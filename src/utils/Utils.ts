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

/**
 * Creates a debounced function that delays invoking the provided function
 * until after the specified delay has elapsed since the last call.
 *
 * @param fn - The function to debounce
 * @param delay - The delay in milliseconds
 * @returns Debounced function with cancel, flush, and pending methods
 *
 * @example
 * ```typescript
 * const debouncedSave = debounce((data: string) => {
 *     console.log('Saving:', data)
 * }, 1000)
 *
 * debouncedSave('first')
 * debouncedSave('second')  // Only this will execute after 1s
 *
 * debouncedSave.cancel()   // Cancel pending execution
 * debouncedSave.flush()    // Execute immediately
 * debouncedSave.pending()  // Check if there's a pending execution
 * ```
 */
export function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): DebouncedFunction<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let lastArgs: Parameters<T> | null = null

    const debounced = (...args: Parameters<T>): void => {
        lastArgs = args

        if (timeoutId) {
            clearTimeout(timeoutId)
        }

        timeoutId = setTimeout(() => {
            timeoutId = null
            fn(...lastArgs!)
            lastArgs = null
        }, delay)
    }

    debounced.cancel = (): void => {
        if (timeoutId) {
            clearTimeout(timeoutId)
            timeoutId = null
            lastArgs = null
        }
    }

    debounced.flush = (): void => {
        if (timeoutId && lastArgs) {
            clearTimeout(timeoutId)
            timeoutId = null
            fn(...lastArgs)
            lastArgs = null
        }
    }

    debounced.pending = (): boolean => {
        return timeoutId !== null
    }

    return debounced
}

export interface DebouncedFunction<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): void
    cancel: () => void
    flush: () => void
    pending: () => boolean
}
