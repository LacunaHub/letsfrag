import {
    APIRequest,
    BurstHandlerMajorIdKey,
    CDN,
    DefaultUserAgent,
    DiscordAPIError,
    DiscordErrorData,
    HTTPError,
    HandlerRequestData,
    InternalRequest,
    InvalidRequestWarningData,
    OAuthErrorData,
    OverwrittenMimeTypes,
    RESTOptions,
    RateLimitData,
    RequestData,
    RequestHeaders,
    RequestMethod,
    ResponseLike,
    RouteData,
    RouteLike,
    SnowflakeUtil,
    parseResponse
} from 'discord.js'
import { EventEmitter } from 'events'
import JSONBI from 'json-bigint'
import { Keyv, KeyvStoreAdapter } from 'keyv'
import filetypeinfo from 'magic-bytes.js'
import type { BodyInit, Dispatcher, RequestInit } from 'undici'
import { DefaultRequestManagerOptions } from '../utils/Constants'
import { isBufferLike } from '../utils/Utils'
import { BurstHandler } from './handlers/BurstHandler'
import { SequentialHandler } from './handlers/SequentialHandler'

let invalidCount = 0,
    invalidCountResetTime: number | null = null

export class RequestManager extends EventEmitter<RequestManagerEvents> {
    /**
     * The {@link https://undici.nodejs.org/#/docs/api/Agent | Agent} for all requests
     * performed by this manager.
     */
    public agent: Dispatcher | null = null

    public readonly cdn: CDN

    /**
     * The number of requests remaining in the global bucket
     */
    public globalRemaining: number

    /**
     * The promise used to wait out the global rate limit
     */
    public globalDelay: Promise<void> | null = null

    /**
     * The timestamp at which the global bucket resets
     */
    public globalReset: number = -1

    /**
     * API bucket hashes that are cached from provided routes
     */
    public readonly hashes: Keyv

    /**
     * Request handlers created from the bucket hash and the major parameters
     */
    public readonly handlers: Keyv

    private token: string | null = null

    constructor(public readonly options: Partial<RequestManagerOptions> = {}) {
        super()

        this.options = { ...DefaultRequestManagerOptions, ...options }
        this.agent = this.options.agent ?? null
        this.cdn = new CDN(this.options.cdn)
        this.globalRemaining = Math.max(1, this.options.globalRequestsPerSecond)

        this.hashes = new Keyv({
            store: this.options.store,
            serialize: this.options.storeSerialize,
            deserialize: this.options.storeDeserialize,
            namespace: 'rqm.hashes',
            ttl: this.options.hashSweepInterval
        })

        this.handlers = new Keyv({
            store: this.options.store,
            serialize: this.options.storeSerialize,
            deserialize: this.options.storeDeserialize,
            namespace: 'rqm.handlers',
            ttl: this.options.handlerSweepInterval
        })
    }

    /**
     * Runs a get request from the api
     *
     * @param fullRoute - The full route to query
     * @param options - Optional request options
     */
    public async get(fullRoute: RouteLike, options: RequestData = {}) {
        return this.request({ ...options, fullRoute, method: RequestMethod.Get })
    }

    /**
     * Runs a delete request from the api
     *
     * @param fullRoute - The full route to query
     * @param options - Optional request options
     */
    public async delete(fullRoute: RouteLike, options: RequestData = {}) {
        return this.request({ ...options, fullRoute, method: RequestMethod.Delete })
    }

    /**
     * Runs a post request from the api
     *
     * @param fullRoute - The full route to query
     * @param options - Optional request options
     */
    public async post(fullRoute: RouteLike, options: RequestData = {}) {
        return this.request({ ...options, fullRoute, method: RequestMethod.Post })
    }

    /**
     * Runs a put request from the api
     *
     * @param fullRoute - The full route to query
     * @param options - Optional request options
     */
    public async put(fullRoute: RouteLike, options: RequestData = {}) {
        return this.request({ ...options, fullRoute, method: RequestMethod.Put })
    }

    /**
     * Runs a patch request from the api
     *
     * @param fullRoute - The full route to query
     * @param options - Optional request options
     */
    public async patch(fullRoute: RouteLike, options: RequestData = {}) {
        return this.request({ ...options, fullRoute, method: RequestMethod.Patch })
    }

    /**
     * Runs a request from the api
     *
     * @param options - Request options
     */
    public async request(options: InternalRequest) {
        const response = await this.queueRequest(options)
        return parseResponse(response)
    }

    /**
     * Sets the default agent to use for requests performed by this manager
     *
     * @param agent - The agent to use
     */
    public setAgent(agent: Dispatcher) {
        this.agent = agent
        return this
    }

