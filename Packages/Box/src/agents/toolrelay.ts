// Kuvo Code's tools for an agent run whole in the box's sandbox (Codex, while it's on): on
// 127.0.0.1, over MCP's HTTP, each session by a key of its own, passed on to the tools as an agent
// outside it reaches them (`kuvoTools`). On this Mac, the app's server; on a machine, the program,
// which runs here, outside the sandbox: it talks to the machine's browser, in Kuvo Code's folder,
// which the sandbox hides. Each call is its session's, whatever it says (a command in the sandbox
// could name another's).
//
// And the computer's MCP servers, for every agent, in the sandbox or not (servers.ts), each at
// `/mcp/<name>`: a command's server started for each of the agent's connections, in the box's
// sandbox (in the conversation's folder, as its commands are) with its keys in its environment; a
// URL's reached with its headers and sign-in added. The agent is given only the relay's address
// and its session's key.
//
// One that can't be reached, or turns down its sign-in, never stops the agent's turn: some agents
// (Antigravity) end their whole session when one server fails to start. The relay connects the
// agent to it anyway, as a server of no tools whose instructions say why (and a call to one that
// turns down its sign-in later says so as its result), so the agent goes on with the rest; the
// engine is told to connect it again, to renew the sign-in or find it needs one (which Settings ›
// Integrations then says). Once it's set right (you signed in again), its agent connects afresh.

import { randomBytes } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { dirname, join, relative } from "node:path"
import { fenceRules, fenceServer } from "./fence"
import { kuvoTools, type KuvoTools } from "./kuvotools"
import { onMachine, ownEnvironment } from "./machine"
import { computerServers, reconnectServer, type ComputerServer, type ComputerServers } from "./servers"

let server: ReturnType<typeof Bun.serve> | undefined
/** Each session's key, and the session each key is for. */
const keys = new Map<string, string>()
const sessionsByKey = new Map<string, string>()
/** On a machine: each session's program, started as its agent first reaches its tools. */
const programs = new Map<string, Program>()
/** What reaches each session's tools through the relay now (its agents' threads): its key stays while any does. */
const holders = new Map<string, Set<object>>()
/** Each session's servers of the computer's, by name, and the folder its commands run in. */
const served = new Map<string, { directory: string; servers: Map<string, ComputerServer> }>()
/** The command servers running, each for one of an agent's connections: by session, name and connection. */
const running = new Map<string, Program>()
/** The relay's own stand-ins for servers that couldn't be reached, by the connection it gave each
 * agent: the server, how it was set up then (`setup`), why it isn't there, and whether that's its
 * sign-in turned down (`signIn`: only another sign-in sets it right). */
const standIns = new Map<string, { sessionID: string; name: string; setup: string; why: string; signIn: boolean }>()
/** The engine asked to connect each session's server again, by session and name, for how it was
 * set up when it turned down its sign-in: once for each setup, however many calls it turns down. */
const refusals = new Map<string, { setup: string; asked: Promise<void> }>()
/** How many times each session's server was set right after the relay stood in for it, by name. */
const setRight = new Map<string, Map<string, number>>()
/** Whether each session's server that wasn't there answers now, being checked, by session and name: one check at a time. */
const checks = new Map<string, Promise<boolean>>()

/** How long a server has to start as an agent connects, before the agent goes on without it (some
 * give up their whole session well before a server's own time); a command's longer, as it may fetch
 * its package the first time. And how long an agent's next message waits for word on whether one
 * that wasn't there answers now (the check goes on without it, for the message after). */
export const relayTiming = { starts: 15_000, commandStarts: 30_000, check: 1_000 }

/** A command's server no connection has used for an hour is stopped (an agent that started again
 * has a new one), as the engine stops its own; one it comes back to it starts again. */
const IDLE = 60 * 60_000
setInterval(() => {
  for (const program of running.values()) if (Date.now() - program.used > IDLE) program.stop()
}, 5 * 60_000).unref()

/** An MCP server over HTTP, as an agent is given it. */
export interface RelayedServer {
  name: string
  url: string
  headers: Record<string, string>
  timeout: number
}

