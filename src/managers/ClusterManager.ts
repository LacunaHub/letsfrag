import { ForkOptions } from 'child_process'
import EventEmitter from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { IPCMessage, IPCRawMessage } from '../ipc/IPCMessage'
import { BrokerClient, BrokerClientOptions } from '../structures/BrokerClient'
import { Cluster } from '../structures/Cluster'
import { Fork } from '../structures/Fork'
import { SpawnQueue } from '../structures/SpawnQueue'
import { chunkArray, serializeScript, sleep } from '../utils/Utils'
import { PromiseManager } from './PromiseManager'

/**
 * Manages multiple cluster instances.
 */
export class ClusterManager extends EventEmitter<ClusterManagerEvents> {
    /**
     * Map of cluster instances.
     */
    public readonly cache = new Map<number, Cluster>()

    /**
     * Promise manager.
     */
    public readonly promises = new PromiseManager()

    /**
     * Time the manager was ready.
     */
    public readyAt: number = -1

    /**
     * Broker client.
     */
    public brokerClient: BrokerClient

    /**
     * Total number of shards.
     */
    public shardCount: number

    /**
     * List of shards that this manager handles.
     */
    public shards: number[] = []

    /**
     * List of clusters that this manager handles.
     */
    public clusters: number[] = []

    /**
     * Spawn queue.
     */
    public spawnQueue: SpawnQueue

    /**
     * Whether the manager is ready.
     */
    public get ready(): boolean {
        return this.readyAt > -1
    }

    constructor(public file: string, public options: ClusterManagerOptions) {
        if (!file) throw new TypeError('[ClusterManager] "file" is required.')

        super()

        this.file = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file)
        if (!fs.statSync(this.file).isFile()) throw new TypeError(`[ClusterManager] "${file}" is not a file.`)

        this.brokerClient = new BrokerClient(this, options.brokerClient)

        this.options.clusterCount = +options.clusterCount || -1
        this.options.shardsPerCluster = +options.shardsPerCluster || -1
        this.options.spawnDelay = +options.spawnDelay || 10_000
        this.options.spawnTimeout = +options.spawnTimeout || -1

