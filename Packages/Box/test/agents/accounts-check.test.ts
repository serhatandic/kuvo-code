// An agent's sign-in as the app reads it (`/api/integration`, `/api/model`) while its check can't
// answer: on a computer too busy to run `claude auth status` in time, the account and its models
// stay as the agent last said, and only the agent's own word that you're signed out is a sign-out.
// Claude Code and Grok are fake programs on the PATH; Codex's app-server and Cursor's SDK are stand-ins.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { Agent } from "../../src/agents/agent"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { CodexAgent } from "../../src/agents/agents/codex"
import { CursorAgent } from "../../src/agents/agents/cursor"
import { GrokAgent } from "../../src/agents/agents/grok"
import { subscribe } from "../../src/agents/events"
import { handler } from "../../src/agents/server"
import type { ServerEvent } from "../../src/agents/wire"

let root: string
let bin: string
const path = process.env.PATH

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-accounts-check-"))
  bin = join(root, "bin")
  // The fake programs first: they're the ones found.
  process.env.PATH = [bin, path].join(delimiter)
})

afterAll(() => {
  process.env.PATH = path
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env.CURSOR_API_KEY
})

/** A program on the PATH that answers as `mode`'s file says: what it prints, or killed as it runs (a check cut short). */
function program(name: string, answers: Record<string, string>): (mode: string) => void {
  const modeFile = join(root, `${name}.mode`)
  const cases = Object.entries(answers)
    .map(([mode, script]) => `  ${mode}) ${script} ;;`)
    .join("\n")
  require("node:fs").mkdirSync(bin, { recursive: true })
  const file = join(bin, name)
  writeFileSync(file, `#!/bin/sh\ncase "$(cat '${modeFile}')" in\n${cases}\n  killed) kill -9 $$ ;;\nesac\n`)
  chmodSync(file, 0o755)
  return (mode) => writeFileSync(modeFile, mode)
}

