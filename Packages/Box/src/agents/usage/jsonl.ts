// Agents' JSONL logs, read as they grow (UsageKit's `IncrementalJSONLScanner`): each file is parsed
// once, then only what was appended to it; one that shrank or was rewritten is read again whole.
// What each file held is kept in the bridge's folder, so a restart doesn't read every log again (it
// can be thrown away: it's rebuilt from the logs). Files changed before the window aren't read.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface FoundFile {
  path: string
  size: number
  /** ms */
  mtime: number
}

interface Record<T> {
  size: number
  mtime: number
  /** Where the last whole line read ended. */
  offset: number
  /** The file's first bytes (`headLength` of them) as they were, hashed: another start is a rewrite. */
  head: string
  headLength: number
  items: T[]
}

/** How much of a file is read at a time, and the longest line read (longer ones are skipped). */
const CHUNK = 1 << 20
const LONGEST_LINE = 64 << 20
const HEAD = 4096
/** The most files looked at under one folder. */
const MOST_FILES = 100_000

/** Every `*.jsonl` file under `folder` (not through links), path-sorted; none when it can't be read. */
export async function jsonlFiles(folder: string): Promise<FoundFile[]> {
  const found: FoundFile[] = []
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= MOST_FILES) return
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
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export class JSONLFiles<T> {
  private records = new Map<string, Record<T>>()
  private dirty = false
  /** The files a round asked for (`items`), until it ends (`endRound`). */
  private seen = new Set<string>()

  constructor(
    /** A line's items (none for a line that isn't one), given its bytes. */
    private readonly parse: (line: Buffer) => T[],
    /** When an item happened (ms): one before the window is let go. */
    private readonly at: (item: T) => number,
    /** Where what was read is kept (none in a test that doesn't), and its format's version. */
    private readonly file?: string,
    private readonly version = 1,
  ) {
    if (!file) return
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"))
      if (saved?.version !== version || !saved.files || typeof saved.files !== "object") return
      for (const [path, record] of Object.entries(saved.files as { [path: string]: Record<T> })) {
        if (record && Array.isArray(record.items) && typeof record.offset === "number" && typeof record.size === "number") this.records.set(path, record)
      }
    } catch {}
  }

  /**
   * The items of `files` (path order, then file order) from `since` (ms) on: each read as far as it
   * was appended to since; undefined once `cancelled`.
   */
  async items(files: FoundFile[], since: number, cancelled: () => boolean = () => false): Promise<T[] | undefined> {
    const all: T[] = []
    for (const file of files) {
      if (cancelled()) return undefined
      if (file.mtime < since) continue
      this.seen.add(file.path)
      const record = await this.read(file, since)
      for (const item of record.items) if (this.at(item) >= since) all.push(item)
    }
    return all
  }

  /** A round of `items` is over: files none of it asked for are forgotten, and what was read is kept. */
  endRound(complete = true) {
    if (complete) {
      for (const path of [...this.records.keys()]) {
        if (this.seen.has(path)) continue
        this.records.delete(path)
        this.dirty = true
      }
    }
    this.seen.clear()
    this.save()
  }

  /** Keeps what was read, if anything changed. */
  private save() {
    if (!this.file || !this.dirty) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file + ".new", JSON.stringify({ version: this.version, files: Object.fromEntries(this.records) }), { mode: 0o600 })
      renameSync(this.file + ".new", this.file)
      this.dirty = false
    } catch {}
  }

  private async read(file: FoundFile, since: number): Promise<Record<T>> {
    const before = this.records.get(file.path)
    if (before && before.size === file.size && before.mtime === file.mtime) return before
    let handle
    try {
      handle = await open(file.path, "r")
    } catch {
      // (Gone or unreadable meanwhile: nothing of it, this time.)
      return { size: file.size, mtime: file.mtime, offset: 0, head: "", headLength: 0, items: [] }
    }
    try {
      let record: Record<T>
      const appended = before && file.size >= before.size && (await headOf(handle, before.headLength)) === before.head
      if (appended) record = { ...before, items: before.items.filter((item) => this.at(item) >= since) }
      else {
        const headLength = Math.min(HEAD, file.size)
        record = { size: 0, mtime: 0, offset: 0, head: await headOf(handle, headLength), headLength, items: [] }
      }
      record.offset = await this.readLines(handle, record.offset, file.size, (line) => {
        for (const item of this.parse(line)) if (this.at(item) >= since) record.items.push(item)
      })
      record.size = file.size
      record.mtime = file.mtime
      // A file that was shorter than its head when read grows into it: its head is taken anew.
      if (record.headLength < HEAD && file.size > record.headLength) {
        record.headLength = Math.min(HEAD, file.size)
        record.head = await headOf(handle, record.headLength)
      }
      this.records.set(file.path, record)
      this.dirty = true
      return record
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

async function headOf(handle: Awaited<ReturnType<typeof open>>, length: number): Promise<string> {
  if (!length) return ""
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, 0)
  return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex").slice(0, 32)
}