/** `holder` reaches `sessionID`'s tools or servers through the relay: its key (the relay listening). */
function hold(sessionID: string, holder: object): string {
  let held = holders.get(sessionID)
  if (!held) holders.set(sessionID, (held = new Set()))
  held.add(holder)
  relayPort()
  let key = keys.get(sessionID)
  if (!key) {
    key = randomBytes(24).toString("hex")
    keys.set(sessionID, key)
    sessionsByKey.set(key, sessionID)
  }
  return key
}

/**
 * Kuvo Code's tools as an agent in the sandbox reaches them for `sessionID`, through the relay,
 * held by `holder` (the agent's thread) until it drops them; none until the app says where they are.
 */
export function relayedTools(sessionID: string, holder: object): Extract<KuvoTools, { kind: "http" }> | undefined {
  const tools = kuvoTools(sessionID)
  if (!tools) return undefined
  const key = hold(sessionID, holder)
  return { kind: "http", name: tools.name, key: tools.key, timeout: tools.timeout, url: `http://127.0.0.1:${relayPort()}/mcp`, headers: { Authorization: `Bearer ${key}` } }
}

/**
 * The computer's servers for `sessionID`, whose commands run in `directory`, as its agent reaches
 * them through the relay, held by `holder` until it drops them: the relay's address for each, and
 * the session's key. What each runs or reaches is the latest given (a key you changed, a sign-in
 * renewed): a command's server already running for a connection goes on as it started.
 */
export function relayedServers(sessionID: string, holder: object, directory: string, found: ComputerServers): RelayedServer[] {
  // (Those set right since the relay stood in for them, noted.)
  retireChanged(sessionID, found)
  if (!found.servers.length) {
    served.delete(sessionID)
    return []
  }
  const key = hold(sessionID, holder)
  served.set(sessionID, { directory, servers: new Map(found.servers.map((each) => [each.name, each])) })
  // (One set right since the relay stood in for it at another address, so its agent connects afresh.)
  return found.servers.map((each) => {
    const times = setRight.get(sessionID)?.get(each.name)
    return { name: each.name, url: `http://127.0.0.1:${relayPort()}/mcp/${encodeURIComponent(each.name)}${times ? `?again=${times}` : ""}`, headers: { Authorization: `Bearer ${key}` }, timeout: each.timeout }
  })
}

/** How a server is set up: its address and headers (your sign-in), or its command and environment. */
const setupOf = (server: ComputerServer) => JSON.stringify(server.kind === "remote" ? [server.url, server.headers] : [server.command, server.env, server.cwd])

/**
 * What tells the computer's servers a session's agent is given now from those it was given, with
 * their names (`found.key`): a server the relay stood in for that's set right since counts as
 * another, so the agent is started again or told, and connects to it afresh. One whose sign-in was
 * turned down is set right by another (you signed in again, changed its key, or took it away); one
 * that couldn't be reached, or start, once it answers, which is checked now (briefly). Each agent's
 * thread asks as it decides that, at each turn.
 */
export async function serversKey(sessionID: string, found: ComputerServers): Promise<string> {
  retireChanged(sessionID, found)
  const waiting = new Set<Promise<boolean>>()
  for (const standIn of standIns.values()) {
    const now = found.servers.find((each) => each.name === standIn.name)
    if (standIn.sessionID !== sessionID || standIn.signIn || !now) continue
    const at = `${sessionID}\n${standIn.name}`
    let check = checks.get(at)
    if (!check) {
      const name = standIn.name
      check = answers(now, sessionID, served.get(sessionID)?.directory).then((started) => {
        checks.delete(at)
        if (started) retire(sessionID, name)
        return started
      })
      checks.set(at, check)
    }
    waiting.add(check)
  }
  // (Briefly: one that doesn't answer at once is checked on, for the next message.)
  if (waiting.size) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all(waiting), new Promise((resolve) => (timer = setTimeout(resolve, relayTiming.check)))])
    clearTimeout(timer)
  }
  const times = [...(setRight.get(sessionID) ?? [])].sort(([a], [b]) => a.localeCompare(b))
  return times.length ? `${found.key} ${JSON.stringify(times)}` : found.key
}

/** A session's servers the relay stood in for that are set up otherwise now (or gone), retired. */
function retireChanged(sessionID: string, found: ComputerServers) {
  for (const standIn of [...standIns.values()]) {
    if (standIn.sessionID !== sessionID) continue
    const now = found.servers.find((each) => each.name === standIn.name)
    if (!now || setupOf(now) !== standIn.setup) retire(sessionID, standIn.name)
  }
}

