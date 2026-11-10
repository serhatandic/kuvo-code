// An ACP agent (as Grok and Antigravity speak it), faked: what it sends shows, nothing lost; what
// it asks is answered as the session's rules and modes say; Stop stops it; what it costs is counted.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { AcpThread, acpTiming } from "../../src/agents/acp"
import type { Agent } from "../../src/agents/agent"
import { AntigravityAgent } from "../../src/agents/agents/antigravity"
import { GrokAgent } from "../../src/agents/agents/grok"
import { Auto } from "../../src/agents/auto"
import { subscribe } from "../../src/agents/events"
import type { Roster } from "../../src/agents/roster"
import { Sessions, timing } from "../../src/agents/sessions"
import { Store } from "../../src/agents/store"
import { setToolServer } from "../../src/agents/kuvotools"
import { canFence, realFence } from "./support/fence"
import { computerServers, KEYS, SERVER_COMMAND } from "./support/servers"
import { subagentEngine } from "./support/subagents"
import { forgetServers } from "../../src/agents/servers"
import { noteAgentsInside } from "../../src/agents/fence"
import type { PermissionRule } from "../../src/agents/wire"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-acp-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let root: string
let sessions: Sessions

beforeEach(() => {
  root = mkdtempSync(join(base, "case-"))
  // Run from inside Kuvo Code (an agent's shell), the box's own sandbox is in the environment: an agent
  // would start run whole in it. Each test that wants the sandbox sets up its own.
  delete process.env.KUVO_FENCE
})
afterEach(() => sessions?.closeAll())

interface Script {
  /** What it does once what it asked last is answered (in place of saying what it was answered). */
  afterReply?: [string, any][]
  /** How its first prompt ends, once it has said all and been answered: `end_turn` unless said. */
  stopReason?: string
  /** Its first prompt goes on until it's told to stop (`session/cancel`), which ends it as cancelled. */
  hangs?: boolean
  /** What each prompt after the first says, before it ends it (over all its processes: one started again goes on). */
  next?: [string, any][]
  /** More of the session it makes or loads (Antigravity's settings). */
  setup?: Record<string, unknown>
  /** Requests it turns down with an error: by method, and what their params hold. */
  refuses?: { method: string; params?: Record<string, unknown> }[]
  /**
   * What it tries at each prompt, where it runs, and says (`name=yes|no`, or what it found):
   * `write`/`read` a file, `tools` (Kuvo Code's, a call through the server it was given), `app`
   * (a server's address, straight), `env` (a variable's value, or `none`); `replace` saves a file
   * whole through a new one (the third: written, then renamed onto it), `hardlink` names it the third too.
   */
  tries?: Record<string, [string, string] | [string, string, string]>
  /**
   * As it starts, it reads the folder it's started in, as Google's agent does (Python's
   * `os.getcwd()`); one it can't read ends it there, with `fails` (a traceback) on its stderr.
   * `fails` alone ends it there whatever it finds.
   */
  readsItsFolder?: boolean
  fails?: string
  /** What it says again as a session is loaded, before it answers (Grok's replay of what it said before). */
  replays?: [string, any][]
}

/**
 * An ACP agent, as a script, whose prompt sends `updates` (each `[sessionId, update]`), asks what
 * `request` asks (one, or several in turn), then, after the answer, sends `later`. Everything it's
 * sent is written down, and how each of its processes was started (see `received`).
 */
