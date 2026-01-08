import { randomUUID } from 'crypto'
import { MakeErrorOptions } from 'discord.js'
import { Cluster } from '../structures/Cluster'
import { ClusterShard } from '../structures/ClusterShard'

export class IPCBaseMessage {
    public nonce: string
    public type: IPCMessageType
    public data: IPCMessageData
    public error?: MakeErrorOptions

    constructor(message: IPCRawMessage = {}) {
        this.nonce = message.nonce = message.nonce || randomUUID()
        this.type = message.type || IPCMessageType.CustomMessage
        this.data = message.data ?? {}
        this.error = message.error
    }

    public toJSON(): IPCRawMessage {
        return { nonce: this.nonce, type: this.type, data: this.data, error: this.error }
    }
}

export class IPCMessage extends IPCBaseMessage {
    constructor(public instance: Cluster | ClusterShard, message: IPCRawMessage) {
        super(message)
    }

    public async send(data: IPCMessageData): Promise<void> {
        if (typeof data !== 'object' && data !== null)
            throw new TypeError('[IPCMessage#send] "data" must be an object.')

        const message = new IPCBaseMessage({ type: IPCMessageType.CustomMessage, data })

        return await this.instance.send(message)
    }

    public async request(data: IPCMessageData): Promise<void> {
        if (typeof data !== 'object' && data !== null)
            throw new TypeError('[IPCMessage#request] "data" must be an object.')

        const message = new IPCBaseMessage({ nonce: this.nonce, type: IPCMessageType.CustomRequest, data })

        return await this.instance.request(message)
    }

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

export interface IPCRawMessage {
    nonce?: string
    type?: IPCMessageType
    data?: IPCMessageData
    error?: MakeErrorOptions
}

export type IPCMessageData = Record<any, any>

export enum IPCMessageType {
    ClusterReady,
    ClusterRespawn,
    ClusterShardEval,
    ClusterShardEvalResponse,
    ClusterManagerBroadcast,
    ClusterManagerBroadcastEval,
    ClusterManagerBroadcastResponse,
    ClusterManagerEval,
    ClusterManagerEvalResponse,
    ClusterManagerRespawnAll,
    ClusterManagerSpawnNextCluster,
    ClusterBrokerBroadcast,
    ClusterBrokerBroadcastResponse,
    ClusterBrokerHostData,
    ClusterBrokerHostDataResponse,
    BrokerClientBroadcast,
    BrokerClientBroadcastResponse,
    BrokerClientHosts,
    BrokerClientHostsResponse,
    BrokerClientShardList,
    BrokerClientShardListResponse,
    BrokerClientClusterList,
    BrokerClientClusterListResponse,
    BrokerClientReady,
    BrokerClientHeartbeat,
    BrokerClientDisconnect,
    CustomMessage,
    CustomReply,
    CustomRequest
}
