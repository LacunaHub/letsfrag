import { RESTPatchAPIChannelJSONBody, RateLimitData, RateLimitError, RequestMethod, ResponseLike } from 'discord.js'
import { RequestManager } from '../rest/RequestManager'

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function generateId(length: number = 10): string {
    if (typeof length !== 'number') length = 4
    if (length < 4) length = 4
    if (length > 11) length = 11

    return `${Math.random().toString(36).substring(2, length)}`
}

export function chunkArray(array: any[], length: number = 10): any[] {
    if (!Array.isArray(array)) array = []
    if (typeof length !== 'number') length = 10

    const arr = []

    for (let i = 0; i < array.length; i += length) {
        arr.push(array.slice(i, i + length))
    }

    return arr
}

export function isBufferLike(value: unknown): value is ArrayBuffer | Buffer | Uint8Array | Uint8ClampedArray {
    return value instanceof ArrayBuffer || value instanceof Uint8Array || value instanceof Uint8ClampedArray
}

export function normalizeRateLimitOffset(offset: GetRateLimitOffsetFunction | number, route: string): number {
    if (typeof offset === 'number') {
        return Math.max(0, offset)
    }

    const result = offset(route)
    return Math.max(0, result)
}

/**
 * Check whether a request falls under a sublimit
 *
 * @param bucketRoute - The buckets route identifier
 * @param body - The options provided as JSON data
 * @param method - The HTTP method that will be used to make the request
 * @returns Whether the request falls under a sublimit
 */
export function hasSublimit(bucketRoute: string, body?: unknown, method?: string): boolean {
    // TODO: Update for new sublimits
    // Currently known sublimits:
    // Editing channel `name` or `topic`
    if (bucketRoute === '/channels/:id') {
        if (typeof body !== 'object' || body === null) return false
        // This should never be a POST body, but just in case
        if (method !== RequestMethod.Patch) return false
        const castedBody = body as RESTPatchAPIChannelJSONBody
        return ['name', 'topic'].some(key => Reflect.has(castedBody, key))
    }

    // If we are checking if a request has a sublimit on a route not checked above, sublimit all requests to avoid a flood of 429s
    return true
}

/**
 * Determines whether the request should be queued or whether a RateLimitError should be thrown
 */
export async function onRateLimit(manager: RequestManager, rateLimitData: RateLimitData) {
    const { options } = manager
    if (!options.rejectOnRateLimit) return

    const shouldThrow =
        typeof options.rejectOnRateLimit === 'function'
            ? await options.rejectOnRateLimit(rateLimitData)
            : options.rejectOnRateLimit.some(route => rateLimitData.route.startsWith(route.toLowerCase()))
    if (shouldThrow) {
        throw new RateLimitError(rateLimitData)
    }
}

/**
 * Converts the response to usable data
 *
 * @param res - The fetch response
 */
export async function parseResponse(res: ResponseLike): Promise<unknown> {
    if (res.headers.get('Content-Type')?.startsWith('application/json')) {
        return res.json()
    }

    return res.arrayBuffer()
}

export type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] }

export type GetRateLimitOffsetFunction = (route: string) => number
