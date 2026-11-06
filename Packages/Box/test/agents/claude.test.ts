// Claude Code's thread against a fake SDK: messages you send partway, taken late or never.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { subscribe } from "../../src/agents/events"
import { repositoryOf } from "../../src/agents/fence"
import { setToolServer } from "../../src/agents/kuvotools"
import { callServer, computerServers, KEYS } from "./support/servers"
import { Auto } from "../../src/agents/auto"
import { Queue } from "../../src/agents/queue"
import type { Roster } from "../../src/agents/roster"
import { Sessions } from "../../src/agents/sessions"
import { shellOutput, shells } from "../../src/agents/shells"
import { Store } from "../../src/agents/store"
import type { Message, PermissionRule } from "../../src/agents/wire"

// Claude Code's own sign-in, as on a machine (a Mac's own is Kuvo Code's: accounts-check.test.ts).
const keychain = ClaudeAgent.keychain
ClaudeAgent.keychain = false
afterAll(() => {
  ClaudeAgent.keychain = keychain
})

/** A Claude Code that answers as the test says: what it was sent, and what it says. */
class FakeClaude {
  sent: any[] = []
  out = new Queue<any>()
  interrupts = 0
  outputs = new Map<string, string>()
  stopped: string[] = []
  closed = false
  onInterrupt?: () => void
  /** As it's told its MCP servers (as a turn starts): it stops there, say. */
  onServers?: () => Promise<void>
  /** Why it stopped, its stream ending in that error, as the SDK's does when Claude Code exits. */
  private crashed?: Error

  /** One-off prompts it answered (a title). */
  oneOffs: string[] = []

  /** The permission modes it was switched to after it started. */
  modes: string[] = []

  options: any
  /** The MCP servers it was given over its pipe. */
  mcpServers?: Record<string, unknown>

  /** The models it lists, how much each holds (unsaid: an older Claude Code), and the ones it was asked about. */
  models: any[] = []
  windows?: Record<string, number>
  asked: string[] = []
  private model?: string

  query = (options: { prompt: AsyncIterable<any> | string; options?: any }) => {
    if (typeof options.prompt === "string") {
      this.oneOffs.push(options.prompt)
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "A Fake Title." }
      })()
    }
    const prompt = options.prompt
    this.options = options.options
    void (async () => {
      for await (const message of prompt) this.sent.push(message)
    })()
    const out = this.out
    return {
      [Symbol.asyncIterator]: () => {
        const inner = out[Symbol.asyncIterator]()
        const next = (): Promise<IteratorResult<any>> => inner.next().then((result) => (this.crashed && result.done ? Promise.reject(this.crashed) : result))
        return { next, return: inner.return }
      },
      setMcpServers: async (servers: Record<string, unknown>) => {
        this.mcpServers = servers
        await this.onServers?.()
      },
      initializationResult: async () => ({ models: this.models }),
      setModel: async (model?: string) => {
        this.model = model
      },
      getContextUsage: async () => {
        if (!this.windows) throw new Error("Unknown control request: get_context_usage")
        this.asked.push(this.model ?? "")
        return { maxTokens: this.windows[this.model ?? ""] }
      },
      applyFlagSettings: async () => {},
      setPermissionMode: async (mode: string) => {
        this.modes.push(mode)
      },
      getTaskOutput: async (task: string) => ({ output: this.outputs.get(task) ?? "", total_bytes: Buffer.byteLength(this.outputs.get(task) ?? ""), truncated: false }),
      stopTask: async (task: string) => {
        this.stopped.push(task)
      },
      interrupt: async () => {
        this.interrupts++
        this.onInterrupt?.()
      },
      close: () => {
        this.closed = true
        out.close()
      },
    }
  }

  /** Claude Code exits, its stream ending in `error`. */
  crash(error: Error) {
    this.crashed = error
    this.out.close()
  }

  say(text: string, uuids: string[]) {
    this.out.push({ type: "assistant", message: { id: `m${Math.random()}`, content: [{ type: "text", text }] }, user_message_uuids: uuids, parent_tool_use_id: null })
  }

  result(uuids: string[], subtype = "success", more: Record<string, unknown> = {}) {
    this.out.push({ type: "result", subtype, is_error: subtype !== "success", result: "", user_message_uuids: uuids, ...more })
  }

  /**
   * One request's reply, streamed as Claude Code streams it (each block whole as it ends), with
   * what the request used: its prompt (`input`, read from and written to the cache) and its output.
   */
  streams(uuids: string[], blocks: any[], usage = { input: 10, read: 0, write: 0, output: 5 }) {
    const id = `msg_${Math.random().toString(36).slice(2)}`
    const event = (event: any) => this.out.push({ type: "stream_event", event, parent_tool_use_id: null })
    event({ type: "message_start", message: { id, usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, output_tokens: 1 } } })
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        event({ type: "content_block_start", index, content_block: { type: "text", text: "" } })
        event({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })
      } else {
        event({ type: "content_block_start", index, content_block: { ...block, input: {} } })
        event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
      }
      event({ type: "content_block_stop", index })
      this.out.push({ type: "assistant", message: { id, content: [block] }, parent_tool_use_id: null, user_message_uuids: uuids })
    })
    event({ type: "message_delta", delta: { stop_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn" }, usage: { output_tokens: usage.output } })
    event({ type: "message_stop" })
  }

  /** What a tool came back with, and Claude Code's own account of it (a command's output, an edit's hunks). */
  toolResult(id: string, content: any, options: { error?: boolean; structured?: any } = {}) {
    this.out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: options.error }] }, parent_tool_use_id: null, tool_use_result: options.structured })
  }

  /** Your rules' hook, as Claude Code runs it before a tool: what it decided (nothing, ask or deny), and why. */
  async hook(name: string, input: Record<string, unknown>, toolUseID: string): Promise<{ decision?: string; reason?: string }> {
    const said = await this.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: toolUseID })
    return { decision: said?.hookSpecificOutput?.permissionDecision, reason: said?.hookSpecificOutput?.permissionDecisionReason }
  }

  /** Claude Code asks whether it may use a tool (its own settings say ask, or the hook did). */
  canUse(name: string, input: Record<string, unknown>, toolUseID: string, more: Record<string, unknown> = {}): Promise<any> {
    return this.options.canUseTool(name, input, { toolUseID, signal: new AbortController().signal, ...more })
  }
}

class TestClaude extends ClaudeAgent {
  /** Signed in with an API key (paid per token) rather than a plan. */
  key = false
  /** Its program: one that fails, unless a test gives it another. */
  at = "/bin/false"
  constructor(
    readonly fake: FakeClaude,
    home: string,
    instance?: { id: string; home?: string },
  ) {
    super({ home, temporary: home, deps: {} as any }, instance)
  }
  override async sdk(): Promise<any> {
    return { query: this.fake.query }
  }
  override executable() {
    return this.at
  }
  override usesKey() {
    return this.key
  }
  /** When its sign-in was last written (signing in again, renewed): never, unless a test says. */
  signInWritten = 0
  protected override async credentialsWritten() {
    return this.signInWritten
  }
}

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-claude-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let root: string
let fake: FakeClaude
let claude: TestClaude
let sessions: Sessions
let provider: string

beforeEach(() => {
  root = mkdtempSync(join(base, "case-"))
  fake = new FakeClaude()
  claude = new TestClaude(fake, root)
  provider = claude.providerID
  sessions = withBlocks([])
})

/** The sessions, with Settings › Permissions' Blocks as the engine gives them. */
function withBlocks(blocks: PermissionRule[]) {
  return new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === claude.providerID ? claude : undefined) } as unknown as Roster, new Auto(root), undefined, async () => blocks)
}

afterEach(() => sessions.closeAll())

