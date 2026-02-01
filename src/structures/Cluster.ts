import { makePlainError } from 'discord.js'
import EventEmitter from 'events'
import { ClusterManager, EvalOptions } from '../managers/ClusterManager'
import { serializeScript } from '../utils/Utils'
import { ClusterContext, ClusterContextStats } from './ClusterContext'
import { Fork } from './Fork'
import { createIPCMessage, IPCMessage, IPCMessagePayload, IPCMessageType } from './IPCMessage'

/**
 * Represents a cluster that manages Discord bot shards.
 */
export class Cluster extends EventEmitter<ClusterEvents> {
    /**
     * Timestamp when the cluster became ready, or -1 if not ready.
     */
    public readyAt: number

    /**
     * Whether the cluster is ready.
     */
    public get ready(): boolean {
        return this.readyAt > 0
    }

    /**
     * Child process for this cluster.
     */
    public cp?: Fork

    public stats?: ClusterStats

    private env: NodeJS.ProcessEnv & ClusterEnv

    /**
     * @param manager The cluster manager.
     * @param id The cluster ID.
     * @param shardList Array of shard IDs assigned to this cluster.
     */
    constructor(
        public readonly manager: ClusterManager,
        public readonly id: number,
        public readonly shardList: number[]
    ) {
        if (!manager) throw new Error(`[Cluster] "manager" is required.`)
        if (typeof id !== 'number') throw new TypeError(`[Cluster] "id" must be a number.`)
        if (!Array.isArray(shardList) || !shardList.every(v => typeof v === 'number'))
            throw new TypeError(`[Cluster] "shardList" must be an array of numbers.`)

        super()

        this.env = Object.assign({}, process.env, {
            LETSFRAG_CLUSTER_ID: String(this.id),
            LETSFRAG_SHARD_COUNT: String(this.manager.shardCount),
            LETSFRAG_SHARD_LIST: this.shardList.join(',')
        })
    }

    /**
     * Spawns the cluster child process and waits for it to become ready.
     *
     * @param timeout Timeout in milliseconds. Default is 30000ms (30 seconds).
     * @returns The spawned Fork process.
     */
    public async spawn(timeout: number = this.manager.options.spawnTimeout): Promise<Fork> {
        if (this.cp) throw new Error(`[Cluster#spawn] Cluster #${this.id} is already spawned.`)
        if (!this.manager.file) throw new Error(`[Cluster#spawn] Cluster #${this.id} is missing a file.`)

        const args = [
                ...(this.manager.options.shardArgs || []),
                `--clusterId ${this.id}`,
                `--shards [${this.shardList.join(',').trim()}]`
            ],
            options = {
                ...this.manager.options.childProcess,
                execArgv: this.manager.options.execArgv,
                env: this.env
            }

        this.cp = new Fork(this.manager.file, args, options)
        this.cp
            .spawn()
            .on('message', async (message: IPCMessage) => {
                if (message.type === IPCMessageType.ClusterReady) {
                    this.readyAt = Date.now()
                    this.emit('ready')

                    if (this.manager.clusters.size === this.manager.clusterCount) {
                        this.manager.readyAt = Date.now()
                        this.manager.emit('ready')
                    }
                } else if (message.type === IPCMessageType.ClusterRespawn) {
                    await this.respawn()
                } else if (message.type === IPCMessageType.ClusterContextHeartbeat) {
                    this.stats = { ...message.data, lastHeartbeatAt: Date.now() }
                } else if (message.type === IPCMessageType.ClusterContextEvalResult) {
                    this.manager.promises.resolve(message.nonce, message)
                } else if (message.type === IPCMessageType.BroadcastEval) {
                    try {
                        const results = await this.manager.broadcastEval(message.data.script, message.data.options)

                        await this.send({
                            type: IPCMessageType.BroadcastEvalResult,
                            data: results,
                            nonce: message.nonce
                        })
                    } catch (err) {
                        await this.send({
                            type: IPCMessageType.BroadcastEvalResult,
                            error: makePlainError(err),
                            nonce: message.nonce
                        })
                    }
                }
            })
            .on('error', err => this.emit('error', err))
            .on('exit', code => {
                this.emit('death', this, this.cp)
                this.kill()
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
        this.readyAt = null
    }

    /**
     * Kills and respawns the cluster with optional delay.
     *
     * @param timeout Timeout for the spawn operation in milliseconds. Defaults to manager's spawn timeout.
     * @returns The newly spawned Fork process.
     */
    public respawn(timeout: number = this.manager.options.spawnTimeout): Promise<Fork> {
        this.kill()
        return this.spawn(timeout)
    }

    /**
     * Sends a one-way message to the cluster child process.
     *
     * @param message IPC message to send.
     * @returns Promise that resolves when the message is sent.
     */
    public send(payload: IPCMessagePayload): Promise<void> {
        if (!this.cp) throw new Error(`[Cluster#send] Cluster #${this.id} is not spawned.`)
        return this.cp.send(createIPCMessage(payload))
    }

    /**
     * Broadcasts a message to all clusters via the manager.
     *
     * @param message IPC message to broadcast.
     * @returns Promise that resolves with an array of void promises for each cluster.
     */
    public broadcast(message: IPCMessage): Promise<void[]> {
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
        script: string | ((client: ClusterContext) => T),
        options: EvalOptions = {}
    ): Promise<T> {
        if (!this.cp) throw new Error(`[Cluster#evalOnShard] Cluster #${this.id} is not spawned.`)
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[Cluster#evalOnShard] "script" must be a function or a string.')

        const serializedScript = serializeScript(script, options.context)
        const message = createIPCMessage({
            type: IPCMessageType.ClusterContextEval,
            data: { script: serializedScript, options }
        })

        await this.cp.send(message)

        const response = await this.manager.promises.create<IPCMessage>(message.nonce, { timeout: options.timeout })
        if (response.error) throw new Error(response.error.message)

        return response.data as T
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
    LETSFRAG_CLUSTER_ID: string
    LETSFRAG_SHARD_COUNT: string
    LETSFRAG_SHARD_LIST: string
}

export type ClusterStats = ClusterContextStats & { lastHeartbeatAt: number }
