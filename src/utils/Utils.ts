export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function generateId(length: number = 10): string {
    if (typeof length !== 'number') length = 4
    if (length < 4) length = 4
    if (length > 11) length = 11

    return `${Math.random().toString(36).substring(2, length)}`
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
