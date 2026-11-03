// What the record keeps a copy of. Never the bytes of what's likely a secret (`.env` files, keys,
// what's under `.ssh` or a `keys` folder, what git ignores), whose versions are listed with no
// copy and are never sent. A code file git tracks keeps only the change its tool call made, as git
// keeps the rest. And nothing past the free-space floor but what's always kept.

import { existsSync, statfsSync } from "node:fs"
import { basename, dirname, relative, sep } from "node:path"
import { runGit } from "../proc"

/** Why a version has no copy. */
export type NoCopy = "secret" | "ignored" | "git" | "too-big" | "low-disk" | "cleared"

/** Versions that are never sent, whatever is asked: what's likely a secret. */
export const privateReasons = new Set<NoCopy>(["secret", "ignored"])

/** Whether a file's name or folder says it likely holds a secret. */
export function isSecret(path: string): boolean {
  const name = basename(path)
  if (name === ".env" || name.startsWith(".env.") || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name)) return true
  if (/^id_[a-z0-9_]+(\.pub)?$/i.test(name)) return true
  const parts = path.split(sep)
  return parts.includes(".ssh") || parts.includes("keys") || parts.includes(".gnupg")
}

/** The free-space floor: whichever is less of 10 GB and a tenth of the disk. */
export function floorOf(total: number): number {
  return Math.min(10 * 1024 ** 3, total / 10)
}

export class CopyPolicy {
  /** Each folder's repository top, or null for none: looked for once. */
  private tops = new Map<string, string | null>()
  private ignored = new Map<string, boolean>()

  /** `disk`: the free and whole space of the disk the copies are on. */
  constructor(private readonly disk: () => { free: number; total: number }) {}

  /**
   * Why `path`'s bytes must never be copied or sent, if they mustn't. What git ignores is read from
   * what `learn` found out, so ask that first; one it hasn't is taken as ignored, never copied.
   */
  privacy(path: string): NoCopy | undefined {
    if (isSecret(path)) return "secret"
    const top = this.top(dirname(path))
    if (top && this.ignored.get(path) !== false) return "ignored"
    return undefined
  }

  /**
   * Finds out which of `paths` git ignores, for `privacy`: each repository asked once for all of
   * its paths, without holding up the bridge while git answers.
   */
  async learn(paths: string[]): Promise<void> {
    const asks = new Map<string, string[]>()
    for (const path of new Set(paths)) {
      if (this.ignored.has(path) || isSecret(path)) continue
      const top = this.top(dirname(path))
      if (top) asks.set(top, [...(asks.get(top) ?? []), path])
    }
    await Promise.all([...asks].map(async ([top, asked]) => {
      let ignored = await this.checkIgnore(top, asked)
      // Git refused them all for one it can't look at (beyond a symbolic link): each on its own.
      if (!ignored) {
        ignored = new Set()
        for (const path of asked) if ((await this.checkIgnore(top, [path]))?.size) ignored.add(path)
      }
      for (const path of asked) this.ignored.set(path, ignored.has(path))
    }))
  }
  /** Whether `path` is in a git repository (whose history git keeps). */
  inGit(path: string): boolean {
    return this.top(dirname(path)) !== null
  }

  /** Whether a copy of `size` bytes would take free space below the floor. */
  lowOn(size: number): boolean {
    const { free, total } = this.disk()
    return free - size < floorOf(total)
  }

  space() {
    const { free, total } = this.disk()
    return { free, floor: floorOf(total) }
  }

  private top(folder: string): string | null {
    const known = this.tops.get(folder)
    if (known !== undefined) return known
    let found: string | null = null
    if (existsSync(folder + sep + ".git")) found = folder
    else if (dirname(folder) !== folder) found = this.top(dirname(folder))
    this.tops.set(folder, found)
    return found
  }

  /**
   * Which of `paths` (in `top`'s repository) git ignores; undefined when it refused the batch. What
   * git can't say of (a path beyond a symbolic link, a repository it won't read, git missing or
   * stopped) counts as ignored: never copied unasked.
   */
  private async checkIgnore(top: string, paths: string[]): Promise<Set<string> | undefined> {
    let ran
    try {
      ran = await runGit(["-C", top, "check-ignore", "-z", "--stdin"], {
        // As `./…`: a name like `:x` isn't read as pathspec magic, and git says each back as sent.
        input: paths.map((path) => "./" + relative(top, path)).join("\0") + "\0",
        timeout: 5000,
        env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      })
    } catch {
      return new Set(paths)
    }
    if (ran.timedOut) return new Set(paths)
    // 0: some ignored; 1: none; 128: it refused: for one path beyond a symbolic link, the batch is
    // asked a path at a time; for the repository (one it won't read), all of it.
    if (ran.code === 128 && paths.length > 1 && ran.stderr.includes("beyond a symbolic link")) return undefined
    if (ran.code !== 0 && ran.code !== 1) return new Set(paths)
    const said = new Set(ran.stdout.split("\0").filter(Boolean))
    return new Set(paths.filter((path) => said.has("./" + relative(top, path))))
  }
}

/** The free and whole space of the disk `folder` is on (none known: plenty). */
export function freeSpace(folder: string) {
  try {
    const stats = statfsSync(folder)
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) }
  } catch {
    return { free: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER }
  }
}
