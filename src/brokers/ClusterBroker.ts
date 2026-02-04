import { WishMap } from '@danliyev/wishmap'
import { APIApplication, RouteBases, Routes } from 'discord.js'
import { EventEmitter } from 'events'
import { schedule, ScheduledTask, validate } from 'node-cron'
import { SystemResources } from '../managers/ClusterManager'
import { PromiseManager } from '../managers/PromiseManager'
import { BrokerClientType } from '../structures/BrokerClient'
import { BrokerMessagePayloadWithoutFrom, BrokerMessageType, createBrokerMessage } from '../structures/BrokerMessage'
import { ClusterStats } from '../structures/Cluster'
import { chunkArray, debounce, DebouncedFunction } from '../utils/Utils'
import { getBrokerClientChannel, RedisBroker, RedisBrokerChannels } from './RedisBroker'

/**
 * ClusterBroker is the central orchestrator for distributing Discord bot shards across multiple machines.
 * It manages shard assignments, monitors manager health, and handles automatic rebalancing.
 */
export class ClusterBroker extends EventEmitter<ClusterBrokerEvents> {
    /**
     * Timestamp when the broker became ready
     */
    public readyAt: number

    /**
     * Whether the broker is ready and operational
     */
    public get ready(): boolean {
        return this.readyAt > 0
    }

    /**
     * The Redis broker instance for pub/sub communication
     */
    public readonly broker: RedisBroker

    /**
     * Map of connected broker clients by their ID
     */
    public readonly clients = new WishMap<string, ClusterBrokerClient>()

    /**
     * Map of registered cluster managers by their ID
     */
    public readonly managers = new WishMap<string, ClusterBrokerManager>()

    /**
     * Promise manager for request/response patterns
     */
    public readonly promises = new PromiseManager()

    /**
     * Discord application ID
     */
    public appId: string

    /**
     * Approximate guild count from Discord API
     */
    public guildCount: number

    /**
     * Total number of shards to distribute
     */
    public shardCount: number

    /**
     * List of all shard IDs (0 to shardCount-1)
     */
    public readonly shardList: number[] = []

    /**
     * Number of shards assigned per manager
     */
    public shardsPerManager: number

    /**
     * Current state of the broker lifecycle
     */
    private state: ClusterBrokerState = ClusterBrokerState.Initializing

    /**
     * Debounced function for shard assignment (15s delay)
     */
    private readonly assignShards: DebouncedFunction<() => void>

    /**
     * Current retry count for waiting for managers
     */
    private waitForManagersRetry: number = 0

    /**
     * Cron job for periodic shard rebalancing
     */
    private shardsRebalancingJob: ScheduledTask

