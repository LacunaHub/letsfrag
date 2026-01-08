import { makeError, MakeErrorOptions } from 'discord.js'
import { IPCBaseMessage } from '../ipc/IPCMessage'

export class PromiseManager {
    public cache = new Map<string, CachedPromise>()

    public has(nonce: string): boolean {
        return this.cache.has(nonce)
    }

    public resolve(nonce: string, value?: unknown): void {
        const promise = this.cache.get(nonce)
        if (!promise) return

        if (promise.timeout) clearTimeout(promise.timeout)
        this.cache.delete(nonce)
        promise.resolve(value)
    }

    public reject(nonce: string, error: Error | MakeErrorOptions): void {
        const promise = this.cache.get(nonce)
        if (!promise) return

        if (promise.timeout) clearTimeout(promise.timeout)
        this.cache.delete(nonce)
        promise.reject(error instanceof Error ? error : makeError(error))
    }

    public resolveMessage(message: IPCBaseMessage): void {
        const promise = this.cache.get(message.nonce)
        if (!promise) return

        if (promise.timeout) clearTimeout(promise.timeout)
        this.cache.delete(message.nonce)

        promise.resolve(message)
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
