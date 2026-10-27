// Cursor's thread against a fake SDK: what its agent is started with, and what a session shows of
// its turns (its reply and steps, Stop, each approval mode, what a turn used).

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TurnHooks } from "../../src/agents/agent"
import { CursorAgent } from "../../src/agents/agents/cursor"
import { setToolServer } from "../../src/agents/kuvotools"
import { Auto } from "../../src/agents/auto"
import type { Roster } from "../../src/agents/roster"
import { Sessions } from "../../src/agents/sessions"
import { Store } from "../../src/agents/store"
import { noTokens, type Message, type PermissionRule, type Session } from "../../src/agents/wire"

/** Cursor's SDK as far as the bridge uses it: each agent's options as it was made (`made`) or
 *  picked up again (`resumed`, when it `resumes`), and what each run was sent with (`sent`). A run
 *  sends `updates`, then ends with `result`; one that `holds` works until it's cancelled, and
 *  ends cancelled. */
function fakeSDK(updates: any[] = [], result: any = { status: "finished" }, options: { holds?: boolean; resumes?: boolean } = {}) {
  let next = 1
  const agent = (agentId: string) => ({
    agentId,
    close() {},
    send: async (message: any, sendOptions: { mode?: string; onDelta: (event: { update: any }) => Promise<void> }) => {
      sdk.sent.push({ message, options: sendOptions })
      for (const update of updates) await sendOptions.onDelta({ update })
      let stop: () => void = () => {}
      const stopped = new Promise<any>((resolve) => (stop = () => resolve({ status: "cancelled" })))
      return {
        wait: async () => (options.holds ? stopped : result),
        cancel: async () => {
          sdk.cancels++
          stop()
        },
      }
    },
  })
  const sdk = {
    made: [] as any[],
    resumed: [] as { id: string; options: any }[],
    sent: [] as { message: any; options: any }[],
    cancels: 0,
    Agent: {
      create: async (agentOptions: any) => {
        sdk.made.push(agentOptions)
        return agent(`agent-${next++}`)
      },
      resume: async (id: string, agentOptions: any) => {
        if (!options.resumes) return undefined
        sdk.resumed.push({ id, options: agentOptions })
        return agent(id)
      },
    },
    JsonlLocalAgentStore: class {},
    createAgentPlatform: async () => ({ prewarmLocalWorkspace: async () => undefined }),
  }
  return sdk
}

class TestCursor extends CursorAgent {
  override async account() {
    return { installed: true, signedIn: true }
  }
}

