import { EventEmitter } from 'events'
import { IPCHandler } from '../ipc/IPCHandler'
import { IPCBaseMessage, IPCMessage, IPCMessageType, IPCRawMessage } from '../ipc/IPCMessage'
import { EvalOptions } from '../managers/ClusterManager'
import { PromiseManager } from '../managers/PromiseManager'
import { serializeScript } from '../utils/Utils'
import { ClusterEnv } from './Cluster'
import { ClusterShardClient } from './ClusterShardClient'

/**
 * Represents a cluster shard that runs inside a forked child process.
 * Provides IPC communication with the parent ClusterManager and access to Discord client functionality.
 *
 * @template Client - The Discord client type, must extend ClusterShardClient
 */
export class ClusterShard<
    Client extends ClusterShardClient = ClusterShardClient
> extends EventEmitter<ClusterShardEvents> {
    /**
     * IPC handler for managing inter-process communication.
     */
    public readonly handler = new IPCHandler(this)

    /**
     * Promise manager for handling async request/response patterns.
     */
    public readonly promises = new PromiseManager()

    /**
     * Timestamp when the shard became ready (in milliseconds).
     * @defaultValue -1 (not ready)
     */
    public readyAt: number = -1

    /**
     * Whether the cluster shard is ready.
     */
    public get ready() {
        return this.readyAt > -1
    }

    /**
     * The cluster ID this shard belongs to.
     */
    public get clusterId(): number {
        return ClusterShard.getInfo().clusterId
    }

    /**
     * Reference to the current Node.js process for IPC communication.
     * @private
     */
    private readonly process = process

    /**
     * @param client - The Discord client instance to manage
     */
    constructor(public readonly client: Client) {
        if (!client) throw new Error('[ClusterShard] "client" is required.')

        super()

        this.process.on('message', (message: IPCRawMessage) => {
            if (!message) return

            this.handler.handleMessage(message)

            if ([IPCMessageType.CustomMessage, IPCMessageType.CustomRequest].includes(message.type)) {
                this.emit('message', new IPCMessage(this, message))
            }
        })

        this.client.on('ready', () => {
            if (!this.process) throw new Error('[ClusterShard] No process found.')

            this.readyAt = Date.now()

            this.sendToProcess({ type: IPCMessageType.ClusterReady })
            this.emit('ready')
        })
    }

    /**
     * Sends a one-way message to the parent cluster manager.
     *
     * @param message - The IPC message to send
     * @returns A promise that resolves when the message is sent
     */
    public send(message: IPCRawMessage): Promise<void> {
        if (!this.process) throw new Error('[ClusterShard#send] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#send] Shard is not ready.')

        return this.sendToProcess({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.CustomMessage
        })
    }

    /**
     * Sends a request to the parent cluster manager and waits for a response.
     *
     * @param message - The IPC message to send
     * @param options - Request options
     * @param options.timeout - Maximum time to wait for response (in milliseconds)
     * @returns A promise that resolves with the response data
     */
    public async request(message: IPCRawMessage, options: { timeout?: number } = {}) {
        if (!this.process) throw new Error('[ClusterShard#request] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#request] Shard is not ready.')

        await this.sendToProcess({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.CustomRequest
        })

        const response = await this.promises.create<IPCBaseMessage>(message.nonce, options)
        if (response.error) throw new Error(response.error.message)

        return response.data
    }

    /**
     * Broadcasts a message to all clusters in the manager.
     *
     * @param message - The IPC message to broadcast
     * @returns A promise that resolves when the broadcast is sent
     */
    public broadcast(message: IPCRawMessage) {
        if (!this.process) throw new Error('[ClusterShard#broadcast] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#broadcast] Shard is not ready.')

        return this.sendToProcess({
            ...new IPCBaseMessage(message),
            type: IPCMessageType.ClusterManagerBroadcast
        })
    }

    /**
     * Evaluates a script on all clusters and returns the aggregated results.
     *
     * @template T - The expected return type of the evaluation
     * @param script - JavaScript code string or function to evaluate
     * @param options - Evaluation options (clusters, shards, context, timeout)
     * @returns A promise that resolves with the evaluation results from all clusters
     */
    public async broadcastEval<T = any>(
        script: string | ((client: Client) => T),
        options: EvalOptions = {}
    ): Promise<T> {
        if (!this.process) throw new Error('[ClusterShard#broadcastEval] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#broadcastEval] Shard is not ready.')
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterShard#broadcastEval] "script" must be a function or a string.')

        const serializedScript = serializeScript(script, options.context)
        const message = new IPCBaseMessage({
            type: IPCMessageType.ClusterManagerBroadcastEval,
            data: { script: serializedScript, options }
        })

        await this.sendToProcess(message)

        const response = await this.promises.create<IPCBaseMessage>(message.nonce, { timeout: options.timeout })
        if (response.error) throw new Error(response.error.message)

        return response.data
    }

    /**
     * Fetches a property value from the client on all or specific clusters.
     * This is a convenience method that uses {@link broadcastEval} internally.
     *
     * @template T - The expected return type
     * @param prop - Property path to fetch (e.g., "guilds.cache.size")
     * @param clusters - Optional array of cluster IDs to target
     * @returns A promise that resolves with the property values from all targeted clusters
     */
    public fetchClientValues<T = any>(prop: string, clusters?: number[]): Promise<T> {
        return this.broadcastEval<T>(`this.${prop}`, { clusters })
    }

    /**
     * Evaluates a script locally on this shard's client instance.
     *
     * @template T - The expected return type
     * @param script - JavaScript code string to evaluate
     * @returns A promise that resolves with the evaluation result
     */
    public eval<T = any>(script: string): Promise<T> {
        if (!this.process) throw new Error('[ClusterShard#eval] No process found.')
        if (!this.ready) throw new Error('[ClusterShard#eval] Cluster is not ready.')
        if (typeof script !== 'string') throw new TypeError('[ClusterShard#eval] "script" must be a string.')

        // @ts-ignore
        if (!this.client._eval) {
            // @ts-ignore
            this.client._eval = function (s: string) {
                return eval(s)
            }.bind(this.client)
        }

        // @ts-ignore
        return this.client._eval(script)
    }

    /**
     * Sends a response message back to the parent process.
     * Typically used to reply to requests from the ClusterManager.
     *
     * @param message - The IPC message to send as a response
     * @returns A promise that resolves when the response is sent
     */
    public respond(message: IPCRawMessage): Promise<void> {
        if (!this.process) throw new Error('[ClusterShard#respond] No process found.')
        return this.sendToProcess(message)
    }

    /**
     * Internal method to send an IPC message to the parent process.
     * Wraps the callback-based process.send() in a Promise for easier async/await usage.
     *
     * @param message - The IPC message to send
     * @returns A promise that resolves when the message is sent successfully
     * @private
     */
    private sendToProcess(message: IPCRawMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            this.process?.send(message, (err: Error | null) => (err ? reject(err) : resolve()))
        })
    }

    /**
     * Retrieves shard information from environment variables.
     * This static method can be called without an instance to get cluster/shard metadata.
     *
     * @returns An object containing cluster ID, shard count, shard list, and shard range
     */
    public static getInfo(): ShardInfo {
        let data: ShardInfo
        const env = process.env as NodeJS.ProcessEnv & ClusterEnv,
            shards: number[] = []

        for (const v of env.LF_SHARDS?.split(',') || []) {
            if (isNaN(+v)) continue
            shards.push(+v)
        }

        data = {
            clusterId: +env.LF_CLUSTER_ID,
            shardCount: +env.LF_SHARD_COUNT,
            shards: shards,
            firstShardId: shards.at(0),
            lastShardId: shards.at(-1)
        }

        return data
    }
}

/**
 * Events emitted by the ClusterShard.
 */
export interface ClusterShardEvents {
    /**
     * Emitted when the shard is ready and operational.
     */
    ready: []

    /**
     * Emitted when a custom message is received from the parent ClusterManager.
     */
    message: [message: IPCMessage]
}

/**
 * Information about the current shard extracted from environment variables.
 */
export interface ShardInfo {
    clusterId: number
    shardCount: number
    shards: number[]
    firstShardId: number
    lastShardId: number
}
