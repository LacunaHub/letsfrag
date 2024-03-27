import { makeError, makePlainError } from 'discord.js'
import { ClientReadyEvent, Client as NetIPCClient, ClientOptions as NetIPCClientOptions } from 'net-ipc'
import { MemUsedInfo, cpu, mem, os } from 'node-os-utils'
import { IPCBaseMessage, IPCMessageType, IPCRawMessage, NetIPCMessage, NetIPCMessageRespond } from '../ipc/IPCMessage'
import { ClusterManager, DebugMessage, EvalOptions } from '../managers/ClusterManager'

export class ServerClient extends NetIPCClient {
    constructor(public readonly manager: ClusterManager | null, public options: ServerClientOptions) {
        if (!options.authorization) throw new TypeError('[ServerClient] "authorization" is required.')

        super(options)

        this.options.type = options.type || 'unknown'

        this.on('close', this.onClose.bind(this))
        this.on('error', this.onError.bind(this))
        this.on('message', this.onMessage.bind(this))
        this.on('ready', this.onReady.bind(this))
        this.on('request', this.onRequest.bind(this))
        this.on('status', this.onStatus.bind(this))
    }

    /**
     * Connects to the server.
     * @param payload Connection payload.
     */
    public override connect(payload: ServerClientConnectPayload = {}): Promise<this> {
        return super.connect({
            authorization: this.options.authorization,
            type: this.options.type,
            ...payload
        })
    }

    /**
     * Gets the sharding data.
     * @param timeout Timeout of request in milliseconds.
     */
    public async getShardingData(timeout: number = 30_000): Promise<ShardingData> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.ServerClientShardList
        })

        const response: IPCRawMessage = await this.request(message.toJSON(), timeout)

        if (response.error) throw makeError(response.error)

        return response.data as ShardingData
    }

    public async getClusteringData(clusterCount: number, timeout: number = 30_000): Promise<ClusteringData> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.ServerClientClusterList,
            data: {
                clusterCount
            }
        })

        const response: IPCRawMessage = await this.request(message.toJSON(), timeout)

        if (response.error) throw makeError(response.error)

        return response.data as ClusteringData
    }

    /**
     * Gets the hosts data.
     * @param timeout Timeout of request in milliseconds.
     */
    public async getHostsData(timeout: number = 30_000): Promise<HostData[]> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.ServerClientHosts
        })

        const response: IPCRawMessage = await this.request(message.toJSON(), timeout)

        if (response.error) throw makeError(response.error)

        return (response.data as HostData[]).sort((a, b) => a.clusters[0] - b.clusters[0])
    }

    /**
     * Broadcasts a script to the server.
     * @param script Script to execute.
     * @param options Evaluation options.
     * @returns
     */
    public async broadcastEval<T = any>(
        script: string | ((client: any) => any),
        options: EvalOptions = {}
    ): Promise<T> {
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[ClusterManager#broadcastEval] "script" must be a function or a string.')

        script = typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script
        const message = new IPCBaseMessage({
            type: IPCMessageType.ServerClientBroadcast,
            data: { script, options }
        })

        const response: IPCRawMessage = await this.request(message.toJSON(), options.timeout)

        if (response.error) throw makeError(response.error)

        return response.data
    }

    private async onClose(reason: any): Promise<boolean> {
        return this.emit('debug', { from: 'ServerClient#onClose', data: arguments })
    }

    private async onError(error: Error): Promise<boolean> {
        return this.emit('debug', { from: 'ServerClient#onError', data: arguments })
    }

    private async onMessage(message: IPCRawMessage): Promise<boolean> {
        this.emit('debug', { from: 'ServerClient#onMessage', data: arguments })

        if (typeof message.type === 'undefined') return false

        const ipcMessage = new NetIPCMessage(this, message)
        return this.emit('serverMessage', ipcMessage)
    }

    private async onReady(data: ClientReadyEvent): Promise<void> {
        this.emit('debug', { from: 'ServerClient#onReady', data: arguments })

        const message = new IPCBaseMessage({
            type: IPCMessageType.ServerClientReady,
            data: {
                shards: this.manager?.shards ?? [],
                clusters: this.manager?.clusters ?? []
            }
        })

        return await this.send(message.toJSON())
    }

    private async onRequest(message: IPCRawMessage, respond: NetIPCMessageRespond): Promise<boolean> {
        this.emit('debug', { from: 'ServerClient#onRequest', data: arguments })

        if (typeof message.type === 'undefined') return false

        const response = new IPCBaseMessage()

        if (message.type === IPCMessageType.ServerBroadcast) {
            try {
                const { script, options } = message.data,
                    data = await this.manager.broadcastEval(script, options)

                response.type = IPCMessageType.ServerBroadcastResponse
                response.data = data
            } catch (err) {
                response.type = IPCMessageType.ServerBroadcastResponse
                response.error = makePlainError(err)
            }
        } else if (message.type === IPCMessageType.ServerHostData) {
            response.type = IPCMessageType.ServerHostDataResponse
            response.data = {
                hostname: os.hostname(),
                uptime: os.uptime(),
                cpuUsage: await cpu.usage(),
                memoryUsed: await mem.used(),
                shards: this.manager?.shards ?? [],
                clusters: this.manager?.clusters ?? []
            }
        }

        await respond(response.toJSON())

        const ipcMessage = new NetIPCMessage(this, message, respond)
        return this.emit('serverRequest', ipcMessage)
    }

    private async onStatus(status: number): Promise<boolean> {
        return this.emit('debug', { from: 'ServerClient#onStatus', data: arguments })
    }
}

export interface ServerClient extends NetIPCClient {
    on<Event extends keyof ServerClientEvents>(
        event: Event,
        listener: (...args: ServerClientEvents[Event]) => void
    ): this

    once<Event extends keyof ServerClientEvents>(
        event: Event,
        listener: (...args: ServerClientEvents[Event]) => void
    ): this

    emit<Event extends keyof ServerClientEvents>(event: Event, ...args: ServerClientEvents[Event]): boolean

    off<Event extends keyof ServerClientEvents>(
        event: Event,
        listener: (...args: ServerClientEvents[Event]) => void
    ): this

    removeAllListeners<Event extends keyof ServerClientEvents>(event?: Event): this
}

export interface ServerClientEvents {
    close: [reason: any]
    error: [error: ErrorEvent]
    message: [message: any]
    ready: [data: ClientReadyEvent]
    request: [request: any, respond: NetIPCMessageRespond]
    status: [status: number]
    serverMessage: [message: NetIPCMessage]
    serverRequest: [message: NetIPCMessage]
    debug: [message: DebugMessage]
}

export interface ServerClientOptions extends NetIPCClientOptions {
    /**
     * Client authorization token.
     */
    authorization: string

    /**
     * Client type.
     */
    type?: ServerClientType
}

export type ServerClientType = 'bot' | 'unknown' | string

export interface ServerClientConnectPayload {
    authorization?: string
    type?: ServerClientType
    shards?: number[]
    clusters?: number[]
}

export interface ShardingData {
    shards: number[]
    shardCount: number
}

export interface ClusteringData {
    clusters: number[]
}

export interface HostData {
    hostname: string
    uptime: number
    cpuUsage: number
    memoryUsed: MemUsedInfo
    shards: number[]
    clusters: number[]
}
