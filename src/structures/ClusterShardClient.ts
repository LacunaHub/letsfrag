import { Client, ClientOptions } from 'discord.js'
import { RequestManager, RequestManagerOptions } from '../rest/RequestManager'
import { ClusterShard } from './ClusterShard'

export class ClusterShardClient extends Client {
    /**
     * The instance of cluster shard.
     */
    public cluster: ClusterShard<this>

    // @ts-ignore
    public declare rest: RequestManager

    constructor(options: ClusterShardClientOptions) {
        const info = ClusterShard.getInfo()

        super({
            ...options,
            shardCount: info.shardCount,
            shards: info.shards
        })

        this.cluster = new ClusterShard(this)
        this.rest = new RequestManager(options.rest)
    }
}

export interface ClusterShardClientOptions extends ClientOptions {
    rest?: Partial<RequestManagerOptions>
}
