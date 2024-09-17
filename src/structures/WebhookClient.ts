import {
    WebhookClient as DJSWebhookClient,
    WebhookClientData as DJSWebhookClientData,
    WebhookClientOptions as DJSWebhookClientOptions
} from 'discord.js'
import { RequestManager, RequestManagerOptions } from '../rest/RequestManager'

export class WebhookClient extends DJSWebhookClient {
    // @ts-ignore
    public declare rest: RequestManager

    constructor(data: DJSWebhookClientData, options?: WebhookClientOptions) {
        super(data, options)

        this.rest = new RequestManager(options.rest)
    }
}

export interface WebhookClientOptions extends DJSWebhookClientOptions {
    rest?: Partial<RequestManagerOptions>
}
