// Kuvo Code's own tools (the side panel's browser, show_in_panel, messages to other agents), as
// the app serves them to the engine: on this Mac an MCP server of the app's, which the bridge gives
// each agent with the session it's for in a header; on a machine the program its engine starts for
// them (`kuvo-browser.js mcp`, with the machine's own browser), which each agent starts the same
// way, with its session in KUVO_SESSION. Either way, what a tool asks goes to that conversation.

import { spawn } from "node:child_process"

export interface ToolServer {
  url: string
  token: string
  /** How long a call may take, in milliseconds (one that asks you waits for you). */
  timeout: number
}

/** On a machine: the program, as the machine's engine has it in its settings (`mcp.servers`). */
export interface ToolProgram {
  command: string[]
  environment: Record<string, string>
  /** How long a call may take, in milliseconds. */
  timeout: number
}

let server: ToolServer | undefined
let program: ToolProgram | undefined

export function setToolServer(value: ToolServer | undefined) {
  server = value
}

export const toolServerName = "kuvo-browser"

/**
 * On a machine: Kuvo Code's tools as the settings the app starts its engine with name them
 * (`OPENCODE_CONFIG_CONTENT`), if they do.
 */
export function setToolProgram(settings: string | undefined) {
  program = undefined
  try {
    const entry = JSON.parse(settings ?? "")?.mcp?.servers?.[toolServerName]
    if (!Array.isArray(entry?.command) || !entry.command.length || !entry.command.every((part: unknown) => typeof part === "string")) return
    const environment: Record<string, string> = {}
    for (const [name, value] of Object.entries(entry.environment ?? {})) if (typeof value === "string") environment[name] = value
    program = { command: entry.command, environment, timeout: Number(entry.timeout?.execution) || 960_000 }
  } catch {}
}

/** Kuvo Code's tools as an agent reaches them for one session: a server, or a program it starts. */
export type KuvoTools = {
  name: string
  /** Which tools these are: different ones (the app started again) are reached again. */
  key: string
  timeout: number
} & ({ kind: "http"; url: string; headers: Record<string, string> } | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> })

/** Kuvo Code's tools, as an agent reaches them for `sessionID`; none until the app says where they are. */
export function kuvoTools(sessionID: string): KuvoTools | undefined {
  if (server) return { kind: "http", name: toolServerName, key: server.url, url: server.url, headers: { Authorization: `Bearer ${server.token}`, "X-Kuvo-Session": sessionID }, timeout: server.timeout }
  if (program) {
    const [command, ...args] = program.command
    return { kind: "stdio", name: toolServerName, key: JSON.stringify(program), command: command!, args, env: { ...program.environment, KUVO_SESSION: sessionID }, timeout: program.timeout }
  }
  return undefined
}

/** Kuvo Code's tools as its server lists them: each one's name, and the arguments it takes. */
let schemas: { key: string; tools: Map<string, Set<string>> } | undefined
let loading: Promise<void> | undefined

/** Reads the list of tools (once for each server or program), for telling their calls from an agent's own. */
export function loadKuvoTools(): Promise<void> {
  const tools = kuvoTools("")
  if (!tools || schemas?.key === tools.key) return Promise.resolve()
  loading ??= (async () => {
    try {
      const answer: any = tools.kind === "http" ? await listOverHTTP(tools) : await listFromProgram(tools)
      const found = new Map<string, Set<string>>()
      for (const tool of answer?.result?.tools ?? []) if (typeof tool?.name === "string") found.set(tool.name, new Set(Object.keys(tool.inputSchema?.properties ?? {})))
      if (found.size) schemas = { key: tools.key, tools: found }
    } catch {}
  })().finally(() => (loading = undefined))
  return loading
}

async function listOverHTTP(tools: Extract<KuvoTools, { kind: "http" }>): Promise<unknown> {
  const response = await fetch(tools.url, {
    method: "POST",
    headers: { ...tools.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(5_000),
  })
  return response.json()
}

/** Starts the program for a moment and asks it, as an agent would. */
function listFromProgram(tools: Extract<KuvoTools, { kind: "stdio" }>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.command, tools.args, { env: { ...process.env, ...tools.env }, stdio: ["pipe", "pipe", "ignore"] })
    const timer = setTimeout(() => finish(new Error("Kuvo Code's tools didn't answer.")), 15_000)
    let buffered = ""
    let done = false
    function finish(result: unknown) {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    child.on("error", finish)
    child.on("exit", () => finish(new Error("Kuvo Code's tools stopped.")))
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk
      let end: number
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        try {
          const message = JSON.parse(line)
          if (message?.id === 2) return finish(message)
        } catch {}
      }
    })
    const write = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n")
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kuvo-agents", version: "1" } } })
    write({ jsonrpc: "2.0", method: "notifications/initialized" })
    write({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  })
}

/** Whether Kuvo Code's tools have one by this name (undefined: their list isn't known yet). */
export function isKuvoTool(name: string): boolean | undefined {
  return schemas ? schemas.tools.has(name) : undefined
}

/**
 * The app's name for a call of one of Kuvo Code's tools (`kuvo-browser_show_widget`), for an
 * agent that names it only as itself ("show_widget"): one it has by that name, called with
 * arguments it takes (an agent's own tool can share a name: Antigravity has a send_message).
 */
export function kuvoToolName(name: string, args: Record<string, unknown>): string | undefined {
  const known = schemas?.tools.get(name)
  if (!known) return undefined
  return Object.keys(args).every((key) => known.has(key)) ? `${toolServerName}_${name}` : undefined
}
