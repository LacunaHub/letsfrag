import EventEmitter from 'events'
import { IPCHandler } from '../ipc/IPCHandler'
import { IPCBaseMessage, IPCMessage, IPCMessageType, IPCRawMessage } from '../ipc/IPCMessage'
import { ClusterManager, EvalOptions } from '../managers/ClusterManager'
import { serializeScript, sleep } from '../utils/Utils'
import { ClusterShard } from './ClusterShard'
import { Fork } from './Fork'

/**
 * Represents a cluster that manages Discord bot shards.
 */
export class Cluster extends EventEmitter<ClusterEvents> {
    /**
     * IPC handler for managing inter-process communication.
     */
    public readonly handler = new IPCHandler(this)

    /**
     * Timestamp when the cluster became ready, or -1 if not ready.
     */
    public readyAt: number = -1

    /**
     * Child process for this cluster.
     */
    public cp?: Fork

    /**
     * Whether the cluster is ready.
     */
    public get ready(): boolean {
        return this.readyAt > -1
    }

    private env: NodeJS.ProcessEnv & ClusterEnv

    /**
     * @param manager The cluster manager.
     * @param id The cluster ID.
     * @param shards Array of shard IDs assigned to this cluster.
     */
    constructor(public readonly manager: ClusterManager, public readonly id: number, public readonly shards: number[]) {
        if (!manager) throw new Error(`[Cluster] "manager" is required.`)
        if (typeof id !== 'number') throw new TypeError(`[Cluster] "id" must be a number.`)
        if (!Array.isArray(shards) || !shards.every(v => typeof v === 'number'))
            throw new TypeError(`[Cluster] "shards" must be an array of numbers.`)

        super()

        this.env = Object.assign({}, process.env, {
            LF_CLUSTER_ID: String(this.id),
            LF_SHARD_COUNT: String(this.manager.shardCount),
            LF_SHARDS: this.shards.join(',')
        })
    }

    /**
     * Spawns the cluster child process and waits for it to become ready.
     *
     * @param timeout Timeout in milliseconds. Default is 30000ms (30 seconds).
     * @returns The spawned Fork process.
     */
    public async spawn(timeout: number = 30_000): Promise<Fork> {
        if (this.cp) throw new Error(`[Cluster#spawn] Cluster #${this.id} is already spawned.`)
        if (!this.manager.file) throw new Error(`[Cluster#spawn] Cluster #${this.id} is missing a file.`)

        const args = [
                ...(this.manager.options.shardArgs || []),
                `--clusterId ${this.id}`,
                `--shards [${this.shards.join(',').trim()}]`
            ],
            options = {
                ...this.manager.options.childProcess,
                execArgv: this.manager.options.execArgv,
                env: this.env
            }

        this.cp = new Fork(this.manager.file, args, options)
        this.cp
            .spawn()
            .on('message', (message: IPCRawMessage) => {
                if (!message) return

                this.handler.handleMessage(message)

                if ([IPCMessageType.CustomMessage, IPCMessageType.CustomRequest].includes(message.type)) {
                    const ipcMessage = new IPCMessage(this, message)

                    if (message.type === IPCMessageType.CustomRequest) this.manager.emit('clientRequest', ipcMessage)

                    this.emit('message', ipcMessage)
                    this.manager.emit('message', ipcMessage)
                }
            })
            .on('error', err => this.emit('error', err))
            .on('exit', code => {
                this.emit('death', this, this.cp)

                this.readyAt = -1
                this.cp = null
            })
        this.emit('spawn', this.cp)

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
                this.manager.emit('clusterDeath', this)
                cleanup()
                reject(new Error(`[Cluster#spawn] Cluster #${this.id} died.`))
            }

            const onTimeout = () => {
                this.manager.emit('clusterTimeout', this)
                cleanup()
                reject(new Error(`[Cluster#spawn] Cluster #${this.id} took too long to get ready.`))
            }

            const spawnTimeoutTimer = shouldAbort ? setTimeout(onTimeout, timeout) : -1

            this.once('ready', onReady)
            this.once('death', onDeath)

