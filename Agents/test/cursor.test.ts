// Cursor's thread against a fake SDK: what its agent is started with.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TurnHooks } from "../src/agent"
import { CursorAgent } from "../src/agents/cursor"
import { setToolServer } from "../src/kuvotools"
import { Auto } from "../src/auto"
import type { Roster } from "../src/roster"
import { Sessions } from "../src/sessions"
import { Store } from "../src/store"
import { noTokens, type Session } from "../src/wire"

/** Cursor's SDK as far as starting an agent goes: each agent's options, as it was made; a run
 *  sends `updates`, then ends with `result`. */
function fakeSDK(updates: any[] = [], result: any = { status: "finished" }) {
  const made: any[] = []
  let next = 1
  const sdk = {
    made,
    Agent: {
      create: async (options: any) => {
        made.push(options)
        return {
          agentId: `agent-${next++}`,
          close() {},
          send: async (_message: any, options: { onDelta: (event: { update: any }) => Promise<void> }) => {
            for (const update of updates) await options.onDelta({ update })
            return { wait: async () => result, cancel: async () => {} }
          },
        }
      },
      resume: async () => undefined,
    },
    JsonlLocalAgentStore: class {},
    createAgentPlatform: async () => ({ prewarmLocalWorkspace: async () => undefined }),
  }
  return sdk
}

const folders: string[] = []
afterEach(() => {
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

describe("Cursor's context", () => {
  test("how full it is is its last turn's request, not the run's turns added up", async () => {
    const home = mkdtempSync(join(tmpdir(), "kuvo-cursor-"))
    folders.push(home)
    const turnEnded = (input: number, cached: number, output: number) => ({ type: "turn-ended", usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: 0, reasoningTokens: 40 } })
    const sdk = fakeSDK([{ type: "text-delta", text: "Looking." }, turnEnded(2_000, 20_000, 300), { type: "text-delta", text: " Done." }, turnEnded(1_500, 23_000, 200)], {
      status: "finished",
      usage: { inputTokens: 3_500, outputTokens: 500, cacheReadTokens: 43_000, cacheWriteTokens: 0 },
    })
    process.env.CURSOR_API_KEY = "key_test"
    class TestCursor extends CursorAgent {
      override async account() {
        return { installed: true, signedIn: true }
      }
    }
    const agent = new TestCursor({ home, temporary: home, deps: { ensure: async () => home, load: async () => sdk } as any })
    const sessions = new Sessions(new Store(join(home, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(home))
    try {
      const id = sessions.create({ model: { providerID: agent.providerID, id: "composer-2" }, location: { directory: home } }).id
      sessions.prompt(id, { id: "msg_cursor_test_01", text: "go", files: [], delivery: "steer" })
      const start = Date.now()
      while (!sessions.messages(id).some((message) => message.type === "idle")) {
        if (Date.now() - start > 10_000) throw new Error("timed out")
        await Bun.sleep(10)
      }
      const last = sessions.messages(id).filter((message: any) => message.type === "assistant").at(-1) as any
      expect(last.tokens).toEqual({ input: 1_500, output: 200, reasoning: 40, cache: { read: 23_000, write: 0 } })
    } finally {
      sessions.closeAll()
    }
  })
})
