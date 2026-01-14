import { sleep } from '../utils/Utils'

/**
 * Queue for managing spawning of clusters with delays.
 */
export class SpawnQueue {
    /**
     * Whether the queue is paused.
     */
    public paused: boolean = false

    private readonly items: SpawnQueueItem[] = []

    /**
     * @param options - Queue configuration options
     */
    constructor(public options: SpawnQueueOptions = {}) {}

    /**
     * Adds an item to the queue.
     * @param item - The item to add
     * @returns This queue instance
     */
    public add(item: SpawnQueueItem): this {
        const queueItem: SpawnQueueItem = {
            run: item.run,
            args: item.args,
            time: Date.now(),
            timeout: item.timeout ?? this.options.timeout ?? 0
        }

        this.items.push(queueItem)
        return this
    }

    /**
     * Processes the next item in the queue.
     * @returns Promise that resolves with the result of the item's run function
     */
    public async next(): Promise<unknown> {
        if (this.paused) return undefined

        const item = this.items.shift()
        return item ? item.run(item) : undefined
    }

    /**
     * Starts processing the queue.
     * @returns Promise that resolves when all items are processed
     */
    public start(): Promise<this> {
        if (this.options.auto) return this.waitForCompletion()
        return this.processItems()
    }

    /**
     * Pauses the queue.
     * @returns This queue instance
     */
    public stop(): this {
        this.paused = true
        return this
    }

    /**
     * Resumes the queue.
     * @returns This queue instance
     */
    public resume(): this {
        this.paused = false
        return this
    }

    /**
     * Waits for the queue to be empty in auto mode.
     * @returns Promise that resolves when the queue is empty
     */
    private waitForCompletion(): Promise<this> {
        return new Promise(resolve => {
            const interval = setInterval(() => {
                if (this.items.length === 0) {
                    clearInterval(interval)
                    resolve(this)
                }
            }, 200)
        })
    }

    /**
     * Processes all items in the queue sequentially.
     * @returns Promise that resolves when all items are processed
     */
    private async processItems(): Promise<this> {
        while (this.items.length > 0) {
            const timeout = this.items[0]?.timeout

            await this.next()
            if (timeout) await sleep(timeout)
        }

        return this
    }
}

/**
 * Represents an item in the spawn queue.
 */
export interface SpawnQueueItem {
    /**
     * Function to execute when the item is processed.
     */
    run(...args: any[]): Promise<unknown>

    /**
     * Arguments to pass to the run function.
     */
    args: any[]

    /**
     * Timestamp when the item was added.
     */
    time?: number

    /**
     * Delay in milliseconds before processing the next item.
     */
    timeout: number
}

/**
 * Configuration options for SpawnQueue.
 */
export interface SpawnQueueOptions {
    /**
     * Whether to automatically process items as they are added.
     */
    auto?: boolean

    /**
     * Default timeout in milliseconds between processing items.
     */
    timeout?: number
}
