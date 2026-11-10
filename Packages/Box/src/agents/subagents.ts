// Your subagents (Settings › Agents, and a project's own agents) and the one model they use
// (Settings › Agents, "Subagents use"), for the coding agents that have subagents of their own, each
// its own way: Claude Code's are given to it as it starts (its `agents`, which win over one of the
// same name in ~/.claude/agents, as its --agents flag does), with the model in
// CLAUDE_CODE_SUBAGENT_MODEL; Codex's as roles in the thread's settings (`agents.<role>`, a file of
// instructions each) with `agents.default_subagent_model`; Grok's as a plugin of its own (its agents
// are named `kuvo:<name>` there); Cursor's in its SDK's `agents`; Antigravity's in its home's
// custom agents folder, which is Kuvo Code's. The engine's own subagents get the model from the
// link (shared/subagents.ts). Each takes a model only from those it can run: a model of another
// maker's leaves its subagents on the conversation's.
//
// The agents come from the engine, as it has them for the conversation's folder; the model from
// this box's settings file, which the engine doesn't read. Nothing goes in your folders, nor the
// agents' own: files, where an agent needs them, are in the bridge's home (`subagents/<set>`).

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseProvider, type AgentKind } from "./accounts"
import type { EngineLink } from "./engine"
import { machineHome, onMachine } from "./machine"
import { holdsBack, matches } from "./rules"
import type { ModelRef, PermissionRule } from "./wire"
import { ENGINE_AGENTS, modelRef, subagentModel } from "../shared/subagents"

/** One of your subagents, as the engine has it for a folder. */
export interface Subagent {
  name: string
  description: string
  /** What it's told. */
  prompt: string
  /** Its own model, or the one subagents use (the engine has it so). */
  model?: ModelRef
  /** What it may do, as the engine reads it (its defaults, then your rules for it). */
  permissions: PermissionRule[]
}

export interface Subagents {
  agents: Subagent[]
  /** The model subagents use here (none: the conversation's). */
  model?: ModelRef
}

let link: EngineLink | undefined
let home: string | undefined
let file: string | undefined

/**
 * Where the engine is (it lists the agents), the bridge's home (where an agent's files for them go)
 * and this box's settings file (`settings`; by default where the box keeps it: this Mac's in its
 * engine's settings folder, KUVO_ENGINE_CONFIG; a machine's in its box's folder).
 */
export function setSubagentSource(engine: EngineLink, folder: string, settings = settingsFile()) {
  link = engine
  home = folder
  file = settings
}

/** This box's settings file, as it keeps it. */
export function settingsFile(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.KUVO_ENGINE_CONFIG) return join(env.KUVO_ENGINE_CONFIG, "opencode", "opencode.json")
  if (onMachine && machineHome) return join(machineHome, "box", "opencode.json")
  return undefined
}

/** The model subagents use, as the settings file says now (a small file, read as each turn starts). */
function settingModel(): ModelRef | undefined {
  if (!file) return undefined
  try {
    return modelRef(subagentModel(JSON.parse(readFileSync(file, "utf8"))))
  } catch {
    return undefined
  }
}

/** Your subagents for a conversation's folder, and the model they use: none while the engine can't say. */
export async function subagentsFor(directory: string): Promise<Subagents> {
  const model = settingModel()
  const listed = link?.ready ? await link.agents(directory).catch(() => undefined) : undefined
  const agents: Subagent[] = []
  for (const entry of listed ?? []) {
    const name = typeof entry?.id === "string" ? entry.id : undefined
    if (!name || ENGINE_AGENTS.has(name) || entry.hidden === true || entry.disabled === true) continue
    if (entry.mode !== "subagent" && entry.mode !== "all") continue
    const description = typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : name
    const prompt = typeof entry.system === "string" ? entry.system.trim() : ""
    const own = entry.model && typeof entry.model.id === "string" && typeof entry.model.providerID === "string" ? { id: entry.model.id, providerID: entry.model.providerID } : undefined
    // (One of the engine's has the model subagents use already, where it has none of its own: the
    // engine has it so. One of a coding agent's, which the engine doesn't take, is put on it here.)
    agents.push({ name, description, prompt, model: own ?? model, permissions: Array.isArray(entry.permissions) ? entry.permissions : [] })
  }
  return { agents, model }
}

/** The makers' own providers in the engine, whose models an agent of theirs runs too. */
const makers: Partial<Record<AgentKind, string>> = { claude: "anthropic", codex: "openai", grok: "xai" }

/** A model as `kind` runs it, if it can: one of its own accounts' (any of them), or its maker's. */
export function nativeModel(kind: AgentKind, ref: ModelRef | undefined): string | undefined {
  if (!ref || !ref.id || ref.id === "default") return undefined
  if (parseProvider(ref.providerID)?.kind === kind || makers[kind] === ref.providerID) return ref.id
  return undefined
}

