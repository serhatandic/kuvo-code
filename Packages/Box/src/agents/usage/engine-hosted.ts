// What the engine's own hosted models cost: OpenCode Go (`opencode-go`) and OpenCode Zen
// (`opencode`), from the engine's databases on this computer (`opencode*.db` in its data folder,
// every release channel's), only ever read (engine-db.ts).
// UsageKit's `OpenCodeUsageScanner`, kept the same while both exist (test/fixtures/usage/
// opencode-hosted.sql, `UsageBoxParityTests`):
// - each assistant message (and opencode 2's completed compaction) of those two providers with a
//   cost, from `message` (opencode 1) and `session_message` (opencode 2);
// - its cost as the engine wrote it, which OpenCode billed (these models aren't in any price
//   catalog): never priced again, never an estimate;
// - its tokens the total it says, else its buckets added up;
// - a message in both tables, or in two channels' databases, once (by its ID: the first).
// A model you reach with a key of your own (BYO) is that provider's, not these: never counted.

import { readEngineDatabases, TABLES_SQL } from "./engine-db"
import { add, noSlots, slotOf, type Slots } from "./history"
import { numberOf } from "./numbers"

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

// --- The SQL, as UsageKit's ---

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

/** Each database's hosted rows from `since` (ms) on, or why it couldn't be read, by path; undefined when there's no database there. */
export async function hostedAnswers(folder: string, since: number): Promise<{ path: string; rows?: HostedRow[]; failed?: string }[] | undefined> {
  const answers = await readEngineDatabases(folder, { tables: TABLES_SQL, v1: hostedSQL(since, { v1: true, v2: false }), v2: hostedSQL(since, { v1: false, v2: true }), both: hostedSQL(since, { v1: true, v2: true }) })
  return answers?.map(({ path, json, failed }) => (failed !== undefined ? { path, failed } : { path, rows: json ? parseHostedRows(json) : [] }))
}

/**
 * The hosted rows of every database in `folder` from `since` (ms) on, of those that could be read;
 * undefined when there's no database there. Fails when every one with message tables failed.
 */
export async function hostedRows(folder: string, since: number): Promise<HostedRow[] | undefined> {
  const answers = await hostedAnswers(folder, since)
  if (!answers) return undefined
  if (answers.length && answers.every((answer) => answer.failed !== undefined)) throw new Error(answers[0]!.failed)
  return answers.flatMap((answer) => answer.rows ?? [])
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
