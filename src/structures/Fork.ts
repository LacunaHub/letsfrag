import { ChildProcess, ForkOptions, fork } from 'child_process'
import { IPCMessage } from './IPCMessage'

/**
 * Wrapper for managing a forked child process.
 */
export class Fork {
    /**
     * The child process instance.
     */
    public process?: ChildProcess

    /**
     * @param file - Path to the file to execute in the child process
     * @param args - Arguments to pass to the child process
     * @param options - Node.js fork options
     */
    constructor(public readonly file: string, public readonly args: string[], public readonly options: ForkOptions) {}

    /**
     * Spawns the child process.
     * @returns The spawned child process
     */
    public spawn(): ChildProcess {
        if (this.process) this.kill()
        return (this.process = fork(this.file, this.args, this.options))
    }

    /**
     * Kills the child process.
     */
    public kill(): void {
        this.process?.removeAllListeners()
        this.process?.kill()
        this.process = null
    }

    /**
     * Respawns the child process.
     * @returns The new child process instance
     */
    public respawn(): ChildProcess {
        this.kill()
        return this.spawn()
    }

    /**
     * Sends a message to the child process.
     * @param message - IPC message to send
     * @returns Promise that resolves when the message is sent
     */
    public send(message: IPCMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            this.process?.send(message, (err: Error | null) => (err ? reject(err) : resolve()))
        })
    }
}