/** Antigravity's subagents take a tier, not a model: Flash or Pro, as its own model's name says. */
export function antigravityTier(ref: ModelRef | undefined): "flash" | "pro" | undefined {
  const id = nativeModel("antigravity", ref) ?? (ref?.providerID === "google" ? ref.id : undefined)
  if (!id) return undefined
  if (/flash/i.test(id)) return "flash"
  if (/\bpro\b|-pro/i.test(id)) return "pro"
  return undefined
}

/** The last of your rules for an action, whatever it's about: it decides the action wherever no later one does. */
function wholly(rules: PermissionRule[], action: string): boolean {
  const last = rules.filter((rule) => matches(rule.action, action)).at(-1)
  return Boolean(last && last.resource === "*" && holdsBack(last.effect))
}

/** Claude Code's tools for each of Kuvo Code's actions. */
const claudeTools: Record<string, string[]> = {
  edit: ["Edit", "MultiEdit", "Write", "NotebookEdit"],
  shell: ["Bash"],
  read: ["Read", "Glob", "Grep", "LS"],
  webfetch: ["WebFetch"],
  websearch: ["WebSearch"],
  subagent: ["Agent", "Task"],
}

/** Claude Code's tools an agent's rules take away whole (one it may use for some things stays, and is asked about each time). */
export function claudeDisallowed(rules: PermissionRule[]): string[] {
  return Object.entries(claudeTools).flatMap(([action, tools]) => (wholly(rules, action) ? tools : []))
}

/** Your subagents as Claude Code's `agents`, and the model its others use (CLAUDE_CODE_SUBAGENT_MODEL), if it runs it. */
export function claudeSubagents(subagents: Subagents): { agents: Record<string, Record<string, unknown>>; model?: string } {
  const agents: Record<string, Record<string, unknown>> = {}
  for (const agent of subagents.agents) {
    const model = nativeModel("claude", agent.model)
    const disallowed = claudeDisallowed(agent.permissions)
    agents[agent.name] = {
      description: agent.description,
      prompt: agent.prompt || agent.description,
      ...(model ? { model } : {}),
      ...(disallowed.length ? { disallowedTools: disallowed } : {}),
    }
  }
  return { agents, model: nativeModel("claude", subagents.model) }
}

/** Your subagents as Cursor's SDK takes them (`agents`): with a model of Cursor's, or the conversation's. */
export function cursorSubagents(subagents: Subagents): Record<string, Record<string, unknown>> {
  const agents: Record<string, Record<string, unknown>> = {}
  for (const agent of subagents.agents) {
    const model = nativeModel("cursor", agent.model)
    agents[agent.name] = { description: agent.description, prompt: agent.prompt || agent.description, model: model ? { id: model } : "inherit" }
  }
  return agents
}

/** A name as a file's (letters, digits, `_` and `-`), or a Codex role's (`_` between words, as its own). */
function slug(name: string, separator = "-"): string {
  return (
    name
      .toLowerCase()
      .replace(separator === "_" ? /[^a-z0-9_]+/g : /[^a-z0-9_-]+/g, separator)
      .replace(/^[-_]+|[-_]+$/g, "") || "agent"
  )
}

