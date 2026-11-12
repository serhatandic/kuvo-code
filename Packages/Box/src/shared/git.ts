// git as the box runs it in a repository (PROTOCOL.md, "Git"): a repository's own settings (its
// `.git/config`, and what that includes) never start a program on their own, since whoever could
// write in the folder (a download, an agent let outside the sandbox) could have put one there.
// Every git the box runs gets no fsmonitor, pager, external diff or signature check. What the box
// does by itself (reading the changes, keeping snapshots and backups) also runs no hooks (those in
// a hooks folder or named in settings), signing or credential helpers, finds no bare repository by
// sitting in its folder, and switches off the filters and diff converters the repository names,
// but for git-lfs's and git-crypt's, run as installed. What you ask git for yourself (Commit, Push
// or Pull in Changes, a worktree) runs its hooks, filters and sign-ins as your terminal would.
// Your own settings (`~/.gitconfig`) count as yours, but for hooks. Neither runs where the
// repository's `commondir` leads git to another repository's settings and hooks (`strayCommon`).

import { execFile, spawnSync } from "node:child_process"
import { accessSync, closeSync, constants, fstatSync, openSync, promises as fsp, readSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

/** What every git the box runs gets. */
export const EVERY = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "log.showSignature=false"]

/** And what the box runs by itself. */
export const OWN = [...EVERY, "-c", "safe.bareRepository=explicit", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "credential.helper="]

/** Never asking anything. */
export const GIT_QUIET = { GIT_TERMINAL_PROMPT: "0" }

// The programs settings can name that git would run for the box: a file's filter (switched off by
// an empty setting) and diff converter (by --no-textconv, as an empty one fails), by its
// attributes, and a hook (by `hook.<name>.enabled=false`; an empty one fails). (A diff program is
// never run: diffs get --no-ext-diff. A merge program runs only in merges you ask for.)
const DRIVERS = String.raw`^(filter\..+\.(clean|smudge|process)|diff\..+\.textconv|hook\..+\.command)$`

// The filters and converters git-lfs and git-crypt set up, which stay on when the program is the
// one installed (as your PATH finds it): Changes would show every file they keep as changed.
const KNOWN = /^"?([^"\s]+)"? (?:filter-process|clean|smudge|diff)(?: --skip| --key-name=[\w-]+| -- %f)*$/
const TOOLS = new Set(["git-lfs", "git-crypt"])

// Options git takes before its command, and those of them followed by a value.
const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"])

// Commands that only read names and objects: never a file's content through a filter or a
// converter, nor a ref or the index written (which runs hooks), so nothing settings name runs and
// they needn't be read first.
const PLAIN = new Set(["rev-parse", "for-each-ref", "rev-list", "config", "merge-base", "show-ref", "check-ignore", "ls-tree", "ls-files", "commit-tree", "write-tree", "pack-objects", "index-pack", "count-objects", "var"])

// Commands that convert a file for showing and take --no-textconv; and those that can't be told not to.
const CONVERTS = new Set(["blame", "annotate", "grep"])
const CONVERTING = new Set(["cat-file", "format-patch", "range-diff"])

/** `args` as git's own options (before its command) and the rest. */
function split(args: string[]): { lead: string[]; rest: string[] } {
  let at = 0
  while (at < args.length && args[at].startsWith("-")) at += VALUED.has(args[at]) ? 2 : 1
  return { lead: args.slice(0, at), rest: args.slice(at) }
}

function plain(rest: string[]): boolean {
  const [command, sub] = rest
  if (command === "cat-file") return !rest.some(each => /^--(filters|textconv|path)/.test(each))
  if (command === "ls-files") return !rest.some(each => /^(-[a-zA-Z]*m|--modified)/.test(each))
  // Read, not written: `symbolic-ref HEAD`, not `symbolic-ref HEAD refs/heads/x` or `-d`.
  if (command === "symbolic-ref") return rest.slice(1).filter(each => !each.startsWith("-")).length < 2 && !rest.some(each => each === "-d" || each === "--delete")
  if (command === "worktree") return sub === "list" || sub === "prune"
  if (command === "stash") return sub === "list"
  return PLAIN.has(command ?? "")
}

/** Where a command showing a diff takes its options (after `diff`, `log`, `show`, `stash show`), or -1. */
function showing(rest: string[]): number {
  if (["diff", "log", "show", "whatchanged"].includes(rest[0] ?? "")) return 1
  return rest[0] === "stash" && rest[1] === "show" ? 2 : -1
}

/** `rest` with the options a diff it shows takes: no diff program, nor (`converters`) converter. */
function withOptions(rest: string[], converters: boolean): string[] | undefined {
  const at = showing(rest)
  if (at >= 0) return [...rest.slice(0, at), "--no-ext-diff", ...(converters ? ["--no-textconv"] : []), ...rest.slice(at)]
  if (!converters) return rest
  if (CONVERTS.has(rest[0] ?? "")) return [rest[0], "--no-textconv", ...rest.slice(1)]
  return CONVERTING.has(rest[0] ?? "") ? undefined : rest
}

