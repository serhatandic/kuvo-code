// What a repository's files were around each of your messages, as the engine keeps them for undo:
// a git object store of the bridge's own (in its folder, never the project's), over the
// repository's folder, with the repository's own ignore rules. Undo puts back only the files the
// undone turns changed, as the engine's does. Only in git repositories, as the engine's.

import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fromPatch } from "./diff"
import { run } from "./proc"
import type { FileDiff } from "./wire"

const quiet = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" }
/** A file's changes as shown with an undo, and how many files: enough to see what goes back. */
const patchLimit = 50_000
const fileLimit = 200

interface Repository {
  /** Its top folder, which the store works over. */
  top: string
  /** The session's folder in it ("" for the top). */
  prefix: string
  /** Its own list of what to leave out (`.git/info/exclude`). */
  exclude?: string
}

export class Snapshots {
  /** One git operation at a time on a store (two at once fail on its index). */
  private queues = new Map<string, Promise<unknown>>()
  private taken = 0
  /** Stores being kept small now (`gc`). */
  private collecting = new Set<string>()

  constructor(private readonly root: string) {}

  /** The repository a folder is in, or none. */
  private async repository(directory: string): Promise<Repository | undefined> {
    const top = await run("git", ["-C", directory, "rev-parse", "--show-toplevel"], { timeout: 15_000, env: quiet }).catch(() => undefined)
    if (top?.code !== 0 || !top.stdout.trim()) return undefined
    let root: string
    let here: string
    try {
      root = realpathSync(top.stdout.trim())
      here = realpathSync(directory)
    } catch {
      return undefined
    }
    const exclude = await run("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { timeout: 15_000, env: quiet }).catch(() => undefined)
    let prefix = relative(root, here)
    if (prefix.startsWith("..")) prefix = ""
    return { top: root, prefix, exclude: exclude?.code === 0 ? exclude.stdout.trim() || undefined : undefined }
  }

  private storeOf(repository: Repository) {
    return join(this.root, createHash("sha1").update(repository.top).digest("hex").slice(0, 20))
  }

  private git(repository: Repository, args: string[], options: { input?: string; timeout?: number; packs?: boolean; patterns?: boolean } = {}) {
    // Packed now and then, never pruned (what's kept is referenced by nothing git knows of).
    const settings = ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "core.symlinks=true", "-c", "core.longpaths=true", "-c", "gc.pruneExpire=never", "-c", "gc.worktreePruneExpire=never"]
    if (!options.packs) settings.push("-c", "gc.auto=0")
    if (repository.exclude) settings.push("-c", `core.excludesFile=${repository.exclude}`)
    return run("git", ["--git-dir", this.storeOf(repository), "--work-tree", repository.top, ...settings, ...args], {
      cwd: repository.top,
      timeout: options.timeout ?? 120_000,
      // (check-ignore takes no literal paths: its paths aren't patterns anyway.)
      env: options.patterns ? { ...quiet, GIT_LITERAL_PATHSPECS: "0" } : quiet,
      input: options.input,
    })
  }

  /** Runs `work` once the store's earlier operations are done. */
  private exclusive<T>(repository: Repository, work: () => Promise<T>): Promise<T> {
    const store = this.storeOf(repository)
    const before = this.queues.get(store) ?? Promise.resolve()
    const next = before.then(work, work)
    this.queues.set(store, next.catch(() => {}))
    return next
  }

