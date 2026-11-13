// Antigravity's conversation accounting, as UsageKit's AntigravityDbUsageScanner and protobuf
// decoder. Only the caller's own agent home is inspected. SQLite stays in a read-only worker;
// a failed/partial read rejects the round so the account keeps its last complete answer.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
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

export function antigravityStamp(geminiHome: string): string {
  return antigravityDatabases(geminiHome).flatMap((path) => [path, path + "-wal"]).map((path) => {
    try { const s = statSync(path); return `${path}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && path.endsWith("-wal")) return `${path}:-`
      throw error
    }
  }).join("\n")
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
            if (row.data === null || row.stepLength > 1048576) throw new Error("Antigravity generation exceeds the 1 MiB limit")
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

/** A full successful scan is cached; failures never replace it and are retried next round. */
export class AntigravityHistory {
  constructor(private readonly folder?: string) {}
  private manifest(home: string): string | undefined {
    return this.folder ? join(this.folder, createHash("sha256").update(home).digest("hex") + ".json") : undefined
  }
  private knownPaths(home: string): string[] {
    const file = this.manifest(home)
    if (!file) return []
    try {
      const paths = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(paths) || !paths.every(p => typeof p === "string")) throw new Error("Invalid Antigravity database list")
      return paths
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  private cached = new Map<string, { stamp: string; paths: string[]; events: AntigravityEvent[]; since: number; filtered: AntigravityEvent[] }>()
  async scan(geminiHome: string, since: number): Promise<AntigravityEvent[]> {
    const stamp = antigravityStamp(geminiHome)
    const before = this.cached.get(geminiHome)
    const paths = antigravityDatabases(geminiHome)
    if (!paths.length || (before?.paths ?? this.knownPaths(geminiHome)).some((path) => !paths.includes(path))) throw new Error("An Antigravity database is missing; keeping the last complete reading")
    if (before?.stamp === stamp) {
      if (before.since !== since) {
        before.since = since
        before.filtered = before.events.filter((event) => event.timestampSeconds * 1000 >= since)
      }
      return before.filtered
    }
    const events = await this.read(paths)
    // Files changing during a read may describe only part of a round: retry without caching it.
    if (antigravityStamp(geminiHome) !== stamp) throw new Error("Antigravity databases changed during the read")
    const filtered = events.filter((event) => event.timestampSeconds * 1000 >= since)
    const manifest = this.manifest(geminiHome)
    if (manifest) {
      mkdirSync(this.folder!, { recursive: true })
      writeFileSync(manifest + ".new", JSON.stringify(paths), { mode: 0o600 })
      renameSync(manifest + ".new", manifest)
    }
    this.cached.set(geminiHome, { stamp, paths, events, since, filtered })
    return filtered
  }
  private read(paths: string[]): Promise<AntigravityEvent[]> {
    readerURL ??= URL.createObjectURL(new Blob([READER], { type: "application/javascript" }))
    const worker = new Worker(readerURL)
    worker.unref?.()
    let timer: ReturnType<typeof setTimeout>
    return new Promise<AntigravityEvent[]>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Antigravity databases took too long to read")), 120_000)
      timer.unref?.()
      worker.onmessage = ({ data }) => data.failed ? reject(new Error(data.failed)) : resolve(data.events)
      worker.onerror = (event) => reject(new Error(event.message))
      worker.postMessage({ paths })
    }).finally(() => { clearTimeout(timer); worker.terminate() })
  }
}
