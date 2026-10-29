// Kuvo Code's tools for an agent run whole in the box's sandbox (Codex, while it's on): on
// 127.0.0.1, over MCP's HTTP, each session by a key of its own, passed on to the tools as an agent
// outside it reaches them (`kuvoTools`). On this Mac, the app's server; on a machine, the program,
// which runs here, outside the sandbox: it talks to the machine's browser, in Kuvo Code's folder,
// which the sandbox hides. Each call is its session's, whatever it says (a command in the sandbox
// could name another's).

import { randomBytes } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { kuvoTools, type KuvoTools } from "./kuvotools"

let server: ReturnType<typeof Bun.serve> | undefined
/** Each session's key, and the session each key is for. */
const keys = new Map<string, string>()
const sessionsByKey = new Map<string, string>()
/** On a machine: each session's program, started as its agent first reaches its tools. */
const programs = new Map<string, Program>()

/** Kuvo Code's tools as an agent in the sandbox reaches them for `sessionID`, through the relay; none until the app says where they are. */
export function relayedTools(sessionID: string): Extract<KuvoTools, { kind: "http" }> | undefined {
  const tools = kuvoTools(sessionID)
  if (!tools) return undefined
  server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: answer })
  let key = keys.get(sessionID)
  if (!key) {
    key = randomBytes(24).toString("hex")
    keys.set(sessionID, key)
    sessionsByKey.set(key, sessionID)
  }
  return { kind: "http", name: tools.name, key: tools.key, timeout: tools.timeout, url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${key}` } }
}

/** The relay's port, once it listens. */
export const relayPort = (): number | undefined => server?.port

/** A session's agent is done with its tools: its key goes, and its program stops. */
export function dropRelayed(sessionID: string) {
  const key = keys.get(sessionID)
  if (key) sessionsByKey.delete(key)
  keys.delete(sessionID)
  programs.get(sessionID)?.stop()
  programs.delete(sessionID)
}

async function answer(request: Request): Promise<Response> {
  const key = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
  const sessionID = key ? sessionsByKey.get(key) : undefined
  if (!sessionID) return new Response("Not allowed.", { status: 401 })
  const tools = kuvoTools(sessionID)
  if (!tools) return new Response("Kuvo Code's tools aren't here now.", { status: 503 })
  let body: any
  if (request.method === "POST") {
    try {
      body = ownSession(await request.json(), sessionID)
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
    }
  }
  if (tools.kind === "http") {
    const headers: Record<string, string> = { ...tools.headers, Accept: request.headers.get("accept") ?? "application/json, text/event-stream" }
    for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
      const value = request.headers.get(name)
      if (value) headers[name] = value
    }
    try {
      // Given up with the agent's own request; a call, not a stream of what comes, after the tools' time.
      const signal = request.method === "POST" ? AbortSignal.any([request.signal, AbortSignal.timeout(tools.timeout)]) : request.signal
      const response = await fetch(tools.url, { method: request.method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal })
      const back = new Headers()
      for (const name of ["content-type", "mcp-session-id"]) {
        const value = response.headers.get(name)
        if (value) back.set(name, value)
      }
      return new Response(response.body, { status: response.status, headers: back })
    } catch {
      return new Response("Kuvo Code's tools didn't answer.", { status: 502 })
    }
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
  let program = programs.get(sessionID)
  if (!program || program.stopped || program.key !== tools.key) {
    program?.stop()
    program = new Program(tools)
    programs.set(sessionID, program)
  }
  const messages: any[] = Array.isArray(body) ? body : [body]
  // Each of its connections (Codex has one a thread) by a name of the relay's, given as it starts:
  // their requests are told apart by it.
  const starts = messages.some((message) => message?.method === "initialize")
  const connection = starts ? randomBytes(12).toString("hex") : (request.headers.get("mcp-session-id") ?? "")
  const answers = await Promise.all(messages.map((message) => program!.send(message, tools.timeout, connection)))
  const replies = answers.filter((each) => each !== undefined)
  const headers = starts ? { "mcp-session-id": connection } : undefined
  if (!replies.length) return new Response(null, { status: 202, headers })
  return Response.json(Array.isArray(body) ? replies : replies[0], { headers })
}

/** A message with its calls named as the session's own, whatever they said. */
function ownSession(body: any, sessionID: string): any {
  const each = (message: any) => {
    if (message?.method !== "tools/call" || typeof message.params !== "object" || !message.params) return message
    return { ...message, params: { ...message.params, _meta: { ...(message.params._meta ?? {}), "ai.opencode/sessionID": sessionID } } }
  }
  return Array.isArray(body) ? body.map(each) : each(body)
}

/**
 * A session's program (`kuvo-browser.js mcp`), which each of its agent's connections share (Codex
 * has one a thread): their requests numbered anew here, so theirs never meet.
 */
class Program {
  readonly key: string
  stopped = false
  private child: ChildProcess
  private next = 1
  private waiting = new Map<number, { id: unknown; done: (message: unknown) => void }>()
  /** Each connection's request, as the program knows it (for a cancel). */
  private ours = new Map<string, number>()

  constructor(tools: Extract<KuvoTools, { kind: "stdio" }>) {
    this.key = tools.key
    this.child = spawn(tools.command, tools.args, { env: { ...process.env, ...tools.env }, stdio: ["pipe", "pipe", "ignore"] })
    this.child.on("error", () => this.stop())
    this.child.on("exit", () => this.stop())
    let buffered = ""
    this.child.stdout!.setEncoding("utf8")
    this.child.stdout!.on("data", (chunk: string) => {
      buffered += chunk
      let end: number
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const waiting = typeof message?.id === "number" ? this.waiting.get(message.id) : undefined
        if (!waiting) continue
        this.waiting.delete(message.id)
        waiting.done({ ...message, id: waiting.id })
      }
    })
  }

  /** Sends a connection's message; a request's answer comes back (undefined for a notification). */
  send(message: any, timeout: number, connection: string): Promise<unknown> {
    if (this.stopped) return Promise.resolve(message?.id === undefined ? undefined : failed(message.id, "Kuvo Code's tools stopped."))
    if (message?.id === undefined || message.id === null) {
      // A cancel names the request as the program knows it.
      const requestId = message?.params?.requestId
      const ours = requestId === undefined ? undefined : this.ours.get(connection + " " + JSON.stringify(requestId))
      if (message?.method === "notifications/cancelled" && ours === undefined) return Promise.resolve(undefined)
      this.write(ours === undefined ? message : { ...message, params: { ...message.params, requestId: ours } })
      return Promise.resolve(undefined)
    }
    const id = this.next++
    const known = connection + " " + JSON.stringify(message.id)
    this.ours.set(known, id)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve(failed(message.id, "Kuvo Code's tools took too long."))
      }, timeout)
      this.waiting.set(id, {
        id: message.id,
        done: (answer) => {
          clearTimeout(timer)
          this.ours.delete(known)
          resolve(answer)
        },
      })
      this.write({ ...message, id })
    })
  }

  private write(message: unknown) {
    try {
      this.child.stdin!.write(JSON.stringify(message) + "\n")
    } catch {}
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.child.kill()
    for (const [, waiting] of this.waiting) waiting.done(failed(waiting.id, "Kuvo Code's tools stopped."))
    this.waiting.clear()
  }
}

const failed = (id: unknown, message: string) => ({ jsonrpc: "2.0", id, error: { code: -32603, message } })