const folders: string[] = []
let sessions: Sessions | undefined
afterEach(() => {
  sessions?.closeAll()
  sessions = undefined
  setToolServer(undefined)
  delete process.env.CURSOR_API_KEY
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function hooks(state: Record<string, unknown>): TurnHooks {
  return {
    permission: async () => "once" as any,
    question: async () => null,
    instructions: () => "",
    check: () => undefined,
    state,
    saveState() {},
    approvesAll: () => true,
    signal: new AbortController().signal,
    subagent: () => {
      throw new Error("no subagents here")
    },
  }
}

/** A session on one of Cursor's models, against `sdk`, in a folder of its own. */
function cursorSession(sdk: ReturnType<typeof fakeSDK>, permissions?: PermissionRule[]) {
  const home = mkdtempSync(join(tmpdir(), "kuvo-cursor-"))
  folders.push(home)
  process.env.CURSOR_API_KEY = "key_test"
  const agent = new TestCursor({ home, temporary: home, deps: { ensure: async () => home, load: async () => sdk } as any })
  const opened = new Sessions(new Store(join(home, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(home))
  sessions = opened
  const id = opened.create({ model: { providerID: agent.providerID, id: "composer-2" }, location: { directory: home }, permissions }).id
  return { sessions: opened, id, home }
}

async function until(condition: () => boolean, ms = 10_000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

let counter = 0
/** Sends a message; with `wait`, until its turn has ended. */
async function send(opened: Sessions, id: string, text = "go", wait = true) {
  const before = idles(opened, id).length
  opened.prompt(id, { id: `msg_cursor_test${String(++counter).padStart(8, "0")}`, text, files: [], delivery: "steer" })
  if (wait) await until(() => idles(opened, id).length > before)
}

const idles = (opened: Sessions, id: string) => opened.messages(id).filter((message) => message.type === "idle") as Extract<Message, { type: "idle" }>[]
const steps = (opened: Sessions, id: string) => opened.messages(id).filter((message) => message.type === "assistant") as any[]
const tools = (opened: Sessions, id: string) => steps(opened, id).flatMap((step) => step.content.filter((content: any) => content.type === "tool"))
const notices = (opened: Sessions, id: string) => opened.messages(id).flatMap((message: Message) => (message.type === "synthetic" ? [(message as { text: string }).text] : []))

/** Settings › Permissions' Ask First, as the app sets it on a session. */
const askFirst: PermissionRule[] = ["edit", "write", "patch", "shell", "webfetch", "external_directory"].map((action) => ({ action, resource: "*", effect: "ask" }))

describe("Cursor", () => {
  test("its agent gets Kuvo Code's tools, for its own conversation, as the other agents do", async () => {
    const home = mkdtempSync(join(tmpdir(), "kuvo-cursor-"))
    folders.push(home)
    const sdk = fakeSDK()
    process.env.CURSOR_API_KEY = "key_test"
    const agent = new CursorAgent({ home, temporary: home, deps: { ensure: async () => home, load: async () => sdk } as any })
    const session: Session = { id: "ses_bot", projectID: "p", cost: 0, tokens: noTokens(), time: { created: 1, updated: 1 }, title: "Primary", location: { directory: home } }
    const state: Record<string, unknown> = {}
    const thread = agent.thread(session, state)
    const input = { text: "hi", files: [], model: { id: "grok-4.7", providerID: "cursor" }, plan: false }

    setToolServer({ url: "http://127.0.0.1:47000/mcp", token: "secret", timeout: 1_000 })
    await thread.prepare?.(input, hooks(state))
    const tools = sdk.made.at(-1)?.mcpServers?.["kuvo-browser"]
    expect(tools?.url).toBe("http://127.0.0.1:47000/mcp")
    expect(tools?.headers).toEqual({ Authorization: "Bearer secret", "X-Kuvo-Session": "ses_bot" })

    // The app started again, its tools elsewhere: the agent is started again with them.
    setToolServer({ url: "http://127.0.0.1:47001/mcp", token: "other", timeout: 1_000 })
    await thread.prepare?.(input, hooks(state))
    expect(sdk.made.length).toBe(2)
    expect(sdk.made.at(-1)?.mcpServers?.["kuvo-browser"]?.url).toBe("http://127.0.0.1:47001/mcp")
  })
})

describe("Cursor's turns", () => {
  test("its reply, its thinking, and its steps with what each did, a step for the words after its tools", async () => {
    const sdk = fakeSDK([
      { type: "thinking-delta", text: "Let me look." },
      { type: "thinking-completed" },
      { type: "text-delta", text: "I'll run " },
      { type: "text-delta", text: "the tests." },
      { type: "tool-call-started", callId: "c1", toolCall: { type: "shell", args: { command: "bun test" } } },
      { type: "shell-output-delta", event: { case: "stdout", value: { data: "3 pass\n" } } },
      { type: "tool-call-completed", callId: "c1", toolCall: { type: "shell", args: { command: "bun test" }, result: { status: "success", value: { exitCode: 0, signal: "", stdout: "3 pass\n", stderr: "", executionTime: 9 } } } },
      { type: "tool-call-started", callId: "c2", toolCall: { type: "edit", args: { path: "/p/a.ts" } } },
      { type: "tool-call-completed", callId: "c2", toolCall: { type: "edit", args: { path: "/p/a.ts" }, result: { status: "success", value: { linesAdded: 1, linesRemoved: 1, diffString: "@@ -1 +1 @@\n-old\n+new" } } } },
      { type: "tool-call-started", callId: "c3", toolCall: { type: "read", args: { path: "/p/gone.ts" } } },
      { type: "tool-call-completed", callId: "c3", toolCall: { type: "read", args: { path: "/p/gone.ts" }, result: { status: "error", error: { message: "No such file." } } } },
      { type: "step-completed" },
      { type: "text-delta", text: "All 3 tests pass." },
    ])
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id, "run the tests")

    expect(sdk.sent.at(-1)?.message).toContain("run the tests")
    expect(idles(sessions, id).map((idle) => idle.outcome)).toEqual(["succeeded"])
    const [working, answer] = steps(sessions, id)
    expect(steps(sessions, id).length).toBe(2)
    expect(working.content.map((content: any) => content.type)).toEqual(["reasoning", "text", "tool", "tool", "tool"])
    expect(working.content[0].text).toBe("Let me look.")
    expect(working.content[1].text).toBe("I'll run the tests.")
    const [shell, edit, read] = tools(sessions, id)
    expect(shell).toMatchObject({ name: "shell", state: { status: "completed", input: { command: "bun test" }, content: [{ type: "text", text: "3 pass\n" }], metadata: { output: "3 pass\n", exit: 0 } } })
    expect(edit).toMatchObject({ name: "edit", state: { status: "completed", input: { path: "/p/a.ts" }, metadata: { files: [{ file: "/p/a.ts", additions: 1, deletions: 1 }] } } })
    expect(read).toMatchObject({ name: "read", state: { status: "error", input: { path: "/p/gone.ts" }, error: { message: "No such file." } } })
    expect(answer.content).toMatchObject([{ type: "text", text: "All 3 tests pass." }])
  })

  test("a reply it gives only as the run's result still shows", async () => {
    const sdk = fakeSDK([], { status: "finished", result: "Nothing to change." })
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id)
    expect(steps(sessions, id).flatMap((step) => step.content)).toMatchObject([{ type: "text", text: "Nothing to change." }])
    expect(idles(sessions, id).at(-1)?.outcome).toBe("succeeded")
  })

  test("a run that ends in an error fails the turn with Cursor's words", async () => {
    const sdk = fakeSDK([{ type: "text-delta", text: "Starting." }], { status: "error", error: { message: "Cursor's servers are busy." } })
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id)
    expect(idles(sessions, id).at(-1)).toMatchObject({ outcome: "failed", error: { message: "Cursor's servers are busy." } })
  })
})

describe("Stopping Cursor", () => {
  test("Stop mid-turn cancels Cursor's run and ends the turn as stopped, with what it printed so far kept", async () => {
    const sdk = fakeSDK(
      [
        { type: "text-delta", text: "Running the suite." },
        { type: "tool-call-started", callId: "c1", toolCall: { type: "shell", args: { command: "bun test" } } },
        { type: "shell-output-delta", event: { case: "stdout", value: { data: "1 pass\n" } } },
      ],
      undefined,
      { holds: true },
    )
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id, "go", false)
    // The command shows as running, with its output as it comes.
    await until(() => tools(sessions, id)[0]?.state.metadata?.output === "1 pass\n")
    expect(tools(sessions, id)[0].state.status).toBe("running")

    await sessions.interrupt(id)
    await until(() => idles(sessions, id).length === 1)
    expect(idles(sessions, id)[0].outcome).toBe("interrupted")
    expect(sdk.cancels).toBe(1)
    expect(tools(sessions, id)[0].state).toMatchObject({ status: "error", error: { type: "aborted", message: "Stopped." }, metadata: { output: "1 pass\n" } })
    expect(steps(sessions, id)[0].content[0]).toMatchObject({ type: "text", text: "Running the suite." })
  })

  test("a subagent at work when you stop shows as stopped in its session, not finished", async () => {
    const sdk = fakeSDK(
      [
        { type: "tool-call-started", callId: "t1", toolCall: { type: "task", args: { description: "Find the tests", prompt: "Where are the tests?" } } },
        { type: "tool-call-delta", callId: "t1", taskUpdate: { type: "tool-call-started", callId: "s1", toolCall: { type: "shell", args: { command: "ls" } } } },
      ],
      undefined,
      { holds: true },
    )
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id, "go", false)
    await until(() => sessions.list(undefined, id).length === 1 && tools(sessions, sessions.list(undefined, id)[0].id).length === 1)
    const child = sessions.list(undefined, id)[0]
    expect(child.title).toBe("Find the tests")

    await sessions.interrupt(id)
    await until(() => idles(sessions, id).length === 1)
    expect(idles(sessions, child.id).map((idle) => idle.outcome)).toEqual(["interrupted"])
    expect(tools(sessions, child.id)[0].state).toMatchObject({ status: "error", error: { message: "Stopped." } })
  })
})

