import { HandlerRequestData, RateLimitData, ResponseLike, RouteData } from 'discord.js'
import type { RequestInit } from 'undici'
import { normalizeRateLimitOffset, onRateLimit, sleep } from '../../utils/Utils'
import { RMEvents, RequestManager, handleErrors, incrementInvalidCount, makeNetworkRequest } from '../RequestManager'

/**
 * The structure used to handle burst requests for a given bucket.
 * Burst requests have no ratelimit handling but allow for pre- and post-processing
 * of data in the same manner as sequentially queued requests.
 *
 * @remarks
 * This queue may still emit a rate limit error if an unexpected 429 is hit
 */
export class BurstHandler {
    /**
     * The unique id of the handler
     */
    public readonly id: string

    /**
     * If the bucket is currently inactive (no pending requests)
     */
    public inactive: boolean = false

    /**
     * @param manager - The request manager
     * @param hash - The hash that this RequestHandler handles
     * @param majorParameter - The major parameter for this handler
     */
    constructor(
        public readonly manager: RequestManager,
        public readonly hash: string,
        public readonly majorParameter: string
    ) {
        this.id = `${hash}:${majorParameter}`
    }

    /**
     * Queues a request to be sent
     *
     * @param routeId - The generalized api route with literal ids for major parameters
     * @param url - The url to do the request on
     * @param options - All the information needed to make a request
     * @param requestData - Extra data from the user's request needed for errors and additional processing
     */
    public async queueRequest(
        routeId: RouteData,
        url: string,
        options: RequestInit,
        requestData: HandlerRequestData
    ): Promise<ResponseLike> {
        return this.runRequest(routeId, url, options, requestData)
    }

    /**
     * The method that actually makes the request to the API, and updates info about the bucket accordingly
     *
     * @param routeId - The generalized API route with literal ids for major parameters
     * @param url - The fully resolved URL to make the request to
     * @param options - The fetch options needed to make the request
     * @param requestData - Extra data from the user's request needed for errors and additional processing
     * @param retries - The number of retries this request has already attempted (recursion)
     */
    private async runRequest(
        routeId: RouteData,
        url: string,
        options: RequestInit,
        requestData: HandlerRequestData,
        retries = 0
    ): Promise<ResponseLike> {
        const method = options.method ?? 'get'

        const res = await makeNetworkRequest(this.manager, routeId, url, options, requestData, retries)

        // Retry requested
        if (res === null) {
            // eslint-disable-next-line no-param-reassign
            return this.runRequest(routeId, url, options, requestData, ++retries)
        }

        const status = res.status
        let retryAfter = 0
        const retry = res.headers.get('Retry-After')

        // Amount of time in milliseconds until we should retry if rate limited (globally or otherwise)
        const offset = normalizeRateLimitOffset(this.manager.options.offset, routeId.bucketRoute)
        if (retry) retryAfter = Number(retry) * 1_000 + offset

        // Count the invalid requests
        if (status === 401 || status === 403 || status === 429) {
            incrementInvalidCount(this.manager)
        }

        if (status >= 200 && status < 300) {
            return res
        } else if (status === 429) {
            // Unexpected ratelimit
            const isGlobal = res.headers.has('X-RateLimit-Global')
            const scope = (res.headers.get('X-RateLimit-Scope') ?? 'user') as RateLimitData['scope']

            await onRateLimit(this.manager, {
                global: isGlobal,
                method,
                url,
                route: routeId.bucketRoute,
                majorParameter: this.majorParameter,
                hash: this.hash,
                limit: Number.POSITIVE_INFINITY,
                timeToReset: retryAfter,
                retryAfter,
                sublimitTimeout: 0,
                scope
            })

            this.debug(
                [
                    'Encountered unexpected 429 rate limit',
                    `  Global         : ${isGlobal}`,
                    `  Method         : ${method}`,
                    `  URL            : ${url}`,
                    `  Bucket         : ${routeId.bucketRoute}`,
                    `  Major parameter: ${routeId.majorParameter}`,
                    `  Hash           : ${this.hash}`,
                    `  Limit          : ${Number.POSITIVE_INFINITY}`,
                    `  Retry After    : ${retryAfter}ms`,
                    `  Sublimit       : None`,
                    `  Scope          : ${scope}`
                ].join('\n')
            )

            // We are bypassing all other limits, but an encountered limit should be respected (it's probably a non-punished rate limit anyways)
            await sleep(retryAfter)

            // Since this is not a server side issue, the next request should pass, so we don't bump the retries counter
            return this.runRequest(routeId, url, options, requestData, retries)
        } else {
            const handled = await handleErrors(this.manager, res, method, url, requestData, retries)
            if (handled === null) {
                // eslint-disable-next-line no-param-reassign
                return this.runRequest(routeId, url, options, requestData, ++retries)
            }

            return handled
        }
    }

    /**
     * Emits a debug message
     *
     * @param message - The message to debug
     */
    private debug(message: string) {
        this.manager.emit(RMEvents.Debug, `[REST ${this.id}] ${message}`)
    }

    public toJSON() {
        return { id: this.id, inactive: this.inactive }
    }
}
