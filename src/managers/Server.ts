import { fetchRecommendedShardCount, makePlainError } from 'discord.js'
import { Connection, Server as NetIPCServer, ServerOptions as NetIPCServerOptions } from 'net-ipc'
import { IPCBaseMessage, IPCMessageType, IPCRawMessage, NetIPCMessage, NetIPCMessageRespond } from '../ipc/IPCMessage'
import { ServerClientConnectPayload, ServerClientType } from '../structures/ServerClient'
import { DebugMessage } from './ClusterManager'

export class Server extends NetIPCServer {
    /**
     * Clients connected to this server.
     */
    public clients = new Map<string, ServerClientConnection>()

    constructor(public options: ServerOptions) {
        if (!options.authorization) throw new TypeError('[Server] "authorization" is required.')
        if (typeof options.hostCount !== 'number' || options.hostCount < 1)
            throw new TypeError('[Server] "hostCount" must be a number and greater than 0.')

        super(options)

        this.options.shardCount = +options.shardCount || -1
        this.options.shardsPerHost = +options.shardsPerHost || -1
        this.options.botToken = options.botToken || null

        this.on('close', this.onClose.bind(this))
        this.on('connect', this.onConnect.bind(this))
        this.on('disconnect', this.onDisconnect.bind(this))
        this.on('error', this.onError.bind(this))
        this.on('message', this.onMessage.bind(this))
        this.on('ready', this.onReady.bind(this))
        this.on('request', this.onRequest.bind(this))
    }

    /**
     * Initializes and starts the server.
     * @returns
     */
    public async initialize(): Promise<this> {
        if (this.options.shardCount === -1) {
            if (!this.options.botToken) throw new Error('[Server] "botToken" is required when "shardCount" is -1.')

            try {
                this.options.shardCount = await fetchRecommendedShardCount(this.options.botToken)
            } catch (err) {
                throw new Error('[Server] Failed to fetch recommended shard count.')
            }
        }

        if (this.options.hostCount > this.options.shardCount)
            throw new Error('[Server] "hostCount" cannot be more than "shardCount".')

        if (this.options.shardsPerHost === -1) {
            this.options.shardsPerHost = Math.ceil(this.options.shardCount / this.options.hostCount)
        }

        if (this.options.shardsPerHost > this.options.shardCount)
            throw new Error('[Server] "shardsPerHost" must be less than "shardCount".')

        return await this.start()
    }

    private async onClose(): Promise<boolean> {
        return this.emit('debug', { from: 'Server#onClose', data: arguments })
    }

    private async onConnect(connection: Connection, payload: ServerClientConnectPayload): Promise<boolean> {
        this.emit('debug', { from: 'Server#onConnect', data: arguments })

        if (typeof payload !== 'object' && payload !== null) return await connection.close('Invalid')
        if (payload.authorization !== this.options.authorization) return await connection.close('Forbidden')

        const clientConnection: ServerClientConnection = Object.assign(connection, {
            authorization: payload.authorization,
            type: payload.type,
            shards: payload.shards ?? [],
            clusters: payload.clusters ?? []
        })

        return !!this.clients.set(connection.id, clientConnection)
    }

    private async onDisconnect(connection: Connection, reason?: any): Promise<boolean> {
        this.emit('debug', { from: 'Server#onDisconnect', data: arguments })

        const clientConnection = this.clients.get(connection.id)

        if (!clientConnection) return false
        if (clientConnection.type !== 'bot' || !clientConnection.shards) return this.clients.delete(connection.id)

        return this.clients.delete(connection.id)
    }

    private async onError(error: Error): Promise<boolean> {
        return this.emit('debug', { from: 'Server#onError', data: arguments })
    }

    private async onMessage(message: IPCRawMessage, connection: Connection): Promise<boolean> {
        this.emit('debug', { from: 'Server#onMessage', data: arguments })

        if (typeof message.type === 'undefined') return false

        const clientConnection = this.clients.get(connection.id)

        if (!clientConnection) return false

        if (message.type === IPCMessageType.ServerClientReady) {
            const { shards, clusters } = message.data

            if (Array.isArray(shards) && shards.every(v => typeof v === 'number')) clientConnection.shards = shards
            if (Array.isArray(clusters) && clusters.every(v => typeof v === 'number'))
                clientConnection.clusters = clusters
        }

        const ipcMessage = new NetIPCMessage(clientConnection, message)
        return this.emit('clientMessage', clientConnection, ipcMessage)
    }

    private async onReady(address: string): Promise<boolean> {
        return this.emit('debug', { from: 'Server#onReady', data: arguments })
    }

