import { makePlainError, Status, TextBasedChannel } from 'discord.js'
import { EventEmitter } from 'events'
import { EvalOptions } from '../managers/ClusterManager'
import { PromiseManager } from '../managers/PromiseManager'
import { serializeScript } from '../utils/Utils'
import { ClusterEnv } from './Cluster'
import { ClusterClient } from './ClusterClient'
import { createIPCMessage, IPCMessage, IPCMessagePayload, IPCMessageType } from './IPCMessage'

/**
 * Represents a cluster shard that runs inside a forked child process.
 * Provides IPC communication with the parent ClusterManager and access to Discord client functionality.
 *
 * @template Client - The Discord client type, must extend ClusterClient
 */
export class ClusterContext<Client extends ClusterClient = ClusterClient> extends EventEmitter<ClusterContextEvents> {
    /**
     * Promise manager for handling async request/response patterns.
     */
    public readonly promises = new PromiseManager()

    /**
     * Timestamp when the shard became ready (in milliseconds)
     */
    public readyAt: number

    /**
     * Whether the cluster shard is ready.
     */
    public get ready() {
        return this.readyAt > 0
    }

    /**
     * The cluster ID this shard belongs to.
     */
    public get id(): number {
        return ClusterContext.getInfo().clusterId
    }

    public get stats(): ClusterContextStats {
        return {
            id: this.id,
            shardsList: ClusterContext.getInfo().shardsList,
            wsPing: this.client.ws.ping,
            wsStatus: this.client.ws.status,
            guildCount: this.client.guilds.cache.size,
            userCount: this.client.guilds.cache.reduce((x, y) => (x += y.memberCount), 0),
            cachedUserCount: this.client.users.cache.size,
            channelCount: this.client.channels.cache.size,
            messageCount: this.client.channels.cache
                .filter(v => 'messages' in v)
                .reduce((x, y: TextBasedChannel) => (x += y.messages.cache.size), 0),
            voiceConnectionCount: this.client.guilds.cache.reduce((x, y) => (x += y.voiceStates.cache.size), 0),
            emojiCount: this.client.emojis.cache.size,
            uptime: this.client.uptime
        }
    }

    /**
     * Reference to the current Node.js process for IPC communication.
     * @private
     */
    private readonly process = process

    private heartbeatInterval: NodeJS.Timeout

    /**
     * @param client - The Discord client instance to manage
     */
    constructor(public readonly client: Client) {
        if (!client) throw new Error('[ClusterContext] "client" is required.')

        super()

        this.process.on('message', async (message: IPCMessage) => {
            if (message.type === IPCMessageType.ClusterContextEval) {
                try {
                    const result = await this.eval(message.data.script)

                    await this.send({
                        type: IPCMessageType.ClusterContextEvalResult,
                        data: result,
                        nonce: message.nonce
                    })
                } catch (err) {
                    await this.send({
                        type: IPCMessageType.ClusterContextEvalResult,
                        error: makePlainError(err),
                        nonce: message.nonce
                    })
                }
            } else if (message.type === IPCMessageType.BroadcastEvalResult) {
                this.promises.resolve(message.nonce, message)
            }
        })

        this.client.on('ready', () => {
            if (!this.process) throw new Error('[ClusterContext] No process found.')

            this.readyAt = Date.now()
            this.emit('ready')
            this.send({ type: IPCMessageType.ClusterReady })

            this.heartbeatInterval = setInterval(
                () =>
                    this.send({
                        type: IPCMessageType.ClusterContextHeartbeat,
                        data: this.stats
                    }),
                15_000
            )
        })
    }

    /**
     * Sends a one-way message to the parent cluster manager.
     *
     * @param message - The IPC message to send
     * @returns A promise that resolves when the message is sent
     */
    public send(payload: IPCMessagePayload): Promise<void> {
        if (!this.process) throw new Error('[ClusterContext#send] No process found.')
        if (!this.ready) throw new Error('[ClusterContext#send] Shard is not ready.')

        return this.sendToProcess(createIPCMessage(payload))
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
        if (!this.process) throw new Error('[ClusterContext#broadcastEval] No process found.')
        if (!this.ready) throw new Error('[ClusterContext#broadcastEval] Shard is not ready.')
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterContext#broadcastEval] "script" must be a function or a string.')

        const serializedScript = serializeScript(script, options.context)
        const message = createIPCMessage({
            type: IPCMessageType.BroadcastEval,
            data: { script: serializedScript, options }
        })

        await this.sendToProcess(message)

        const response = await this.promises.create<IPCMessage>(message.nonce, { timeout: options.timeout })
        if (response.error) throw new Error(response.error.message)

        return response.data as T
    }

    /**
     * Fetches a property value from the client on all or specific clusters.
     * This is a convenience method that uses {@link broadcastEval} internally.
     *
     * @template T - The expected return type
     * @param prop - Property path to fetch (e.g., "guilds.cache.size")
     * @param clusterList - Optional array of cluster IDs to target
     * @returns A promise that resolves with the property values from all targeted clusters
     */
    public fetchClientValues<T = any>(prop: string, clusterList?: number[]): Promise<T> {
        return this.broadcastEval<T>(`this.${prop}`, { clusterList })
    }

    /**
     * Evaluates a script locally on this shard's client instance.
     *
     * @template T - The expected return type
     * @param script - JavaScript code string to evaluate
     * @returns A promise that resolves with the evaluation result
     */
    public eval<T = any>(script: string): Promise<T> {
        if (!this.process) throw new Error('[ClusterContext#eval] No process found.')
        if (!this.ready) throw new Error('[ClusterContext#eval] Cluster is not ready.')
        if (typeof script !== 'string') throw new TypeError('[ClusterContext#eval] "script" must be a string.')

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
     * Internal method to send an IPC message to the parent process.
     * Wraps the callback-based process.send() in a Promise for easier async/await usage.
     *
     * @param message - The IPC message to send
     * @returns A promise that resolves when the message is sent successfully
     * @private
     */
    private sendToProcess(message: IPCMessage): Promise<void> {
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
    public static getInfo(): ClusterContextShardInfo {
        const env = process.env as NodeJS.ProcessEnv & ClusterEnv,
            shardsList: number[] = []

        for (const v of env.LETSFRAG_SHARD_LIST?.split(',') || []) {
            if (isNaN(+v)) continue
            shardsList.push(+v)
        }

        const data: ClusterContextShardInfo = {
            clusterId: +env.LETSFRAG_CLUSTER_ID,
            shardCount: +env.LETSFRAG_SHARD_COUNT,
            shardsList,
            firstShardId: shardsList.at(0),
            lastShardId: shardsList.at(-1)
        }

        return data
    }
}

/**
 * Events emitted by the ClusterContext.
 */
export interface ClusterContextEvents {
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
export interface ClusterContextShardInfo {
    clusterId: number
    shardCount: number
    shardsList: number[]
    firstShardId: number
    lastShardId: number
}

export interface ClusterContextStats {
    id: number
    shardsList: number[]
    wsPing: number
    wsStatus: Status
    guildCount: number
    userCount: number
    cachedUserCount: number
    channelCount: number
    messageCount: number
    voiceConnectionCount: number
    emojiCount: number
    uptime: number
}
