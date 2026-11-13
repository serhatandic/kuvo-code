// The engine's databases on this computer (`opencode*.db` in its data folder, one for each release
// channel), only ever read: listed, stamped (to read them again only when one changed), and read
// in a worker of its own (`bun:sqlite`, read-only), so the bridge never waits on SQLite. What each
// usage source asks of them is its own SQL (engine-hosted.ts).

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

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

/** What's asked of each database: which message tables it has, then the query for those it has. */
export interface EngineSQL {
  tables: string
  v1: string
  v2: string
  both: string
}

/** What the databases answered: each one's JSON; how many had message tables, and why each of those that failed did. */
export interface EngineAnswers {
  checked: number
  failed: string[]
  jsons: string[]
}

/**
 * The worker: each database read-only. A database in WAL mode whose side files are gone (Linux's
 * SQLite removes them as the engine's last connection closes: a channel not running) can't be
 * opened read-only, so one with no write-ahead log to lose is read as it is (immutable). A database
 * without either message table isn't counted, read or failed.
 */
const READER = `
import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
function open(path) {
  let db
  try {
    db = new Database(path, { readonly: true })
    db.query("SELECT count(*) FROM sqlite_master").values()
    return db
  } catch (error) {
    db?.close()
    let wal = 0
    try {
      wal = statSync(path + "-wal").size
    } catch {}
    if (wal > 0 || !/unable to open/i.test(error instanceof Error ? error.message : String(error))) throw error
    return new Database("file:" + path.replace(/[%?#]/g, (character) => "%" + character.charCodeAt(0).toString(16)) + "?immutable=1", { readonly: true })
  }
}
self.onmessage = (event) => {
  const { paths, sql } = event.data
  const jsons = []
  let checked = 0
  const failed = []
  for (const path of paths) {
    let db
    try {
      db = open(path)
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

/** The tables query every reader starts with. */
export const TABLES_SQL = "SELECT group_concat(name) FROM sqlite_master WHERE type='table' AND name IN ('message','session_message');"

/** What every database in `folder` answers `sql`; undefined when there's no database there. */
export function readEngineDatabases(folder: string, sql: EngineSQL): Promise<EngineAnswers | undefined> {
  const paths = engineDatabases(folder)
  if (!paths.length) return Promise.resolve(undefined)
  readerURL ??= URL.createObjectURL(new Blob([READER], { type: "application/javascript" }))
  const worker = new Worker(readerURL)
  // (It never keeps the bridge from ending.)
  worker.unref?.()
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<EngineAnswers>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The engine's database took too long to read.")), READ_FOR)
    worker.onmessage = (event: MessageEvent<EngineAnswers>) => resolve(event.data)
    worker.onerror = (event) => reject(new Error(event.message))
    worker.postMessage({ paths, sql })
  }).finally(() => {
    clearTimeout(timer)
    worker.terminate()
  })
}
