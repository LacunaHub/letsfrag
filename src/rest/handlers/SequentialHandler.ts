import { AsyncQueue } from '@sapphire/async-queue'
import { HandlerRequestData, RateLimitData, ResponseLike, RouteData } from 'discord.js'
import type { RequestInit } from 'undici'
import { hasSublimit, normalizeRateLimitOffset, onRateLimit, sleep } from '../../utils/Utils'
import {
    RMEvents,
    RequestManager,
    RequestManagerHandlerData,
    RequestManagerHashData,
    handleErrors,
    incrementInvalidCount,
    makeNetworkRequest
} from '../RequestManager'

const enum QueueType {
    Standard,
    Sublimit
}

/**
 * The structure used to handle sequential requests for a given bucket
 */
export class SequentialHandler {
    /**
     * The unique id of the handler
     */
    public readonly id: string

    /**
     * The time this rate limit bucket will reset
     */
    public reset: number = -1

    /**
     * The remaining requests that can be made before we are rate limited
     */
    public remaining: number = -1

    /**
     * The total number of requests that can be made before we are rate limited
     */
    public limit: number = -1

    /**
     * The interface used to sequence async requests sequentially
     */
    private asyncQueue = new AsyncQueue()

    /**
     * The interface used to sequence sublimited async requests sequentially
     */
    private sublimitedQueue: AsyncQueue | null = null

    /**
     * A promise wrapper for when the sublimited queue is finished being processed or null when not being processed
     */
    private sublimitPromise: { promise: Promise<void>; resolve(): void } | null = null

    /**
     * Whether the sublimit queue needs to be shifted in the finally block
     */
    private shiftSublimit = false

    /**
     * @param manager - The request manager
     * @param hash - The hash that this RequestHandler handles
     * @param majorParameter - The major parameter for this handler
     */
    constructor(
        public readonly manager: RequestManager,
        public readonly hash: string,
        public readonly majorParameter: string,
        public readonly state: Partial<RequestManagerHandlerData> = {}
    ) {
        this.id = `${hash}:${majorParameter}`
        this.reset = state.reset ?? -1
        this.remaining = state.remaining ?? -1
        this.limit = state.limit ?? Number.POSITIVE_INFINITY
    }

    /**
     * If the bucket is currently inactive (no pending requests)
     */
    public get inactive(): boolean {
        return (
            this.asyncQueue.remaining === 0 &&
            (this.sublimitedQueue === null || this.sublimitedQueue.remaining === 0) &&
            !this.limited
        )
    }

    /**
     * If the rate limit bucket is currently limited by the global limit
     */
    private get globalLimited(): boolean {
        return this.manager.globalRemaining <= 0 && Date.now() < this.manager.globalReset
    }

    /**
     * If the rate limit bucket is currently limited by its limit
     */
    private get localLimited(): boolean {
        return this.remaining <= 0 && Date.now() < this.reset
    }

    /**
     * If the rate limit bucket is currently limited
     */
    private get limited(): boolean {
        return this.globalLimited || this.localLimited
    }

    /**
     * The time until queued requests can continue
     */
    private getTimeToReset(routeId: RouteData): number {
        const offset = normalizeRateLimitOffset(this.manager.options.offset, routeId.bucketRoute)
        return this.reset + offset - Date.now()
    }

    /**
     * Delay all requests for the specified amount of time, handling global rate limits
     *
     * @param time - The amount of time to delay all requests for
     */
    private async globalDelayFor(time: number): Promise<void> {
        await sleep(time)
        this.manager.globalDelay = null
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
        let queue = this.asyncQueue
        let queueType = QueueType.Standard
        // Separate sublimited requests when already sublimited
        if (this.sublimitedQueue && hasSublimit(routeId.bucketRoute, requestData.body, options.method)) {
            queue = this.sublimitedQueue!
            queueType = QueueType.Sublimit
        }

        // Wait for any previous requests to be completed before this one is run
        await queue.wait({ signal: requestData.signal })
        // This set handles retroactively sublimiting requests
        if (queueType === QueueType.Standard) {
            if (this.sublimitedQueue && hasSublimit(routeId.bucketRoute, requestData.body, options.method)) {
                /**
                 * Remove the request from the standard queue, it should never be possible to get here while processing the
                 * sublimit queue so there is no need to worry about shifting the wrong request
                 */
                queue = this.sublimitedQueue!
                const wait = queue.wait()
                this.asyncQueue.shift()
                await wait
            } else if (this.sublimitPromise) {
                // Stall requests while the sublimit queue gets processed
                await this.sublimitPromise.promise
            }
        }

        try {
            // Make the request, and return the results
            return await this.runRequest(routeId, url, options, requestData)
        } finally {
            // Allow the next request to fire
            queue.shift()
            if (this.shiftSublimit) {
                this.shiftSublimit = false
                this.sublimitedQueue?.shift()
            }

            // If this request is the last request in a sublimit
            if (this.sublimitedQueue?.remaining === 0) {
                this.sublimitPromise?.resolve()
                this.sublimitedQueue = null
            }
        }
    }

