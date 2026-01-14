export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function chunkArray(array: any[], length: number = 10): any[] {
    if (!Array.isArray(array)) array = []
    if (typeof length !== 'number') length = 10

    const arr = []

    for (let i = 0; i < array.length; i += length) {
        arr.push(array.slice(i, i + length))
    }

    return arr
}

/**
 * Serializes script to string format.
 * @param script - Script to serialize
 * @param context - Context to pass to the script
 * @returns Serialized script
 */
export function serializeScript(script: string | Function, context?: any): string {
    return typeof script === 'function' ? `(${script})(this,${JSON.stringify(context)})` : script
}

export interface DebugMessage {
    from: string
    data: any
}