function fakeAcp(updates: [string, any][], later: [string, any][] = [], request?: any, script: Script = {}): string {
  const path = join(root, "agent.js")
  const log = join(root, "received.jsonl")
  const requests = request === undefined ? [] : Array.isArray(request) ? request : [request]
  const prompts = [
    { updates, requests, afterReply: script.afterReply, stopReason: script.stopReason ?? "end_turn", hangs: script.hangs ?? false },
    ...(script.next ? [{ updates: script.next, requests: [], stopReason: "end_turn", hangs: false }] : []),
  ]
  writeFileSync(
    path,
    `const { appendFileSync, readFileSync } = require("node:fs")
// (Signing in, the sandbox keeps it out of the test's folder, where it writes this down.)
const log = (entry) => { try { appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n") } catch {} }
log({ argv: process.argv.slice(2), pid: process.pid })
// (Stopped as an agent's process is, said with when.)
const exit = () => { log({ exited: Date.now() }); process.exit(0) }
process.on("SIGTERM", exit)
process.stdin.on("end", exit)
let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
// One of an agent's own (Grok's _x.ai/session/update) when it says which: { method, update }.
const update = (sessionId, value) => send(value?.method ? { method: value.method, params: { sessionId, update: value.update } } : { method: "session/update", params: { sessionId, update: value } })
const prompts = ${JSON.stringify(prompts)}
const setup = ${JSON.stringify({ sessionId: "s1", ...script.setup })}
const refuses = ${JSON.stringify(script.refuses ?? [])}
const later = ${JSON.stringify(later)}
const replays = ${JSON.stringify(script.replays ?? [])}
const tries = ${JSON.stringify(script.tries ?? null)}
const fails = ${JSON.stringify(script.fails ?? "Traceback (most recent call last):\nPermissionError: [Errno 1] Operation not permitted")}
if (${JSON.stringify(Boolean(script.readsItsFolder || script.fails))}) {
  try {
    require("node:fs").readdirSync(".")
    if (${JSON.stringify(script.fails !== undefined)}) throw new Error()
  } catch {
    process.stderr.write(fails + "\\n")
    process.exit(1)
  }
}
let servers = []
async function attempt(how, place, through) {
  if (how === "env") return process.env[place] ?? "none"
  if (how === "arg") return process.argv.includes(place) ? "yes" : "no"
  try {
    if (how === "write") require("node:fs").writeFileSync(place, "x")
    // Saved whole, as Grok saves its sign-in: a new file (\`through\`), renamed onto it.
    else if (how === "replace") require("node:fs").writeFileSync(through, "x"), require("node:fs").renameSync(through, place)
    // Another name for it (\`through\`), a hard link.
    else if (how === "hardlink") require("node:fs").linkSync(place, through)
    else if (how === "read") require("node:fs").readFileSync(place)
    else if (how === "link") require("node:fs").symlinkSync("/", place)
    else if (how === "linked") return require("node:fs").lstatSync(place).isSymbolicLink() ? "yes" : "no"
    else if (how === "move in") {
      // A folder made in its project, with a link in it, moved to \`place\` (where there's none yet).
      const fs = require("node:fs"), path = require("node:path")
      if (fs.existsSync(place)) throw new Error("There already.")
      const staged = fs.mkdtempSync(path.join(process.cwd(), "staged-"))
      fs.symlinkSync("/", path.join(staged, "prompt_history.jsonl"))
      fs.renameSync(staged, place)
    }
    else if (how === "server") {
      // One of the computer's servers it was given, by name: started, then its tool called
      // ("<server> [<tool> [<path or name>]]", its key told by default).
      const [named, tool = "reveal", argument] = place.split(" ")
      const server = servers.find((each) => each.name === named)
      if (!server) return "none"
      const headers = { ...Object.fromEntries(server.headers.map((each) => [each.name, each.value])), "Content-Type": "application/json", Accept: "application/json, text/event-stream" }
      const started = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } } }) })
      if (!started.ok) return "no"
      const session = started.headers.get("mcp-session-id")
      const response = await fetch(server.url, { method: "POST", headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: tool === "env" ? { name: argument } : { path: argument } } }) })
      if (!response.ok) return "no"
      return (await response.json()).result?.content?.[0]?.text ?? "no"
    }
    else if (how === "tools" || how === "app") {
      const server = how === "tools" ? servers.find((each) => each.type === "http") : { url: place, headers: [] }
      if (!server) return "none"
      const headers = Object.fromEntries(server.headers.map((each) => [each.name, each.value]))
      const response = await fetch(server.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "show_in_panel", arguments: {} } }) })
      if (!response.ok) return "no"
      return (await response.json()).result?.content?.[0]?.text ?? "no"
    }
    return "yes"
  } catch {
    return "no"
  }
}
/** How many prompts it had before this one, in any of its processes. */
const before = () => readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter((line) => line && JSON.parse(line).method === "session/prompt").length - 1
let prompt, turn, asked = 0, stopped = false
const ask = () => send({ id: 900 + asked, method: turn.requests[asked].method, params: turn.requests[asked].params })
const end = () => turn.hangs || send({ id: prompt, result: { stopReason: turn.stopReason } })
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    log(message)
    if (refuses.some((refused) => refused.method === message.method && Object.entries(refused.params ?? {}).every(([key, value]) => message.params?.[key] === value))) send({ id: message.id, error: { code: -32603, message: "Refused." } })
    else if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } } } })
    else if (message.method === "session/new" || message.method === "session/load") {
      servers = message.params?.mcpServers ?? []
      if (message.method === "session/load") for (const [sessionId, value] of replays) update(sessionId, value)
      send({ id: message.id, result: setup })
    } else if (message.method === "session/prompt" && tries) {
      // (What it tries is all that prompt does.)
      const id = message.id
      void (async () => {
        const found = []
        for (const [name, [how, place, through]] of Object.entries(tries)) found.push(name + "=" + (await attempt(how, place, through)))
        update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: found.join(" ") } })
        send({ id, result: { stopReason: "end_turn" } })
      })()
    } else if (message.method === "session/prompt") {
      prompt = message.id
      turn = prompts[Math.min(before(), prompts.length - 1)]
      asked = 0
      stopped = false
      for (const [sessionId, value] of turn.updates) update(sessionId, value)
      if (turn.requests.length) ask()
      else end()
      if (later.length) setTimeout(() => { log({ later: Date.now() }); for (const [sessionId, value] of later) update(sessionId, value) }, 300)
    } else if (message.method === "session/cancel") {
      stopped = true
      send({ id: prompt, result: { stopReason: "cancelled" } })
    } else if (message.id >= 900 && message.id < 1000 && !message.method) {
      // What it asked, answered: it says what it got (or does what it's to do then), and asks the next or ends. (Stopped: nothing.)
      if (stopped) continue
      asked++
      const last = asked >= turn.requests.length
      if (last && turn.afterReply) for (const [sessionId, value] of turn.afterReply) update(sessionId, value)
      else update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Got " + JSON.stringify(message.result) } })
      if (last) end()
      else ask()
    } else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
  )
  return path
}

/** The script as a program, run with what it's given (Grok's `grok`, Antigravity's server). As Bun
 * whatever runs the tests: on a machine that's its engine, Bun by `BUN_BE_BUN`, which the sandbox doesn't pass on. */
function program(script: string, path: string): string {
  writeFileSync(path, `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

/** An ACP agent (no agent's own ways) whose prompt goes as `fakeAcp` says; its command's argument is the mode it's started for. */
function agentSaying(updates: [string, any][], later: [string, any][] = [], request?: any, options: Script & { fileSystem?: boolean; noteContext?: (model: string, size: number) => void } = {}): Agent {
  const script = fakeAcp(updates, later, request, options)
  return {
    id: "grok",
    providerID: "acp",
    name: "Agent",
    instance: { id: "default" },
    methods: () => [],
    account: async () => ({ installed: true, signedIn: true }),
    models: async () => [],
    thread: (session, state) => new AcpThread({ fileSystem: options.fileSystem ?? false, authMethod: () => undefined, command: async (mode) => ({ argv: [process.execPath, script, JSON.stringify(mode)], cwd: root }), selectModel: async () => {}, noteContext: options.noteContext }, session, state, "Agent"),
  }
}

/** Grok, with the fake for its CLI. */
class TestGrok extends GrokAgent {
  constructor(
    private readonly launcher: string,
    home: string,
  ) {
    super({ home, temporary: home, deps: {} as any })
  }
  override executable() {
    return this.launcher
  }
  override async account() {
    return { installed: true, signedIn: true }
  }
}

/** Antigravity, with the fake in place of Google's agent, as if downloaded. */
class TestAntigravity extends AntigravityAgent {
  constructor(script: string, home: string) {
    super({ home, temporary: join(home, "temporary"), deps: {} as any })
    const folder = (this as any).folder as string
    mkdirSync(folder, { recursive: true })
    program(script, join(folder, "agy_acp_server.par"))
    writeFileSync(join(folder, ".complete"), "{}")
  }
  override async account() {
    return { installed: true, signedIn: true }
  }
}

let sent = 0

/** A session on `agent` (with its rules, or its agent: "plan"), and your first message to it. */
function start(agent: Agent, options: { permissions?: PermissionRule[]; agent?: string } = {}) {
  sessions?.closeAll()
  sessions = new Sessions(new Store(join(root, "sessions")), { find: (provider: string | undefined) => (provider === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
  return another(agent, options)
}

/** Another session on the same agent, and your first message to it. */
function another(agent: Agent, options: { permissions?: PermissionRule[]; agent?: string } = {}) {
  const id = sessions.create({ title: "ACP", model: { providerID: agent.providerID, id: "one" }, location: { directory: root }, ...options }).id
  send(id)
  return id
}

/** Your message to a session. */
function send(id: string, text = "go") {
  sessions.prompt(id, { id: `msg_acp_test_${String(++sent).padStart(5, "0")}`, text, files: [], delivery: "steer" })
}

async function until(condition: () => boolean, ms = 30_000) {
  const began = Date.now()
  while (!condition()) {
    if (Date.now() - began > ms) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

/** Once a session's `idles` turns are over. */
async function settled(id: string, idles = 1) {
  await until(() => sessions.messages(id).filter((message) => message.type === "idle").length >= idles && !sessions.active().includes(id))
  return id
}

async function run(agent: Agent, idles = 1, options: { permissions?: PermissionRule[]; agent?: string } = {}) {
  return settled(start(agent, options), idles)
}

const tools = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "assistant" ? message.content.filter((content: any) => content.type === "tool") : []))
const words = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "assistant" ? message.content.filter((content: any) => content.type === "text").map((content: any) => content.text) : [])).join("")
const notices = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "synthetic" ? [message.text] : []))
const steps = (id: string) => sessions.messages(id).filter((message) => message.type === "assistant") as any[]
const ended = (id: string) => sessions.messages(id).at(-1) as any

/** What the agent was sent, in order, and how each of its processes was started (`{ argv }`). */
function received(): any[] {
  try {
    return readFileSync(join(root, "received.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
/** What it heard back to what it asked, in order. */
const answers = () => received().filter((message) => message.id >= 900 && message.id < 1000 && !message.method).map((message) => message.result?.outcome ?? message.error)
const prompts = () => received().filter((message) => message.method === "session/prompt")
/** How its processes were started: the arguments each was given. */
const launches = () => received().filter((message) => message.argv).map((message) => message.argv as string[])

/** The events of one kind for a session, from now until `stop`. */
function watch(type: string) {
  const seen: any[] = []
  const stop = subscribe((event: any) => {
    if (event.type === type) seen.push(event.data)
  })
  return { of: (id: string) => seen.filter((data) => data?.sessionID === id), stop }
}

const said = (text: string): [string, any] => ["s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }]

describe("ACP agents, nothing dropped", () => {
  test("pictures it sends and its tools bring back, a link, an error's words, and a kind this bridge doesn't know", async () => {
    const id = await run(
      agentSaying([
        ["s1", { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "DDDD", mimeType: "image/png" } }],
        ["s1", { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", name: "Docs", uri: "https://kuvo.run" } }],
        ["s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Screenshot", kind: "other", status: "completed", content: [{ type: "content", content: { type: "image", data: "EEEE", mimeType: "image/jpeg" } }] }],
        ["s1", { sessionUpdate: "tool_call", toolCallId: "t2", title: "npm test", kind: "execute", status: "failed", rawInput: { command: "npm test" }, rawOutput: { stderr: "1 test failed" } }],
        ["s1", { sessionUpdate: "shiny_new_kind", message: "Something new to read." }],
      ]),
    )
    const [image, shot, failed] = tools(id)
    expect(image).toMatchObject({ name: "generate_image", state: { content: [{ type: "text" }, { type: "file", uri: "data:image/png;base64,DDDD" }] } })
    expect(shot.state.content).toEqual([{ type: "text", text: "" }, { type: "file", uri: "data:image/jpeg;base64,EEEE", mime: "image/jpeg" }])
    expect(JSON.stringify(failed.state)).toContain("1 test failed")
    expect(words(id)).toContain("[Docs](https://kuvo.run)")
    expect(notices(id)).toContain("Something new to read.")
  })

  test("how full its context is and how much its model holds, as it says: what the context ring counts", async () => {
    const said: [string, number][] = []
    const id = await run(
      agentSaying(
        [
          ["s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }],
          ["s1", { sessionUpdate: "usage_update", used: 52_000, size: 372_000 }],
        ],
        [],
        undefined,
        { noteContext: (model, size) => said.push([model, size]) },
      ),
    )
    expect(said).toEqual([["one", 372_000]])
    const last = sessions.messages(id).filter((message: any) => message.type === "assistant").at(-1) as any
    expect(last.tokens.input + last.tokens.output + last.tokens.cache.read + last.tokens.cache.write).toBe(52_000)
  })

  test("a file it has Kuvo Code read shows as read then, though it says so only as the turn ends (Antigravity)", async () => {
    const file = join(root, "notes.txt")
    writeFileSync(file, "first\nsecond\nthird\n")
    const missing = join(root, "gone.txt")
    const read = (id: string, path: string, title = "Running client_view_file") => ["s1", { sessionUpdate: "tool_call", toolCallId: id, title, kind: "read", status: "in_progress", locations: [{ path }], rawInput: { absolute_path: path } }] as [string, any]
    const done = (id: string) => ["s1", { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" }] as [string, any]
    const id = await run(
      agentSaying([read("r1", missing)], [], { method: "fs/read_text_file", params: { sessionId: "s1", path: file, line: 1, limit: 2 } }, {
        fileSystem: true,
        afterReply: [read("r3", file, "Running view_file"), read("r2", file), ["s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It says first." } }], done("r3"), done("r2"), done("r1")],
      }),
    )
    // Its own read of it (view_file) is done by the time it answers; the one Kuvo Code did shows what was read.
    const [gone, own, notes] = tools(id)
    expect(gone).toMatchObject({ name: "read", state: { status: "error" } })
    expect(JSON.stringify(gone.state)).toContain("There's no such file.")
    expect(own).toMatchObject({ id: "r3", name: "read", state: { status: "completed" } })
    expect(notes).toMatchObject({ id: "r2", name: "read", state: { status: "completed", content: [{ type: "text", text: "first\nsecond" }] } })
  })

  test("one of Kuvo Code's tools that the agent wraps in its own call (Grok's UseTool) shows with its own arguments, and its tool search as one", async () => {
    const message = { to: "ses_other", text: "Got ping #3." }
    const id = await run(
      agentSaying([
        ["s1", { sessionUpdate: "tool_call", toolCallId: "k1", title: "kuvo-browser__send_message", kind: "other", status: "completed",
                 rawInput: { variant: "UseTool", tool_name: "kuvo-browser__send_message", tool_input: message } }],
        ["s1", { sessionUpdate: "tool_call", toolCallId: "k2", title: "Use tool", kind: "other", status: "completed",
                 rawInput: { variant: "UseTool", tool_name: "kuvo-browser__show_in_panel", tool_input: { path: "/tmp/a.txt" } } }],
        ["s1", { sessionUpdate: "tool_call", toolCallId: "k3", title: "Search tools: send_message kuvo session", kind: "other", status: "completed",
                 rawInput: { variant: "SearchTool", query: "send_message kuvo session", limit: 5 } }],
        ["s1", { sessionUpdate: "tool_call", toolCallId: "k4", title: "Search tools: browser", kind: "search", status: "completed",
                 rawInput: { variant: "SearchTool", query: "browser" } }],
      ]),
    )
    const [sent, shown, search, searchedAsSearch] = tools(id)
    expect(search).toMatchObject({ name: "tool_search", state: { input: { query: "send_message kuvo session" } } })
    // Its kind given as a search: a search for a tool all the same, not for text in files.
    expect(searchedAsSearch).toMatchObject({ name: "tool_search", state: { input: { query: "browser" } } })
    expect(sent).toMatchObject({ name: "kuvo-browser_send_message", state: { input: message } })
    expect(shown).toMatchObject({ name: "kuvo-browser_show_in_panel", state: { input: { path: "/tmp/a.txt" } } })
  })

  test("a tool whose name is known only later is told with its new name", async () => {
    const started: string[] = []
    const unsubscribe = subscribe((event: any) => {
      if (event.type === "session.tool.input.started") started.push(event.data?.name ?? event.properties?.name)
    })
    try {
      const id = await run(
        agentSaying([
          ["s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Working", kind: "other", status: "in_progress" }],
          ["s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", kind: "read", locations: [{ path: "/tmp/a.txt" }], status: "completed" }],
        ]),
      )
      expect(tools(id)[0].name).toBe("read")
      expect(started).toEqual(["working", "read"])
    } finally {
      unsubscribe()
    }
  })

  test("a subagent's session (another session of the agent's), with its task", async () => {
    const id = await run(
      agentSaying([
        ["c1", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Count the files" } }],
        ["c1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "There are 3." } }],
        ["s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }],
      ]),
    )
    const [row] = tools(id)
    expect(row).toMatchObject({ name: "subagent", state: { status: "completed", input: { description: "Count the files" } } })
    const child = row.state.metadata.sessionID
    expect(words(child)).toBe("There are 3.")
  })

  test("Antigravity's question names its call, for a client to show what went ahead on it there", async () => {
    sessions = undefined as unknown as Sessions
    const agent = agentSaying([], [], { method: "session/request_permission", params: { toolCall: { toolCallId: "interaction_7", title: "Which roast?" }, options: [{ optionId: "warm", name: "Warm (Recommended)", kind: "allow_once" }, { optionId: "dark", name: "Dark", kind: "allow_once" }] } })
    const started = run(agent)
    await until(() => Boolean(sessions?.list(root).length && sessions.forms(sessions.list(root)[0].id).length))
    const session = sessions.list(root)[0].id
    const [form] = sessions.forms(session)
    expect(form.metadata).toEqual({ kind: "question", tool: { id: "interaction_7" } })
    sessions.replyForm(session, form.id, { answer: "warm" })
    await started
  })

  test("Antigravity's question turned down by its box with words (Autopilot): its step says them, as it can only hear cancelled", async () => {
    sessions = undefined as unknown as Sessions
    const update = { sessionUpdate: "tool_call", toolCallId: "interaction_8", title: "Which roast?", status: "pending" }
    const agent = agentSaying([["s1", update]], [], { method: "session/request_permission", params: { toolCall: { toolCallId: "interaction_8", title: "Which roast?" }, options: [{ optionId: "warm", name: "Warm" }] } })
    const started = run(agent)
    await until(() => Boolean(sessions?.list(root).length && sessions.forms(sessions.list(root)[0].id).length))
    const session = sessions.list(root)[0].id
    sessions.replyForm(session, sessions.forms(session)[0].id, null, "This is on Autopilot: leave it.")
    await started
    expect(answers()).toEqual([{ outcome: "cancelled" }])
    expect(tools(session)[0]).toMatchObject({ id: "interaction_8", name: "question", state: { input: { questions: [{ question: "Which roast?" }] }, status: "error", error: { message: "This is on Autopilot: leave it." } } })
  })

  test("Grok's question turned down by its box with words (Autopilot): they're the answer it hears", async () => {
    const ask = { method: "_x.ai/ask_user_question", params: { toolCallId: "q1", questions: [{ id: "which", question: "Which roast?", options: [{ label: "Warm" }] }] } }
    const id = start(new TestGrok(program(fakeAcp([], [], ask), join(root, "grok")), root))
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, null, "This is on Autopilot: leave it.")
    await settled(id)
    expect(received().find((message) => message.id >= 900 && message.id < 1000 && !message.method).result).toEqual({ outcome: "accepted", answers: { "Which roast?": ["This is on Autopilot: leave it."] } })
  })

  test("a form it asks you to fill in", async () => {
    sessions = undefined as unknown as Sessions
    const agent = agentSaying([], [], { method: "elicitation/create", params: { message: "Which branch?", requestedSchema: { type: "object", properties: { branch: { type: "string", enum: ["main", "dev"] } }, required: ["branch"] } } })
    const started = run(agent)
    const start = Date.now()
    while (!sessions || !sessions.list(root).length || !sessions.forms(sessions.list(root)[0].id).length) {
      if (Date.now() - start > 15_000) throw new Error("no form")
      await Bun.sleep(20)
    }
    const session = sessions.list(root)[0].id
    const [form] = sessions.forms(session)
    expect(form.fields[0]).toMatchObject({ key: "branch", options: [{ value: "main" }, { value: "dev" }] })
    // Not the agent's question: a form like this never goes ahead on its own.
    expect(form.metadata?.kind).toBe("mcp-elicitation")
    sessions.replyForm(session, form.id, { branch: "dev" })
    const id = await started
    expect(words(id)).toContain('"action":"accept","content":{"branch":"dev"}')
  })

  test("a turn it begins on its own after its answer is taken as a turn here", async () => {
    acpTiming.ownQuiet = 500
    const id = await run(agentSaying([["s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Started the task." } }]], [["s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The task finished." } }]]), 2)
    expect(words(id)).toContain("The task finished.")
    expect(notices(id)).toContain("Agent carried on by itself.")
    acpTiming.ownQuiet = 20_000
  }, 20_000)
})

// MARK: What it asks

/** What an ACP agent offers when it asks (Grok's and Antigravity's four). */
const offered = [
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
]
const command = (toolCallId: string, line: string): [string, any] => ["s1", { sessionUpdate: "tool_call", toolCallId, title: `Run \`${line}\``, kind: "execute", status: "pending", rawInput: { command: line } }]
const edit = (toolCallId: string, path: string): [string, any] => ["s1", { sessionUpdate: "tool_call", toolCallId, title: "Edit notes.txt", kind: "edit", status: "pending", locations: [{ path }], rawInput: { path }, content: [{ type: "diff", path, oldText: "old\n", newText: "new\n" }] }]
const asking = (toolCallId: string) => ({ method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId }, options: offered } })
const askFirst: PermissionRule[] = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
]

