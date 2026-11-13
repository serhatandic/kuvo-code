// The engine's databases on this computer (`opencode*.db` in its data folder, one for each release
// channel), only ever read: listed, stamped (to read them again only when one changed), and read
// in a worker of its own (`bun:sqlite`, read-only), so the bridge never waits on SQLite. What each
// usage source asks of them is its own SQL (engine-hosted.ts).

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Every channel's database in the engine's data folder, path-sorted; none when the folder isn't
 * there (no engine has run). A folder that is there but can't be listed throws: not known now.
 */
export function engineDatabases(folder: string): string[] {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return []
    throw error
  }
  return names
    .filter((name) => name.startsWith("opencode") && name.endsWith(".db"))
    .sort()
    .map((name) => join(folder, name))
}

/** What the databases are now (each with its write-ahead log), to read them again only when one changed; throws as `engineDatabases` does. */
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

/** What one database answered: its JSON, or why it couldn't be read. One without message tables answers nothing. */
export type EngineAnswer = { path: string; json?: string; failed?: string }

/**
 * The worker: each database read-only. A database in WAL mode whose side files are gone (Linux's
 * SQLite removes them as the engine's last connection closes: a channel not running) can't be
 * opened read-only, so one with no write-ahead log to lose is read as it is (immutable). A database
 * without either message table isn't counted, read or failed.
 */
const READER = `
import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
// (A database the engine is recovering or checkpointing is waited for a little, from the first query on.)
function opened(db) {
  db.exec("PRAGMA busy_timeout = 2000")
  return db
}
function open(path) {
  let db
  try {
    db = opened(new Database(path, { readonly: true }))
    db.query("SELECT count(*) FROM sqlite_master").values()
    return db
  } catch (error) {
    db?.close()
    let wal = 0
    try {
      wal = statSync(path + "-wal").size
    } catch {}
    if (wal > 0 || !/unable to open/i.test(error instanceof Error ? error.message : String(error))) throw error
    return opened(new Database("file:" + path.replace(/[%?#]/g, (character) => "%" + character.charCodeAt(0).toString(16)) + "?immutable=1", { readonly: true }))
  }
}
self.onmessage = (event) => {
  const { paths, sql } = event.data
  const answers = []
  for (const path of paths) {
    let db
    try {
      db = open(path)
      const names = String(db.query(sql.tables).values()[0]?.[0] ?? "").split(",").map((name) => name.trim())
      const v1 = names.includes("message")
      const v2 = names.includes("session_message")
      if (!v1 && !v2) continue
      const json = db.query(v1 && v2 ? sql.both : v1 ? sql.v1 : sql.v2).values()[0]?.[0]
      answers.push(typeof json === "string" ? { path, json } : { path })
    } catch (error) {
      answers.push({ path, failed: error instanceof Error ? error.message : String(error) })
    } finally {
      db?.close()
    }
  }
  postMessage(answers)
}
`
let readerURL: string | undefined

/** How long a read may take before it's given up (and tried again next round). */
const READ_FOR = 120_000

/** The tables query every reader starts with. */
export const TABLES_SQL = "SELECT group_concat(name) FROM sqlite_master WHERE type='table' AND name IN ('message','session_message');"

/**
 * What each database in `folder` with message tables answers `sql`, by path; undefined when
 * there's no database there. Fails when the folder can't be listed.
 */
export function readEngineDatabases(folder: string, sql: EngineSQL): Promise<EngineAnswer[] | undefined> {
  let paths: string[]
  try {
    paths = engineDatabases(folder)
  } catch (error) {
    return Promise.reject(error)
  }
  if (!paths.length) return Promise.resolve(undefined)
  readerURL ??= URL.createObjectURL(new Blob([READER], { type: "application/javascript" }))
  const worker = new Worker(readerURL)
  // (It never keeps the bridge from ending.)
  worker.unref?.()
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<EngineAnswer[]>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The engine's database took too long to read.")), READ_FOR)
    timer.unref?.()
    worker.onmessage = (event: MessageEvent<EngineAnswer[]>) => resolve(event.data)
    worker.onerror = (event) => reject(new Error(event.message))
    worker.postMessage({ paths, sql })
  }).finally(() => {
    clearTimeout(timer)
    worker.terminate()
  })
}