// Where PATH finds each of [TOOLS] here, as its real place (null: not installed), by PATH.
const installed = new Map<string, string | null>()
function found(tool: string): string | null {
  const key = `${process.env.PATH}\0${tool}`
  if (!installed.has(key)) {
    let place: string | null = null
    for (const folder of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      try {
        accessSync(join(folder, tool), constants.X_OK)
        place = realpathSync(join(folder, tool))
        break
      } catch {}
    }
    installed.set(key, place)
  }
  return installed.get(key) ?? null
}

/** Whether `value` runs git-lfs or git-crypt as installed here, to do what they set up. */
function known(value: string | undefined): boolean {
  const program = value?.match(KNOWN)?.[1]
  if (!program || !TOOLS.has(basename(program))) return false
  const place = found(basename(program))
  if (!place) return false
  if (!program.includes("/")) return true
  try {
    return realpathSync(program) === place
  } catch {
    return false
  }
}

// The `git config` read of the programs settings name, as git said it (its scope, each ended by a
// NUL, then its name, a newline and its value, ended by a NUL), and whether it says each one's
// scope (git before 2.26 can't).
const reading = (lead: string[], scoped: boolean) => [...lead, "config", ...(scoped ? ["--show-scope"] : []), "-z", "--get-regexp", DRIVERS]

interface Found { settings: string[]; converters: boolean }

/** What switches off what the read found: each hook, and the repository's own filters and
 * converters but git-lfs's and git-crypt's; undefined when one can't be (its name has an `=`,
 * which `-c` would read as its end). */
function switchedOff(read: string, scoped: boolean): Found | undefined {
  const parts = read.split("\0").filter(Boolean)
  const settings: string[] = []
  let converters = false
  for (let at = 0; at < parts.length; at += scoped ? 2 : 1) {
    const scope = scoped ? parts[at] : "local"
    const [name, value] = (scoped ? parts[at + 1] : parts[at])?.split(/\n(.*)/s) ?? []
    if (!name) continue
    const where = name.slice(0, name.lastIndexOf("."))
    if (name.startsWith("hook.")) {
      if (where.includes("=")) return undefined
      settings.push("-c", `${where}.enabled=false`)
      continue
    }
    if (scope === "system" || scope === "global" || scope === "command" || known(value)) continue
    if (name.startsWith("diff.")) {
      converters = true
      continue
    }
    if (name.includes("=")) return undefined
    settings.push("-c", `${name}=`, "-c", `${where}.required=false`)
  }
  return { settings, converters }
}

/** What the read said, or undefined (don't run it: the read failed, stopped or found what can't
 * be switched off); `retry` when git can't say scopes. No git at all: nothing to switch off (the
 * command fails as it would). */
function answer(code: number | string | null, out: string, scoped: boolean): Found | undefined | "retry" {
  if (code === 0) return switchedOff(out, scoped)
  if (code === 1 || code === "ENOENT") return { settings: [], converters: false }
  if (code === 129 && scoped) return "retry"
  return undefined
}

function built(lead: string[], rest: string[], found: Found | undefined | "retry"): string[] | undefined {
  if (!found || found === "retry") return undefined
  const shown = withOptions(rest, found.converters)
  return shown && [...lead, ...OWN, ...found.settings, ...shown]
}

const NOTHING: Found = { settings: [], converters: false }

// Where git takes a repository's common folder from (its settings, hooks, objects): its folder's
// `commondir`, when there's one. A repository's own folder names none, or itself (`.`, which Kuvo
// Code's sandbox gives one on Linux: fence/landlock.ts, MAKE_GIT), and a linked worktree's own
// folder (`<repository>/worktrees/<name>`) names the repository it's one of. One that leads anywhere
// else was put there to have git read another's settings and run its hooks, so the box runs no git
// there that could start a program (`strayCommon`).
const MOST_NAMED = 4096
const O_NONBLOCK = constants.O_NONBLOCK ?? 0
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

/** The real places a `commondir` in `folder` (the repository's or worktree's own folder git found)
 * names, and that it should name: [the folder, where it leads, the folder's repository's if it's a
 * worktree's own]. `named`, what the file says. */
const places = (folder: string, named: string) => [folder, resolve(folder, named.replace(/[\r\n]+$/, "")), dirname(dirname(folder))]

/** Whether a `commondir` leads where it should, from its places' real paths (null: not there). */
function leadsHome(folder: string, [own, common, above]: (string | null)[]): boolean {
  if (!own || !common) return false
  return common === own || (basename(dirname(own)) === "worktrees" && dirname(dirname(own)) === dirname(dirname(folder)) && above === common)
}

const realOrNull = (where: string) => { try { return realpathSync(where) } catch { return null } }

/** A `commondir` read only as a small regular file, never waiting on one (a FIFO put in its place):
 * what it says, null where there's none, undefined where it can't be read so. */