describe("What ACP agents ask", () => {
  test("a command it asks to run waits for you, on its step; Allow Once reaches it as the allow-once it offered, and it runs", async () => {
    const ran: [string, any] = ["s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "removed build/" } }] }]
    const id = start(agentSaying([command("t1", "rm -rf build")], [], asking("t1"), { afterReply: [ran] }), { permissions: askFirst })
    await until(() => sessions.permissions(id).length > 0)
    const [ask] = sessions.permissions(id)
    expect(ask).toMatchObject({ action: "shell", resources: ["rm -rf build"], source: { type: "tool", id: "t1" } })
    sessions.replyPermission(id, ask.id, "once")
    await settled(id)
    expect(answers()).toEqual([{ outcome: "selected", optionId: "allow-once" }])
    expect(tools(id)[0]).toMatchObject({ name: "shell", state: { status: "completed", input: { command: "rm -rf build" }, content: [{ type: "text", text: "removed build/" }] } })
    expect(ended(id)).toMatchObject({ type: "idle", outcome: "succeeded" })
  })

  test("an edit it asks to make shows its change; No reaches it as its reject-once, the step shows it declined, and it isn't told to carry on", async () => {
    const file = join(root, "notes.txt")
    const id = start(agentSaying([edit("e1", file)], [], asking("e1"), { afterReply: [said("Okay, I'll leave it.")] }), { permissions: askFirst })
    await until(() => sessions.permissions(id).length > 0)
    const [ask] = sessions.permissions(id)
    expect(ask).toMatchObject({ action: "edit", resources: [file], metadata: { files: [{ file, additions: 1, deletions: 1 }] } })
    sessions.replyPermission(id, ask.id, "reject")
    await settled(id)
    expect(answers()).toEqual([{ outcome: "selected", optionId: "reject-once" }])
    expect(tools(id)[0]).toMatchObject({ id: "e1", name: "edit", state: { status: "error", error: { message: "Declined." } } })
    expect(words(id)).toContain("Okay, I'll leave it.")
    expect(prompts()).toHaveLength(1)
  })

  test("Always: the same again in this session isn't asked, and the agent hears allow-once each time (the always is Kuvo Code's to keep, not the agent's)", async () => {
    const asked = watch("permission.asked")
    try {
      const id = start(agentSaying([command("t1", "npm test"), command("t2", "npm test")], [], [asking("t1"), asking("t2")]), { permissions: askFirst })
      await until(() => sessions.permissions(id).length > 0)
      sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
      await settled(id)
      expect(asked.of(id)).toHaveLength(1)
      expect(answers()).toEqual([
        { outcome: "selected", optionId: "allow-once" },
        { outcome: "selected", optionId: "allow-once" },
      ])
    } finally {
      asked.stop()
    }
  })

  test("Always on an edit lets every later edit in the session through, to other files too (Grok's: told as its call, asked bare)", async () => {
    const asked = watch("permission.asked")
    try {
      const id = start(agentSaying([edit("e1", join(root, "a.txt")), edit("e2", join(root, "b.txt"))], [], [asking("e1"), asking("e2")]), { permissions: askFirst })
      await until(() => sessions.permissions(id).length > 0)
      sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
      await settled(id)
      expect(asked.of(id)).toHaveLength(1)
      expect(answers()).toEqual([
        { outcome: "selected", optionId: "allow-once" },
        { outcome: "selected", optionId: "allow-once" },
      ])
    } finally {
      asked.stop()
    }
  })

  test("Always on an edit lets every later edit through (Antigravity's: the kind and file only in what it asks)", async () => {
    const asked = watch("permission.asked")
    const asks = (toolCallId: string, file: string, title: string) => ({
      method: "session/request_permission",
      params: { sessionId: "s1", toolCall: { toolCallId, title, kind: "edit", status: "pending", locations: [{ path: join(root, file) }], rawInput: { TargetFile: join(root, file) } }, options: offered },
    })
    try {
      const id = start(agentSaying([], [], [asks("w1", "a.txt", "write_to_file"), asks("w2", "b.txt", "replace_file_content")]), { permissions: askFirst })
      await until(() => sessions.permissions(id).length > 0)
      sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
      await settled(id)
      expect(asked.of(id)).toHaveLength(1)
      expect(answers()).toEqual([
        { outcome: "selected", optionId: "allow-once" },
        { outcome: "selected", optionId: "allow-once" },
      ])
    } finally {
      asked.stop()
    }
  })

  test("Approve All: it's started approving all, and what it asks anyway is answered for you", async () => {
    const asked = watch("permission.asked")
    try {
      const id = await run(agentSaying([command("t1", "npm test")], [], asking("t1")))
      expect(launches().map(([mode]) => JSON.parse(mode))).toEqual([{ approvesAll: true, plan: false }])
      expect(asked.of(id)).toHaveLength(0)
      expect(answers()).toEqual([{ outcome: "selected", optionId: "allow-once" }])
    } finally {
      asked.stop()
    }
  })

  test("Plan mode: it's started planning; an edit it asks for is refused without asking you, and, stopped by that, it's told why and carries on to the end", async () => {
    const asked = watch("permission.asked")
    try {
      const file = join(root, "notes.txt")
      const id = await run(agentSaying([edit("e1", file)], [], asking("e1"), { stopReason: "cancelled", next: [said("Here's the plan instead.")] }), 1, { agent: "plan" })
      expect(launches().map(([mode]) => JSON.parse(mode))).toEqual([{ approvesAll: false, plan: true }])
      expect(asked.of(id)).toHaveLength(0)
      expect(answers()).toEqual([{ outcome: "selected", optionId: "reject-once" }])
      const [, carryOn] = prompts()
      expect(carryOn.params.prompt[0].text).toContain(`Kuvo Code didn't allow editing ${file}`)
      expect(words(id)).toContain("Here's the plan instead.")
      expect(tools(id)[0]).toMatchObject({ id: "e1", state: { status: "error" } })
      expect(ended(id)).toMatchObject({ type: "idle", outcome: "succeeded" })
    } finally {
      asked.stop()
    }
  })

  test("Grok is started approving all, asking first or planning, as the session is; a change starts it again on its conversation", async () => {
    const grok = new TestGrok(program(fakeAcp([said("Done.")]), join(root, "grok")), root)
    const id = await run(grok)
    sessions.update(id, { permissions: askFirst })
    send(id)
    await settled(id, 2)
    await settled(another(grok, { agent: "plan" }))
    expect(launches()).toEqual([
      ["agent", "--always-approve", "stdio"],
      ["--permission-mode", "default", "agent", "stdio"],
      ["--permission-mode", "plan", "agent", "stdio"],
    ])
    expect(received().filter((message) => message.method === "session/load").map((message) => message.params.sessionId)).toEqual(["s1"])
    expect(words(id)).toBe("Done.Done.")
  })

  test("Antigravity is put in its yolo mode for Approve All and its plan mode for Plan; a session to ask first that it can't be made to ask in doesn't start", async () => {
    const modes = { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: ["default", "yolo", "plan"].map((value) => ({ value, name: value })) }
    const setTo = () => received().filter((message) => message.method === "session/set_config_option" && message.params.configId === "mode").map((message) => message.params.value)
    await run(new TestAntigravity(fakeAcp([said("Done.")], [], undefined, { setup: { configOptions: [modes] } }), root))
    expect(setTo()).toEqual(["yolo"])
    root = mkdtempSync(join(base, "case-"))
    await run(new TestAntigravity(fakeAcp([said("Done.")], [], undefined, { setup: { configOptions: [modes] } }), root), 1, { agent: "plan" })
    expect(setTo()).toEqual(["plan"])
    // Its conversation left running without asking (an Approve All session's), and it won't change.
    root = mkdtempSync(join(base, "case-"))
    const stuck = fakeAcp([said("Done.")], [], undefined, { setup: { configOptions: [{ ...modes, currentValue: "yolo" }] }, refuses: [{ method: "session/set_config_option", params: { configId: "mode", value: "default" } }] })
    const id = await run(new TestAntigravity(stuck, root), 1, { permissions: askFirst })
    expect(prompts()).toHaveLength(0)
    expect(ended(id)).toMatchObject({ type: "idle", outcome: "failed", error: { message: expect.stringContaining("Antigravity couldn't be set to ask before it acts") } })
  })
})

// MARK: Your subagents

describe("Your subagents (Settings › Agents), in Grok and Antigravity", () => {
  test("Grok is given them as a plugin of its own, each on a model Grok runs, and started again when they change", async () => {
    const engine = subagentEngine(root)
    engine.agents.push({ id: "scout", name: "scout", mode: "subagent", description: "Looks: around.", system: "You scout.", model: { providerID: "grok-cli", id: "grok-4.6" }, permissions: [] })
    engine.model = "anthropic/claude-haiku-4-5"
    await engine.serve()
    try {
      const grok = new TestGrok(program(fakeAcp([said("Done.")]), join(root, "grok")), root)
      const id = await run(grok)
      const given = launches()[0]
      const folder = given[given.lastIndexOf("--plugin-dir") + 1]
      expect(given.filter((arg) => arg === "--plugin-dir")).toHaveLength(1)
      expect(JSON.parse(readFileSync(join(folder, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("kuvo")
      expect(readdirSync(join(folder, "agents")).sort()).toEqual(["keyword-research.md", "reviewer.md", "scout.md"])
      expect(readFileSync(join(folder, "agents", "scout.md"), "utf8")).toBe('---\nname: "scout"\ndescription: "Looks: around."\nmodel: "grok-4.6"\n---\n\nYou scout.\n')
      // Another maker's model (its own, or the one subagents use): the conversation's.
      expect(readFileSync(join(folder, "agents", "reviewer.md"), "utf8")).toBe('---\nname: "reviewer"\ndescription: "Reviews a finished change."\n---\n\nYou review. You never edit.\n')
      expect(folder.startsWith(root)).toBe(true)
      // The model subagents use changed to one of Grok's: the next message starts it again, with it.
      engine.model = "grok-cli/grok-4.6-fast"
      send(id)
      await settled(id, 2)
      const again = launches()[1]
      expect(again).toBeDefined()
      expect(readFileSync(join(again[again.lastIndexOf("--plugin-dir") + 1], "agents", "reviewer.md"), "utf8")).toContain('model: "grok-4.6-fast"')
    } finally {
      engine.stop()
    }
  })

  test("Antigravity is given them as custom agents in its home's folder for them, on Flash or Pro as their model says; one taken away goes, and nothing else there is touched", async () => {
    const engine = subagentEngine(root)
    engine.model = "antigravity/gemini-3-flash"
    await engine.serve()
    const agent = new TestAntigravity(fakeAcp([said("Done.")]), root)
    const folder = join((agent as any).profile, "config", "agents")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "mine.md"), "yours")
    try {
      await run(agent)
      expect(readdirSync(folder).sort()).toEqual([".kuvo-code", "keyword-research.md", "mine.md", "reviewer.md"])
      expect(readFileSync(join(folder, "reviewer.md"), "utf8")).toBe('---\nname: "reviewer"\ndescription: "Reviews a finished change."\nsubagent: true\nmainAgent: false\nmodel: "flash"\n---\n\nYou review. You never edit.\n')
      expect(readFileSync(join(folder, "keyword-research.md"), "utf8")).not.toContain("model:")
      engine.agents.splice(engine.agents.findIndex((each) => each.id === "Keyword Research"), 1)
      root = mkdtempSync(join(base, "case-"))
      await run(new TestAntigravity(fakeAcp([said("Done.")]), dirname(dirname(dirname(dirname(folder))))))
    } finally {
      engine.stop()
    }
    expect(readdirSync(folder).sort()).toEqual([".kuvo-code", "mine.md", "reviewer.md"])
    expect(readFileSync(join(folder, "mine.md"), "utf8")).toBe("yours")
  })

  test("what Antigravity put in its agents folder itself (it writes its home, in the sandbox) never makes the bridge remove or write anything outside it", async () => {
    const engine = subagentEngine(root)
    await engine.serve()
    const agent = new TestAntigravity(fakeAcp([said("Done.")]), root)
    const profile = (agent as any).profile as string
    const folder = join(profile, "config", "agents")
    mkdirSync(folder, { recursive: true })
    const outside = join(root, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, "keep.txt"), "mine")
    writeFileSync(join(outside, "target.txt"), "mine")
    // A record naming a file elsewhere, and an agent's file that's a link to one.
    writeFileSync(join(folder, ".kuvo-code"), JSON.stringify({ "../../../../outside/keep.txt": "x", "gone.md": "x" }))
    symlinkSync(join(outside, "target.txt"), join(folder, "reviewer.md"))
    try {
      await run(agent)
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("mine")
      expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("mine")
      expect(lstatSync(join(folder, "reviewer.md")).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(folder, "reviewer.md"), "utf8")).toContain('name: "reviewer"')
      // Its whole agents folder a link elsewhere: nothing's written there, and the session still starts.
      rmSync(folder, { recursive: true })
      symlinkSync(outside, folder)
      engine.agents.push({ id: "extra", name: "extra", mode: "subagent", description: "More.", system: "", permissions: [] })
      root = mkdtempSync(join(base, "case-"))
      const id = await run(new TestAntigravity(fakeAcp([said("Done.")]), dirname(dirname(dirname(dirname(folder))))))
      expect(readdirSync(outside).sort()).toEqual(["keep.txt", "target.txt"])
      expect(ended(id)).toMatchObject({ type: "idle", outcome: "succeeded" })
    } finally {
      engine.stop()
    }
  })
})

// MARK: Stop

describe("Stopping an ACP agent", () => {
  test("Stop mid-turn: Grok is told to cancel, the turn ends stopped with its words kept and its command stopped; the next message starts it again, on its conversation", async () => {
    const running: [string, any] = ["s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run `npm run dev`", kind: "execute", status: "in_progress", rawInput: { command: "npm run dev" } }]
    const grok = new TestGrok(program(fakeAcp([said("Starting the server."), running], [], undefined, { hangs: true, next: [said("Back.")] }), join(root, "grok")), root)
    const id = start(grok)
    await until(() => tools(id).length > 0)
    expect(await sessions.interrupt(id)).toBe(true)
    await settled(id)
    expect(received().filter((message) => message.method === "session/cancel").map((message) => message.params)).toEqual([{ sessionId: "s1" }])
    expect(ended(id)).toMatchObject({ type: "idle", outcome: "interrupted" })
    expect(words(id)).toBe("Starting the server.")
    expect(tools(id)[0]).toMatchObject({ name: "shell", state: { status: "error", error: { message: "Stopped." } } })
    send(id)
    await settled(id, 2)
    expect(words(id)).toBe("Starting the server.Back.")
    expect(launches()).toHaveLength(2)
    expect(received().filter((message) => message.method === "session/load").map((message) => message.params.sessionId)).toEqual(["s1"])
    expect(ended(id)).toMatchObject({ type: "idle", outcome: "succeeded" })
  })

  test("Stop while it waits on your answer: the ask goes, it's told to cancel, and then what it asked is answered as cancelled (not as a no)", async () => {
    const id = start(agentSaying([command("t1", "rm -rf build")], [], asking("t1")), { permissions: askFirst })
    await until(() => sessions.permissions(id).length > 0)
    expect(await sessions.interrupt(id)).toBe(true)
    await settled(id)
    expect(sessions.permissions(id)).toEqual([])
    await until(() => answers().length > 0)
    expect(answers()).toEqual([{ outcome: "cancelled" }])
    const order = received().map((message) => (message.method === "session/cancel" ? "cancel" : message.id === 900 ? "answer" : undefined)).filter(Boolean)
    expect(order).toEqual(["cancel", "answer"])
    expect(ended(id)).toMatchObject({ type: "idle", outcome: "interrupted" })
    expect(tools(id)[0]).toMatchObject({ name: "shell", state: { status: "error", error: { message: "Stopped." } } })
  })
})

