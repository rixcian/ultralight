import { distance } from '@chainsafe/discv5'
import { bigIntToHex, hexToBytes, padToEven } from '@ethereumjs/util'
import { MemoryLevel } from 'memory-level'

import { fromHexString, serializedContentKeyToContentId } from '../index.js'

import type { NetworkId } from '../index.js'
import type { NodeId } from '@chainsafe/enr'
import type { AbstractBatchOperation, AbstractLevel } from 'abstract-level'
import type { Debugger } from 'debug'

export class DBManager {
  nodeId: string
  db: AbstractLevel<string, string>
  logger: Debugger
  currentSize: () => Promise<number>
  sublevels: Map<NetworkId, AbstractLevel<string, string>>
  streaming: Set<string>
  constructor(
    nodeId: NodeId,
    logger: Debugger,
    currentSize: () => Promise<number>,
    sublevels: NetworkId[] = [],
    db?: AbstractLevel<string>,
  ) {
    //@ts-ignore Because level doesn't know how to get along with itself
    this.db = db ?? new MemoryLevel()
    this.nodeId = nodeId.startsWith('0x') ? nodeId.slice(2) : nodeId
    this.logger = logger.extend('DB')
    this.currentSize = currentSize
    this.sublevels = new Map()
    this.streaming = new Set()
    for (const network of sublevels) {
      const sub = this.db.sublevel(network)
      this.sublevels.set(network, sub)
    }
  }

  addToStreaming(key: string) {
    this.logger(`Adding ${key} to streaming`)
    this.streaming.add(key)
  }

  async get(network: NetworkId, key: string) {
    // this.streaming is a Set of contentKeys currently streaming over uTP
    // the timeout is a safety measure to prevent the while loop from running indefinitely in case of a uTP stream failure
    this.logger(`Content ${key}.  Streaming=${this.streaming.has(key)}`)
    const timeout = setTimeout(() => {
      this.streaming.delete(key)
    }, 1000)
    while (this.streaming.has(key)) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const db = this.sublevel(network)
    const databaseKey = this.databaseKey(key)
    this.logger(`Getting ${key} from DB. dbKey: ${databaseKey}`)
    const val = await db.get(databaseKey)
    this.logger(
      `Got ${key} from DB with key: ${databaseKey}.  Size=${
        fromHexString(padToEven(val)).length
      } bytes`,
    )
    clearTimeout(timeout)
    return val
  }

  put(network: NetworkId, key: string, val: string) {
    const db = this.sublevel(network)
    const databaseKey = this.databaseKey(key)
    db.put(databaseKey, val, (err: any) => {
      if (err !== undefined) this.logger(`Error putting content in history DB: ${err.toString()}`)
    })
    this.streaming.delete(key)
    this.logger(
      `Put ${key} in DB as ${databaseKey}.  Size=${fromHexString(padToEven(val)).length} bytes`,
    )
  }

  async storeBlockIndex(blockIndex: Map<string, string>) {
    return this.db.put('block_index', JSON.stringify(Array.from(blockIndex.entries())))
  }

  async getBlockIndex(): Promise<Map<string, string>> {
    try {
      return new Map(JSON.parse(await this.db.get('block_index')))
    } catch {
      return new Map()
    }
  }

  batch(ops: AbstractBatchOperation<string, string, string>[], sublevel?: NetworkId) {
    const db = sublevel ? this.sublevels.get(sublevel) ?? this.db : this.db
    return (db as any).batch(ops)
  }

  del(network: NetworkId, key: string) {
    const db = this.sublevel(network)
    const databaseKey = this.databaseKey(key)
    return db.del(databaseKey)
  }
  databaseKey(key: string) {
    const contentId = serializedContentKeyToContentId(hexToBytes(key))
    const d = BigInt.asUintN(32, distance(contentId.slice(2), this.nodeId))
    return bigIntToHex(d)
  }

  sublevel(network: NetworkId) {
    return this.sublevels.get(network)!
  }

  async prune(sublevel: NetworkId, radius: bigint) {
    const db = this.sublevels.get(sublevel)
    if (!db) return
    for await (const key of db.keys({ gte: bigIntToHex(radius) })) {
      await db.del(key)
    }
  }

  async open() {
    await this.db.open()
    for (const sublevel of this.sublevels.values()) {
      await sublevel.open()
    }
  }

  async close() {
    this.db.removeAllListeners()
    await this.db.close()
  }

  async closeAll() {
    await this.close()
  }
}