/** A session's server set right: the relay's stand-ins for it go, and its agent is given it at another address. */
function retire(sessionID: string, name: string) {
  let any = false
  for (const [connection, standIn] of standIns) if (standIn.sessionID === sessionID && standIn.name === name) any = standIns.delete(connection)
  if (!any) return
  let times = setRight.get(sessionID)
  if (!times) setRight.set(sessionID, (times = new Map()))
  times.set(name, (times.get(name) ?? 0) + 1)
}

/** Whether a server that wasn't there starts now (as an agent's start would have it): connected
 * to, and let go. */
async function answers(entry: ComputerServer, sessionID: string, directory: string | undefined): Promise<boolean> {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kuvo-code", version: "1" } } }
  if (entry.kind === "local") {
    if (!directory) return false
    const started = startServer(entry, sessionID, directory)
    if (typeof started === "string") return false
    const answer: any = await started.send(initialize, Math.min(entry.timeout, relayTiming.commandStarts), "check")
    started.stop()
    return Boolean(answer?.result) && !answer.error
  }
  try {
    const signal = AbortSignal.timeout(Math.min(entry.timeout, relayTiming.starts))
    const response = await fetchHere(entry.url, { method: "POST", headers: { ...entry.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(initialize), signal })
    const started = response.ok ? await readStart(response, 1) : { failure: `HTTP ${response.status}`, body: null }
    if (started.body instanceof ReadableStream) await started.body.cancel().catch(() => {})
    const session = response.headers.get("mcp-session-id")
    if (session) void fetchHere(response.url || entry.url, { method: "DELETE", headers: { ...entry.headers, "mcp-session-id": session }, signal: AbortSignal.timeout(relayTiming.starts) }).catch(() => {})
    return started.failure === undefined
  } catch {
    return false
  }
}

/** The relay's port (listening from then on). */
export const relayPort = (): number => (server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: answer })).port!

/**
 * `holder` is done with a session's tools: once nothing else holds them (another of its agents'
 * threads, an account's or a provider's), its key goes, and its programs and servers stop.
 */
export function dropRelayed(sessionID: string, holder: object) {
  const held = holders.get(sessionID)
  held?.delete(holder)
  if (held?.size) return
  holders.delete(sessionID)
  const key = keys.get(sessionID)
  if (key) sessionsByKey.delete(key)
  keys.delete(sessionID)
  programs.get(sessionID)?.stop()
  programs.delete(sessionID)
  served.delete(sessionID)
  for (const [at, program] of running) if (at.startsWith(sessionID + "\n")) program.stop()
  for (const [connection, standIn] of standIns) if (standIn.sessionID === sessionID) standIns.delete(connection)
  for (const at of refusals.keys()) if (at.startsWith(sessionID + "\n")) refusals.delete(at)
}

async function answer(request: Request): Promise<Response> {
  const key = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
  const sessionID = key ? sessionsByKey.get(key) : undefined
  if (!sessionID) return new Response("Not allowed.", { status: 401 })
  const path = new URL(request.url).pathname
  if (path.startsWith("/mcp/")) {
    let name: string
    try {
      name = decodeURIComponent(path.slice("/mcp/".length))
    } catch {
      return new Response("No such server here.", { status: 404 })
    }
    return answerServer(request, sessionID, name)
  }
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
  if (tools.kind === "http") return forward(request, tools.url, tools.headers, tools.timeout, body === undefined ? undefined : JSON.stringify(body), "Kuvo Code's tools didn't answer.")
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
  let program = programs.get(sessionID)
  if (!program || program.stopped || program.key !== tools.key) {
    program?.stop()
    program = new Program({ key: tools.key, command: tools.command, args: tools.args, env: { ...process.env, ...tools.env }, name: "Kuvo Code's tools" })
    programs.set(sessionID, program)
  }
  const messages: any[] = Array.isArray(body) ? body : [body]
  // Each of its connections (Codex has one a thread) by a name of the relay's, given as it starts:
  // their requests are told apart by it.
  const starts = messages.some((message) => message?.method === "initialize")
  const connection = starts ? randomBytes(12).toString("hex") : (request.headers.get("mcp-session-id") ?? "")
  return sendAll(program, body, tools.timeout, connection, starts)
}