// MARK: Its reply and steps

/** Grok's list of what it keeps going in the background: `tasks` as `[id, command, status]`. */
const backgroundTasks = (tasks: [string, string, string][], outputFile?: string): [string, any] => ["s1", { method: "_x.ai/session/update", update: { sessionUpdate: "background_tasks", tasks: tasks.map(([task_id, command, status]) => ({ task_id, command, description: `Run ${command}`, kind: "bash", status, started_at: "2026-11-10T00:00:00Z", output_file: outputFile })) } }]

describe("Grok's background work after its turn (#262)", () => {
  test("it keeps Grok running past its idle close, shown as still at work; once it ends, Grok is let go", async () => {
    const idleClose = timing.idleClose
    timing.idleClose = 50
    try {
      const grok = new TestGrok(program(fakeAcp([backgroundTasks([["b1", "npm test", "running"]]), said("Waiting for the tests.")], [backgroundTasks([["b1", "npm test", "completed"]])]), join(root, "grok")), root)
      const id = await run(grok)
      expect(sessions.background()[id]?.tasks.map((task) => task.id)).toEqual(["b1"])
      // Let go of only after it ended (its idle close came round several times before that).
      await until(() => received().some((message) => message.exited))
      const later = received().find((message) => message.later).later
      expect(received().find((message) => message.exited).exited).toBeGreaterThanOrEqual(later)
      expect(sessions.background()[id]).toBeUndefined()
    } finally {
      timing.idleClose = idleClose
    }
  })

  test("Grok killed from outside meanwhile: the session is woken, told the command stopped unfinished and where its output is", async () => {
    const output = join(root, "b1.log")
    writeFileSync(output, "PASS one.test\n")
    // (Loaded again, it says again what it said before, its list of what ran then too.)
    const grok = new TestGrok(program(fakeAcp([backgroundTasks([["b1", "npm test", "running"]], output), said("Waiting for the tests.")], [], undefined, { next: [said("Running them again.")], replays: [backgroundTasks([["b1", "npm test", "running"]], output)] }), join(root, "grok")), root)
    const id = await run(grok)
    // (Killed by its PID, as the stray pkill of 2026-11-07 did to Claude Code.)
    process.kill(received().find((message) => message.pid).pid, "SIGTERM")
    await settled(id, 2)
    const told = prompts()[1].params.prompt[0].text as string
    expect(told).toContain("Grok stopped between turns")
    expect(told).toContain("`npm test`")
    // (Where its output went, for it to read: not read for it by the bridge, outside its sandbox.)
    expect(told).toContain(output)
    expect(told).not.toContain("PASS one.test")
    const notice = sessions.messages(id).find((message) => message.type === "synthetic") as any
    expect(notice).toMatchObject({ description: "npm test", metadata: { source: "shell", state: "error", signal: "SIGTERM" } })
    expect(words(id)).toContain("Running them again.")
    // What the load said again of before isn't taken for work going now.
    expect(received().some((message) => message.method === "session/load")).toBe(true)
    expect(sessions.background()[id]).toBeUndefined()
  })
})

