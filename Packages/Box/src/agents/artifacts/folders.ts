// Bots' folders, watched for what changes in them outside the tool calls the record hears: files a
// command made (a script that writes a report), and your own edits (its memory, in Edit Bot). A
// change while the bot's turn runs is that turn's (`shell`); any other is by no agent (`outside`).
// Its memory, job and skills are noted as they are when the watch starts, so their first change
// has a before.

import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs"
import { join, relative, sep } from "node:path"
import { watchFolder } from "../../shared/watch"
import type { Recorder } from "./recorder"
import { copyLimit, type ArtifactStore, type Made } from "./store"
import { changedSince, skipped } from "./turnfiles"

/** Whether a file in the bots' folder (`path`, from it) is one the record keeps: a bot's memory, job, chat recaps and workspace. */
export function recordable(path: string): boolean {
  const parts = path.split(sep)
  if (!parts[0]?.startsWith("bot_") || parts.length < 2) return false
  const inside = parts.slice(1)
  if (inside.length === 1) return inside[0] === "MEMORY.md" || inside[0] === "job.json"
  if (inside[0] === "groups") return inside.length === 2 && inside[1].endsWith(".md")
  if (inside[0] !== "workspace") return false
  const rest = inside.slice(1)
  const name = rest.at(-1) ?? ""
  // An editor's or a download's file on its way.
  if (!name || name.endsWith("~") || /\.(swp|tmp|crdownload|part)$/.test(name)) return false
  if (rest[0] === ".opencode") return rest[1] === "skills" && rest.length > 3 && !rest.some((part) => skipped.has(part))
  return !rest.some((part) => skipped.has(part) || part.startsWith("."))
}

/**
 * `folder` and what's in it watched, `changed` told each path that changes, the same on macOS and
 * Linux: on macOS, one recursive watch (FSEvents, a single stream however many folders), and
 * `missed` told a moment after it or any other watch in the process starts or stops, for what the
 * stream didn't tell then (`watchFolder`); on Linux, where each folder takes one of the user's
 * inotify watches, a watch of each folder but tools' and caches' (`skipped`, dot folders but a
 * bot's skills), added as folders come, at most `limit`. `failed`: it can't keep watching (out of
 * watches); what's still watched stays.
 */
export function watchTree(folder: string, changed: (path: string) => void, failed: (why: string) => void, { limit = 4000, linux = process.platform === "linux", missed = () => {} } = {}) {
  if (!linux) {
    const watcher = watchFolder(folder, (_, name) => {
      if (name) changed(join(folder, name))
    }, { recursive: true, missed })
    watcher.on("error", (error: any) => {
      watcher.close()
      failed(String(error?.message ?? error))
    })
    return { close: () => watcher.close() }
  }
  const watchers = new Map<string, FSWatcher>()
  let full = false
  const add = (at: string) => {
    if (watchers.has(at) || full) return
    if (watchers.size >= limit) {
      full = true
      return failed(`more than ${limit} folders`)
    }
    let watcher: FSWatcher
    try {
      watcher = watch(at, (_, name) => {
        if (!name) return
        const path = join(at, name.toString())
        changed(path)
        // A folder made since: watched too.
        try {
          if (statSync(path).isDirectory() && wanted(relative(folder, path))) visit(path)
        } catch {}
      })
    } catch (error: any) {
      full = true
      return failed(String(error?.message ?? error))
    }
    watcher.on("error", () => {
      watcher.close()
      watchers.delete(at)
    })
    watchers.set(at, watcher)
  }
  const visit = (at: string) => {
    add(at)
    let names: string[]
    try {
      names = readdirSync(at)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(at, name)
      try {
        if (statSync(path).isDirectory() && wanted(relative(folder, path))) visit(path)
      } catch {}
    }
  }
  visit(folder)
  return { close: () => { for (const watcher of watchers.values()) watcher.close() } }
}

/** A folder in the bots' folder (by its path from it) whose files can be what a bot made or keeps. */
function wanted(path: string): boolean {
  const parts = path.split(sep)
  if (parts.some((part) => skipped.has(part))) return false
  // Dot folders, but a bot's own skills (workspace/.opencode/skills).
  return parts.every((part, i) => !part.startsWith(".") || (part === ".opencode" && (parts[i + 1] === undefined || parts[i + 1] === "skills")))
}

export class BotFolders {
  private watcher?: { close(): void }
  /** The watch is up: every change is told (on Linux, it ends when the system's watches run out). */
  private watching = false
  private pending = new Map<string, ReturnType<typeof setTimeout>>()
  /** Since when what the watch may not have told was last looked for. */
  private lookedAt = 0

  constructor(
    private readonly store: ArtifactStore,
    private readonly recorder: Recorder,
    private readonly bots: string,
    private readonly settle = 1000,
  ) {}