/** A request on to a server over HTTP, with `headers`; what it answers, back. */
async function forward(request: Request, url: string, headers: Record<string, string>, timeout: number, body: string | undefined, failed: string): Promise<Response> {
  const sent: Record<string, string> = { ...headers, Accept: request.headers.get("accept") ?? "application/json, text/event-stream" }
  for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
    const value = request.headers.get(name)
    if (value) sent[name] = value
  }
  try {
    // Given up with the agent's own request; a call, not a stream of what comes, after the server's time.
    const signal = request.method === "POST" ? AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]) : request.signal
    const response = await fetchHere(url, { method: request.method, headers: sent, body, signal })
    const back = new Headers()
    for (const name of ["content-type", "mcp-session-id"]) {
      const value = response.headers.get(name)
      if (value) back.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers: back })
  } catch {
    return new Response(failed, { status: 502 })
  }
}

/**
 * A request to a server, following it only where the server itself moved it on its own site (a 307
 * or 308 to the same address with a slash, or on to https), as the request it was: never elsewhere,
 * as a sign-in page somewhere else isn't the server's answer, and its keys aren't for another site.
 * What else it sends elsewhere comes back as it is (a 3xx).
 */
async function fetchHere(url: string, init: RequestInit): Promise<Response> {
  let at = new URL(url)
  for (let hops = 0; ; hops++) {
    const response = await fetch(at, { ...init, redirect: "manual" })
    const location = response.headers.get("location")
    if (![307, 308].includes(response.status) || !location || hops >= 3) return response
    const next = new URL(location, at)
    const sameSite = next.hostname === at.hostname && (next.protocol === at.protocol ? next.port === at.port : at.protocol === "http:" && next.protocol === "https:")
    if (!sameSite) return response
    await response.body?.cancel()
    at = next
  }
}

/** A message (or several) to a program, for one of its connections; its answers back. */
async function sendAll(program: Program, body: any, timeout: number, connection: string, starts: boolean): Promise<Response> {
  const messages: any[] = Array.isArray(body) ? body : [body]
  const answers = await Promise.all(messages.map((message) => program.send(message, timeout, connection)))
  return replies(body, answers, starts ? { "mcp-session-id": connection } : undefined)
}

/** The answers to a message (or several), as MCP's HTTP sends them: none (notifications), 202. */
function replies(body: any, answers: unknown[], headers?: Record<string, string>): Response {
  const said = answers.filter((each) => each !== undefined)
  if (!said.length) return new Response(null, { status: 202, headers })
  return Response.json(Array.isArray(body) ? said : said[0], { headers })
}

/** Turned down: its sign-in or key refused (401), or what was asked not allowed (403). */
const refused = (status: number) => status === 401 || status === 403

/** Not the server's answer: turned down, sent elsewhere (to a sign-in page, say), or failing. */
const failing = (status: number) => refused(status) || (status >= 300 && status < 400) || status >= 500

/** Why a server's tools aren't there, or a call to it failed, as the agent is told it (`started`:
 * why its answer to starting wasn't a start). */
function whyNot(name: string, status: number, started?: string): string {
  if (status === 401) return `The ${name} server turned down its sign-in, so its tools aren't available for now. If the user asks for something from it, tell them to sign in to it again in Kuvo Code (Settings › Integrations, or its key in Settings › MCP Servers), and carry on with the rest`
  if (status === 403) return `The ${name} server turned this down (HTTP 403): its sign-in or key may not be allowed to do it`
  if (started) return `The ${name} server couldn't start (${started}), so its tools aren't available for now`
  const what = status === 502 ? "no answer" : status >= 300 && status < 400 ? `HTTP ${status}: it sent elsewhere, perhaps to sign in` : `HTTP ${status}`
  return `The ${name} server couldn't be reached (${what}), so its tools aren't available for now`
}

/** A server's answer to `initialize` (numbered `id`) in what it has sent so far (`text`: JSON, or
 * the events of a stream, by `type`, its content type): why it isn't a start (an error's words,
 * cut short), none for a start, or nothing yet. */
