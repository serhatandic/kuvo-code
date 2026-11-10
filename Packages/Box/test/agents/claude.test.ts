// Claude Code's thread against a fake SDK: messages you send partway, taken late or never.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { handler } from "../../src/agents/server"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { Carrying } from "../../src/agents/carry"
import { subscribe } from "../../src/agents/events"
import { repositoryOf } from "../../src/agents/fence"
import { setToolServer } from "../../src/agents/kuvotools"
import { callServer, computerServers, KEYS } from "./support/servers"
import { subagentEngine } from "./support/subagents"
import { Auto } from "../../src/agents/auto"
import { agentAccounts, Limits } from "../../src/agents/limits"
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

describe("Claude Code ended between turns, with work in the background (#262)", () => {
  /** A session whose turn started `scripts/test.sh` in the background and ended, waiting for it. */
  async function waiting(id: string) {
    sessions.prompt(id, { id: "msg_claude_lost_001", text: "run the tests in the background", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tool1", name: "Bash", input: { command: "scripts/test.sh", run_in_background: true } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "t1", task_type: "local_bash", description: "Run the tests", tool_use_id: "tool1", is_backgrounded: true })
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_bash", description: "Run the tests" }] })
    fake.say("Waiting for the tests to report back.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    await until(() => (sessions.background()[id]?.commands.length ?? 0) === 1)
  }

  test("killed from outside: the session is woken, told the command stopped unfinished, rather than waiting for ever", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await waiting(id)
    // What it printed so far, as the bar read it.
    fake.outputs.set("t1", "PASS a.test\n")
    const [job] = shells(root).filter((job) => job.metadata.sessionID === id && job.status === "running")
    await shellOutput(job.id, 0, 24_000)
    const before = fake.sent.length
    // (The Claude Code that starts again for the note has a stream of its own.)
    const killed = fake.out
    fake.out = new Queue<any>()
    ;(fake as any).crashed = new Error("Claude Code process exited with code 143")
    killed.close()
    await until(() => fake.sent.length === before + 1)
    const told = fake.sent.at(-1).message.content.find((part: any) => part.type === "text")?.text ?? fake.sent.at(-1).message.content
    expect(String(told)).toContain("scripts/test.sh")
    expect(String(told)).toContain("stopped")
    expect(String(told)).toContain("PASS a.test")
    // It shows as the command stopping, and nothing runs for it any more.
    const notice = sessions.messages(id).find((message) => message.type === "synthetic") as any
    expect(notice.description).toBe("scripts/test.sh")
    expect(notice.metadata).toMatchObject({ source: "shell", state: "error", signal: "SIGTERM" })
    expect(shells(root).find((one) => one.id === job.id)?.status).toBe("exited")
    fake.say("The tests stopped; running them again.", [fake.sent.at(-1).uuid])
    fake.result([fake.sent.at(-1).uuid])
    await until(() => idles(id).length === 2)
  })

  test("killed while an undo is staged: the note waits for your next message, and the undo stays", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await waiting(id)
    await sessions.stageRevert(id, "msg_claude_lost_001")
    const killed = fake.out
    fake.out = new Queue<any>()
    ;(fake as any).crashed = new Error("Claude Code process exited with code 143")
    killed.close()
    await until(() => sessions.inbox(id).length === 1)
    await Bun.sleep(50)
    expect(sessions.inbox(id)[0]).toMatchObject({ type: "synthetic", delivery: "queue" })
    expect(fake.sent).toHaveLength(1)
    expect(sessions.get(id).revert?.messageID).toBe("msg_claude_lost_001")
    // Redo: it goes now, as it would have.
    await sessions.clearRevert(id)
    await until(() => fake.sent.length === 2)
    expect(String(fake.sent[1].message.content.find?.((part: any) => part.type === "text")?.text ?? fake.sent[1].message.content)).toContain("scripts/test.sh")
  })

  test("an undo made final while a command still runs: its Claude Code starts over, and the session is told once, after your message", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await waiting(id)
    await sessions.stageRevert(id, "msg_claude_lost_001")
    fake.out = new Queue<any>()
    sessions.prompt(id, { id: "msg_claude_lost_003", text: "start over", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    const text = (message: any) => String(message.message.content.find?.((part: any) => part.type === "text")?.text ?? message.message.content)
    expect(text(fake.sent[1])).toContain("start over")
    fake.say("ok", [fake.sent[1].uuid])
    fake.result([fake.sent[1].uuid])
    await until(() => fake.sent.length === 3)
    expect(text(fake.sent[2])).toContain("scripts/test.sh")
    fake.say("noted", [fake.sent[2].uuid])
    fake.result([fake.sent[2].uuid])
    // (The undo took the first turn away: these are the two since.)
    await until(() => idles(id).length === 2)
    expect(fake.sent).toHaveLength(3)
    expect(sessions.inbox(id)).toHaveLength(0)
  })

  test("started again for a command (/review): the session hears it as a note", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await waiting(id)
    claude.programUpdated()
    fake.out = new Queue<any>()
    sessions.prompt(id, { id: "msg_claude_lost_004", text: "/review", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    expect(String(fake.sent[1].message.content.find?.((part: any) => part.type === "text")?.text ?? fake.sent[1].message.content)).toBe("/review")
    await until(() => sessions.inbox(id).length + sessions.messages(id).filter((message) => message.type === "synthetic").length === 1)
    const note = [...sessions.inbox(id).map((item: any) => item.payload.text), ...sessions.messages(id).flatMap((message: any) => (message.type === "synthetic" ? [message.text] : []))][0]
    expect(note).toContain("scripts/test.sh")
  })

  test("closed by the box itself (its account removed): no note, nothing more starts", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await waiting(id)
    sessions.forgetProvider(provider)
    await until(() => fake.closed)
    await Bun.sleep(50)
    expect(sessions.messages(id).some((message) => message.type === "synthetic")).toBe(false)
    expect(fake.sent).toHaveLength(1)
  })

  test("started again for your next message (Claude Code was updated): that message says what stopped with it", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await waiting(id)
    claude.programUpdated()
    fake.out = new Queue<any>()
    sessions.prompt(id, { id: "msg_claude_lost_002", text: "how are the tests doing?", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    const told = String(fake.sent[1].message.content.find?.((part: any) => part.type === "text")?.text ?? fake.sent[1].message.content)
    expect(told).toContain("Claude Code started again before this message")
    expect(told).toContain("scripts/test.sh")
    expect(told).toContain("how are the tests doing?")
    // Not a turn of its own besides.
    expect(sessions.messages(id).some((message) => message.type === "synthetic")).toBe(false)
  })

  test("the bridge stops meanwhile: once it's back, the session is woken with what stopped", async () => {
    const store = join(root, "sessions")
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await waiting(id)
    sessions.closeAll()
    // A bridge started again, on the same sessions.
    fake = new FakeClaude()
    claude = new TestClaude(fake, root)
    sessions = new Sessions(new Store(store), { find: (provider: string | undefined) => (provider === claude.providerID ? claude : undefined) } as unknown as Roster, new Auto(root), undefined, async () => [])
    expect(fake.sent).toHaveLength(0)
    sessions.wakeLost()
    await until(() => fake.sent.length === 1)
    const told = String(fake.sent[0].message.content.find?.((part: any) => part.type === "text")?.text ?? fake.sent[0].message.content)
    expect(told).toContain("Kuvo Code stopped")
    expect(told).toContain("scripts/test.sh")
  })

  test("the bridge back only after a while (Kuvo Code quit for the night): nothing starts, and the note waits for your next message", async () => {
    const store = join(root, "sessions")
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await waiting(id)
    sessions.closeAll()
    fake = new FakeClaude()
    claude = new TestClaude(fake, root)
    sessions = new Sessions(new Store(store), { find: (provider: string | undefined) => (provider === claude.providerID ? claude : undefined) } as unknown as Roster, new Auto(root), undefined, async () => [])
    sessions.wakeLost(Date.now() + 11 * 60_000)
    await Bun.sleep(50)
    expect(fake.sent).toHaveLength(0)
    // It goes with your next message instead.
    expect(sessions.inbox(id)).toMatchObject([{ type: "synthetic", delivery: "queue" }])
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

  /** A turn that sends a subagent (call1, Claude Code's ag1) off as Claude Code does by default: `run_in_background` left out. */
  async function sendOffByDefault(id: string, said: boolean) {
    sessions.prompt(id, { id: "msg_claude_sub_0101", text: "have a reviewer look", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "call1", name: "Agent", input: { description: "Review it", prompt: "Review it", subagent_type: "reviewer" } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "ag1", task_type: "local_agent", description: "Review it", tool_use_id: "call1", is_backgrounded: true })
    fake.out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call1", content: "Async agent launched successfully." }] }, parent_tool_use_id: null })
    if (said) fake.out.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Reading the diff." }] }, parent_tool_use_id: "call1" })
    fake.say("A reviewer is on it.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    const child = sessions.list(root, id)[0]?.id
    expect(child).toBeTruthy()
    return child
  }

  test("one sent off without saying (Claude Code's default is the background) works on after the turn, under your rules", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    const child = await sendOffByDefault(id, true)
    expect(sessions.active()).toContain(child)
    // Its tools after the turn: what you allow runs, what asks is asked in the conversation, and
    // what you refused stays refused.
    expect((await fake.canUse("Read", { file_path: join(root, "a.ts") }, "t1", { agentID: "ag1" })).behavior).toBe("allow")
    sessions.update(id, { permissions: [{ action: "shell", resource: "*", effect: "ask" }, { action: "shell", resource: "rm *", effect: "deny" }] })
    const asked = fake.canUse("Bash", { command: "git diff" }, "t2", { agentID: "ag1" })
    await until(() => sessions.permissions(id).length === 1)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "once")
    expect((await asked).behavior).toBe("allow")
    expect(await fake.hook("Bash", { command: "rm -rf build" }, "t3")).toMatchObject({ decision: "deny" })
    expect((await fake.canUse("Bash", { command: "rm -rf build" }, "t3", { agentID: "ag1" })).behavior).toBe("deny")
    fake.out.push({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Looks right." }] }, parent_tool_use_id: "call1" })
    await until(() => texts(child).includes("Looks right."))
    fake.out.push({ type: "system", subtype: "task_notification", task_id: "ag1", status: "completed", tool_use_id: "call1", output_file: "", summary: "done" })
    await until(() => !sessions.active().includes(child))
    // Done: a call that still comes from it is a stray, and refused.
    expect((await fake.canUse("Bash", { command: "git status" }, "t4", { agentID: "ag1" })).behavior).toBe("deny")
  })

  test("one whose first words come after the turn ended is still its own session's, and still asks", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    const child = await sendOffByDefault(id, false)
    expect(sessions.active()).toContain(child)
    expect((await fake.canUse("Read", { file_path: join(root, "a.ts") }, "t1", { agentID: "ag1" })).behavior).toBe("allow")
    fake.out.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Reading the diff." }] }, parent_tool_use_id: "call1" })
    await until(() => texts(child).includes("Reading the diff."))
  })

  test("one sent to work in the foreground and moved to the background on the way goes on after the turn", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_sub_0102", text: "have a reviewer look", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "call1", name: "Agent", input: { description: "Review it", prompt: "Review it", subagent_type: "reviewer", run_in_background: false } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "ag1", task_type: "local_agent", description: "Review it", tool_use_id: "call1", is_backgrounded: false })
    fake.out.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Reading the diff." }] }, parent_tool_use_id: "call1" })
    fake.out.push({ type: "system", subtype: "task_updated", task_id: "ag1", patch: { is_backgrounded: true } })
    fake.out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call1", content: "The agent was moved to the background." }] }, parent_tool_use_id: null })
    fake.say("It's in the background now.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    const child = sessions.list(root, id)[0].id
    expect(sessions.active()).toContain(child)
    expect((await fake.canUse("Read", { file_path: join(root, "a.ts") }, "t1", { agentID: "ag1" })).behavior).toBe("allow")
  })

  test("one sent off in an earlier turn goes on when you stop a later one it spoke in, and is listed once meanwhile", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    const child = await sendOffByDefault(id, true)
    fake.out.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "ag1", task_type: "local_agent", description: "Review it" }] })
    sessions.prompt(id, { id: "msg_claude_sub_0104", text: "meanwhile, something else", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    const second = fake.sent[1].uuid
    fake.out.push({ type: "assistant", message: { id: "m4", content: [{ type: "text", text: "Still reading." }] }, parent_tool_use_id: "call1" })
    await until(() => texts(child).includes("Still reading."))
    // The reviewer is one subagent, not a task besides.
    expect(sessions.background()[id]).toMatchObject({ subagents: [{ id: child }], tasks: [] })
    fake.onInterrupt = () => fake.result([second], "error_during_execution")
    await sessions.interrupt(id, false)
    await until(() => idles(id).length === 2)
    expect(sessions.active()).toContain(child)
    expect((await fake.canUse("Read", { file_path: join(root, "a.ts") }, "t1", { agentID: "ag1" })).behavior).toBe("allow")
    fake.out.push({ type: "assistant", message: { id: "m5", content: [{ type: "text", text: "Done reading." }] }, parent_tool_use_id: "call1" })
    await until(() => texts(child).includes("Done reading."))
    fake.out.push({ type: "system", subtype: "task_notification", task_id: "ag1", status: "completed", tool_use_id: "call1", output_file: "", summary: "done" })
    await until(() => !sessions.active().includes(child))
    expect(idles(child).at(-1)?.outcome).toBe("succeeded")
  })

  test("a Claude Code that says only in the launch's result that it went to the background: it goes on after the turn", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_sub_0105", text: "have a reviewer look", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.out.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "call1", name: "Agent", input: { description: "Review it", prompt: "Review it", subagent_type: "reviewer" } }] }, parent_tool_use_id: null, user_message_uuids: [first] })
    fake.out.push({ type: "system", subtype: "task_started", task_id: "ag1", task_type: "local_agent", description: "Review it", tool_use_id: "call1" })
    fake.out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call1", content: "Async agent launched successfully." }] }, parent_tool_use_id: null, tool_use_result: { status: "async_launched", agentId: "ag1", description: "Review it", prompt: "Review it" } })
    fake.say("A reviewer is on it.", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    const child = sessions.list(root, id)[0].id
    expect(sessions.active()).toContain(child)
    expect((await fake.canUse("Read", { file_path: join(root, "a.ts") }, "t1", { agentID: "ag1" })).behavior).toBe("allow")
  })

  test("a call from a subagent the box doesn't know, with no turn under way, is refused", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_sub_0103", text: "hello", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    const [first] = fake.sent.map((message) => message.uuid)
    fake.say("hi", [first])
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect((await fake.canUse("Bash", { command: "git status" }, "t1", { agentID: "nobody" })).behavior).toBe("deny")
    expect((await fake.canUse("Bash", { command: "git status" }, "t2")).behavior).toBe("deny")
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
    expect(notices(id)).toEqual(["Claude's API is overloaded: trying again (2/10).", "Something new to read."])
    expect(sessions.messages(id).filter((message) => message.type === "compaction")).toMatchObject([{ status: "completed", reason: "auto" }])
  })

  test("several hooks failing the same way at the same moment show as one row, and the same failure again later as another", async () => {
    const failed = { type: "system", subtype: "hook_response", hook_name: "SessionStart:compact", hook_event: "SessionStart", outcome: "error", stderr: "Failed to run" }
    const id = await turn(() => [failed, failed, failed, failed, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }, failed])
    const row = "Your SessionStart:compact hook failed: Failed to run."
    expect(notices(id)).toEqual([row, row])
    expect(sessions.messages(id).map((message) => message.type)).toEqual(["user", "synthetic", "compaction", "synthetic", "idle"])
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
    const want = { opus: 1_000_000, "claude-haiku-4-5": 200_000, "opus[1m]": 1_000_000 }
    expect(await windows(new TestClaude(fake, root), want)).toEqual(want)
    expect(fake.asked).toEqual(["default", "claude-haiku-4-5", "opus[1m]"])
  })

  /** The models as listed once Claude Code has said which it has. */
  async function offered(claude: ClaudeAgent) {
    let models = await claude.models()
    for (const start = Date.now(); Date.now() - start < 3_000 && !models.some((model) => model.id === "claude-haiku-4-5"); await Bun.sleep(20)) models = await claude.models()
    return models
  }

  test("its default isn't offered: the model it stands for is, known by that name too", async () => {
    fake.models = listed
    const models = await offered(new TestClaude(fake, root))
    expect(models.map((model) => model.id)).toEqual(["opus", "claude-haiku-4-5", "opus[1m]"])
    expect(Object.fromEntries(models.map((model) => [model.id, model.aliases ?? []]))).toEqual({ opus: ["default"], "claude-haiku-4-5": [], "opus[1m]": [] })
  })

  test("what its default stands for is whatever this account's Claude Code says, never assumed", async () => {
    fake.models = [
      { value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default (recommended)", description: "Sonnet 5.5 · Everyday" },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Best for complex tasks" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Everyday" },
      { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Haiku 4.5 · Fast" },
    ]
    const models = await offered(new TestClaude(fake, root))
    expect(Object.fromEntries(models.map((model) => [model.id, model.aliases ?? []]))).toEqual({ opus: [], sonnet: ["default"], "claude-haiku-4-5": [] })
    // Where its default was listed, a new session starts on: so Sonnet stays first.
    expect([...models].sort((x, y) => y.time.released - x.time.released)[0].id).toBe("sonnet")
  })

  test("a default nothing else lists is that model, under its own id", async () => {
    fake.models = [
      { value: "default", resolvedModel: "claude-fable-5-1", displayName: "Default (recommended)", description: "Fable 5.1 · Newest" },
      { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Haiku 4.5 · Fast" },
    ]
    const models = await offered(new TestClaude(fake, root))
    expect(models.map((model) => [model.id, model.name, model.aliases ?? []])).toEqual([["claude-fable-5-1", "Fable 5.1", ["default"]], ["claude-haiku-4-5", "Haiku 4.5", []]])
  })

  test("a default described without a model's name is named by the model it resolves to, never \"Default\"", async () => {
    fake.models = [
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Use the default model (currently Opus)" },
      { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Haiku 4.5 · Fast" },
    ]
    const models = await offered(new TestClaude(fake, root))
    expect(models.map((model) => [model.id, model.name])).toEqual([["claude-opus-5-5", "Opus 5.5"], ["claude-haiku-4-5", "Haiku 4.5"]])
  })

  test("before Claude Code has listed its models, the usual ones still answer to its default", async () => {
    const claude = new TestClaude(fake, root)
    const models = await claude.models()
    expect(models.filter((model) => model.aliases?.includes("default")).map((model) => model.id)).toEqual(["opus"])
    expect(models.some((model) => model.id === "default" || /default/i.test(model.name))).toBe(false)
  })

  test("a session already on its default goes on: Claude Code's own default is what it runs", async () => {
    fake.models = listed
    const { id, first } = await begin()
    expect(fake.options.model).toBeUndefined()
    expect(sessions.get(id).model).toMatchObject({ providerID: provider, id: "default" })
    fake.result([first])
  })

  test("an older Claude Code that doesn't say: as its list says", async () => {
    fake.models = listed
    const want = { opus: 200_000, "claude-haiku-4-5": 200_000, "opus[1m]": 1_000_000 }
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

describe("a bot's Claude Code on the computer it moved to", () => {
  const bot = (name: string, memory: boolean) => {
    const folder = join(root, "bots", name)
    mkdirSync(join(folder, "workspace"), { recursive: true })
    if (memory) mkdirSync(join(folder, "memory"))
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: join(folder, "workspace") }, metadata: { kuvo: { bot: name } } }).id
    return { folder, id }
  }
  const start = async (id: string) => {
    const sent = fake.sent.length
    sessions.prompt(id, { id: "msg_claude_turn_0001", text: "go", files: [], delivery: "steer" })
    await until(() => fake.sent.length === sent + 1)
  }

  test("it goes on with the same conversation, and its memory is the one in its folder", async () => {
    const { folder, id } = bot("bot_ship", true)
    // As it came: Claude Code had started on that conversation on the other computer.
    sessions.slotsOf(id)[provider] = { state: { claudeSession: "0b5e1f1c-0000-4000-8000-000000000000", claudeStarted: true } }
    await start(id)
    expect(fake.options.resume).toBe("0b5e1f1c-0000-4000-8000-000000000000")
    expect(fake.options.settings).toEqual({ autoMemoryDirectory: join(folder, "memory") })
    // It's its own to read and write, without asking; another bot's isn't.
    const own = { file_path: join(folder, "memory", "deploys.md"), content: "On Fridays." }
    expect((await fake.hook("Write", own, "toolu_1")).decision).toBeUndefined()
    const other = { file_path: join(homedir(), "bots", "bot_scout", "memory", "deploys.md") }
    expect((await fake.hook("Read", other, "toolu_2")).decision).toBe("ask")
  })

  test("one with no memory in its folder keeps Claude Code's own place for it", async () => {
    const { id } = bot("bot_old", false)
    await start(id)
    expect(fake.options.settings).toBeUndefined()
  })
})

describe("a conversation on Claude Code's default, moved to a computer where that's another model", () => {
  // Claude Code's `default` stands for whichever model it recommends on that computer's account:
  // Opus 5.5 on one, Sonnet 5.5 on the other (as on the user's MacBook and Mac mini, 2026-11-08).
  const listing = (stands: "opus" | "sonnet") => [
    { value: "default", resolvedModel: `claude-${stands}-5-5`, displayName: "Default (recommended)", description: `${stands === "opus" ? "Opus" : "Sonnet"} 5.5 · Recommended` },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Opus 5.5 · Most capable" },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Sonnet 5.5 · Everyday" },
  ]
  /** A computer's agents bridge as far as a move goes: its sessions, its Claude Code, and what carries them. */
  const computer = (name: string, models: unknown[]) => {
    const home = mkdtempSync(join(base, `${name}-`))
    const claudeHere = new TestClaude(new FakeClaude(), home)
    claudeHere.fake.models = models
    const store = new Store(join(home, "sessions"))
    const roster = { find: (id: string | undefined) => (id === claudeHere.providerID ? claudeHere : undefined) } as unknown as Roster
    const its = new Sessions(store, roster, new Auto(home), undefined, async () => [])
    return { home, claude: claudeHere, sessions: its, carrying: new Carrying(its, store, (id) => its.agent(id), () => [claudeHere]) }
  }
  /** What a picker there calls a session's model: as that computer's Claude Code lists it. */
  const named = async (where: ReturnType<typeof computer>, id: string) => {
    // (Once it has said which it has: its usual ones meanwhile.)
    await where.claude.concreteModel("default")
    return (await where.claude.models()).find((model) => model.id === id || model.aliases?.includes(id))?.name
  }
  const move = async (from: ReturnType<typeof computer>, to: ReturnType<typeof computer>, id: string) => {
    const bundle = join(from.home, "bundle")
    await from.carrying.pack(id, bundle)
    const work = join(to.home, "work")
    mkdirSync(work, { recursive: true })
    return await to.carrying.place(bundle, join(to.home, "kept"), work, id)
  }

  test("it goes on there on the model it ran on here, and shows that model's name there too", async () => {
    const macBook = computer("macbook", listing("opus")), mini = computer("mini", listing("sonnet"))
    try {
      const id = macBook.sessions.create({ model: { providerID: provider, id: "default", variant: "high" }, location: { directory: macBook.home } }).id
      expect(await named(macBook, "default")).toBe("Opus 5.5")
      const placed = await move(macBook, mini, id)
      expect(mini.sessions.get(id).model).toEqual({ providerID: provider, id: "opus", variant: "high" })
      expect(await named(mini, mini.sessions.get(id).model!.id)).toBe("Opus 5.5")
      // What it came as, for the link to make the bot's own model the same.
      expect(placed.came).toEqual({ providerID: provider, id: "default", variant: "high" })
      // (Its original is as it was: a move taken back leaves it on the default you chose.)
      expect(macBook.sessions.get(id).model?.id).toBe("default")
    } finally {
      macBook.sessions.closeAll()
      mini.sessions.closeAll()
    }
  })

  test("one on a model of its own goes on it; where Claude Code hasn't said what its default is, or the account there doesn't have it, it stays on the default", async () => {
    const macBook = computer("macbook", listing("opus")), mini = computer("mini", listing("sonnet"))
    const quiet = computer("quiet", [])
    try {
      const own = macBook.sessions.create({ model: { providerID: provider, id: "sonnet" }, location: { directory: macBook.home } }).id
      await move(macBook, mini, own)
      expect(mini.sessions.get(own).model).toEqual({ providerID: provider, id: "sonnet" })
      const unsaid = quiet.sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: quiet.home } }).id
      await move(quiet, mini, unsaid)
      expect(mini.sessions.get(unsaid).model).toEqual({ providerID: provider, id: "default" })
      // To an account there that doesn't have that model: on its default there, which it can run.
      const noOpus = computer("no-opus", listing("sonnet").filter((each) => each.value !== "opus"))
      try {
        const other = macBook.sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: macBook.home } }).id
        await noOpus.claude.concreteModel("default")
        await move(macBook, noOpus, other)
        expect(noOpus.sessions.get(other).model).toEqual({ providerID: provider, id: "default" })
      } finally {
        noOpus.sessions.closeAll()
      }
    } finally {
      for (const each of [macBook, mini, quiet]) each.sessions.closeAll()
    }
  })
})

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
    expect(form.metadata).toMatchObject({ kind: "question", tool: { id: "toolu_1" } })
    sessions.replyForm(id, form.id, { q0: "SQLite" })
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { questions, answers: { "Which database?": "SQLite" } } })
    const again = fake.canUse("AskUserQuestion", { questions }, "toolu_2")
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, null)
    expect(await again).toMatchObject({ behavior: "deny" })
    // Turned down by its box, with words: those are what it hears, not that you dismissed it.
    const left = fake.canUse("AskUserQuestion", { questions }, "toolu_3")
    await until(() => sessions.forms(id).length === 1)
    // (As the box does: the bridge's own route.)
    const answer = handler({ sessions, password: "pw" } as any)
    const route = `http://box/api/session/${id}/form/${sessions.forms(id)[0].id}?message=${encodeURIComponent("This is on Autopilot: leave it.")}`
    expect((await answer(new Request(route, { method: "DELETE", headers: { authorization: "Basic " + btoa("opencode:pw") } }))).status).toBe(200)
    expect(await left).toMatchObject({ behavior: "deny", message: "This is on Autopilot: leave it." })
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