        this.spawnQueue = new SpawnQueue({ auto: !!this.options.queueAutoSpawn, timeout: this.options.queueTimeout })
    }

    /**
     * Initializes the manager and spawns clusters.
     */
    public async spawn(): Promise<SpawnQueue> {
        if (this.options.spawnDelay < 8000) {
            process.emitWarning(
                '[ClusterManager#spawn] Spawn delay is smaller than 8s, this can cause global rate limits on /gateway/bot'
            )
        }

        await this.brokerClient.connect()

        const shardingData = await this.brokerClient.getShardingData()
        this.shardCount = shardingData.shardCount
        this.shards = shardingData.shards
        const clusterShardCount = this.shards.length

        if (this.options.clusterCount === -1) {
            const cpuCores = os.cpus().length
            this.options.clusterCount = cpuCores > clusterShardCount ? clusterShardCount : cpuCores
        }

        if (this.options.shardsPerCluster === -1) {
            this.options.shardsPerCluster = Math.ceil(clusterShardCount / this.options.clusterCount)
        }

        if (clusterShardCount / this.options.shardsPerCluster !== this.options.clusterCount) {
            this.options.clusterCount = Math.ceil(clusterShardCount / this.options.shardsPerCluster)
        }

        if (this.options.clusterCount > clusterShardCount)
            throw new Error('[ClusterManager#spawn] "clusterCount" cannot be more than "shardCount".')
        if (this.options.shardsPerCluster > clusterShardCount)
            throw new Error('[ClusterManager#spawn] "shardsPerCluster" must be less than "shardCount".')
        if (this.options.shardsPerCluster < 1)
            throw new Error('[ClusterManager#spawn] "shardsPerCluster" must be at least 1.')

        const shards = chunkArray(this.shards, this.options.shardsPerCluster)

        if (shards.length !== this.options.clusterCount) {
            this.options.clusterCount = shards.length
        }

        const clusteringData = await this.brokerClient.getClusteringData(this.options.clusterCount)
        this.clusters = clusteringData.clusters

        if (this.shards.some(shard => shard < 0))
            throw new Error('[ClusterManager#spawn] Shard identifier cannot be less than 0.')
        if (this.clusters.some(cluster => cluster < 0))
            throw new Error('[ClusterManager#spawn] Cluster identifier cannot be less than 0.')

        for (const clusterId of this.clusters) {
            const index = this.clusters.indexOf(clusterId)
            const clusterShards = shards[index]

            if (!clusterShards) continue

            const timeout = this.options.spawnDelay * clusterShards.length
            const spawnTimeout =
                this.options.spawnTimeout !== -1
                    ? this.options.spawnTimeout + this.options.spawnDelay * clusterShards.length
                    : this.options.spawnTimeout

            this.spawnQueue.add({
                timeout,
                args: [spawnTimeout],
                run: (...timeoutArgs: number[]) => this.createCluster(clusterId, clusterShards).spawn(...timeoutArgs)
            })
        }

        return this.spawnQueue.start()
    }

    /**
     * Creates a new cluster.
     * @param id ID of the cluster.
     * @param shards Shard list of the cluster.
     */
    public createCluster(id: number, shards: number[]): Cluster {
        const cluster = new Cluster(this, id, shards)

        this.cache.set(id, cluster)
        this.emit('clusterCreate', cluster)

        return cluster
    }

    /**
     * Respawns all clusters.
     * @param options - Respawn options
     */
    public async respawnClusters(options: RespawnOptions = {}): Promise<Map<number, Cluster>> {
        const spawnDelay = options.spawnDelay ?? this.options.spawnDelay
        const shardSpawnDelay = options.shardSpawnDelay ?? this.options.spawnDelay
        const shardSpawnTimeout = options.shardSpawnTimeout ?? this.options.spawnTimeout

        this.promises.cache.clear()

        const shards = chunkArray(this.shards || [], this.options.shardsPerCluster || this.shardCount)
        const clusters = [...this.cache.values()]
        const promises: Promise<Fork | void>[] = []

        for (let i = 0; i < clusters.length; i++) {
            const cluster = clusters[i]
            const shardCount = shards[i]?.length || this.shardCount / this.options.clusterCount

            promises.push(cluster.respawn(shardSpawnDelay, shardSpawnTimeout))

            if (i < clusters.length - 1 && spawnDelay > 0) {
                promises.push(sleep(shardCount * spawnDelay))
            }
        }

        await Promise.allSettled(promises)
        return this.cache
    }

    /**
     * Broadcasts a message to all clusters.
     * @param message - Message to broadcast
     */
    public broadcast(message: IPCRawMessage): Promise<void[]> {
        const clusters = [...this.cache.values()]
        return Promise.all(clusters.map(cluster => cluster.send(message)))
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
        if (!this.cache.size) throw new Error('[ClusterManager#broadcastEval] No clusters found.')
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterManager#broadcastEval] "script" must be a function or a string.')

        const serializedScript = serializeScript(script, options.context)
        let targetClusters = [...this.cache.values()]

        if (Array.isArray(options.shards)) {
            if (options.shards.some(v => v < 0) || !options.shards.every(v => this.shards.includes(v)))
                throw new Error('[ClusterManager#broadcastEval] Invalid shards.')

            const clusterIds = new Set<number>()
            for (const cluster of this.cache.values()) {
                if (cluster.shards.some(v => options.shards.includes(v))) clusterIds.add(cluster.id)
            }

            if (!clusterIds.size) throw new Error('[ClusterManager#broadcastEval] No clusters found.')
            options.clusters = Array.from(clusterIds)
        }

        if (Array.isArray(options.clusters)) {
            if (options.clusters.some(v => v < 0) || !options.clusters.every(v => this.cache.has(v)))
                throw new Error('[ClusterManager#broadcastEval] Invalid clusters.')

            targetClusters = targetClusters.filter(v => options.clusters.includes(v.id))
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
     * Emitted when a message is received from a cluster.
     */
    message: [message: IPCMessage]

    /**
     * Emitted when an error occurs.
     */
    error: [error: Error]

    /**
     * Emitted when a client request is received.
     */
    clientRequest: [message: IPCMessage]

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
     * Total number of clusters. Defaults to CPU core count.
     */
    clusterCount?: number

    /**
     * Number of shards per cluster. Auto-calculated if not provided.
     */
    shardsPerCluster?: number

    /**
     * Arguments to pass to shards.
     */
    shardArgs?: any[]

    /**
     * Exec arguments for child processes.
     */
    execArgv?: any[]

    /**
     * Delay in milliseconds before spawning next cluster. Defaults to 10000ms.
     */
    spawnDelay?: number

    /**
     * Spawn timeout for clusters in milliseconds.
     */
    spawnTimeout?: number

    /**
     * Whether to automatically spawn clusters in the queue.
     */
    queueAutoSpawn?: boolean

    /**
     * Queue spawn timeout in milliseconds.
     */
    queueTimeout?: number

    /**
     * Node.js fork options for child processes.
     */
    childProcess?: ForkOptions
}

/**
 * Options for respawning clusters.
 */
export interface RespawnOptions {
    /**
     * Delay between cluster spawns in milliseconds.
     */
    spawnDelay?: number

    /**
     * Delay between shard spawns in milliseconds.
     */
    shardSpawnDelay?: number

    /**
     * Timeout for shard spawns in milliseconds.
     */
    shardSpawnTimeout?: number
}

/**
 * Options for evaluating scripts on clusters.
 */
export interface EvalOptions<T extends object = object> {
    /**
     * Specific cluster IDs to evaluate on.
     */
    clusters?: number[]

    /**
     * Specific shard IDs to evaluate on.
     */
    shards?: number[]

    /**
     * Context to pass to the evaluated script.
     */
    context?: T

    /**
     * Timeout for script evaluation in milliseconds.
     */
    timeout?: number
}
