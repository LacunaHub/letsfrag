import { makeError } from 'discord.js'
import { IPCBaseMessage } from '../ipc/IPCMessage'
import { ClusterShard } from '../structures/ClusterShard'
import { ClusterManager } from './ClusterManager'

export class PromiseManager<T extends ClusterManager | ClusterShard> {
    public cache = new Map<string, CachedPromise>()

    constructor(public instance: T) {}

    public resolve(message: IPCBaseMessage): void {
        const promise = this.cache.get(message.nonce)

        if (!promise) return

        if (promise.timeout) clearTimeout(promise.timeout)
        this.cache.delete(message.nonce)

        if (typeof message.error === 'undefined') {
            return promise.resolve(message.data)
        } else {
            return promise.reject(makeError(message.error))
        }
    }

    public async create<T>(nonce: string, options: { timeout?: number } = {}): Promise<T> {
        return await new Promise<T>((resolve, reject) => {
            const timeout =
                typeof options.timeout === 'number'
                    ? setTimeout(() => {
                          this.cache.delete(nonce)
                          reject(new Error('[PromiseManager#create] Promise timed out.'))
                      }, options.timeout)
                    : null

            this.cache.set(nonce, { resolve, reject, timeout })
        })
    }
}

export interface CachedPromise {
    timeout?: NodeJS.Timeout

    resolve(value: unknown): void

    reject(error: Error): void
}
