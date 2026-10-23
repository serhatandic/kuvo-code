// An ACP agent (as Grok and Antigravity speak it), faked: what it sends shows, nothing lost; what
// it asks is answered as the session's rules and modes say; Stop stops it; what it costs is counted.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpThread, acpTiming } from "../src/acp"
import type { Agent } from "../src/agent"
import { AntigravityAgent } from "../src/agents/antigravity"
import { GrokAgent } from "../src/agents/grok"
import { Auto } from "../src/auto"
import { subscribe } from "../src/events"
import type { Roster } from "../src/roster"
import { Sessions } from "../src/sessions"
import { Store } from "../src/store"
import type { PermissionRule } from "../src/wire"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-acp-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let root: string
let sessions: Sessions

beforeEach(() => {
  root = mkdtempSync(join(base, "case-"))
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
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n")
log({ argv: process.argv.slice(2) })
let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } })
const prompts = ${JSON.stringify(prompts)}
const setup = ${JSON.stringify({ sessionId: "s1", ...script.setup })}
const refuses = ${JSON.stringify(script.refuses ?? [])}
const later = ${JSON.stringify(later)}
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
    else if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } } })
    else if (message.method === "session/new" || message.method === "session/load") send({ id: message.id, result: setup })
    else if (message.method === "session/prompt") {
      prompt = message.id
      turn = prompts[Math.min(before(), prompts.length - 1)]
      asked = 0
      stopped = false
      for (const [sessionId, value] of turn.updates) update(sessionId, value)
      if (turn.requests.length) ask()
      else end()
      if (later.length) setTimeout(() => { for (const [sessionId, value] of later) update(sessionId, value) }, 300)
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

/** The script as a program, run with what it's given (Grok's `grok`, Antigravity's server). */
function program(script: string, path: string): string {
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
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