describe("summarizing when you ask (/compact)", () => {
  // What Claude Code 2.1.318 sends for it, in order.
  const compacts = (fake: FakeClaude, more: Record<string, unknown> = {}) => {
    fake.out.push({ type: "system", subtype: "status", status: "compacting" })
    fake.out.push({ type: "system", subtype: "hook_started", hook_name: "SessionStart:compact", hook_event: "SessionStart", hook_id: "h1" })
    fake.out.push({ type: "system", subtype: "hook_response", hook_name: "SessionStart:compact", hook_event: "SessionStart", hook_id: "h1", outcome: "success", exit_code: 0 })
    fake.out.push({ type: "system", subtype: "status", status: null, compact_result: "success", ...more })
    fake.out.push({ type: "system", subtype: "init", session_id: "claude-1" })
    fake.out.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 32985, post_tokens: 10541 } })
    fake.out.push({ type: "user", isSynthetic: true, message: { role: "user", content: "This session is being continued from a previous conversation." } })
    fake.out.push({ type: "user", isReplay: true, message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } })
    fake.out.push({ type: "command_lifecycle", command: "compact" })
    fake.out.push({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 0 })
  }
  const words = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "synthetic" ? [message.text] : []))

  async function afterATurn() {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_compact1", text: "remember the word", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    fake.streams([fake.sent[0].uuid], [{ type: "text", text: "HARBOUR" }])
    fake.result([fake.sent[0].uuid])
    await until(() => idles(id).length === 1)
    return id
  }

  test("it's typed as you would, and ends on its first result: the row shows it, the conversation stays as it was", async () => {
    const id = await afterATurn()
    expect(sessions.compact(id).state).toBe("compacting")
    await until(() => fake.sent.length === 2)
    expect(fake.sent[1].message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("")).toBe("/compact")
    compacts(fake)
    await until(() => idles(id).length === 2)
    expect(idles(id)[1].outcome).toBe("succeeded")
    expect(sessions.messages(id).find((message) => message.type === "compaction")).toMatchObject({ status: "completed", reason: "manual" })
    expect(words(id)).toEqual([])
    expect(texts(id)).toEqual(["HARBOUR"])
    expect(sessions.messages(id).filter((message) => message.type === "user").map((message: any) => message.text)).toEqual(["remember the word"])
  })

  test("one that fails shows why, though its result says it went through", async () => {
    const id = await afterATurn()
    sessions.compact(id)
    await until(() => fake.sent.length === 2)
    fake.out.push({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Not enough messages to compact." })
    fake.out.push({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 0 })
    await until(() => idles(id).length === 2)
    expect(sessions.messages(id).find((message) => message.type === "compaction")).toMatchObject({ status: "failed" })
    expect(idles(id)[1].error?.message).toBe("Claude Code couldn't summarize the conversation: Not enough messages to compact.")
  })

  test("Stop during it: Claude Code is told to stop, and the row says it didn't", async () => {
    const id = await afterATurn()
    sessions.compact(id)
    await until(() => fake.sent.length === 2)
    fake.onInterrupt = () => fake.result([fake.sent[1].uuid], "error_during_execution")
    await sessions.interrupt(id, false)
    await until(() => idles(id).length === 2)
    expect(fake.interrupts).toBe(1)
    expect(idles(id)[1].outcome).toBe("interrupted")
    expect(sessions.messages(id).find((message) => message.type === "compaction")).toMatchObject({ status: "failed" })
    expect(texts(id)).toEqual(["HARBOUR"])
  })

  test("a hook that fails as it compacts still says so", async () => {
    const id = await afterATurn()
    sessions.compact(id)
    await until(() => fake.sent.length === 2)
    fake.out.push({ type: "system", subtype: "hook_response", hook_name: "SessionStart:compact", hook_event: "SessionStart", outcome: "error", stderr: "Failed to run" })
    compacts(fake)
    await until(() => idles(id).length === 2)
    expect(words(id)).toEqual(["Your SessionStart:compact hook failed: Failed to run."])
  })

  test("shows as one row, not a second one for what Claude Code says as it summarizes", async () => {
    const id = await afterATurn()
    sessions.compact(id)
    await until(() => fake.sent.length === 2)
    compacts(fake)
    await until(() => idles(id).length === 2)
    expect(sessions.messages(id).filter((message) => message.type === "compaction")).toMatchObject([{ status: "completed", reason: "manual" }])
  })
})

