import { makePlainError } from 'discord.js'
import { RespawnOptions } from '../managers/ClusterManager'
import { Cluster } from '../structures/Cluster'
import { ClusterShard } from '../structures/ClusterShard'
import { IPCBaseMessage, IPCMessageType, IPCRawMessage } from './IPCMessage'

export class IPCHandler<T extends Cluster | ClusterShard> {
    constructor(public instance: T) {}

    public async handleMessage(message: IPCRawMessage): Promise<void> {
        const baseMessage = new IPCBaseMessage(message)
        if (this.instance instanceof Cluster) {
            if (message.type === IPCMessageType.ClusterManagerBroadcast) {
                await this.instance.manager.broadcast(message.data.message)
            } else if (message.type === IPCMessageType.ClusterManagerBroadcastEval) {
                try {
                    const { script, options } = message.data,
                        results = await this.instance.manager.broadcastEval(script, options)

                    await this.instance.cp.send({
                        ...new IPCBaseMessage({
                            nonce: message.nonce,
                            type: IPCMessageType.ClusterManagerBroadcastResponse,
                            data: results
                        })
                    })
                } catch (err) {
                    await this.instance.cp.send({
                        ...new IPCBaseMessage({
                            nonce: message.nonce,
                            type: IPCMessageType.ClusterManagerBroadcastResponse,
                            error: makePlainError(err)
                        })
                    })
                }
            } else if (message.type === IPCMessageType.ClusterShardEvalResponse) {
                this.instance.manager.promises.resolveMessage(baseMessage)
            } else if (message.type === IPCMessageType.ClusterReady) {
                this.instance.readyAt = Date.now()
                this.instance.emit('ready')

                if (this.instance.manager.cache.size === this.instance.manager.options.clusterCount) {
                    this.instance.manager.readyAt = Date.now()
                    this.instance.manager.emit('ready')
                }
            } else if (message.type === IPCMessageType.ClusterRespawn) {
                const { spawnDelay, spawnTimeout } = message.data

                await this.instance.respawn(spawnDelay, spawnTimeout)
            } else if (message.type === IPCMessageType.ClusterManagerRespawnClusters) {
                const { spawnDelay, shardSpawnDelay, shardSpawnTimeout } = message.data as RespawnOptions

                await this.instance.manager.respawnClusters({ spawnDelay, shardSpawnDelay, shardSpawnTimeout })
            } else if (message.type === IPCMessageType.ClusterManagerSpawnNextCluster) {
                await this.instance.manager.spawnQueue.next()
            }
        } else {
            if (message.type === IPCMessageType.ClusterManagerBroadcastResponse) {
                this.instance.promises.resolveMessage(baseMessage)
            } else if (message.type === IPCMessageType.ClusterShardEval) {
                const { script } = message.data

                try {
                    const result = await this.instance.eval(script)

                    await this.instance.respond({
                        ...new IPCBaseMessage({
                            nonce: message.nonce,
                            type: IPCMessageType.ClusterShardEvalResponse,
                            data: result
                        })
                    })
                } catch (err) {
                    await this.instance.respond({
                        ...new IPCBaseMessage({
                            nonce: message.nonce,
                            type: IPCMessageType.ClusterShardEvalResponse,
                            error: makePlainError(err)
                        })
                    })
                }
            }
        }
    }
}