    /**
     * Sets the authorization token that should be used for requests
     *
     * @param token - The authorization token to use
     */
    public setToken(token: string) {
        this.token = token
        return this
    }

    /**
     * Queues a request to be sent
     *
     * @param request - All the information needed to make a request
     * @returns The response from the api request
     */
    public async queueRequest(request: InternalRequest): Promise<ResponseLike> {
        // Generalize the endpoint to its route data
        const routeId = RequestManager.generateRouteData(request.fullRoute, request.method)
        // Get the bucket hash for the generic route, or point to a global route otherwise
        const hash = (await this.hashes.get<RequestManagerHashData>(`${request.method}:${routeId.bucketRoute}`)) ?? {
            value: `Global(${request.method}:${routeId.bucketRoute})`,
            lastAccess: -1
        }

        // Get the request handler for the obtained hash, with its major parameter
        const handlerState = await this.handlers.get<RequestManagerHandlerData>(
                `${hash.value}:${routeId.majorParameter}`
            ),
            handler = await this.createHandler(hash.value, routeId.majorParameter, handlerState)

        // Resolve the request into usable fetch options
        const { url, fetchOptions } = await this.resolveRequest(request)
        const response = await handler.queueRequest(routeId, url, fetchOptions, {
            body: request.body,
            files: request.files,
            auth: request.auth !== false,
            signal: request.signal
        })

        await this.handlers.set(handler.id, handler.toJSON(), this.options.handlerSweepInterval)

        return response
    }

    /**
     * Creates a new rate limit handler from a hash, based on the hash and the major parameter
     *
     * @param hash - The hash for the route
     * @param majorParameter - The major parameter for this handler
     * @param state - The state of the handler
     * @internal
     */
    private async createHandler(hash: string, majorParameter: string, state?: RequestManagerHandlerData) {
        // Create the async request queue to handle requests
        const queue =
            majorParameter === BurstHandlerMajorIdKey
                ? new BurstHandler(this, hash, majorParameter)
                : new SequentialHandler(this, hash, majorParameter, state)

        // Save the queue based on its id
        if (!state) await this.handlers.set(queue.id, queue.toJSON())

        return queue
    }

    /**
     * Formats the request data to a usable format for fetch
     *
     * @param request - The request data
     */
    private async resolveRequest(request: InternalRequest): Promise<{ fetchOptions: RequestInit; url: string }> {
        const { options } = this

        let query = ''

        // If a query option is passed, use it
        if (request.query) {
            const resolvedQuery = request.query.toString()
            if (resolvedQuery !== '') {
                query = `?${resolvedQuery}`
            }
        }

        // Create the required headers
        const headers: RequestHeaders = {
            ...this.options.headers,
            'User-Agent': `${DefaultUserAgent} ${options.userAgentAppendix}`.trim()
        }

        // If this request requires authorization (allowing non-"authorized" requests for webhooks)
        if (request.auth !== false) {
            // If we haven't received a token, throw an error
            if (!this.token) {
                throw new Error('Expected token to be set for this request, but none was present')
            }

            headers.Authorization = `${request.authPrefix ?? this.options.authPrefix} ${this.token}`
        }

        // If a reason was set, set its appropriate header
        if (request.reason?.length) {
            headers['X-Audit-Log-Reason'] = encodeURIComponent(request.reason)
        }

        // Format the full request URL (api base, optional version, endpoint, optional querystring)
        const url = `${options.api}${request.versioned === false ? '' : `/v${options.version}`}${
            request.fullRoute
        }${query}`

        let finalBody: RequestInit['body']
        let additionalHeaders: Record<string, string> = {}

        if (request.files?.length) {
            const formData = new FormData()

            // Attach all files to the request
            for (const [index, file] of request.files.entries()) {
                const fileKey = file.key ?? `files[${index}]`

                // https://developer.mozilla.org/en-US/docs/Web/API/FormData/append#parameters
                // FormData.append only accepts a string or Blob.
                // https://developer.mozilla.org/en-US/docs/Web/API/Blob/Blob#parameters
                // The Blob constructor accepts TypedArray/ArrayBuffer, strings, and Blobs.
                if (isBufferLike(file.data)) {
                    // Try to infer the content type from the buffer if one isn't passed
                    let contentType = file.contentType

                    if (!contentType) {
                        const [parsedType] = filetypeinfo(file.data)

                        if (parsedType) {
                            contentType =
                                OverwrittenMimeTypes[parsedType.mime as keyof typeof OverwrittenMimeTypes] ??
                                parsedType.mime ??
                                'application/octet-stream'
                        }
                    }

                    formData.append(fileKey, new Blob([file.data], { type: contentType }), file.name)
                } else {
                    formData.append(fileKey, new Blob([`${file.data}`], { type: file.contentType }), file.name)
                }
            }

            // If a JSON body was added as well, attach it to the form data, using payload_json unless otherwise specified
            // eslint-disable-next-line no-eq-null, eqeqeq
            if (request.body != null) {
                if (request.appendToFormData) {
                    for (const [key, value] of Object.entries(request.body as Record<string, unknown>)) {
                        formData.append(key, value as any)
                    }
                } else {
                    formData.append('payload_json', JSON.stringify(request.body))
                }
            }

            // Set the final body to the form data
            finalBody = formData as any

            // eslint-disable-next-line no-eq-null, eqeqeq
        } else if (request.body != null) {
            if (request.passThroughBody) {
                finalBody = request.body as BodyInit
            } else {
                // Stringify the JSON data
                finalBody = JSON.stringify(request.body)
                // Set the additional headers to specify the content-type
                additionalHeaders = { 'Content-Type': 'application/json' }
            }
        }

        const method = request.method.toUpperCase()

        // The non null assertions in the following block are due to exactOptionalPropertyTypes, they have been tested to work with undefined
        const fetchOptions: RequestInit = {
            // Set body to null on get / head requests. This does not follow fetch spec (likely because it causes subtle bugs) but is aligned with what request was doing
            body: ['GET', 'HEAD'].includes(method) ? null : finalBody!,
            headers: { ...request.headers, ...additionalHeaders, ...headers } as Record<string, string>,
            method,
            // Prioritize setting an agent per request, use the agent for this instance otherwise.
            dispatcher: request.dispatcher ?? this.agent ?? undefined!
        }

        return { url, fetchOptions }
    }

