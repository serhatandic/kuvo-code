// Words for voice input to listen for: a speech model (Whisper) is prompted with what you're
// likely to say, and in a conversation that's its project's own names. The box has the
// conversation's folder, so it picks them, for the engine's sessions and the coding agents' alike
// (PROTOCOL.md, "Side questions, handoffs and reviews"): the folder's name, the names said in the
// conversation lately, the project's packages, the files changed lately, then the rest of its
// files and folders. Quick, and never anything that looks like a secret.

import { readdirSync, type Dirent } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { GoalPlace, GoalPlaces } from "./goals"
import { messages, sessionInfo } from "./oneoff"
import { runGit } from "./proc"

/** The words a client gets, at most. */
export const wordLimit = 100
/** A word longer than this isn't one anyone says. */
const wordLength = 40
/** The project's files looked at, at most. */
const fileLimit = 4_000
/** The conversation's newest messages read. */
const messageLimit = 30
/** A manifest bigger than this isn't read. */
const manifestLimit = 256_000

export class VoiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class VoiceWords {
  constructor(private readonly places: GoalPlaces) {}

  private place(session: string): GoalPlace {
    return this.places.isBridge(session) ? this.places.bridge : this.places.engine
  }

  /** The words to listen for in `session`, most useful first. */
  async words(session: string): Promise<string[]> {
    const { api } = this.place(session)
    const info = await sessionInfo(api, session).catch((error: any) => {
      throw new VoiceError(error?.status === 404 ? 404 : 503, error?.status === 404 ? "There's no such conversation here." : "The conversation can't be reached now.")
    })
    if (!info.directory) throw new VoiceError(409, "That conversation has no folder.")
    const [said, project] = await Promise.all([messages(api, session, messageLimit).catch(() => []), readProject(info.directory)])
    return pickWords(info.directory, said, project)
  }
}

/** What the words are picked from in a project's folder. */
export interface Project {
  /** Its files, as paths in it. */
  files: string[]
  /** Those changed lately, newest first: not committed yet, then the latest commits'. */
  changed: string[]
  /** The repository's own name, when the folder is a worktree or a folder in it. */
  repository?: string
  /** Its packages' names, its own first. */
  packages: string[]
  dependencies: string[]
}

async function git(directory: string, args: string[]): Promise<string | undefined> {
  const ran = await runGit(["-C", directory, ...args], { timeout: 5_000 }).catch(() => undefined)
  return ran && ran.code === 0 && !ran.timedOut ? ran.stdout : undefined
}

export async function readProject(directory: string): Promise<Project> {
  const [listed, uncommitted, committed, common] = await Promise.all([
    git(directory, ["ls-files", "-co", "--exclude-standard", "-z"]),
    git(directory, ["diff", "--name-only", "--relative", "-z", "HEAD"]),
    git(directory, ["log", "-n", "15", "--name-only", "--relative", "--format=", "-z"]),
    git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ])
  const split = (out?: string) => (out ?? "").split(/[\0\n]/).filter(Boolean)
  const files = (listed !== undefined ? [...new Set(split(listed))] : walk(directory)).filter((file) => !secret.test(file)).slice(0, fileLimit)
  const changed = [...new Set([...split(uncommitted), ...split(committed)])].filter((file) => !secret.test(file))
  const top = common?.trim()
  const repository = top && basename(top) === ".git" ? basename(dirname(top)) : undefined
  const { packages, dependencies } = await readManifests(directory, files)
  return { files, changed, repository, packages, dependencies }
}

