import { WishMap } from '@danliyev/wishmap'
import { ForkOptions } from 'child_process'
import EventEmitter from 'events'
import { statSync } from 'fs'
import { OSUtils } from 'node-os-utils'
import { isAbsolute, resolve } from 'path'
import { BrokerClient, BrokerClientOptions } from '../structures/BrokerClient'
import { BrokerMessageType } from '../structures/BrokerMessage'
import { Cluster } from '../structures/Cluster'
import { IPCMessage } from '../structures/IPCMessage'
import { SpawnQueue } from '../structures/SpawnQueue'
import { chunkArray, serializeScript } from '../utils/Utils'
import { PromiseManager } from './PromiseManager'

/**
 * Manages multiple cluster instances.
 */
export class ClusterManager extends EventEmitter<ClusterManagerEvents> {
    /**
     * Time the manager was ready.
     */
    public readyAt: number

    /**
     * Whether the manager is ready.
     */
    public get ready(): boolean {
        return this.readyAt > 0
    }

    /**
     * Broker client.
     */
    public brokerClient: BrokerClient

    /**
     * Map of cluster instances.
     */
    public readonly clusters = new WishMap<number, Cluster>()

    public clusterCount: number

    public clusterList: number[] = []

    public firstClusterId: number

    /**
     * Total number of shards.
     */
    public shardCount: number

    public shardsPerCluster: number

    /**
     * List of shards that this manager handles.
     */
    public shardList: number[] = []

    /**
     * Promise manager.
     */
    public readonly promises = new PromiseManager()
    public readonly spawnQueue: SpawnQueue

    private healthcheckInterval: NodeJS.Timeout

    private readonly os = new OSUtils()

    constructor(
        public file: string,
        public options: ClusterManagerOptions
    ) {
        if (!file) throw new TypeError('[ClusterManager] "file" is required.')

        super()

        this.file = isAbsolute(file) ? file : resolve(process.cwd(), file)
        if (!statSync(this.file).isFile()) throw new TypeError(`[ClusterManager] "${file}" is not a file.`)

        this.brokerClient = new BrokerClient(this, options.brokerClient)

        this.options.spawnDelay = +options.spawnDelay || 10_000
        this.options.spawnTimeout = +options.spawnTimeout || 60_000

        this.spawnQueue = new SpawnQueue({ delay: this.options.spawnDelay })

        this.on('ready', () => {
            this.brokerClient.send({
                type: BrokerMessageType.ClusterManagerReady,
                data: {
                    id: this.brokerClient.id,
                    clusterCount: this.clusterCount,
                    shardList: this.shardList
                }
            })

            this.setupHealthcheck()
        })
    }

    public async register() {
        await this.brokerClient.connect()
        const systemResources = await this.getSystemResources()
        await this.brokerClient.send({
            type: BrokerMessageType.ClusterManagerRegister,
            data: {
                id: this.brokerClient.id,
                ...systemResources
            }
        })
        this.emit('register')
    }

    /**
     * Initializes the manager and spawns clusters.
     */
    public async spawnClusters(): Promise<this> {
        if (this.options.spawnDelay < 8000) {
            process.emitWarning(
                '[ClusterManager#spawn] Spawn delay is smaller than 8s, this can cause global rate limits on /gateway/bot'
            )
        }

        this.clusterCount = Number(this.options.clusterCount) || (await this.calculateClusterCount())
        this.shardsPerCluster = Math.ceil(this.shardList.length / this.clusterCount)
        if (this.shardList.length / this.shardsPerCluster !== this.clusterCount)
            this.clusterCount = Math.ceil(this.shardList.length / this.shardsPerCluster)

        if (this.clusterCount > this.shardList.length)
            throw new Error('[ClusterManager#spawn] "clusterCount" cannot be more than shards.')
        if (this.shardsPerCluster > this.shardList.length)
            throw new Error('[ClusterManager#spawn] "shardsPerCluster" must be less than shards.')
        if (this.shardsPerCluster < 1) throw new Error('[ClusterManager#spawn] "shardsPerCluster" must be at least 1.')

        const shards: number[][] = chunkArray(this.shardList, this.shardsPerCluster)
        if (shards.length !== this.clusterCount) this.clusterCount = shards.length
        this.clusterList = shards.map((v, i) => i)

        for (let i = 0; i < this.clusterList.length; i++) {
            const clusterShards = shards[i]

            this.spawnQueue.add({
                run: (timeout: number) => this.createCluster(i + this.firstClusterId, clusterShards).spawn(timeout),
                args: [this.options.spawnTimeout]
            })
        }

        await this.spawnQueue.start()
        return this
    }

