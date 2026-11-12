// The computer's MCP servers, for the coding agents as for the engine's models: those the engine
// has for a conversation's folder (Settings › MCP Servers and Settings › Integrations, a project's
// own, and a bot's folder's, with its own keys), as the engine reads them, keys in. Each agent
// reaches them through the bridge's relay (toolrelay.ts), which starts a command's server in the
// box's sandbox with its keys, and adds a URL's headers and sign-in on the way: the agent itself is
// given neither.

import { isAbsolute } from "node:path"
import type { EngineLink } from "./engine"
import { toolServerName } from "./kuvotools"

/** One of the computer's servers, as the relay runs or reaches it. */
export type ComputerServer = {
  name: string
  /** How long a call may take, in milliseconds. */
  timeout: number
} & ({ kind: "remote"; url: string; headers: Record<string, string>; /** When your sign-in to it runs out (ms), if it's one. */ expires?: number } | { kind: "local"; command: string[]; env: Record<string, string>; cwd?: string })

/** A conversation's servers, and what tells one set of them from another as agents see them (their
 * names): an agent's is started anew for another set, but not for a key or sign-in renewed, which
 * only the relay holds. */
export interface ComputerServers {
  servers: ComputerServer[]
  key: string
}

let link: EngineLink | undefined

/** Where the engine is, which reads its settings for each folder. */
export function setServerSource(engine: EngineLink) {
  link = engine
}

/** A server's name as every agent's settings take it (Codex's are dotted keys, Claude's tool names
 * have no dots). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const none: ComputerServers = { servers: [], key: "" }
const read = new Map<string, { at: number; servers: Promise<ComputerServers> }>()

/**
 * The servers the engine has for `directory`, read again at most every few seconds (each agent's
 * turn asks), or now (`fresh`: a sign-in ran out); the last ones known while the engine can't say
 * (it's starting again), none before. Those turned off aren't, nor Kuvo Code's own tools, which
 * each agent is given anyway.
 */
export function computerServers(directory: string, fresh = false): Promise<ComputerServers> {
  const known = read.get(directory)
  if (known && !fresh && Date.now() - known.at < 5_000) return known.servers
  const servers = readServers(directory).catch(() => known?.servers ?? none)
  read.set(directory, { at: Date.now(), servers })
  return servers
}

/** What's known is read again (a test's own settings). */
export function forgetServers() {
  read.clear()
}

async function readServers(directory: string): Promise<ComputerServers> {
  if (!link?.ready) throw new Error("The engine isn't running.")
  const at = (path: string) => `${path}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
  // Its settings, in the order it reads them (this computer's, then the folder's), each server
  // named in a later one in place of an earlier one's.
  const answer: any = await link.request("GET", at("/api/config"), undefined, 10_000)
  const layers: any[] = Array.isArray(answer) ? answer : Array.isArray(answer?.data) ? answer.data : []
  const named = new Map<string, any>()
  for (const layer of layers) {
    const servers = layer?.info?.mcp?.servers
    if (servers && typeof servers === "object" && !Array.isArray(servers)) for (const [name, entry] of Object.entries(servers)) named.set(name, entry)
  }
  const servers: ComputerServer[] = []
  // (URLs' servers that can be signed in to, by name.)
  const signing = new Set<string>()
  for (const [name, entry] of named) {
    if (name === toolServerName || !NAME.test(name) || !entry || typeof entry !== "object" || entry.disabled === true || entry.enabled === false) continue
    const timeout = Number(entry.timeout?.execution) > 0 ? Number(entry.timeout.execution) : 300_000
    if (entry.type === "local" && Array.isArray(entry.command) && entry.command.length && entry.command.every((part: unknown) => typeof part === "string")) {
      servers.push({ name, kind: "local", command: entry.command, env: strings(entry.environment), ...(typeof entry.cwd === "string" && isAbsolute(entry.cwd) ? { cwd: entry.cwd } : {}), timeout })
    } else if (entry.type === "remote" && typeof entry.url === "string" && /^https?:\/\//.test(entry.url)) {
      servers.push({ name, kind: "remote", url: entry.url, headers: strings(entry.headers), timeout })
      if (entry.oauth !== false) signing.add(name)
    }
  }
  await signIn(servers.filter((server) => signing.has(server.name)), at)
  return { servers, key: servers.map((server) => server.name).sort().join(" ") }
}

/**
 * A server that turned down an agent's call (its sign-in or key refused): the engine connects it
 * again, for `directory` and its own, so it renews your sign-in if it can, or finds that it can't,
 * and Settings › Integrations says it needs signing in again.
 */
export async function reconnectServer(directory: string, name: string) {
  if (!link?.ready) return
  const connect = `/api/experimental/mcp/${encodeURIComponent(name)}/connect`
  await link.request("POST", `${connect}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`, {}, 30_000).catch(() => {})
  await link.request("POST", connect, {}, 30_000).catch(() => {})
}

const strings = (value: unknown): Record<string, string> => {
  const found: Record<string, string> = {}
  if (value && typeof value === "object" && !Array.isArray(value)) for (const [name, text] of Object.entries(value)) if (typeof text === "string") found[name] = text
  return found
}

/**
 * A URL's server you signed in to in Settings (its maker's sign-in, which the engine keeps and
 * renews): its sign-in added, as the engine sends it, unless its settings give one of their own.
 * One that ran out is renewed by the engine first (connecting it again).
 */
async function signIn(servers: ComputerServer[], at: (path: string) => string) {
  const signing = servers.filter((server): server is Extract<ComputerServer, { kind: "remote" }> => server.kind === "remote" && !Object.keys(server.headers).some((name) => name.toLowerCase() === "authorization"))
  if (!signing.length || !link) return
  const listed: any = await link.request("GET", at("/api/mcp"), undefined, 10_000).catch(() => undefined)
  const integrations = new Map<string, string>()
  for (const server of Array.isArray(listed?.data) ? listed.data : Array.isArray(listed) ? listed : []) if (typeof server?.name === "string" && typeof server.integrationID === "string") integrations.set(server.name, server.integrationID)
  if (!signing.some((server) => integrations.has(server.name))) return
  const credentials = async () => {
    const answer: any = await link!.request("GET", "/api/credential", undefined, 10_000).catch(() => undefined)
    return (Array.isArray(answer?.data) ? answer.data : []) as any[]
  }
  const accessFor = (list: any[], integration: string) => list.find((each) => each?.integrationID === integration && each.active && each.value?.type === "oauth" && typeof each.value.access === "string")?.value
  let list = await credentials()
  for (const server of signing) {
    const integration = integrations.get(server.name)
    if (!integration) continue
    let value = accessFor(list, integration)
    if (value && Number(value.expires) > 0 && Number(value.expires) < Date.now() + 60_000) {
      await link.request("POST", at(`/api/experimental/mcp/${encodeURIComponent(server.name)}/connect`), {}, 30_000).catch(() => {})
      list = await credentials()
      value = accessFor(list, integration)
    }
    if (!value) continue
    server.headers = { ...server.headers, Authorization: `Bearer ${value.access}` }
    if (Number(value.expires) > 0) server.expires = Number(value.expires)
  }
}
