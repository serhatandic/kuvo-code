// Antigravity's conversation accounting, as UsageKit's AntigravityDbUsageScanner and protobuf
// decoder. Only the caller's own agent home is inspected. SQLite stays in a read-only worker;
// an unreadable database keeps its own last answer while the other databases keep advancing.
import { readdirSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { add, addUnknown, noSlots, slotOf, type Slots } from "./history"
import type { Pricing } from "./pricing"

export const MAXIMUM_BLOB_BYTES = 1_048_576
export const ANTIGRAVITY_BATCH_SIZE = 8
export interface AntigravityEvent {
  modelID?: string
  label?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  timestampSeconds: number
}

/** Self-contained so this exact decoder also runs inside the SQLite worker. */
export function generationEvent(blob: Uint8Array, stepMetadata?: Uint8Array): AntigravityEvent | undefined {
  function varint(bytes: Uint8Array, start: number): { value: bigint; next: number } | undefined {
    let value = 0n
    for (let i = 0; i < 10; i++) {
      const byte = bytes[start + i]
      if (byte === undefined || (i === 9 && (byte & 127) > 1)) return undefined
      value |= BigInt(byte & 127) << BigInt(i * 7)
      if (!(byte & 128)) return { value, next: start + i + 1 }
    }
    return undefined
  }
  function field(bytes: Uint8Array, wanted: number): bigint | Uint8Array | undefined {
    let offset = 0
    while (offset < bytes.length) {
      const tag = varint(bytes, offset)
      if (!tag || tag.value >> 3n === 0n || tag.value >> 3n > 0xffffffffn) return undefined
      const number = Number(tag.value >> 3n)
      const wire = Number(tag.value & 7n)
      if (wire === 0) {
        const value = varint(bytes, tag.next)
        if (!value) return undefined
        if (number === wanted) return value.value
        offset = value.next
      } else if (wire === 2) {
        const length = varint(bytes, tag.next)
        if (!length || length.value > BigInt(bytes.length - length.next)) return undefined
        const end = length.next + Number(length.value)
        if (number === wanted) return bytes.subarray(length.next, end)
        offset = end
      } else if (wire === 1 || wire === 5) {
        offset = tag.next + (wire === 1 ? 8 : 4)
        if (offset > bytes.length) return undefined
      } else return undefined
    }
    return undefined
  }
  const bytes = (from: Uint8Array, n: number): Uint8Array | undefined => {
    const value = field(from, n)
    return value instanceof Uint8Array ? value : undefined
  }
  const integer = (from: Uint8Array, n: number): bigint | undefined => {
    const value = field(from, n)
    return typeof value === "bigint" ? value : undefined
  }
  const text = (from: Uint8Array, n: number): string | undefined => {
    const value = bytes(from, n)
    if (!value) return undefined
    try { return new TextDecoder("utf-8", { fatal: true }).decode(value).trim() || undefined } catch { return undefined }
  }
  const timestamp = (value?: Uint8Array): number | undefined => {
    const seconds = value && integer(value, 1)
    return seconds !== undefined && seconds > 0n && seconds <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) ? Number(seconds) : undefined
  }
  const wrapped = bytes(blob, 1)
  if (!wrapped) return undefined
  const modelID = text(wrapped, 19), label = text(wrapped, 21)
  const usage = bytes(wrapped, 4)
  if (!usage) return undefined
  const system = integer(usage, 1) ?? 0n, input = integer(usage, 2) ?? 0n
  const output = integer(usage, 3) ?? 0n, cache = integer(usage, 5) ?? 0n
  const safe = BigInt(Number.MAX_SAFE_INTEGER)
  if ([system, input, output, cache, system + input, system + input + output + cache].some((n) => n > safe)) return undefined
  const generated = input !== 0n || output !== 0n || cache !== 0n
  if ((!modelID && !label && !generated) || (!generated && system + input === 0n)) return undefined
  const timing = bytes(wrapped, 9)
  const timestampSeconds = timestamp(timing && bytes(timing, 4)) ?? timestamp(stepMetadata && bytes(stepMetadata, 1))
  if (timestampSeconds === undefined) return undefined
  return { ...(modelID ? { modelID } : {}), ...(label ? { label } : {}), inputTokens: Number(system + input), outputTokens: Number(output), cacheReadTokens: Number(cache), timestampSeconds }
}