describe("An ACP agent's reply", () => {
  test("its thinking, its words, a command with its output as it comes and its result, and what it says after: in steps, as the engine's", async () => {
    const progress = watch("session.tool.progress")
    try {
      const id = await run(
        agentSaying([
          ["s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The tests first." } }],
          said("Running "),
          said("the tests."),
          ["s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run `npm test`", kind: "execute", status: "pending", rawInput: { command: "npm test" } }],
          ["s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "3 passing" } }] }],
          ["s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: "3 passing\n0 failing" } }] }],
          said("All 3 pass."),
        ]),
      )
      const [first, second] = steps(id)
      expect(steps(id)).toHaveLength(2)
      expect(first.content).toMatchObject([
        { type: "reasoning", text: "The tests first." },
        { type: "text", text: "Running the tests." },
        { type: "tool", name: "shell", state: { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "3 passing\n0 failing" }], metadata: { exit: 0 } } },
      ])
      expect(second.content).toMatchObject([{ type: "text", text: "All 3 pass." }])
      expect(progress.of(id).map((data) => data.metadata.output)).toEqual(["3 passing"])
      expect(ended(id)).toMatchObject({ type: "idle", outcome: "succeeded" })
    } finally {
      progress.stop()
    }
  })

  test("an edit shows its change; its to-do list is one list, brought up to date, done as the turn ends", async () => {
    const file = join(root, "a.txt")
    const id = await run(
      agentSaying([
        ["s1", { sessionUpdate: "plan", entries: [{ content: "Edit a.txt", status: "in_progress", priority: "high" }, { content: "Run the tests", status: "pending", priority: "medium" }] }],
        ["s1", { sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit a.txt", kind: "edit", status: "completed", locations: [{ path: file }], content: [{ type: "diff", path: file, oldText: "one\n", newText: "two\n" }] }],
        ["s1", { sessionUpdate: "plan", entries: [{ content: "Edit a.txt", status: "completed", priority: "high" }, { content: "Run the tests", status: "in_progress", priority: "medium" }] }],
        said("Edited."),
      ]),
    )
    expect(tools(id)).toHaveLength(2)
    const [todos, change] = tools(id)
    expect(todos).toMatchObject({ name: "todowrite", state: { status: "completed", input: { todos: [{ content: "Edit a.txt", status: "completed" }, { content: "Run the tests", status: "in_progress" }] } } })
    expect(change).toMatchObject({ name: "edit", state: { status: "completed", input: { path: file }, metadata: { files: [{ file, additions: 1, deletions: 1, status: "modified" }] } } })
    expect(words(id)).toBe("Edited.")
  })
})

