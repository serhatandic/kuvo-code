// What the record keeps a copy of. Never the bytes of what's likely a secret (`.env` files, keys,
// what's under `.ssh` or a `keys` folder, what git ignores), whose versions are listed with no
// copy and are never sent. A code file git tracks keeps only the change its tool call made, as git
// keeps the rest. And nothing past the free-space floor but what's always kept.

import { spawnSync } from "node:child_process"
import { existsSync, statfsSync } from "node:fs"
import { basename, dirname, relative, sep } from "node:path"

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

  /** Why `path`'s bytes must never be copied or sent, if they mustn't. */
  privacy(path: string): NoCopy | undefined {
    if (isSecret(path)) return "secret"
    const top = this.top(dirname(path))
    if (top && this.isIgnored(top, path)) return "ignored"
    return undefined
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

  private isIgnored(top: string, path: string): boolean {
    const known = this.ignored.get(path)
    if (known !== undefined) return known
    // 0: ignored; 1: not; anything else (git missing): taken as not.
    const result = spawnSync("git", ["-C", top, "check-ignore", "-q", "--", relative(top, path)], {
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    })
    const ignored = result.status === 0
    this.ignored.set(path, ignored)
    return ignored
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