    /**
     * Creates a new cluster.
     * @param id ID of the cluster.
     * @param shards Shard list of the cluster.
     */
    public createCluster(id: number, shards: number[]): Cluster {
        const cluster = new Cluster(this, id, shards)

        this.clusters.set(id, cluster)
        this.emit('clusterCreate', cluster)

        return cluster
    }

    /**
     * Respawns all clusters.
     * @param options - Respawn options
     */
    public async respawnClusters(options: RespawnClustersOptions = {}): Promise<this> {
        const {
            spawnDelay = this.options.spawnDelay,
            spawnTimeout = this.options.spawnTimeout,
            clusterIds = []
        } = options

        this.promises.cache.clear()

        if (clusterIds.length) {
            const clusters = this.clusters.filter(v => (clusterIds.length ? clusterIds.includes(v.id) : true))

            for (const [, cluster] of clusters) {
                this.spawnQueue.add({
                    run: (timeout: number) => cluster.respawn(timeout),
                    args: [spawnTimeout],
                    delay: spawnDelay
                })
            }

            await this.spawnQueue.start()
        } else {
            for (const [, cluster] of this.clusters) cluster.kill()
            this.clusters.clear()
            await this.spawnClusters()
        }

        return this
    }

    /**
     * Broadcasts a message to all clusters.
     * @param message - Message to broadcast
     */
    public broadcast(message: IPCMessage): Promise<void[]> {
        return Promise.all(this.clusters.map(cluster => cluster.send(message)))
    }

    /**
     * Broadcasts a script to all clusters.
     * @param script - Script to broadcast
     * @param options - Options for the script
     */
    public async broadcastEval<T = any>(
        script: string | ((manager: ClusterManager) => T),
        options: EvalOptions = {}
    ): Promise<T> {
        if (!this.clusters.size) throw new Error('[ClusterManager#broadcastEval] No clusters found.')
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterManager#broadcastEval] "script" must be a function or a string.')

        const serializedScript = serializeScript(script, options.context)
        let targetClusters = [...this.clusters.values()]

        if (Array.isArray(options.shardList)) {
            if (options.shardList.some(v => v < 0) || !options.shardList.every(v => this.shardList.includes(v)))
                throw new Error('[ClusterManager#broadcastEval] Invalid shards.')

            const clusterIds = new Set<number>()
            for (const [, cluster] of this.clusters) {
                if (cluster.shardList.some(v => options.shardList.includes(v))) clusterIds.add(cluster.id)
            }

            if (!clusterIds.size) throw new Error('[ClusterManager#broadcastEval] No clusters found.')
            options.clusterList = Array.from(clusterIds)
        }

        if (Array.isArray(options.clusterList)) {
            if (options.clusterList.some(v => v < 0) || !options.clusterList.every(v => this.clusters.has(v)))
                throw new Error('[ClusterManager#broadcastEval] Invalid clusters.')

            targetClusters = targetClusters.filter(v => options.clusterList.includes(v.id))
            if (!targetClusters.length) throw new Error('[ClusterManager#broadcastEval] No clusters found.')
        }

        const promises = targetClusters.map(cluster => cluster.evalOnShard(serializedScript, options))
        const results = (await Promise.allSettled(promises)) as PromiseFulfilledResult<any>[]

        return results.filter(r => r.status === 'fulfilled').map(r => r.value) as T
    }

    /**
     * Evaluates a script on the manager.
     * @param script - Script to evaluate
     * @param options - Options for the script
     * @returns Result and error (if any)
     */
    public async eval<T = any>(
        script: string | ((manager: ClusterManager) => T),
        options: { context?: any; timeout?: number } = {}
    ): Promise<{ result: any; error: Error | undefined }> {
        let result: any
        let error: Error | undefined

        try {
            const serializedScript = serializeScript(script, options.context)
            result = await eval(serializedScript)
        } catch (err) {
            error = err as Error
        }

        return { result, error }
    }

    public async getSystemResources(): Promise<SystemResources> {
        const coreCount = await this.os.cpu.coreCount()
        const cpuUsage = await this.os.cpu.usage()
        const memoryTotal = await this.os.memory.total()
        const memoryUsed = await this.os.memory.usage()
        const uptime = await this.os.system.uptime()

        return {
            cpuCores: coreCount.success ? coreCount.data.physical : 0,
            cpuUsage: cpuUsage.success ? cpuUsage.data : 0,
            memoryTotal: memoryTotal.success ? memoryTotal.data.toMB() : 0,
            memoryUsage: memoryUsed.success ? memoryUsed.data : 0,
            uptime: uptime.success ? uptime.data.uptime : 0
        }
    }

