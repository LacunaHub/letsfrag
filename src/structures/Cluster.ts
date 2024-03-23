import { ChildProcess } from 'child_process'
import EventEmitter from 'events'
import { Worker } from 'worker_threads'
import { IPCHandler } from '../ipc/IPCHandler'
import { IPCBaseMessage, IPCMessage, IPCMessageType, IPCRawMessage } from '../ipc/IPCMessage'
import { ClusterManager, ClusterManagerMode, DebugMessage, EvalOptions } from '../managers/ClusterManager'
import { sleep } from '../utils/Utils'
import { ClusterShard } from './ClusterShard'
import { Fork } from './Fork'
import { Thread } from './Thread'

export class Cluster extends EventEmitter {
    /**
     * Time the cluster was ready.
     */
    public readyAt: number = -1

    public thread: Fork | Thread | null = null

    /**
     * IPC handler.
     */
    public handler = new IPCHandler(this)

    /**
     * Whether the cluster is ready.
     */
    public get ready(): boolean {
        return this.readyAt > -1
    }

    private env: NodeJS.ProcessEnv & ClusterEnv

    constructor(public readonly manager: ClusterManager, public id: number, public shardList: number[]) {
        if (!manager) throw new Error(`[Cluster] "manager" is required.`)
        if (typeof id !== 'number') throw new Error(`[Cluster] "id" must be a number.`)
        if (!Array.isArray(shardList)) throw new Error(`[Cluster] "shardList" must be an array.`)

        super()

        this.env = Object.assign({}, process.env, {
            LF_CLUSTER_ID: this.id,
            LF_CLUSTER_MANAGER_MODE: this.manager.options.mode,
            LF_TOTAL_SHARDS: this.manager.totalShards,
            LF_TOTAL_CLUSTERS: this.manager.options.totalClusters,
            LF_SHARD_LIST: this.shardList
        })
    }

    /**
     * Spawns the cluster.
     * @param timeout Timeout in milliseconds.
     */
    public async spawn(timeout: number = 30_000): Promise<ChildProcess | Worker> {
        if (this.thread) throw new Error(`[Cluster#spawn] Cluster with ID ${this.id} is already spawned.`)
        if (!this.manager.file) throw new Error(`[Cluster#spawn] Cluster with ID ${this.id} is missing file.`)

        const args = [
                ...(this.manager.options.shardArgs || []),
                `--clusterId ${this.id}`,
                `--shards [${this.shardList.join(', ').trim()}]`
            ],
            options = {
                ...this.manager.options.clusterOptions,
                execArgv: this.manager.options.execArgv,
                env: this.env
            }

        this.thread =
            this.manager.options.mode === 'fork'
                ? new Fork(this.manager.file, args, options)
                : new Thread(this.manager.file, options)

        this.thread
            .spawn()
            .on('message', this.onThreadMessage.bind(this))
            .on('error', this.onThreadError.bind(this))
            .on('exit', this.onThreadExit.bind(this))
        this.emit('spawn', this.thread.process)

        const shouldAbort = timeout > 0 && timeout !== Infinity

        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(spawnTimeoutTimer)

                this.off('ready', onReady)
                this.off('death', onDeath)
            }

            const onReady = () => {
                this.readyAt = Date.now()
                this.manager.emit('clusterReady', this)
                cleanup()
                resolve()
            }

            const onDeath = () => {
                cleanup()
                reject(new Error(`[Cluster#spawn] Cluster ${this.id} died.`))
            }

            const onTimeout = () => {
                cleanup()
                reject(new Error(`[Cluster#spawn] Cluster ${this.id} took too long to get ready.`))
            }

            const spawnTimeoutTimer = shouldAbort ? setTimeout(onTimeout, timeout) : -1

            this.once('ready', onReady)
            this.once('death', onDeath)

