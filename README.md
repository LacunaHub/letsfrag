# About

Distributed sharding library for Discord.js bots with automatic shard assignment and rebalancing. This package is inspired by [discord-hybrid-sharding](https://github.com/meister03/discord-hybrid-sharding).

## Architecture Overview

```mermaid
flowchart TD
    Redis[(Redis)]
    ClusterBroker((ClusterBroker))
    BrokerClient([BrokerClient])
    ClusterManager{ClusterManager}
    Cluster0(Cluster)
    Cluster1(Cluster)
    Client0{{Client}}
    Client1{{Client}}
    Client2{{Client}}
    Client3{{Client}}

    Redis <-->|"PubSub"| ClusterBroker
    Redis <-->|"PubSub"| BrokerClient
    BrokerClient <--> ClusterManager
    ClusterManager <--> Cluster0
    ClusterManager <--> Cluster1
    Cluster0 <-->|"IPC"| Client0
    Cluster0 <-->|"IPC"| Client1
    Cluster1 <-->|"IPC"| Client2
    Cluster1 <-->|"IPC"| Client3
```

### How It Works

1. **ClusterBroker** manages shard distribution
2. Each **ClusterManager** connects to the **ClusterBroker** via **BrokerClient** and spawns assigned shards
3. All communication between **ClusterBroker** and **BrokerClient** happens through **Redis PubSub** channels

## Key Features

- **Redis PubSub**: Fast, reliable inter-process communication using Redis
- **Distributed architecture**: Scale across unlimited hosts/machines
- **Automatic shard distribution**: ClusterBroker automatically assigns shards to available cluster managers
- **Health monitoring**: Automatic respawn of dead shards
- **Hot reload**: Add or remove managers without restarting the entire system
- **Type-Safe**: Full TypeScript support with proper typings

# Links

- [API Docs](https://lacunahub.github.io/letsfrag)

# Installation

## Using NPM Registry

```bash
npm install @lacunahub/letsfrag
```

## Using GitHub Packages Registry

1. Create a [GitHub Personal Access Token](https://github.com/settings/tokens/new) with `read:packages` scope

2. Add to your shell profile (`.bashrc`, `.zshrc`, or `.profile`):

```bash
export GITHUB_TOKEN=your_token_here
```

3. In your project directory, create `.npmrc`:

```
@lacunahub:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

4. Install:

```bash
npm install @lacunahub/letsfrag
```

### Alternative: npm login

Authenticate once with GitHub Packages:

```bash
npm login --registry=https://npm.pkg.github.com --scope=@lacunahub
# Username: your-github-username
# Password: your-personal-access-token (with read:packages scope)
# Email: your-email
```

Then install normally:

```bash
npm install @lacunahub/letsfrag
```

See [Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) for more information.

# Usage

## Prerequisites

You need a Redis server running. You can use Docker:

```bash
docker run -d -p 6379:6379 redis:latest
```

## File structure

```
├── src
│   ├── client.ts
│   ├── cluster.ts
│   └── broker.ts
└── package.json
```

```ts
import { ClusterBroker } from '@lacunahub/letsfrag'

const broker = new ClusterBroker({
    redisURI: 'redis://localhost:6379',
    botToken: process.env.BOT_TOKEN
})

broker.on('ready', () => console.info('ClusterBroker is ready'))
broker.on('error', err => console.error(err))
broker.on('clientConnect', client => console.info(`Client "${client.id}" connected`))

broker.initialize()
```

`src/cluster.ts`

```ts
import { ClusterManager } from '@lacunahub/letsfrag'

const clusterManager = new ClusterManager(`${__dirname}/client.js`, {
    brokerClient: {
        redisURI: 'redis://localhost:6379'
    }
})

clusterManager.on('ready', manager => console.info(`Manager with clusters (${manager.clusters}) is ready`))
clusterManager.on('clusterCreate', cluster => console.info(`Cluster #${cluster.id} has been created`))

clusterManager.register()
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

_**Note**: The ClusterBroker must be started before `ClusterManager` is initialized on each host._

# License

This project is licensed under the [MIT License](./LICENSE).
