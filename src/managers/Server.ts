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
        if (typeof options.totalHosts !== 'number' || options.totalHosts < 1)
            throw new TypeError('[Server] "totalHosts" must be a number and greater than 0.')

        super(options)

        this.options.totalShards = +options.totalShards || -1
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
        if (this.options.totalShards === -1) {
            if (!this.options.botToken) throw new Error('[Server] "botToken" is required when "totalShards" is -1.')

            try {
                this.options.totalShards = await fetchRecommendedShardCount(this.options.botToken)
            } catch (err) {
                throw new Error('[Server] Failed to fetch recommended shard count.')
            }
        }

        if (this.options.totalHosts > this.options.totalShards)
            throw new Error('[Server] "totalHosts" cannot be more than "totalShards".')

        if (this.options.shardsPerHost === -1) {
            this.options.shardsPerHost = Math.floor(this.options.totalShards / this.options.totalHosts)
        }

        if (this.options.shardsPerHost > this.options.totalShards)
            throw new Error('[Server] "shardsPerHost" must be less than "totalShards".')

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
            shardList: []
        })

        this.clients.set(connection.id, clientConnection)

        return !!this.clients.set(connection.id, clientConnection)
    }

    private async onDisconnect(connection: Connection, reason?: any): Promise<boolean> {
        this.emit('debug', { from: 'Server#onDisconnect', data: arguments })

        const clientConnection = this.clients.get(connection.id)

        if (!clientConnection) return false
        if (clientConnection.type !== 'bot' || !clientConnection.shardList) return this.clients.delete(connection.id)

        this.clients.delete(connection.id)

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
            response.data.error = 'Unknown connection'
            await respond(response)

            return false
        }

        if (message.type === IPCMessageType.ServerClientShardList) {
            const botClients = [...this.clients.values()].filter(v => v.type === 'bot'),
                startedBotCount = botClients.filter(v => v.shardList.length).length,
                startedShardCount = startedBotCount * this.options.shardsPerHost
            const totalShardList = [...Array(this.options.totalShards).keys()],
                shardList = totalShardList.slice(startedShardCount, startedShardCount + this.options.shardsPerHost)

            if (!shardList.length) {
                response.data.error = 'All shards are already started'
                await respond(response)

                return false
            }

            clientConnection.shardList = shardList

            response.type = IPCMessageType.ServerClientShardListResponse
            response.data.shardList = shardList
            response.data.totalShards = shardList.length
        } else if (message.type === IPCMessageType.ServerClientBroadcast) {
            const promises = []
            const request = new IPCBaseMessage({ ...message, type: IPCMessageType.ServerBroadcast })

            for (const client of this.clients.values()) {
                if (client.type !== 'bot') continue

                promises.push(client.request(request.toJSON(), message.data.timeout))
            }

            try {
                const results = await Promise.all(promises)
                response.type = IPCMessageType.ServerBroadcastResponse
                response.data = results.map(v => v.data)
            } catch (err) {
                response.type = IPCMessageType.ServerBroadcastResponse
                response.error = makePlainError(err)
            }
        } else if (message.type === IPCMessageType.ServerClientHosts) {
            const promises = []
            const request = new IPCBaseMessage({ ...message, type: IPCMessageType.ServerHostData })

            for (const client of this.clients.values()) {
                if (client.type === 'bot') continue

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
    totalHosts: number

    /**
     * Total number of shards on all hosts.
     */
    totalShards?: number

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
    shardList: number[]
}
