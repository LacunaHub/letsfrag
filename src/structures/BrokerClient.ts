import { randomUUID } from 'crypto'
import { makeError, makePlainError } from 'discord.js'
import { EventEmitter } from 'events'
import { RedisOptions } from 'ioredis'
import { cpu, mem, MemUsedInfo, os } from 'node-os-utils'
import { BrokerChannels, getClusterManagerChannel, RedisBroker } from '../brokers/RedisBroker'
import { IPCBaseMessage, IPCMessageType, IPCRawMessage } from '../ipc/IPCMessage'
import { ClusterManager, DebugMessage, EvalOptions } from '../managers/ClusterManager'
import { PromiseManager } from '../managers/PromiseManager'

const DEFAULT_HEARTBEAT_INTERVAL = 15_000 // 15 seconds

export class BrokerClient extends EventEmitter<BrokerClientEvents> {
    public readonly id: string
    public readonly broker: RedisBroker
    public readonly promises = new PromiseManager()

    private heartbeatInterval: NodeJS.Timeout | null = null

    constructor(public readonly manager: ClusterManager | null, public options: BrokerClientOptions) {
        super()

        this.id = options.id ?? randomUUID()
        this.options.type = options.type || 'bot'
        this.options.heartbeatInterval = options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL

        this.broker = new RedisBroker(options.redis)
        this.broker.on('message', this.onMessage.bind(this))
        this.broker.on('error', error => this.emit('error', error))
    }