            if (!shouldAbort) resolve()
        })

        return this.thread.process
    }

    /**
     * Kills the cluster.
     */
    public kill(): void {
        if (!this.thread) throw new Error(`[Cluster#kill] Cluster ${this.id} does not have a child process/worker.`)

        this.thread.kill()
        this.thread = null
        this.readyAt = -1

        this.manager.emit('debug', { from: 'Cluster#kill', data: this.id })
    }

    /**
     * Respawns the cluster.
     * @param delay Spawn delay in milliseconds.
     * @param timeout Timeout in milliseconds.
     */
    public async respawn(
        delay: number = this.manager.options.spawnDelay,
        timeout: number = this.manager.options.spawnTimeout
    ): Promise<ChildProcess | Worker> {
        this.thread && this.kill()
        delay > 0 && (await sleep(delay))

        return this.spawn(timeout)
    }

    /**
     * Sends a message to the cluster.
     * @param message IPC message.
     */
    public async send(message: IPCRawMessage): Promise<void> {
        if (!this.thread) throw new Error(`[Cluster#send] Cluster ${this.id} does not have a child process/worker.`)

        this.manager.emit('debug', { from: 'Cluster#send', data: arguments })

        return this.thread.send({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.CustomMessage
        })
    }

    /**
     * Sends a request to the cluster.
     * @param message IPC message.
     * @param timeout Timeout in milliseconds.
     */
    public async request(message: IPCRawMessage, timeout?: number): Promise<any> {
        if (!this.thread) throw new Error(`[Cluster#request] Cluster ${this.id} does not have a child process/worker.`)

        const baseMessage = new IPCBaseMessage({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.CustomRequest
        })

        await this.thread.send(baseMessage)

        return await this.manager.promises.create(baseMessage.nonce, { timeout })
    }

    /**
     * Broadcasts a message to the cluster.
     * @param message IPC message.
     */
    public async broadcast(message: IPCRawMessage): Promise<void[]> {
        return await this.manager.broadcast(message)
    }

    /**
     * Evaluates a script on the cluster.
     * @param script Script to evaluate.
     * @param options Evaluation options.
     */
    public async eval<T = any>(script: string | ((cluster: Cluster) => T), options: EvalOptions = {}): Promise<T> {
        return eval(typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script)
    }

    /**
     * Evaluates a script on the shard.
     * @param script Script to evaluate.
     * @param options Evaluation options.
     */
    public async evalOnShard<T = any>(
        script: string | ((client: ClusterShard) => T),
        options: EvalOptions = {}
    ): Promise<T> {
        if (!this.thread)
            throw new Error(`[Cluster#evalOnShard] Cluster ${this.id} does not have a child process/worker.`)
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterShard#evalOnShard] Script must be a function.')

        script = typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script

        const message = new IPCBaseMessage({
            type: IPCMessageType.ClusterShardEval,
            data: { script, options }
        })

        await this.thread.send(message)

        return await this.manager.promises.create(message.nonce, { timeout: options.timeout })
    }

    private onThreadMessage(message: IPCRawMessage): void {
        if (!message) return

        this.handler.handleMessage(message)

        if ([IPCMessageType.CustomMessage, IPCMessageType.CustomRequest].includes(message.type)) {
            const ipcMessage = new IPCMessage(this, message)

            if (message.type === IPCMessageType.CustomRequest) this.manager.emit('clientRequest', ipcMessage)

            this.emit('message', ipcMessage)
            this.manager.emit('message', ipcMessage)
        }
    }

    private onThreadExit(code: number): void {
        this.emit('death', this, this.thread?.process)
        this.emit('debug', { from: 'Cluster#handleExit', data: arguments })

        this.readyAt = -1
        this.thread = null
    }

    private onThreadError(error: Error): void {
        this.manager.emit('error', error)
    }
}

export interface Cluster {
    on<Event extends keyof ClusterEvents>(event: Event, listener: (...args: ClusterEvents[Event]) => void): this

    once<Event extends keyof ClusterEvents>(event: Event, listener: (...args: ClusterEvents[Event]) => void): this

    emit<Event extends keyof ClusterEvents>(event: Event, ...args: ClusterEvents[Event]): boolean

    off<Event extends keyof ClusterEvents>(event: Event, listener: (...args: ClusterEvents[Event]) => void): this

    removeAllListeners<Event extends keyof ClusterEvents>(event?: Event): this
}

export interface ClusterEvents {
    message: [message: IPCMessage]
    death: [cluster: Cluster, thread: ChildProcess | Worker | undefined | null]
    spawn: [thread: ChildProcess | Worker | undefined | null]
    ready: [cluster: Cluster]
    debug: [message: DebugMessage]
    error: [error: Error]
}

export interface ClusterEnv<T extends ClusterManagerMode = 'thread'> {
    LF_CLUSTER_ID: T extends 'fork' ? string : number
    LF_CLUSTER_MANAGER_MODE: ClusterManagerMode
    LF_TOTAL_SHARDS: T extends 'fork' ? string : number
    LF_TOTAL_CLUSTERS: T extends 'fork' ? string : number
    LF_SHARD_LIST: T extends 'fork' ? string : number[]
}
