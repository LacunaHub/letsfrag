import { sleep } from '../utils/Utils'

export class SpawnQueue {
    public paused: boolean = false

    private items: SpawnQueueItem[] = []

    constructor(public options: SpawnQueueOptions = {}) {}

    public async start(): Promise<this> {
        if (this.options.auto) {
            return new Promise(resolve => {
                const interval = setInterval(() => {
                    if (this.items.length === 0) {
                        clearInterval(interval)
                        resolve(this)
                    }
                }, 200)
            })
        }

        const length = this.items.length

        for (let i = 0; i < length; i++) {
            if (!this.items[0]) continue

            const timeout = this.items[0].timeout

            await this.next()
            await sleep(timeout)
        }

        return this
    }

    public async next(): Promise<unknown> {
        if (this.paused) return

        const item = this.items.shift()

        return item && item.run(item)
    }

    public stop(): this {
        this.paused = true
        return this
    }

    public resume(): this {
        this.paused = false
        return this
    }

    public add(item: SpawnQueueItem): this {
        this.items.push({
            run: item.run,
            args: item.args,
            time: Date.now(),
            timeout: item.timeout ?? this.options.timeout
        })

        return this
    }
}

export interface SpawnQueueItem {
    run(...args: any[]): Promise<unknown>

    args: any[]

    time?: number

    timeout: number
}

export interface SpawnQueueOptions {
    auto?: boolean

    timeout?: number
}
