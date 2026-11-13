// What your ChatGPT sign-in in Kuvo Code (the engine's `openai`, Settings › Accounts) used through
// the engine's own models: UsageKit's `OpenCodeCodexUsageScanner`, kept the same while both exist
// (test/fixtures/usage/codex-engine, `UsageBoxParityTests`), read from the engine's databases on
// this computer (`opencode*.db` in its data folder), only ever read (`bun:sqlite`, read-only).
// - The engine keeps a ChatGPT sign-in's and an OpenAI API key's use alike (`openai`): a database's
//   rows count only while its own `openai` sign-in is ChatGPT's (OAuth), and only those its
//   sign-in priced at nothing (Codex's own plugin prices every model at $0; a key's cost more).
// - Both its tables: `message` (opencode 1) and `session_message` (opencode 2), whose rows count
//   only from when the sign-in was made (an early opencode 2 priced a key's use at $0 too).
// - A message copied between two databases (two release channels) counts once, by its ID.
// - Priced as Codex prices it (codex-pricing.ts).
//
// Nothing secret is read out: whether the sign-in is OAuth is asked of SQLite, its tokens stay there.

import { Database } from "bun:sqlite"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pricingModelOf, prepareCodex, preparedCost, type Prepared } from "./codex-pricing"
import { add, addUnknown, noSlots, slotOf, type Slots } from "./history"
import type { Pricing, Tokens } from "./pricing"