  /** Its bots' memory noted as it is, and (`watch`) the folder watched from now on. */
  start({ watch: watches = true }: { watch?: boolean } = {}) {
    this.lookedAt = Date.now()
    for (const bot of this.list()) this.baseline(bot)
    if (!watches) return
    // Without a whole watch, each turn's end looks instead (`turnEnded`).
    this.watching = true
    try {
      this.watcher = watchTree(this.bots, (path) => this.changed(path), (why) => {
        console.error("artifacts: bots' folders aren't all watched:", why)
        this.watching = false
      }, { missed: () => this.missed() })
    } catch (error: any) {
      console.error("artifacts: bots' folders can't be watched:", error?.message ?? error)
      this.watching = false
    }
  }

  stop() {
    this.watcher?.close()
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  /** What changed since it last looked, for what the watch may not have told (as it started, or
   * as another started or stopped): each the record hasn't seen as it is, as the watch would have
   * told it. (By the files' times: a file moved in keeps its own, and one gone isn't found.) */
  missed() {
    const since = this.lookedAt
    this.lookedAt = Date.now()
    for (const path of changedSince(this.bots, since, (inside) => recordable(inside))) {
      if (!this.pending.has(path) && !this.store.asSeen(path)) this.changed(path)
    }
  }

  /** A file in a bot's folder changed: recorded once it settles (or its turn ends). */
  changed(path: string) {
    const inside = relative(this.bots, path)
    if (inside.startsWith("..")) return
    const bot = inside.split(sep)[0]
    // A bot just made: its memory as it starts.
    if (inside === bot) return this.baseline(bot)
    if (!recordable(inside)) return
    clearTimeout(this.pending.get(path))
    this.pending.set(path, setTimeout(() => this.record(path), this.settle))
  }

  /**
   * A bot's turn ended: what changed in its folder meanwhile, recorded now as that turn's. The
   * folder is looked through for what changed since the turn began: without a watch, all of it;
   * with one, what the record hasn't seen as it is (what the watch didn't tell, its stream made
   * anew for longer than it looked again).
   */
  turnEnded(bot: string, since: number, made: (via: string) => Made) {
    // What's still settling goes with the rest, read once at its turn (not looked at now, and again).
    const settling = this.settling(bot)
    const folder = join(this.bots, bot)
    const found = changedSince(folder, since, (inside) => recordable(join(bot, inside))).filter((path) => !settling.includes(path))
    void this.store.changeAll([...settling, ...(this.watching ? found.filter((path) => !this.store.asSeen(path)) : found)], made("shell"))
  }

  /** What's waiting to settle in `bot`'s folder (all bots' without one), recorded now. */
  flush(bot?: string) {
    for (const path of this.settling(bot)) this.record(path)
  }

  /** What's waiting to settle in `bot`'s folder (all bots' without one), no longer waiting. */
  private settling(bot?: string): string[] {
    const paths = [...this.pending.keys()].filter((path) => !bot || relative(this.bots, path).startsWith(bot + sep))
    for (const path of paths) {
      clearTimeout(this.pending.get(path))
      this.pending.delete(path)
    }
    return paths
  }

  private record(path: string) {
    clearTimeout(this.pending.get(path))
    this.pending.delete(path)
    const bot = relative(this.bots, path).split(sep)[0]
    const running = this.recorder.madeInFolder(bot)
    void this.store.change(path, running ? running("shell") : { by: { kind: "outside" }, via: "outside", where: { bot } })
  }

  private list(): string[] {
    try {
      return readdirSync(this.bots).filter((name) => name.startsWith("bot_"))
    } catch {
      return []
    }
  }

  /** A bot's memory, job and skills as they are, kept as each one's version 0 where the record has none. */
  private baseline(bot: string) {
    const folder = join(this.bots, bot)
    const files = [join(folder, "MEMORY.md"), join(folder, "job.json"), ...walk(join(folder, "workspace", ".opencode", "skills"), 200)]
    for (const file of files) {
      if (this.store.at(file)) continue
      try {
        const stat = statSync(file)
        if (!stat.isFile() || stat.size > copyLimit) continue
        void this.store.before(file, readFileSync(file), { bot })
      } catch {}
    }
  }
}

/** Files under `folder`, at most `limit`. */
function walk(folder: string, limit: number): string[] {
  const found: string[] = []
  const visit = (at: string) => {
    let names: string[]
    try {
      names = readdirSync(at)
    } catch {
      return
    }
    for (const name of names) {
      if (found.length >= limit || skipped.has(name)) return
      const path = join(at, name)
      try {
        if (statSync(path).isDirectory()) visit(path)
        else found.push(path)
      } catch {}
    }
  }
  visit(folder)
  return found
}
