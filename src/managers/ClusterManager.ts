import { ChildProcess, ForkOptions } from 'child_process'
import EventEmitter from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WorkerOptions, Worker as WorkerThread } from 'worker_threads'
import { IPCMessage, IPCRawMessage } from '../ipc/IPCMessage'
import { Cluster } from '../structures/Cluster'
import { ServerClient } from '../structures/ServerClient'
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
     * List of clusters that this manager handles.
     */
    public clusters = new Map<number, Cluster>()

    /**
     * Promise manager.
     */
    public promises = new PromiseManager(this)

    /**
     * Total number of shards.
     */
    public totalShards: number

    /**
     * List of shards that this manager handles.
     */
    public shardList: number[] = []

    /**
     * List of clusters that this manager handles.
     */
    public clusterList: number[] = []

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
        if (!options.serverHostname) throw new TypeError('[ClusterManager] "serverHostname" is required.')
        if (typeof options.serverPort !== 'number')
            throw new TypeError('[ClusterManager] "serverPort" must be a number.')
        if (!options.serverAuthorization) throw new TypeError('[ClusterManager] "serverAuthorization" is required.')
        if (!['fork', 'thread'].includes(options.mode))
            throw new TypeError('[ClusterManager] "mode" must be "fork" or "thread".')

        this.server = new ServerClient(this, {
            host: options.serverHostname,
            port: +options.serverPort,
            authorization: options.serverAuthorization,
            type: 'bot'
        })

        this.options.totalClusters = +options.totalClusters || -1
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

        this.totalShards = shardingData.totalShards
        this.shardList = shardingData.shardList

        if (this.options.totalClusters === -1) {
            const cpuCores = os.cpus().length

            this.options.totalClusters = cpuCores > this.totalShards ? this.totalShards : cpuCores
        }

        if (this.options.shardsPerCluster === -1) {
            this.options.shardsPerCluster = Math.round(this.totalShards / this.options.totalClusters)
        }

        if (this.options.totalClusters > this.totalShards)
            throw new Error('[ClusterManager#spawn] "totalClusters" cannot be more than "totalShards".')
        if (this.options.shardsPerCluster > this.totalShards)
            throw new Error('[ClusterManager#spawn] "shardsPerCluster" must be less than "totalShards".')
        if (this.options.shardsPerCluster < 1)
            throw new Error('[ClusterManager#spawn] "shardsPerCluster" must be at least 1.')

        if (this.clusterList.length !== this.options.totalClusters)
            this.clusterList = [...Array(this.options.totalClusters).keys()]

        if (this.shardList.some(shard => shard < 0))
            throw new Error('[ClusterManager#spawn] Shard identifier cannot be less than 0.')
        if (this.clusterList.some(cluster => cluster < 0))
            throw new Error('[ClusterManager#spawn] Cluster identifier cannot be less than 0.')

        const shardList = chunkArray(this.shardList, this.options.shardsPerCluster)

        for (let i = 0; i < this.options.totalClusters; i++) {
            if (shardList[i]) {
                this.spawnQueue.add({
                    timeout: this.options.spawnDelay * shardList[i]?.length,
                    args: [
                        this.options.spawnTimeout !== -1
                            ? this.options.spawnTimeout + this.options.spawnDelay * shardList[i]?.length
                            : this.options.spawnTimeout
                    ],
                    run: (...timeout: number[]) => this.createCluster(i, shardList[i]).spawn(...timeout)
                })
            }
        }

        return this.spawnQueue.start()
    }

    /**
     * Creates a new cluster.
     * @param id ID of the cluster.
     * @param shardList Shard list of the cluster.
     */
    public createCluster(id: number, shardList: number[]): Cluster {
        const cluster = new Cluster(this, id, shardList)

        this.clusters.set(id, cluster)
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
            shardList = chunkArray(this.shardList || [], this.options.shardsPerCluster || this.totalShards)

        const clusters = [...this.clusters.values()]

        for (const cluster of clusters) {
            const i = clusters.indexOf(cluster),
                length = shardList[i]?.length || this.totalShards / this.options.totalClusters

            promises.push(cluster.respawn(shardSpawnDelay, shardSpawnTimeout))
            if (i < this.clusters.size && spawnDelay > 0) promises.push(sleep(length * spawnDelay))
        }

        await Promise.allSettled(promises)

        return this.clusters
    }

    /**
     * Broadcasts a message to all clusters.
     * @param message Message to broadcast.
     */
    public broadcast(message: IPCRawMessage): Promise<void[]> {
        return Promise.all([...this.clusters.values()].map(cluster => cluster.send(message)))
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
        if (!this.clusters.size) throw new Error('[ClusterManager#broadcastEval] No clusters found.')
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterManager#broadcastEval] Script must be a function.')

        script = typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script

        if (Array.isArray(options.cluster)) {
            const clusterIds = options.cluster

            if (clusterIds.some(v => v < 0) || !clusterIds.every(v => this.clusters.has(v)))
                throw new Error('[ClusterManager#broadcastEval] Invalid cluster ID(s).')
        }

        if (Array.isArray(options.shard)) {
            const shardIds = options.shard

            if (shardIds.some(v => v < 0) || !shardIds.every(v => this.shardList.includes(v)))
                throw new Error('[ClusterManager#broadcastEval] Invalid shard ID(s).')

            const clusterIds = new Set<number>()

            for (const cluster of this.clusters.values()) {
                if (cluster.shardList.some(shard => shardIds.includes(shard))) clusterIds.add(cluster.id)
            }

            if (!clusterIds.size) throw new Error('[ClusterManager#broadcastEval] No clusters found for shard ID(s).')

            options.cluster = Array.from(clusterIds)
        }

        const promises: Promise<any>[] = []

        if (Array.isArray(options.cluster)) {
            const clusters = [...this.clusters.values()].filter(v => (options.cluster as number[]).includes(v.id))

            if (!clusters.length) throw new Error('[ClusterManager#broadcastEval] No clusters found for cluster ID(s).')

            for (const cluster of clusters) {
                promises.push(cluster.evalOnShard(script, options))
            }
        } else {
            for (const cluster of this.clusters.values()) {
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
     * Hostname of the server.
     */
    serverHostname: string

    /**
     * Port of the server.
     */
    serverPort: number

    /**
     * Authorization token of the server.
     */
    serverAuthorization: string

    /**
     * Mode of the cluster manager.
     */
    mode?: T

    /**
     * Total number of clusters.
     */
    totalClusters?: number

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

    clusterOptions?: T extends 'fork' ? ForkOptions : WorkerOptions
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
    cluster?: number[]

    /**
     * Shard IDs to evaluate.
     */
    shard?: number[]

    context?: T

    /**
     * Timeout of script evaluation.
     */
    timeout?: number
}