/** The files in a folder that isn't a repository, the shallowest first: all but hidden ones and `node_modules`. */
function walk(top: string): string[] {
  const found: string[] = []
  let level = [""]
  for (let depth = 0; depth < 5 && level.length && found.length < fileLimit; depth++) {
    const next: string[] = []
    for (const folder of level) {
      let entries: Dirent[]
      try {
        entries = readdirSync(join(top, folder), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (found.length >= fileLimit) break
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue
        const name = folder ? `${folder}/${entry.name}` : entry.name
        if (entry.isDirectory()) next.push(name)
        else if (entry.isFile()) found.push(name)
      }
    }
    level = next
  }
  return found
}

/** Files named for secrets (`.env`, `.env.local`): never read, never named. */
const secret = /(^|\/)\.env(\.[^/]*)?$/

/** The packages' names in its manifests near the top (package.json, Package.swift, Cargo.toml). */
async function readManifests(directory: string, files: string[]) {
  const packages: string[] = []
  const dependencies: string[] = []
  const manifests = files.filter((file) => /(^|\/)(package\.json|Package\.swift|Cargo\.toml)$/.test(file) && file.split("/").length <= 3 && !file.includes("node_modules/"))
  manifests.sort((a, b) => a.split("/").length - b.split("/").length)
  for (const file of manifests.slice(0, 8)) {
    const path = join(directory, file)
    const text = await stat(path).then((kind) => (kind.isFile() && kind.size <= manifestLimit ? readFile(path, "utf8") : undefined)).catch(() => undefined)
    if (!text) continue
    if (file.endsWith("package.json")) {
      try {
        const json = JSON.parse(text)
        if (typeof json?.name === "string") packages.push(json.name)
        for (const key of ["dependencies", "devDependencies", "peerDependencies"]) if (json?.[key] && typeof json[key] === "object") dependencies.push(...Object.keys(json[key]))
      } catch {}
    } else if (file.endsWith("Package.swift")) {
      // Its package, products and targets, but its test targets.
      for (const match of text.matchAll(/\bname:\s*"([^"]{1,60})"/g)) if (!/Tests$/.test(match[1])) packages.push(match[1])
      for (const match of text.matchAll(/\.package\(\s*url:\s*"[^"]*\/([^"/]+?)(?:\.git)?"/g)) dependencies.push(match[1])
    } else {
      let section = ""
      for (const line of text.split("\n")) {
        const header = line.match(/^\s*\[([^\]]+)\]/)
        if (header) {
          section = header[1].trim()
          continue
        }
        const entry = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)
        if (!entry) continue
        if (section === "package" && entry[1] === "name") packages.push(line.split("=")[1].trim().replace(/^["']|["']$/g, ""))
        if (/(^|\.)(dev-|build-)?dependencies$/.test(section)) dependencies.push(entry[1])
      }
    }
  }
  return { packages: packages.flatMap(packageForms), dependencies: dependencies.flatMap(packageForms) }
}

/** `@scope/name` as people say it: the name, then the scope. */
function packageForms(name: string): string[] {
  const scoped = name.match(/^@([^/]+)\/(.+)$/)
  return scoped ? [scoped[2], scoped[1]] : [name]
}

/** File extensions that make a dotted word a file's name, not `object.property`. */
const extensions = new Set("ts tsx js jsx mjs cjs json md mdx swift rs py go rb java kt kts c h m mm cpp hpp cs css scss html vue svelte yml yaml toml sh zsh sql xml plist txt lock gradle php ex exs dart lua zig astro".split(" "))

/** A long hex or random-looking run, a key's or a hash's: never a word to listen for. */
export function looksSecret(word: string): boolean {
  if (/^(sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|AKIA|AIza)[-_]?[A-Za-z0-9]/.test(word) && word.length >= 16) return true
  if (/[0-9a-f]{12,}/i.test(word) && /\d/.test(word.match(/[0-9a-f]{12,}/i)![0])) return true
  const digits = word.replace(/\D/g, "").length
  if (word.length >= 20 && digits >= 3 && /[A-Z]/.test(word) && /[a-z]/.test(word)) return true
  return /[A-Za-z0-9+/]{24,}={0,2}$/.test(word) && digits >= 2
}

/** Whether a word from a conversation looks like a name in code: camelCase, PascalCase with two humps or more, or snake_case. */
function isIdentifier(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) && (/[a-z][A-Z]/.test(word) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(word))
}

/** The names a text says: identifiers, and files by their names (`src/timer.ts` says `timer.ts`). */
export function namesIn(text: string): string[] {
  const names: string[] = []
  // Not links, and of a path only its file's name (the folders it's in, a temporary folder's or
  // your home's, aren't the project's).
  const plain = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").replace(/[^\s`'"()<>[\]{},;]*[/\\]([^\s`'"()<>[\]{},;/\\]*)/g, " $1")
  for (const match of plain.matchAll(/[A-Za-z0-9_][A-Za-z0-9_.-]*/g)) {
    const token = match[0].replace(/[.-]+$/, "")
    if (!token) continue
    const dot = token.lastIndexOf(".")
    if (dot > 0 && extensions.has(token.slice(dot + 1).toLowerCase()) && /[A-Za-z]/.test(token.slice(0, dot)) && dot >= 2) {
      names.push(token)
      continue
    }
    for (const part of token.split(".")) if (isIdentifier(part)) names.push(part)
  }
  return names
}

/** What a message says that names things: your words, the agent's, and what its tools were given (not what they returned). */
function textsOf(message: any): string[] {
  if (message?.type === "user") return [String(message.text ?? "")]
  if (message?.type !== "assistant") return []
  const texts: string[] = []
  for (const part of message.content ?? []) {
    if (part?.type === "text" && typeof part.text === "string") texts.push(part.text)
    if (part?.type === "tool") {
      // Its input's values, not its keys (`filePath`); a tool that touched a secrets file: none of it.
      const input = Object.values(part.state?.input ?? {}).filter((value) => typeof value === "string").join("\n")
      if (!/(^|[\s/"'])\.env\b/.test(input)) texts.push(input.slice(0, 2_000))
    }
  }
  return texts
}

/** A file's names: its name, and without its extension (`timer.ts`, `timer`). */
function fileForms(path: string): string[] {
  const name = basename(path)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? [name, name.slice(0, dot)] : [name]
}

/** The words for a project's folder, from its conversation's messages (oldest first) and its files, most useful first. */
export function pickWords(directory: string, said: any[], project: Project): string[] {
  const picked: string[] = []
  const seen = new Set<string>()
  const add = (word: string) => {
    const trimmed = word.trim()
    const key = trimmed.toLowerCase()
    if (picked.length >= wordLimit || trimmed.length < 2 || trimmed.length > wordLength || trimmed.startsWith(".") || seen.has(key)) return
    if (secret.test(trimmed) || looksSecret(trimmed) || !/[A-Za-z]/.test(trimmed)) return
    seen.add(key)
    picked.push(trimmed)
  }

  // The folder's name, and the repository's when it's a worktree or a folder in one.
  add(basename(directory))
  if (project.repository) add(project.repository)

  // What the conversation says lately: the names said most first, the newest first among those.
  const byName = new Map<string, string[]>()
  const byStem = new Map<string, string[]>()
  for (const file of project.files) {
    const [name, stem] = fileForms(file)
    byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), file])
    if (stem) byStem.set(stem.toLowerCase(), [...(byStem.get(stem.toLowerCase()) ?? []), file])
  }
  const counts = new Map<string, { word: string; count: number; last: number }>()
  const words = said.flatMap(textsOf).flatMap(namesIn)
  for (const [index, word] of words.entries()) {
    const key = word.toLowerCase()
    const known = counts.get(key)
    counts.set(key, { word: known?.word ?? word, count: (known?.count ?? 0) + 1, last: index })
  }
  // A word that's a file's name, or the name of one without its extension, said in passing ("the timer").
  for (const match of said.flatMap(textsOf).join(" ").matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
    const key = match[0].toLowerCase()
    if (!counts.has(key) && byStem.has(key)) counts.set(key, { word: match[0], count: 1, last: -1 })
  }
  for (const { word } of [...counts.values()].sort((a, b) => b.count - a.count || b.last - a.last)) {
    add(word)
    const files = byName.get(word.toLowerCase()) ?? byStem.get(word.toLowerCase()) ?? []
    for (const file of files.slice(0, 2)) for (const form of fileForms(file)) add(form)
  }

  // Its own packages, the files changed lately, its top-level folders and files.
  for (const name of project.packages.slice(0, 20)) add(name)
  for (const file of project.changed.slice(0, 30)) for (const form of fileForms(file)) add(form)
  const folders = new Map<string, number>()
  for (const file of project.files) {
    const parts = file.split("/")
    for (let depth = 1; depth < parts.length; depth++) if (!folders.has(parts.slice(0, depth).join("/"))) folders.set(parts.slice(0, depth).join("/"), depth)
  }
  const atDepth = (depth: number) => [
    ...[...folders].filter(([, at]) => at === depth).map(([folder]) => [basename(folder)]),
    ...project.files.filter((file) => file.split("/").length === depth).map(fileForms),
  ]
  for (const forms of atDepth(1)) for (const form of forms) add(form)
  // What it's built with, then the rest, the shallowest first.
  for (const name of project.dependencies) add(name)
  const deepest = Math.max(0, ...project.files.map((file) => file.split("/").length))
  for (let depth = 2; depth <= deepest && picked.length < wordLimit; depth++) for (const forms of atDepth(depth)) for (const form of forms) add(form)
  return picked
}

// MARK: Routes (`/api/kuvo/voice`, which a client reaches as `kuvo/agents/api/kuvo/voice`)

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

export async function voiceRoutes(voice: VoiceWords | undefined, method: string, parts: string[]): Promise<Response> {
  if (!voice) return json({ message: "Voice words aren't running on this computer." }, 503)
  const [what, session] = parts
  if (what !== "words" || !session || parts.length > 2) return json({ message: "Not found" }, 404)
  if (method !== "GET") return json({ message: "Not allowed" }, 405)
  if (!/^ses_[A-Za-z0-9_]+$/.test(session)) return json({ message: "There's no such conversation here." }, 404)
  try {
    return json({ data: { words: await voice.words(session) } })
  } catch (error) {
    if (error instanceof VoiceError) return json({ message: error.message }, error.status)
    throw error
  }
}