/** Each agent's slug, made unique. */
function named(agents: Subagent[], separator = "-"): { agent: Subagent; slug: string }[] {
  const taken = new Set<string>()
  return agents.map((agent) => {
    const base = slug(agent.name, separator)
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base}${separator}${n}`
    taken.add(name)
    return { agent, slug: name }
  })
}

/** A string as TOML and YAML both read it (a double-quoted one, escapes and all). */
const quoted = (text: string) => JSON.stringify(text)

/** The `[agents]` settings that aren't roles: a role can't be called one of them. */
const codexReserved = new Set(["enabled", "max_threads", "max_concurrent_threads_per_session", "max_depth", "default_subagent_model", "default_subagent_reasoning_effort", "interrupt_message", "job_max_runtime_seconds"])

/**
 * Your subagents as Codex's roles, in a thread's settings: each `agents.<role>` with its
 * description and a file of its instructions (and its model, and no shell when it may run no
 * commands), and the model its other subagents use. `key` tells one set from another.
 */
export function codexSubagents(subagents: Subagents): { config: Record<string, unknown>; key: string } {
  const config: Record<string, unknown> = {}
  const files: Record<string, string> = {}
  const roles: { role: string; agent: Subagent }[] = []
  for (const { agent, slug: role } of named(subagents.agents, "_")) {
    const name = codexReserved.has(role) ? `${role}_agent` : role
    const model = nativeModel("codex", agent.model)
    const lines = [`developer_instructions = ${quoted(agent.prompt || agent.description)}`, ...(model ? [`model = ${quoted(model)}`] : [])]
    if (wholly(agent.permissions, "shell")) lines.push("", "[features]", "shell_tool = false")
    files[`${name}.toml`] = lines.join("\n") + "\n"
    roles.push({ role: name, agent })
  }
  const folder = setFolder("codex", files)
  if (folder) {
    for (const { role, agent } of roles) {
      config[`agents.${role}.description`] = agent.description
      config[`agents.${role}.config_file`] = join(folder, `${role}.toml`)
    }
  }
  const model = nativeModel("codex", subagents.model)
  if (model) config["agents.default_subagent_model"] = model
  return { config, key: JSON.stringify(config) }
}

/** Your subagents as a plugin of Grok's (`kuvo`): an agent's file each, with its model if Grok runs it. Undefined for none. */
export function grokSubagents(subagents: Subagents): string | undefined {
  const files: Record<string, string> = {}
  for (const { agent, slug: file } of named(subagents.agents)) {
    const model = nativeModel("grok", agent.model)
    files[join("agents", `${file}.md`)] = frontMatter({ name: agent.name, description: agent.description, ...(model ? { model } : {}) }, agent.prompt)
  }
  if (!Object.keys(files).length) return undefined
  files[join(".claude-plugin", "plugin.json")] = JSON.stringify({ name: "kuvo", description: "The subagents in Kuvo Code's Settings › Agents.", version: "1.0.0" }, null, 2) + "\n"
  return setFolder("grok", files)
}

/**
 * Your subagents in a folder Antigravity reads its custom agents from (its home's, which is Kuvo
 * Code's): made to match, the files it put there before named in `.kuvo-code` (anything else in it
 * stays). Says what's there, for telling one set from another.
 */
export function antigravityCustomAgents(folder: string, subagents: Subagents): string | undefined {
  const after: Record<string, string> = {}
  for (const { agent, slug: file } of named(subagents.agents)) {
    const tier = antigravityTier(agent.model)
    after[`${file}.md`] = frontMatter({ name: agent.name, description: agent.description, subagent: true, mainAgent: false, ...(tier ? { model: tier } : {}) }, agent.prompt)
  }
  const record = join(folder, ".kuvo-code")
  let before: Record<string, string> = {}
  try {
    before = JSON.parse(readFileSync(record, "utf8"))
  } catch {}
  const stamps = Object.fromEntries(Object.entries(after).map(([name, text]) => [name, createHash("sha256").update(text).digest("hex").slice(0, 16)]))
  if (JSON.stringify(before) !== JSON.stringify(stamps)) {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    for (const name of Object.keys(before)) if (!(name in after)) rmSync(join(folder, name), { force: true })
    for (const [name, text] of Object.entries(after)) writeFileSync(join(folder, name), text)
    writeFileSync(record, JSON.stringify(stamps))
  }
  return Object.keys(after).length ? createHash("sha256").update(JSON.stringify(stamps)).digest("hex").slice(0, 16) : undefined
}

/** An agent's file: its settings between `---` lines, then what it's told. */
function frontMatter(fields: Record<string, string | boolean>, body: string): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${typeof value === "string" ? quoted(value) : value}`)
  return ["---", ...lines, "---", "", body, ""].join("\n")
}

/** The rules of a subagent of yours, by its name (as Claude Code says which agent a tool is for). */
export function subagentRules(subagents: Subagents | undefined, name: unknown): PermissionRule[] | undefined {
  if (typeof name !== "string") return undefined
  return subagents?.agents.find((agent) => agent.name === name)?.permissions
}

/** Where the files for subagents go: a folder for each set, kept a day after its last use. */
export const subagentsRoot = (): string | undefined => (home ? join(home, "subagents") : undefined)

/** A folder of `files`, made once for each set as they are; undefined for none. */
function setFolder(kind: string, files: Record<string, string>): string | undefined {
  const root = subagentsRoot()
  if (!root || !Object.keys(files).length) return undefined
  const names = Object.keys(files).sort()
  const set = createHash("sha256").update(names.map((name) => `${name}\0${files[name]}`).join("\0\0")).digest("hex").slice(0, 16)
  const folder = join(root, `${kind}-${set}`)
  const now = new Date()
  if (existsSync(join(folder, ".complete"))) {
    // In use: kept from the tidying below.
    try {
      utimesSync(folder, now, now)
    } catch {}
    return folder
  }
  tidy(root)
  const making = join(root, `.${kind}-${set}-${process.pid}`)
  rmSync(making, { recursive: true, force: true })
  for (const name of names) {
    mkdirSync(join(making, name, ".."), { recursive: true, mode: 0o700 })
    writeFileSync(join(making, name), files[name])
  }
  writeFileSync(join(making, ".complete"), "")
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
