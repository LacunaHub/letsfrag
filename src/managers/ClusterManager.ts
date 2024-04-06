import { ChildProcess, ForkOptions } from 'child_process'
import EventEmitter from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WorkerOptions, Worker as WorkerThread } from 'worker_threads'
import { IPCMessage, IPCRawMessage } from '../ipc/IPCMessage'
import { Cluster } from '../structures/Cluster'
import { ServerClient, ServerClientOptions } from '../structures/ServerClient'
import { SpawnQueue } from '../structures/SpawnQueue'
import { chunkArray, sleep } from '../utils/Utils'
import { PromiseManager } from './PromiseManager'

export class ClusterManager extends EventEmitter {
    /**
     * Time the manager was ready.
     */
    public readyAt: number = -1

    /**
     * Server client.
     */
    public server: ServerClient

    /**
     * Map of cluster instances.
     */
    public cache = new Map<number, Cluster>()

    /**
     * Promise manager.
     */
    public promises = new PromiseManager(this)

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

    constructor(public file: string, public options: ClusterManagerOptions<ClusterManagerMode>) {
        super()

        if (!file) throw new TypeError('[ClusterManager] "file" is required.')
        this.file = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file)

        if (!fs.statSync(this.file).isFile()) throw new TypeError(`[ClusterManager] "${this.file}" is not a file.`)
        if (!options.server?.host) throw new TypeError('[ClusterManager] "server.host" is required.')
        if (typeof options.server?.port !== 'number')
            throw new TypeError('[ClusterManager] "server.port" must be a number.')
        if (!options.server.authorization) throw new TypeError('[ClusterManager] "server.authorization" is required.')
        if (!['fork', 'thread'].includes(options.mode))
            throw new TypeError('[ClusterManager] "mode" must be "fork" or "thread".')

        this.server = new ServerClient(this, options.server)

