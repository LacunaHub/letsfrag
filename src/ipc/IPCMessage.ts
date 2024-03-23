import { randomUUID } from 'crypto'
import { MakeErrorOptions } from 'discord.js'
import { ServerClientConnection } from '../managers/Server'
import { Cluster } from '../structures/Cluster'
import { ClusterShard } from '../structures/ClusterShard'
import { ServerClient } from '../structures/ServerClient'

export class IPCBaseMessage {
    /**
     * Message nonce.
     */
    public nonce: string

    /**
     * Message type.
     */
    public type: IPCMessageType

    /**
     * Message data.
     */
    public data: IPCMessageData

    /**
     * Message error data.
     */
    public error?: MakeErrorOptions

    constructor(message: IPCRawMessage = {}) {
        this.nonce = message.nonce = message.nonce || randomUUID()
        this.type = message.type || IPCMessageType.CustomMessage
        this.data = message.data ?? {}
        this.error = message.error
    }

    /**
     * Serializes the message to JSON.
     */
    public toJSON(): IPCRawMessage {
        return { nonce: this.nonce, type: this.type, data: this.data, error: this.error }
    }
}

export class IPCMessage extends IPCBaseMessage {
    constructor(public instance: Cluster | ClusterShard, message: IPCRawMessage) {
        super(message)
    }

    /**
     * Sends a message to instance.
     * @param data Message data.
     */
    public async send(data: IPCMessageData): Promise<void> {
        if (typeof data !== 'object' && data !== null)
            throw new TypeError('[IPCMessage#send] "data" must be an object.')

        const message = new IPCBaseMessage({ type: IPCMessageType.CustomMessage, data })

        return await this.instance.send(message)
    }

    /**
     * Sends a request to instance.
     * @param data Message data.
     */
    public async request(data: IPCMessageData): Promise<void> {
        if (typeof data !== 'object' && data !== null)
            throw new TypeError('[IPCMessage#request] "data" must be an object.')

        const message = new IPCBaseMessage({ nonce: this.nonce, type: IPCMessageType.CustomRequest, data })

        return await this.instance.request(message)
    }

    /**
     * Sends a reply to instance.
     * @param data Message data.
     */
    public async reply(data: IPCMessageData): Promise<void> {
        if (typeof data !== 'object' && data !== null)
            throw new TypeError('[IPCMessage#reply] "data" must be an object.')

        const message = new IPCBaseMessage({
            nonce: this.nonce,
            type: IPCMessageType.CustomMessage,
            data
        })

        return await this.instance.send(message)
    }
}

export class NetIPCMessage extends IPCBaseMessage {
    constructor(
        public instance: ServerClient | ServerClientConnection,
        message: IPCRawMessage,
        public respond?: NetIPCMessageRespond
    ) {
        super(message)
    }

    /**
     * Sends a message to instance.
     * @param data Message data.
     */
    public async send(data: IPCMessageData): Promise<void> {
        if (typeof data !== 'object' && data !== null)
            throw new TypeError('[IPCMessage#request] "data" must be an object.')

        const message = new IPCBaseMessage({ nonce: this.nonce, type: IPCMessageType.CustomMessage, data })

        return this.instance.send(message.toJSON())
    }

    /**
     * Sends a request to instance.
     * @param data Message data.
     */
    public async request(data: IPCMessageData): Promise<void> {
        if (typeof data !== 'object' && data !== null)
            throw new TypeError('[IPCMessage#request] "data" must be an object.')

        const message = new IPCBaseMessage({ nonce: this.nonce, type: IPCMessageType.CustomRequest, data })

        return await this.instance.request(message.toJSON())
    }

    /**
     * Sends a reply to instance.
     * @param data Message data.
     */
    public async reply(data: IPCMessageData): Promise<void> {
        if (typeof data !== 'object' && data !== null)
            throw new TypeError('[IPCMessage#reply] "data" must be an object.')

        const message = new IPCBaseMessage({
            nonce: this.nonce,
            type: IPCMessageType.CustomMessage,
            data
        })

        return await this.respond?.(message.toJSON())
    }
}

export interface IPCRawMessage {
    nonce?: string
    type?: IPCMessageType
    data?: IPCMessageData
    error?: MakeErrorOptions
}

export type IPCMessageData = Record<any, any>

export enum IPCMessageType {
    'ClusterReady',
    'ClusterRespawn',
    'ClusterShardEval',
    'ClusterShardEvalResponse',
    'ClusterManagerBroadcast',
    'ClusterManagerBroadcastEval',
    'ClusterManagerBroadcastResponse',
    'ClusterManagerEval',
    'ClusterManagerEvalResponse',
    'ClusterManagerRespawnAll',
    'ClusterManagerSpawnNextCluster',
    'ServerBroadcast',
    'ServerBroadcastResponse',
    'ServerHostData',
    'ServerHostDataResponse',
    'ServerClientBroadcast',
    'ServerClientBroadcastResponse',
    'ServerClientHosts',
    'ServerClientHostsResponse',
    'ServerClientShardList',
    'ServerClientShardListResponse',
    'CustomMessage',
    'CustomReply',
    'CustomRequest'
}

export type NetIPCMessageRespond = (message: IPCRawMessage) => Promise<void>
