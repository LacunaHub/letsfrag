import { fetchRecommendedShardCount, makePlainError } from 'discord.js'
import { EventEmitter } from 'events'
import { RedisOptions } from 'ioredis'
import { IPCBaseMessage, IPCMessageType, IPCRawMessage } from '../ipc/IPCMessage'
import { PromiseManager } from '../managers/PromiseManager'
import { BrokerChannels, getClusterManagerChannel, RedisBroker } from './RedisBroker'

const DEFAULT_CLIENT_TIMEOUT = 45_000 // 45 seconds (3x heartbeat interval)
const DEFAULT_CLEANUP_INTERVAL = 15_000 // 15 seconds

export class ClusterBroker extends EventEmitter<ClusterBrokerEvents> {
    public readonly broker: RedisBroker
    public readonly promises = new PromiseManager()

    public readonly clients = new Map<string, BrokerClientConnection>()

    public shardsPerHost: number

    private cleanupInterval: NodeJS.Timeout | null = null

    constructor(public options: ClusterBrokerOptions) {
        super()

        if (typeof options.hostCount !== 'number' || options.hostCount < 1)
            throw new TypeError('[ClusterBroker] "hostCount" must be a number and greater than 0.')

        this.options.shardCount = +options.shardCount || -1
        this.options.botToken = options.botToken || null
        this.options.clientTimeout = options.clientTimeout ?? DEFAULT_CLIENT_TIMEOUT

        this.broker = new RedisBroker(options.redis)
        this.broker.on('message', this.onMessage.bind(this))
        this.broker.on('error', error => this.emit('error', error))
    }

    public async initialize(): Promise<this> {
        if (this.options.shardCount === -1) {
            if (!this.options.botToken)
                throw new Error('[ClusterBroker] "botToken" is required when "shardCount" is -1.')

            try {
                this.options.shardCount = await fetchRecommendedShardCount(this.options.botToken)
            } catch {
                throw new Error('[ClusterBroker] Failed to fetch recommended shard count.')
            }
        }

        if (this.options.hostCount > this.options.shardCount)
            throw new Error('[ClusterBroker] "hostCount" cannot be more than "shardCount".')

        this.shardsPerHost = Math.ceil(this.options.shardCount / this.options.hostCount)
        if (this.shardsPerHost > this.options.shardCount)
            throw new Error('[ClusterBroker] "shardsPerHost" must be less than "shardCount".')

        await this.broker.connect()
        await this.broker.subscribe(BrokerChannels.ClusterBroker)

        // Start cleanup interval to remove dead clients
        this.startCleanupInterval()
        this.emit('ready')

        return this
    }

    public async close(): Promise<void> {
        this.stopCleanupInterval()
        this.broker.disconnect()
        this.emit('close')
    }

    public async send(clientId: string, message: IPCBaseMessage): Promise<void> {
        const client = this.clients.get(clientId)
        if (!client) throw new Error(`Client ${clientId} not found`)

        await this.broker.publish(getClusterManagerChannel(clientId), message)
    }

    public async request(clientId: string, message: IPCBaseMessage, timeout?: number): Promise<IPCBaseMessage> {
        const client = this.clients.get(clientId)
        if (!client) throw new Error(`Client ${clientId} not found`)

        const promise = this.promises.create<IPCBaseMessage>(message.nonce, { timeout })
        await this.broker.publish(getClusterManagerChannel(clientId), message)

        return promise
    }

    public async broadcast(message: IPCBaseMessage): Promise<void> {
        await this.broker.publish(BrokerChannels.Broadcast, message)
    }

    private startCleanupInterval(): void {
        if (this.cleanupInterval) return

        this.cleanupInterval = setInterval(() => {
            const now = Date.now()
            const timeout = this.options.clientTimeout

            for (const [clientId, client] of this.clients) {
                if (now - client.lastHeartbeat > timeout) {
                    this.clients.delete(clientId)
                    this.emit('disconnect', client, 'Heartbeat timeout')
                }
            }
        }, DEFAULT_CLEANUP_INTERVAL)
    }