    constructor(public readonly options: ClusterBrokerOptions) {
        super()

        this.assignShards = debounce(async () => {
            if (this.state === ClusterBrokerState.Assigning) return
            this.state = ClusterBrokerState.Assigning

            this.debug('starting shard assignment', { managers: this.managers.size, shards: this.shardCount })

            this.managers.forEach(v => {
                v.clusterCount = 0
                v.shardList = []
                v.readyAt = 0
            })

            this.shardsPerManager = Math.ceil(this.shardCount / this.managers.size)
            const shards: number[][] = chunkArray(this.shardList, this.shardsPerManager)
            const managers = [...this.managers.values()]

            this.debug('shard distribution calculated', { shardsPerManager: this.shardsPerManager })
            // Running counter for firstClusterId calculation
            let firstClusterId = 0

            for (let i = 0; i < managers.length; i++) {
                const manager = managers[i],
                    managerShards = shards[i]

                if (!managerShards || managerShards.length === 0) {
                    this.debug('skipping manager, no shards to assign', { managerId: manager.id })
                    continue
                }

                this.debug('assigning shards to manager', {
                    managerId: manager.id,
                    shards: managerShards,
                    firstClusterId
                })

                manager.shardList = managerShards
                await this.send(manager.id, {
                    type: BrokerMessageType.ShardAssignment,
                    data: { firstClusterId, shardCount: this.shardCount, shardList: managerShards }
                })

                this.emit('managerShardsAssign', manager, managerShards)
                this.debug('waiting for manager readiness', { managerId: manager.id })
                await this.promises.create(`manager-readiness:${manager.id}`)

                // Update running total with actual cluster count from manager
                firstClusterId += manager.clusterCount
                this.debug('manager ready', {
                    managerId: manager.id,
                    clusterCount: manager.clusterCount,
                    firstClusterId
                })
            }

            this.debug('shard assignment complete')
            this.state = ClusterBrokerState.Ready
        }, 15_000)

        this.options.healthcheckInterval = options.healthcheckInterval || 30_000
        this.options.shardsRebalancingCron = options.shardsRebalancingCron || '*/30 * * * *'
        if (!validate(this.options.shardsRebalancingCron))
            throw new Error('[ClusterBroker] Invalid shards rebalancing cron expression.')

        this.broker = new RedisBroker(options.redisURI)

        this.broker.on('error', error => this.emit('error', error))
        this.broker.on('message', async (channel, message) => {
            this.debug('received message from broker', { channel, message })

            if (channel === RedisBrokerChannels.ClusterBroker) {
                if (message.type === BrokerMessageType.BrokerClientConnect) {
                    this.clients.set(message.data.id, message.data)
                } else if (message.type === BrokerMessageType.BrokerClientDisconnect) {
                    const client = this.clients.get(message.data.id)
                    if (!client) this.emit('error', new Error(`Unknown client "${message.data.id}" disconnected`))

                    this.clients.delete(client.id)
                } else if (message.type === BrokerMessageType.ClusterManagerRegister) {
                    this.managers.set(message.data.id, {
                        ...message.data,
                        clusterCount: 0,
                        clusters: [],
                        shardList: [],
                        readyAt: 0,
                        lastHeartbeatAt: Date.now()
                    })
                } else if (message.type === BrokerMessageType.ClusterManagerHeartbeat) {
                    const manager = this.managers.get(message.data.id)
                    if (!manager) {
                        this.emit(
                            'error',
                            new Error(`Received heartbeat from unregistered cluster manager "${message.data.id}"`)
                        )

                        return
                    }

                    const now = Date.now()
                    const beatsGap = now - manager.lastHeartbeatAt

                    manager.clusters = message.data.clusters
                    manager.lastHeartbeatAt = now
                    manager.cpuCores = message.data.cpuCores
                    manager.cpuUsage = message.data.cpuUsage
                    manager.memoryTotal = message.data.memoryTotal
                    manager.memoryUsage = message.data.memoryUsage
                    manager.uptime = message.data.uptime

                    this.emit('managerHeartbeat', manager, beatsGap)
                } else if (message.type === BrokerMessageType.ClusterManagerReady) {
                    const manager = this.managers.get(message.data.id)
                    if (!manager) {
                        this.emit(
                            'error',
                            new Error(`Cluster manager "${message.data.id}" is ready before registration.`)
                        )

                        return
                    }

                    manager.clusterCount = message.data.clusterCount
                    manager.shardList = message.data.shardList
                    manager.readyAt = Date.now()

                    // Detect warm start: receiving ClusterManagerReady during initialization
                    // means this manager already had shards before broker restarted
                    if (this.state === ClusterBrokerState.Initializing && manager.shardList.length > 0) {
                        this.state = ClusterBrokerState.WarmStart
                        this.debug('warm start indicator received')
                    }

                    this.emit('managerReady', manager)
                    this.promises.resolve(`manager-readiness:${message.data.id}`)
                } else if (message.type === BrokerMessageType.RequestStats) {
                    await this.send(message.from, {
                        type: BrokerMessageType.RequestStatsResult,
                        nonce: message.nonce,
                        data: {
                            readyAt: this.readyAt,
                            clients: [...this.clients.values()],
                            managers: [...this.managers.values()],
                            shardCount: this.shardCount,
                            shardsPerManager: this.shardsPerManager
                        }
                    })
                }
            }
        })
    }

    /**
     * Initializes the cluster broker by connecting to Redis, fetching Discord app info,
     * and starting to wait for cluster managers to register.
     *
     * @returns The broker instance for chaining
     * @fires ClusterBroker#ready
     */
    public async initialize(): Promise<this> {
        if (!this.options.botToken) throw new Error('[ClusterBroker#initialize] "botToken" is required.')

        // Reset state for initialization
        this.state = ClusterBrokerState.Initializing

        this.debug('initializing cluster broker')

        await this.broker.connect()
        this.debug('connected to Redis')

        await this.broker.subscribe(RedisBrokerChannels.ClusterBroker)
        this.debug('subscribed to broker channel')

        await this.fetchApplication()
        this.debug('fetched application', { appId: this.appId, guildCount: this.guildCount })

        this.shardCount = Number(this.options.shardCount) || this.calculateShardCount()
        this.shardList.push(...Array.from({ length: this.shardCount }, (v, i) => i))
        this.debug('calculated shard count', { shardCount: this.shardCount })

        await this.broadcast({ type: BrokerMessageType.ClusterBrokerInitialize })
        this.debug('broadcasted initialization message')

        this.readyAt = Date.now()
        this.emit('ready')
        this.waitForManagers()
        this.setupHealthcheck()

        this.clients.events.on('set', (key, value) => this.emit('clientConnect', value))
        this.clients.events.on('delete', (key, value) => {
            this.emit('clientDisconnect', value)
            this.managers.delete(key)
        })
        this.managers.events.on('set', (key, value) => this.emit('managerCreate', value))
        this.managers.events.on('delete', (key, value) => this.emit('managerRemove', value))

        this.debug('cluster broker initialized')
        return this
    }

