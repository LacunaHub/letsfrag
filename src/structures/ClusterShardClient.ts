import { ClientOptions, Client as DJSClient } from 'discord.js'
import { ClusterShard } from './ClusterShard'

export class ClusterShardClient extends DJSClient {
    /**
     * The instance of cluster shard.
     */
    public cluster: ClusterShard<this>

    constructor(options: ClientOptions) {
        const info = ClusterShard.getInfo()

        super({
            ...options,
            shardCount: info.shardCount,
            shards: info.shards
        })

        this.cluster = new ClusterShard(this)
    }
}