    /**
     * The method that actually makes the request to the api, and updates info about the bucket accordingly
     *
     * @param routeId - The generalized api route with literal ids for major parameters
     * @param url - The fully resolved url to make the request to
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
        /*
         * After calculations have been done, pre-emptively stop further requests
         * Potentially loop until this task can run if e.g. the global rate limit is hit twice
         */
        while (this.limited) {
            const isGlobal = this.globalLimited
            let limit: number
            let timeout: number
            let delay: Promise<void>

            if (isGlobal) {
                const offset = normalizeRateLimitOffset(this.manager.options.offset, routeId.bucketRoute)

                // Set RateLimitData based on the global limit
                limit = this.manager.options.globalRequestsPerSecond
                timeout = this.manager.globalReset + offset - Date.now()
                // If this is the first task to reach the global timeout, set the global delay
                if (!this.manager.globalDelay) {
                    // The global delay function clears the global delay state when it is resolved
                    this.manager.globalDelay = this.globalDelayFor(timeout)
                }

                delay = this.manager.globalDelay
            } else {
                // Set RateLimitData based on the route-specific limit
                limit = this.limit
                timeout = this.getTimeToReset(routeId)
                delay = sleep(timeout)
            }

            const rateLimitData: RateLimitData = {
                global: isGlobal,
                method: options.method ?? 'get',
                url,
                route: routeId.bucketRoute,
                majorParameter: this.majorParameter,
                hash: this.hash,
                limit,
                timeToReset: timeout,
                retryAfter: timeout,
                sublimitTimeout: 0,
                scope: 'user'
            }

            // Let library users know they have hit a rate limit
            this.manager.emit(RMEvents.RateLimited, rateLimitData)
            // Determine whether a RateLimitError should be thrown
            await onRateLimit(this.manager, rateLimitData)

            // When not erroring, emit debug for what is happening
            if (isGlobal) {
                this.debug(`Global rate limit hit, blocking all requests for ${timeout}ms`)
            } else {
                this.debug(`Waiting ${timeout}ms for rate limit to pass`)
            }

            // Wait the remaining time left before the rate limit resets
            await delay
        }

        // As the request goes out, update the global usage information
        if (!this.manager.globalReset || this.manager.globalReset < Date.now()) {
            this.manager.globalReset = Date.now() + 1_000
            this.manager.globalRemaining = this.manager.options.globalRequestsPerSecond
        }

        this.manager.globalRemaining--

        const method = options.method ?? 'get'

        const res = await makeNetworkRequest(this.manager, routeId, url, options, requestData, retries)

        // Retry requested
        if (res === null) {
            // eslint-disable-next-line no-param-reassign
            return this.runRequest(routeId, url, options, requestData, ++retries)
        }

        const status = res.status
        let retryAfter = 0

        const limit = res.headers.get('X-RateLimit-Limit')
        const remaining = res.headers.get('X-RateLimit-Remaining')
        const reset = res.headers.get('X-RateLimit-Reset-After')
        const hash = res.headers.get('X-RateLimit-Bucket')
        const retry = res.headers.get('Retry-After')
        const scope = (res.headers.get('X-RateLimit-Scope') ?? 'user') as RateLimitData['scope']

        const offset = normalizeRateLimitOffset(this.manager.options.offset, routeId.bucketRoute)

        // Update the total number of requests that can be made before the rate limit resets
        this.limit = limit ? Number(limit) : Number.POSITIVE_INFINITY
        // Update the number of remaining requests that can be made before the rate limit resets
        this.remaining = remaining ? Number(remaining) : 1
        // Update the time when this rate limit resets (reset-after is in seconds)
        this.reset = reset ? Number(reset) * 1_000 + Date.now() + offset : Date.now()

        // Amount of time in milliseconds until we should retry if rate limited (globally or otherwise)
        if (retry) retryAfter = Number(retry) * 1_000 + offset

