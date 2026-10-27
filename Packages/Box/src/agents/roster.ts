// The agents the bridge runs: one for each account you have with each coding agent (see
// accounts.ts), made as accounts are added and stopped as they're removed.

import { Accounts, providerID, type AccountRecord } from "./accounts"
import type { Agent, AgentContext } from "./agent"
import { AntigravityAgent } from "./agents/antigravity"
import { ClaudeAgent } from "./agents/claude"
import { CodexAgent } from "./agents/codex"
import { CursorAgent } from "./agents/cursor"
import { GrokAgent } from "./agents/grok"

export class Roster {
  private agents = new Map<string, Agent>()

  constructor(
    readonly accounts: Accounts,
    private readonly context: AgentContext,
  ) {
    this.sync()
  }

  /** Every account's agent, each agent's own sign-in first, then the accounts you added. */
  all(): Agent[] {
    return this.accounts.all().flatMap((record) => this.agents.get(providerID(record.kind, record.id)) ?? [])
  }

  find(provider: string | undefined): Agent | undefined {
    return provider ? this.agents.get(provider) : undefined
  }

  /** Makes the agents of new accounts, renames, and stops those of removed ones. */
  sync() {
    const wanted = new Set<string>()
    for (const record of this.accounts.all()) {
      const id = providerID(record.kind, record.id)
      wanted.add(id)
      const existing = this.agents.get(id)
      if (existing) {
        existing.instance.label = record.label
        continue
      }
      this.agents.set(id, this.make(record))
    }
    for (const [id, agent] of this.agents) {
      if (wanted.has(id)) continue
      agent.shutdown?.()
      this.agents.delete(id)
    }
  }

  private make(record: AccountRecord): Agent {
    const account = { id: record.id, label: record.label, home: this.accounts.home(record) }
    switch (record.kind) {
      case "claude":
        return new ClaudeAgent(this.context, account)
      case "codex":
        return new CodexAgent(this.context, account)
      case "cursor":
        return new CursorAgent(this.context, account)
      case "grok":
        return new GrokAgent(this.context, account)
      case "antigravity":
        return new AntigravityAgent(this.context, account)
    }
  }
}
