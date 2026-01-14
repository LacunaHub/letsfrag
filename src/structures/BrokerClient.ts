import { randomUUID } from 'crypto'
import { makeError, makePlainError } from 'discord.js'
import { EventEmitter } from 'events'
import { RedisOptions } from 'ioredis'
import { cpu, mem, MemUsedInfo, os } from 'node-os-utils'
import { BrokerChannels, getClusterManagerChannel, RedisBroker } from '../brokers/RedisBroker'
import { IPCBaseMessage, IPCMessageType, IPCRawMessage } from '../ipc/IPCMessage'
import { ClusterManager, EvalOptions } from '../managers/ClusterManager'
import { PromiseManager } from '../managers/PromiseManager'

/**
 * BrokerClient is responsible for managing communication between cluster managers and the cluster broker
 * through Redis Pub/Sub. It handles heartbeats, message routing, and request-response patterns.
 *
 * @example
 * ```typescript
 * const client = new BrokerClient(manager, {
 *   redis: 'redis://localhost:6379',
 *   type: 'bot'
 * })
 *
 * await client.connect()
 * ```
 */
export class BrokerClient extends EventEmitter<BrokerClientEvents> {
    /**
     * Unique identifier for this broker client
     */
    public readonly id: string

    /**
     * The Redis broker instance handling pub/sub operations
     */
    public readonly broker: RedisBroker

    /**
     * Manager for handling promise-based request/response patterns
     */
    public readonly promises = new PromiseManager()

    /**
     * Internal timer for sending periodic heartbeat messages
     * @private
     */
    private heartbeatInterval: NodeJS.Timeout | null = null

    /**
     * Creates a new BrokerClient instance
     *
     * @param manager - The cluster manager instance, or null for standalone clients
     * @param options - Configuration options for the broker client
     */
    constructor(public readonly manager: ClusterManager | null, public readonly options: BrokerClientOptions) {
        super()

        this.id = options.id ?? randomUUID()
        this.options.type = options.type || 'bot'
        this.options.heartbeatInterval = options.heartbeatInterval ?? 15_000

        this.broker = new RedisBroker(options.redis)

        this.broker.on('error', error => this.emit('error', error))
        this.broker.on('message', async (channel: string, message: IPCBaseMessage) => {
            if (typeof message.type === 'undefined') return

            // Handle responses to pending requests
            if (this.promises.has(message.nonce)) {
                this.promises.resolveMessage(message)
                return
            }

            const rawMessage = message as IPCRawMessage

            if (rawMessage.type === IPCMessageType.ClusterBrokerBroadcast) {
                const response = new IPCBaseMessage({ nonce: message.nonce })

                try {
                    const { script, options } = rawMessage.data
                    const data = await this.manager?.broadcastEval(script, options)

                    response.type = IPCMessageType.ClusterBrokerBroadcastResponse
                    response.data = data
                } catch (err) {
                    response.type = IPCMessageType.ClusterBrokerBroadcastResponse
                    response.error = makePlainError(err)
                }

                await this.broker.publish(BrokerChannels.ClusterBroker, response)
            } else if (rawMessage.type === IPCMessageType.ClusterBrokerHostData) {
                const response = new IPCBaseMessage({ nonce: message.nonce })

                response.type = IPCMessageType.ClusterBrokerHostDataResponse
                response.data = {
                    clientId: this.id,
                    hostname: os.hostname(),
                    uptime: os.uptime(),
                    cpuUsage: await cpu.usage(),
                    memoryUsed: await mem.used(),
                    shards: this.manager?.shards ?? [],
                    clusters: this.manager?.clusters ?? []
                }

                await this.broker.publish(BrokerChannels.ClusterBroker, response)
            } else if (rawMessage.type === IPCMessageType.CustomMessage) {
                this.emit('brokerMessage', rawMessage)
            } else if (rawMessage.type === IPCMessageType.CustomRequest) {
                this.emit('brokerRequest', rawMessage, async (data: any) => {
                    const reply = new IPCBaseMessage({
                        nonce: message.nonce,
                        type: IPCMessageType.CustomReply,
                        data
                    })
                    await this.broker.publish(BrokerChannels.ClusterBroker, reply)
                })
            }
        })
    }