    private stopCleanupInterval(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
            this.cleanupInterval = null
        }
    }

    private async onMessage(channel: string, message: IPCBaseMessage): Promise<void> {
        if (typeof message.type === 'undefined') return

        // Handle responses to pending requests
        if (this.promises.has(message.nonce)) {
            if (message.error) {
                this.promises.reject(message.nonce, message.error)
            } else {
                this.promises.resolve(message.nonce, message)
            }
            return
        }

        const rawMessage = message as IPCRawMessage

        if (rawMessage.type === IPCMessageType.BrokerClientReady) {
            const { clientId, shards, clusters, type } = rawMessage.data

            const clientConnection: BrokerClientConnection = {
                id: clientId,
                type: type || 'bot',
                shards: shards ?? [],
                clusters: clusters ?? [],
                lastHeartbeat: Date.now()
            }

            this.clients.set(clientId, clientConnection)
            this.emit('connect', clientConnection)

            return
        }

        if (rawMessage.type === IPCMessageType.BrokerClientHeartbeat) {
            const { clientId, shards, clusters } = rawMessage.data
            const clientConnection = this.clients.get(clientId)

            if (clientConnection) {
                clientConnection.lastHeartbeat = Date.now()
                clientConnection.shards = shards ?? clientConnection.shards
                clientConnection.clusters = clusters ?? clientConnection.clusters
            }

            return
        }

        if (rawMessage.type === IPCMessageType.BrokerClientDisconnect) {
            const { clientId } = rawMessage.data
            const clientConnection = this.clients.get(clientId)

            if (clientConnection) {
                this.clients.delete(clientId)
                this.emit('disconnect', clientConnection, 'Client disconnected')
            }
            return
        }

        const clientId = rawMessage.data?.clientId
        const clientConnection = this.clients.get(clientId)
        if (!clientConnection) return

        // Update heartbeat on any message from client
        clientConnection.lastHeartbeat = Date.now()

        if (rawMessage.type === IPCMessageType.BrokerClientShardList) {
            const botClients = [...this.clients.values()].filter(v => v.type === 'bot')
            const occupiedShards = botClients.filter(v => v.shards.length).flatMap(v => v.shards)
            let shards: number[] = []

            for (let shardId of [...Array(this.shardsPerHost).keys()]) {
                while (occupiedShards.includes(shardId) || shards.includes(shardId)) {
                    shardId++
                }
                shards.push(shardId)
            }

            if (shards.some(v => v + 1 > this.options.shardCount)) {
                shards = shards.filter(v => v + 1 <= this.options.shardCount)
            }

            clientConnection.shards = shards

            const response = new IPCBaseMessage({
                nonce: message.nonce,
                type: IPCMessageType.BrokerClientShardListResponse,
                data: { shards, shardCount: this.options.shardCount }
            })

            await this.send(clientId, response)
            return
        } else if (rawMessage.type === IPCMessageType.BrokerClientClusterList) {
            const botClients = [...this.clients.values()].filter(v => v.type === 'bot')
            const occupiedClusters = botClients.filter(v => v.clusters.length).flatMap(v => v.clusters)
            const clusters: number[] = []

            for (let clusterId of [...Array(rawMessage.data.clusterCount).keys()]) {
                while (occupiedClusters.includes(clusterId) || clusters.includes(clusterId)) {
                    clusterId++
                }
                clusters.push(clusterId)
            }

            clientConnection.clusters = clusters

            const response = new IPCBaseMessage({
                nonce: message.nonce,
                type: IPCMessageType.BrokerClientClusterListResponse,
                data: { clusters }
            })
            await this.send(clientId, response)
            return
        } else if (rawMessage.type === IPCMessageType.BrokerClientBroadcast) {
            const promises: Promise<IPCBaseMessage>[] = []
            const request = new IPCBaseMessage({ ...rawMessage, type: IPCMessageType.ClusterBrokerBroadcast })

            for (const client of this.clients.values()) {
                if (client.type !== 'bot') continue
                promises.push(this.request(client.id, request, rawMessage.data.timeout))
            }

            let response: IPCBaseMessage
            try {
                const results = await Promise.all(promises)
                response = new IPCBaseMessage({
                    nonce: message.nonce,
                    type: IPCMessageType.BrokerClientBroadcastResponse,
                    data: results.map(v => v.data)
                })
            } catch (err) {
                response = new IPCBaseMessage({
                    nonce: message.nonce,
                    type: IPCMessageType.BrokerClientBroadcastResponse,
                    error: makePlainError(err)
                })
            }
            await this.send(clientId, response)
            return
        } else if (rawMessage.type === IPCMessageType.BrokerClientHosts) {
            const promises: Promise<IPCBaseMessage>[] = []
            const request = new IPCBaseMessage({ ...rawMessage, type: IPCMessageType.ClusterBrokerHostData })

            for (const client of this.clients.values()) {
                if (client.type !== 'bot') continue
                promises.push(this.request(client.id, request, rawMessage.data.timeout))
            }

            let response: IPCBaseMessage
            try {
                const results = await Promise.all(promises)
                response = new IPCBaseMessage({
                    nonce: message.nonce,
                    type: IPCMessageType.BrokerClientHostsResponse,
                    data: results.map(v => v.data)
                })
            } catch (err) {
                response = new IPCBaseMessage({
                    nonce: message.nonce,
                    type: IPCMessageType.BrokerClientHostsResponse,
                    error: makePlainError(err)
                })
            }
            await this.send(clientId, response)
            return
        } else if (rawMessage.type === IPCMessageType.CustomRequest) {
            this.emit('clientRequest', clientConnection, rawMessage, async data => {
                const reply = new IPCBaseMessage({ nonce: message.nonce, type: IPCMessageType.CustomReply, data })
                await this.send(clientId, reply)
            })
            return
        } else if (rawMessage.type === IPCMessageType.CustomMessage) {
            this.emit('clientMessage', clientConnection, rawMessage)
            return
        }
    }
}

export interface ClusterBrokerEvents {
    ready: []
    error: [error: Error]
    connect: [connection: BrokerClientConnection]
    disconnect: [connection: BrokerClientConnection, reason?: string]
    close: []
    clientRequest: [connection: BrokerClientConnection, message: IPCRawMessage, respond: (data: any) => Promise<void>]
    clientMessage: [connection: BrokerClientConnection, message: IPCRawMessage]
}

export interface ClusterBrokerOptions {
    redis: RedisOptions | string
    botToken: string
    hostCount: number
    shardCount?: number
    clientTimeout?: number
}

export interface BrokerClientConnection {
    id: string
    type: 'bot' | 'custom'
    shards: number[]
    clusters: number[]
    lastHeartbeat: number
}