function startOf(text: string, type: string | null, id: unknown): { failure?: string } | undefined {
  const messages: any[] = []
  const add = (data: string) => {
    const parsed = jsonOf(data)
    if (parsed !== undefined) messages.push(...(Array.isArray(parsed) ? parsed : [parsed]))
  }
  if (type?.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
      if (data) add(data)
    }
  } else add(text)
  const answer = messages.find((message) => message && typeof message === "object" && message.id === id && ("result" in message || "error" in message))
  if (!answer) return undefined
  if (answer.error || !answer.result || typeof answer.result !== "object") {
    const said = typeof answer.error?.message === "string" ? answer.error.message.trim() : "it said no"
    return { failure: said.length > 200 ? `${said.slice(0, 200)}…` : said }
  }
  return {}
}

/**
 * A server's answer to `initialize` (numbered `id`), read until it says whether it started: why it
 * didn't, if so, and the answer to hand on. A stream is read event by event up to that one (a server
 * may keep it open after), and handed on as it goes on.
 */
async function readStart(response: Response, id: unknown): Promise<{ failure?: string; body: ReadableStream<Uint8Array> | string | null }> {
  const type = response.headers.get("content-type")
  const notOne = "its answer isn't an MCP server's"
  if (!type?.includes("text/event-stream") || !response.body) {
    const text = await response.text().catch(() => undefined)
    if (text === undefined) return { failure: "no answer", body: null }
    return { failure: (startOf(text, type, id) ?? { failure: notOne }).failure, body: text }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const read: Uint8Array[] = []
  let text = ""
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>
    try {
      next = await reader.read()
    } catch {
      return { failure: "no answer", body: null }
    }
    if (next.value) {
      read.push(next.value)
      text += decoder.decode(next.value, { stream: true })
    }
    const start = startOf(text, type, id)
    if (start?.failure || (!start && next.done)) {
      await reader.cancel().catch(() => {})
      return { failure: start?.failure ?? notOne, body: null }
    }
    if (!start) continue
    const done = next.done
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of read) controller.enqueue(chunk)
        if (done) controller.close()
      },
      async pull(controller) {
        try {
          const more = await reader.read()
          if (more.done) controller.close()
          else controller.enqueue(more.value)
        } catch (error) {
          controller.error(error)
        }
      },
      cancel: () => reader.cancel().catch(() => {}),
    })
    return { body }
  }
}

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * A server that couldn't be reached as an agent connected to it: the relay connects the agent
 * anyway, to a stand-in of its own with no tools, whose instructions say `why`, so an agent that
 * gives up its whole session when one server fails to start goes on with the rest.
 */
function standInFor(sessionID: string, name: string, setup: string, why: string, messages: any[], many: boolean, signIn = false): Response {
  const connection = `unavailable-${randomBytes(12).toString("hex")}`
  standIns.set(connection, { sessionID, name, setup, why, signIn })
  return standInAnswers(messages, why, many, { "mcp-session-id": connection })
}

/** A session's server reached for real: the relay's stand-ins for it from before go. */
function reached(sessionID: string, name: string) {
  for (const [connection, standIn] of standIns) if (standIn.sessionID === sessionID && standIn.name === name) standIns.delete(connection)
}

/** A request to a stand-in, answered by the relay. */
async function answerStandIn(request: Request, connection: string, why: string): Promise<Response> {
  if (request.method === "DELETE") {
    standIns.delete(connection)
    return new Response(null, { status: 200 })
  }
  // (No stream of its own to offer.)
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } })
  const body = jsonOf(await request.text())
  if (body === undefined) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
  return standInAnswers(Array.isArray(body) ? body : [body], why, Array.isArray(body), undefined)
}

/**
 * What a server that isn't there answers: it starts, it has no tools, and anything asked of it says
 * `why`. Or (`failing`) what one connected for real that fails partway answers: a tool's call, its
 * error saying why; anything else, an error saying why (not an empty list, as if it had none).
 */
