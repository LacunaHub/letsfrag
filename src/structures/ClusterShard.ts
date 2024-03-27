import { Client as DJSClient } from 'discord.js'
import { EventEmitter } from 'events'
import { workerData } from 'worker_threads'
import { IPCHandler } from '../ipc/IPCHandler'
import { IPCBaseMessage, IPCMessage, IPCMessageType, IPCRawMessage } from '../ipc/IPCMessage'
import {
    ClusterManager,
    ClusterManagerMode,
    DebugMessage,
    EvalOptions,
    RespawnOptions
} from '../managers/ClusterManager'
import { PromiseManager } from '../managers/PromiseManager'
import { ClusterEnv } from './Cluster'
import { ForkClient } from './ForkClient'
import { ThreadClient } from './ThreadClient'

export class ClusterShard<Client extends DJSClient = DJSClient> extends EventEmitter {
    /**
     * Time the shard was ready.
     */
    public readyAt: number = -1

    public process: ForkClient | ThreadClient

    /**
     * IPC handler.
     */
    public handler = new IPCHandler(this)

    /**
     * Promise manager.
     */
    public promises = new PromiseManager(this)

    /**
     * Whether the shard is ready.
     */
    public get ready() {
        return this.readyAt > -1
    }

    /**
     * Cluster ID.
     */
    public get id(): number {
        return ClusterShard.getInfo().clusterId
    }

    constructor(public client: Client) {
        super()

        const info = ClusterShard.getInfo()

        if (info.clusterManagerMode === 'fork') {
            this.process = new ForkClient()
        } else {
            this.process = new ThreadClient()
        }

        this.process.ipc.on('message', this.onProcessMessage.bind(this))
        this.client.on('ready', this.onClientReady.bind(this))
    }

    /**
     * Sends a message to the cluster.
     * @param message IPC message.
     */
    public send(message: IPCRawMessage): Promise<void> {
        if (!this.process) throw new Error('[ClusterShard#send] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#send] Cluster is not ready.')

        this.emit('debug', { from: 'ClusterShard#send', data: arguments })

        return this.process.send({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.CustomMessage
        })
    }

    /**
     * Sends a request to the cluster.
     * @param message IPC message.
     * @param options Request options.
     */
    public async request(message: IPCRawMessage, options: { timeout?: number } = {}) {
        if (!this.process) throw new Error('[ClusterShard#request] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#request] Cluster is not ready.')

        this.emit('debug', { from: 'ClusterShard#request', data: arguments })

        await this.process.send({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.CustomRequest
        })

        return await this.promises.create(message.nonce, options)
    }

    /**
     * Broadcasts a message to the cluster.
     * @param message IPC message.
     */
    public broadcast(message: IPCRawMessage) {
        if (!this.process) throw new Error('[ClusterShard#broadcast] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#broadcast] Cluster is not ready.')

        this.emit('debug', { from: 'ClusterShard#broadcast', data: arguments })

        return this.process.send({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.ClusterManagerBroadcast
        })
    }

    /**
     * Broadcasts a script to the cluster.
     * @param script Script to evaluate.
     * @param options Evaluation options.
     */
    public async broadcastEval<T = any>(
        script: string | ((client: Client) => T),
        options: EvalOptions = {}
    ): Promise<T> {
        if (!this.process) throw new Error('[ClusterShard#broadcastEval] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#broadcastEval] Cluster is not ready.')
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterShard#broadcastEval] Script must be a function.')

        script = typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script

        this.emit('debug', { from: 'ClusterShard#broadcastEval', data: arguments })

        const message = new IPCBaseMessage({
            type: IPCMessageType.ClusterManagerBroadcastEval,
            data: { script, options }
        })

        await this.process.send(message)

        return await this.promises.create(message.nonce, { timeout: options.timeout })
    }

    /**
     * Fetches client values from the cluster.
     * @param prop Property to fetch.
     * @param clusterIds Cluster IDs to fetch.
     */
    public fetchClientValues<T = any>(prop: string, clusters?: number[]): Promise<T> {
        return this.broadcastEval<T>(`this.${prop}`, { clusters })
    }

    /**
     * Evaluates a script on the client.
     * @param script Script to evaluate.
     */
    public async eval<T = any>(script: string): Promise<T> {
        if (!this.process) throw new Error('[ClusterShard#eval] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#eval] Cluster is not ready.')
        if (typeof script !== 'string') throw new TypeError('[ClusterShard#eval] Script must be a string.')

        // @ts-ignore
        if (!this.client._eval) {
            // @ts-ignore
            this.client._eval = function (_: string) {
                return eval(_)
            }.bind(this.client)
        }

        // @ts-ignore
        return await this.client._eval(script)
    }

