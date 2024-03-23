import { IPCRawMessage } from '../ipc/IPCMessage'

export class ForkClient {
    public ipc = process

    /**
     * Process environment.
     */
    public get data(): NodeJS.ProcessEnv {
        return this.ipc.env
    }

    /**
     * Sends a message to the child process.
     * @param message IPC message.
     */
    public send(message: IPCRawMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ipc?.send?.(message, (err: Error) => (err ? reject(err) : resolve()))
        })
    }
}
