import { parentPort, workerData } from 'worker_threads'
import { IPCRawMessage } from '../ipc/IPCMessage'

export class ThreadClient {
    public ipc = parentPort

    /**
     * Worker environment.
     */
    public get data(): typeof workerData {
        return workerData
    }

    /**
     * Sends a message to the worker.
     * @param message IPC message.
     */
    public send(message: IPCRawMessage): Promise<void> {
        return new Promise<void>(resolve => {
            this.ipc?.postMessage?.(message)
            resolve()
        })
    }
}
