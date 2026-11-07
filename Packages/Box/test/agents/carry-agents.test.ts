// Which coding agents a move carries the own conversation of, as the link says it in Move's
// question (`shared/carry.ts`): the same as the agents that can hand theirs over and take one in.
import "../safety"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AntigravityAgent } from "../../src/agents/agents/antigravity"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { CodexAgent } from "../../src/agents/agents/codex"
import { CursorAgent } from "../../src/agents/agents/cursor"
import { GrokAgent } from "../../src/agents/agents/grok"
import { AGENT_NAMES, CARRIED_AGENTS } from "../../src/shared/carry"

describe("what Move's question says of a coding agent's own conversation", () => {
  test("it goes for each agent that carries one, and starts over for each that doesn't, named as the bridge names it", () => {
    const home = realpathSync(mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-carry-agents-")))
    const context = { home, temporary: home, deps: {} as any }
    try {
      for (const agent of [new ClaudeAgent(context), new CodexAgent(context), new CursorAgent(context), new GrokAgent(context), new AntigravityAgent(context)]) {
        const carries = Boolean(agent.conversationFiles && agent.conversationPlace && agent.conversationRoots)
        expect([agent.providerID, CARRIED_AGENTS.has(agent.providerID)]).toEqual([agent.providerID, carries])
        expect(AGENT_NAMES[agent.providerID]).toBe(agent.name)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
