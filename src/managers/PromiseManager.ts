import { WishMap } from '@danliyev/wishmap'
import { makeError, MakeErrorOptions } from 'discord.js'

/**
 * Manages pending promises for request-response patterns using nonce-based correlation.
 * Allows creating promises that can be resolved/rejected externally by their nonce identifier.
 */
export class PromiseManager {
    /**
     * Cache of pending promises keyed by nonce
     */
    public cache = new WishMap<string, CachedPromise>()

    /**
     * Checks if a promise with the given nonce exists
     *
     * @param nonce - The unique identifier for the promise
     * @returns True if the promise exists in cache
     */
    public has(nonce: string): boolean {
        return this.cache.has(nonce)
    }

    /**
     * Resolves a pending promise by its nonce and removes it from cache
     *
     * @param nonce - The unique identifier for the promise
     * @param value - The value to resolve the promise with
     */
    public resolve(nonce: string, value?: unknown): void {
        const promise = this.cache.get(nonce)
        if (!promise) return

        if (promise.timeout) clearTimeout(promise.timeout)
        this.cache.delete(nonce)
        promise.resolve(value)
    }

    /**
     * Rejects a pending promise by its nonce and removes it from cache
     *
     * @param nonce - The unique identifier for the promise
     * @param error - The error to reject the promise with
     */
    public reject(nonce: string, error: Error | MakeErrorOptions): void {
        const promise = this.cache.get(nonce)
        if (!promise) return

        if (promise.timeout) clearTimeout(promise.timeout)
        this.cache.delete(nonce)
        promise.reject(error instanceof Error ? error : makeError(error))
    }

    /**
     * Creates a new promise and stores it in cache for later resolution
     *
     * @typeParam T - The expected type of the resolved value
     * @param nonce - The unique identifier for the promise
     * @param options - Creation options
     * @param options.timeout - Timeout in milliseconds after which the promise auto-rejects
     * @returns A promise that will be resolved/rejected when resolve/reject is called with the same nonce
     */
    public create<T>(nonce: string, options: { timeout?: number } = {}): Promise<T> {
        return new Promise<T>((resolve, reject) => {
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

/**
 * Internal structure for storing pending promise state
 */
export interface CachedPromise {
    /**
     * Auto-rejection timeout handle (if timeout was specified)
     */
    timeout?: NodeJS.Timeout

    /**
     * Function to resolve the promise
     */
    resolve(value: unknown): void

    /**
     * Function to reject the promise
     */
    reject(error: Error): void
}
