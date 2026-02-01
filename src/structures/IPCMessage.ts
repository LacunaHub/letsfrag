import { randomUUID } from 'crypto'
import { MakeErrorOptions } from 'discord.js'
import { EvalOptions } from '../managers/ClusterManager'
import { ClusterContextStats } from './ClusterContext'

export enum IPCMessageType {
    ClusterReady = 1,
    ClusterRespawn,
    ClusterContextHeartbeat,
    ClusterContextEval,
    ClusterContextEvalResult,
    BroadcastEval,
    BroadcastEvalResult
}

/** Data shape map */
export interface IPCMessageDataMap {
    [IPCMessageType.ClusterReady]: never
    [IPCMessageType.ClusterRespawn]: never
    [IPCMessageType.ClusterContextHeartbeat]: ClusterContextStats
    [IPCMessageType.ClusterContextEval]: {
        script: string
        options: EvalOptions
    }
    [IPCMessageType.ClusterContextEvalResult]: any | undefined // Optional: can have error instead
    [IPCMessageType.BroadcastEval]: {
        script: string
        options: EvalOptions
    }
    [IPCMessageType.BroadcastEvalResult]: any | undefined // Optional: can have error instead
}

// Type utilities
type IPCMessageBase = {
    nonce: string
    error?: MakeErrorOptions
}

/** Message types where data is optional (result types that can have error instead) */
type OptionalDataTypes = IPCMessageType.ClusterContextEvalResult | IPCMessageType.BroadcastEvalResult

type IPCMessageOf<T extends IPCMessageType> = IPCMessageBase & {
    type: T
} & ([IPCMessageDataMap[T]] extends [never]
        ? { data?: undefined }
        : T extends OptionalDataTypes
          ? { data?: IPCMessageDataMap[T] }
          : { data: IPCMessageDataMap[T] })

type IPCMessagePayloadOf<T extends IPCMessageType> = Omit<IPCMessageOf<T>, 'nonce'> & { nonce?: string }

// Union types
export type IPCMessage = {
    [K in IPCMessageType]: IPCMessageOf<K>
}[IPCMessageType]

export type IPCMessagePayload = {
    [K in IPCMessageType]: IPCMessagePayloadOf<K>
}[IPCMessageType]

/** Factory function */
export function createIPCMessage(payload: IPCMessagePayload): IPCMessage {
    return {
        ...payload,
        nonce: payload.nonce || randomUUID()
    } as IPCMessage
}

// Named type aliases
export type IPCMessageClusterReady = IPCMessageOf<IPCMessageType.ClusterReady>
export type IPCMessageClusterRespawn = IPCMessageOf<IPCMessageType.ClusterRespawn>
export type IPCMessageClusterContextHeartbeat = IPCMessageOf<IPCMessageType.ClusterContextHeartbeat>
export type IPCMessageClusterContextEval = IPCMessageOf<IPCMessageType.ClusterContextEval>
export type IPCMessageClusterContextEvalResult = IPCMessageOf<IPCMessageType.ClusterContextEvalResult>
export type IPCMessageBroadcastEval = IPCMessageOf<IPCMessageType.BroadcastEval>
export type IPCMessageBroadcastEvalResult = IPCMessageOf<IPCMessageType.BroadcastEvalResult>
