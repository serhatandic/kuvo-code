// git as the box runs it in a repository (PROTOCOL.md, "Git"): a repository's own settings (its
// `.git/config`, and what that includes) never start a program on their own, since whoever could
// write in the folder (a download, an agent let outside the sandbox) could have put one there.
// Every git the box runs gets no fsmonitor, pager, external diff or signature check, and finds no
// bare repository by sitting in its folder. What the box does by itself (reading the changes,
// keeping snapshots and backups) also runs no hooks, signing or credential helpers, nor the
// filters and diff converters the repository names. What you ask git for yourself (Commit, Push
// or Pull in Changes, a worktree) runs its hooks, filters and sign-ins as your terminal would.
// Your own settings (`~/.gitconfig`) count as yours throughout.

import { execFile, spawnSync } from "node:child_process"

/** What every git the box runs gets. */
export const EVERY = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "log.showSignature=false", "-c", "safe.bareRepository=explicit"]

/** And what the box runs by itself. */
export const OWN = [...EVERY, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "credential.helper="]

/** Never asking anything. */
export const GIT_QUIET = { GIT_TERMINAL_PROMPT: "0" }

// The programs a repository can name for a file by its attributes, that git would run for the
// box: a filter (switched off by an empty setting) and a diff's converter (by --no-textconv, as
// an empty one fails). (A diff program is never run: diffs get --no-ext-diff. A merge program
// runs only in merges you ask for.)
const DRIVERS = String.raw`^(filter\..+\.(clean|smudge|process)|diff\..+\.textconv)$`

// Options git takes before its command, and those of them followed by a value.
const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"])

// Commands that read or write only names and objects, never a file's content through a filter
// or a converter: nothing the repository names runs, so its settings needn't be read first.
const PLAIN = new Set(["rev-parse", "symbolic-ref", "for-each-ref", "rev-list", "update-ref", "config", "merge-base", "show-ref", "branch", "check-ignore", "ls-tree", "ls-files", "commit-tree", "write-tree", "init", "pack-objects", "index-pack", "count-objects", "remote", "repack", "gc", "fetch", "reflog", "var"])

// Commands that would convert a file for showing, and take no --no-textconv.
const CONVERTING = new Set(["blame", "annotate", "grep", "cat-file", "format-patch", "range-diff"])

/** `args` as git's own options (before its command) and the rest. */
function split(args: string[]): { lead: string[]; rest: string[] } {
  let at = 0
  while (at < args.length && args[at].startsWith("-")) at += VALUED.has(args[at]) ? 2 : 1
  return { lead: args.slice(0, at), rest: args.slice(at) }
}

function plain(rest: string[]): boolean {
  const [command, sub] = rest
  if (command === "cat-file") return !rest.some(each => /^--(filters|textconv|path)/.test(each))
  if (command === "worktree") return sub === "list" || sub === "prune"
  if (command === "stash") return sub === "list" || sub === "store"
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
  if (at < 0) return converters && CONVERTING.has(rest[0] ?? "") ? undefined : rest
  return [...rest.slice(0, at), "--no-ext-diff", ...(converters ? ["--no-textconv"] : []), ...rest.slice(at)]
}

// The `git config` read of the programs the repository names, as git said it (scope and name,
// each ended by a NUL), and whether it says each one's scope (git before 2.26 can't).
const reading = (lead: string[], scoped: boolean) => [...lead, "config", ...(scoped ? ["--show-scope"] : []), "--name-only", "-z", "--get-regexp", DRIVERS]

interface Found { settings: string[]; converters: boolean }

/** What switches off what the read found; undefined when a filter can't be (its name has an `=`,
 * which `-c` would read as its end). */
function switchedOff(found: string, scoped: boolean): Found | undefined {
  const parts = found.split("\0").filter(Boolean)
  const settings: string[] = []
  let converters = false
  for (let at = 0; at < parts.length; at += scoped ? 2 : 1) {
    const scope = scoped ? parts[at] : "local"
    const name = scoped ? parts[at + 1] : parts[at]
    if (!name || scope === "system" || scope === "global" || scope === "command") continue
    if (name.startsWith("diff.")) {
      converters = true
      continue
    }
    if (/[=\n]/.test(name)) return undefined
    settings.push("-c", `${name}=`, "-c", `${name.slice(0, name.lastIndexOf("."))}.required=false`)
  }
  return { settings, converters }
}

/** What the read said, or undefined (don't run it: the read failed, stopped or found what can't
 * be switched off); `retry` when git can't say scopes. */
function answer(code: number | null, out: string, scoped: boolean): Found | undefined | "retry" {
  if (code === 0) return switchedOff(out, scoped)
  if (code === 1) return { settings: [], converters: false }
  if (code === 129 && scoped) return "retry"
  return undefined
}

function built(lead: string[], rest: string[], found: Found | undefined | "retry"): string[] | undefined {
  if (!found || found === "retry") return undefined
  const shown = withOptions(rest, found.converters)
  return shown && [...lead, ...OWN, ...found.settings, ...shown]
}

const NOTHING: Found = { settings: [], converters: false }

/**
 * `args` as the box runs them by itself: [OWN], and the programs the repository's own settings
 * name switched off (read first, unless the command never runs one). Undefined: don't run it (the
 * repository names a program it can't switch off).
 */
export function ownArgs(args: string[], cwd?: string): string[] | undefined {
  const { lead, rest } = split(args)
  let found: Found | undefined | "retry" = NOTHING
  if (!plain(rest)) {
    for (const scoped of [true, false]) {
      const ran = spawnSync("git", reading(lead, scoped), { cwd, encoding: "utf8", env: { ...process.env, ...GIT_QUIET }, timeout: 30_000 })
      found = answer(ran.status, String(ran.stdout ?? ""), scoped)
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
    for (const scoped of [true, false]) {
      found = await new Promise<Found | undefined | "retry">(resolve =>
        execFile("git", reading(lead, scoped), { cwd, encoding: "utf8", env: { ...process.env, ...GIT_QUIET }, timeout: 30_000 }, (error, out) =>
          resolve(answer(error ? (typeof error.code === "number" ? error.code : 128) : 0, String(out ?? ""), scoped))))
      if (found !== "retry") break
    }
  }
  return built(lead, rest, found)
}

/** `args` as you asked for them: [EVERY], the repository's hooks, filters and sign-ins as they are. */
export function askedArgs(args: string[]): string[] {
  const { lead, rest } = split(args)
  return [...lead, ...EVERY, ...(withOptions(rest, false) ?? rest)]
}