  /**
   * The folder's files as they are now (a tree's ID), or undefined outside a git repository.
   * Throws when they couldn't be kept.
   */
  async take(directory: string): Promise<string | undefined> {
    const repository = await this.repository(directory)
    if (!repository) return undefined
    return this.exclusive(repository, async () => {
      const store = this.storeOf(repository)
      if (!existsSync(join(store, "HEAD"))) {
        mkdirSync(store, { recursive: true })
        const made = await run("git", ["init", "--bare", "-q", store], { timeout: 30_000, env: quiet })
        if (made.code !== 0) throw new Error("Kuvo Code couldn't make a place to keep this project's files.")
      }
      const added = await this.git(repository, ["add", "-A", "--", repository.prefix || "."])
      if (added.code !== 0) throw new Error(`Kuvo Code couldn't keep this project's files: ${added.stderr.trim().split("\n").pop() ?? "git failed"}`)
      const tree = await this.git(repository, ["write-tree"])
      if (tree.code !== 0 || !tree.stdout.trim()) throw new Error("Kuvo Code couldn't keep this project's files.")
      // What the ignore rules leave out now (a whole folder as one), kept with it: Undo spares
      // those, though the rules change after.
      const ignored = await this.git(repository, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory", "--", repository.prefix || "."])
      if (ignored.code === 0) this.keepIgnored(store, tree.stdout.trim(), ignored.stdout.split("\0").filter(Boolean))
      // Kept small now and then, beside what comes next (which never waits for it: nothing here is
      // ever pruned, so it takes nothing away from under them), one at a time for a store.
      if (++this.taken % 50 === 0 && !this.collecting.has(store)) {
        this.collecting.add(store)
        void this.git(repository, ["gc", "--auto", "--quiet"], { timeout: 600_000, packs: true })
          .catch(() => {})
          .finally(() => this.collecting.delete(store))
      }
      return tree.stdout.trim()
    })
  }

  /**
   * The files (the repository's paths) that differ between two snapshots, in the session's folder.
   * A repository inside it (a submodule, or one cloned there) isn't one of them: Undo never
   * touches it.
   */
  async changed(directory: string, from: string, to: string): Promise<string[]> {
    const repository = await this.repository(directory)
    if (!repository || from === to) return []
    return this.exclusive(repository, async () => {
      const ran = await this.git(repository, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-abbrev", from, to, "--", repository.prefix || "."])
      if (ran.code !== 0) throw new Error("Kuvo Code couldn't tell which files changed.")
      // ":<mode> <mode> <id> <id> <status>\0<path>\0" for each.
      const fields = ran.stdout.split("\0")
      const paths: string[] = []
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const [oldMode, newMode] = fields[i].replace(/^:/, "").split(" ")
        if (oldMode === "160000" || newMode === "160000" || !fields[i + 1]) continue
        paths.push(fields[i + 1])
      }
      return paths
    })
  }

  /** How some files differ from one snapshot to another, for showing what an undo puts back. */
  async changes(directory: string, from: string, to: string, paths: string[]): Promise<FileDiff[]> {
    const repository = await this.repository(directory)
    if (!repository) return []
    return this.exclusive(repository, async () => {
      const files: FileDiff[] = []
      for (const path of paths.slice(0, fileLimit)) {
        const ran = await this.git(repository, ["diff", "--no-color", "--no-renames", "--no-ext-diff", from, to, "--", path]).catch(() => undefined)
        if (ran?.code !== 0) continue
        const patch = ran.stdout.length > patchLimit ? ran.stdout.slice(0, patchLimit) : ran.stdout
        const status = /^new file mode/m.test(patch) ? "added" : /^deleted file mode/m.test(patch) ? "deleted" : "modified"
        files.push(fromPatch(join(repository.top, path), patch, status))
      }
      return files
    })
  }

  /**
   * Puts `paths` (the repository's) back as they were in `tree`: those that weren't there go,
   * the rest are as they were. Never through a link, never outside the repository. Throws when
   * it couldn't. A file that wasn't in `tree` but was made before it was kept (`since`, ms) stays:
   * ignore rules left it out then (rules outside the session's folder, or git's own list).
   */
  async restore(directory: string, tree: string, paths: string[], since?: number): Promise<void> {
    const repository = await this.repository(directory)
    if (!repository || !paths.length) return
    await this.exclusive(repository, async () => {
      const listed = await this.git(repository, ["ls-tree", "-r", "-z", "--full-tree", tree])
      if (listed.code !== 0) throw new Error("Kuvo Code couldn't read what the files were.")
      const wanted = new Set(paths)
      // "<mode> <type> <id>\t<path>" for each; a repository inside it (a gitlink) is left alone.
      const there = new Set<string>()
      const repositories = new Set<string>()
      for (const entry of listed.stdout.split("\0")) {
        const tab = entry.indexOf("\t")
        if (tab < 0) continue
        const path = entry.slice(tab + 1)
        if (!wanted.has(path)) continue
        if (entry.startsWith("160000 ")) repositories.add(path)
        else there.add(path)
      }
      const isRules = (path: string) => /(^|\/)\.gitignore$/.test(path)
      // Its ignore rules first, as they were: what they left out then wasn't kept, so it isn't
      // known to be new, and stays.
      const goneRules = paths.filter((path) => isRules(path) && !there.has(path) && !repositories.has(path))
      for (const path of goneRules) this.remove(repository.top, path)
      await this.checkout(repository, tree, paths.filter((path) => isRules(path) && there.has(path)))
      // (One through a link isn't touched.)
      let gone = paths.filter((path) => !isRules(path) && !there.has(path) && !repositories.has(path) && this.isInside(repository.top, join(repository.top, path)))
      // One the rules leave out now (their files may have changed outside the session's folder,
      // or in git's own list) stays.
      if (gone.length) {
        // (Each as "./<path>": a name like ":(x)" isn't read as git's pathspec magic.)
        const ignored = await this.git(repository, ["check-ignore", "--no-index", "-z", "--stdin"], { input: gone.map((path) => `./${path}`).join("\0"), patterns: true })
        // Not known (it failed): none deleted.
        if (ignored.code !== 0 && ignored.code !== 1) throw new Error("Kuvo Code couldn't tell which files the ignore rules left out.")
        const left = new Set(ignored.stdout.split("\0").filter(Boolean).map((path) => path.replace(/^\.\//, "")))
        gone = gone.filter((path) => !left.has(path))
      }
      // And one the rules left out when it was kept: it was there.
      const leftOut = this.ignoredWith(this.storeOf(repository), tree)
      if (leftOut) gone = gone.filter((path) => !leftOut.has(path) && !ancestors(path).some((folder) => leftOut.has(`${folder}/`)))
      // (Kept before that was noted: one made before it, as its file system says.)
      else if (since !== undefined) gone = gone.filter((path) => !this.madeBefore(join(repository.top, path), since))
      // Gone first, deepest first (a folder that was a file, a file that was a folder).
      for (const path of gone.sort((a, b) => b.length - a.length)) this.remove(repository.top, path)
      const back = paths.filter((path) => !isRules(path) && there.has(path))
      // A folder where a file goes back (it became one): it goes first, unless it's a repository.
      for (const path of back) {
        const full = join(repository.top, path)
        if (this.isInside(repository.top, full) && existsSync(full) && lstatSync(full).isDirectory() && !existsSync(join(full, ".git"))) rmSync(full, { recursive: true, force: true })
      }
      await this.checkout(repository, tree, back)
    })
  }

  private async checkout(repository: Repository, tree: string, paths: string[]) {
    if (!paths.length) return
    const checked = await this.git(repository, ["checkout", tree, "--pathspec-from-file=-", "--pathspec-file-nul"], { input: paths.join("\0") })
    if (checked.code !== 0) throw new Error(`Kuvo Code couldn't put the files back: ${checked.stderr.trim().split("\n").pop() ?? "git failed"}`)
  }

  /** Notes what the ignore rules left out as `tree` was kept (with what they left out before, for the same files). */
  private keepIgnored(store: string, tree: string, paths: string[]) {
    try {
      const folder = join(store, "kuvo-ignored")
      mkdirSync(folder, { recursive: true })
      const file = join(folder, tree)
      const known = existsSync(file) ? readFileSync(file, "utf8").split("\0").filter(Boolean) : []
      writeFileSync(file, [...new Set([...known, ...paths])].join("\0"))
    } catch {}
  }

  /** What the ignore rules left out as `tree` was kept, if that was noted. */
  private ignoredWith(store: string, tree: string): Set<string> | undefined {
    try {
      return new Set(readFileSync(join(store, "kuvo-ignored", tree), "utf8").split("\0").filter(Boolean))
    } catch {
      return undefined
    }
  }

  /** Whether a file was made before a time (as far as its file system says when it was made). */
  private madeBefore(full: string, time: number): boolean {
    try {
      const born = lstatSync(full).birthtimeMs
      return born > 0 && born < time
    } catch {
      return false
    }
  }

  /** Whether a path's folders are inside the repository, none of them a link (deleting through one would reach elsewhere). */
  private isInside(top: string, full: string): boolean {
    const target = resolve(full)
    if (!target.startsWith(top + sep)) return false
    let folder = dirname(target)
    while (folder.length > top.length) {
      try {
        if (lstatSync(folder).isSymbolicLink()) return false
      } catch {
        return true
      }
      folder = dirname(folder)
    }
    return true
  }

  /** A file (or link, or folder) made since, gone again; the folders it leaves empty too. A repository is never removed. */
  private remove(top: string, path: string) {
    const full = join(top, path)
    if (!this.isInside(top, full)) return
    try {
      const stat = lstatSync(full)
      if (stat.isDirectory() && !stat.isSymbolicLink() && existsSync(join(full, ".git"))) return
      // A link goes itself, never what it points at.
      rmSync(full, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true })
    } catch {
      return
    }
    let folder = dirname(full)
    while (folder.length > top.length) {
      try {
        if (readdirSync(folder).length) break
        rmdirSync(folder)
      } catch {
        break
      }
      folder = dirname(folder)
    }
  }
}

/** A path's folders, outermost first (`a`, `a/b` for `a/b/c`). */
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"))
}