    /**
     * Connects the broker client to Redis and subscribes to necessary channels.
     * Sends a ready notification to the cluster broker and starts the heartbeat.
     *
     * @returns The BrokerClient instance for chaining
     * @fires BrokerClient#ready
     */
    public async connect(): Promise<this> {
        await this.broker.connect()

        // Subscribe to own channel and broadcast channel
        await this.broker.subscribe(getClusterManagerChannel(this.id))
        await this.broker.subscribe(BrokerChannels.Broadcast)

        // Notify server that we're ready
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientReady,
            data: {
                clientId: this.id,
                type: this.options.type,
                shards: this.manager?.shards ?? [],
                clusters: this.manager?.clusters ?? []
            }
        })

        await this.broker.publish(BrokerChannels.ClusterBroker, message)

        // Start heartbeat
        this.startHeartbeat()
        this.emit('ready')

        return this
    }

    /**
     * Disconnects the broker client from Redis.
     * Stops the heartbeat and sends a disconnect notification to the cluster broker.
     *
     * @fires BrokerClient#close
     */
    public async disconnect(): Promise<void> {
        this.stopHeartbeat()

        // Notify server about disconnect
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientDisconnect,
            data: { clientId: this.id }
        })

        try {
            await this.broker.publish(BrokerChannels.ClusterBroker, message)
        } catch {
            // Ignore errors during disconnect
        }

        this.broker.disconnect()
        this.emit('close', 'Disconnected')
    }

    /**
     * Sends a one-way message to the cluster broker without expecting a response.
     *
     * @param message - The IPC message to send
     */
    public async send(message: IPCBaseMessage): Promise<void> {
        await this.broker.publish(BrokerChannels.ClusterBroker, message)
    }

    /**
     * Sends a request message to the cluster broker and waits for a response.
     *
     * @template T - The expected response type (defaults to IPCRawMessage)
     * @param message - The IPC message to send
     * @param timeout - Maximum time to wait for a response in milliseconds (default: 30000)
     * @returns A promise that resolves with the response data
     */
    public async request<T = IPCRawMessage>(message: IPCBaseMessage, timeout: number = 30_000): Promise<T> {
        const promise = this.promises.create<T>(message.nonce, { timeout })
        await this.broker.publish(BrokerChannels.ClusterBroker, message)
        return promise
    }

    /**
     * Requests shard assignment data from the cluster broker.
     *
     * @param timeout - Maximum time to wait for a response in milliseconds (default: 30000)
     * @returns Shard assignment information including shard IDs and total shard count
     */
    public async getShardingData(timeout: number = 30_000): Promise<ShardingData> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientShardList,
            data: { clientId: this.id }
        })

        const response = await this.request<IPCRawMessage>(message, timeout)

        if (response.error) throw makeError(response.error)

        return response.data as ShardingData
    }

    /**
     * Requests cluster assignment data from the cluster broker.
     *
     * @param clusterCount - The total number of clusters to distribute across
     * @param timeout - Maximum time to wait for a response in milliseconds (default: 30000)
     * @returns Cluster assignment information including assigned cluster IDs
     */
    public async getClusteringData(clusterCount: number, timeout: number = 30_000): Promise<ClusteringData> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientClusterList,
            data: { clientId: this.id, clusterCount }
        })

        const response = await this.request<IPCRawMessage>(message, timeout)

        if (response.error) throw makeError(response.error)

        return response.data as ClusteringData
    }

    /**
     * Retrieves system information from all connected hosts in the cluster.
     *
     * @param timeout - Maximum time to wait for responses in milliseconds (default: 30000)
     * @returns Array of host data including hostname, uptime, CPU usage, memory, and assigned shards/clusters
     */
    public async getHostsData(timeout: number = 30_000): Promise<HostData[]> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientHosts,
            data: { clientId: this.id, timeout }
        })

        const response = await this.request<IPCRawMessage>(message, timeout)

        if (response.error) throw makeError(response.error)

        return (response.data as HostData[]).sort((a, b) => a.clusters[0] - b.clusters[0])
    }

    /**
     * Evaluates a script across all clusters in the distributed system.
     *
     * @template T - The expected return type of the evaluation (defaults to any)
     * @param script - JavaScript code as a string or function to execute on each cluster
     * @param options - Evaluation options including context and timeout
     * @returns The aggregated result from all clusters
     */
    public async broadcastEval<T = any>(
        script: string | ((client: any) => any),
        options: EvalOptions = {}
    ): Promise<T> {
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[BrokerClient#broadcastEval] "script" must be a function or a string.')

        script = typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script

        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientBroadcast,
            data: { clientId: this.id, script, options, timeout: options.timeout }
        })

        const response = await this.request<IPCRawMessage>(message, options.timeout)

        if (response.error) throw makeError(response.error)

        return response.data
    }

    /**
     * Starts sending periodic heartbeat messages to the cluster broker.
     * Heartbeats include current timestamp, shards, and clusters information.
     * @private
     */
    private startHeartbeat(): void {
        if (this.heartbeatInterval) return

        this.heartbeatInterval = setInterval(async () => {
            try {
                const message = new IPCBaseMessage({
                    type: IPCMessageType.BrokerClientHeartbeat,
                    data: {
                        clientId: this.id,
                        timestamp: Date.now(),
                        shards: this.manager?.shards ?? [],
                        clusters: this.manager?.clusters ?? []
                    }
                })

                await this.broker.publish(BrokerChannels.ClusterBroker, message)
            } catch (error) {}
        }, this.options.heartbeatInterval)
    }

    /**
     * Stops the heartbeat timer and clears the interval.
     * @private
     */
    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval)
            this.heartbeatInterval = null
        }
    }
}

