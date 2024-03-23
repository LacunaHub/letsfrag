import { Worker, WorkerOptions } from 'worker_threads'
import { IPCRawMessage } from '../ipc/IPCMessage'

export class Thread {
    public process: Worker

    constructor(public file: string, public options: WorkerOptions) {}

    /**
     * Spawns the worker.
     */
    public spawn(): Worker {
        return (this.process = new Worker(this.file, this.options))
    }

    /**
     * Kills the worker.
     */
    public kill(): boolean {
        this.process?.removeAllListeners?.()
        return !!this.process?.terminate?.()
    }

    /**
     * Respawns the worker.
     */
    public respawn(): Worker {
        this.kill()
        return this.spawn()
    }

    /**
     * Sends a message to the worker.
     * @param message IPC message.
     */
    public send(message: IPCRawMessage): Promise<void> {
        return new Promise<void>(resolve => {
            this.process?.postMessage?.(message)
            resolve()
        })
    }
}
