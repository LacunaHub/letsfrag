import { EventEmitter } from 'events'
import { Redis } from 'ioredis'
import { BrokerMessage } from '../structures/BrokerMessage'

export class RedisBroker extends EventEmitter<RedisBrokerEvents> {
    public pub: Redis
    public sub: Redis

    private subscriptions = new Set<string>()

    constructor(public readonly redisURI: string) {
        super()

        this.pub = new Redis(redisURI, { lazyConnect: true })
        this.sub = new Redis(redisURI, { lazyConnect: true })

        this.pub.on('error', error => this.emit('error', error))
        this.sub.on('error', error => this.emit('error', error))

        this.sub.on('message', (channel, message) => {
            try {
                const data = JSON.parse(message) as BrokerMessage
                this.emit('message', channel, data)
            } catch {
                this.emit('error', new Error(`Failed to parse message from "${channel}"`))
            }
        })
    }

    public async connect(): Promise<void> {
        await Promise.all([this.pub.connect(), this.sub.connect()])
        this.emit('ready')
    }

    public async disconnect(): Promise<void> {
        await Promise.all([this.pub.quit(), this.sub.quit()])
        this.emit('disconnect')
    }

    public async subscribe(channel: string): Promise<void> {
        if (this.subscriptions.has(channel)) return

        await this.sub.subscribe(channel)
        this.subscriptions.add(channel)
    }

    public async unsubscribe(channel: string): Promise<void> {
        if (!this.subscriptions.has(channel)) return

        await this.sub.unsubscribe(channel)
        this.subscriptions.delete(channel)
    }

    public publish(channel: string, message: BrokerMessage): Promise<number> {
        return this.pub.publish(channel, JSON.stringify(message))
    }
}

export interface RedisBrokerEvents {
    ready: []
    message: [channel: string, message: BrokerMessage]
    error: [error: Error]
    disconnect: []
}

export enum RedisBrokerChannels {
    ClusterBroker = 'letsfrag:cluster-broker',
    Broadcast = 'letsfrag:broadcast'
}

export function getBrokerClientChannel(id: string): string {
    return `letsfrag:broker-client:${id}`
}
