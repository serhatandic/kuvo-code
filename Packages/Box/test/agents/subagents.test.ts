// Your subagents as each coding agent takes them (subagents.ts), where a turn's tests don't reach:
// which tools a subagent's rules take away whole, a model only its own agent runs, names that
// can't be file or role names as they are, and the engine's own subagents (shared/subagents.ts).

import "../safety"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { baseProvider } from "../../src/agents/accounts"
import { EngineLink } from "../../src/agents/engine"
import { antigravityTier, claudeDisallowed, codexSubagents, nativeModel, setSubagentSource, type Subagent } from "../../src/agents/subagents"
import { AGENT_PROVIDERS, subagentLayer } from "../../src/shared/subagents"

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const agent = (name: string, permissions: Subagent["permissions"] = [], model?: Subagent["model"]): Subagent => ({ name, description: `${name}'s words`, prompt: `You are ${name}.`, permissions, model })

describe("Your subagents, for each coding agent", () => {
  test("only the tools a subagent may never use are taken away; one it may use for some things stays, to be asked about", () => {
    expect(claudeDisallowed([{ action: "*", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "deny" }])).toEqual(["Edit", "MultiEdit", "Write", "NotebookEdit"])
    expect(claudeDisallowed([{ action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: "docs/*", effect: "allow" }])).toEqual([])
    expect(claudeDisallowed([{ action: "shell", resource: "*", effect: "ask" }])).toEqual([])
    expect(claudeDisallowed([{ action: "*", resource: "*", effect: "deny" }])).toContain("Bash")
  })

  test("a model goes to the agent that runs it: any of its accounts, or its maker's own; Antigravity's as Flash or Pro", () => {
    expect(nativeModel("claude", { providerID: "claude-code@5348f21e", id: "haiku" })).toBe("haiku")
    expect(nativeModel("claude", { providerID: "anthropic", id: "claude-sonnet-4-5" })).toBe("claude-sonnet-4-5")
    expect(nativeModel("claude", { providerID: "github-copilot", id: "claude-sonnet-4.5" })).toBeUndefined()
    expect(nativeModel("claude", { providerID: "claude-code", id: "default" })).toBeUndefined()
    expect(nativeModel("codex", { providerID: "openai", id: "gpt-5" })).toBe("gpt-5")
    expect(nativeModel("cursor", { providerID: "openai", id: "gpt-5" })).toBeUndefined()
    expect(antigravityTier({ providerID: "antigravity", id: "gemini-3-pro" })).toBe("pro")
    expect(antigravityTier({ providerID: "antigravity", id: "gemini-3-flash" })).toBe("flash")
    expect(antigravityTier({ providerID: "openai", id: "gpt-5" })).toBeUndefined()
  })

  test("Codex: names made into roles it takes, one each, and one that may run no commands has no shell", () => {
    const home = mkdtempSync(join(tmpdir(), "kuvo-subagents-"))
    folders.push(home)
    setSubagentSource(new EngineLink(), home, undefined)
    const { config } = codexSubagents({ agents: [agent("Bug Hunter", [{ action: "shell", resource: "*", effect: "deny" }]), agent("bug-hunter"), agent("enabled")] })
    expect(Object.keys(config).filter((key) => key.endsWith(".description")).sort()).toEqual(["agents.bug_hunter.description", "agents.bug_hunter_2.description", "agents.enabled_agent.description"])
    expect(readFileSync(config["agents.bug_hunter.config_file"] as string, "utf8")).toBe('developer_instructions = "You are Bug Hunter."\n\n[features]\nshell_tool = false\n')
    expect(readFileSync(config["agents.bug_hunter_2.config_file"] as string, "utf8")).not.toContain("shell_tool")
  })
})

describe("The engine's own subagents", () => {
  test("the coding agents' providers are those the bridge has", () => {
    expect([...AGENT_PROVIDERS].sort()).toEqual(Object.values(baseProvider).sort())
  })

  test("get the model unless they have their own or are turned off; none for one the engine can't run, or a model that isn't one", () => {
    expect(subagentLayer({ subagent_model: "openai/gpt-5", agents: { explore: { model: "x/y" }, general: { disabled: true } } })).toEqual({})
    expect(subagentLayer({ subagent_model: "codex-cli@work/gpt-5" })).toEqual({})
    expect(subagentLayer({ subagent_model: "gpt-5" })).toEqual({})
    expect(subagentLayer({ subagent_model: "openai/gpt-5", agents: { plan: { mode: "subagent" } } })).toEqual({ agents: { general: { model: "openai/gpt-5" }, explore: { model: "openai/gpt-5" } } })
  })
})
