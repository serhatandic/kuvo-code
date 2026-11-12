// An agent's sign-in as the app reads it (`/api/integration`, `/api/model`) while its check can't
// answer: on a computer too busy to run `claude auth status` in time, the account and its models
// stay as the agent last said, and only the agent's own word that you're signed out is a sign-out.
// Claude Code and Grok are fake programs on the PATH; Codex's app-server and Cursor's SDK are stand-ins.

import "../safety"
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { TookTooLong, type Agent } from "../../src/agents/agent"
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
const keychain = ClaudeAgent.keychain
const realFetch = globalThis.fetch

beforeAll(() => {
  // Claude Code's own sign-in, as a machine's is (a Mac's is Kuvo Code's own: its describe below).
  ClaudeAgent.keychain = false
  root = mkdtempSync(join(tmpdir(), "kuvo-accounts-check-"))
  bin = join(root, "bin")
  mkdirSync(bin)
  // The fake programs first: they're the ones found.
  process.env.PATH = [bin, path].join(delimiter)
  // Reading an account also asks its maker's npm registry for the newest program version: here,
  // the programs are fakes, and a slow registry under load would hold each read for its 2 s and
  // answer after the read, announcing an update this test doesn't ask about. This file asks nothing
  // else of the network, so every fetch is answered at once, as a registry that can't answer does.
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch
})

afterAll(() => {
  ClaudeAgent.keychain = keychain
  process.env.PATH = path
  globalThis.fetch = realFetch
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env.CURSOR_API_KEY
  setSystemTime()
})