export function modelCandidates(id?: string, label?: string): string[] {
  id = id?.replace(/-tiered$/, "")
  return (id?.endsWith("-default") ? [label, id] : [id, label]).filter((name): name is string => name !== undefined)
}

export function antigravitySlots(events: AntigravityEvent[], pricing: Pricing, since: number): Slots {
  const slots = noSlots()
  for (const event of events) {
    const at = event.timestampSeconds * 1000
    if (at < since) continue
    const tokens = { input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite5m: 0, cacheWrite1h: 0 }
    const total = tokens.input + tokens.output + tokens.cacheRead
    if (!Number.isSafeInteger(total) || total <= 0) continue
    const candidates = modelCandidates(event.modelID, event.label)
    let priced = false
    for (const model of candidates) {
      const cost = pricing.cost(model, tokens)
      if (cost === undefined) continue
      add(slots, slotOf(at), pricing.familyName(model, ["-preview"]), total, cost)
      priced = true
      break
    }
    if (!priced) addUnknown(slots, slotOf(at), candidates[0] ?? "Unknown Antigravity Model")
  }
  return slots
}

function names(folder: string): string[] {
  try { return readdirSync(folder).sort() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

/** Same antigravity* surfaces as Swift, but under the agent's isolated .gemini, never the user's. */
export function antigravityDatabases(geminiHome: string): string[] {
  return [...new Set(names(geminiHome).filter((name) => name.startsWith("antigravity")).flatMap((name) => {
    const folder = join(geminiHome, name, "conversations")
    return names(folder).filter((file) => file.endsWith(".db")).map((file) => realpathSync(join(folder, file)))
  }))].sort()
}

/** Both the database and WAL participate, including inode replacement and WAL-only writes. */
function fingerprint(path: string): { stamp: string; latest: number } {
  let latest = -Infinity
  const stamp = [path, path + "-wal"].map((file) => {
    try {
      const info = statSync(file)
      latest = Math.max(latest, info.mtimeMs)
      return `${file}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && file.endsWith("-wal")) return `${file}:-`
      throw error
    }
  }).join("\n")
  return { stamp, latest }
}

export function antigravityStamp(geminiHome: string): string {
  return antigravityDatabases(geminiHome).map((path) => fingerprint(path).stamp).join("\n")
}

// Decode each bounded batch in the worker, passing only the small accounting events back.
const READER = `
import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
const generationEvent = ${generationEvent.toString()}
function open(path) {
  let db
  try {
    db = new Database(path, { readonly: true })
    db.query("SELECT count(*) FROM sqlite_master").values()
    return db
  } catch (error) {
    db?.close()
    let wal = 0
    try { wal = statSync(path + "-wal").size } catch {}
    if (wal > 0 || !/unable to open/i.test(String(error))) throw error
    return new Database("file:" + path.replace(/[%?#]/g, c => "%" + c.charCodeAt(0).toString(16)) + "?immutable=1", { readonly: true })
  }
}
self.onmessage = ({ data: { paths } }) => {
  const events = []
  try {
    for (const path of paths) {
      let db
      try {
        db = open(path)
        db.exec("PRAGMA busy_timeout=2000")
        db.exec("BEGIN")
        const steps = db.query("SELECT 1 FROM pragma_table_info('steps') WHERE name='metadata'").values().length > 0
        const step = steps ? ", (SELECT CASE WHEN length(metadata) <= 1048576 THEN metadata ELSE NULL END FROM steps WHERE idx = g.idx) AS step, (SELECT length(metadata) FROM steps WHERE idx = g.idx) AS stepLength" : ", NULL AS step, NULL AS stepLength"
        const query = db.query("SELECT idx, CASE WHEN length(data) <= 1048576 THEN data ELSE NULL END AS data" + step + " FROM gen_metadata g WHERE idx > ? AND data IS NOT NULL ORDER BY idx LIMIT 8")
        let index = -1
        while (true) {
          const rows = query.all(index)
          for (const row of rows) {
            if (!Number.isSafeInteger(row.idx) || row.idx <= index) throw new Error("Invalid Antigravity generation index")
            index = row.idx
            // Swift skips an oversized generation; oversized step metadata is absent, so
            // embedded timing can still date an otherwise valid generation.
            if (row.data === null) continue
            const event = generationEvent(row.data, row.step ?? undefined)
            if (event) events.push(event)
          }
          if (rows.length < 8) break
        }
      } finally { db?.close() }
    }
    postMessage({ events })
  } catch (error) { postMessage({ failed: String(error) }) }
}
`
let readerURL: string | undefined

interface CachedDatabase {
  stamp: string
  events: AntigravityEvent[]
}

/** Each database is independently cached. Removed stores stop contributing, as Swift's do. */
export class AntigravityHistory {
  // The legacy folder argument is accepted by usage.ts; no manifest should keep removed paths alive.
  constructor(_folder?: string, private readonly read = readAntigravityDatabase) {}
  private databases = new Map<string, Map<string, CachedDatabase>>()
  private combined = new Map<string, { since: number; parts: AntigravityEvent[][]; events: AntigravityEvent[] }>()
  async scan(geminiHome: string, since: number): Promise<AntigravityEvent[]> {
    const paths = antigravityDatabases(geminiHome)
    let cached = this.databases.get(geminiHome)
    if (!cached) this.databases.set(geminiHome, cached = new Map())
    for (const path of cached.keys()) if (!paths.includes(path)) cached.delete(path)
    const parts: AntigravityEvent[][] = []
    let failure: unknown
    for (const path of paths) {
      const before = cached.get(path)
      try {
        const stamp = fingerprint(path)
        // A store untouched since the window began cannot contain use in the window.
        if (stamp.latest < since) { cached.delete(path); continue }
        if (before?.stamp === stamp.stamp) { parts.push(before.events); continue }
        const events = await this.read(path)
        if (fingerprint(path).stamp !== stamp.stamp) throw new Error("Antigravity database changed during the read")
        cached.set(path, { stamp: stamp.stamp, events })
        parts.push(events)
      } catch (error) {
        // Never let an unreadable/actively changing database replace its previous complete answer.
        // Leave its old stamp too, so it is retried next round while the others keep advancing.
        if (before) parts.push(before.events)
        else failure ??= error
      }
    }
    // An unreadable store with no prior result is unknown, not an empty contribution.
    if (failure) throw failure
    const previous = this.combined.get(geminiHome)
    if (previous?.since === since && previous.parts.length === parts.length && previous.parts.every((part, index) => part === parts[index])) return previous.events
    const events = parts.flatMap((part) => part.filter((event) => event.timestampSeconds * 1000 >= since))
    this.combined.set(geminiHome, { since, parts, events })
    return events
  }
}

export function readAntigravityDatabase(path: string): Promise<AntigravityEvent[]> {
  readerURL ??= URL.createObjectURL(new Blob([READER], { type: "application/javascript" }))
  const worker = new Worker(readerURL)
  worker.unref?.()
  let timer: ReturnType<typeof setTimeout>
  return new Promise<AntigravityEvent[]>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Antigravity databases took too long to read")), 120_000)
    timer.unref?.()
    worker.onmessage = ({ data }) => data.failed ? reject(new Error(data.failed)) : resolve(data.events)
    worker.onerror = (event) => reject(new Error(event.message))
    worker.postMessage({ paths: [path] })
  }).finally(() => { clearTimeout(timer); worker.terminate() })
}