    /**
     * Disconnects the broker from Redis and emits a disconnect event.
     * @fires ClusterBroker#disconnect
     */
    public async disconnect(): Promise<void> {
        await this.broker.disconnect()
        this.emit('disconnect')
    }

    /**
     * Sends a message to a specific broker client via Redis pub/sub.
     * @param channelOrClientId - The client ID or full channel name
     * @param payload - The message payload to send
     * @returns Number of subscribers that received the message
     */
    public send(channelOrClientId: string, payload: BrokerMessagePayloadWithoutFrom): Promise<number> {
        return this.broker.publish(
            channelOrClientId.startsWith('letsfrag:broker-client')
                ? channelOrClientId
                : getBrokerClientChannel(channelOrClientId),
            createBrokerMessage({ from: RedisBrokerChannels.ClusterBroker, ...payload })
        )
    }

    /**
     * Broadcasts a message to all connected broker clients.
     * @param payload - The message payload to broadcast
     * @returns Number of subscribers that received the message
     */
    public broadcast(payload: BrokerMessagePayloadWithoutFrom): Promise<number> {
        return this.broker.publish(
            RedisBrokerChannels.Broadcast,
            createBrokerMessage({ from: RedisBrokerChannels.ClusterBroker, ...payload })
        )
    }

    private get isWarmStartComplete(): boolean {
        if (!this.managers.size || this.state !== ClusterBrokerState.WarmStart) return false
        if (!this.managers.every(v => v.readyAt > 0)) return false

        const assignedShards = new Set<number>(this.managers.flatMap(v => v.shardList))
        return this.shardList.every(s => assignedShards.has(s))
    }

    private async fetchApplication(): Promise<APIApplication> {
        const response = await fetch(RouteBases.api + Routes.currentApplication(), {
            method: 'GET',
            headers: {
                Authorization: `Bot ${this.options.botToken}`
            }
        })

        if (!response.ok) {
            throw new Error(`[ClusterBroker#fetchApplication] Failed to fetch application (${await response.text()}).`)
        }

        const app = (await response.json()) as APIApplication
        this.appId = app.id
        this.guildCount = app.approximate_guild_count || 0

        return app
    }

    private calculateShardCount(): number {
        const { guildsPerShard = 1000, growthFactor = 1 } = this.options.shardCountCalc ?? {}
        return Math.ceil((this.guildCount * growthFactor) / guildsPerShard)
    }

    private waitForManagers(): void {
        this.waitForManagersRetry++
        const delay = this.waitForManagersRetry * 10_000

        this.debug('waiting for managers', {
            retry: this.waitForManagersRetry,
            delay,
            state: ClusterBrokerState[this.state]
        })

        setTimeout(() => {
            // Warm start: all managers ready with all shards assigned
            if (this.isWarmStartComplete) {
                this.debug('warm start complete, preserving existing shard assignments')
                this.state = ClusterBrokerState.Ready
                this.setupShardsRebalancing()
                this.waitForManagersRetry = 0
                return
            }

            if (!this.managers.size) {
                this.debug('no managers registered, retrying')
                return this.waitForManagers()
            }

            // Cold start or incomplete warm start - assign shards
            this.debug('starting shard assignment')
            this.assignShards()
            this.setupShardsRebalancing()

            this.waitForManagersRetry = 0
        }, delay)
    }

    private setupHealthcheck(): void {
        this.debug('setting up healthcheck', { interval: this.options.healthcheckInterval })

        const healthcheck = () => {
            const unhealthyManagers = this.managers.filter(
                v => Date.now() - v.lastHeartbeatAt > this.options.healthcheckInterval * 3
            )
            if (!unhealthyManagers.size) return

            for (const [, manager] of unhealthyManagers) {
                this.debug('removing unhealthy manager', { managerId: manager.id })
                this.clients.delete(manager.id)
                this.emit('managerUnhealthy', manager)
            }

            // Trigger immediate rebalance to reassign orphaned shards
            if (unhealthyManagers.size > 0 && this.managers.size > 0) {
                this.debug('triggering immediate rebalance due to manager removal')
                this.assignShards()
            }
        }

        const setHealthcheckTimeout = () =>
            setTimeout(() => {
                healthcheck()
                setHealthcheckTimeout()
            }, this.options.healthcheckInterval)

        setHealthcheckTimeout()
    }