/** A program on the PATH that answers as `mode`'s file says: what it prints, or killed as it runs (a check cut short). */
function program(name: string, answers: Record<string, string>): (mode: string) => void {
  const modeFile = join(root, `${name}.mode`)
  const cases = Object.entries(answers)
    .map(([mode, script]) => `  ${mode}) ${script} ;;`)
    .join("\n")
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
    /** The models the picker lists, of `agent` (its account as it stands, not asked anew). */
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

/** Codex's app-server, as the test says it answers: `account/read` and `model/list`, counted. */
function codexServer() {
  const server = {
    /** How it answers now: as signed in, as signed out, too late, or held until `release`. */
    answers: "in" as "in" | "out" | "late" | "held",
    reads: 0,
    release: () => {},
    /** Called once a held check is waiting. */
    holding: () => {},
    isClosed: false,
    request: async (method: string) => {
      if (method === "account/read") server.reads++
      if (server.answers === "late") throw new TookTooLong(`${method} took too long.`)
      if (server.answers === "held") await new Promise<void>((resolve) => ((server.release = resolve), server.holding()))
      if (method === "account/read") return { account: server.answers === "out" ? null : { type: "chatgpt", email: "ada@example.com", planType: "plus" } }
      if (method === "model/list") return { data: [{ id: "gpt-6", model: "gpt-6", displayName: "GPT-6", isDefault: true }] }
      throw new Error(`No ${method}.`)
    },
  }
  return server
}

function codex(server: { request: (method: string) => Promise<unknown> } | Error) {
  class TestCodex extends CodexAgent {
    override executable() {
      return "/usr/bin/true"
    }
    override async rpc(): Promise<any> {
      if (server instanceof Error) throw server
      return server
    }
  }
  return new TestCodex(context())
}

describe("an agent's sign-in that can't be checked just now", () => {
  test("Claude Code: still signed in as you, with its models, until Claude Code says you're signed out", async () => {
    const claude = program("claude", {
      in: `echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}'`,
      out: `echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`,
      garbled: `echo 'Error: something went wrong' >&2; exit 1`,
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

    // Killed as it checks, or saying nothing it can go by.
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

  test("never answered yet: one that took too long is taken as signed in and says it couldn't check; one that fails says why", async () => {
    const late = codexServer()
    late.answers = "late"
    const slow = codex(late)
    const account = await bridge([slow]).account(slow)
    expect(account.connections[0]?.status).toEqual({ status: "connected", message: "Couldn't check the sign-in just now" })
    expect(account.metadata.unchecked).toBe(true)

    // Its answer once it comes only names the account: nothing the app has to read again.
    const changes = told()
    late.answers = "in"
    expect((await bridge([slow]).account(slow)).connections[0]?.label).toBe("ada@example.com · ChatGPT Plus")
    changes.stop()
    expect(changes.events).toEqual([])

    // Broken for good (its app-server can't start): its own words, as before, not "couldn't check" for ever.
    const broken = codex(new Error("codex: cannot execute binary file"))
    const said = await bridge([broken]).account(broken)
    expect(said.connections).toEqual([])
    expect(said.metadata.message).toBe("codex: cannot execute binary file")
    // Its program is there: no Install, which would run its maker's installer again.
    expect(said.metadata.installed).toBe(true)

    const claude = program("claude", { crashes: `echo 'Segmentation fault' >&2; exit 139` })
    claude("crashes")
    const crashing = new ClaudeAgent(context())
    const crashed = await bridge([crashing]).account(crashing)
    expect(crashed.metadata.message).toBe("Claude Code couldn't say whether it's signed in: Segmentation fault")
    expect(crashed.metadata.installed).toBe(true)
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

  test("Codex: an app-server that doesn't answer in time keeps the account and the models it listed; one that says you're signed out signs you out", async () => {
    const server = codexServer()
    const agent = codex(server)
    const box = bridge([agent])
    const start = Date.now()
    setSystemTime(start)

    expect((await box.account(agent)).connections[0]?.label).toBe("ada@example.com · ChatGPT Plus")
    expect(await box.models(agent)).toEqual(["gpt-6"])

    // Busy past the time its models are listed again.
    server.answers = "late"
    setSystemTime(start + 31 * 60_000)
    const account = await box.account(agent)
    expect(account.metadata.installed).toBe(true)
    expect(account.connections[0]?.label).toBe("ada@example.com · ChatGPT Plus")
    expect(await box.models(agent)).toEqual(["gpt-6"])

    server.answers = "out"
    const out = await box.account(agent)
    expect(out.connections).toEqual([])
    expect(out.metadata.message).toBe("Sign in to Codex with ChatGPT or an OpenAI API key.")
    expect(await box.models(agent)).toEqual([])
  })

  test("a busy agent is asked once at a time, and not again for 30 seconds after a check that failed", async () => {
    const server = codexServer()
    const agent = codex(server)
    const box = bridge([agent])
    const start = Date.now()
    setSystemTime(start)

    // Asked twice while the first check waits: one check, both answered by it.
    server.answers = "held"
    const held = new Promise<void>((resolve) => (server.holding = resolve))
    const both = Promise.all([box.account(agent), box.account(agent)])
    await held
    server.answers = "in"
    server.release()
    for (const account of await both) expect(account.connections[0]?.label).toBe("ada@example.com · ChatGPT Plus")
    expect(server.reads).toBe(1)
    expect(await box.models(agent)).toEqual(["gpt-6"])
    expect(server.reads).toBe(1)

    // Its answer stands a while; then a check that fails…
    server.answers = "late"
    setSystemTime(start + 31_000)
    expect(await box.models(agent)).toEqual(["gpt-6"])
    expect(server.reads).toBe(2)
    // …isn't tried again for 30 seconds by the lists the app reads,
    setSystemTime(start + 50_000)
    expect(await box.models(agent)).toEqual(["gpt-6"])
    expect(server.reads).toBe(2)
    // and is then.
    server.answers = "in"
    setSystemTime(start + 62_000)
    expect(await box.models(agent)).toEqual(["gpt-6"])
    expect(server.reads).toBe(3)
  })

  test("Cursor: out of reach, still signed in as you with your models; turned down by Cursor, or signed out of here, signed out", async () => {
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
    const start = Date.now()
    setSystemTime(start)

    expect((await box.account(agent)).connections[0]?.label).toBe("ada@example.com")
    expect(await box.models(agent)).toEqual(["default", "composer-2"])

    reachable = false
    setSystemTime(start + 31 * 60_000)
    expect((await box.account(agent)).connections[0]?.label).toBe("ada@example.com")
    expect(await box.models(agent)).toEqual(["default", "composer-2"])

    reachable = true
    rejects = true
    expect((await box.account(agent)).connections).toEqual([])

    // Signed out of here, with your key still set: asked anew, not as it last said.
    rejects = false
    expect((await box.account(agent)).connections[0]?.label).toBe("ada@example.com")
    await agent.signOut()
    rejects = true
    expect((await box.models(agent))).toEqual([])
  })
})

describe("signing out of an agent's own sign-in", () => {
  test("on a machine it's Kuvo Code's own, in its folder there: Sign Out signs it out with the agent's own command, or says why it couldn't; on a Mac it's yours, signed out where you signed in", async () => {
    const said = join(root, "claude-logout")
    const signedIn = `echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}'`
    const claude = program("claude", {
      in: `if [ "$2" = logout ]; then echo "$CLAUDE_CONFIG_DIR" > '${said}'; echo out > '${join(root, "claude.mode")}'; exit 0; fi; ${signedIn}`,
      locked: `if [ "$2" = logout ]; then echo 'The Keychain is locked.' >&2; exit 1; fi; ${signedIn}`,
      out: `echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`,
    })
    const signOut = async (agent: Agent) => {
      const answer = handler({ roster: { all: () => [agent], find: (id: string) => (id === agent.providerID ? agent : undefined) }, password: "pw" } as any)
      const response = await answer(new Request(`http://box/api/integration/${encodeURIComponent(agent.providerID)}/disconnect`, { method: "POST", headers: { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") } }))
      return { status: response.status, said: ((await response.json()) as any)?.message as string | undefined }
    }

    // This Mac's: your own Claude Code's, shared with claude in Terminal.
    claude("in")
    const yours = new ClaudeAgent(context())
    expect((await bridge([yours]).account(yours)).metadata.signsOut).toBe(false)

    // A machine's: in Kuvo Code's folder there.
    const home = mkdtempSync(join(root, "machine-claude-"))
    const machine = new ClaudeAgent(context(), { id: "default", home })
    const box = bridge([machine])
    const account = await box.account(machine)
    expect(account.connections[0]?.label).toBe("ada@example.com")
    expect(account.metadata.signsOut).toBe(true)

    claude("locked")
    const refused = await signOut(machine)
    expect(refused.status).not.toBe(200)
    expect(refused.said).toContain("The Keychain is locked.")
    expect((await box.account(machine)).connections[0]?.label).toBe("ada@example.com")

    claude("in")
    expect((await signOut(machine)).status).toBe(200)
    expect(readFileSync(said, "utf8").trim()).toBe(home)
    expect((await box.account(machine)).connections).toEqual([])
  })
})

describe("Claude Code on a Mac: Kuvo Code's own sign-in", () => {
  const TOKEN = "sk-ant-oat01-kuvo_test-token_a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5AA"

  test("signed in once, in a terminal of its own; kept in Kuvo Code's folder and handed to Claude Code; your own sign-in only read, and never signed out of", async () => {
    const said = join(root, "claude-mac-status")
    const logout = join(root, "claude-mac-logout")
    writeFileSync(join(bin, "claude"), `#!/bin/sh
case "$1" in
  setup-token)
    [ -t 0 ] || exit 3
    printf 'https://claude.com/cai/oauth/authorize?code=true&scope=user%%3Ainference\\n\\nPaste code here if prompted > '
    read code
    [ "$code" = "good#state" ] || { echo "OAuth error: That code wasn't accepted."; exit 1; }
    printf '\\nYour OAuth token (valid for 1 year):\\n\\nsk-ant-oat01-kuvo_test-token_a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5AA\\n\\nStore this token securely.\\n'
    read wait ;;
  auth)
    echo "\${CLAUDE_CODE_OAUTH_TOKEN:-none}" >> '${said}'
    [ "$2" = logout ] && { echo out > '${logout}'; exit 0; }
    # Kuvo Code's own folder has no sign-in of Claude Code's; yours does.
    [ -n "$CLAUDE_CONFIG_DIR" ] && { echo '{"loggedIn":false,"authMethod":"none"}'; exit 1; }
    echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}' ;;
esac
`)
    chmodSync(join(bin, "claude"), 0o755)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      const box = bridge([agent])
      expect((await box.account(agent)).connections).toEqual([])

      const sign = await agent.signIn("claudeai", { remote: true })
      expect(sign.url).toContain("scope=user%3Ainference")
      await sign.complete!("good#state")
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      expect(sign.status().status).toBe("complete")

      const account = await box.account(agent)
      expect(account.connections[0]?.label).toBe("ada@example.com · Max plan")
      expect(account.metadata.signsOut).toBe(true)
      expect(agent.env().CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-kuvo_test-token_a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5AA")
      // Kept where only Kuvo Code reads it, and never shown to `claude auth status`.
      expect(agent.tokenFile.startsWith(agent.context.home + "/")).toBe(true)
      expect(statSync(agent.tokenFile).mode & 0o777).toBe(0o600)
      expect(readFileSync(said, "utf8")).not.toContain("sk-ant")

      // Sign Out: Kuvo Code's own sign-in goes; yours stays.
      const answer = handler({ roster: { all: () => [agent], find: (id: string) => (id === agent.providerID ? agent : undefined) }, password: "pw" } as any)
      const out = await answer(new Request(`http://box/api/integration/${encodeURIComponent(agent.providerID)}/disconnect`, { method: "POST", headers: { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") } }))
      expect(out.status).toBe(200)
      expect(existsSync(logout)).toBe(false)
      expect(agent.env().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect((await box.account(agent)).connections).toEqual([])
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })
  /** A Claude Code whose setup-token prints its token as `printed` says (after `good#state`), and
   * then does as `after` says. */
  function setupToken(printed: string, after = "read wait") {
    writeFileSync(join(bin, "claude"), `#!/bin/sh
case "$1" in
  setup-token)
    printf 'https://claude.com/cai/oauth/authorize?code=true\\n\\nPaste code here if prompted > '
    read code
    [ "$code" = "good#state" ] || { printf "OAuth error: That code wasn't accepted. Press Enter to retry.\\n"; read again; printf 'https://claude.com/cai/oauth/authorize?code=true&again\\n'; read wait; exit 1; }
    printf '${printed}'
    ${after} ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}' ;;
esac
`)
    chmodSync(join(bin, "claude"), 0o755)
  }

  test("a token drawn with the next line's text after a cursor move is kept whole", async () => {
    setupToken(`\\nYour OAuth token (valid for 1 year):\\n\\n${TOKEN}\\033[2BStore this token securely.\\n`)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      const sign = await agent.signIn("claudeai", { remote: true })
      await sign.complete!("good#state")
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      expect(sign.status().status).toBe("complete")
      expect(agent.env().CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN)
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  // A token shaped like a real one: sk-ant-oat01- and 100 more.
  const LONG = "sk-ant-oat01-" + "Ab3_xY9-kQ".repeat(10)
  /** Signs in with `good#state`, and waits for the end. */
  async function signInWith(printed: string, after?: string) {
    setupToken(printed, after)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      const sign = await agent.signIn("claudeai", { remote: true })
      await sign.complete!("good#state")
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      return { status: sign.status(), token: agent.env().CLAUDE_CODE_OAUTH_TOKEN, sign }
    } finally {
      ClaudeAgent.keychain = keychain
    }
  }

  test("a token Claude Code draws over its last screen, jumping over the cells that didn't change, is kept whole", async () => {
    // Its screen redraws only what changed: where the line before had the same characters (the
    // pasted code, here), it jumps over them, with ESC[nG and ESC[nC.
    const before = "x".repeat(40) + LONG.slice(40, 44) + "x".repeat(26) + LONG.slice(70, 73) + "xxxx"
    const redrawn = `${LONG.slice(0, 40)}\\033[45G${LONG.slice(44, 70)}\\033[3C${LONG.slice(73)}\\033[K`
    const { status, token } = await signInWith(`\\n${before}\\r${redrawn}\\n\\nStore this token securely.\\n`)
    expect(status.status).toBe("complete")
    expect(token).toBe(LONG)
  })

  test("a token among a terminal's codes (colors, a link, keyboard modes, a character set) is kept whole", async () => {
    const link = (text: string) => `\\033]8;;https://claude.ai\\033\\\\${text}\\033]8;;\\033\\\\`
    const { status, token } = await signInWith(`\\033[1m\\033[38;5;174m${link(LONG)}\\033[39m\\033[22m\\033(B\\n\\nStore this token securely.\\n\\033[<u\\033(B`)
    expect(status.status).toBe("complete")
    expect(token).toBe(LONG)
  })

  test("a token cut short is never kept: its line still being drawn when it stops", async () => {
    const ended = await signInWith(LONG.slice(0, 90), "exit 1")
    expect(ended.token).toBeUndefined()
    expect(ended.status.status).toBe("failed")
  })

  test("a failed sign-in's words have no terminal codes, and nothing of a token", async () => {
    // It stops before any code is pasted: its last words are what's said.
    writeFileSync(join(bin, "claude"), `#!/bin/sh
case "$1" in
  setup-token)
    printf 'https://claude.com/cai/oauth/authorize?code=true\\n\\nPaste code here if prompted > '
    printf '\\r\\033[2K${LONG.slice(0, 70)}\\n${LONG.slice(70)}\\n\\n\\033[31mOAuth error: Request failed\\033[39m\\n\\033[<u\\033(B'
    exit 1 ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}' ;;
esac
`)
    chmodSync(join(bin, "claude"), 0o755)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      const sign = await agent.signIn("claudeai", { remote: true })
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      const status = sign.status()
      expect(status.status).toBe("failed")
      const message = (status as { message: string }).message
      expect(message).toContain("OAuth error: Request failed")
      expect(message).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]|\[<u|\(B/)
      expect(message).not.toContain(LONG.slice(20, 40))
      expect(message).not.toContain(LONG.slice(75, 95))
      expect(agent.env().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  test("a code Claude turns away ends the sign-in, to start again with a new page", async () => {
    setupToken(`${TOKEN}\\n`)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      const sign = await agent.signIn("claudeai", { remote: true })
      await expect(sign.complete!("half-a-code")).rejects.toThrow("Start again for a new one")
      expect(sign.status()).toEqual({ status: "failed", message: "Claude didn't take that code. Start again for a new one." })
      expect(agent.env().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  test("an Anthropic Console sign-in is kept in Kuvo Code's own folder: yours in Terminal is never written or signed out", async () => {
    const yours = join(root, "claude-yours")
    writeFileSync(join(bin, "claude"), `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-${yours}}"
case "$1 $2" in
  "auth login") mkdir -p "$dir"; echo "$3" > "$dir/signed-in" ;;
  "auth logout") rm -f "$dir/signed-in" ;;
  "auth status")
    [ -f "$dir/signed-in" ] || { echo '{"loggedIn":false,"authMethod":"none"}'; exit 1; }
    echo '{"loggedIn":true,"authMethod":"console","email":"ops@example.com"}' ;;
esac
`)
    chmodSync(join(bin, "claude"), 0o755)
    mkdirSync(yours, { recursive: true })
    writeFileSync(join(yours, "signed-in"), "--claudeai")
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      const box = bridge([agent])
      // Yours doesn't count: Kuvo Code's Claude Code would renew it.
      expect((await box.account(agent)).connections).toEqual([])

      const sign = await agent.signIn("console", {})
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      expect(sign.status().status).toBe("complete")
      expect(readFileSync(join(yours, "signed-in"), "utf8").trim()).toBe("--claudeai")
      expect((await box.account(agent)).connections[0]?.label).toBe("ops@example.com")
      expect(agent.env().CLAUDE_CONFIG_DIR).toBe(agent.consoleHome)
      expect(agent.consoleHome.startsWith(agent.context.home + "/")).toBe(true)

      await agent.signOut!()
      expect((await box.account(agent)).connections).toEqual([])
      expect(readFileSync(join(yours, "signed-in"), "utf8").trim()).toBe("--claudeai")
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  /** A Claude Code that keeps a sign-in per folder (yours by default), as `auth login` says. */
  function consoleClaude(yours: string) {
    writeFileSync(join(bin, "claude"), `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-${yours}}"
case "$1 $2" in
  "auth login") mkdir -p "$dir"; echo "$3" > "$dir/signed-in" ;;
  "auth logout") rm -f "$dir/signed-in" ;;
  "auth status")
    [ -f "$dir/signed-in" ] || { echo '{"loggedIn":false,"authMethod":"none"}'; exit 1; }
    grep -q console "$dir/signed-in" && echo '{"loggedIn":true,"authMethod":"console","email":"ops@example.com"}' || echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}' ;;
esac
`)
    chmodSync(join(bin, "claude"), 0o755)
    mkdirSync(yours, { recursive: true })
    writeFileSync(join(yours, "signed-in"), "--claudeai")
  }

  function ownToken(agent: ClaudeAgent) {
    mkdirSync(dirname(agent.tokenFile), { recursive: true })
    writeFileSync(agent.tokenFile, JSON.stringify({ token: TOKEN, made: Date.now() }))
  }

  test("a Console sign-in while Kuvo Code has its own plan sign-in takes its place, and never writes yours", async () => {
    const yours = join(root, "claude-yours-switch")
    consoleClaude(yours)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      ownToken(agent)
      const sign = await agent.signIn("console", {})
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      expect(sign.status().status).toBe("complete")
      expect(readFileSync(join(yours, "signed-in"), "utf8").trim()).toBe("--claudeai")
      expect(agent.env().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect((await bridge([agent]).account(agent)).connections[0]?.label).toBe("ops@example.com")
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  test("Sign Out after moving from a Console sign-in to a Claude plan signs out of both", async () => {
    const yours = join(root, "claude-yours-out")
    consoleClaude(yours)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      const sign = await agent.signIn("console", {})
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      ownToken(agent)
      await agent.signOut!()
      expect((await bridge([agent]).account(agent)).connections).toEqual([])
      expect(readFileSync(join(yours, "signed-in"), "utf8").trim()).toBe("--claudeai")
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  test("a Sign Out whose Console sign-out fails still leaves Kuvo Code's own plan sign-in signed out", async () => {
    writeFileSync(join(bin, "claude"), `#!/bin/sh
case "$1 $2" in
  "auth logout") echo "The Keychain is locked." >&2; exit 1 ;;
  "auth status")
    [ -n "$CLAUDE_CONFIG_DIR" ] && echo '{"loggedIn":true,"authMethod":"console","email":"ops@example.com"}' || echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}' ;;
esac
`)
    chmodSync(join(bin, "claude"), 0o755)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      ownToken(agent)
      expect((await agent.account()).label).toBe("ada@example.com")
      await expect(agent.signOut!()).rejects.toThrow("The Keychain is locked.")
      // Its own plan sign-in is gone, and said so at once (a Console one is still there).
      expect((await agent.account()).label).toBe("ops@example.com")
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  test("an added account an earlier version signed in to a Claude plan in its folder asks to sign in again", async () => {
    consoleClaude(join(root, "claude-yours-added"))
    const home = join(root, "claude-added-old")
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "signed-in"), "--claudeai")
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context(), { id: "old", home })
      expect((await bridge([agent]).account(agent)).connections).toEqual([])
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  test("a code Claude turns away only after checking it still ends the sign-in", async () => {
    const go = join(root, "refuse-now")
    writeFileSync(join(bin, "claude"), `#!/bin/sh
printf 'https://claude.com/cai/oauth/authorize?code=true\\n\\nPaste code here if prompted > '
read code
while [ ! -f '${go}' ]; do sleep 0.05; done
printf "OAuth error: That code wasn't accepted. Press Enter to retry.\\n"
read again
`)
    chmodSync(join(bin, "claude"), 0o755)
    ClaudeAgent.keychain = true
    try {
      const agent = new ClaudeAgent(context())
      const sign = await agent.signIn("claudeai", { remote: true })
      await sign.complete!("a-whole-code#state")
      expect(sign.status().status).toBe("pending")
      writeFileSync(go, "")
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      expect(sign.status()).toEqual({ status: "failed", message: "Claude didn't take that code. Start again for a new one." })
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  test("an added account is never named after your own sign-in", async () => {
    setupToken(`${TOKEN}\\n`)
    ClaudeAgent.keychain = true
    try {
      const home = join(root, "claude-added")
      const agent = new ClaudeAgent(context(), { id: "work", home })
      const sign = await agent.signIn("claudeai", { remote: true })
      await sign.complete!("good#state")
      for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 50) await Bun.sleep(50)
      expect((await bridge([agent]).account(agent)).connections[0]?.label).toBe("Claude plan")
    } finally {
      ClaudeAgent.keychain = keychain
    }
  })

  test("a token the box was started with never reaches Claude Code", async () => {
    const said = join(root, "claude-inherited")
    writeFileSync(join(bin, "claude"), `#!/bin/sh
echo "\${CLAUDE_CODE_OAUTH_TOKEN:-none}" >> '${said}'
echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}'
`)
    chmodSync(join(bin, "claude"), 0o755)
    const before = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-yours"
    try {
      for (const mac of [false, true]) {
        ClaudeAgent.keychain = mac
        await new ClaudeAgent(context()).account(true)
      }
      expect(readFileSync(said, "utf8")).not.toContain("sk-ant")
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = before
      ClaudeAgent.keychain = keychain
    }
  })
})

test("the picker's models leave out those an agent keeps from its own; the box asks for them too, marked, to say they still run", async () => {
  const listed = (hidden: boolean) => [
    { id: "gpt-5.5", providerID: "codex-cli" },
    ...(hidden ? [{ id: "gpt-5.1-codex-mini", providerID: "codex-cli", hidden: true }] : []),
  ]
  const agent = { providerID: "codex-cli", account: async () => ({ installed: true, signedIn: true }), models: async (options?: { hidden?: boolean }) => listed(options?.hidden === true) } as unknown as Agent
  const answer = handler({ roster: { all: () => [agent], find: () => agent }, password: "pw" } as any)
  const ask = async (route: string) => ((await (await answer(new Request(`http://box/api/${route}`, { headers: { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") } }))).json()) as any).data
  expect((await ask("model")).map((model: any) => model.id)).toEqual(["gpt-5.5"])
  expect(await ask("model?hidden=1")).toEqual(listed(true))
})

test("an account says whether its list is every model it runs: not while its agent can't say so (Claude Code's usual ones, a Codex that lists none it hides)", async () => {
  const of = (listsEveryModel?: () => boolean) =>
    ({ providerID: "codex-cli", id: "codex", name: "Codex", instance: { id: "default" }, methods: () => [], account: async () => ({ installed: true, signedIn: true }), models: async () => [], ...(listsEveryModel ? { listsEveryModel } : {}) }) as unknown as Agent
  const metadata = async (agent: Agent) => {
    const answer = handler({ roster: { all: () => [agent], find: () => agent }, password: "pw" } as any)
    const response = await answer(new Request("http://box/api/integration/codex-cli", { headers: { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") } }))
    return ((await response.json()) as any).data.metadata
  }
  expect((await metadata(of(() => false))).modelsComplete).toBe(false)
  expect((await metadata(of(() => true))).modelsComplete).toBe(true)
  expect((await metadata(of())).modelsComplete).toBe(true)
})
