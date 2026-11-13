// What the engine's own hosted models cost: OpenCode Go (`opencode-go`) and OpenCode Zen
// (`opencode`), from the engine's databases on this computer (`opencode*.db` in its data folder,
// every release channel's), only ever read (`bun:sqlite`, read-only, in a worker of its own).
// UsageKit's `OpenCodeUsageScanner`, kept the same while both exist (test/fixtures/usage/
// opencode-hosted.sql, `UsageBoxParityTests`):
// - each assistant message (and opencode 2's completed compaction) of those two providers with a
//   cost, from `message` (opencode 1) and `session_message` (opencode 2);
// - its cost as the engine wrote it, which OpenCode billed (these models aren't in any price
//   catalog): never priced again, never an estimate;
// - its tokens the total it says, else its buckets added up;
// - a message in both tables, or in two channels' databases, once (by its ID: the first).
// A model you reach with a key of your own (BYO) is that provider's, not these: never counted.

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { add, noSlots, slotOf, type Slots } from "./history"
import { numberOf } from "./grok-log"

/** The engine's providers whose use OpenCode bills itself. */
export const HOSTED_PROVIDERS = ["opencode-go", "opencode"] as const
export type HostedProvider = (typeof HOSTED_PROVIDERS)[number]

/** One message's use, as a database row says it. */
export interface HostedRow {
  id?: string
  /** When it was made, in ms. */
  at: number
  /** Dollars, as billed. */
  cost: number
  tokens: number
  model: string
  provider: string
}

/** Every channel's database in the engine's data folder, path-sorted; none when there's none. */
export function engineDatabases(folder: string): string[] {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith("opencode") && name.endsWith(".db"))
    .sort()
    .map((name) => join(folder, name))
}

/** What the databases are now (each with its write-ahead log), to read them again only when one changed. */
export function databasesStamp(folder: string): string {
  const parts: string[] = []
  for (const path of engineDatabases(folder).flatMap((db) => [db, db + "-wal"])) {
    try {
      const info = statSync(path)
      parts.push(`${path}:${info.size}:${info.mtimeMs}`)
    } catch {
      parts.push(`${path}:-`)
    }
  }
  return parts.join("\n")
}

// --- The SQL, as UsageKit's ---

const TABLES = "SELECT group_concat(name) FROM sqlite_master WHERE type='table' AND name IN ('message','session_message');"
const MODEL = "COALESCE(json_extract(data,'$.model.id'), json_extract(data,'$.modelID'))"
const PROVIDER = "COALESCE(json_extract(data,'$.model.providerID'), json_extract(data,'$.providerID'))"
const TOTAL = `COALESCE(json_extract(data,'$.tokens.total'),
                 COALESCE(json_extract(data,'$.tokens.input'),0)
                 + COALESCE(json_extract(data,'$.tokens.output'),0)
                 + COALESCE(json_extract(data,'$.tokens.reasoning'),0)
                 + COALESCE(json_extract(data,'$.tokens.cache.read'),0)
                 + COALESCE(json_extract(data,'$.tokens.cache.write'),0))`
const V1_ROLE = "json_extract(data,'$.role') = 'assistant'"
const V2_ROLE = "(type = 'assistant' OR (type = 'compaction' AND json_extract(data,'$.status') = 'completed'))"
const PROVIDERS = "(" + HOSTED_PROVIDERS.map((provider) => `'${provider}'`).join(",") + ")"

function rowsSQL(table: string, role: string, cutoff: number) {
  return `SELECT id, time_created, data FROM ${table}
  WHERE time_created >= ${cutoff}
    AND json_valid(data)
    AND ${role}
    AND ${PROVIDER} IN ${PROVIDERS}
    AND json_type(data,'$.cost') IN ('integer','real')`
}

/** The hosted rows from `cutoff` (ms) on, `[time_created, cost, tokens, model, provider, id]` each, in one JSON array. */
export function hostedSQL(cutoff: number, tables: { v1: boolean; v2: boolean }): string {
  const bodies: string[] = []
  if (tables.v1) bodies.push(rowsSQL("message", V1_ROLE, Math.trunc(cutoff)))
  if (tables.v2) bodies.push(rowsSQL("session_message", V2_ROLE, Math.trunc(cutoff)))
  return `SELECT json_group_array(json_array(
         time_created,
         json_extract(data,'$.cost'),
         ${TOTAL},
         ${MODEL},
         ${PROVIDER},
         id))
FROM (
${bodies.join("\n  UNION ALL\n")}
);`
}