async function until(condition: () => boolean, ms = 3_000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

const idles = (id: string) => sessions.messages(id).filter((message) => message.type === "idle") as Extract<Message, { type: "idle" }>[]
const texts = (id: string) => sessions.messages(id).flatMap((message) => (message.type === "assistant" ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : []))

describe("Claude Code that stops", () => {
  test("as it starts, before it takes your message: the turn fails with why it stopped", async () => {
    fake.onServers = async () => {
      fake.crash(new Error("Claude Code process exited with code 1"))
      // (Its stream has ended by the time the turn goes on.)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_crash01", text: "hello", files: [], delivery: "steer" })
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("failed")
    expect(idles(id)[0].error?.message).toContain("exited with code 1")
    expect(idles(id)[0].error?.message).not.toContain("this.input")
  })

  test("Claude turns its sign-in away: the turn fails as one to sign in again for, its words said once, in the card, and that Claude Code goes", async () => {
    // The apps hear it, to show the account needs a sign-in (the card's Sign In, the chip).
    const updated: unknown[] = []
    const unsubscribe = subscribe((event) => {
      if (event.type === "integration.updated") updated.push(event.data.integrationID)
    })
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_auth001", text: "hello", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const uuid = fake.sent[0].uuid
    const words = "Failed to authenticate: OAuth session expired and could not be refreshed"
    fake.out.push({ type: "assistant", message: { id: "msg_auth", content: [{ type: "text", text: words }] }, error: "authentication_failed", parent_tool_use_id: null, user_message_uuids: [uuid] })
    fake.result([uuid], "success", { is_error: true, result: words })
    await until(() => idles(id).length === 1)
    const idle = idles(id)[0]
    expect(idle.outcome).toBe("failed")
    expect(idle.error?.type).toBe("signin")
    expect(texts(id).join(" ")).not.toContain("Failed to authenticate")
    // The next message starts a Claude Code that reads the sign-in as it is then.
    expect(fake.closed).toBe(true)
    unsubscribe()
    expect(updated).toContain(provider)
  })

  test("another error Claude gives: its own words, in the failure", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_long001", text: "hello", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const uuid = fake.sent[0].uuid
    const words = "API Error: prompt is too long: 210000 tokens > 200000 maximum"
    fake.out.push({ type: "assistant", message: { id: "msg_long", content: [{ type: "text", text: words }] }, error: "invalid_request", parent_tool_use_id: null, user_message_uuids: [uuid] })
    fake.result([uuid], "success", { is_error: true, result: words })
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].error?.message).toContain("prompt is too long")
    expect(texts(id).join(" ")).not.toContain("prompt is too long")
  })

  test("after Claude turned its sign-in away, a message fails at once as one to sign in for, until it's signed in again", async () => {
    // \`claude auth status\` still says signed in (Claude revoked it).
    claude.at = join(root, "claude")
    writeFileSync(claude.at, `#!/bin/sh\necho '{"loggedIn":true,"authMethod":"claude.ai"}'\n`, { mode: 0o755 })
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_auth002", text: "hello", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const uuid = fake.sent[0].uuid
    fake.out.push({ type: "assistant", message: { id: "msg_auth2", content: [{ type: "text", text: "Failed to authenticate" }] }, error: "authentication_failed", parent_tool_use_id: null, user_message_uuids: [uuid] })
    fake.result([uuid], "success", { is_error: true, result: "Failed to authenticate" })
    await until(() => idles(id).length === 1)
    // Again, as a wake-up or Try Again would: said at once, not sent to Claude Code to wait on.
    sessions.prompt(id, { id: "msg_claude_auth003", text: "again", files: [], delivery: "steer" })
    await until(() => idles(id).length === 2)
    expect(idles(id)[1].outcome).toBe("failed")
    expect(idles(id)[1].error?.type).toBe("signin")
    expect(fake.sent).toHaveLength(1)
    // Signed in again, at once (in Terminal, say): the next one goes.
    claude.signInWritten = Date.now()
    fake.out = new Queue<any>()
    sessions.prompt(id, { id: "msg_claude_auth004", text: "once more", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
  })
})

describe("Claude Code, messages sent partway", () => {
  test("one it takes after its last step: the turn goes on until it has answered it", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_first01", text: "first", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    sessions.prompt(id, { id: "msg_claude_second1", text: "second", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    expect(fake.sent[1].priority).toBe("next")
    const [first, second] = fake.sent.map((message) => message.uuid)
    fake.say("on the first", [first])
    fake.result([first])
    await Bun.sleep(50)
    // Not over: it takes the second next.
    expect(idles(id)).toHaveLength(0)
    fake.say("on the second", [second])
    fake.result([second])
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    expect(texts(id).join(" ")).toContain("on the second")
    // Named from your first message, by the session's model, as the engine's sessions are.
    await until(() => sessions.get(id).title === "A Fake Title")
    expect(fake.oneOffs[0]).toContain("first")
  })

  test("one taken partway ends with the turn's one result", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_first02", text: "first", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    sessions.prompt(id, { id: "msg_claude_second2", text: "second", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    const [first, second] = fake.sent.map((message) => message.uuid)
    fake.say("on both", [first, second])
    fake.result([first, second])
    await until(() => idles(id).length === 1)
    expect(fake.closed).toBe(false)
  })

  test("stopped before it took one: that Claude Code goes, and the message is handed over next time", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_first03", text: "first", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    sessions.prompt(id, { id: "msg_claude_second3", text: "the missed one", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.onInterrupt = () => fake.result([first], "error_during_execution")
    await sessions.interrupt(id, false)
    await until(() => idles(id).length === 1)
    expect(fake.closed).toBe(true)
    // The next message opens a new Claude Code, which is handed what it missed.
    const again = new FakeClaude()
    fake.sent = []
    fake.out = again.out
    fake.closed = false
    sessions.prompt(id, { id: "msg_claude_third04", text: "go on", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const text = fake.sent[0].message.content.find((part: any) => part.type === "text").text
    expect(text).toContain("the missed one")
    expect(text).toContain("go on")
  })
})

describe("Claude Code, on its own", () => {
  test("a command it leaves running shows in the bar; when it ends, the turn it starts on its own shows too", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_bg_00001", text: "start the server", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tool1", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "t1", task_type: "local_bash", description: "Start the dev server", tool_use_id: "tool1", is_backgrounded: true })
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_bash", description: "Start the dev server" }] })
    fake.say("It's running.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    // In the bar, with what it printed.
    const [job] = shells(root).filter((job) => job.metadata.sessionID === id && job.status === "running")
    expect(job.command).toBe("npm run dev")
    fake.outputs.set("t1", "ready on :3000\n")
    expect((await shellOutput(job.id, 0, 24_000))?.output).toBe("ready on :3000\n")
    // It ends; Claude Code carries on by itself, and a turn here takes it.
    fake.out.push({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed", tool_use_id: "tool1", output_file: "/nonexistent", summary: "exit code 0" })
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [] })
    fake.say("The server stopped.", [])
    fake.result([])
    await until(() => idles(id).length === 2)
    expect(shells(root).find((one) => one.id === job.id)?.status).toBe("exited")
    const notice = sessions.messages(id).find((message) => message.type === "synthetic") as any
    expect(notice.metadata).toMatchObject({ source: "shell", state: "completed", exit: 0 })
    expect(notice.description).toBe("npm run dev")
    expect(texts(id).join(" ")).toContain("The server stopped.")
  })

  test("a turn of its own answered before your message: your turn ends with the result that answers yours", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_bg_00002", text: "hello", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [mine] = fake.sent.map((message) => message.uuid)
    fake.say("about the command that ended", [])
    fake.result([])
    await Bun.sleep(50)
    expect(idles(id)).toHaveLength(0)
    fake.say("hello to you", [mine])
    fake.result([mine])
    await until(() => idles(id).length === 1)
    expect(texts(id).join(" ")).toContain("hello to you")
  })
})

describe("Claude Code, on its own, twice", () => {
  test("two turns of its own one after the other are two turns here", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_bg_00004", text: "hello", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [mine] = fake.sent.map((message) => message.uuid)
    fake.say("hi", [mine])
    fake.result([mine])
    await until(() => idles(id).length === 1)
    fake.say("the first command ended", [])
    fake.result([])
    fake.say("the second command ended", [])
    fake.result([])
    await until(() => idles(id).length === 3)
    expect(texts(id).join(" ")).toContain("the first command ended")
    expect(texts(id).join(" ")).toContain("the second command ended")
    expect(fake.interrupts).toBe(0)
  })
})

describe("Claude Code, on its own, not taken", () => {
  test("a turn it begins while an undo is staged is stopped, and the undo stays", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_bg_00003", text: "hello", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [mine] = fake.sent.map((message) => message.uuid)
    fake.say("hi", [mine])
    fake.result([mine])
    await until(() => idles(id).length === 1)
    await sessions.stageRevert(id, "msg_claude_bg_00003")
    fake.say("about the command that ended", [])
    await until(() => fake.interrupts === 1)
    fake.result([])
    await Bun.sleep(50)
    expect(sessions.get(id).revert?.messageID).toBe("msg_claude_bg_00003")
    expect(idles(id)).toHaveLength(1)
    expect(sessions.messages(id).some((message) => message.type === "synthetic")).toBe(false)
  })
})

describe("Claude Code's subagents in the background", () => {
  test("one goes on after the turn: its work shows in its session, it can ask you, and it ends when Claude Code says", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_sub_0001", text: "look into it in the background", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "call1", name: "Agent", input: { description: "Look into it", prompt: "Look into it", subagent_type: "general-purpose", run_in_background: true } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "ag1", task_type: "local_agent", description: "Look into it", tool_use_id: "call1", is_backgrounded: true })
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "ag1", task_type: "local_agent", description: "Look into it" }] })
    fake.out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call1", content: "Launched in the background." }] }, parent_tool_use_id: null })
    fake.say("Launched.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    const child = sessions.list(root, id)[0]?.id
    expect(child).toBeTruthy()
    expect(sessions.active()).toContain(child)
    // After the turn: its words in its session.
    fake.out.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Found the cause." }] }, parent_tool_use_id: "call1" })
    await until(() => texts(child).includes("Found the cause."))
    // It asks, as its own; you answer in the conversation that started it.
    const asked = fake.options.canUseTool("Bash", { command: "rm -rf build" }, { toolUseID: "t2", agentID: "ag1" })
    sessions.update(id, { permissions: [{ action: "shell", resource: "*", effect: "ask" }] })
    await until(() => sessions.permissions(id).length === 1)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "once")
    expect((await asked).behavior).toBe("allow")
    // Claude Code says it's done: its session's work ends.
    fake.out.push({ type: "system", subtype: "task_notification", task_id: "ag1", status: "completed", tool_use_id: "call1", output_file: "", summary: "done" })
    await until(() => !sessions.active().includes(child))
    expect(sessions.messages(child).at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" })
  })
})

