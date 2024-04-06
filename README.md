# About

This package is inspired by [discord-hybrid-sharding](https://github.com/meister03/discord-hybrid-sharding) and allows you to scale your Discord bot across multiple hosts/machines.

# Links

-   [Documentation](https://lacunahub.github.io/letsfrag)

# Installation

In the same directory as your `package.json` file, create or edit an `.npmrc` file:

```
@lacunahub:registry=https://npm.pkg.github.com/
```

Then run:

```bash
npm install @lacunahub/letsfrag
```

_Developed and tested on Node.js v18_

# Usage

## File structure

```
├── src
│   ├── client.ts
│   ├── cluster.ts
│   └── server.ts
└── package.json
```

`src/server.ts`

```ts
import { Server } from '@lacunahub/letsfrag'

const server = new Server({
    port: 5565,
    authorization: 'authorization_token',
    hostCount: 2,
    shardCount: 10,
    botToken: 'bot_token'
})

server.on('connect', client => console.info(`Client "${client.id}" connected`))
server.on('disconnect', client => console.warn(`Client "${client.id}" disconnected`))
server.on('error', err => console.error(err))
server.on('ready', url => console.info(`Server is ready on url ${url}`))

server.initialize()
```

`src/cluster.ts`

```ts
import { ClusterManager } from '@lacunahub/letsfrag'

const clusterManager = new ClusterManager(`${__dirname}/Client.js`, {
    server: {
        host: 'localhost',
        port: 5565,
        authorization: 'authorization_token',
        type: 'bot',
        reconnect: true,
        retries: 10
    },
    mode: 'fork',
    spawnDelay: 10_000
})

clusterManager.on('clusterCreate', cluster => console.info(`Cluster #${cluster.id} has been created`))
clusterManager.on('ready', manager => console.info(`Manager with clusters (${manager.clusters}) is ready`))

clusterManager.spawn()
```

`src/client.ts`

```ts
import { ClusterShardClient } from '@lacunahub/letsfrag'
import { GatewayIntentBits } from 'discord.js'

const client = new ClusterShardClient({
    intents: [GatewayIntentBits.Guilds]
})

client.login()
```

_**Note**: The server must be started before `ClusterManager` is initialized._

### Rate limit sync

You can enable rate limit sync between shards/hosts by setting the `store` option in the `rest` object:

`src/client.ts`

```ts
import { ClusterShardClient } from '@lacunahub/letsfrag'
import { GatewayIntentBits } from 'discord.js'

const client = new ClusterShardClient({
    intents: [GatewayIntentBits.Guilds],
    rest: {
        store: 'redis://user:pass@127.0.0.1:6379'
    }
})

client.login()
```

See [Keyv](https://www.npmjs.com/package/keyv?activeTab=readme#usage) for more details.
