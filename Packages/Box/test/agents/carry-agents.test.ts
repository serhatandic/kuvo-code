// Which coding agents a move carries the own conversation of, as the link says it in Move's
// question (`shared/carry.ts`): the same as the agents that can hand theirs over and take one in.
import "../safety"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Agent } from "../../src/agents/agent"
import { AntigravityAgent } from "../../src/agents/agents/antigravity"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { CodexAgent, rolloutOf } from "../../src/agents/agents/codex"
import { CursorAgent } from "../../src/agents/agents/cursor"
import { GrokAgent } from "../../src/agents/agents/grok"
import { AGENT_NAMES, CARRIED_AGENTS } from "../../src/shared/carry"

describe("what Move's question says of a coding agent's own conversation", () => {
  test("it goes for each agent that carries one, and starts over for each that doesn't, named as the bridge names it", () => {
    const home = realpathSync(mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-carry-agents-")))
    const context = { home, temporary: home, deps: {} as any }
    try {
      const all: Agent[] = [new ClaudeAgent(context), new CodexAgent(context), new CursorAgent(context), new GrokAgent(context), new AntigravityAgent(context)]
      for (const agent of all) {
        const carries = Boolean(agent.conversationFiles && agent.conversationPlace && agent.conversationRoots)
        expect([agent.providerID, CARRIED_AGENTS.has(agent.providerID)]).toEqual([agent.providerID, carries])
        expect(AGENT_NAMES[agent.providerID]).toBe(agent.name)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("a Codex thread's own conversation, found for a move", () => {
  // A UUIDv7 made at `ms`, as Codex names a thread.
  const thread = (ms: number, tail: string) => {
    const hex = ms.toString(16).padStart(12, "0")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, "0")}`
  }
  const dayOf = (ms: number) => {
    const day = new Date(ms)
    return join(String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"))
  }
  const write = (home: string, folder: string, id: string) => {
    mkdirSync(join(home, folder), { recursive: true })
    const file = join(home, folder, `rollout-2026-01-01T00-00-00-${id}.jsonl`)
    writeFileSync(file, "{}\n")
    return file
  }

  test("under the day it was made, another day, or archived, and none when it's gone", () => {
    const home = realpathSync(mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-codex-rollout-")))
    try {
      const made = Date.UTC(2026, 10, 7, 12)
      const today = thread(made, "aaa111")
      const other = thread(made, "bbb222")
      const old = thread(made, "ccc333")
      const kept = thread(made, "ddd444")
      // Another thread's file the same day, and one with a name a v7 id doesn't have.
      const atToday = write(home, join("sessions", dayOf(made)), today)
      write(home, join("sessions", dayOf(made)), other)
      const atAnotherDay = write(home, join("sessions", "2025", "03", "09"), old)
      const archived = write(home, "archived_sessions", kept)
      const plain = "0198a3c2-1111-4abc-8def-000000000001"
      const atPlain = write(home, join("sessions", "2024", "12", "31"), plain)

      expect(rolloutOf(home, today)).toBe(atToday)
      expect(rolloutOf(home, old)).toBe(atAnotherDay)
      expect(rolloutOf(home, kept)).toBe(archived)
      expect(rolloutOf(home, plain)).toBe(atPlain)
      expect(rolloutOf(home, thread(made, "eee555"))).toBeUndefined()
      expect(rolloutOf(join(home, "nothing"), today)).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