// MARK: Usage

describe("What an ACP agent costs", () => {
  test("as it says it (what its conversation has cost so far): each turn adds what's new, once", async () => {
    const cost = (amount: number): [string, any] => ["s1", { sessionUpdate: "usage_update", used: 1_000, size: 200_000, cost: { amount, currency: "USD" } }]
    const id = await run(agentSaying([said("One."), cost(0.02), said("Two."), cost(0.05)], [], undefined, { next: [said("Three."), cost(0.08)] }))
    expect(sessions.get(id).cost).toBeCloseTo(0.05, 6)
    send(id)
    await settled(id, 2)
    expect(sessions.get(id).cost).toBeCloseTo(0.08, 6)
  })
})

describe.skipIf(!canFence)("Grok in the box's sandbox", () => {
  /** Kuvo Code's folder, Grok's own home, and a folder elsewhere. */
  let kuvo: string, home: string, elsewhere: string
  beforeEach(() => {
    kuvo = realpathSync(mkdtempSync(join(base, "kuvo-")))
    home = realpathSync(mkdtempSync(join(base, "grok-home-")))
    elsewhere = realpathSync(mkdtempSync(join(base, "elsewhere-")))
    writeFileSync(join(kuvo, "secret"), "s")
    for (const folder of ["sessions/project", "bin"]) mkdirSync(join(home, folder), { recursive: true })
    process.env.GROK_HOME = home
    process.env.XAI_API_KEY = "xai-test"
    process.env.KUVO_FENCE = realFence(kuvo)
  })
  afterEach(() => {
    delete process.env.KUVO_FENCE
    delete process.env.GROK_HOME
    delete process.env.XAI_API_KEY
    setToolServer(undefined)
  })

  /** Grok whose prompts try `tries` where it runs. */
  const trying = (tries: Record<string, [string, string] | [string, string, string]>) => new TestGrok(program(fakeAcp([], [], undefined, { tries }), join(root, "grok")), root)

  test("Grok runs whole in it: what it runs, even a command you allowed, writes the session's folder and Grok's own state, never its settings, hooks or program (on a Mac), nor elsewhere, and can't read Kuvo Code's folder", async () => {
    const id = await run(trying({
      project: ["write", join(root, "made.txt")],
      state: ["write", join(home, "sessions", "project", "conversation.json")],
      signin: ["write", join(home, "auth.json")],
      lock: ["write", join(home, "grok.lock")],
      settings: ["write", join(home, "config.toml")],
      hooks: ["write", join(home, "hooks-paths")],
      shared: ["write", join(home, "settings.json")],
      statusline: ["write", join(home, "statusline.sh")],
      // What a project always allows, kept with its conversations.
      grants: ["write", join(home, "sessions", "project", "permission.toml")],
      // A link your own Grok would write through, elsewhere.
      link: ["link", join(home, "sessions", "project", "prompt_history.jsonl")],
      models: ["write", join(home, "models_cache.json")],
      program: ["write", join(home, "bin", "grok")],
      elsewhere: ["write", join(elsewhere, "e.txt")],
      kuvo: ["read", join(kuvo, "secret")],
      // Its own sandbox off (one can't run in another on a Mac), its memories off (what it writes
      // there it's told as it starts), never in a shared leader, and its key, which it signs in with.
      sandbox: ["env", "GROK_SANDBOX"],
      memory: ["env", "GROK_MEMORY"],
      leader: ["arg", "--no-leader"],
      key: ["env", "XAI_API_KEY"],
    }), 1, { permissions: askFirst })
    // (Linux grants its home whole: there, a machine's, it's Kuvo Code's own copy of Grok's.)
    const mac = process.platform === "darwin" ? "no" : "yes"
    expect(words(id)).toBe(`project=yes state=yes signin=yes lock=yes settings=${mac} hooks=${mac} shared=${mac} statusline=${mac} grants=${mac} link=${mac} models=${mac} program=${mac} elsewhere=no kuvo=no sandbox=off memory=0 leader=yes key=xai-test`)
  })

  test("Grok saves its sign-in and its running sessions in it, each through a new file renamed into place; a file by such a name never becomes its settings", async () => {
    writeFileSync(join(home, "config.toml"), "")
    const id = await run(trying({
      signin: ["replace", join(home, "auth.json"), join(home, ".4242.0.tmp")],
      running: ["replace", join(home, "active_sessions.json"), join(home, "active_sessions.json.tmp")],
      settings: ["replace", join(home, "config.toml"), join(home, ".4242.1.tmp")],
      hooks: ["replace", join(home, "hooks-paths"), join(home, ".4242.2.tmp")],
      // Its models' list, which names where each model's requests go: not its state, if not settings.
      models: ["replace", join(home, "models_cache.json"), join(home, ".4242.3.tmp")],
      // Its settings by a name it writes, to write them through that.
      named: ["hardlink", join(home, "config.toml"), join(home, ".4242.4.tmp")],
    }), 1, { permissions: askFirst })
    // (Linux grants its home whole: there, a machine's, it's Kuvo Code's own copy of Grok's.)
    const mac = process.platform === "darwin" ? "no" : "yes"
    expect(words(id)).toBe(`signin=yes running=yes settings=${mac} hooks=${mac} models=${mac} named=${mac}`)
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("x")
    if (mac === "no") {
      expect(readFileSync(join(home, "config.toml"), "utf8")).toBe("")
      expect(existsSync(join(home, "hooks-paths"))).toBe(false)
      expect(existsSync(join(home, "models_cache.json"))).toBe(false)
    }
  })

  test("Kuvo Code's tools reach it through the bridge, as its own session's; the app's server itself it can't use", async () => {
    // The app's tool server: with its password, says which session each call was for.
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        request.headers.get("authorization") === "Bearer app-token"
          ? Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: request.headers.get("x-kuvo-session") ?? "anyone" }] } })
          : new Response("Not allowed.", { status: 401 }),
    })
    try {
      setToolServer({ url: `http://127.0.0.1:${app.port}/mcp`, token: "app-token", timeout: 30_000 })
      const id = await run(trying({ tools: ["tools", ""], app: ["app", `http://127.0.0.1:${app.port}/mcp`] }))
      // (Its password, which only the bridge has.)
      expect(words(id)).toBe(`tools=${id} app=no`)
    } finally {
      app.stop(true)
    }
  })

  test("a folder you let the project's commands write (Also Allowed) it writes from its next message", async () => {
    const agent = trying({ elsewhere: ["write", join(elsewhere, "e.txt")] })
    const id = await run(agent)
    expect(words(id)).toBe("elsewhere=no")
    // Also Allowed, as the box writes it for this project.
    const allowed = join(kuvo, "run", "fence", "allowed", createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 32))
    mkdirSync(dirname(allowed), { recursive: true })
    writeFileSync(allowed, elsewhere + "\n")
    send(id, "again")
    await settled(id, 2)
    expect(words(id)).toBe("elsewhere=noelsewhere=yes")
  })

  test("in a session's worktree, a folder you let its project's commands write it writes from its next message, as the project's", async () => {
    // The session's branch: a worktree of the project's repository.
    const project = realpathSync(mkdtempSync(join(base, "project-")))
    const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { stdio: "ignore" })
    git("init", "-q")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first")
    root = join(base, `branch-${basename(project)}`)
    git("worktree", "add", "-q", root)
    root = realpathSync(root)
    const agent = trying({ elsewhere: ["write", join(elsewhere, "e.txt")] })
    const id = await run(agent)
    expect(words(id)).toBe("elsewhere=no")
    // Also Allowed, as the box writes it for the project.
    const allowed = join(kuvo, "run", "fence", "allowed", createHash("sha256").update(project).digest("hex").slice(0, 32))
    mkdirSync(dirname(allowed), { recursive: true })
    writeFileSync(allowed, elsewhere + "\n")
    send(id, "again")
    await settled(id, 2)
    expect(words(id)).toBe("elsewhere=noelsewhere=yes")
  })

  test("a link moved into its state inside a folder is taken away before it runs again, so your own Grok never writes through it", async () => {
    const moved = join(home, "sessions", "another")
    const agent = trying({ moved: ["move in", moved], there: ["linked", join(moved, "prompt_history.jsonl")] })
    const id = await run(agent)
    expect(words(id)).toBe("moved=yes there=yes")
    // Started again (Also Allowed changed for its project, as the box writes it).
    const allowed = join(kuvo, "run", "fence", "allowed", createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 32))
    mkdirSync(dirname(allowed), { recursive: true })
    writeFileSync(allowed, elsewhere + "\n")
    send(id, "again")
    await settled(id, 2)
    // (The folder stays, its link gone.)
    expect(words(id)).toBe("moved=yes there=yesmoved=no there=no")
    expect(() => lstatSync(join(moved, "prompt_history.jsonl"))).toThrow()
  })

  test("one started before the sandbox came on keeps agents from the vault until it's done", async () => {
    const fence = process.env.KUVO_FENCE!
    rmSync(join(fence, "on"))
    const id = await run(trying({ elsewhere: ["write", join(elsewhere, "e.txt")] }))
    expect(words(id)).toBe("elsewhere=yes")
    // The sandbox comes on, with Grok's process from before still running (it's kept for the next message).
    writeFileSync(join(fence, "on"), "set up again")
    noteAgentsInside(!sessions.outside())
    // (The box asks you, once, to restart it, PROTOCOL.md "Sandbox".)
    expect(JSON.parse(readFileSync(join(fence, "agents"), "utf8")).outside).toBe(true)
    // Done (its process closed): now every agent's process runs in it.
    sessions.closeAll()
    noteAgentsInside(!sessions.outside())
    const said = JSON.parse(readFileSync(join(fence, "agents"), "utf8"))
    expect(said.pid).toBe(process.pid)
    expect(said.outside).toBeUndefined()
  })

  test("with the sandbox off, it runs as before: its own program, its own sandbox as you set it", async () => {
    delete process.env.KUVO_FENCE
    const id = await run(trying({ sandbox: ["env", "GROK_SANDBOX"], leader: ["arg", "--no-leader"], elsewhere: ["write", join(elsewhere, "e.txt")] }))
    expect(words(id)).toBe("sandbox=none leader=no elsewhere=yes")
  })
})

