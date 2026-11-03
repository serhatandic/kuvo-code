// Files a turn changed that no tool call named (a command's output), looked for as the turn ends:
// in a git repository, what git status lists (so what git ignores is left out); elsewhere, a walk
// of the folder for files changed since the turn began, which stops at a limit. The same on macOS
// and Linux: plain directory reads and git, no watch.

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { ownArgs } from "../../shared/git"

/** Folders whose files are never what an agent made for you (tools' own, caches). */
export const skipped = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".next", ".turbo", ".gradle", "target", "DerivedData"])

/**
 * A project's scratch folders, whatever their case: what a command leaves there (a render to check
 * its work) isn't what it made for you. (A bot's own folder keeps what it puts in its tmp.)
 */
const scratch = new Set(["tmp", "temp", ".tmp"])

/** Whether `path` is in a scratch folder of `project`'s. */
export function inScratch(path: string, project: string): boolean {
  if (!path.startsWith(project + sep)) return false
  return path.slice(project.length + 1).split(sep).slice(0, -1).some((part) => scratch.has(part.toLowerCase()))
}

/**
 * How much earlier than the turn a file's time may say it changed and still count: Linux stamps
 * files from a coarse clock (a few milliseconds behind the time read just before the write), and
 * some file systems keep whole seconds.
 */
const clockSlack = 2000

/** Most entries a walk looks at, and most files it gives back. */
const walkLimit = 20_000
const fileLimit = 200

/**
 * Kuvo Code's own folders on this computer (the box's, with the files sent with messages, its run
 * state and records): never what an agent made, though a session working in the home folder walks
 * over them. On a machine they're `~/.kuvo-code`; on a Mac, the app's support folder, which holds
 * the bridge's and the box's, and what the app names (`KUVO_OWN_FOLDERS`, a JSON list: a Mac's
 * caches, logs and preferences, folders or files).
 */
function ownFolders(): string[] {
  const agents = process.env.KUVO_AGENTS_HOME
  let named: string[] = []
  try {
    const list = JSON.parse(process.env.KUVO_OWN_FOLDERS ?? "[]")
    if (Array.isArray(list)) named = list.filter((each): each is string => typeof each === "string")
  } catch {}
  return [process.env.KUVO_HOME, agents ? dirname(agents) : undefined, ...named].filter((folder): folder is string => !!folder)
}

/** The git repository `folder` is in, or none. */
function repositoryOf(folder: string): string | undefined {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at
    if (dirname(at) === at) return undefined
  }
}

/**
 * Files under `folder` changed since `since` (ms), at most a couple of hundred; `keep` says
 * which of them count (a path from `folder`).
 */
export function changedSince(folder: string, since: number, keep: (relative: string) => boolean = () => true): string[] {
  const top = repositoryOf(folder)
  // Kuvo Code's own, where they're inside it (not a bot's folder, which is in them).
  const own = ownFolders().filter((inside) => inside.startsWith(folder + sep))
  const candidates = top ? fromGit(top, folder) : walk(folder, own)
  const found: string[] = []
  for (const path of candidates) {
    if (found.length >= fileLimit) break
    const relative = path.slice(folder.length + 1)
    if (!keep(relative) || relative.split(sep).some((part) => skipped.has(part) || scratch.has(part.toLowerCase())) || own.some((inside) => path === inside || path.startsWith(inside + sep))) continue
    try {
      const stat = statSync(path)
      if (stat.isFile() && stat.mtimeMs >= since - clockSlack) found.push(path)
    } catch {}
  }
  return found
}

/** What git status lists under `folder`: changed and new files, each by its whole path. */
function fromGit(top: string, folder: string): string[] {
  const args = ownArgs(["-C", folder, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
  if (!args) return walk(folder)
  const result = spawnSync("git", args, {
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  })
  if (result.status !== 0) return walk(folder)
  const paths: string[] = []
  const entries = result.stdout.toString("utf8").split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    // A rename names where it went first, then where it came from (skipped).
    if (entry[0] === "R" || entry[0] === "C") i++
    if (entry[0] === "D" || entry[1] === "D") continue
    paths.push(join(top, entry.slice(3)))
  }
  return paths.filter((path) => path.startsWith(folder + sep))
}

/** Every file under `folder`, but in skipped folders and `own`, up to the walk's limit. */
function walk(folder: string, own: string[] = []): string[] {
  const files: string[] = []
  let looked = 0
  const visit = (at: string) => {
    let names: string[]
    try {
      names = readdirSync(at)
    } catch {
      return
    }
    for (const name of names) {
      if (++looked > walkLimit) return
      if (skipped.has(name)) continue
      const path = join(at, name)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (!own.includes(path)) visit(path)
      }
      else if (stat.isFile()) files.push(path)
    }
  }
  visit(folder)
  if (looked > walkLimit) console.error(`artifacts: stopped looking through ${folder} after ${walkLimit} entries`)
  return files
}