describe("Cursor's approvals", () => {
  // Cursor's SDK can't stop to ask: the session's mode decides, as its agent starts, whether it
  // runs in its sandbox with Cursor's own review of each call.
  test("Approve All: it runs its tools on its own, outside its sandbox, and nothing is said", async () => {
    const sdk = fakeSDK([{ type: "text-delta", text: "Done." }])
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id)
    expect(sdk.made.at(-1)).toMatchObject({ mode: "agent", local: { autoReview: false, sandboxOptions: { enabled: false } } })
    expect(sdk.sent.at(-1)?.options.mode).toBe("agent")
    expect(notices(sessions, id)).toEqual([])
  })

  test("Ask First: it runs in its sandbox with Cursor's review, and the session says once that it can't stop to ask", async () => {
    const sdk = fakeSDK([{ type: "text-delta", text: "Done." }])
    const { sessions, id } = cursorSession(sdk, askFirst)
    await send(sessions, id)
    await send(sessions, id)
    expect(sdk.made.length).toBe(1)
    expect(sdk.made[0]).toMatchObject({ mode: "agent", local: { autoReview: true, sandboxOptions: { enabled: true } } })
    expect(notices(sessions, id)).toEqual([
      "Cursor can't stop to ask you before it acts here: it runs what its sandbox allows and declines the rest. Use Plan mode to have it propose changes first.",
    ])
  })

  test("Plan: it plans in its sandbox, with nothing said", async () => {
    const sdk = fakeSDK([{ type: "text-delta", text: "Here's the plan." }])
    const { sessions, id } = cursorSession(sdk)
    sessions.selectAgent(id, "plan")
    await send(sessions, id)
    expect(sdk.made.at(-1)).toMatchObject({ mode: "plan", local: { autoReview: true, sandboxOptions: { enabled: true } } })
    expect(sdk.sent.at(-1)?.options.mode).toBe("plan")
    expect(notices(sessions, id)).toEqual([])
  })

  test("switching modes starts its agent again on the same conversation, as the new mode says", async () => {
    const sdk = fakeSDK([{ type: "text-delta", text: "Done." }], undefined, { resumes: true })
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id)
    expect(sdk.made.length).toBe(1)
    sessions.update(id, { permissions: askFirst })
    await send(sessions, id)
    expect(sdk.made.length).toBe(1)
    expect(sdk.resumed.map((resumed) => resumed.id)).toEqual(["agent-1"])
    expect(sdk.resumed[0].options).toMatchObject({ local: { autoReview: true, sandboxOptions: { enabled: true } } })
    // Back to Approve All: out of the sandbox again.
    sessions.update(id, { permissions: [] })
    await send(sessions, id)
    expect(sdk.resumed.map((resumed) => resumed.id)).toEqual(["agent-1", "agent-1"])
    expect(sdk.resumed[1].options).toMatchObject({ local: { autoReview: false, sandboxOptions: { enabled: false } } })
    expect(idles(sessions, id).map((idle) => idle.outcome)).toEqual(["succeeded", "succeeded", "succeeded"])
  })
})