    private async onRequest(
        message: IPCRawMessage,
        respond: NetIPCMessageRespond,
        connection: Connection
    ): Promise<boolean> {
        this.emit('debug', { from: 'Server#onRequest', data: arguments })

        if (typeof message.type === 'undefined') return false

        const clientConnection = this.clients.get(connection.id)
        const response = new IPCBaseMessage()

        if (!clientConnection) {
            response.error = makePlainError(new Error('Unknown connection'))
            await respond(response.toJSON())

            return false
        }

        if (message.type === IPCMessageType.ServerClientShardList) {
            const botClients = [...this.clients.values()].filter(v => v.type === 'bot'),
                occupiedShardCount = botClients.filter(v => v.shards.length).length * this.options.shardsPerHost
            const shards = [...Array(this.options.shardCount).keys()].slice(
                occupiedShardCount,
                occupiedShardCount + this.options.shardsPerHost
            )

            if (!shards.length) {
                response.error = makePlainError(new Error('All shards are already started'))
                await respond(response.toJSON())

                return false
            }

            clientConnection.shards = shards

            response.type = IPCMessageType.ServerClientShardListResponse
            response.data.shards = shards
            response.data.shardCount = this.options.shardCount
        } else if (message.type === IPCMessageType.ServerClientClusterList) {
            const botClients = [...this.clients.values()].filter(v => v.type === 'bot'),
                occupiedClusters = botClients.filter(v => v.clusters.length).flatMap(v => v.clusters)
            const clusters = []

            for (let clusterId of [...Array(message.data.clusterCount).keys()]) {
                while (occupiedClusters.includes(clusterId) || clusters.includes(clusterId)) {
                    clusterId++
                }

                clusters.push(clusterId)
            }

            clientConnection.clusters = clusters

            response.type = IPCMessageType.ServerClientClusterListResponse
            response.data.clusters = clusters
        } else if (message.type === IPCMessageType.ServerClientBroadcast) {
            const promises = []
            const request = new IPCBaseMessage({ ...message, type: IPCMessageType.ServerBroadcast })

            for (const client of this.clients.values()) {
                if (client.type !== 'bot') continue

                promises.push(client.request(request.toJSON(), message.data.timeout))
            }

            try {
                const results = await Promise.all(promises)
                response.type = IPCMessageType.ServerClientBroadcastResponse
                response.data = results.map(v => v.data)
            } catch (err) {
                response.type = IPCMessageType.ServerClientBroadcastResponse
                response.error = makePlainError(err)
            }
        } else if (message.type === IPCMessageType.ServerClientHosts) {
            const promises = []
            const request = new IPCBaseMessage({ ...message, type: IPCMessageType.ServerHostData })

            for (const client of this.clients.values()) {
                if (client.type !== 'bot') continue

                promises.push(client.request(request.toJSON(), message.data.timeout))
            }

            try {
                const results = await Promise.all(promises)
                response.type = IPCMessageType.ServerClientHostsResponse
                response.data = results.map(v => v.data)
            } catch (err) {
                response.type = IPCMessageType.ServerClientHostsResponse
                response.error = makePlainError(err)
            }
        }

        await respond(response.toJSON())

        const ipcMessage = new NetIPCMessage(clientConnection, message, respond)
        return this.emit('clientRequest', clientConnection, ipcMessage)
    }
}

export interface Server extends NetIPCServer {
    on<Event extends keyof ServerEvents>(event: Event, listener: (...args: ServerEvents[Event]) => void): this

    once<Event extends keyof ServerEvents>(event: Event, listener: (...args: ServerEvents[Event]) => void): this

    emit<Event extends keyof ServerEvents>(event: Event, ...args: ServerEvents[Event]): boolean

    off<Event extends keyof ServerEvents>(event: Event, listener: (...args: ServerEvents[Event]) => void): this

    removeAllListeners<Event extends keyof ServerEvents>(event?: Event): this
}

export interface ServerEvents {
    ready: [address: string]
    error: [error: ErrorEvent, connection: Connection]
    connect: [connection: Connection, payload?: any]
    disconnect: [connection: Connection, reason?: any]
    close: []
    message: [message: any, connection: Connection]
    request: [request: any, respond: NetIPCMessageRespond, connection: Connection]
    clientRequest: [connection: ServerClientConnection, message: NetIPCMessage]
    clientMessage: [connection: ServerClientConnection, message: NetIPCMessage]
    debug: [message: DebugMessage]
}

export interface ServerOptions extends NetIPCServerOptions {
    /**
     * Authorization token.
     */
    authorization: string

    /**
     * Total number of hosts.
     */
    hostCount: number

    /**
     * Total number of shards on all hosts.
     */
    shardCount?: number

    /**
     * Number of shards per host.
     */
    shardsPerHost?: number

    /**
     * Bot token.
     */
    botToken?: string
}

export interface ServerClientConnection extends Connection {
    authorization: string
    type: ServerClientType
    shards: number[]
    clusters: number[]
}
