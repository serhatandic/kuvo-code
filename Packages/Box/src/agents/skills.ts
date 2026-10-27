// The skills Settings › Skills lists, for the coding agents too: the engine's (the skills folder
// beside its settings, the folders and catalogs you named under Other Places, a project's
// .opencode/skills, and what it finds in ~/.claude/skills and ~/.agents/skills), but those you
// turned off, and those an agent finds on its own anyway. Each agent gets them its own way, from
// one folder the bridge makes for them in its home (`skills/<set>`), of copies of the skills'
// folders (Grok doesn't follow links): a plugin to Claude Code and Grok (`.claude-plugin`, `skills/`), extra skills to Codex,
// a folder of the workspace to Cursor (`.cursor/skills`), and Antigravity's own skills folder in
// its home. Nothing goes in your folders, nor the agents' own.

import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import type { TurnHooks } from "./agent"
import type { EngineLink } from "./engine"

export interface Skill {
  name: string
  /** Its folder (where its SKILL.md is). */
  folder: string
}

let link: EngineLink | undefined
let home: string | undefined

/** Where the engine is (it lists the skills), and the bridge's home (where their folders go). */
export function setSkillSource(engine: EngineLink, folder: string) {
  link = engine
  home = folder
}

const listed = new Map<string, { at: number; skills: Promise<Skill[]> }>()
/** What the engine last said, by folder: the skills' own folders (an agent reading one isn't working outside the project). */
const said = new Map<string, Skill[]>()

/** Every skill's folder the engine has listed, for any project. */
export function skillFolders(): string[] {
  return [...new Set([...said.values()].flat().map((skill) => skill.folder))]
}

/** The engine's skills for a project's folder, as Settings › Skills lists them: asked once a minute at most. */
export function engineSkills(directory: string): Promise<Skill[]> {
  const known = listed.get(directory)
  if (known && Date.now() - known.at < 60_000) return known.skills
  const skills = (async () => {
    if (!link?.ready) return []
    try {
      const answer: any = await link.request("GET", "/api/skill", undefined, 10_000, directory)
      const list: any[] = Array.isArray(answer?.data) ? answer.data : Array.isArray(answer) ? answer : []
      const found: Skill[] = []
      for (const skill of list) {
        const name = typeof skill?.name === "string" ? skill.name : typeof skill?.id === "string" ? skill.id : undefined
        const path = typeof skill?.path === "string" ? skill.path : undefined
        // The engine's own (`/builtin/…`) are for its agent, not these.
        if (!name || !path || path.startsWith("/builtin/") || !path.endsWith("SKILL.md") || !existsSync(path)) continue
        found.push({ name, folder: dirname(path) })
      }
      // None yet (the engine answers so while it's still looking, as it starts): asked again next time.
      if (!list.length) listed.delete(directory)
      said.set(directory, found)
      return found
    } catch {
      // Not now (the engine restarting): asked again next time.
      listed.delete(directory)
      return []
    }
  })()
  listed.set(directory, { at: Date.now(), skills })
  return skills
}

/** Forgets what the engine said, for a skill added or turned off just now. */
export function forgetSkills() {
  listed.clear()
}

/** The folder and the folders above it, to the top. */
export function upward(directory: string): string[] {
  const folders: string[] = []
  let at = resolve(directory)
  while (true) {
    folders.push(at)
    const up = dirname(at)
    if (up === at) return folders
    at = up
  }
}

/** It's in one of these folders. */
export function within(path: string, folders: string[]): boolean {
  return folders.some((folder) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep))
}

/**
 * The skills for an agent in a session: the engine's for its folder, but those your rules turn off
 * (`off`) and those in folders the agent reads skills from itself (`own`).
 */
export async function skillsFor(directory: string, own: string[], off: (name: string) => boolean): Promise<Skill[]> {
  const seen = new Set<string>()
  const skills: Skill[] = []
  for (const skill of await engineSkills(directory)) {
    if (seen.has(skill.name) || off(skill.name) || within(skill.folder, own)) continue
    seen.add(skill.name)
    skills.push(skill)
  }
  return skills
}

/** Turned off in Settings › Skills (a rule denying it), or by a rule of the session's. */
export function turnedOff(hooks: TurnHooks): (name: string) => boolean {
  return (name) => hooks.check({ action: "skill", resources: [name] }) === "deny"
}

/** A skill's name as a folder's: what can't be in one goes. */
function folderName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "skill"
}

/** Larger skills aren't copied (one that big carries more than instructions and scripts). */
const largest = 20 * 1024 * 1024

/**
 * What a skill's folder holds now, in a few words (how many files, how big, changed when): a
 * copy made of another is made again. Undefined for one too large to copy, or unreadable.
 */
