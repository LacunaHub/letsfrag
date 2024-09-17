import { DefaultRestOptions } from 'discord.js'
import JSONBI from 'json-bigint'
import { RequestManagerOptions } from '../rest/RequestManager'

export const DefaultRequestManagerOptions: RequestManagerOptions = {
    ...DefaultRestOptions,
    storeSerialize: JSONBI.stringify,
    storeDeserialize: JSONBI.parse
}
