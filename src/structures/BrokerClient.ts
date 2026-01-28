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

    public readonly channel: string

    /**
     * The Redis broker instance handling pub/sub operations
     */
    public readonly broker: RedisBroker

    public readonly promises = new PromiseManager()

    private heartbeatInterval: NodeJS.Timeout

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

        const shutdownSignals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'beforeExit']
        for (const signal of shutdownSignals) process.on(signal, () => this.disconnect())
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
            if (this.manager) {
                const systemResources = await this.manager.getSystemResources()
                const clusterStats = [...this.manager.clusters.values()].filter(v => v.stats).map(v => v.stats)

                await this.send({
                    type: BrokerMessageType.ClusterManagerHeartbeat,
                    data: { id: this.id, ...systemResources, clusters: clusterStats }
                })
            }
        }, this.options.heartbeatInterval || 15_000)

        return this
    }

    /**
     * Disconnects the broker client from Redis.
     * Stops the heartbeat and sends a disconnect notification to the cluster broker.
     *
     * @fires BrokerClient#close
     */
    public async disconnect(): Promise<void> {
        try {
            clearInterval(this.heartbeatInterval)
            await this.send({ type: BrokerMessageType.BrokerClientDisconnect, data: { id: this.id } })
            this.broker.disconnect()
            this.emit('disconnect')
        } catch (err) {
            this.emit('error', err)
        }
    }

    /**
     * Sends a one-way message to the cluster broker without expecting a response.
     *
     * @param message - The broker message to send
     */
    public send(payload: BrokerMessagePayloadWithoutFrom): Promise<number> {
        return this.broker.publish(
            RedisBrokerChannels.ClusterBroker,
            createBrokerMessage({ from: this.channel, ...payload })
        )
    }

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
     * Emitted when an error occurs */
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

    heartbeatInterval?: number
}

/**
 * Type of broker client
 */
export enum BrokerClientType {
    Bot = 1,
    Custom
}