describe("summarizing on its own, as the conversation fills up", () => {
  // What Claude Code 2.1.319 sends as it summarizes by itself partway through a turn: `status:
  // "compacting"` (again every 30 seconds while it waits), then `status: null` with how it went,
  // then the boundary. One with no result (it stopped, or found nothing to summarize) ends with a
  // bare `status: null`.
  const compacting = { type: "system", subtype: "status", status: "compacting" }
  const over = (result?: "success" | "failed", more: Record<string, unknown> = {}) => ({ type: "system", subtype: "status", status: null, ...(result ? { compact_result: result } : {}), ...more })
  const boundary = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 180000, post_tokens: 12000 } }
  const summaries = (id: string) => sessions.messages(id).filter((message) => message.type === "compaction") as Extract<Message, { type: "compaction" }>[]
  const notices = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "synthetic" ? [message.text] : []))
  let told: { type: string; data: any }[] = []
  let unsubscribe = () => {}
  beforeEach(() => {
    told = []
    unsubscribe = subscribe((event) => {
      if (event.type.startsWith("session.compaction.")) told.push({ type: event.type, data: event.data })
    })
  })
  afterEach(() => unsubscribe())

  /** A turn at work (a command run), then Claude Code summarizing: the session's id and Claude Code's for the message. */
  async function summarizing() {
    const { id, first } = await begin()
    fake.streams([first], [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }])
    fake.toolResult("toolu_1", "a.ts")
    fake.out.push(compacting)
    await until(() => summaries(id).length === 1)
    return { id, first }
  }

  test("while it runs the conversation says so, last, as it happens; it ends as one finished row, the turn going on after it", async () => {
    const { id, first } = await summarizing()
    expect(summaries(id)).toMatchObject([{ status: "running", reason: "auto" }])
    // Last in the conversation, so the line under it says it too.
    expect(sessions.messages(id).at(-1)).toMatchObject({ type: "compaction", status: "running" })
    expect(told).toMatchObject([{ type: "session.compaction.started", data: { reason: "auto" } }])
    // Said again as it waits: still the one.
    fake.out.push(compacting)
    fake.out.push(over("success"))
    fake.out.push({ type: "system", subtype: "init", session_id: "claude-1" })
    fake.out.push(boundary)
    fake.streams([first], [{ type: "text", text: "Listed." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    expect(summaries(id)).toMatchObject([{ status: "completed", reason: "auto", time: { completed: expect.any(Number) } }])
    expect(told.map((event) => event.type)).toEqual(["session.compaction.started", "session.compaction.ended"])
    expect(notices(id)).toEqual([])
    expect(sessions.messages(id).map((message) => message.type)).toEqual(["user", "assistant", "compaction", "assistant", "idle"])
    expect(texts(id)).toEqual(["Listed."])
  })

  test("one that fails says so on its row, once, and the turn goes on", async () => {
    const { id, first } = await summarizing()
    fake.out.push(over("failed", { compact_error: "Conversation too long." }))
    fake.out.push({ type: "system", subtype: "notification", key: "error-compacting-conversation", text: "Error compacting conversation", priority: "immediate" })
    fake.streams([first], [{ type: "text", text: "Carrying on." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    expect(summaries(id)).toMatchObject([{ status: "failed", reason: "auto" }])
    expect(told.map((event) => event.type)).toEqual(["session.compaction.started", "session.compaction.failed"])
    expect(notices(id)).toEqual(["Error compacting conversation"])
  })

  test("one that ends with nothing summarized doesn't stay under way while the turn goes on", async () => {
    const { id, first } = await summarizing()
    fake.out.push(over())
    fake.streams([first], [{ type: "text", text: "Carrying on." }])
    await until(() => texts(id).length === 1)
    expect(summaries(id)).toMatchObject([{ status: "failed" }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(summaries(id)).toHaveLength(1)
  })

  test("one it lets go of and begins again at once (or a permission mode set meanwhile) is still the one row", async () => {
    const { id, first } = await summarizing()
    fake.out.push(over())
    fake.out.push({ type: "system", subtype: "status", status: null, permissionMode: "default" })
    fake.out.push(compacting)
    fake.out.push(over("success"))
    fake.out.push(boundary)
    fake.streams([first], [{ type: "text", text: "Listed." }])
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(summaries(id)).toMatchObject([{ status: "completed", reason: "auto" }])
    expect(told.map((event) => event.type)).toEqual(["session.compaction.started", "session.compaction.ended"])
  })

  test("Stop during it: the turn ends stopped and the row isn't left under way", async () => {
    const { id, first } = await summarizing()
    fake.onInterrupt = () => fake.result([first], "error_during_execution")
    await sessions.interrupt(id, false)
    await until(() => idles(id).length === 1)
    expect(idles(id)[0].outcome).toBe("interrupted")
    expect(summaries(id)).toMatchObject([{ status: "failed" }])
    expect(told.map((event) => event.type)).toEqual(["session.compaction.started", "session.compaction.failed"])
  })

  test("Claude Code quitting during it: the row isn't left under way", async () => {
    const { id } = await summarizing()
    fake.crash(new Error("Claude Code exited with code 1"))
    await until(() => idles(id).length === 1)
    expect(summaries(id)).toMatchObject([{ status: "failed" }])
  })

  test("a message you send meanwhile goes to Claude Code, and the row stays the one until it's done", async () => {
    const { id, first } = await summarizing()
    sessions.prompt(id, { id: "msg_claude_meanwhile", text: "and the tests too", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    expect(summaries(id)).toMatchObject([{ status: "running" }])
    // After the row, which still says it's summarizing.
    expect(sessions.messages(id).map((message) => message.type)).toEqual(["user", "assistant", "compaction", "user"])
    fake.out.push(over("success"))
    fake.out.push(boundary)
    fake.result([first, fake.sent[1].uuid])
    await until(() => idles(id).length === 1)
    expect(summaries(id)).toMatchObject([{ status: "completed" }])
  })

  test("told only once it's done (no word as it began): one finished row, not a note", async () => {
    const { id, first } = await begin()
    fake.out.push(boundary)
    fake.result([first])
    await until(() => idles(id).length === 1)
    expect(summaries(id)).toMatchObject([{ status: "completed", reason: "auto" }])
    expect(notices(id)).toEqual([])
  })
})

describe("Claude Code, instructions that changed as its conversation goes on", () => {
  /** What the message it was sent last says. */
  const lastSent = () => fake.sent.at(-1).message.content.findLast((part: any) => part.type === "text").text as string

  /** A message, answered: its turn over. */
  async function answered(id: string, text: string, turns: number) {
    sessions.prompt(id, { id: `msg_claude_told_${text}`, text, files: [], delivery: "steer" })
    await until(() => fake.sent.length === turns)
    fake.out.push({ type: "system", subtype: "init", session_id: fake.options.resume ?? fake.options.sessionId })
    fake.result([fake.sent.at(-1).uuid])
    await until(() => idles(id).length === turns)
  }

  test("moved to another folder, the conversation it goes on with is told what changed, once; unchanged, nothing extra", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.setInstruction(id, "kuvo.worktree", "You work in the worktree at /old/place/tree.")
    await answered(id, "first", 1)
    // A new conversation has them as its instructions: no note.
    expect(fake.options.systemPrompt.append).toContain("/old/place/tree")
    expect(lastSent()).toBe("first")
    // It moved (another computer, another folder), and the bridge started again there.
    sessions.closeAll()
    sessions.setInstruction(id, "kuvo.worktree", "You work in the worktree at /new/place/tree.")
    sessions.setInstruction(id, "kuvo.moved", "You moved to this computer from the Old Mac.")
    fake = new FakeClaude()
    claude = new TestClaude(fake, root)
    sessions = withBlocks([])
    await answered(id, "second", 1)
    // The same conversation, which keeps the instructions it started with: what changed goes with the message.
    expect(fake.options.resume).toBeTruthy()
    const told = lastSent()
    expect(told).toContain("/new/place/tree")
    expect(told).toContain("You moved to this computer from the Old Mac.")
    expect(told).toMatch(/Replaced or taken out:\s+You work in the worktree at \/old\/place\/tree\./)
    expect(told.endsWith("\n\nsecond")).toBe(true)
    // Unchanged since: nothing more.
    await answered(id, "third", 2)
    expect(lastSent()).toBe("third")
  })

  test("a conversation from before Kuvo Code kept what it was told hears its instructions as they are now, once", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.setInstruction(id, "kuvo.moved", "You moved to this computer from the Old Mac.")
    await answered(id, "first", 1)
    sessions.closeAll()
    // As a conversation kept by an older bridge: it has no word of what it was told.
    const file = join(root, "sessions", id, "agent.json")
    writeFileSync(file, readFileSync(file, "utf8").replace(/"claudeTold":\s*"[^"]*",?/, ""))
    expect(readFileSync(file, "utf8")).not.toContain("claudeTold")
    fake = new FakeClaude()
    claude = new TestClaude(fake, root)
    sessions = withBlocks([])
    await answered(id, "second", 1)
    expect(lastSent()).toContain("You moved to this computer from the Old Mac.")
    expect(lastSent().endsWith("\n\nsecond")).toBe(true)
    await answered(id, "third", 2)
    expect(lastSent()).toBe("third")
  })

  test("changed while Claude Code runs: a command you type goes as typed, and the next message says what changed", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await answered(id, "first", 1)
    // Its worktree changed: it starts again, going on with the same conversation.
    sessions.setInstruction(id, "kuvo.worktree", "You work in the worktree at /a/tree.")
    fake.out = new Queue<any>()
    await answered(id, "/review", 2)
    expect(fake.options.resume).toBeTruthy()
    expect(lastSent()).toBe("/review")
    await answered(id, "go on", 3)
    expect(lastSent()).toContain("You work in the worktree at /a/tree.")
    expect(lastSent().endsWith("\n\ngo on")).toBe(true)
  })

  test("a message Claude Code never took: what changed goes with the next; one it took and failed on isn't said again", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await answered(id, "first", 1)
    sessions.setInstruction(id, "kuvo.project-folders", "The project's other folder is /elsewhere.")
    fake.out = new Queue<any>()
    sessions.prompt(id, { id: "msg_claude_told_f", text: "second", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    expect(lastSent()).toContain("/elsewhere")
    // It stops before it takes it.
    fake.crash(new Error("Claude Code process exited with code 1"))
    await until(() => idles(id).length === 2)
    expect(idles(id)[1].outcome).toBe("failed")
    fake.out = new Queue<any>()
    sessions.prompt(id, { id: "msg_claude_told_g", text: "third", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 3)
    expect(lastSent()).toContain("/elsewhere")
    // This time it takes it, and fails on it (Claude's API overloaded).
    fake.out.push({ type: "system", subtype: "init", session_id: fake.options.resume })
    fake.result([fake.sent.at(-1).uuid], "error_during_execution", { result: "Overloaded" })
    await until(() => idles(id).length === 3)
    expect(idles(id)[2].outcome).toBe("failed")
    await answered(id, "fourth", 4)
    expect(lastSent()).toBe("fourth")
  })

  test("once Claude Code summarized its conversation, what it has is what it was started with: nothing more to say", async () => {
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    await answered(id, "first", 1)
    sessions.setInstruction(id, "kuvo.worktree", "You work in the worktree at /b/tree.")
    fake.out = new Queue<any>()
    // Your command, as typed, and Claude Code summarizes.
    sessions.prompt(id, { id: "msg_claude_told_c", text: "/compact", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 2)
    expect(lastSent()).toBe("/compact")
    fake.out.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 100 }, parent_tool_use_id: null })
    fake.result([fake.sent.at(-1).uuid])
    await until(() => idles(id).length === 2)
    await answered(id, "after", 3)
    expect(lastSent()).toBe("after")
  })
})

describe("the plan's limits a turn hears", () => {
  test("Claude Code's rate-limit event in a turn keeps the account's window current for the clients", async () => {
    const limits = new Limits(() => agentAccounts([claude]))
    await limits.tick()
    const { id, first } = await begin()
    // As Claude Code 2.1.3xx tells it: every window, from the response's headers.
    fake.out.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: 1_794_200_000, surpassedThreshold: 0.75, unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 1_794_100_000 }, seven_day: { utilization: 0.81, resetsAt: 1_794_200_000, status: "allowed_warning" } } } })
    await until(() => limits.list().length > 0)
    const [account] = limits.list()
    expect(account!.provider).toBe(provider)
    expect(account!.windows.map((window) => [window.id, window.used, window.minutes, window.resetsAt, window.source])).toEqual([
      ["five_hour", 0.3, 300, 1_794_100_000_000, "turn"],
      ["seven_day", 0.81, 10_080, 1_794_200_000_000, "turn"],
    ])
    fake.result([first])
    await until(() => idles(id).length > 0)
  })
})

describe("Your subagents (Settings › Agents), in Claude Code", () => {
  /** A turn that has started, with the engine listing your subagents and the model they use. */
  async function started(model: string | undefined) {
    const engine = subagentEngine(root)
    engine.model = model
    await engine.serve()
    const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_claude_subs_001", text: "review it", files: [], delivery: "steer" })
    await until(() => fake.sent.length === 1)
    return { engine, id }
  }

  test("it's given them as its own, over one of the same name in ~/.claude/agents: their words, a model it runs, the tools they may not use, and the model for the rest", async () => {
    const { engine } = await started("claude-code/haiku")
    try {
      expect(Object.keys(fake.options.agents).sort()).toEqual(["Keyword Research", "reviewer"])
      expect(fake.options.agents.reviewer).toEqual({
        description: "Reviews a finished change.",
        prompt: "You review. You never edit.",
        model: "haiku",
        disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit"],
      })
      // Its own model is one Claude Code doesn't run: it goes by the model Claude Code's subagents use.
      expect(fake.options.agents["Keyword Research"]).toEqual({ description: "Finds keywords.", prompt: "You research keywords." })
      expect(fake.options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("haiku")
    } finally {
      engine.stop()
    }
  })

  test("the model changed in Settings: the next message starts it again with that one; one it doesn't run leaves its subagents on the conversation's", async () => {
    const { engine, id } = await started("claude-code/sonnet")
    try {
      expect(fake.options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("sonnet")
      const first = fake.sent[0].uuid
      fake.result([first])
      await until(() => idles(id).length === 1)
      engine.model = "openai/gpt-5"
      fake.out = new Queue<any>()
      sessions.prompt(id, { id: "msg_claude_subs_002", text: "again", files: [], delivery: "steer" })
      await until(() => fake.sent.length === 2)
      expect(fake.closed).toBe(true)
      expect(fake.options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
      expect(Object.keys(fake.options.agents)).toContain("reviewer")
    } finally {
      engine.stop()
    }
  })

  test("a subagent of yours with no model of its own takes the one subagents use as it is now, not the one the engine still has for it a moment", async () => {
    const engine = subagentEngine(root)
    // The engine still lists the model it had before for it (it reads the box's layer again later).
    engine.agents = engine.agents.map((agent) => (agent.id === "reviewer" ? { ...agent, model: { providerID: "claude-code", id: "haiku" } } : agent))
    engine.inSettings = { reviewer: { mode: "subagent" } }
    engine.model = "claude-code/sonnet"
    await engine.serve()
    try {
      const id = sessions.create({ model: { providerID: provider, id: "default" }, location: { directory: root } }).id
      sessions.prompt(id, { id: "msg_claude_subs_004", text: "review it", files: [], delivery: "steer" })
      await until(() => fake.sent.length === 1)
      expect(fake.options.agents.reviewer.model).toBe("sonnet")
    } finally {
      engine.stop()
    }
  })

  test("the engine starting again meanwhile doesn't start Claude Code again: it keeps the subagents it has", async () => {
    const { engine, id } = await started("claude-code/haiku")
    try {
      fake.result([fake.sent[0].uuid])
      await until(() => idles(id).length === 1)
      engine.down()
      sessions.prompt(id, { id: "msg_claude_subs_003", text: "again", files: [], delivery: "steer" })
      await until(() => fake.sent.length === 2)
      expect(fake.closed).toBe(false)
    } finally {
      engine.stop()
    }
  })

  test("a subagent's tools go by what it may do, with the session's rules over them", async () => {
    const { engine, id } = await started(undefined)
    try {
      const hook = async (name: string, input: Record<string, unknown>, toolUseID: string, agent?: string) => {
        const said = await fake.options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: toolUseID, ...(agent ? { agent_id: "ag1", agent_type: agent } : {}) })
        return said?.hookSpecificOutput?.permissionDecision
      }
      // The reviewer edits nothing, and asks before a command but `git diff`.
      expect(await hook("Edit", { file_path: join(root, "a.ts"), old_string: "a", new_string: "b" }, "t1", "reviewer")).toBe("deny")
      expect(await hook("Bash", { command: "git diff HEAD" }, "t2", "reviewer")).toBeUndefined()
      expect(await hook("Bash", { command: "rm -rf build" }, "t3", "reviewer")).toBe("ask")
      const asked = fake.canUse("Bash", { command: "rm -rf build" }, "t3", { agentID: "ag1" })
      await until(() => sessions.permissions(id).length === 1)
      sessions.replyPermission(id, sessions.permissions(id)[0].id, "reject")
      expect((await asked).behavior).toBe("deny")
      // The conversation's own agent, and Claude Code's own subagents, go by the session's.
      expect(await hook("Edit", { file_path: join(root, "a.ts"), old_string: "a", new_string: "b" }, "t4")).toBeUndefined()
      expect(await hook("Bash", { command: "rm -rf build" }, "t5", "general-purpose")).toBeUndefined()
      expect((await fake.canUse("Bash", { command: "rm -rf build" }, "t5", { agentID: "ag2" })).behavior).toBe("allow")
      // Approve All for the session goes over what the subagent asks first about, as the engine has it.
      sessions.update(id, { permissions: [{ action: "*", resource: "*", effect: "allow" }] })
      expect(await hook("Bash", { command: "rm -rf build" }, "t6", "reviewer")).toBeUndefined()
      expect(await hook("Edit", { file_path: join(root, "a.ts"), old_string: "a", new_string: "b" }, "t7", "reviewer")).toBeUndefined()
    } finally {
      engine.stop()
    }
  })
})
