import { EventEmitter } from 'events'
import { Redis, RedisOptions } from 'ioredis'
import { IPCBaseMessage } from '../ipc/IPCMessage'

export class RedisBroker extends EventEmitter<RedisBrokerEvents> {
    public pub: Redis
    public sub: Redis

    private subscriptions = new Set<string>()

    constructor(public readonly options: RedisOptions | string) {
        super()

        if (typeof options === 'string') {
            this.pub = new Redis(options, { lazyConnect: true })
            this.sub = new Redis(options, { lazyConnect: true })
        } else {
            this.pub = new Redis({ ...options, lazyConnect: true })
            this.sub = new Redis({ ...options, lazyConnect: true })
        }

        this.pub.on('error', error => this.emit('error', error))
        this.sub.on('error', error => this.emit('error', error))

        this.sub.on('message', (channel, message) => {
            try {
                const data = JSON.parse(message) as IPCBaseMessage
                this.emit('message', channel, data)
            } catch {
                this.emit('error', new Error(`Failed to parse message from ${channel}`))
            }
        })
    }

    async connect(): Promise<void> {
        await Promise.all([this.pub.connect(), this.sub.connect()])
        this.emit('ready')
    }

    async disconnect(): Promise<void> {
        this.sub.disconnect()
        this.pub.disconnect()
    }

    async subscribe(channel: string): Promise<void> {
        if (this.subscriptions.has(channel)) return

        await this.sub.subscribe(channel)
        this.subscriptions.add(channel)
    }

    async unsubscribe(channel: string): Promise<void> {
        if (!this.subscriptions.has(channel)) return

        await this.sub.unsubscribe(channel)
        this.subscriptions.delete(channel)
    }

    async publish(channel: string, message: IPCBaseMessage): Promise<void> {
        await this.pub.publish(channel, JSON.stringify(message))
    }
}

export interface RedisBrokerEvents {
    ready: []
    message: [channel: string, message: IPCBaseMessage]
    error: [error: Error]
}

export enum BrokerChannels {
    ClusterBroker = 'letsfrag:cb',
    Broadcast = 'letsfrag:broadcast'
}

export function getClusterManagerChannel(id: string | number): string {
    return `letsfrag:cm:${id}`
}

export function getClusterChannel(managerId: string | number, clusterId: number): string {
    return `letsfrag:cluster:${managerId}:${clusterId}`
}