/**
 * Events emitted by the BrokerClient
 */
export interface BrokerClientEvents {
    /**
     * Emitted when the broker client successfully connects and is ready
     */
    ready: []

    /**
     * Emitted when an error occurs */
    error: [error: Error]

    /**
     * Emitted when the broker client disconnects
     */
    close: [reason: string]

    /**
     * Emitted when a custom message is received from the broker
     */
    brokerMessage: [message: IPCRawMessage]

    /**
     * Emitted when a custom request is received, with a callback to send the response
     */
    brokerRequest: [message: IPCRawMessage, respond: (data: any) => Promise<void>]
}

/**
 * Configuration options for BrokerClient
 */
export interface BrokerClientOptions {
    /**
     * Redis connection options or connection string
     */
    redis: RedisOptions | string

    /**
     * Unique identifier for this client (auto-generated if not provided)
     */
    id?: string

    /**
     * Type of broker client (default: 'bot')
     */
    type?: BrokerClientType

    /**
     * Interval in milliseconds between heartbeat messages (default: 15000)
     */
    heartbeatInterval?: number
}

/**
 * Type of broker client
 */
export type BrokerClientType = 'bot' | 'custom'

/**
 * Shard assignment data returned by the cluster broker
 */
export interface ShardingData {
    /**
     * Array of shard IDs assigned to this client
     */
    shards: number[]

    /**
     * Total number of shards in the system
     */
    shardCount: number
}

/**
 * Cluster assignment data returned by the cluster broker
 */
export interface ClusteringData {
    /**
     * Array of cluster IDs assigned to this client
     */
    clusters: number[]
}

/**
 * System and resource information for a host in the cluster
 */
export interface HostData {
    /**
     * Unique identifier of the client
     */
    clientId: string

    /**
     * Hostname of the machine
     */
    hostname: string

    /**
     * System uptime in seconds
     */
    uptime: number

    /**
     * CPU usage percentage (0-100)
     */
    cpuUsage: number

    /**
     * Memory usage information
     */
    memoryUsed: MemUsedInfo

    /**
     * Array of shard IDs running on this host
     */
    shards: number[]

    /**
     * Array of cluster IDs running on this host
     */
    clusters: number[]
}