function readNamed(file: string): string | null | undefined {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MOST_NAMED) return undefined
    const buffer = Buffer.alloc(MOST_NAMED)
    return buffer.subarray(0, readSync(fd, buffer, 0, MOST_NAMED, 0)).toString("utf8")
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

async function readNamedLater(file: string): Promise<string | null | undefined> {
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(file, constants.O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MOST_NAMED) return undefined
    const buffer = Buffer.alloc(MOST_NAMED)
    const { bytesRead } = await handle.read(buffer, 0, MOST_NAMED, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

// (Asked of git itself, which finds the repository from `cwd` and the options before its command as
// it will for the command: a plain command, so nothing the repository names runs.)
const gitDirArgs = (lead: string[]) => [...lead, ...EVERY, "rev-parse", "--absolute-git-dir"]
// Commands that make a repository rather than work in one.
const MAKING = new Set(["clone", "init"])

/** Whether the repository git would work in, with `lead` from `cwd`, has a `commondir` that leads
 * anywhere but where it should (none, itself, or a worktree's repository). Not in one: no. */
function strayCommon(lead: string[], rest: string[], cwd?: string): boolean {
  if (MAKING.has(rest[0] ?? "")) return false
  const ran = spawnSync("git", gitDirArgs(lead), { cwd, encoding: "utf8", env: { ...process.env, ...GIT_QUIET }, timeout: 30_000 })
  const folder = ran.status === 0 ? String(ran.stdout ?? "").trim() : ""
  if (!folder) return false
  const named = readNamed(join(folder, "commondir"))
  if (named === null) return false
  return named === undefined || !leadsHome(folder, places(folder, named).map(realOrNull))
}

async function strayCommonLater(lead: string[], rest: string[], cwd?: string): Promise<boolean> {
  if (MAKING.has(rest[0] ?? "")) return false
  const folder = await new Promise<string>(done =>
    execFile("git", gitDirArgs(lead), { cwd, encoding: "utf8", env: { ...process.env, ...GIT_QUIET }, timeout: 30_000 }, (error, out) => done(error ? "" : String(out ?? "").trim())))
  if (!folder) return false
  const named = await readNamedLater(join(folder, "commondir"))
  if (named === null) return false
  if (named === undefined) return true
  return !leadsHome(folder, await Promise.all(places(folder, named).map(where => fsp.realpath(where).catch(() => null))))
}

/**
 * `args` as the box runs them by itself: [OWN], and the programs settings name switched off (read
 * first, unless the command never runs one). Undefined: don't run it (the
 * repository names a program it can't switch off, or its `commondir` leads elsewhere).
 */
export function ownArgs(args: string[], cwd?: string): string[] | undefined {
  const { lead, rest } = split(args)
  let found: Found | undefined | "retry" = NOTHING
  if (!plain(rest)) {
    if (strayCommon(lead, rest, cwd)) return undefined
    for (const scoped of [true, false]) {
      const ran = spawnSync("git", reading(lead, scoped), { cwd, encoding: "utf8", env: { ...process.env, ...GIT_QUIET }, timeout: 30_000 })
      found = answer((ran.error as NodeJS.ErrnoException | undefined)?.code ?? ran.status, String(ran.stdout ?? ""), scoped)
      if (found !== "retry") break
    }
  }
  return built(lead, rest, found)
}

/** [ownArgs], without holding up the bridge. */
export async function ownArgsLater(args: string[], cwd?: string): Promise<string[] | undefined> {
  const { lead, rest } = split(args)
  let found: Found | undefined | "retry" = NOTHING
  if (!plain(rest)) {
    if (await strayCommonLater(lead, rest, cwd)) return undefined
    for (const scoped of [true, false]) {
      found = await new Promise<Found | undefined | "retry">(resolve =>
        execFile("git", reading(lead, scoped), { cwd, encoding: "utf8", env: { ...process.env, ...GIT_QUIET }, timeout: 30_000 }, (error, out) =>
          resolve(answer(error ? (error.code ?? 128) : 0, String(out ?? ""), scoped))))
      if (found !== "retry") break
    }
  }
  return built(lead, rest, found)
}

/** `args` as you asked for them, from `cwd`: [EVERY], the repository's hooks, filters and sign-ins as
 * they are. Undefined: don't run it (its `commondir` leads elsewhere, so they'd be another's). */
export function askedArgs(args: string[], cwd?: string): string[] | undefined {
  const { lead, rest } = split(args)
  if (strayCommon(lead, rest, cwd)) return undefined
  return [...lead, ...EVERY, ...(withOptions(rest, false) ?? rest)]
}

/** [askedArgs], without holding up the bridge. */
export async function askedArgsLater(args: string[], cwd?: string): Promise<string[] | undefined> {
  const { lead, rest } = split(args)
  if (await strayCommonLater(lead, rest, cwd)) return undefined
  return [...lead, ...EVERY, ...(withOptions(rest, false) ?? rest)]
}