describe("what Claude Code left running, as the box reads it", () => {
  test("a command, a subagent and another task count until each ends; a stop ends them all", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_left_001", text: "start them", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    expect(sessions.background()[id]).toBeUndefined()
    fake.out.push({ type: "assistant", message: { id: "m1", content: [
      { type: "tool_use", id: "tool1", name: "Bash", input: { command: "npm run dev", run_in_background: true } },
      { type: "tool_use", id: "call1", name: "Agent", input: { description: "Look into it", prompt: "Look into it", subagent_type: "general-purpose", run_in_background: true } },
    ] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "t1", task_type: "local_bash", description: "Start the dev server", tool_use_id: "tool1", is_backgrounded: true })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "ag1", task_type: "local_agent", description: "Look into it", tool_use_id: "call1", is_backgrounded: true })
    const everything = [
      { task_id: "t1", task_type: "local_bash", description: "Start the dev server" },
      { task_id: "ag1", task_type: "local_agent", description: "Look into it" },
      { task_id: "m1", task_type: "monitor_mcp", description: "Watch it" },
    ]
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: everything })
    fake.out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call1", content: "Launched in the background." }] }, parent_tool_use_id: null })
    fake.say("All going.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    // Its turn is over: it's the rest that still run, each once.
    await until(() => (sessions.background()[id]?.tasks.length ?? 0) > 0)
    const left = sessions.background()[id]
    expect(left.commands.map((each) => each.command)).toEqual(["npm run dev"])
    expect(left.subagents).toHaveLength(1)
    expect(left.tasks.map((each) => each.id)).toEqual(["m1"])
    await sessions.stopBackground(id)
    // Each is asked to stop; it's Claude Code that says they did, and then nothing's left.
    expect([...fake.stopped].sort()).toEqual(["ag1", "m1", "t1"])
    fake.out.push({ type: "system", subtype: "task_notification", task_id: "ag1", status: "stopped", tool_use_id: "call1", output_file: "", summary: "stopped" })
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [] })
    await until(() => !sessions.background()[id])
    expect(sessions.active()).not.toContain(left.subagents[0].id)
  })
})

describe("Claude Code stopping with work left running", () => {
  test("what it left running went with it, and whoever follows the session hears so", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_exit_001", text: "start it", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tool1", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "t1", task_type: "local_bash", description: "Start the dev server", tool_use_id: "tool1", is_backgrounded: true })
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_bash", description: "Start the dev server" }] })
    fake.say("It's up.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    await until(() => (sessions.background()[id]?.commands.length ?? 0) === 1)
    const heard: unknown[] = []
    const unsubscribe = subscribe((event) => {
      if (event.type === "session.background.updated") heard.push(event.data.sessionID)
    })
    fake.crash(new Error("Claude Code process exited with code 1"))
    await until(() => heard.includes(id))
    unsubscribe()
    expect(sessions.background()[id]).toBeUndefined()
  })

  test("a turn it begins on its own says so, whatever began it", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_own_0001", text: "start it", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.say("Sent it off.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    // Nothing of yours is in it: it goes on with something it had going.
    fake.say("Carrying on.", [])
    await until(() => texts(id).includes("Carrying on."))
    const own = sessions.messages(id).find((message) => message.type === "synthetic")
    expect((own as { metadata?: { source?: string } } | undefined)?.metadata?.source).toBe("agent")
  })
})

describe("Writing to a Claude Code subagent", () => {
  /** A conversation whose subagent (call1, Claude Code's ag1) went off in the background; `done`, it has finished since. */
  async function sendOff(done: boolean) {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_rel_0001", text: "look into it in the background", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "call1", name: "Agent", input: { description: "Look into it", prompt: "Look into it", subagent_type: "general-purpose", run_in_background: true } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "ag1", task_type: "local_agent", description: "Look into it", tool_use_id: "call1", is_backgrounded: true })
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "ag1", task_type: "local_agent", description: "Look into it" }] })
    fake.out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call1", content: "Launched in the background." }] }, parent_tool_use_id: null })
    fake.out.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Looking." }] }, parent_tool_use_id: "call1" })
    fake.say("Launched.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    const child = sessions.list(root, id)[0].id
    await until(() => texts(child).includes("Looking."))
    if (done) {
      fake.out.push({ type: "system", subtype: "task_notification", task_id: "ag1", status: "completed", tool_use_id: "call1", output_file: "", summary: "done" })
      await until(() => idles(child).length === 1)
    }
    return { id, child }
  }
  const users = (id: string) => sessions.messages(id).flatMap((message) => (message.type === "user" ? [message.text] : []))

  test("your message shows in its conversation at once, and the agent that started it is asked to pass it on, as it is", async () => {
    const { id, child } = await sendOff(false)
    expect(sessions.get(child).metadata?.kuvo).toMatchObject({ messages: { via: "parent" } })
    sessions.prompt(child, { id: "msg_claude_rel_0002", text: "Check the tests too", files: [], delivery: "steer" })
    expect(users(child)).toContain("Check the tests too")
    // The conversation that started it gets a note, by Claude Code's id for it, and shows it.
    await until(() => fake.sent.length === 2)
    const note = fake.sent[1].message.content.find((part: any) => part.type === "text").text
    expect(note).toContain('SendMessage tool (to: "ag1")')
    expect(note).toContain("Check the tests too")
    // Nothing else under way there: its turn is only for this.
    expect(note).toContain("then end your turn")
    expect(note).toContain("don't act on it yourself")
    const shown = sessions.messages(id).find((message) => message.type === "synthetic") as any
    expect(shown).toMatchObject({ description: "Your message for “Look into it”" })
    // It passes it on; the subagent, still at work, takes it there.
    fake.out.push({ type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "send1", name: "SendMessage", input: { to: "ag1", message: "Check the tests too" } }] }, parent_tool_use_id: null, user_message_uuids: [fake.sent[1].uuid] })
    fake.out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "send1", content: "Message queued for delivery." }] }, parent_tool_use_id: null })
    fake.result([fake.sent[1].uuid])
    await until(() => idles(id).length === 2)
    // Passed on: nothing says otherwise.
    expect(sessions.messages(child).some((message) => message.type === "synthetic")).toBe(false)
    fake.out.push({ type: "assistant", message: { id: "m4", content: [{ type: "text", text: "The tests pass." }] }, parent_tool_use_id: "call1" })
    await until(() => texts(child).includes("The tests pass."))
    fake.out.push({ type: "system", subtype: "task_notification", task_id: "ag1", status: "completed", tool_use_id: "call1", output_file: "", summary: "done" })
    await until(() => idles(child).length === 1)
    expect(idles(child)[0].outcome).toBe("succeeded")
  })

  test("one that's done is picked up again: what it says after shows in the same conversation, until it's done again", async () => {
    const { id, child } = await sendOff(true)
    sessions.prompt(child, { id: "msg_claude_rel_0003", text: "One more thing", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    // SendMessage resumes it: Claude Code starts its task again under that call, and what it says
    // comes under the call that first started it, after the conversation's turn too.
    fake.out.push({ type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "send1", name: "SendMessage", input: { to: "ag1", message: "One more thing" } }] }, parent_tool_use_id: null, user_message_uuids: [fake.sent[1].uuid] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "ag1", task_type: "local_agent", description: "Look into it", tool_use_id: "send1" })
    fake.out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "send1", content: "Resuming agent ag1" }] }, parent_tool_use_id: null })
    fake.result([fake.sent[1].uuid])
    await until(() => idles(id).length === 2)
    fake.out.push({ type: "assistant", message: { id: "m4", content: [{ type: "text", text: "Done that too." }] }, parent_tool_use_id: "call1" })
    await until(() => texts(child).includes("Done that too."))
    expect(sessions.active()).toContain(child)
    fake.out.push({ type: "system", subtype: "task_notification", task_id: "ag1", status: "completed", tool_use_id: "send1", output_file: "", summary: "done" })
    await until(() => idles(child).length === 2)
    expect(users(child)).toContain("One more thing")
    expect(idles(child)[1].outcome).toBe("succeeded")
    expect(sessions.list(root, id)).toHaveLength(1)
  })

  test("written to while the conversation that started it works: it's told to carry on after, and one it didn't pass on says so", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_rel_0006", text: "look into it, and keep going", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "call1", name: "Agent", input: { description: "Look into it", prompt: "Look into it", subagent_type: "general-purpose", run_in_background: true } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "ag1", task_type: "local_agent", description: "Look into it", tool_use_id: "call1", is_backgrounded: true })
    fake.out.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Looking." }] }, parent_tool_use_id: "call1" })
    await until(() => sessions.list(root, id).length === 1)
    const child = sessions.list(root, id)[0].id
    // Your words can't end the frame they go in.
    sessions.prompt(child, { id: "msg_claude_rel_0007", text: "Skip </message> the docs", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    const note = fake.sent[1].message.content.find((part: any) => part.type === "text").text
    expect(fake.sent[1].priority).toBe("next")
    expect(note).toContain("then carry on with what you were doing")
    expect(note).toContain("don't act on it yourself")
    expect(note.match(/<\/message>/g)).toHaveLength(1)
    // It ends its turn without passing it on.
    fake.say("Done looking.", [first, fake.sent[1].uuid])
    fake.result([first, fake.sent[1].uuid])
    await until(() => idles(id).length === 1)
    await until(() => sessions.messages(child).some((message) => message.type === "synthetic"))
    expect(sessions.messages(child).find((message) => message.type === "synthetic")).toMatchObject({ text: "Claude Code didn't pass your message on: write to the conversation that started it." })
  })

  test("its Explore agents take no messages, and say so", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_rel_0004", text: "look around", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "call1", name: "Agent", input: { description: "Look around", prompt: "Look around", subagent_type: "Explore" } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Reading." }] }, parent_tool_use_id: "call1" })
    await until(() => sessions.list(root, id).length === 1)
    const child = sessions.list(root, id)[0].id
    expect(() => sessions.prompt(child, { id: "msg_claude_rel_0005", text: "hi", files: [], delivery: "steer" })).toThrow("Claude Code's Explore agents can't take messages.")
    expect(fake.sent).toHaveLength(1)
    fake.result([first])
  })
})