    public async connect(): Promise<this> {
        await this.broker.connect()

        // Subscribe to own channel and broadcast channel
        await this.broker.subscribe(getClusterManagerChannel(this.id))
        await this.broker.subscribe(BrokerChannels.Broadcast)

        // Notify server that we're ready
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientReady,
            data: {
                clientId: this.id,
                type: this.options.type,
                shards: this.manager?.shards ?? [],
                clusters: this.manager?.clusters ?? []
            }
        })

        await this.broker.publish(BrokerChannels.ClusterBroker, message)

        // Start heartbeat
        this.startHeartbeat()

        this.emit('ready')
        this.emit('debug', { from: 'BrokerClient#connect', data: 'Connected to Redis' })

        return this
    }

    public async disconnect(): Promise<void> {
        this.stopHeartbeat()

        // Notify server about disconnect
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientDisconnect,
            data: { clientId: this.id }
        })

        try {
            await this.broker.publish(BrokerChannels.ClusterBroker, message)
        } catch {
            // Ignore errors during disconnect
        }

        await this.broker.disconnect()
        this.emit('close', 'Disconnected')
    }

    public async send(message: IPCBaseMessage): Promise<void> {
        await this.broker.publish(BrokerChannels.ClusterBroker, message)
    }

    public async request<T = IPCRawMessage>(message: IPCBaseMessage, timeout: number = 30_000): Promise<T> {
        const promise = this.promises.create<T>(message.nonce, { timeout })
        await this.broker.publish(BrokerChannels.ClusterBroker, message)
        return promise
    }

    public async getShardingData(timeout: number = 30_000): Promise<ShardingData> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientShardList,
            data: { clientId: this.id }
        })

        const response = await this.request<IPCRawMessage>(message, timeout)

        if (response.error) throw makeError(response.error)

        return response.data as ShardingData
    }

    public async getClusteringData(clusterCount: number, timeout: number = 30_000): Promise<ClusteringData> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientClusterList,
            data: { clientId: this.id, clusterCount }
        })

        const response = await this.request<IPCRawMessage>(message, timeout)

        if (response.error) throw makeError(response.error)

        return response.data as ClusteringData
    }

    public async getHostsData(timeout: number = 30_000): Promise<HostData[]> {
        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientHosts,
            data: { clientId: this.id, timeout }
        })

        const response = await this.request<IPCRawMessage>(message, timeout)

        if (response.error) throw makeError(response.error)

        return (response.data as HostData[]).sort((a, b) => a.clusters[0] - b.clusters[0])
    }

    public async broadcastEval<T = any>(
        script: string | ((client: any) => any),
        options: EvalOptions = {}
    ): Promise<T> {
        if (typeof script !== 'function' && typeof script !== 'string')
            throw new TypeError('[BrokerClient#broadcastEval] "script" must be a function or a string.')

        script = typeof script === 'function' ? `(${script})(this,${JSON.stringify(options.context)})` : script

        const message = new IPCBaseMessage({
            type: IPCMessageType.BrokerClientBroadcast,
            data: { clientId: this.id, script, options, timeout: options.timeout }
        })

        const response = await this.request<IPCRawMessage>(message, options.timeout)

        if (response.error) throw makeError(response.error)

        return response.data
    }

    private startHeartbeat(): void {
        if (this.heartbeatInterval) return

        this.heartbeatInterval = setInterval(async () => {
            try {
                const message = new IPCBaseMessage({
                    type: IPCMessageType.BrokerClientHeartbeat,
                    data: {
                        clientId: this.id,
                        timestamp: Date.now(),
                        shards: this.manager?.shards ?? [],
                        clusters: this.manager?.clusters ?? []
                    }
                })

                await this.broker.publish(BrokerChannels.ClusterBroker, message)
                this.emit('debug', { from: 'BrokerClient#heartbeat', data: 'Heartbeat sent' })
            } catch (error) {
                this.emit('debug', { from: 'BrokerClient#heartbeat', data: `Heartbeat failed: ${error}` })
            }
        }, this.options.heartbeatInterval)
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval)
            this.heartbeatInterval = null
        }
    }

    private async onMessage(channel: string, message: IPCBaseMessage): Promise<void> {
        this.emit('debug', { from: 'BrokerClient#onMessage', data: { channel, message } })

        if (typeof message.type === 'undefined') return

        // Handle responses to pending requests
        if (this.promises.has(message.nonce)) {
            this.promises.resolveMessage(message)
            return
        }

        const rawMessage = message as IPCRawMessage

        if (rawMessage.type === IPCMessageType.ClusterBrokerBroadcast) {
            const response = new IPCBaseMessage({ nonce: message.nonce })

            try {
                const { script, options } = rawMessage.data
                const data = await this.manager?.broadcastEval(script, options)

                response.type = IPCMessageType.ClusterBrokerBroadcastResponse
                response.data = data
            } catch (err) {
                response.type = IPCMessageType.ClusterBrokerBroadcastResponse
                response.error = makePlainError(err)
            }

            await this.broker.publish(BrokerChannels.ClusterBroker, response)
        } else if (rawMessage.type === IPCMessageType.ClusterBrokerHostData) {
            const response = new IPCBaseMessage({ nonce: message.nonce })

            response.type = IPCMessageType.ClusterBrokerHostDataResponse
            response.data = {
                clientId: this.id,
                hostname: os.hostname(),
                uptime: os.uptime(),
                cpuUsage: await cpu.usage(),
                memoryUsed: await mem.used(),
                shards: this.manager?.shards ?? [],
                clusters: this.manager?.clusters ?? []
            }

            await this.broker.publish(BrokerChannels.ClusterBroker, response)
        } else if (rawMessage.type === IPCMessageType.CustomMessage) {
            this.emit('serverMessage', rawMessage)
        } else if (rawMessage.type === IPCMessageType.CustomRequest) {
            this.emit('serverRequest', rawMessage, async (data: any) => {
                const reply = new IPCBaseMessage({
                    nonce: message.nonce,
                    type: IPCMessageType.CustomReply,
                    data
                })
                await this.broker.publish(BrokerChannels.ClusterBroker, reply)
            })
        }
    }
}

export interface BrokerClientEvents {
    ready: []
    close: [reason: string]
    error: [error: Error]
    serverMessage: [message: IPCRawMessage]
    serverRequest: [message: IPCRawMessage, respond: (data: any) => Promise<void>]
    debug: [message: DebugMessage]
}

export interface BrokerClientOptions {
    redis: RedisOptions | string
    id?: string
    type?: BrokerClientType
    heartbeatInterval?: number
}

export type BrokerClientType = 'bot' | 'custom'

export interface ShardingData {
    shards: number[]
    shardCount: number
}

export interface ClusteringData {
    clusters: number[]
}

export interface HostData {
    clientId: string
    hostname: string
    uptime: number
    cpuUsage: number
    memoryUsed: MemUsedInfo
    shards: number[]
    clusters: number[]
}
