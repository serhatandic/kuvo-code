// Codex's thread against a fake `codex app-server`: what Codex 0.16x sends, shown, not lost.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexAgent } from "../src/agents/codex"
import { Auto } from "../src/auto"
import type { Roster } from "../src/roster"
import { Sessions } from "../src/sessions"
import { Store } from "../src/store"
import type { Message } from "../src/wire"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-codex-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** A Codex whose turn sends `events` (each `[method, params]`, with the thread's id filled in). */
function fakeCodex(folder: string, events: [string, any][]): string {
  const script = join(folder, "app-server.js")
  writeFileSync(
    script,
    `const events = ${JSON.stringify(events)}
let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "t1" } } })
    else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "u1", status: "inProgress" } } })
      send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } })
      for (const [method, params] of events) send({ method, params: { threadId: "t1", turnId: "u1", ...params } })
      send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed" } } })
    } else if (message.method === "model/list") send({ id: message.id, result: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", isDefault: true }] } })
    else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
  )
  const launcher = join(folder, "codex")
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

class TestCodex extends CodexAgent {
  constructor(
    readonly launcher: string,
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

let root: string
let codex: TestCodex | undefined
let sessions: Sessions

beforeEach(() => {
  root = mkdtempSync(join(base, "case-"))
})

afterEach(() => {
  sessions?.closeAll()
  codex?.shutdown()
})

async function run(events: [string, any][]) {
  codex = new TestCodex(fakeCodex(root, events), root)
  const agent = codex
  sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
  const id = sessions.create({ model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root } }).id
  sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
  const start = Date.now()
  while (!sessions.messages(id).some((message) => message.type === "idle")) {
    if (Date.now() - start > 10_000) throw new Error("timed out")
    await Bun.sleep(10)
  }
  return id
}

const tools = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "assistant" ? message.content.filter((content: any) => content.type === "tool") : []))
const notices = (id: string) => sessions.messages(id).flatMap((message: Message) => (message.type === "synthetic" ? [(message as { text: string }).text] : []))

describe("Codex, nothing dropped", () => {
  test("an image it made, one it looked at, a function's pictures, and an item kind the bridge doesn't know", async () => {
    const id = await run([
      ["item/completed", { item: { type: "imageGeneration", id: "g1", status: "completed", revisedPrompt: "an apple", savedPath: "/tmp/apple.png" } }],
      ["item/completed", { item: { type: "imageView", id: "v1", path: "/tmp/look.jpg" } }],
      ["item/completed", { item: { type: "functionCallOutput", id: "f1", name: "shot", namespace: "browser", output: [{ type: "input_text", text: "here" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] } }],
      ["item/completed", { item: { type: "hologram", id: "h1", output: "beamed" } }],
    ])
    const [made, viewed, called, unknown] = tools(id)
    expect(made).toMatchObject({ name: "generate_image", state: { status: "completed", content: [{ type: "text" }, { type: "file", mime: "image/png", uri: "file:///tmp/apple.png" }] } })
    expect(viewed).toMatchObject({ name: "read", state: { content: [{ type: "text" }, { type: "file", mime: "image/jpeg" }] } })
    expect(called).toMatchObject({ name: "browser.shot", state: { content: [{ type: "text", text: "here" }, { type: "file", uri: "data:image/png;base64,AAAA" }] } })
    expect(unknown).toMatchObject({ name: "hologram", state: { status: "completed", content: [{ type: "text", text: "beamed" }] } })
  })

  test("what Codex says for you to read, hooks, and an image it couldn't make", async () => {
    const id = await run([
      ["warning", { message: "Your config has an unknown key." }],
      ["model/rerouted", { fromModel: "gpt-a", toModel: "gpt-b", reason: "highRiskCyberActivity" }],
      ["hook/completed", { run: { id: "k1", eventName: "preToolUse", status: "blocked", entries: [{ kind: "stop", text: "Not on main." }] } }],
      ["item/completed", { item: { type: "imageGeneration", id: "g2", status: "failed", failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: 1900000000 } } }],
    ])
    expect(notices(id)).toEqual(["Your config has an unknown key.", "gpt-b answered instead of gpt-a (Codex moves security-sensitive work to it)."])
    const [hook, image] = tools(id)
    expect(hook).toMatchObject({ name: "hook", state: { status: "error" } })
    expect(JSON.stringify(hook.state)).toContain("Not on main.")
    expect(image.state.status).toBe("error")
    expect(JSON.stringify(image.state)).toContain("limit for making images")
  })

  test("a step whose start wasn't told still shows, with an MCP result's pictures and links", async () => {
    const id = await run([
      ["item/completed", { item: { type: "mcpToolCall", id: "m1", server: "kuvo-browser", tool: "browser_screenshot", arguments: {}, status: "completed", result: { content: [{ type: "image", data: "BBBB", mimeType: "image/png" }, { type: "resource_link", name: "Page", uri: "https://example.com" }] } } }],
      ["item/completed", { item: { type: "webSearch", id: "w1", query: "kuvo", action: { type: "openPage", url: "https://kuvo.run" } } }],
    ])
    const [shot, search] = tools(id)
    expect(shot).toMatchObject({ name: "kuvo-browser_browser_screenshot", state: { content: [{ type: "text", text: "Page: https://example.com" }, { type: "file", uri: "data:image/png;base64,BBBB" }] } })
    expect(search.state.content[0].text).toContain("Opened https://kuvo.run")
  })
})

/** A Codex whose turn spawns an agent (thread t2) that goes on after it: asks first if `asks`, and works until it's stopped otherwise. */
function spawningCodex(folder: string, asks: boolean): string {
  const script = join(folder, "app-server.js")
  writeFileSync(
    script,
    `let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "t1" } } })
    else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "u1", status: "inProgress" } } })
      send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } })
      send({ method: "item/completed", params: { threadId: "t1", turnId: "u1", item: { type: "subAgentActivity", id: "sa1", kind: "started", agentThreadId: "t2", agentPath: "/root/worker" } } })
      send({ method: "turn/started", params: { threadId: "t2", turn: { id: "u2" } } })
      if (${asks}) send({ id: 500, method: "item/commandExecution/requestApproval", params: { threadId: "t2", turnId: "u2", itemId: "c1", command: "rm -rf build" } })
      setTimeout(() => send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed" } } }), 50)
    } else if (message.id === 500) {
      send({ method: "item/completed", params: { threadId: "t2", turnId: "u2", item: { type: "agentMessage", id: "a2", text: "Answered: " + message.result.decision } } })
      send({ method: "turn/completed", params: { threadId: "t2", turn: { id: "u2", status: "completed" } } })
    } else if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} })
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } } })
    } else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
  )
  const launcher = join(folder, "codex")
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

