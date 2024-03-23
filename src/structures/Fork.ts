import { ChildProcess, ForkOptions, fork } from 'child_process'
import { IPCRawMessage } from '../ipc/IPCMessage'

export class Fork {
    public process: ChildProcess | null = null

    constructor(public file: string, public args: string[], public options: ForkOptions) {}

    /**
     * Spawns the child process.
     */
    public spawn(): ChildProcess {
        return (this.process = fork(this.file, this.args, this.options))
    }

    /**
     * Kills the child process.
     */
    public kill(): boolean {
        this.process?.removeAllListeners?.()
        return this.process?.kill?.() ?? false
    }

    /**
     * Respawns the child process.
     */
    public respawn(): ChildProcess {
        this.kill()
        return this.spawn()
    }

    /**
     * Sends a message to the child process.
     * @param message IPC message.
     */
    public send(message: IPCRawMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            this.process?.send?.(message, err => (err ? reject(err) : resolve()))
        })
    }
}