    /**
     * Generates route data for an endpoint:method
     *
     * @param endpoint - The raw endpoint to generalize
     * @param method - The HTTP method this endpoint is called without
     * @internal
     */
    private static generateRouteData(endpoint: RouteLike, method: RequestMethod): RouteData {
        if (endpoint.startsWith('/interactions/') && endpoint.endsWith('/callback')) {
            return {
                majorParameter: BurstHandlerMajorIdKey,
                bucketRoute: '/interactions/:id/:token/callback',
                original: endpoint
            }
        }

        const majorIdMatch =
            /(?:^\/webhooks\/(\d{17,19}\/[^/?]+))|(?:^\/(?:channels|guilds|webhooks)\/(\d{17,19}))/.exec(endpoint)

        // Get the major id or id + token for this route - global otherwise
        const majorId = majorIdMatch?.[2] ?? majorIdMatch?.[1] ?? 'global'

        const baseRoute = endpoint
            // Strip out all ids
            .replaceAll(/\d{17,19}/g, ':id')
            // Strip out reaction as they fall under the same bucket
            .replace(/\/reactions\/(.*)/, '/reactions/:reaction')
            // Strip out webhook tokens
            .replace(/\/webhooks\/:id\/[^/?]+/, '/webhooks/:id/:token')

        let exceptions = ''

        // Hard-Code Old Message Deletion Exception (2 week+ old messages are a different bucket)
        // https://github.com/discord/discord-api-docs/issues/1295
        if (method === RequestMethod.Delete && baseRoute === '/channels/:id/messages/:id') {
            const id = /\d{17,19}$/.exec(endpoint)![0]!
            const timestamp = SnowflakeUtil.timestampFrom(id)
            if (Date.now() - timestamp > 1_000 * 60 * 60 * 24 * 14) {
                exceptions += '/Delete Old Message'
            }
        }

        return {
            majorParameter: majorId,
            bucketRoute: baseRoute + exceptions,
            original: endpoint
        }
    }
}

/**
 * Performs the actual network request for a request handler
 *
 * @param manager - The manager that holds options and emits informational events
 * @param routeId - The generalized api route with literal ids for major parameters
 * @param url - The fully resolved url to make the request to
 * @param options - The fetch options needed to make the request
 * @param requestData - Extra data from the user's request needed for errors and additional processing
 * @param retries - The number of retries this request has already attempted (recursion occurs on the handler)
 * @returns The respond from the network or `null` when the request should be retried
 * @internal
 */