    /**
     * Evaluates a script on the manager.
     * @param script Script to evaluate.
     * @param options Evaluation options.
     */
    public async evalOnManager<T>(script: string | ((manager: ClusterManager) => T), options: EvalOptions = {}) {
        if (!this.process) throw new Error('[ClusterShard#evalOnManager] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#evalOnManager] Cluster is not ready.')
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterShard#evalOnManager] Script must be a function.')

        this.emit('debug', { from: 'ClusterShard#evalOnManager', data: arguments })

        const message = new IPCBaseMessage({
            type: IPCMessageType.ClusterManagerEval,
            data: {
                script: typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script,
                options
            }
        })

        await this.process.send(message)

        return await this.promises.create(message.nonce, { timeout: options.timeout })
    }

    /**
     * Respawns all cluster shards.
     * @param options Respawn options.
     */
    public respawnAll(options: RespawnOptions = {}) {
        if (!this.process) throw new Error('[ClusterShard#respawnAll] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#respawnAll] Cluster is not ready.')

        this.emit('debug', { from: 'ClusterShard#respawnAll', data: arguments })

        return this.process.send({
            type: IPCMessageType.ClusterManagerRespawnAll,
            data: options
        })
    }

    /**
     * Responds to a message.
     * @param message IPC message.
     */
    public respond(message: IPCRawMessage): Promise<void> {
        if (!this.process) throw new Error('[ClusterShard#respond] No process found.')

        this.emit('debug', { from: 'ClusterShard#respond', data: arguments })

        return this.process.send(message)
    }

    /**
     * Get shard info.
     */
    public static getInfo(): ShardInfo {
        const mode = process.env.LF_CLUSTER_MANAGER_MODE as ClusterManagerMode

        if (!['fork', 'thread'].includes(mode)) throw new TypeError('[ShardInfo] Mode must be "fork" or "thread".')

        let data: ShardInfo

        if (mode === 'fork') {
            const env = process.env as NodeJS.ProcessEnv & ClusterEnv<'fork'>,
                shards: number[] = []

            for (const v of env?.LF_SHARD_LIST?.split(',') || []) {
                if (isNaN(+v)) continue
                shards.push(+v)
            }

            data = {
                clusterId: +env.LF_CLUSTER_ID,
                clusterManagerMode: env.LF_CLUSTER_MANAGER_MODE,
                shardCount: +env.LF_SHARD_COUNT,
                shards: shards,
                firstShardId: shards.at(0),
                lastShardId: shards.at(-1)
            }
        } else {
            const env = workerData as ClusterEnv<'thread'>,
                shards = env.LF_SHARDS

            data = {
                clusterId: env.LF_CLUSTER_ID,
                clusterManagerMode: env.LF_CLUSTER_MANAGER_MODE,
                shardCount: env.LF_SHARD_COUNT,
                shards: shards,
                firstShardId: shards.at(0),
                lastShardId: shards.at(-1)
            }
        }

        return data
    }

    private onProcessMessage(message: IPCRawMessage): void {
        if (!message) return

        this.handler.handleMessage(message)

        if ([IPCMessageType.CustomMessage, IPCMessageType.CustomRequest].includes(message.type)) {
            this.emit('message', new IPCMessage(this, message))
        }
    }

    private onClientReady(): void {
        if (!this.process) throw new Error('[ClusterShard] No process found.')

        this.readyAt = Date.now()

        this.process.send({
            type: IPCMessageType.ClusterReady
        })

        this.emit('ready', this)
    }
}

export interface ClusterShard {
    on<Event extends keyof ClusterShardEvents>(
        event: Event,
        listener: (...args: ClusterShardEvents[Event]) => void
    ): this

    once<Event extends keyof ClusterShardEvents>(
        event: Event,
        listener: (...args: ClusterShardEvents[Event]) => void
    ): this

    emit<Event extends keyof ClusterShardEvents>(event: Event, ...args: ClusterShardEvents[Event]): boolean

    off<Event extends keyof ClusterShardEvents>(
        event: Event,
        listener: (...args: ClusterShardEvents[Event]) => void
    ): this

    removeAllListeners<Event extends keyof ClusterShardEvents>(event?: Event): this
}

export interface ClusterShardEvents {
    message: [message: IPCMessage]
    ready: [ClusterShard: ClusterShard]
    debug: [message: DebugMessage]
}

export interface ShardInfo {
    /**
     * Cluster ID.
     */
    clusterId: number

    /**
     * Cluster manager mode.
     */
    clusterManagerMode: ClusterManagerMode

    /**
     * Total number of shards.
     */
    shardCount: number

    /**
     * Shard list.
     */
    shards: number[]

    /**
     * First shard ID.
     */
    firstShardId: number

    /**
     * Last shard ID.
     */
    lastShardId: number
}