        // Handle buckets via the hash header retroactively
        if (hash && hash !== this.hash) {
            // Let library users know when rate limit buckets have been updated
            this.debug(
                ['Received bucket hash update', `  Old Hash  : ${this.hash}`, `  New Hash  : ${hash}`].join('\n')
            )
            // This queue will eventually be eliminated via attrition
            await this.manager.hashes.set(
                `${method}:${routeId.bucketRoute}`,
                { value: hash, lastAccess: Date.now() },
                this.manager.options.hashLifetime
            )
        } else if (hash) {
            // Handle the case where hash value doesn't change
            // Fetch the hash data from the manager
            const hashData = await this.manager.hashes.get<RequestManagerHashData>(`${method}:${routeId.bucketRoute}`)

            // When fetched, update the last access of the hash
            if (hashData) {
                hashData.lastAccess = Date.now()
                await this.manager.hashes.set(
                    `${method}:${routeId.bucketRoute}`,
                    hashData,
                    this.manager.options.hashLifetime
                )
            }
        }

        // Handle retryAfter, which means we have actually hit a rate limit
        let sublimitTimeout: number | null = null
        if (retryAfter > 0) {
            if (res.headers.has('X-RateLimit-Global')) {
                this.manager.globalRemaining = 0
                this.manager.globalReset = Date.now() + retryAfter
            } else if (!this.localLimited) {
                /*
                 * This is a sublimit (e.g. 2 channel name changes/10 minutes) since the headers don't indicate a
                 * route-wide rate limit. Don't update remaining or reset to avoid rate limiting the whole
                 * endpoint, just set a reset time on the request itself to avoid retrying too soon.
                 */
                sublimitTimeout = retryAfter
            }
        }

        // Count the invalid requests
        if (status === 401 || status === 403 || status === 429) {
            incrementInvalidCount(this.manager)
        }

        if (res.ok) {
            return res
        } else if (status === 429) {
            // A rate limit was hit - this may happen if the route isn't associated with an official bucket hash yet, or when first globally rate limited
            const isGlobal = this.globalLimited
            let limit: number
            let timeout: number

            if (isGlobal) {
                const offset = normalizeRateLimitOffset(this.manager.options.offset, routeId.bucketRoute)

                // Set RateLimitData based on the global limit
                limit = this.manager.options.globalRequestsPerSecond
                timeout = this.manager.globalReset + offset - Date.now()
            } else {
                // Set RateLimitData based on the route-specific limit
                limit = this.limit
                timeout = this.getTimeToReset(routeId)
            }

            await onRateLimit(this.manager, {
                global: isGlobal,
                method,
                url,
                route: routeId.bucketRoute,
                majorParameter: this.majorParameter,
                hash: this.hash,
                limit,
                timeToReset: timeout,
                retryAfter,
                sublimitTimeout: sublimitTimeout ?? 0,
                scope
            })

            this.debug(
                [
                    'Encountered unexpected 429 rate limit',
                    `  Global         : ${isGlobal.toString()}`,
                    `  Method         : ${method}`,
                    `  URL            : ${url}`,
                    `  Bucket         : ${routeId.bucketRoute}`,
                    `  Major parameter: ${routeId.majorParameter}`,
                    `  Hash           : ${this.hash}`,
                    `  Limit          : ${limit}`,
                    `  Retry After    : ${retryAfter}ms`,
                    `  Sublimit       : ${sublimitTimeout ? `${sublimitTimeout}ms` : 'None'}`,
                    `  Scope          : ${scope}`
                ].join('\n')
            )

            // If caused by a sublimit, wait it out here so other requests on the route can be handled
            if (sublimitTimeout) {
                // Normally the sublimit queue will not exist, however, if a sublimit is hit while in the sublimit queue, it will
                const firstSublimit = !this.sublimitedQueue
                if (firstSublimit) {
                    this.sublimitedQueue = new AsyncQueue()
                    void this.sublimitedQueue.wait()
                    this.asyncQueue.shift()
                }

                this.sublimitPromise?.resolve()
                this.sublimitPromise = null
                await sleep(sublimitTimeout)
                let resolve: () => void
                // eslint-disable-next-line promise/param-names, no-promise-executor-return
                const promise = new Promise<void>(res => (resolve = res))
                this.sublimitPromise = { promise, resolve: resolve! }
                if (firstSublimit) {
                    // Re-queue this request so it can be shifted by the finally
                    await this.asyncQueue.wait()
                    this.shiftSublimit = true
                }
            }

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
        return { id: this.id, inactive: this.inactive, reset: this.reset, remaining: this.remaining, limit: this.limit }
    }
}