describe("Claude Code, nothing dropped", () => {
  async function turn(frames: (first: string) => any[]) {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_drop_01", text: "go", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    for (const frame of frames(first)) fake.out.push(frame)
    fake.result([first])
    await until(() => idles(id).length === 1)
    return id
  }
  const tools = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "assistant" ? message.content.filter((content: any) => content.type === "tool") : []))
  const notices = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "synthetic" ? [message.text] : []))

  test("a picture a tool brings back, and a server tool's results", async () => {
    const id = await turn((first) => [
      { type: "assistant", message: { id: "a1", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/tmp/shot.png" } }] }, parent_tool_use_id: null, user_message_uuids: [first] },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } }] }] }, parent_tool_use_id: null },
      { type: "assistant", message: { id: "a2", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "kuvo" } }, { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", title: "Kuvo", url: "https://kuvo.run" }] }] }, parent_tool_use_id: null },
    ])
    const [read, search] = tools(id)
    expect(read.state.content).toEqual([{ type: "text", text: "" }, { type: "file", uri: "data:image/png;base64,CCCC", mime: "image/png" }])
    expect(search).toMatchObject({ name: "websearch", state: { status: "completed", content: [{ type: "text", text: "Kuvo — https://kuvo.run" }] } })
  })

  test("what Claude Code says about itself: compacting, retrying, and a kind this bridge doesn't know", async () => {
    const id = await turn(() => [
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } },
      { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, error_status: 529, error: "overloaded" },
      { type: "system", subtype: "api_retry", attempt: 3, max_retries: 10, error_status: 529, error: "overloaded" },
      { type: "system", subtype: "brand_new_thing", content: "Something new to read." },
      { type: "system", subtype: "post_turn_summary", summary: "Already shown." },
    ])
    expect(notices(id)).toEqual(["Claude Code summarized the conversation to make room.", "Claude's API is overloaded: trying again (2/10).", "Something new to read."])
  })

  test("several hooks failing the same way at the same moment show as one row, and the same failure again later as another", async () => {
    const failed = { type: "system", subtype: "hook_response", hook_name: "SessionStart:compact", hook_event: "SessionStart", outcome: "error", stderr: "Failed to run" }
    const id = await turn(() => [failed, failed, failed, failed, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }, failed])
    const row = "Your SessionStart:compact hook failed: Failed to run."
    expect(notices(id)).toEqual([row, "Claude Code summarized the conversation to make room.", row])
  })
})

describe("Claude Code's models", () => {
  const listed = [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Best for everyday, complex tasks" },
    { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Haiku 4.5 · Fast" },
    { value: "opus[1m]", displayName: "Opus 4.8 (1M context)", description: "Opus 4.8 with 1M context" },
  ]

  /** Each model's window, once it's what's expected (Claude Code's usual ones come first), or as it is after a while. */
  async function windows(claude: ClaudeAgent, expected: Record<string, number>) {
    let said: Record<string, number> = {}
    for (const start = Date.now(); Date.now() - start < 3_000; await Bun.sleep(20)) {
      said = Object.fromEntries((await claude.models()).map((model) => [model.id, model.limit.context]))
      if (JSON.stringify(said) === JSON.stringify(expected)) break
    }
    return said
  }

  test("each holds what Claude Code says it does on your plan, which its list doesn't say", async () => {
    fake.models = listed
    fake.windows = { default: 1_000_000, "claude-haiku-4-5": 200_000, "opus[1m]": 1_000_000 }
    const want = { default: 1_000_000, opus: 1_000_000, "claude-haiku-4-5": 200_000, "opus[1m]": 1_000_000 }
    expect(await windows(new TestClaude(fake, root), want)).toEqual(want)
    expect(fake.asked).toEqual(["default", "claude-haiku-4-5", "opus[1m]"])
  })

  test("an older Claude Code that doesn't say: as its list says", async () => {
    fake.models = listed
    const want = { default: 200_000, opus: 200_000, "claude-haiku-4-5": 200_000, "opus[1m]": 1_000_000 }
    expect(await windows(new TestClaude(fake, root), want)).toEqual(want)
  })
})

/** A session on Claude Code with your message sent: its id, and Claude Code's id for the message. */
async function begin(options: { permissions?: PermissionRule[]; agent?: string } = {}) {
  const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root }, agent: options.agent, permissions: options.permissions }).id
  const sent = fake.sent.length
  sessions.prompt(id, { id: `msg_claude_turn_${String(sent).padStart(4, "0")}`, text: "go", files: [], delivery: "steer" })
  await until(() => fake.sent.length === sent + 1)
  return { id, first: fake.sent[sent].uuid as string }
}

const steps = (id: string) => sessions.messages(id).filter((message) => message.type === "assistant") as Extract<Message, { type: "assistant" }>[]
const toolCalls = (id: string) => steps(id).flatMap((message) => message.content.filter((content) => content.type === "tool")) as any[]

/** Ask First, as the composer's menu sets it. */
const askFirst: PermissionRule[] = ["edit", "write", "patch", "shell", "webfetch", "external_directory"].map((action) => ({ action, resource: "*", effect: "ask" }))

describe("Claude Code and the computer's MCP servers", () => {
  test("it's told them over its pipe, through the bridge, without their keys, and a call reaches each with what it needs", async () => {
    const servers = computerServers(root)
    await servers.serve()
    try {
      await begin()
      const given = fake.mcpServers as Record<string, any>
      expect(Object.keys(given).sort()).toEqual(["files", "notes", "tracker"])
      const text = JSON.stringify(given)
      for (const key of Object.values(KEYS)) expect(text).not.toContain(key)
      for (const server of Object.values(given)) expect(server.type).toBe("http")
      expect(await callServer(given.files)).toBe(`key:${KEYS.shared}`)
      expect(await callServer(given.notes)).toBe(`auth:none,key:${KEYS.notes},at:/notes`)
      // (On the same pipe as before: its conversation goes on.)
      expect(fake.closed).toBe(false)
    } finally {
      servers.stop()
    }
  })
})

