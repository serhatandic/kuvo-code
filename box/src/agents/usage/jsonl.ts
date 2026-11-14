// Agents' JSONL logs, read as they grow (UsageKit's `IncrementalJSONLScanner`): each file is parsed
// once, then only what was appended to it; one that shrank or was rewritten is read again whole.
// What each file held is kept in the bridge's folder, a file a log, so a restart doesn't read every
// log again (it can be thrown away: it's rebuilt from the logs). Files changed before the window
// aren't read, and an item that's the same as one before it in its file (Claude Code writes a
// reply's usage once for each part of it) is kept once. A log whose lines mean something only after
// the ones before (Codex's running totals) keeps what they said so far with it (`state`), so it's
// read on from there.

import { createHash } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { open, readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

export interface FoundFile {
  path: string
  size: number
  /** ms */
  mtime: number
}

interface Record<T, S> {
  size: number
  mtime: number
  /** Where the last whole line read ended. */
  offset: number
  /** The file's first bytes (`headLength` of them) as they were, hashed: another start is a rewrite. */
  head: string
  headLength: number
  items: T[]
  /** What its lines so far say of the next (`JSONLFiles`' `state`). */
  state?: S
}

/** How much of a file is read at a time, and the longest line read (longer ones are skipped). */
const CHUNK = 1 << 20
const LONGEST_LINE = 64 << 20
const HEAD = 4096
/** The most files looked at under one folder (the newest), and walked past to find them. */
const MOST_FILES = 100_000
const MOST_WALKED = 4 * MOST_FILES

/** Every `*.jsonl` file under `folder` (not through links), path-sorted, the newest 100,000 at most; none when it can't be read. */
export async function jsonlFiles(folder: string): Promise<FoundFile[]> {
  let found: FoundFile[] = []
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= MOST_WALKED) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(path)
          found.push({ path, size: info.size, mtime: info.mtimeMs })
        } catch {}
      }
    }
  }
  await walk(folder)
  if (found.length > MOST_FILES) found = found.sort((a, b) => b.mtime - a.mtime).slice(0, MOST_FILES)
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export class JSONLFiles<T, S = undefined> {
  private records = new Map<string, Record<T, S>>()
  /** Files whose record changed since it was last kept, and those forgotten. */
  private changed = new Set<string>()
  private forgotten = new Set<string>()
  /** The files a round asked for (`refresh`), until it ends (`endRound`). */
  private seen = new Set<string>()
  private loading?: Promise<void>
  /** Counts each change to what's read: the same since a round, nothing new to work out. */
  version = 0

  constructor(
    /** A line's items (none for a line that isn't one), given its bytes, and its log's `state` so far (which it carries on). */
    private readonly parse: (line: Buffer, state: S) => T[],
    /** When an item happened (ms): one before the window is let go. */
    private readonly at: (item: T) => number,
    /** The folder what was read is kept in, a file a log (none in a test that doesn't), and its format's version. */
    private readonly folder?: string,
    private readonly format = 1,
    /** What an item is but for when it happened: one the same as an earlier one in its file is left out (none: always kept). */
    private readonly same?: (item: T) => string | undefined,
    /** A log's state: as it starts, and as it was kept (undefined: not one, the log is read again whole). */
    private readonly state?: { initial: () => S; from: (kept: unknown) => S | undefined },
  ) {}

  /** What was kept, read as the first round starts (not as the bridge does). */
  private load(): Promise<void> {
    this.loading ??= (async () => {
      if (!this.folder) return
      let names: string[] = []
      try {
        names = await readdir(this.folder)
      } catch {}
      for (const name of names) {
        if (!/^[0-9a-f]{32}\.json$/.test(name)) continue
        try {
          const saved = JSON.parse(await readFile(join(this.folder, name), "utf8"))
          const record = saved?.record
          const state = this.state && record ? this.state.from(record.state) : undefined
          if (saved?.version === this.format && typeof saved.path === "string" && keptName(saved.path) === name && record && Array.isArray(record.items) && typeof record.offset === "number" && typeof record.size === "number" && (!this.state || state !== undefined)) this.records.set(saved.path, { ...record, state })
          else rmSync(join(this.folder, name), { force: true })
        } catch {}
      }
    })()
    return this.loading
  }

  /** Each of `files` read as far as it was appended to since, from `since` (ms) on. */
  async refresh(files: FoundFile[], since: number): Promise<void> {
    await this.load()
    for (const file of files) {
      if (file.mtime < since) continue
      this.seen.add(file.path)
      await this.read(file, since)
    }
  }

  /** The items of `files` read (path order, then file order) from `since` (ms) on. */
  itemsOf(files: FoundFile[], since: number): T[] {
    const all: T[] = []
    for (const file of files) for (const item of this.records.get(file.path)?.items ?? []) if (this.at(item) >= since) all.push(item)
    return all
  }

  /** Both: `refresh`, then `itemsOf`. */
  async items(files: FoundFile[], since: number): Promise<T[]> {
    await this.refresh(files, since)
    return this.itemsOf(files, since)
  }

  /** A round of `refresh` is over: files none of it asked for are forgotten, and what changed is kept. */
  endRound(complete = true) {
    if (complete) {
      for (const path of [...this.records.keys()]) {
        if (this.seen.has(path)) continue
        this.records.delete(path)
        this.changed.delete(path)
        this.forgotten.add(path)
        this.version++
      }
    }
    this.seen.clear()
    this.save()
  }

  /** Keeps the records that changed, each in a file of its own (a log that grew rewrites its own only). */
  private save() {
    if (!this.folder) return
    try {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 })
    } catch {
      return
    }
    for (const path of this.forgotten) {
      try {
        rmSync(join(this.folder, keptName(path)), { force: true })
      } catch {}
    }
    this.forgotten.clear()
    for (const path of this.changed) {
      const file = join(this.folder, keptName(path))
      try {
        writeFileSync(file + ".new", JSON.stringify({ version: this.format, path, record: this.records.get(path) }), { mode: 0o600 })
        renameSync(file + ".new", file)
      } catch {}
    }
    this.changed.clear()
  }

  private async read(file: FoundFile, since: number): Promise<void> {
    const before = this.records.get(file.path)
    if (before && before.size === file.size && before.mtime === file.mtime) return
    let handle
    try {
      handle = await open(file.path, "r")
    } catch {
      // (Gone or unreadable meanwhile: nothing of it, this time.)
      return
    }
    try {
      let record: Record<T, S>
      const grew = before && file.size > before.size && (await headOf(handle, before.headLength)) === before.head
      // (Its state a copy, so one read cut short leaves the record it had as it was; none to go on from: read again whole.)
      const state = grew && this.state ? this.state.from(JSON.parse(JSON.stringify(before!.state ?? null))) : undefined
      const appended = grew && (!this.state || state !== undefined)
      if (appended) record = { ...before!, items: before!.items.filter((item) => this.at(item) >= since), ...(this.state ? { state } : {}) }
      else {
        const headLength = Math.min(HEAD, file.size)
        record = { size: 0, mtime: 0, offset: 0, head: await headOf(handle, headLength), headLength, items: [], ...(this.state ? { state: this.state.initial() } : {}) }
      }
      // (What's in the file already, to leave out what's the same again.)
      const had = this.same ? new Set(record.items.map(this.same).filter((key) => key !== undefined)) : undefined
      record.offset = await this.readLines(handle, record.offset, file.size, (line) => {
        for (const item of this.parse(line, record.state as S)) {
          if (this.at(item) < since) continue
          const key = had ? this.same!(item) : undefined
          if (had && key !== undefined) {
            if (had.has(key)) continue
            had.add(key)
          }
          record.items.push(item)
        }
      })
      record.size = file.size
      record.mtime = file.mtime
      // A file that was shorter than its head when read grows into it: its head is taken anew.
      if (record.headLength < HEAD && file.size > record.headLength) {
        record.headLength = Math.min(HEAD, file.size)
        record.head = await headOf(handle, record.headLength)
      }
      this.records.set(file.path, record)
      this.changed.add(file.path)
      this.version++
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** Each whole line from `offset` to `end`; where the last whole one ended. */
  private async readLines(handle: Awaited<ReturnType<typeof open>>, offset: number, end: number, line: (bytes: Buffer) => void): Promise<number> {
    const buffer = Buffer.alloc(CHUNK)
    let pieces: Buffer[] = []
    let pending = 0
    let skipping = false
    let position = offset
    let consumed = offset
    while (position < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, end - position), position)
      if (!bytesRead) break
      let start = 0
      for (let at = buffer.indexOf(10, 0); at >= 0 && at < bytesRead; at = buffer.indexOf(10, at + 1)) {
        if (!skipping) {
          const piece = buffer.subarray(start, at)
          const whole = pieces.length ? Buffer.concat([...pieces, piece]) : piece
          if (whole.length) line(whole)
        }
        pieces = []
        pending = 0
        skipping = false
        start = at + 1
        consumed = position + at + 1
      }
      if (start < bytesRead && !skipping) {
        pending += bytesRead - start
        if (pending > LONGEST_LINE) {
          pieces = []
          skipping = true
        } else pieces.push(Buffer.from(buffer.subarray(start, bytesRead)))
      }
      position += bytesRead
    }
    // (What follows the last newline is read again next time, once it's whole.)
    return consumed
  }
}

/** A log's record's file: its path, hashed. */
const keptName = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 32) + ".json"

async function headOf(handle: Awaited<ReturnType<typeof open>>, length: number): Promise<string> {
  if (!length) return ""
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, 0)
  return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex").slice(0, 32)
}