describe.skipIf(!canFence)("The computer's MCP servers, for an ACP agent in the box's sandbox", () => {
  let kuvo: string
  let servers: ReturnType<typeof computerServers>
  beforeEach(async () => {
    kuvo = realpathSync(mkdtempSync(join(base, "kuvo-")))
    writeFileSync(join(kuvo, "secret"), "s")
    // The integrations' folder, in Kuvo Code's, where one keeps its sign-in.
    mkdirSync(join(kuvo, "integrations", "files"), { recursive: true })
    process.env.KUVO_INTEGRATIONS = join(kuvo, "integrations")
    process.env.GROK_HOME = realpathSync(mkdtempSync(join(base, "grok-home-")))
    process.env.KUVO_FENCE = realFence(kuvo)
    servers = computerServers(root)
    await servers.serve()
  })
  afterEach(() => {
    servers.stop()
    delete process.env.KUVO_FENCE
    delete process.env.GROK_HOME
    delete process.env.KUVO_INTEGRATIONS
  })

  const trying = (tries: Record<string, [string, string]>) => new TestGrok(program(fakeAcp([], [], undefined, { tries }), join(root, "grok")), root)
  const everyKind: Record<string, [string, string]> = { files: ["server", "files"], notes: ["server", "notes"], tracker: ["server", "tracker"], off: ["server", "off"] }

  test("each reaches it through the bridge with what it needs: a command's server, found on the PATH, with its key; a URL's with its headers or your sign-in; one turned off isn't there", async () => {
    const id = await run(trying(everyKind))
    expect(words(id)).toBe(`files=key:${KEYS.shared} notes=auth:none,key:${KEYS.notes},at:/notes tracker=auth:Bearer ${KEYS.tracker},key:none,at:/tracker off=none`)
  })

  test("a command's server runs in the sandbox as the conversation's commands do: Kuvo Code's folder hidden, but its integration's own folder, where it keeps its sign-in, its to write", async () => {
    const token = join(kuvo, "integrations", "files", "token.json")
    servers.filesEnvironment = { TOKEN_CACHE: token }
    const id = await run(trying({ secret: ["server", `files read ${join(kuvo, "secret")}`], token: ["server", `files write ${token}`], project: ["server", `files write ${join(root, "made.txt")}`] }))
    expect(words(id)).toBe("secret=no token=yes project=yes")
  })

  test("the agent is given only the bridge's address for each and its own key to it, never the servers' keys, commands or addresses", async () => {
    await run(trying(everyKind))
    const given = received().find((message) => message.method === "session/new").params.mcpServers as any[]
    expect(given.map((server) => server.name)).toEqual(expect.arrayContaining(["files", "notes", "tracker"]))
    const text = JSON.stringify(given)
    for (const key of Object.values(KEYS)) expect(text).not.toContain(key)
    expect(text).not.toContain(SERVER_COMMAND)
    // Each the bridge's own address, one port for all.
    const relay = new URL(given[0].url).port
    for (const server of given) expect(server.url).toBe(`http://127.0.0.1:${relay}/mcp/${server.name}`)
  })

  test("a bot's own key (Edit Bot › Keys) is the one its server gets, in place of yours, from the agent's next message on", async () => {
    const agent = trying({ files: ["server", "files"] })
    const id = await run(agent)
    expect(words(id)).toBe(`files=key:${KEYS.shared}`)
    // Given to the bot now, while the same Grok goes on.
    servers.botLayer = servers.botFiles()
    forgetServers()
    send(id, "again")
    await settled(id, 2)
    expect(words(id)).toBe(`files=key:${KEYS.shared}files=key:${KEYS.bot}`)
  })

  test("a call that doesn't carry the conversation's key to the bridge reaches none of them", async () => {
    await run(trying(everyKind))
    const given = received().find((message) => message.method === "session/new").params.mcpServers as any[]
    const files = given.find((server) => server.name === "files")
    const response = await fetch(files.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer guessed" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) })
    expect(response.status).toBe(401)
  })
})

describe.skipIf(!canFence)("Antigravity in the box's sandbox", () => {
  /** Kuvo Code's folder, the bridge's (where Antigravity's agent and home are), and a folder elsewhere. */
  let kuvo: string, home: string, elsewhere: string
  beforeEach(() => {
    kuvo = realpathSync(mkdtempSync(join(base, "kuvo-")))
    home = realpathSync(mkdtempSync(join(base, "agy-home-")))
    elsewhere = realpathSync(mkdtempSync(join(base, "elsewhere-")))
    writeFileSync(join(kuvo, "secret"), "s")
    process.env.KUVO_FENCE = realFence(kuvo)
  })
  afterEach(() => {
    delete process.env.KUVO_FENCE
  })

  /** Antigravity whose prompts try `tries` where it runs (`places`: its home and program, once made). */
  const trying = (tries: (places: { profile: string; program: string }) => Record<string, [string, string]>) => {
    const agent = new TestAntigravity(fakeAcp([], [], undefined, { tries: {} }), home)
    const places = { profile: agent.profile, program: (agent as any).folder as string }
    mkdirSync(join(places.profile, "conversations"), { recursive: true })
    // (Made again, now with what it tries, in the same place.)
    program(fakeAcp([], [], undefined, { tries: tries(places) }), join(places.program, "agy_acp_server.par"))
    return agent
  }

  test("it runs whole in it: it writes the session's folder and its own home, never its program nor elsewhere, can't read Kuvo Code's folder, and writes files itself rather than through Kuvo Code", async () => {
    const id = await run(trying(({ profile, program }) => ({
      project: ["write", join(root, "made.txt")],
      conversation: ["write", join(profile, "conversations", "c.json")],
      signin: ["write", join(profile, "antigravity-acp", "acp_token.json")],
      program: ["write", join(program, "agy_acp_server.par")],
      elsewhere: ["write", join(elsewhere, "e.txt")],
      kuvo: ["read", join(kuvo, "secret")],
    })))
    expect(words(id)).toBe("project=yes conversation=yes signin=yes program=no elsewhere=no kuvo=no")
    // Kuvo Code would read and write outside the sandbox for it: it isn't offered to.
    const initialize = received().find((message) => message.method === "initialize")
    expect(initialize.params.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false })
  })

  /** How signing in ends, once it has (Google's page answered at once, as the fake does). */
  const signedIn = async (agent: TestAntigravity) => {
    const attempt = await agent.signIn()
    await until(() => attempt.status().status !== "pending")
    return attempt.status()
  }

  test("signing in starts it where it can read its own folder, with the bridge's folders inside Kuvo Code's, as on a Mac", async () => {
    // (The bridge's home and temporary folder are inside Kuvo Code's, which the sandbox hides.)
    const agent = new TestAntigravity(fakeAcp([], [], undefined, { readsItsFolder: true }), join(kuvo, "agents"))
    expect(await signedIn(agent)).toEqual({ status: "complete" })
    // Nothing left of where it ran, once it's gone.
    await until(() => readdirSync(join(kuvo, "agents", "temporary", "antigravity")).length === 0)
  })

  test("an agent that stops as it starts says why in a line, and leaves its traceback for the log", async () => {
    const traceback = 'Traceback (most recent call last):\n  File "agy_acp_server.py", line 12, in <module>\nPermissionError: [Errno 1] Operation not permitted'
    const logged: string[] = []
    const log = console.error
    console.error = (...said: unknown[]) => void logged.push(said.join(" "))
    try {
      const ended = await signedIn(new TestAntigravity(fakeAcp([], [], undefined, { fails: traceback }), home))
      expect(ended.status).toBe("failed")
      expect(ended.message).not.toContain("Traceback")
      expect(ended.message).not.toContain("\n")
      expect(ended.message).toContain("wasn't allowed")
      expect(logged.join("\n")).toContain(traceback)
      // Google's own refusal, said as it stops, still reads as one.
      const refused = await signedIn(new TestAntigravity(fakeAcp([], [], undefined, { fails: "google.auth.Error: SUBSCRIPTION_REQUIRED" }), home))
      expect(refused.message).toBe("Google says this account needs an Antigravity subscription.")
    } finally {
      console.error = log
    }
  })

  test("with the sandbox off, it runs as before, reading and writing files through Kuvo Code", async () => {
    delete process.env.KUVO_FENCE
    const id = await run(trying(() => ({ elsewhere: ["write", join(elsewhere, "e.txt")] })))
    expect(words(id)).toBe("elsewhere=yes")
    const initialize = received().find((message) => message.method === "initialize")
    expect(initialize.params.clientCapabilities.fs).toEqual({ readTextFile: true, writeTextFile: true })
  })
})

