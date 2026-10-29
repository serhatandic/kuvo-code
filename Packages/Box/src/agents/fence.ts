// The box's sandbox, as the coding agents' own programs run their commands in it (PROTOCOL.md,
// "Sandbox"): the rules the box writes for its launcher (`run/fence/policy.json`), while it has the
// sandbox on here (`run/fence/on`). Each agent puts them in its own terms: Codex as a permission
// profile of its own sandbox.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { machineHome } from "./machine"

/** What commands may do: everything read but `hidden`; written only in the session's folder and
 * `writable`; inside those, `readOnly` only read; `readable`, inside `hidden`, read. */
export interface FenceRules {
  hidden: string[]
  readable: string[]
  writable: string[]
  readOnly: string[]
}

/** The box's sandbox folder: this Mac's (the app names it), or a machine's in `~/.kuvo-code`. */
const folder = () => process.env.KUVO_FENCE ?? (machineHome ? join(machineHome, "run", "fence") : undefined)

/** The box's rules, while its sandbox is on here; undefined when it's off, or can't be read. */
export function fenceRules(): FenceRules | undefined {
  const where = folder()
  if (!where || process.env.KUVO_SANDBOX === "off" || !existsSync(join(where, "on"))) return undefined
  try {
    const read = JSON.parse(readFileSync(join(where, "policy.json"), "utf8"))
    const paths = (value: unknown) => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string" && each.startsWith("/")) : [])
    return { hidden: paths(read.hidden), readable: paths(read.readable), writable: paths(read.writable), readOnly: paths(read.readOnly) }
  } catch {
    return undefined
  }
}

const real = (place: string) => {
  try {
    return realpathSync(place)
  } catch {
    return place
  }
}

/**
 * The folders you let a project's commands write in too (Also Allowed, `link/fence/allowed.ts`), as
 * the box tells its launcher: by its real path's sum, one a line. Each by the real path it was
 * given: one that's become a link since isn't.
 */
export function allowedFolders(directory: string): string[] {
  const where = folder()
  if (!where) return []
  const sum = createHash("sha256").update(real(directory)).digest("hex").slice(0, 32)
  try {
    return readFileSync(join(where, "allowed", sum), "utf8").split("\n").filter((line) => line.startsWith("/") && real(line) === line).slice(0, 8)
  } catch {
    return []
  }
}

/** What changes with the rules, to tell when an agent's program must start again with new ones. */
export const fenceKey = () => JSON.stringify(fenceRules() ?? null)

/**
 * In a git worktree, the parts of its repository's own folder a commit writes (`objects`, `refs`,
 * `logs`, and the worktree's own folder in it), which are outside the session's folder; none in a
 * repository's own checkout, whose `.git` is in it, or outside one.
 */
export function worktreeGitFolders(directory: string): string[] {
  const read = spawnSync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], { encoding: "utf8", timeout: 10_000 })
  if (read.status !== 0) return []
  const [common, own] = read.stdout.trim().split("\n")
  if (!common || !own || common === own) return []
  return [join(common, "objects"), join(common, "refs"), join(common, "logs"), own]
}
