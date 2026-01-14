import { Client, ClientOptions } from 'discord.js'
import { ClusterShard } from './ClusterShard'

/**
 * Extended Discord.js Client with built-in cluster shard management.
 * This client automatically configures sharding based on environment variables
 * and provides IPC communication with the parent ClusterManager.
 *
 * @example
 * ```typescript
 * import { ClusterShardClient } from '@lacunahub/letsfrag'
 * import { GatewayIntentBits } from 'discord.js'
 *
 * const client = new ClusterShardClient({
 *     intents: [GatewayIntentBits.Guilds]
 * })
 *
 * client.login('your_token')
 * ```
 */
export class ClusterShardClient extends Client {
    /**
     * The cluster shard instance managing IPC communication and cluster operations.
     */
    public clusterShard: ClusterShard<this>

    /**
     * @param options - Discord.js client options
     */
    constructor(options: ClientOptions) {
        const info = ClusterShard.getInfo()

        super({
            ...options,
            shardCount: info.shardCount,
            shards: info.shards
        })

        this.clusterShard = new ClusterShard(this)
    }
}