async function until(condition: () => boolean, ms = 10_000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

describe("Codex's agents in the background", () => {
  async function spawn(asks: boolean) {
    codex = new TestCodex(spawningCodex(root, asks), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    // (Titled: no title is asked of this Codex.)
    const id = sessions.create({ title: "Spawn", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root }, permissions: [{ action: "shell", resource: "*", effect: "ask" }] }).id
    sessions.prompt(id, { id: "msg_codex_test_002", text: "go", files: [], delivery: "steer" })
    await until(() => sessions.messages(id).some((message) => message.type === "idle"))
    const child = tools(id)[0].state.metadata.sessionID as string
    return { id, child }
  }

  test("what one asks during the turn that spawned it is still yours to answer after that turn", async () => {
    const { id, child } = await spawn(true)
    await Bun.sleep(50)
    expect(sessions.permissions(id)).toHaveLength(1)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "once")
    await until(() => sessions.messages(child).some((message) => message.type === "idle"))
    expect(JSON.stringify(sessions.messages(child))).toContain("Answered: accept")
  })

  test("Stop in its session stops it, and so does Codex stopping", async () => {
    const { child } = await spawn(false)
    expect(sessions.active()).toContain(child)
    expect(await sessions.interrupt(child)).toBe(true)
    await until(() => sessions.messages(child).some((message) => message.type === "idle"))
    expect(sessions.messages(child).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
  })

  test("one still at work when Codex stops ends with it", async () => {
    const { child } = await spawn(false)
    codex!.shutdown()
    await until(() => sessions.messages(child).some((message) => message.type === "idle"))
    expect(sessions.messages(child).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
  })
})

describe("Codex's context", () => {
  test("how full it is, as its last request was, against the window Codex says its model has", async () => {
    const id = await run([
      ["item/started", { item: { type: "agentMessage", id: "m1", text: "" } }],
      ["item/agentMessage/delta", { itemId: "m1", delta: "Done." }],
      ["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }],
      ["thread/tokenUsage/updated", { tokenUsage: { modelContextWindow: 258_400, last: { inputTokens: 52_000, cachedInputTokens: 48_000, outputTokens: 900, reasoningOutputTokens: 300 } } }],
    ])
    const last = sessions.messages(id).filter((message: any) => message.type === "assistant").at(-1) as any
    expect(last.tokens).toMatchObject({ input: 4_000, output: 600, reasoning: 300, cache: { read: 48_000 } })
    const models = await codex!.models()
    expect(models.find((model) => model.id === "gpt-test")?.limit.context).toBe(258_400)
  })
})