export async function makeNetworkRequest(
    manager: RequestManager,
    routeId: RouteData,
    url: string,
    options: RequestInit,
    requestData: HandlerRequestData,
    retries: number
) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), manager.options.timeout)
    if (requestData.signal) {
        // If the user signal was aborted, abort the controller, else abort the local signal.
        // The reason why we don't re-use the user's signal, is because users may use the same signal for multiple
        // requests, and we do not want to cause unexpected side-effects.
        if (requestData.signal.aborted) controller.abort()
        else requestData.signal.addEventListener('abort', () => controller.abort())
    }

    let res: ResponseLike
    try {
        res = await manager.options.makeRequest(url, { ...options, signal: controller.signal })
    } catch (error: unknown) {
        if (!(error instanceof Error)) throw error
        // Retry the specified number of times if needed
        if (shouldRetry(error) && retries !== manager.options.retries) {
            // Retry is handled by the handler upon receiving null
            return null
        }

        throw error
    } finally {
        clearTimeout(timeout)
    }

    if (manager.listenerCount(RMEvents.Response)) {
        manager.emit(
            RMEvents.Response,
            {
                method: options.method ?? 'get',
                path: routeId.original,
                route: routeId.bucketRoute,
                options,
                data: requestData,
                retries
            },
            res instanceof Response ? (res.clone() as any) : { ...res }
        )
    }

    return res
}

/**
 * Check whether an error indicates that a retry can be attempted
 *
 * @param error - The error thrown by the network request
 * @returns Whether the error indicates a retry should be attempted
 */
export function shouldRetry(error: Error | NodeJS.ErrnoException) {
    // Retry for possible timed out requests
    if (error.name === 'AbortError') return true
    // Downlevel ECONNRESET to retry as it may be recoverable
    return ('code' in error && error.code === 'ECONNRESET') || error.message.includes('ECONNRESET')
}

/**
 * Handles 5xx and 4xx errors (not 429's) conventionally. 429's should be handled before calling this function
 *
 * @param manager - The manager that holds options and emits informational events
 * @param res - The response received from {@link makeNetworkRequest}
 * @param method - The method used to make the request
 * @param url - The fully resolved url to make the request to
 * @param requestData - Extra data from the user's request needed for errors and additional processing
 * @param retries - The number of retries this request has already attempted (recursion occurs on the handler)
 * @returns The response if the status code is not handled or null to request a retry
 */
export async function handleErrors(
    manager: RequestManager,
    res: ResponseLike,
    method: string,
    url: string,
    requestData: HandlerRequestData,
    retries: number
) {
    const status = res.status
    if (status >= 500 && status < 600) {
        // Retry the specified number of times for possible server side issues
        if (retries !== manager.options.retries) {
            return null
        }

        // We are out of retries, throw an error
        throw new HTTPError(status, res.statusText, method, url, requestData)
    } else {
        // Handle possible malformed requests
        if (status >= 400 && status < 500) {
            // If we receive this status code, it means the token we had is no longer valid.
            if (status === 401 && requestData.auth) {
                manager.setToken(null!)
            }

            // The request will not succeed for some reason, parse the error returned from the api
            const data = (await parseResponse(res)) as DiscordErrorData | OAuthErrorData
            // throw the API error
            throw new DiscordAPIError(data, 'code' in data ? data.code : data.error, status, method, url, requestData)
        }

        return res
    }
}

/**
 * Increment the invalid request count and emit warning if necessary
 */
export function incrementInvalidCount(manager: RequestManager) {
    if (!invalidCountResetTime || invalidCountResetTime < Date.now()) {
        invalidCountResetTime = Date.now() + 1_000 * 60 * 10
        invalidCount = 0
    }

    invalidCount++

    const emitInvalid =
        manager.options.invalidRequestWarningInterval > 0 &&
        invalidCount % manager.options.invalidRequestWarningInterval === 0
    if (emitInvalid) {
        // Let library users know periodically about invalid requests
        manager.emit(RMEvents.InvalidRequestWarning, {
            count: invalidCount,
            remainingTime: invalidCountResetTime - Date.now()
        })
    }
}

export interface RequestManagerEvents {
    debug: [info: string]
    invalidRequestWarning: [invalidRequestInfo: InvalidRequestWarningData]
    rateLimited: [rateLimitInfo: RateLimitData]
    response: [request: APIRequest, response: ResponseLike]
}

export enum RMEvents {
    Debug = 'debug',
    InvalidRequestWarning = 'invalidRequestWarning',
    RateLimited = 'rateLimited',
    Response = 'response'
}

export interface RequestManagerOptions extends RESTOptions {
    store?: KeyvStoreAdapter
    storeSerialize?: typeof JSONBI.stringify
    storeDeserialize?: typeof JSONBI.parse
}

export interface RequestManagerHashData {
    lastAccess: number
    value: string
}

export interface RequestManagerHandlerData {
    id: string
    reset?: number
    remaining?: number
    limit?: number
}