describe("summarizing when you ask (/compact)", () => {
  test("Grok gets its command exactly as typed, with no instructions before it: no reply, no note", async () => {
    const agent = new TestGrok(program(fakeAcp([["agent_message_chunk", { content: { type: "text", text: "HARBOUR" } }]], [], undefined, { next: [] }), join(root, "grok")), root)
    const id = await run(agent)
    const before = steps(id).length
    expect(sessions.compact(id).state).toBe("compacting")
    await settled(id, 2)
    const prompts = readFileSync(join(root, "received.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((message) => message.method === "session/prompt")
    expect(prompts.at(-1).params.prompt).toEqual([{ type: "text", text: "/compact" }])
    expect(steps(id)).toHaveLength(before)
    expect(notices(id)).toEqual([])
    expect(sessions.messages(id).find((message) => message.type === "compaction")).toMatchObject({ status: "completed", reason: "manual" })
  })

  // What Grok 1.0.77 names its own (read from its program, not seen from a real one): begun with
  // how full the context was, then how it went.
  test("one Grok makes by itself shows while it runs, last, and ends as one finished row", async () => {
    const grok = new TestGrok(program(fakeAcp([["s1", { sessionUpdate: "auto_compact_started", tokens_used: 180_000, context_window: 200_000, percentage: 90 }]], [], undefined, { hangs: true }), join(root, "grok")), root)
    const id = start(grok)
    await until(() => sessions.messages(id).some((message) => message.type === "compaction"))
    expect(sessions.messages(id).at(-1)).toMatchObject({ type: "compaction", status: "running", reason: "auto" })
    await sessions.interrupt(id)
    await settled(id)
    expect(sessions.messages(id).filter((message) => message.type === "compaction")).toMatchObject([{ status: "failed", reason: "auto" }])
  })

  test("one Grok makes by itself that goes through is one finished row, not a note", async () => {
    const agent = new TestGrok(program(fakeAcp([
      ["s1", { sessionUpdate: "auto_compact_started", tokens_used: 180_000, context_window: 200_000, percentage: 90 }],
      ["s1", { sessionUpdate: "auto_compact_completed", tokens_before: 180_000, tokens_after: 20_000, summary_preview: "So far…" }],
      ["s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }],
    ]), join(root, "grok")), root)
    const id = await run(agent)
    expect(sessions.messages(id).filter((message) => message.type === "compaction")).toMatchObject([{ status: "completed", reason: "auto" }])
    expect(notices(id)).toEqual([])
    expect(words(id)).toBe("Done.")
  })

  test("Antigravity can't be asked: it says so, and nothing is sent", async () => {
    const agent = new TestAntigravity(fakeAcp([["agent_message_chunk", { content: { type: "text", text: "hello" } }]]), root)
    const id = await run(agent)
    expect(() => sessions.compact(id)).toThrow("Antigravity can't summarize on request: it does so by itself when the conversation fills up.")
    expect(readFileSync(join(root, "received.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((message) => message.method === "session/prompt")).toHaveLength(1)
  })
})