function stamp(folder: string): string | undefined {
  let files = 0
  let size = 0
  let changed = 0
  const visit = (at: string, depth: number): boolean => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      const info = statSync(path)
      changed = Math.max(changed, info.mtimeMs)
      if (info.isDirectory()) {
        if (depth < 8 && !visit(path, depth + 1)) return false
      } else {
        files += 1
        size += info.size
        if (size > largest || files > 2_000) return false
      }
    }
    return true
  }
  try {
    return visit(folder, 0) ? `${files}:${size}:${Math.round(changed)}` : undefined
  } catch {
    return undefined
  }
}

/** Each skill under the name its copy has, and what it holds now; too large or unreadable ones left out. */
function named(skills: Skill[]): { name: string; skill: Skill; stamp: string }[] {
  const names = new Set<string>()
  const list: { name: string; skill: Skill; stamp: string }[] = []
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const now = stamp(skill.folder)
    if (!now) continue
    let name = folderName(skill.name)
    for (let n = 2; names.has(name); n++) name = `${folderName(skill.name)}-${n}`
    names.add(name)
    list.push({ name, skill, stamp: now })
  }
  return list
}

/** A copy of a skill's folder (links in it followed: some agents don't follow them). */
function copy(from: string, to: string): boolean {
  try {
    cpSync(from, to, { recursive: true, dereference: true, errorOnExist: false, force: true })
    return true
  } catch {
    rmSync(to, { recursive: true, force: true })
    return false
  }
}

/**
 * A folder of copies of `skills`, made once for each set as they are: `skills/`, the plugin's
 * manifest beside it, and `.cursor/skills` linking to it. Undefined for none.
 */
export function skillsFolder(skills: Skill[]): string | undefined {
  if (!home || !skills.length) return undefined
  const list = named(skills)
  if (!list.length) return undefined
  const set = createHash("sha256").update(list.map((entry) => `${entry.name}\0${entry.skill.folder}\0${entry.stamp}`).join("\n")).digest("hex").slice(0, 16)
  const root = join(home, "skills")
  const folder = join(root, set)
  const now = new Date()
  if (existsSync(join(folder, ".claude-plugin", "plugin.json"))) {
    // In use: kept from the tidying below.
    try {
      utimesSync(folder, now, now)
    } catch {}
    return folder
  }
  tidy(root)
  const making = join(root, `.${set}-${process.pid}`)
  rmSync(making, { recursive: true, force: true })
  mkdirSync(join(making, "skills"), { recursive: true, mode: 0o700 })
  mkdirSync(join(making, ".claude-plugin"), { recursive: true })
  mkdirSync(join(making, ".cursor"), { recursive: true })
  for (const entry of list) copy(entry.skill.folder, join(making, "skills", entry.name))
  writeFileSync(
    join(making, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "kuvo-code", description: "The skills in Kuvo Code's Settings › Skills.", version: "1.0.0" }, null, 2) + "\n",
  )
  symlinkSync(join("..", "skills"), join(making, ".cursor", "skills"))
  try {
    renameSync(making, folder)
  } catch {
    // Made meanwhile, by another session.
    rmSync(making, { recursive: true, force: true })
  }
  return folder
}

/** Sets not used for a day go. */
function tidy(root: string) {
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(root, name)
    try {
      if (Date.now() - statSync(path).mtimeMs > 86_400_000) rmSync(path, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Copies of `skills` in a folder an agent reads its own skills from (Antigravity's, in its home,
 * which is Kuvo Code's): made to match, the copies it put there before named in `.kuvo-code`
 * (anything else in it stays). Says what's there, for telling one set from another.
 */
export function copySkillsInto(folder: string, skills: Skill[]): string | undefined {
  const list = named(skills)
  const record = join(folder, ".kuvo-code")
  let before: Record<string, string> = {}
  try {
    before = JSON.parse(readFileSync(record, "utf8"))
  } catch {}
  const after: Record<string, string> = {}
  for (const entry of list) after[entry.name] = `${entry.skill.folder}\0${entry.stamp}`
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    for (const name of Object.keys(before)) if (before[name] !== after[name]) rmSync(join(folder, folderName(name)), { recursive: true, force: true })
    for (const entry of list) {
      if (before[entry.name] === after[entry.name] && existsSync(join(folder, entry.name))) continue
      if (!existsSync(join(folder, entry.name)) && !copy(entry.skill.folder, join(folder, entry.name))) delete after[entry.name]
    }
    writeFileSync(record, JSON.stringify(after))
  }
  return list.length ? createHash("sha256").update(JSON.stringify(after)).digest("hex").slice(0, 16) : undefined
}