function standInAnswers(messages: any[], reason: string, many: boolean, headers: Record<string, string> | undefined, failing = false): Response {
  const why = reason.replace(/[.\s]+$/, "")
  const answers = messages.map((message) => {
    if (message?.id === undefined || message.id === null) return undefined
    const result = (value: unknown) => ({ jsonrpc: "2.0", id: message.id, result: value })
    if (failing && message.method !== "tools/call") return failure(message.id, `${why}.`)
    switch (message.method) {
      case "initialize":
        return result({
          protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "unavailable", version: "1" },
          instructions: `${why}.`,
        })
      case "ping":
        return result({})
      case "tools/list":
        return result({ tools: [] })
      case "resources/list":
        return result({ resources: [] })
      case "resources/templates/list":
        return result({ resourceTemplates: [] })
      case "prompts/list":
        return result({ prompts: [] })
      case "tools/call":
        return result({ content: [{ type: "text", text: `${why}.` }], isError: true })
      default:
        return failure(message.id, `${why}.`)
    }
  })
  return replies(many ? messages : messages[0], answers, headers)
}

/** A request to one of the computer's servers, from a session's agent. */
async function answerServer(request: Request, sessionID: string, name: string): Promise<Response> {
  const session = served.get(sessionID)
  const entry = session?.servers.get(name)
  if (!session || !entry) return new Response("No such server here.", { status: 404 })
  const failed = `The ${name} server didn't answer.`
  const connection = request.headers.get("mcp-session-id") ?? ""
  const standIn = standIns.get(connection)
  if (standIn?.sessionID === sessionID && standIn.name === name) return answerStandIn(request, connection, standIn.why)
  if (entry.kind === "remote") {
    const body = request.method === "POST" ? await request.text() : undefined
    const sent = body === undefined ? undefined : jsonOf(body)
    const messages: any[] = sent === undefined ? [] : Array.isArray(sent) ? sent : [sent]
    const initialize = messages.find((message) => message?.method === "initialize")
    // (Its start, briefly, renewals and all: an agent may give up its whole session while it waits.)
    const deadline = Date.now() + relayTiming.starts
    const limit = (server: ComputerServer) => (initialize ? Math.max(1, Math.min(server.timeout, deadline - Date.now())) : server.timeout)
    const renewing = () => (initialize ? inTime(renewed(sessionID, session, name), deadline) : renewed(sessionID, session, name))
    // Your sign-in to it running out (in a long turn): renewed by the engine first; one it turned
    // down, renewed and tried once more.
    let current = entry.expires !== undefined && entry.expires < Date.now() + 60_000 ? ((await renewing()) ?? entry) : entry
    let answer = await forward(request, current.url, current.headers, limit(current), body, failed)
    const at = `${sessionID}\n${name}`
    /** Tried again with how it's set up now, if that's changed. */
    const retried = async () => {
      const again = await renewing()
      if (!again || setupOf(again) === setupOf(current)) return
      await answer.body?.cancel()
      current = again
      answer = await forward(request, again.url, again.headers, limit(again), body, failed)
    }
    if (answer.status === 401 && current.expires !== undefined) await retried()
    if (answer.status === 401) {
      // The engine connects it again, once for how it's set up now, whatever else it turns down
      // meanwhile: it renews your sign-in if it can, or finds it needs one, for Settings ›
      // Integrations to say. (A start doesn't wait for that: the agent's next turn finds it.)
      const setup = setupOf(current)
      let asked = refusals.get(at)
      if (asked?.setup !== setup) refusals.set(at, (asked = { setup, asked: reconnectServer(session.directory, name) }))
      if (!initialize) {
        await asked.asked
        await retried()
        // (Turned down as renewed too: not asked again for that either.)
        if (answer.status === 401) refusals.set(at, { setup: setupOf(current), asked: asked.asked })
      }
    }
    if (initialize) {
      // Read before the agent has it: what isn't a start (an error, a page) is a stand-in's.
      let why: string | undefined
      let started: ReadableStream<Uint8Array> | string | null = null
      if (answer.ok) {
        const start = await readStart(answer, initialize.id)
        if (start.failure) why = whyNot(name, answer.status, start.failure)
        started = start.body
      } else {
        await answer.body?.cancel()
        why = whyNot(name, answer.status)
      }
      if (why) return standInFor(sessionID, name, setupOf(current), why, messages, Array.isArray(sent), answer.status === 401)
      reached(sessionID, name)
      return new Response(started, { status: answer.status, headers: answer.headers })
    }
    // A call it turns down partway (or can't take, for now): its answer says why, as a tool's
    // error, rather than an error of the connection's.
    if (messages.length && failing(answer.status)) {
      await answer.body?.cancel()
      return standInAnswers(messages, whyNot(name, answer.status), Array.isArray(sent), undefined, true)
    }
    // (And its stream of what it sends, failing: none, which MCP's HTTP allows.)
    if (request.method === "GET" && failing(answer.status)) {
      await answer.body?.cancel()
      return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } })
    }
    return answer
  }
  const at = `${sessionID}\n${name}\n${connection}`
  if (request.method === "DELETE") {
    running.get(at)?.stop()
    return new Response(null, { status: 200 })
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } })
  let body: any
  try {
    body = await request.json()
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 })
  }
  const messages: any[] = Array.isArray(body) ? body : [body]
  const initialize = messages.find((message) => message?.method === "initialize")
  if (initialize) {
    // Each connection a server of its own, as an agent that starts it itself has it.
    const started = startServer(entry, sessionID, session.directory)
    if (typeof started === "string") return standInFor(sessionID, name, setupOf(entry), started, messages, Array.isArray(body))
    const fresh = randomBytes(12).toString("hex")
    const key = `${sessionID}\n${name}\n${fresh}`
    running.set(key, started)
    started.whenStopped(() => running.get(key) === started && running.delete(key))
    // (Its start, briefly: an agent may give up its whole session while it waits.)
    const answers = await Promise.all(messages.map((message) => started.send(message, message === initialize ? Math.min(entry.timeout, relayTiming.commandStarts) : entry.timeout, fresh)))
    // (One that ends, or says no, before it's started: the agent goes on without it.)
    const answered: any = answers[messages.indexOf(initialize)]
    if (!answered || answered.error) {
      started.stop()
      return standInFor(sessionID, name, setupOf(entry), `The ${name} server couldn't start${answered?.error?.message ? `: ${answered.error.message}` : ""}`, messages, Array.isArray(body))
    }
    reached(sessionID, name)
    return replies(body, answers, { "mcp-session-id": fresh })
  }
  const program = running.get(at)
  // (One that stopped, or a connection it doesn't know: the agent connects again.)
  if (!program || program.stopped) return new Response("No such connection here.", { status: 404 })
  return sendAll(program, body, entry.timeout, connection, false)
}