describe("Claude Code in the box's sandbox", () => {
  // The box's sandbox folder, as the box sets it up (link/fence/state.ts): its rules, and its
  // launcher for an agent run whole, which here notes what it was told and runs the program.
  let fence: string
  let givenSettings: string | undefined
  const turnOn = () => {
    writeFileSync(join(fence, "policy.json"), JSON.stringify({ hidden: [], readable: [], writable: [], readOnly: [] }))
    writeFileSync(join(fence, "on"), "")
  }
  const told = () => join(root, "launched.json")
  beforeEach(() => {
    fence = join(root, "fence")
    mkdirSync(join(fence, "shell"), { recursive: true })
    writeFileSync(
      join(fence, "shell", "run"),
      `#!/bin/sh\nprintf '{"program":"%s","args":"%s","folder":"%s","work":"%s","git":"%s","own":"%s","state":"%s","kept":"%s","read":"%s","port":"%s","shell":"%s","tmp":"%s"}' "$KUVO_FENCE_SHELL" "$*" "$(pwd -P)" "$KUVO_FENCE_WORK" "$KUVO_FENCE_GIT" "$KUVO_FENCE_OWN" "$(printf '%s' "$KUVO_FENCE_STATE" | tr '\\n' ' ')" "$(printf '%s' "$KUVO_FENCE_KEPT" | tr '\\n' ' ')" "$(printf '%s' "$KUVO_FENCE_READ" | tr '\\n' ' ')" "$KUVO_FENCE_PORT" "\${CLAUDE_CODE_SHELL-none}" "\${CLAUDE_CODE_TMPDIR-none}" > ${JSON.stringify(told())}\nexec "$KUVO_FENCE_SHELL" "$@"\n`,
      { mode: 0o700 },
    )
    process.env.KUVO_FENCE = fence
    // (Its settings folder a test's own: it makes things in it as it starts here.)
    givenSettings = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-settings")
  })
  afterEach(() => {
    delete process.env.KUVO_FENCE
    if (givenSettings === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = givenSettings
    setToolServer(undefined)
  })

  /** Claude Code started as the SDK starts it, through what the bridge gave it: what it printed, and what the launcher was told. */
  async function started() {
    const child = fake.options.spawnClaudeCodeProcess({ command: "/bin/echo", args: ["--output-format", "stream-json"], cwd: root, env: { PATH: process.env.PATH, OPENCODE_SESSION_ID: "ses_x", CLAUDE_CODE_TMPDIR: join(root, "kuvo-own") } })
    let printed = ""
    child.stdout.on("data", (chunk: Buffer) => (printed += chunk))
    await new Promise((resolve) => child.once("exit", resolve))
    return { printed: printed.trim(), launched: JSON.parse(readFileSync(told(), "utf8")) }
  }

  test("while it's on, Claude Code runs whole in it, so what it starts does too (its commands, hooks and MCP servers, a project's too): in the conversation's folder, keeping its conversations but not its settings, with Kuvo Code's tools through the relay", async () => {
    turnOn()
    spawnSync("git", ["init", "-q", root])
    setToolServer({ url: "http://127.0.0.1:9/mcp", token: "app-password", timeout: 10_000 })
    await begin()
    const { printed, launched } = await started()
    const work = realpathSync(root)
    // The program as the SDK names it, with its arguments, started by the box's launcher.
    expect(printed).toBe("--output-format stream-json")
    expect(launched).toMatchObject({ program: "/bin/echo", args: "--output-format stream-json", folder: work, work, git: join(work, ".git") })
    // Its settings folder its own: its conversations, sign-in and caches written; never its
    // settings or hooks, which run outside the sandbox when you use it yourself.
    expect(launched.own).toBe(join(work, "claude-settings"))
    expect(launched.state.split(" ")).toEqual(expect.arrayContaining(["projects", "sessions", "todos", ".credentials.json*"]))
    // Never what your own Claude Code, outside, runs or reads later: its settings, the shells its
    // commands source, a session's environment, an editor's lock, a settings backup.
    for (const later of ["settings.json", "shell-snapshots", "session-env", "ide", "backups"]) expect(launched.state.split(" ")).not.toContain(later)
    expect(launched.kept.split(" ")).toEqual(expect.arrayContaining(["settings*.json", "hooks"]))
    // Its commands are in the sandbox already: no shell of the box's in it, nor a temporary folder
    // of Kuvo Code's own (hidden from it).
    expect(launched.shell).toBe("none")
    expect(launched.tmp).toBe("none")
    // Kuvo Code's tools, through the relay, the one port it may reach.
    const servers = fake.mcpServers as Record<string, any>
    const tools = Object.values(servers)[0]
    expect(tools.url).toBe(`http://127.0.0.1:${launched.port}/mcp`)
    expect(tools.headers.Authorization).not.toBe("Bearer app-password")
  })

  test("its hooks can start: this conversation's environment is there before it starts, and for the new name after /clear, as plain folders outside what it writes", async () => {
    turnOn()
    await begin()
    const environments = join(process.env.CLAUDE_CONFIG_DIR!, "session-env")
    const mine = join(environments, fake.options.sessionId)
    expect(lstatSync(mine).isDirectory()).toBe(true)
    // A new name it chose.
    fake.out.push({ type: "system", subtype: "init", session_id: "cleared-conversation" })
    await until(() => existsSync(join(environments, "cleared-conversation")))
    expect(lstatSync(join(environments, "cleared-conversation")).isDirectory()).toBe(true)
    // Never a name that would lead out of there.
    fake.out.push({ type: "system", subtype: "init", session_id: "../escaped" })
    fake.out.push({ type: "system", subtype: "init", session_id: "cleared-again" })
    await until(() => existsSync(join(environments, "cleared-again")))
    expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, "escaped"))).toBe(false)
    // As it stops, what's empty goes; one with your own hook's file in it stays.
    writeFileSync(join(environments, "cleared-again", "sessionstart-hook-0.sh"), "export YOURS=1\n")
    const { launched } = await started()
    expect(launched.state.split(" ")).not.toContain("session-env")
    expect(readdirSync(environments)).toEqual(["cleared-again"])
    expect(readFileSync(join(environments, "cleared-again", "sessionstart-hook-0.sh"), "utf8")).toBe("export YOURS=1\n")
  })

  test("one being replaced stopping leaves the new one's environment where it is", async () => {
    turnOn()
    const { id, first } = await begin()
    const mine = join(process.env.CLAUDE_CONFIG_DIR!, "session-env", fake.options.sessionId)
    const replaced = fake.options
    fake.result([first])
    await until(() => idles(id).length === 1)
    // The conversation goes to Full Access: at its next message its Claude Code starts again.
    mkdirSync(join(fence, "full"), { recursive: true })
    writeFileSync(join(fence, "full", id), "")
    sessions.prompt(id, { id: "msg_claude_turn_replaced", text: "again", files: [], delivery: "steer" })
    await until(() => fake.options !== replaced)
    const child = replaced.spawnClaudeCodeProcess({ command: "/bin/echo", args: [], cwd: root, env: { PATH: process.env.PATH, OPENCODE_SESSION_ID: "ses_x" } })
    await new Promise((resolve) => child.once("exit", resolve))
    expect(existsSync(mine)).toBe(true)
  })

  test("a hook the sandbox kept from its session's environment says so in words, and the same for each, once", async () => {
    turnOn()
    const { id } = await begin()
    const environment = join(process.env.CLAUDE_CONFIG_DIR!, "session-env", fake.options.sessionId, "sessionstart-hook-0.sh")
    const failed = (stderr: string) => ({ type: "system", subtype: "hook_response", hook_name: "SessionStart:compact", outcome: "error", exit_code: 1, stderr })
    fake.out.push(failed(`/bin/sh: ${environment}: Operation not permitted`))
    fake.out.push(failed(`/bin/sh: ${environment}: Operation not permitted`))
    fake.out.push(failed(`Failed to run: EPERM: operation not permitted, mkdir '${join(process.env.CLAUDE_CONFIG_DIR!, "session-env", "new")}'`))
    fake.out.push(failed("rate limited by the tool"))
    const rows = () => sessions.messages(id).filter((message) => message.type === "synthetic").map((message: any) => message.text)
    await until(() => rows().length === 3)
    expect(rows()).toEqual([
      "Your SessionStart:compact hook failed: the sandbox doesn't let a hook set environment variables with CLAUDE_ENV_FILE.",
      "Your SessionStart:compact hook failed: Claude Code can't start this one in the sandbox.",
      "Your SessionStart:compact hook failed: rate limited by the tool.",
    ])
  })

  test("with the sandbox off, it makes its own as it always has", async () => {
    await begin()
    expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, "session-env"))).toBe(false)
  })

  test("on, with no launcher of the box's yet (a box from before), Claude Code doesn't start, rather than outside the sandbox", async () => {
    turnOn()
    rmSync(join(fence, "shell"), { recursive: true })
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_turn_0001", text: "go", files: [], delivery: "steer" })
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].error?.message ?? "").toContain("restart Kuvo Code")
    expect(fake.options).toBeUndefined()
  })

  describe("what it says on its error output as it stops", () => {
    const plain = "Claude Code process exited with code 1"
    const launcher = (script: string) => writeFileSync(join(fence, "shell", "run"), `#!/bin/sh\n${script}\n`, { mode: 0o700 })
    /** Claude Code started through the launcher, as the SDK starts it. */
    const spawned = () => fake.options.spawnClaudeCodeProcess({ command: "/bin/echo", args: [], cwd: root, env: { PATH: process.env.PATH, OPENCODE_SESSION_ID: "ses_x" } })
    const closed = (child: any) => new Promise((resolve) => child.once("close", resolve))
    const newSession = () => sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    const send = (id: string, turn: number) => sessions.prompt(id, { id: `msg_claude_turn_000${turn}`, text: "go", files: [], delivery: "steer" })
    /** Starts, says what the launcher says, and stops before it takes the message: what the failure says. */
    const stopsAsItStarts = async (id: string, turn: number) => {
      const before = idles(id).length
      fake.onServers = async () => {
        await closed(spawned())
        fake.crash(new Error(plain))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      send(id, turn)
      await until(() => idles(id).length === before + 1)
      return idles(id)[before].error?.message
    }

    /** Says this line as it stops, and what the failure makes of it. */
    const saying = async (line: string) => {
      launcher(`cat >&2 <<'SAID'\n${line}\nSAID\nexit 1`)
      return (await stopsAsItStarts(newSession(), 1))?.slice(plain.length + 2)
    }

    test("no secret an error line can hold is said back", async () => {
      turnOn()
      for (const [line, said] of [
        ["cannot reach https://me:p@ss@proxy.test/v1", "cannot reach https://…@proxy.test/v1"],
        ["sent Bearer abc.def-ghi, Authorization: Basic Zm9v", "sent Bearer …, Authorization: …"],
        [`API_KEY="a b" TOKEN=k1 x-api-key: k2`, `API_KEY=… TOKEN=… x-api-key: …`],
        [`{"apiKey":"k3","password": "k4"}`, `{"apiKey":…,"password": …}`],
        ["password: k5 auth_token: k6", "password: … auth_token: …"],
        ["ran it with --token k7 --api-key=k8", "ran it with --token … --api-key=…"],
      ]) expect(await saying(line)).toBe(said)
    })

    test("a plain sentence keeps its words", async () => {
      turnOn()
      for (const line of ["Bearer token expired", "Invalid API key: not found", "Invalid token: expired", "max_tokens=4096 is too many", "Authorization failed for that account"]) expect(await saying(line)).toBe(line)
    })

    test("a line too long to keep whole is left out, so no piece of a token gets through", async () => {
      turnOn()
      launcher(`{ printf 'sk-ant-oat01-'; head -c 5000 /dev/zero | tr '\\0' a; echo; } >&2\nexit 1`)
      expect(await stopsAsItStarts(newSession(), 1)).toBe(plain)
    })

    test("what an earlier Claude Code said isn't why a later one stopped", async () => {
      turnOn()
      const id = newSession()
      launcher(`echo "the first one's reason" >&2\nexit 1`)
      expect(await stopsAsItStarts(id, 1)).toBe(`${plain}: the first one's reason`)
      launcher("exit 1")
      expect(await stopsAsItStarts(id, 2)).toBe(plain)
    })

    test("with the sandbox turned off since, what the one in it said isn't why the next one stopped", async () => {
      turnOn()
      const id = newSession()
      launcher(`echo "the sandboxed one's reason" >&2\nexit 1`)
      expect(await stopsAsItStarts(id, 1)).toBe(`${plain}: the sandboxed one's reason`)
      rmSync(join(fence, "on"))
      fake.onServers = async () => {
        fake.crash(new Error(plain))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      send(id, 2)
      await until(() => idles(id).length === 2)
      expect(idles(id)[1].error?.message).toBe(plain)
    })

    test("one being replaced, still writing as it goes, doesn't speak for the new one", async () => {
      turnOn()
      const go = join(root, "go")
      const id = newSession()
      fake.onServers = async () => {
        launcher(`( while [ ! -e ${JSON.stringify(go)} ]; do sleep 0.01; done; echo "the old one's last words" >&2 ) &\nexit 0`)
        const old = spawned()
        await new Promise((resolve) => old.once("exit", resolve))
        launcher("exit 1")
        await closed(spawned())
        writeFileSync(go, "")
        await closed(old)
        fake.crash(new Error(plain))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      send(id, 1)
      await until(() => idles(id).length === 1)
      expect(idles(id)[0].error?.message).toBe(plain)
    })

    test("a warning from when it was working isn't why it stops later", async () => {
      turnOn()
      launcher(`echo "warning: something old" >&2\nexit 0`)
      const id = newSession()
      send(id, 1)
      await until(() => fake.sent.length === 1)
      await closed(spawned())
      fake.say("done", [fake.sent[0].uuid])
      fake.result([fake.sent[0].uuid])
      await until(() => idles(id).length === 1)
      expect(idles(id)[0].outcome).toBe("succeeded")
      send(id, 2)
      await until(() => fake.sent.length === 2)
      fake.crash(new Error(plain))
      await until(() => idles(id).length === 2)
      expect(idles(id)[1].error?.message).toBe(plain)
    })

    test("crashing in a turn, the failure says its error, not the stack under it", async () => {
      turnOn()
      launcher(`printf 'Error: out of memory\\n    at run (cli.js:1:1)\\n\\nBun v1.3.14 (macOS arm64)\\n' >&2\nexit 1`)
      const id = newSession()
      send(id, 1)
      await until(() => fake.sent.length === 1)
      await closed(spawned())
      fake.crash(new Error(plain))
      await until(() => idles(id).length === 1)
      expect(idles(id)[0].error?.message).toBe(`${plain}: Error: out of memory`)
    })

    describe("with its error output held open by what it left running", () => {
      const within = ClaudeAgent.heardWithin
      afterEach(() => {
        ClaudeAgent.heardWithin = within
      })
      /** Says `before`, exits, and leaves a process holding its error output until `go` is there, which then says `after`. */
      const holding = (go: string, before: string, after: string) => launcher(`printf '${before}' >&2\n( while [ ! -e ${JSON.stringify(go)} ]; do sleep 0.01; done; printf '${after}' >&2 ) &\nexit 1`)
      const stops = () => {
        fake.onServers = async () => {
          const child = spawned()
          await new Promise((resolve) => child.once("exit", resolve))
          fake.crash(new Error(plain))
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }

      test("what comes after it exits still counts", async () => {
        turnOn()
        ClaudeAgent.heardWithin = 60_000
        const go = join(root, "go")
        holding(go, "", "said as it went\\n")
        const id = newSession()
        fake.onServers = async () => {
          const child = spawned()
          await new Promise((resolve) => child.once("exit", resolve))
          fake.crash(new Error(plain))
          await new Promise((resolve) => setTimeout(resolve, 0))
          writeFileSync(go, "")
        }
        send(id, 1)
        await until(() => idles(id).length === 1, 30_000)
        expect(idles(id)[0].error?.message).toBe(`${plain}: said as it went`)
      }, 40_000)

      test("the failure doesn't wait for long, and leaves out a line still coming", async () => {
        turnOn()
        const go = join(root, "go")
        holding(go, "a whole line\\nhttps://me:hunt", "er2@proxy\\n")
        const id = newSession()
        stops()
        try {
          send(id, 1)
          await until(() => idles(id).length === 1, 30_000)
          expect(idles(id)[0].error?.message).toBe(`${plain}: a whole line`)
        } finally {
          writeFileSync(go, "")
        }
      }, 40_000)

      test("you can stop the turn while it waits", async () => {
        turnOn()
        ClaudeAgent.heardWithin = 60_000
        const go = join(root, "go")
        holding(go, "", "")
        const id = newSession()
        try {
          send(id, 1)
          await until(() => fake.sent.length === 1)
          const child = spawned()
          await new Promise((resolve) => child.once("exit", resolve))
          fake.crash(new Error(plain))
          await new Promise((resolve) => setTimeout(resolve, 0))
          await sessions.interrupt(id, false)
          await until(() => idles(id).length === 1)
          expect(idles(id)[0].outcome).toBe("interrupted")
        } finally {
          writeFileSync(go, "")
        }
      })
    })
  })

  test("stopped as it starts there, the turn fails with what Claude Code said, never with a token in it", async () => {
    turnOn()
    // Claude Code quits as it starts in the sandbox, saying why on its error output (as 2.1.318 did in
    // a folder the sandbox hid from it).
    writeFileSync(join(fence, "shell", "run"), `#!/bin/sh\necho "starting with sk-ant-oat01-abcdefghijklmnop" >&2\necho "Can't read the current directory (EPERM). Start Claude Code from a different directory." >&2\nexit 1\n`, { mode: 0o700 })
    fake.onServers = async () => {
      const child = fake.options.spawnClaudeCodeProcess({ command: "/bin/echo", args: [], cwd: root, env: { PATH: process.env.PATH, OPENCODE_SESSION_ID: "ses_x" } })
      await new Promise((resolve) => child.once("close", resolve))
      fake.crash(new Error("Claude Code process exited with code 1"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_turn_0001", text: "go", files: [], delivery: "steer" })
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("failed")
    expect(idles(id)[0].error?.message).toBe("Claude Code process exited with code 1: Can't read the current directory (EPERM). Start Claude Code from a different directory.")

    // A token it printed as it stopped is never said back.
    writeFileSync(join(fence, "shell", "run"), `#!/bin/sh\necho "Invalid token sk-ant-oat01-abcdefghijklmnop" >&2\nexit 1\n`, { mode: 0o700 })
    sessions.prompt(id, { id: "msg_claude_turn_0002", text: "again", files: [], delivery: "steer" })
    await until(() => idles(id).length === 2)
    expect(idles(id)[1].error?.message).toBe("Claude Code process exited with code 1: Invalid token sk-ant-…")
  })

  test("its own sandbox stays off while the box's is on, whatever your settings or a project's say (one can't run inside the other)", async () => {
    turnOn()
    await begin()
    expect(fake.options.sandbox).toEqual({ enabled: false })
  })

  test("a file you attach reaches it as a copy it can read, outside Kuvo Code's own folder", async () => {
    turnOn()
    const file = join(root, "kuvo-own", "plan.pdf")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "%PDF-1.4\n")
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_turn_0001", text: "read it", files: [{ uri: `file://${file}`, name: "plan.pdf" }], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const said = fake.sent[0].message.content.at(-1).text as string
    const copy = said.split("- ").at(-1)!.trim()
    expect(copy.startsWith(join(fence, "attachments") + "/")).toBe(true)
    expect(readFileSync(copy, "utf8")).toBe("%PDF-1.4\n")
  })

  test("off, Claude Code runs as it always does; turned on, its next turn starts it again in the sandbox", async () => {
    const { id, first } = await begin()
    expect(fake.options.spawnClaudeCodeProcess).toBeUndefined()
    fake.streams([first], [{ type: "text", text: "Done." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    turnOn()
    sessions.prompt(id, { id: "msg_claude_turn_9001", text: "again", files: [], delivery: "steer" })
    await until(() => fake.options.spawnClaudeCodeProcess !== undefined)
  })

  test("signed out of its own sign-in on a machine, the Claude Code a session has open goes: its next message starts one signed out", async () => {
    claude = new TestClaude(fake, root, { id: "default", home: join(root, "agents") })
    claude.at = "/usr/bin/true"
    const { id, first } = await begin()
    fake.streams([first], [{ type: "text", text: "Done." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    const started = fake.options
    await claude.signOut!()
    expect(fake.closed).toBe(false)
    sessions.prompt(id, { id: "msg_claude_turn_9001", text: "again", files: [], delivery: "steer" })
    await until(() => fake.closed)
    await until(() => fake.options !== started)
  })

  test("restarted as you said to, a Claude Code started before the sandbox was on finishes its turn first, then its next starts in the sandbox, going on with its conversation", async () => {
    const { id, first } = await begin()
    turnOn()
    expect(sessions.outside()).toBe(true)
    // At work: it waits for its turn to end.
    expect(sessions.restartOutside()).toBe(true)
    expect(fake.closed).toBe(false)
    const conversation = fake.options.sessionId
    fake.out.push({ type: "system", subtype: "init", session_id: conversation })
    fake.streams([first], [{ type: "text", text: "Done." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    // Between turns: it goes now.
    expect(sessions.restartOutside()).toBe(false)
    expect(fake.closed).toBe(true)
    expect(sessions.outside()).toBe(false)
    sessions.prompt(id, { id: "msg_claude_turn_9001", text: "again", files: [], delivery: "steer" })
    await until(() => fake.options.spawnClaudeCodeProcess !== undefined)
    expect(fake.options.resume).toBe(conversation)
  })

  test("restarted as you said to, a Claude Code started before the sandbox was on lets a command it left running finish first", async () => {
    const { id, first } = await begin()
    turnOn()
    fake.out.push({ type: "system", subtype: "task_started", task_id: "t1", task_type: "local_bash", description: "Start the dev server", tool_use_id: "tool1", is_backgrounded: true })
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_bash", description: "Start the dev server" }] })
    fake.streams([first], [{ type: "text", text: "It's running." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    // Between turns, but its command still runs: it waits.
    expect(sessions.restartOutside()).toBe(true)
    expect(fake.closed).toBe(false)
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [] })
    await until(() => sessions.restartOutside() === false)
    expect(fake.closed).toBe(true)
    expect(sessions.outside()).toBe(false)
  })

  test("a worktree's commits go to its repository's own folder, which its commands write; a .git that names a folder not naming it back gives none", () => {
    const repository = join(root, "repo")
    spawnSync("git", ["init", "-q", repository])
    spawnSync("git", ["-C", repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"])
    spawnSync("git", ["-C", repository, "worktree", "add", "-q", join(root, "tree")])
    expect(repositoryOf(realpathSync(join(root, "tree")))).toBe(realpathSync(join(repository, ".git")))
    mkdirSync(join(root, "posing"))
    writeFileSync(join(root, "posing", ".git"), `gitdir: ${join(repository, ".git", "worktrees", "tree")}\n`)
    expect(repositoryOf(realpathSync(join(root, "posing")))).toBe("")
  })
})

describe("Claude Code's permissions", () => {
  test("Ask First: a command it would run is your card on its step; Allow Once lets it run", async () => {
    const { id, first } = await begin({ permissions: askFirst })
    fake.streams([first], [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }])
    // Asked, even where Claude Code's own settings would let it run.
    expect((await fake.hook("Bash", { command: "npm test" }, "toolu_1")).decision).toBe("ask")
    const answer = fake.canUse("Bash", { command: "npm test" }, "toolu_1", { title: "Claude wants to run npm test" })
    await until(() => sessions.permissions(id).length === 1)
    const [card] = sessions.permissions(id)
    expect(card).toMatchObject({ action: "shell", resources: ["npm test"], message: "Claude wants to run npm test", source: { type: "tool", id: "toolu_1" } })
    sessions.replyPermission(id, card.id, "once")
    expect(await answer).toEqual({ behavior: "allow", updatedInput: { command: "npm test" }, toolUseID: "toolu_1" })
    fake.toolResult("toolu_1", "3 passed")
    fake.streams([first], [{ type: "text", text: "They pass." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(toolCalls(id)[0]).toMatchObject({ name: "shell", state: { status: "completed", content: [{ type: "text", text: "3 passed" }] } })
  })

  test("Allow Always: Claude Code keeps it for this session only, and the same command isn't asked about again; one more in the line is", async () => {
    const { id } = await begin({ permissions: askFirst })
    const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }]
    const answer = fake.canUse("Bash", { command: "npm test" }, "toolu_1", { suggestions })
    await until(() => sessions.permissions(id).length === 1)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
    // Not written into the project's own Claude settings.
    expect((await answer).updatedPermissions).toEqual([{ ...suggestions[0], destination: "session" }])
    expect((await fake.hook("Bash", { command: "npm test" }, "toolu_2")).decision).toBeUndefined()
    expect(await fake.canUse("Bash", { command: "npm test" }, "toolu_2")).toMatchObject({ behavior: "allow" })
    expect(sessions.permissions(id)).toHaveLength(0)
    expect((await fake.hook("Bash", { command: "npm test && rm -rf build" }, "toolu_3")).decision).toBe("ask")
  })

  test("Allow Always on an edit lets every later edit in the session through, to other files and by other tools, without asking", async () => {
    const [a, b] = [join(root, "a.ts"), join(root, "b.ts")]
    writeFileSync(a, "const a = 1\n")
    writeFileSync(b, "const b = 1\n")
    const { id } = await begin({ permissions: askFirst })
    const first = { file_path: a, old_string: "const a = 1", new_string: "const a = 2" }
    const answer = fake.canUse("Edit", first, "toolu_1")
    await until(() => sessions.permissions(id).length === 1)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
    expect(await answer).toMatchObject({ behavior: "allow" })
    const second = { file_path: b, old_string: "const b = 1", new_string: "const b = 2" }
    expect((await fake.hook("Edit", second, "toolu_2")).decision).toBeUndefined()
    expect(await fake.canUse("Edit", second, "toolu_2")).toMatchObject({ behavior: "allow" })
    const created = { file_path: join(root, "c.ts"), content: "export {}\n" }
    expect((await fake.hook("Write", created, "toolu_3")).decision).toBeUndefined()
    expect(await fake.canUse("Write", created, "toolu_3")).toMatchObject({ behavior: "allow" })
    expect(sessions.permissions(id)).toHaveLength(0)
  })

  test("Deny: an edit's card shows what it would change; Claude Code is told you declined, and the turn goes on", async () => {
    const file = join(root, "a.ts")
    writeFileSync(file, "const a = 1\n")
    const { id, first } = await begin({ permissions: askFirst })
    const edit = { file_path: file, old_string: "const a = 1", new_string: "const a = 2" }
    fake.streams([first], [{ type: "tool_use", id: "toolu_1", name: "Edit", input: edit }])
    const answer = fake.canUse("Edit", edit, "toolu_1")
    await until(() => sessions.permissions(id).length === 1)
    const [card] = sessions.permissions(id)
    expect(card).toMatchObject({ action: "edit", resources: [file], metadata: { files: [{ file, additions: 1, deletions: 1 }] } })
    sessions.replyPermission(id, card.id, "reject")
    expect(await answer).toEqual({ behavior: "deny", message: "The user declined this.", toolUseID: "toolu_1" })
    fake.toolResult("toolu_1", "The user declined this.", { error: true })
    fake.streams([first], [{ type: "text", text: "Leaving it as it is." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    expect(toolCalls(id)[0]).toMatchObject({ name: "edit", state: { status: "error" } })
    expect(texts(id)).toContain("Leaving it as it is.")
  })

  test("Approve All: what it asks about runs without a card, but reading a .env file still asks", async () => {
    const { id } = await begin()
    const edit = { file_path: join(root, "a.ts"), old_string: "1", new_string: "2" }
    expect((await fake.hook("Edit", edit, "toolu_1")).decision).toBeUndefined()
    expect(await fake.canUse("Edit", edit, "toolu_1")).toMatchObject({ behavior: "allow", updatedInput: edit })
    expect(await fake.canUse("Bash", { command: "rm -rf build" }, "toolu_2")).toMatchObject({ behavior: "allow" })
    expect(sessions.permissions(id)).toHaveLength(0)
    const secrets = join(root, ".env")
    expect((await fake.hook("Read", { file_path: secrets }, "toolu_3")).decision).toBe("ask")
    const answer = fake.canUse("Read", { file_path: secrets }, "toolu_3")
    await until(() => sessions.permissions(id).length === 1)
    expect(sessions.permissions(id)[0]).toMatchObject({ action: "read", resources: [secrets] })
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "once")
    expect(await answer).toMatchObject({ behavior: "allow" })
  })

  test("reading a file outside the project asks first, as the engine's agents do, but not Claude Code's own: its memory, a long output it saved, its background commands' output", async () => {
    const { id } = await begin()
    const keys = join(homedir(), ".ssh", "id_ed25519")
    expect((await fake.hook("Read", { file_path: keys }, "toolu_1")).decision).toBe("ask")
    const answer = fake.canUse("Read", { file_path: keys }, "toolu_1")
    await until(() => sessions.permissions(id).length === 1)
    expect(sessions.permissions(id)[0]).toMatchObject({ action: "external_directory", resources: [keys] })
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "reject")
    expect(await answer).toMatchObject({ behavior: "deny" })
    // Its own, where Claude Code keeps them: a long output it saved (a page of a PDF too), which
    // it's told to read, the project's memory it reads and writes, a background command's output.
    const settings = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    const saved = join(settings, "projects", "-tmp-project", "0b5e1f1c-0000-4000-8000-000000000000", "tool-results", "toolu_0.txt")
    const memory = join(settings, "projects", "-tmp-project", "memory", "MEMORY.md")
    const own = [
      ["Read", { file_path: saved }],
      ["Read", { file_path: join(dirname(saved), "pages", "1.png") }],
      ["Read", { file_path: memory }],
      ["Write", { file_path: join(dirname(memory), "testing.md"), content: "Run the tests with bun test." }],
      ["Read", { file_path: `/tmp/claude-${process.getuid!()}/-tmp-project/0b5e1f1c-0000-4000-8000-000000000000/tasks/b1.output` }],
    ] as const
    for (const [index, [tool, input]] of own.entries()) {
      expect((await fake.hook(tool, input, `toolu_own${index}`)).decision).toBeUndefined()
      expect(await fake.canUse(tool, input, `toolu_own${index}`)).toMatchObject({ behavior: "allow" })
    }
    // Only those: a path that climbs out of them, another program's files in /tmp, its settings.
    for (const [index, path] of [`${saved}/../../../../../.ssh/id_ed25519`, `/tmp/claude-${process.getuid!()}/notes.txt`, join(settings, "settings.json")].entries()) {
      expect((await fake.hook("Read", { file_path: path }, `toolu_out${index}`)).decision).toBe("ask")
    }
    expect(sessions.permissions(id)).toHaveLength(0)
  })

  test("its own files aren't outside the project, but your rules still hold for them: Ask First asks before it writes its memory", async () => {
    await begin({ permissions: askFirst })
    const memory = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", "-tmp-project", "memory", "MEMORY.md")
    expect((await fake.hook("Write", { file_path: memory, content: "-" }, "toolu_1")).decision).toBe("ask")
    expect((await fake.hook("Read", { file_path: memory }, "toolu_2")).decision).toBeUndefined()
  })

  test("your Blocks refuse a tool before it runs, under Approve All too: any command in a line counts, and Claude Code is told why", async () => {
    sessions = withBlocks([{ action: "shell", resource: "rm *", effect: "deny" }])
    const { id } = await begin()
    const refused = await fake.hook("Bash", { command: "npm test && rm -rf build" }, "toolu_1")
    expect(refused.decision).toBe("deny")
    expect(refused.reason).toContain("Settings › Permissions")
    expect((await fake.hook("Bash", { command: "npm test" }, "toolu_2")).decision).toBeUndefined()
    // Asked about by Claude Code all the same: refused, with no card.
    expect(await fake.canUse("Bash", { command: "rm -rf build" }, "toolu_3")).toMatchObject({ behavior: "deny" })
    expect(sessions.permissions(id)).toHaveLength(0)
  })

  test("plan mode is Claude Code's own: it writes its plan to its file even under Ask First, other edits are refused, and Build takes it out", async () => {
    const { id, first } = await begin({ permissions: askFirst, agent: "plan" })
    expect(fake.options.permissionMode).toBe("plan")
    const plan = { file_path: join(homedir(), ".claude", "plans", "a-plan.md"), content: "# The plan" }
    const written = await fake.hook("Write", plan, "toolu_1")
    expect(written.decision).toBeUndefined()
    const edit = { file_path: join(root, "a.ts"), old_string: "1", new_string: "2" }
    expect(await fake.canUse("Edit", edit, "toolu_2")).toMatchObject({ behavior: "deny" })
    // Done planning: told to wait for you, who builds it when you're ready.
    expect(await fake.canUse("ExitPlanMode", { plan: "# The plan" }, "toolu_3")).toMatchObject({ behavior: "deny", message: expect.stringContaining("wait") })
    expect(sessions.permissions(id)).toHaveLength(0)
    fake.say("Here's the plan.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    sessions.selectAgent(id, "build")
    sessions.prompt(id, { id: "msg_claude_build_01", text: "build it", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    expect(fake.modes).toEqual(["default"])
  })

  test("in Build, a plan mode it went into on its own it leaves when its plan is done, and carries on", async () => {
    const { id } = await begin()
    expect(fake.options.permissionMode).toBe("default")
    expect(await fake.canUse("ExitPlanMode", { plan: "# The plan" }, "toolu_1")).toMatchObject({ behavior: "allow", updatedInput: { plan: "# The plan" } })
    expect(sessions.permissions(id)).toHaveLength(0)
  })

  test("a question it asks is a form: your answers reach it, and dismissing one tells it so", async () => {
    const { id } = await begin()
    const questions = [{ question: "Which database?", header: "Database", options: [{ label: "Postgres" }, { label: "SQLite", description: "One file" }], multiSelect: false }]
    const asked = fake.canUse("AskUserQuestion", { questions }, "toolu_1")
    await until(() => sessions.forms(id).length === 1)
    const [form] = sessions.forms(id)
    expect(form.fields[0]).toMatchObject({ title: "Database", description: "Which database?", options: [{ value: "Postgres" }, { value: "SQLite", description: "One file" }] })
    sessions.replyForm(id, form.id, { q0: "SQLite" })
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { questions, answers: { "Which database?": "SQLite" } } })
    const again = fake.canUse("AskUserQuestion", { questions }, "toolu_2")
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, null)
    expect(await again).toMatchObject({ behavior: "deny" })
  })
})

describe("Claude Code's context and usage", () => {
  test("how full its context is, as its last request was: what the context ring counts", async () => {
    const { id, first } = await begin()
    fake.streams([first], [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: join(root, "a.ts") } }], { input: 3_000, read: 40_000, write: 1_000, output: 120 })
    fake.toolResult("toolu_1", "const a = 1")
    fake.streams([first], [{ type: "text", text: "It sets a to 1." }], { input: 200, read: 44_000, write: 300, output: 400 })
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(steps(id).at(-1)?.tokens).toEqual({ input: 200, output: 400, reasoning: 0, cache: { read: 44_000, write: 300 } })
  })

  test("a turn's usage: each request's tokens, and with an API key, what Claude Code says it cost since the turn before", async () => {
    claude.key = true
    const { id, first } = await begin()
    fake.streams([first], [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }], { input: 3_000, read: 40_000, write: 1_000, output: 120 })
    fake.toolResult("toolu_1", "a.ts")
    fake.streams([first], [{ type: "text", text: "One file." }], { input: 200, read: 44_000, write: 300, output: 400 })
    fake.result([first], "success", { total_cost_usd: 0.12 })
    await until(() => idles(id).length === 1)
    // What the reply's footer counts.
    expect(steps(id).reduce((sum, step) => sum + (step.tokens?.output ?? 0), 0)).toBe(520)
    expect(sessions.get(id).tokens).toEqual({ input: 3_200, output: 520, reasoning: 0, cache: { read: 84_000, write: 1_300 } })
    expect(sessions.get(id).cost).toBeCloseTo(0.12)
    sessions.prompt(id, { id: "msg_claude_cost_002", text: "and now?", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    const second = fake.sent[1].uuid
    fake.streams([second], [{ type: "text", text: "Still one." }], { input: 100, read: 45_000, write: 0, output: 50 })
    fake.result([second], "success", { total_cost_usd: 0.2 })
    await until(() => idles(id).length === 2)
    expect(sessions.get(id).cost).toBeCloseTo(0.2)
  })

  test("on a plan, a turn costs nothing here: the plan pays", async () => {
    const { id, first } = await begin()
    fake.streams([first], [{ type: "text", text: "Hi." }])
    fake.result([first], "success", { total_cost_usd: 0.12 })
    await until(() => idles(id).length === 1)
    expect(sessions.get(id).cost).toBe(0)
  })
})

describe("Claude Code's reply", () => {
  test("in steps: its words, a command that failed, the edit it made with what changed, the command passing, then its answer", async () => {
    const file = join(root, "a.ts")
    writeFileSync(file, "const a = 1\n")
    const { id, first } = await begin()
    fake.streams([first], [{ type: "text", text: "Running the tests." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }])
    fake.toolResult("toolu_1", "1 failed", { error: true })
    fake.streams([first], [{ type: "tool_use", id: "toolu_2", name: "Edit", input: { file_path: file, old_string: "const a = 1", new_string: "const a = 2" } }])
    fake.toolResult("toolu_2", "The file has been updated.", { structured: { filePath: file, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-const a = 1", "+const a = 2"] }] } })
    fake.streams([first], [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "npm test" } }])
    fake.toolResult("toolu_3", "3 passed", { structured: { stdout: "3 passed", stderr: "", interrupted: false } })
    fake.streams([first], [{ type: "text", text: "Fixed: a is 2 now." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    const [one, two, three, four] = steps(id)
    expect(one.content).toMatchObject([
      { type: "text", text: "Running the tests." },
      { type: "tool", name: "shell", state: { status: "error", input: { command: "npm test" }, error: { message: "1 failed" } } },
    ])
    expect(two.content).toMatchObject([{ type: "tool", name: "edit", state: { status: "completed", input: { path: file }, metadata: { files: [{ file, additions: 1, deletions: 1 }] } } }])
    expect(three.content).toMatchObject([{ type: "tool", name: "shell", state: { status: "completed", content: [{ type: "text", text: "3 passed" }] } }])
    expect(four.content).toEqual([{ type: "text", text: "Fixed: a is 2 now." }])
    expect(steps(id)).toHaveLength(4)
  })

  test("Stop mid-turn: it ends stopped, the command still running shows stopped, what it said stays, and the same Claude Code takes your next message", async () => {
    const { id, first } = await begin()
    fake.streams([first], [{ type: "text", text: "Building it." }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm run build" } }])
    await until(() => toolCalls(id)[0]?.state.status === "running")
    fake.onInterrupt = () => fake.result([first], "error_during_execution")
    await sessions.interrupt(id, false)
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("interrupted")
    expect(fake.interrupts).toBe(1)
    expect(toolCalls(id)[0].state).toMatchObject({ status: "error", error: { type: "aborted" } })
    expect(texts(id)).toContain("Building it.")
    expect(fake.closed).toBe(false)
    sessions.prompt(id, { id: "msg_claude_after_01", text: "try again", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
  })

  test("Stop while it asks: the card goes, Claude Code is told no, and the turn ends stopped", async () => {
    const { id, first } = await begin({ permissions: askFirst })
    fake.streams([first], [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "rm -rf build" } }])
    const answer = fake.canUse("Bash", { command: "rm -rf build" }, "toolu_1")
    await until(() => sessions.permissions(id).length === 1)
    fake.onInterrupt = () => fake.result([first], "error_during_execution")
    await sessions.interrupt(id, false)
    expect(await answer).toMatchObject({ behavior: "deny" })
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("interrupted")
    expect(sessions.permissions(id)).toHaveLength(0)
  })
})
