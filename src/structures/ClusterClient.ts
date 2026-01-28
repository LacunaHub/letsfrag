import { Client, ClientOptions } from 'discord.js'
import { ClusterContext } from './ClusterContext'

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
export class ClusterClient extends Client {
    /**
     * The cluster shard instance managing IPC communication and cluster operations.
     */
    public readonly cluster: ClusterContext<this>

    /**
     * @param options - Discord.js client options
     */
    constructor(options: ClientOptions) {
        const info = ClusterContext.getInfo()

        super({
            ...options,
            shardCount: info.shardCount,
            shards: info.shardsList
        })

        this.cluster = new ClusterContext(this)
    }
}