/** The bridge's own routes, as the app asks them, for these agents alone. */
function bridge(agents: Agent[]) {
  const answer = handler({ roster: { all: () => agents, find: (id: string) => agents.find((agent) => agent.providerID === id) }, password: "pw" } as any)
  const ask = async (route: string) => {
    const response = await answer(new Request(`http://box/api/${route}`, { headers: { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") } }))
    return ((await response.json()) as any).data
  }
  return {
    /** The account as Settings › Accounts shows it, asked anew. */
    account: (agent: Agent) => ask(`integration/${encodeURIComponent(agent.providerID)}`),
    /** The models the picker lists, of `agent`. */
    models: async (agent: Agent) => ((await ask("model")) as any[]).filter((model) => model.providerID === agent.providerID).map((model) => model.id),
  }
}

/** What the app was told changed meanwhile (an `integration.updated` makes it read every account and model again). */
function told(): { events: ServerEvent[]; stop: () => void } {
  const events: ServerEvent[] = []
  const stop = subscribe((event) => {
    if (event.type === "integration.updated") events.push(event)
  })
  return { events, stop }
}

const context = () => {
  const home = mkdtempSync(join(root, "agent-"))
  return { home, temporary: home, deps: {} as any }
}

describe("an agent's sign-in that can't be checked just now", () => {
  test("Claude Code: still signed in as you, with its models, until Claude Code says you're signed out", async () => {
    const claude = program("claude", {
      in: `echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}'`,
      out: `echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`,
      garbled: `echo 'Error: something went wrong'; exit 1`,
    })
    class TestClaude extends ClaudeAgent {
      // Claude Code's own list of your models, as it says once it starts.
      override async sdk(): Promise<any> {
        return {
          query: () => ({
            initializationResult: async () => ({ models: [{ value: "opus", displayName: "Opus", description: "Opus 5.5 · Most capable" }] }),
            setModel: async () => {
              throw new Error("Unknown control request")
            },
          }),
        }
      }
    }
    const agent = new TestClaude(context())
    const box = bridge([agent])

    claude("in")
    expect((await box.account(agent)).connections[0]?.label).toBe("ada@example.com · Max plan")
    expect(await box.models(agent)).not.toEqual([])

    // Killed as it checks (a check that ran out of time), or saying nothing it can go by.
    const changes = told()
    for (const mode of ["killed", "garbled"]) {
      claude(mode)
      const account = await box.account(agent)
      expect(account.connections[0]?.label).toBe("ada@example.com · Max plan")
      expect(account.metadata.message).toBeUndefined()
      expect(account.metadata.unchecked).toBe(true)
      expect(await box.models(agent)).not.toEqual([])
    }
    changes.stop()
    expect(changes.events).toEqual([])

    // Claude Code's own word: signed out.
    claude("out")
    const account = await box.account(agent)
    expect(account.connections).toEqual([])
    expect(account.metadata.message).toBe("Sign in to Claude Code with your Claude plan or an Anthropic Console account.")
    expect(await box.models(agent)).toEqual([])
  })

  test("never checked yet, a check that fails isn't taken for a sign-out either, and says it couldn't check", async () => {
    const claude = program("claude", { in: `echo '{"loggedIn":true}'` })
    const agent = new ClaudeAgent(context())
    claude("killed")
    const account = await bridge([agent]).account(agent)
    expect(account.connections[0]?.status).toEqual({ status: "connected", message: "Couldn't check the sign-in just now" })
    expect(account.metadata.unchecked).toBe(true)
  })

  test("Grok: its models stay listed while `grok models` can't answer", async () => {
    const grok = program("grok", {
      in: `printf 'You are logged in with grok.com.\\n\\nAvailable models:\\n  * grok-4.7 (default)\\n  - grok-4.6\\n'`,
      out: `echo 'Error: not authenticated. Run grok login first.'; exit 1`,
      silent: `exit 1`,
    })
    const agent = new GrokAgent(context())
    const box = bridge([agent])

    grok("in")
    expect((await box.account(agent)).connections[0]?.label).toBe("grok.com")
    expect(await box.models(agent)).toEqual(["grok-4.7", "grok-4.6"])

    for (const mode of ["killed", "silent"]) {
      grok(mode)
      expect((await box.account(agent)).connections[0]?.label).toBe("grok.com")
      expect(await box.models(agent)).toEqual(["grok-4.7", "grok-4.6"])
    }

    grok("out")
    expect((await box.account(agent)).connections).toEqual([])
    expect(await box.models(agent)).toEqual([])
  })

  test("Codex: an app-server that doesn't answer in time keeps the account and the models it listed", async () => {
    let answering = true
    const server = {
      isClosed: false,
      request: async (method: string) => {
        if (!answering) throw new Error(`Codex didn't answer ${method} in time.`)
        if (method === "account/read") return { account: { type: "chatgpt", email: "ada@example.com", planType: "plus" } }
        if (method === "model/list") return { data: [{ id: "gpt-6", model: "gpt-6", displayName: "GPT-6", isDefault: true }] }
        throw new Error(`No ${method}.`)
      },
    }
    class TestCodex extends CodexAgent {
      override executable() {
        return "/usr/bin/true"
      }
      override async rpc(): Promise<any> {
        return server
      }
    }
    const agent = new TestCodex(context())
    const box = bridge([agent])

    expect((await box.account(agent)).connections[0]?.label).toBe("ada@example.com · ChatGPT Plus")
    expect(await box.models(agent)).toEqual(["gpt-6"])

    answering = false
    const account = await box.account(agent)
    expect(account.metadata.installed).toBe(true)
    expect(account.connections[0]?.label).toBe("ada@example.com · ChatGPT Plus")
    ;(agent as any).modelList.at = 0
    expect(await box.models(agent)).toEqual(["gpt-6"])
  })

  test("Cursor: out of reach, still signed in as you with your models; turned down by Cursor, signed out", async () => {
    process.env.CURSOR_API_KEY = "key_test"
    let reachable = true
    let rejects = false
    class AuthenticationError extends Error {}
    const sdk = {
      AuthenticationError,
      Cursor: {
        me: async () => {
          if (rejects) throw new AuthenticationError("Unauthorized")
          if (!reachable) throw new Error("fetch failed")
          return { userEmail: "ada@example.com" }
        },
        models: {
          list: async () => {
            if (!reachable) throw new Error("fetch failed")
            return [{ id: "default" }, { id: "composer-2", displayName: "Composer 2" }]
          },
        },
      },
    }
    class TestCursor extends CursorAgent {
      override async sdk(): Promise<any> {
        return sdk
      }
    }
    const agent = new TestCursor(context())
    const box = bridge([agent])

    expect((await box.account(agent)).connections[0]?.label).toBe("ada@example.com")
    expect(await box.models(agent)).toEqual(["default", "composer-2"])

    reachable = false
    expect((await box.account(agent)).connections[0]?.label).toBe("ada@example.com")
    ;(agent as any).modelList.at = 0
    expect(await box.models(agent)).toEqual(["default", "composer-2"])

    reachable = true
    rejects = true
    expect((await box.account(agent)).connections).toEqual([])
  })
})
