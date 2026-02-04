import { sleep } from '../utils/Utils'

/**
 * Queue for managing spawning of clusters with delays.
 */
export class SpawnQueue {
    private readonly items: SpawnQueueItem[] = []

    /**
     * Whether the queue is paused.
     */
    public state: SpawnQueueState = SpawnQueueState.Empty

    public get paused(): boolean {
        return this.state === SpawnQueueState.Paused
    }

    /**
     * @param options - Queue configuration options
     */
    constructor(public readonly options: SpawnQueueOptions = {}) {}

    /**
     * Adds an item to the queue.
     * @param item - The item to add
     * @returns This queue instance
     */
    public add(item: Omit<SpawnQueueItem, 'addedAt' | 'delay'> & { delay?: number }): this {
        const queueItem: SpawnQueueItem = {
            run: item.run,
            args: item.args,
            addedAt: Date.now(),
            delay: item.delay ?? this.options.delay ?? 0
        }

        this.items.push(queueItem)
        return this
    }

    /**
     * Starts processing the queue.
     * @returns Promise that resolves when all items are processed
     */
    public async start(): Promise<this> {
        this.state = SpawnQueueState.Running

        while (this.items.length > 0) {
            const delay = this.items[0].delay

            await this.next()
            if (delay && !this.paused) await sleep(delay)
        }

        this.state = SpawnQueueState.Empty
        return this
    }

    /**
     * Pauses the queue.
     * @returns This queue instance
     */
    public pause(): this {
        this.state = SpawnQueueState.Paused
        return this
    }

    /**
     * Processes the next item in the queue.
     * @returns Promise that resolves with the result of the item's run function
     */
    public async next(): Promise<unknown> {
        if (this.paused) return null

        const item = this.items.shift()
        return item ? item.run(...item.args) : null
    }

    public clear() {
        this.pause()
        this.items.splice(0, this.items.length)
        this.state = SpawnQueueState.Empty
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
    addedAt: number

    /**
     * Delay in milliseconds before processing the next item.
     */
    delay: number
}

/**
 * Configuration options for SpawnQueue.
 */
export interface SpawnQueueOptions {
    /**
     * Default delay in milliseconds between processing items.
     */
    delay?: number
}

export enum SpawnQueueState {
    Running = 1,
    Paused,
    Empty
}