        this.options.clusterCount = +options.clusterCount || -1
        this.options.shardsPerCluster = +options.shardsPerCluster || -1
        this.options.autoRespawn = !!options.autoRespawn
        this.options.spawnDelay = +options.spawnDelay || 10_000
        this.options.spawnTimeout = +options.spawnTimeout || -1
        this.spawnQueue = new SpawnQueue({ auto: !!this.options.queueAutoSpawn, timeout: this.options.queueTimeout })
    }

    /**
     * Initializes the manager and spawns clusters.
     */
    public async spawn(): Promise<SpawnQueue> {
        if (this.options.spawnDelay < 8000)
            process.emitWarning(
                '[ClusterManager#spawn] Spawn delay is smaller than 8s, this can cause global rate limits on /gateway/bot',
                {
                    code: 'SHARDS_SPAWN_DELAY'
                }
            )

        await this.server.connect()

        const shardingData = await this.server.getShardingData()

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

        const clusteringData = await this.server.getClusteringData(this.options.clusterCount)
        this.clusters = clusteringData.clusters

        if (this.shards.some(shard => shard < 0))
            throw new Error('[ClusterManager#spawn] Shard identifier cannot be less than 0.')
        if (this.clusters.some(cluster => cluster < 0))
            throw new Error('[ClusterManager#spawn] Cluster identifier cannot be less than 0.')

        for (const clusterId of this.clusters) {
            const i = this.clusters.indexOf(clusterId)
            const clusterShards = shards[i]

            if (!clusterShards) continue

            this.spawnQueue.add({
                timeout: this.options.spawnDelay * clusterShards.length,
                args: [
                    this.options.spawnTimeout !== -1
                        ? this.options.spawnTimeout + this.options.spawnDelay * clusterShards.length
                        : this.options.spawnTimeout
                ],
                run: (...timeout: number[]) => this.createCluster(clusterId, clusterShards).spawn(...timeout)
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
     * @param options Respawn options.
     */
    public async respawnAll(options?: RespawnOptions): Promise<Map<number, Cluster>> {
        const spawnDelay = options.spawnDelay ?? this.options.spawnDelay,
            shardSpawnDelay = options.shardSpawnDelay ?? this.options.spawnDelay,
            shardSpawnTimeout = options.shardSpawnTimeout ?? this.options.spawnTimeout

        this.promises.cache.clear()
        this.emit('debug', { from: 'ClusterManager#respawnAll', data: arguments })

        const promises: Promise<ChildProcess | WorkerThread | void>[] = [],
            shards = chunkArray(this.shards || [], this.options.shardsPerCluster || this.shardCount)

        const clusters = [...this.cache.values()]

        for (const cluster of clusters) {
            const i = clusters.indexOf(cluster),
                length = shards[i]?.length || this.shardCount / this.options.clusterCount

            promises.push(cluster.respawn(shardSpawnDelay, shardSpawnTimeout))
            if (i < this.cache.size && spawnDelay > 0) promises.push(sleep(length * spawnDelay))
        }

        await Promise.allSettled(promises)

        return this.cache
    }

    /**
     * Broadcasts a message to all clusters.
     * @param message Message to broadcast.
     */
    public broadcast(message: IPCRawMessage): Promise<void[]> {
        return Promise.all([...this.cache.values()].map(cluster => cluster.send(message)))
    }

    /**
     * Broadcasts a script to all clusters.
     * @param script Script to broadcast.
     * @param options Options for the script.
     */
    public async broadcastEval<T = any>(
        script: string | ((manager: ClusterManager) => T),
        options: EvalOptions = {}
    ): Promise<T> {
        if (!this.cache.size) throw new Error('[ClusterManager#broadcastEval] No clusters found.')
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterManager#broadcastEval] Script must be a function.')

        script = typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script

        if (Array.isArray(options.clusters)) {
            const clusters = options.clusters

            if (clusters.some(v => v < 0) || !clusters.every(v => this.cache.has(v)))
                throw new Error('[ClusterManager#broadcastEval] Invalid cluster ID(s).')
        }

        if (Array.isArray(options.shards)) {
            const shards = options.shards

            if (shards.some(v => v < 0) || !shards.every(v => this.shards.includes(v)))
                throw new Error('[ClusterManager#broadcastEval] Invalid shard ID(s).')

            const clusterIds = new Set<number>()

            for (const cluster of this.cache.values()) {
                if (cluster.shards.some(shard => shards.includes(shard))) clusterIds.add(cluster.id)
            }

            if (!clusterIds.size) throw new Error('[ClusterManager#broadcastEval] No clusters found for shard ID(s).')

            options.clusters = Array.from(clusterIds)
        }

        const promises: Promise<any>[] = []

        if (Array.isArray(options.clusters)) {
            const clusters = [...this.cache.values()].filter(v => (options.clusters as number[]).includes(v.id))

            if (!clusters.length) throw new Error('[ClusterManager#broadcastEval] No clusters found for cluster ID(s).')

            for (const cluster of clusters) {
                promises.push(cluster.evalOnShard(script, options))
            }
        } else {
            for (const cluster of this.cache.values()) {
                promises.push(cluster.evalOnShard(script, options))
            }
        }

        const results = (await Promise.allSettled(promises)) as PromiseFulfilledResult<any>[]
        return results.filter(v => v.status === 'fulfilled').map(v => v.value) as T
    }

    /**
     * Evaluates a script on all manager.
     * @param script Script to evaluate.
     * @param options Options for the script.
     */
    public async eval<T = any>(
        script: string | ((manager: ClusterManager) => T),
        options: { context?: any; timeout?: number } = {}
    ): Promise<{
        result: any
        error: Error
    }> {
        let result: any
        let error: Error

        try {
            result = await eval(
                typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script
            )
        } catch (err) {
            error = err as Error
        }

        return { result: result, error: error }
    }
}

export interface ClusterManager {
    on<Event extends keyof ClusterManagerEvents>(
        event: Event,
        listener: (...args: ClusterManagerEvents[Event]) => void
    ): this

    once<Event extends keyof ClusterManagerEvents>(
        event: Event,
        listener: (...args: ClusterManagerEvents[Event]) => void
    ): this

    emit<Event extends keyof ClusterManagerEvents>(event: Event, ...args: ClusterManagerEvents[Event]): boolean

    off<Event extends keyof ClusterManagerEvents>(
        event: Event,
        listener: (...args: ClusterManagerEvents[Event]) => void
    ): this

    removeAllListeners<Event extends keyof ClusterManagerEvents>(event?: Event): this
}

export interface ClusterManagerEvents {
    clientRequest: [message: IPCMessage]
    clusterCreate: [cluster: Cluster]
    clusterReady: [cluster: Cluster]
    message: [message: IPCMessage]
    debug: [message: DebugMessage]
    ready: [manager: ClusterManager]
    error: [error: Error]
}

export interface DebugMessage {
    from: string
    data: any
}

export interface ClusterManagerOptions<T extends ClusterManagerMode> {
    /**
     * Server options.
     */
    server: ServerClientOptions

    /**
     * Mode of the cluster manager.
     */
    mode?: T

    /**
     * Total number of clusters.
     */
    clusterCount?: number

    /**
     * Number of shards per cluster.
     */
    shardsPerCluster?: number

    /**
     * Shard args.
     */
    shardArgs?: any[]

    /**
     * Exec args.
     */
    execArgv?: any[]

    /**
     * Whether to automatically respawn dead clusters.
     */
    autoRespawn?: boolean

    /**
     * Time to wait before spawning a new cluster.
     */
    spawnDelay?: number

    /**
     * Spawn timeout of clusters.
     */
    spawnTimeout?: number

    /**
     * Whether to automatically spawn clusters in the queue.
     */
    queueAutoSpawn?: boolean

    /**
     * Queue spawn timeout.
     */
    queueTimeout?: number

    cluster?: T extends 'fork' ? ForkOptions : WorkerOptions
}

export type ClusterManagerMode = 'fork' | 'thread'

export interface RespawnOptions {
    spawnDelay?: number
    shardSpawnDelay?: number
    shardSpawnTimeout?: number
}

export interface EvalOptions<T extends object = object> {
    /**
     * Cluster IDs to evaluate.
     */
    clusters?: number[]

    /**
     * Shard IDs to evaluate.
     */
    shards?: number[]

    context?: T

    /**
     * Timeout of script evaluation.
     */
    timeout?: number
}
