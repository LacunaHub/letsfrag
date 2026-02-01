import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { getBrokerClientChannel, RedisBroker, RedisBrokerChannels } from '../brokers/RedisBroker'
import { ClusterManager } from '../managers/ClusterManager'
import { PromiseManager } from '../managers/PromiseManager'
import {
    BrokerMessage,
    BrokerMessagePayloadWithoutFrom,
    BrokerMessageRequestStatsResult,
    BrokerMessageType,
    createBrokerMessage
} from './BrokerMessage'
import { SpawnQueueState } from './SpawnQueue'

/**
 * BrokerClient is responsible for managing communication between cluster managers and the cluster broker
 * through Redis Pub/Sub. It handles heartbeats, message routing, and request-response patterns.
 *
 * @example
 * ```typescript
 * const client = new BrokerClient(manager, {
 *   redisURI: 'redis://localhost:6379'
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
     * The dedicated Redis channel for this client (letsfrag:broker-client:{id})
     */
    public readonly channel: string

    /**
     * The Redis broker instance handling pub/sub operations
     */
    public readonly broker: RedisBroker

    /**
     * Manager for request-response patterns using nonces
     */
    public readonly promises = new PromiseManager()

    /**
     * Timer for periodic heartbeat messages to the broker
     */
    private heartbeatInterval: NodeJS.Timeout

    /**
     * Whether the client is currently disconnecting or already disconnected
     */
    private disconnecting = false

    /**
     * Creates a new BrokerClient instance
     *
     * @param manager - The cluster manager instance, or null for standalone clients
     * @param options - Configuration options for the broker client
     */
    constructor(
        public readonly manager: ClusterManager | null,
        public readonly options: BrokerClientOptions
    ) {
        super()

        this.id = options.id || randomUUID()
        this.channel = getBrokerClientChannel(this.id)
        this.options.type = options.type || BrokerClientType.Bot

        this.broker = new RedisBroker(options.redisURI)

        this.broker.on('error', error => this.emit('error', error))
        this.broker.on('message', async (channel: string, message: BrokerMessage) => {
            if (channel === this.channel) {
                if (message.type === BrokerMessageType.ShardAssignment) {
                    this.manager.firstClusterId = message.data.firstClusterId
                    this.manager.shardCount = message.data.shardCount
                    this.manager.shardList = message.data.shardList

                    if (this.manager.spawnQueue.state !== SpawnQueueState.Empty) this.manager.spawnQueue.clear()
                    await this.manager.respawnClusters()
                } else if (message.type === BrokerMessageType.RequestStatsResult) {
                    this.promises.resolve(message.nonce, message)
                }
            }

            if (channel === RedisBrokerChannels.Broadcast) {
                if (message.type === BrokerMessageType.ClusterBrokerInitialize) {
                    await this.send({
                        type: BrokerMessageType.BrokerClientConnect,
                        data: { id: this.id, type: this.options.type }
                    })

                    if (this.manager) {
                        const systemResources = await this.manager.getSystemResources()
                        await this.send({
                            type: BrokerMessageType.ClusterManagerRegister,
                            data: {
                                id: this.id,
                                ...systemResources
                            }
                        })

                        if (this.manager.ready) this.manager.emit('ready')
                    }
                }
            }
        })

        const shutdown = () => this.disconnect().then(() => process.exit(0))
        process.once('SIGINT', shutdown)
        process.once('SIGTERM', shutdown)
        process.once('SIGHUP', shutdown)
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
        await this.broker.subscribe(this.channel)
        await this.broker.subscribe(RedisBrokerChannels.Broadcast)

        await this.send({
            type: BrokerMessageType.BrokerClientConnect,
            data: { id: this.id, type: this.options.type }
        })

        this.emit('ready')
        this.heartbeatInterval = setInterval(async () => {
            if (this.disconnecting || !this.manager) return

            const systemResources = await this.manager.getSystemResources()
            const clusterStats = [...this.manager.clusters.values()].filter(v => v.stats).map(v => v.stats)

            await this.send({
                type: BrokerMessageType.ClusterManagerHeartbeat,
                data: { id: this.id, ...systemResources, clusters: clusterStats }
            })
        }, this.options.heartbeatInterval || 15_000)

        return this
    }

    /**
     * Disconnects the broker client from Redis.
     * Stops the heartbeat and sends a disconnect notification to the cluster broker.
     *
     * @fires BrokerClient#disconnect
     */
    public async disconnect(): Promise<void> {
        if (this.disconnecting) return
        this.disconnecting = true

        try {
            clearInterval(this.heartbeatInterval)
            await this.send({ type: BrokerMessageType.BrokerClientDisconnect, data: { id: this.id } })
            await this.broker.disconnect()
            this.emit('disconnect')
        } catch {
            // Ignore errors during shutdown
        }
    }

    /**
     * Sends a one-way message to the cluster broker without expecting a response.
     *
     * @param payload - The broker message payload to send
     * @returns The number of subscribers that received the message
     */
    public send(payload: BrokerMessagePayloadWithoutFrom): Promise<number> {
        return this.broker.publish(
            RedisBrokerChannels.ClusterBroker,
            createBrokerMessage({ from: this.channel, ...payload })
        )
    }

    /**
     * Sends a request to the cluster broker and waits for a response.
     * Uses nonce-based correlation for matching requests to responses.
     *
     * @param payload - The broker message payload to send
     * @param options - Request options
     * @param options.timeout - Timeout in milliseconds (default: 30000)
     * @returns The response data from the broker
     */
    public async request(payload: BrokerMessagePayloadWithoutFrom, options: { timeout?: number } = {}) {
        const { timeout = 30_000 } = options
        const message = createBrokerMessage({ from: this.channel, ...payload })

        await this.broker.publish(RedisBrokerChannels.ClusterBroker, message)

        const response = await this.promises.create<BrokerMessageRequestStatsResult>(message.nonce, { timeout })
        return response.data
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
     * Emitted when an error occurs
     */
    error: [error: Error]

    /**
     * Emitted when the broker client disconnects
     */
    disconnect: []
}

/**
 * Configuration options for BrokerClient
 */
export interface BrokerClientOptions {
    /**
     * Redis connection options or connection string
     */
    redisURI: string

    /**
     * Unique identifier for this client (auto-generated if not provided)
     */
    id?: string

    /**
     * Type of broker client
     */
    type?: BrokerClientType

    /**
     * Interval in milliseconds between heartbeat messages (default: 15000)
     */
    heartbeatInterval?: number
}

/**
 * Type of broker client for identification purposes
 */
export enum BrokerClientType {
    /** Standard Discord bot manager */
    Bot = 1,
    /** Custom client for monitoring or external integrations */
    Custom
}
