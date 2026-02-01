import { randomUUID } from 'crypto'
import { ClusterBrokerClient, ClusterBrokerManager } from '../brokers/ClusterBroker'
import { SystemResources } from '../managers/ClusterManager'
import { BrokerClientType } from './BrokerClient'
import { ClusterStats } from './Cluster'

export enum BrokerMessageType {
    ClusterBrokerInitialize = 1,
    BrokerClientConnect,
    BrokerClientDisconnect,
    ClusterManagerRegister,
    ClusterManagerHeartbeat,
    ClusterManagerReady,
    ShardAssignment,
    RequestStats,
    RequestStatsResult
}

/** Data shape map */
export interface BrokerMessageDataMap {
    [BrokerMessageType.ClusterBrokerInitialize]: never
    [BrokerMessageType.BrokerClientConnect]: {
        id: string
        type: BrokerClientType
    }
    [BrokerMessageType.BrokerClientDisconnect]: {
        id: string
    }
    [BrokerMessageType.ClusterManagerRegister]: { id: string } & SystemResources
    [BrokerMessageType.ClusterManagerHeartbeat]: { id: string; clusters: ClusterStats[] } & SystemResources
    [BrokerMessageType.ClusterManagerReady]: {
        id: string
        clusterCount: number
        shardList: number[]
    }
    [BrokerMessageType.ShardAssignment]: {
        firstClusterId: number
        shardList: number[]
        shardCount: number
    }
    [BrokerMessageType.RequestStats]: never
    [BrokerMessageType.RequestStatsResult]: {
        readyAt: number
        clients: ClusterBrokerClient[]
        managers: ClusterBrokerManager[]
        shardCount: number
        shardsPerManager: number
    }
}

// Type utilities
type BrokerMessageBase = {
    from: string
    nonce: string
}

type BrokerMessageOf<T extends BrokerMessageType> = BrokerMessageBase & {
    type: T
} & ([BrokerMessageDataMap[T]] extends [never] ? { data?: undefined } : { data: BrokerMessageDataMap[T] })

type BrokerMessagePayloadOf<T extends BrokerMessageType> = Omit<BrokerMessageOf<T>, 'nonce'> & { nonce?: string }

/** Distributive Omit that preserves union types */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never

// Union types
export type BrokerMessage = {
    [K in BrokerMessageType]: BrokerMessageOf<K>
}[BrokerMessageType]

export type BrokerMessagePayload = {
    [K in BrokerMessageType]: BrokerMessagePayloadOf<K>
}[BrokerMessageType]

/** Payload type without 'from' field, for use in send/broadcast methods */
export type BrokerMessagePayloadWithoutFrom = DistributiveOmit<BrokerMessagePayload, 'from'>

/** Factory function */
export function createBrokerMessage(payload: BrokerMessagePayload): BrokerMessage {
    return {
        ...payload,
        nonce: payload.nonce || randomUUID()
    } as BrokerMessage
}

// Named type aliases
export type BrokerMessageClusterBrokerInitialize = BrokerMessageOf<BrokerMessageType.ClusterBrokerInitialize>
export type BrokerMessageBrokerClientConnect = BrokerMessageOf<BrokerMessageType.BrokerClientConnect>
export type BrokerMessageBrokerClientDisconnect = BrokerMessageOf<BrokerMessageType.BrokerClientDisconnect>
export type BrokerMessageClusterManagerRegister = BrokerMessageOf<BrokerMessageType.ClusterManagerRegister>
export type BrokerMessageClusterManagerHeartbeat = BrokerMessageOf<BrokerMessageType.ClusterManagerHeartbeat>
export type BrokerMessageClusterManagerReady = BrokerMessageOf<BrokerMessageType.ClusterManagerReady>
export type BrokerMessageShardAssignment = BrokerMessageOf<BrokerMessageType.ShardAssignment>
export type BrokerMessageRequestStats = BrokerMessageOf<BrokerMessageType.RequestStats>
export type BrokerMessageRequestStatsResult = BrokerMessageOf<BrokerMessageType.RequestStatsResult>