/** What `work` comes to, or nothing if that isn't by `deadline`. */
async function inTime<T>(work: Promise<T>, deadline: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()))))
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** A URL's server of a session's as the engine has it now (your sign-in renewed), for the rest of its calls. */
async function renewed(sessionID: string, session: { directory: string; servers: Map<string, ComputerServer> }, name: string) {
  const found = (await computerServers(session.directory, true)).servers.find((each) => each.name === name)
  if (found?.kind !== "remote") return undefined
  if (served.get(sessionID) === session) session.servers.set(name, found)
  return found
}

/**
 * The folders a command's server keeps what it needs in, as the engine runs it: its caches
 * (kuvo-npx's, npm's and Bun's), the engine's, in Kuvo Code's folder. A machine's bridge has them
 * already, as its engine does; on this Mac, beside the engine's data.
 */
function engineFolders(): Record<string, string> {
  const data = process.env.KUVO_ENGINE_DATA
  if (process.env.XDG_CACHE_HOME || !data) return {}
  const root = dirname(dirname(data))
  return { XDG_CACHE_HOME: join(root, "cache"), npm_config_cache: join(root, "cache", "npm"), BUN_INSTALL: join(root, "cache", "bun") }
}

/** The integrations' folders (`KUVO_INTEGRATIONS/<one>`) a server's settings name, where it keeps its own sign-in. */
function integrationFolders(entry: Extract<ComputerServer, { kind: "local" }>): string[] {
  const integrations = process.env.KUVO_INTEGRATIONS
  if (!integrations) return []
  const folders = new Set<string>()
  for (const value of [...entry.command, ...Object.values(entry.env)]) {
    for (const part of value.split(/[=:,\s]/)) {
      const inside = relative(integrations, part)
      if (part.startsWith("/") && inside && !inside.startsWith("..")) folders.add(join(integrations, inside.split("/")[0]!))
    }
  }
  return [...folders]
}

