import { Client, ClientOptions, REST } from 'discord.js'
import { RequestManager, RequestManagerOptions } from '../rest/RequestManager'
import { ClusterShard } from './ClusterShard'

export class ClusterShardClient extends Client {
    /**
     * The instance of cluster shard.
     */
    public cluster: ClusterShard<this>

    // @ts-ignore
    public declare rest: RequestManager | REST

    constructor(options: ClusterShardClientOptions) {
        const info = ClusterShard.getInfo()

        super({
            ...options,
            shardCount: info.shardCount,
            shards: info.shards
        })

        this.cluster = new ClusterShard(this)

        if (typeof options.rest?.store !== 'undefined') {
            this.rest = new RequestManager(options.rest)
        } else {
            this.rest = new REST(options.rest)
        }
    }
}

export interface ClusterShardClientOptions extends ClientOptions {
    rest?: Partial<RequestManagerOptions>
}