    private setupShardsRebalancing(): void {
        this.debug('setting up shards rebalancing', { cron: this.options.shardsRebalancingCron })

        const rebalanceShards = () => {
            const managers = this.managers.filter(
                v => Date.now() - v.lastHeartbeatAt < this.options.healthcheckInterval * 3
            )

            if (!managers.size || this.state === ClusterBrokerState.Assigning) {
                this.debug('rebalance skipped', { managers: managers.size, state: ClusterBrokerState[this.state] })
                return
            }

            const assignedShards = new Set(managers.flatMap(v => v.shardList)),
                unassignedShards = this.shardList.filter(v => !assignedShards.has(v))

            const shardsPerManager = Math.ceil(this.shardCount / managers.size),
                isUnbalanced = managers.some(v => Math.abs(v.shardList.length - shardsPerManager) > 1)

            this.debug('rebalance check', {
                unassignedShards: unassignedShards.length,
                isUnbalanced,
                shardsPerManager
            })

            if (unassignedShards.length > 0 || isUnbalanced) {
                this.debug('triggering rebalance')
                this.assignShards()
            }
        }

        this.shardsRebalancingJob?.destroy()
        this.shardsRebalancingJob = schedule(this.options.shardsRebalancingCron, rebalanceShards.bind(this))
    }

    private debug(message: string, ...args: unknown[]): void {
        this.emit('debug', message, args)
    }
}

/**
 * Events emitted by ClusterBroker
 */
export interface ClusterBrokerEvents {
    /** Emitted when an error occurs */
    error: [error: Error]
    /** Emitted for debug messages */
    debug: [message: string, args: unknown[]]
    /** Emitted when the broker is ready */
    ready: []
    /** Emitted when the broker disconnects */
    disconnect: []
    /** Emitted when a broker client connects */
    clientConnect: [client: ClusterBrokerClient]
    /** Emitted when a broker client disconnects */
    clientDisconnect: [client: ClusterBrokerClient]
    /** Emitted when a cluster manager registers */
    managerCreate: [manager: ClusterBrokerManager]
    /** Emitted when a cluster manager is removed */
    managerRemove: [manager: ClusterBrokerManager]
    /** Emitted when a cluster manager becomes ready */
    managerReady: [manager: ClusterBrokerManager]
    /** Emitted on manager heartbeat */
    managerHeartbeat: [manager: ClusterBrokerManager, beatsGap: number]
    /** Emitted when shards are assigned to a manager */
    managerShardsAssign: [manager: ClusterBrokerManager, shards: number[]]
    /** Emitted when a manager becomes unhealthy */
    managerUnhealthy: [manager: ClusterBrokerManager]
}

/**
 * Broker lifecycle states
 */
export enum ClusterBrokerState {
    /** Initial startup, waiting for managers */
    Initializing = 1,
    /** Warm start detected, managers already have shards */
    WarmStart,
    /** Actively assigning shards to managers */
    Assigning,
    /** Normal operation */
    Ready
}

/**
 * Configuration options for ClusterBroker
 */
export interface ClusterBrokerOptions {
    /** Redis connection URI */
    redisURI: string
    /** Discord bot token for API calls */
    botToken: string
    /** Fixed shard count (auto-calculated if not provided) */
    shardCount?: number
    /** Shard count calculation options */
    shardCountCalc?: ClusterBrokerOptionsShardCountCalc
    /** Health check interval in ms (default: 30000) */
    healthcheckInterval?: number
    /** Cron expression for shard rebalancing (default: every 30 min) */
    shardsRebalancingCron?: string
}

/**
 * Options for automatic shard count calculation
 */
export interface ClusterBrokerOptionsShardCountCalc {
    /** Guilds per shard (default: 1000) */
    guildsPerShard?: number
    /** Growth factor multiplier (default: 1) */
    growthFactor?: number
}

/**
 * Connected broker client info
 */
export interface ClusterBrokerClient {
    /** Unique client identifier */
    id: string
    /** Client type */
    type: BrokerClientType
}

/**
 * Registered cluster manager info
 */
export interface ClusterBrokerManager extends SystemResources {
    /** Unique manager identifier */
    id: string
    /** Number of clusters on this manager */
    clusterCount: number
    /** Stats for each cluster */
    clusters: ClusterStats[]
    /** Shard IDs assigned to this manager */
    shardList: number[]
    /** Timestamp when manager became ready */
    readyAt: number
    /** Timestamp of last heartbeat */
    lastHeartbeatAt: number
}