/**
 * A command's server for one of a session's connections: in the box's sandbox while it's on, as
 * the conversation's commands are, with its keys in its environment (and npx's own cache in it:
 * kuvo-npx's, the engine's, is in Kuvo Code's folder); as the engine runs it while it's off. Or why
 * it can't start.
 */
function startServer(entry: Extract<ComputerServer, { kind: "local" }>, sessionID: string, directory: string): Program | string {
  const [named, ...args] = entry.command
  const env: Record<string, string | undefined> = { ...process.env, ...engineFolders(), ...entry.env, OPENCODE_SESSION_ID: sessionID }
  const cwd = entry.cwd ?? directory
  // By its name on the PATH, as a shell finds it (Linux's sandbox runs it by its path).
  const command = named!.includes("/") ? named! : Bun.which(named!, { PATH: env.PATH ?? "" })
  if (!command) return `The ${entry.name} server can't start: ${named} isn't installed here.`
  if (!fenceRules()) return new Program({ key: "", command, args, env, cwd, name: `The ${entry.name} server` })
  // In the sandbox, as the conversation's commands are: Kuvo Code's folder hidden but its
  // integration's own (where it keeps its sign-in) and the engine (Bun, for kuvo-npx without
  // Node), with npm's and Bun's caches the sandbox's and, on a machine, its own folders back.
  // (Bun's cache in the sandbox's npm cache, which the launcher names: never yours in your home.)
  const fence = fenceServer("/bin/sh", directory, { homes: integrationFolders(entry), read: [dirname(process.execPath)] })
  if (!fence) return "The sandbox isn't ready here, so this server can't start: restart Kuvo Code."
  for (const name of ["XDG_CACHE_HOME", "npm_config_cache", "BUN_INSTALL"]) delete env[name]
  if (onMachine) for (const [name, value] of Object.entries(ownEnvironment())) if (name !== "XDG_CACHE_HOME") value === undefined ? delete env[name] : (env[name] = value)
  const inside = ["-c", 'BUN_INSTALL_CACHE_DIR="$npm_config_cache/_bun" exec "$0" "$@"', command, ...args]
  return new Program({ key: "", command: fence.command, args: inside, env: { ...env, ...fence.env }, cwd, name: `The ${entry.name} server`, ended: fence.ended })
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
 * A program spoken to over its input and output: a session's Kuvo Code tools (`kuvo-browser.js
 * mcp`), which each of its agent's connections share (Codex has one a thread), their requests
 * numbered anew here so theirs never meet; or one of the computer's servers, one a connection.
 */
class Program {
  readonly key: string
  stopped = false
  /** When a connection last used it. */
  used = Date.now()
  private child: ChildProcess
  private next = 1
  private waiting = new Map<number, { id: unknown; done: (message: unknown) => void }>()
  /** Each connection's request, as the program knows it (for a cancel). */
  private ours = new Map<string, number>()

  /** What it's called where it says it stopped ("Kuvo Code's tools"). */
  private readonly name: string
  private stopping: (() => void)[] = []

  constructor(spec: { key: string; command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string; name: string; ended?: () => void }) {
    this.key = spec.key
    this.name = spec.name
    if (spec.ended) this.stopping.push(spec.ended)
    // (What it says on stderr isn't kept: a server's own can have its keys in it.)
    this.child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: ["pipe", "pipe", "ignore"] })
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
        // What it asks the agent (its folders, a question, a model's words) isn't passed on: it's
        // told so at once, rather than waiting.
        if (typeof message?.method === "string") {
          if (message.id !== undefined && message.id !== null) this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Kuvo Code doesn't pass this on to the agent." } })
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
    this.used = Date.now()
    if (this.stopped) return Promise.resolve(message?.id === undefined ? undefined : failure(message.id, `${this.name} stopped.`))
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
        this.ours.delete(known)
        this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Took too long." } })
        resolve(failure(message.id, `${this.name} took too long.`))
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

  /** `then` once it has stopped. */
  whenStopped(then: () => void) {
    if (this.stopped) then()
    else this.stopping.push(then)
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.child.kill()
    for (const [, waiting] of this.waiting) waiting.done(failure(waiting.id, `${this.name} stopped.`))
    this.waiting.clear()
    for (const then of this.stopping.splice(0)) then()
  }
}

const failure = (id: unknown, message: string) => ({ jsonrpc: "2.0", id, error: { code: -32603, message } })