/** One assistant message's use, as a database row says it. */
export interface EngineCodexRow {
  id?: string
  /** When it completed, in ms. */
  at: number
  model: string
  tokens: Tokens
  /** Its buckets added up, or the total it said when they're none. */
  total: number
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

const IMPORTED = "SELECT 1 FROM migration WHERE id = '20260805200742_import_legacy_credentials' LIMIT 1;"
// (Whether it's OAuth, asked of SQLite: its tokens never leave the database. Its value is JSON, or
// JSON kept as a JSON string.)
const SIGN_IN = `SELECT json_extract(doc,'$.type') = 'oauth' AND (length(trim(COALESCE(json_extract(doc,'$.access'),''))) > 0 OR length(trim(COALESCE(json_extract(doc,'$.refresh'),''))) > 0), time_created
  FROM (SELECT CASE WHEN json_type(value) = 'text' THEN json_extract(value,'$') ELSE value END AS doc, time_created, active, time_updated, id
    FROM credential
    WHERE integration_id = 'openai' AND (active IS NULL OR active = 1))
  ORDER BY active DESC, time_updated DESC, id DESC
  LIMIT 1;`
const TABLES = "SELECT group_concat(name) FROM sqlite_master WHERE type='table' AND name IN ('message','session_message');"

const MOST_MS = 1e15

const missingTable = (error: unknown) => /no such table/i.test(error instanceof Error ? error.message : String(error))

/** A database's `openai` sign-in: whether it's ChatGPT's, and since when (ms) where it says. */
function signInOf(db: Database, folder: string): { oauth: boolean; since?: number } {
  let imported = false
  try {
    imported = db.query(IMPORTED).values().length > 0
  } catch (error) {
    if (!missingTable(error)) throw error
  }
  if (imported) {
    try {
      const row = db.query(SIGN_IN).values()[0]
      // (Signed out: the row is gone, and the `auth.json` it was imported from doesn't count.)
      if (!row) return { oauth: false }
      // (When it was made, in ms: none bounds nothing.)
      const since = row[1] === null ? undefined : numberOf(row[1])
      if (row[1] !== null && (since === undefined || since < 0 || since > MOST_MS)) throw new Error("credential row is malformed")
      return { oauth: row[0] === 1, ...(since !== undefined ? { since } : {}) }
    } catch (error) {
      if (!missingTable(error)) throw error
    }
  }
  // Before opencode 2 took its sign-ins in: the `auth.json` beside it.
  let text: string
  try {
    text = readFileSync(join(folder, "auth.json"), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { oauth: false }
    throw error
  }
  const entry = (JSON.parse(text) as any)?.openai
  return { oauth: isOAuth(entry) }
}

function isOAuth(entry: any): boolean {
  if (!entry || typeof entry !== "object" || entry.type !== "oauth") return false
  return ["access", "refresh"].some((field) => typeof entry[field] === "string" && entry[field].trim() !== "")
}

const COMPLETED = "(json_type(data,'$.time.completed') IN ('integer','real') OR json_type(data,'$.finish') = 'text')"

function rowsSQL(table: string, role: string, creationCutoff: number, extra = "") {
  return `
  SELECT time_created, id, data FROM ${table}
  WHERE time_created >= ${creationCutoff}
    AND json_valid(data)
    AND COALESCE(json_extract(data,'$.model.providerID'), json_extract(data,'$.providerID')) = 'openai'
    AND json_type(data,'$.cost') IN ('integer','real')
    AND json_extract(data,'$.cost') = 0
    AND ${role}${extra}`
}

/** The rows from `cutoff` (ms) on, as `parseRows` reads them; v2's only from the sign-in (`oauthSince`) on. */
export function dataSQL(cutoff: number, tables: { v1: boolean; v2: boolean }, oauthSince?: number): string {
  const creationCutoff = Math.trunc(cutoff) - 7 * 86_400_000
  const bodies: string[] = []
  if (tables.v1) bodies.push(rowsSQL("message", `json_extract(data,'$.role') = 'assistant' AND ${COMPLETED}`, creationCutoff))
  // Compaction summaries complete by `$.status`, not as an assistant's reply does.
  if (tables.v2) bodies.push(rowsSQL("session_message", `((type = 'assistant' AND ${COMPLETED}) OR (type = 'compaction' AND json_extract(data,'$.status') = 'completed'))`, creationCutoff, oauthSince !== undefined ? `\n    AND COALESCE(json_extract(data,'$.time.completed'),time_created) >= ${Math.trunc(oauthSince)}` : ""))
  return `SELECT json_group_array(json_array(
         COALESCE(json_extract(data,'$.time.completed'),time_created),
         json_extract(data,'$.cost'),
         COALESCE(json_extract(data,'$.tokens.total'),0),
         COALESCE(json_extract(data,'$.model.id'), json_extract(data,'$.modelID')),
         COALESCE(json_extract(data,'$.tokens.input'),0),
         COALESCE(json_extract(data,'$.tokens.cache.read'),0),
         COALESCE(json_extract(data,'$.tokens.cache.write'),0),
         COALESCE(json_extract(data,'$.tokens.output'),0),
         COALESCE(json_extract(data,'$.tokens.reasoning'),0),
         id))
FROM (${bodies.join("\n  UNION ALL")}
)
WHERE COALESCE(json_extract(data,'$.time.completed'),time_created) >= ${Math.trunc(cutoff)};`
}

/** `ProviderParse.number`: a number (not a boolean), or text that is one; finite. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value)) {
    const found = Number(value)
    return Number.isFinite(found) ? found : undefined
  }
  return undefined
}

const clamped = (value: unknown) => Math.trunc(Math.min(Math.max(numberOf(value) ?? 0, 0), 1e18))

/** `[completed, cost, total, model, input, cacheRead, cacheWrite, output, reasoning, id]`, each a row: those priced at nothing. */
export function parseRows(json: string): EngineCodexRow[] {
  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(payload)) return []
  const rows: EngineCodexRow[] = []
  for (const values of payload) {
    if (!Array.isArray(values) || values.length < 10) continue
    const at = numberOf(values[0])
    // (A key's use, left from before you signed in with ChatGPT, cost something: not Codex's.)
    if (at === undefined || numberOf(values[1]) !== 0) continue
    const [input, cacheRead, cacheWrite, output, reasoning] = [values[4], values[5], values[6], values[7], values[8]].map(clamped) as [number, number, number, number, number]
    const tokens: Tokens = { input, cacheWrite5m: cacheWrite, cacheWrite1h: 0, cacheRead, output: output + reasoning }
    const sum = input + cacheWrite + cacheRead + output + reasoning
    const id = typeof values[9] === "string" ? values[9].trim() : ""
    rows.push({ ...(id ? { id } : {}), at, model: typeof values[3] === "string" ? values[3].trim() : "", tokens, total: sum > 0 ? sum : clamped(values[2]) })
  }
  return rows
}

/** A message copied between databases counts once: its latest, then its larger. Rows without an ID all count. */
export function deduplicated(rows: EngineCodexRow[]): EngineCodexRow[] {
  const without: EngineCodexRow[] = []
  const byID = new Map<string, EngineCodexRow>()
  for (const row of rows) {
    if (row.id === undefined) {
      without.push(row)
      continue
    }
    const kept = byID.get(row.id)
    if (!kept || row.at > kept.at || (row.at === kept.at && row.total > kept.total)) byID.set(row.id, row)
  }
  return [...without, ...byID.values()]
}

/** The rows of every database in `folder` whose sign-in is ChatGPT's, from `since` (ms) on; throws when one can't be read and none could. */
export function engineCodexRows(folder: string, since: number): EngineCodexRow[] | undefined {
  const rows: EngineCodexRow[] = []
  let oauth = false
  let read = false
  let failed: unknown
  for (const path of engineDatabases(folder)) {
    let db: Database | undefined
    try {
      db = new Database(path, { readonly: true })
      // (The engine may be writing: wait a little for it, never hold it up.)
      db.exec("PRAGMA busy_timeout = 2000")
      const signIn = signInOf(db, folder)
      if (!signIn.oauth) continue
      oauth = true
      const names = String(db.query(TABLES).values()[0]?.[0] ?? "").split(",").map((name) => name.trim())
      const tables = { v1: names.includes("message"), v2: names.includes("session_message") }
      if (!tables.v1 && !tables.v2) continue
      const json = db.query(dataSQL(since, tables, signIn.since)).values()[0]?.[0]
      if (typeof json === "string") rows.push(...parseRows(json))
      read = true
    } catch (error) {
      failed = error
    } finally {
      db?.close()
    }
  }
  // None signed in with ChatGPT: nothing of it here. One that couldn't be read, and none that could: not known now.
  if (!oauth) return undefined
  if (!read && failed !== undefined) throw failed
  return rows
}

/** The rows by the slot, priced; a model that can't be priced counts nowhere but as an unknown one. */
export function engineCodexSlots(rows: EngineCodexRow[], pricing: Pricing, since: number): Slots {
  const slots = noSlots()
  // Resolved once per model it's priced as (auto-review's change with the date).
  const prepared = new Map<string, Prepared | undefined>()
  for (const row of deduplicated(rows)) {
    if (row.at < since || !row.model) continue
    const slot = slotOf(row.at)
    const as = pricingModelOf(row.model, row.at)
    if (!prepared.has(as)) prepared.set(as, prepareCodex(pricing, row.model, row.at))
    const found = prepared.get(as)
    if (!found) {
      if (row.total > 0) addUnknown(slots, slot, row.model)
      continue
    }
    add(slots, slot, row.model, row.total, preparedCost(found, row.tokens))
  }
  return slots
}

/** What the databases are now, to read them again only when one changed. */
export function engineStamp(folder: string): string {
  const parts: string[] = []
  for (const path of [...engineDatabases(folder).flatMap((db) => [db, db + "-wal"]), join(folder, "auth.json")]) {
    try {
      const info = statSync(path)
      parts.push(`${path}:${info.size}:${info.mtimeMs}`)
    } catch {
      parts.push(`${path}:-`)
    }
  }
  return parts.join("\n")
}