/** `[time_created, cost, tokens, model, provider, id]` rows; one without a time, a cost of none or less, or a provider, left out. */
export function parseHostedRows(json: string): HostedRow[] {
  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(payload)) return []
  const rows: HostedRow[] = []
  for (const values of payload) {
    if (!Array.isArray(values) || values.length < 5) continue
    const at = numberOf(values[0])
    const cost = numberOf(values[1])
    if (at === undefined || cost === undefined || cost < 0 || typeof values[4] !== "string") continue
    const tokens = Math.trunc(Math.min(Math.max(numberOf(values[2]) ?? 0, 0), 1e15))
    const id = values.length >= 6 && typeof values[5] === "string" && values[5] ? values[5] : undefined
    rows.push({ ...(id ? { id } : {}), at, cost, tokens, model: typeof values[3] === "string" ? values[3] : "", provider: values[4] })
  }
  return rows
}

/**
 * Reads the databases in a worker of its own, so the bridge never waits on SQLite (a busy engine's
 * database can take a second): each one read-only, its message tables, then its rows' JSON. A
 * database without either table isn't counted, read or failed.
 */
const READER = `
import { Database } from "bun:sqlite"
self.onmessage = (event) => {
  const { paths, sql } = event.data
  const jsons = []
  let checked = 0
  const failed = []
  for (const path of paths) {
    let db
    try {
      db = new Database(path, { readonly: true })
      // (The engine may be writing: wait a little for it.)
      db.exec("PRAGMA busy_timeout = 2000")
      const names = String(db.query(sql.tables).values()[0]?.[0] ?? "").split(",").map((name) => name.trim())
      const v1 = names.includes("message")
      const v2 = names.includes("session_message")
      if (!v1 && !v2) continue
      checked++
      const json = db.query(v1 && v2 ? sql.both : v1 ? sql.v1 : sql.v2).values()[0]?.[0]
      if (typeof json === "string") jsons.push(json)
    } catch (error) {
      checked++
      failed.push(error instanceof Error ? error.message : String(error))
    } finally {
      db?.close()
    }
  }
  postMessage({ checked, failed, jsons })
}
`
let readerURL: string | undefined

/** How long a read may take before it's given up (and tried again next round). */
const READ_FOR = 120_000

/**
 * The hosted rows of every database in `folder` from `since` (ms) on; undefined when there's no
 * database there. Fails when every one with message tables failed to be read.
 */
export function hostedRows(folder: string, since: number): Promise<HostedRow[] | undefined> {
  const paths = engineDatabases(folder)
  if (!paths.length) return Promise.resolve(undefined)
  const sql = { tables: TABLES, v1: hostedSQL(since, { v1: true, v2: false }), v2: hostedSQL(since, { v1: false, v2: true }), both: hostedSQL(since, { v1: true, v2: true }) }
  readerURL ??= URL.createObjectURL(new Blob([READER], { type: "application/javascript" }))
  const worker = new Worker(readerURL)
  // (It never keeps the bridge from ending.)
  worker.unref?.()
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<HostedRow[] | undefined>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The engine's database took too long to read.")), READ_FOR)
    worker.onmessage = (event: MessageEvent<{ checked: number; failed: string[]; jsons: string[] }>) => {
      const { checked, failed, jsons } = event.data
      if (checked > 0 && failed.length === checked) reject(new Error(failed[0]))
      else resolve(jsons.flatMap(parseHostedRows))
    }
    worker.onerror = (event) => reject(new Error(event.message))
    worker.postMessage({ paths, sql })
  }).finally(() => {
    clearTimeout(timer)
    worker.terminate()
  })
}

/** A message in two tables or two databases once: the first. Rows without an ID all count. */
export function dedupHosted(rows: HostedRow[]): HostedRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (row.id === undefined) return true
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}

/** One provider's rows (deduplicated across all of them first) by the slot, as billed. */
export function hostedSlots(rows: HostedRow[], provider: string, since: number): Slots {
  const slots = noSlots()
  for (const row of dedupHosted(rows)) {
    if (row.provider !== provider || row.at < since) continue
    add(slots, slotOf(row.at), row.model, row.tokens, row.cost)
  }
  return slots
}