describe("Cursor's context", () => {
  const turnEnded = (input: number, cached: number, output: number) => ({ type: "turn-ended", usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: 0, reasoningTokens: 40 } })

  test("how full it is is its last turn's request, not the run's turns added up", async () => {
    const sdk = fakeSDK([{ type: "text-delta", text: "Looking." }, turnEnded(2_000, 20_000, 300), { type: "text-delta", text: " Done." }, turnEnded(1_500, 23_000, 200)], {
      status: "finished",
      usage: { inputTokens: 3_500, outputTokens: 500, cacheReadTokens: 43_000, cacheWriteTokens: 0 },
    })
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id)
    const last = steps(sessions, id).at(-1)
    // (Its thinking is part of what it wrote, as Cursor counts: counted once.)
    expect(last.tokens).toEqual({ input: 1_500, output: 160, reasoning: 40, cache: { read: 23_000, write: 0 } })
  })

  test("without a turn's own numbers, the run's: on its last step and the session's usage, thinking counted once", async () => {
    const sdk = fakeSDK([{ type: "text-delta", text: "Done." }], {
      status: "finished",
      usage: { inputTokens: 1_000, outputTokens: 300, reasoningTokens: 100, cacheReadTokens: 5_000, cacheWriteTokens: 200, totalTokens: 6_500 },
    })
    const { sessions, id } = cursorSession(sdk)
    await send(sessions, id)
    const used = { input: 1_000, output: 200, reasoning: 100, cache: { read: 5_000, write: 200 } }
    expect(steps(sessions, id).at(-1).tokens).toEqual(used)
    expect(sessions.get(id).tokens).toEqual(used)
  })
})