    private async calculateClusterCount(): Promise<number> {
        if (!this.shardCount || this.shardCount < 1) return 0
        const {
            strategy = ClusterManagerOptionsClusterCountCalcStrategy.Auto,
            memoryPerClusterMB = 500,
            maxShardsPerCluster = 8
        } = this.options.clusterCountCalc ?? {}

        const systemResources = await this.getSystemResources()
        const maxByCores = Math.max(1, systemResources.cpuCores)
        const maxByMemory = Math.floor(systemResources.memoryTotal / memoryPerClusterMB)
        const minByShards = Math.ceil(this.shardList.length / maxShardsPerCluster)

        const optimalValues = [this.shardList.length]
        if (strategy === ClusterManagerOptionsClusterCountCalcStrategy.CPUCores) optimalValues.push(maxByCores)
        else if (strategy === ClusterManagerOptionsClusterCountCalcStrategy.Memory) optimalValues.push(maxByMemory)
        else optimalValues.push(maxByCores, maxByMemory)

        let optimal = Math.min(...optimalValues)
        optimal = Math.max(optimal, minByShards, 1)

        return optimal
    }

    private setupHealthcheck() {
        const intervalMS = this.options.healthcheckInterval || 30_000

        const clearHealthcheckInterval = () => {
            if (!this.healthcheckInterval) return

            clearInterval(this.healthcheckInterval)
            this.healthcheckInterval = null
        }

        const healthcheck = async () => {
            const unhealthyClusters = this.clusters.filter(
                v => v.ready && Date.now() - v.stats?.lastHeartbeatAt > intervalMS * 10
            )

            if (!unhealthyClusters.length) return

            for (const [, cluster] of unhealthyClusters) this.emit('clusterUnhealthy', cluster)
            clearHealthcheckInterval()
            await this.respawnClusters({ clusterIds: unhealthyClusters.map(v => v.id) })
            this.setupHealthcheck()
        }

        clearHealthcheckInterval()
        this.healthcheckInterval = setInterval(healthcheck.bind(this), intervalMS)
    }
}

/**
 * Events emitted by ClusterManager.
 */
export interface ClusterManagerEvents {
    /**
     * Emitted when all clusters are ready.
     */
    ready: []

    /**
     * Emitted when an error occurs.
     */
    error: [error: Error]

    register: []

    /**
     * Emitted when a cluster is created.
     */
    clusterCreate: [cluster: Cluster]

    /**
     * Emitted when a cluster becomes ready.
     */
    clusterReady: [cluster: Cluster]

    /**
     * Emitted when a cluster dies.
     */
    clusterDeath: [cluster: Cluster]

    /**
     * Emitted when a cluster spawn times out.
     */
    clusterTimeout: [cluster: Cluster]

    clusterUnhealthy: [cluster: Cluster]
}

/**
 * Configuration options for ClusterManager.
 */
export interface ClusterManagerOptions {
    /**
     * BrokerClient options.
     */
    brokerClient: BrokerClientOptions

    /**
     * Node.js fork options for child processes.
     */
    childProcess?: ForkOptions

    /**
     * Total number of clusters.
     */
    clusterCount?: number

    /**
     * Ignored if "clusterCount" is set
     */
    clusterCountCalc?: ClusterManagerOptionsClusterCountCalc

    /**
     * Arguments to pass to shards.
     */
    shardArgs?: any[]

    /**
     * Exec arguments for child processes.
     */
    execArgv?: any[]

    /**
     * Delay in milliseconds before spawning next cluster. Defaults to 10s.
     */
    spawnDelay?: number

    /**
     * Spawn timeout for clusters in milliseconds. Defaults to 60s.
     */
    spawnTimeout?: number

    healthcheckInterval?: number
}

export interface ClusterManagerOptionsClusterCountCalc {
    strategy?: ClusterManagerOptionsClusterCountCalcStrategy
    memoryPerClusterMB?: number
    maxShardsPerCluster?: number
}

export enum ClusterManagerOptionsClusterCountCalcStrategy {
    Auto = 1,
    CPUCores,
    Memory
}

/**
 * Options for respawning clusters.
 */
export interface RespawnClustersOptions {
    /**
     * Delay between cluster spawns in milliseconds.
     */
    spawnDelay?: number

    /**
     * Timeout for shard spawns in milliseconds.
     */
    spawnTimeout?: number

    clusterIds?: number[]
}

/**
 * Options for evaluating scripts on clusters.
 */
export interface EvalOptions<T extends object = object> {
    /**
     * Specific cluster IDs to evaluate on.
     */
    clusterList?: number[]

    /**
     * Specific shard IDs to evaluate on.
     */
    shardList?: number[]

    /**
     * Context to pass to the evaluated script.
     */
    context?: T

    /**
     * Timeout for script evaluation in milliseconds.
     */
    timeout?: number
}

export interface SystemResources {
    cpuCores: number
    cpuUsage: number

    /**
     * In MB
     */
    memoryTotal: number
    memoryUsage: number
    uptime: number
}