            if (!shouldAbort) resolve()
        })

        return this.cp
    }

    /**
     * Terminates the cluster child process and resets its state.
     */
    public kill(): void {
        this.cp?.kill()
        this.cp = null
        this.readyAt = -1
    }

    /**
     * Kills and respawns the cluster with optional delay.
     *
     * @param delay Delay before respawning in milliseconds. Defaults to manager's spawn delay.
     * @param timeout Timeout for the spawn operation in milliseconds. Defaults to manager's spawn timeout.
     * @returns The newly spawned Fork process.
     */
    public async respawn(
        delay: number = this.manager.options.spawnDelay,
        timeout: number = this.manager.options.spawnTimeout
    ): Promise<Fork> {
        this.kill()
        if (delay > 0) await sleep(delay)

        return this.spawn(timeout)
    }

    /**
     * Sends a one-way message to the cluster child process.
     *
     * @param message IPC message to send.
     * @returns Promise that resolves when the message is sent.
     */
    public send(message: IPCRawMessage): Promise<void> {
        if (!this.cp) throw new Error(`[Cluster#send] Cluster #${this.id} is not spawned.`)

        return this.cp.send({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.CustomMessage
        })
    }

    /**
     * Sends a request to the cluster and waits for a response.
     *
     * @param message IPC message to send.
     * @param timeout Optional timeout in milliseconds for the response.
     * @returns Promise that resolves with the response data.
     */
    public async request(message: IPCRawMessage, timeout?: number): Promise<any> {
        if (!this.cp) throw new Error(`[Cluster#request] Cluster #${this.id} is not spawned.`)

        const baseMessage = new IPCBaseMessage({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.CustomRequest
        })

        await this.cp.send(baseMessage)

        const response = await this.manager.promises.create<IPCBaseMessage>(baseMessage.nonce, { timeout })
        if (response.error) throw new Error(response.error.message)

        return response.data
    }

    /**
     * Broadcasts a message to all clusters via the manager.
     *
     * @param message IPC message to broadcast.
     * @returns Promise that resolves with an array of void promises for each cluster.
     */
    public broadcast(message: IPCRawMessage): Promise<void[]> {
        return this.manager.broadcast(message)
    }

    /**
     * Evaluates a script on the cluster process.
     *
     * @param script Script string or function to evaluate.
     * @param options Optional evaluation options including context.
     * @returns Promise that resolves with the evaluation result.
     */
    public eval<T = any>(script: string | ((cluster: Cluster) => T), options: EvalOptions = {}): Promise<T> {
        return eval(serializeScript(script, options.context))
    }

    /**
     * Evaluates a script on the cluster's shard client.
     *
     * @param script Script string or function to evaluate on the shard.
     * @param options Optional evaluation options including context and timeout.
     * @returns Promise that resolves with the evaluation result.
     */
    public async evalOnShard<T = any>(
        script: string | ((client: ClusterShard) => T),
        options: EvalOptions = {}
    ): Promise<T> {
        if (!this.cp) throw new Error(`[Cluster#evalOnShard] Cluster #${this.id} is not spawned.`)
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterShard#evalOnShard] "script" must be a function or a string.')

        const serializedScript = serializeScript(script, options.context)
        const message = new IPCBaseMessage({
            type: IPCMessageType.ClusterShardEval,
            data: { script: serializedScript, options }
        })

        await this.cp.send(message)

        const response = await this.manager.promises.create<IPCBaseMessage>(message.nonce, { timeout: options.timeout })
        if (response.error) throw new Error(response.error.message)

        return response.data
    }
}

/**
 * Events emitted by the Cluster.
 */
export interface ClusterEvents {
    /**
     * Emitted when the cluster child process becomes ready.
     */
    ready: []

    /**
     * Emitted when the cluster receives an IPC message.
     */
    message: [message: IPCMessage]

    /**
     * Emitted when an error occurs in the cluster child process.
     */
    error: [error: Error]

    /**
     * Emitted when the cluster child process is spawned.
     */
    spawn: [process: Fork]

    /**
     * Emitted when the cluster child process dies or exits.
     */
    death: [cluster: Cluster, process?: Fork]
}

/**
 * Environment variables set for the cluster process.
 */
export interface ClusterEnv {
    LF_CLUSTER_ID: string
    LF_SHARD_COUNT: string
    LF_SHARDS: string
}
