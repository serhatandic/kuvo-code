// Updating the coding agents' programs, as every client sees it (`kuvo/agents/api/integration`'s
// `metadata.programUpdate` and `metadata.updateAll`): the box picks what Update All updates, keeps
// each program's update under way, done or failed with why, and answers as an update starts, so a
// second client (the phone while the Mac updates) sees it under way, and so does one opened again
// after it quit. The agents are stand-ins whose update finishes when the test says.

import "../safety"
import { describe, expect, test } from "bun:test"
import type { Agent } from "../../src/agents/agent"
import { subscribe } from "../../src/agents/events"
import type { Maintenance, UpdateResult } from "../../src/agents/maintenance"
import { handler } from "../../src/agents/server"

/** A stand-in agent's program: its version, the newest, whether its installer can update it, and its update, finished when the test says. */
class Program {
  installed: string
  updates = 0
  told = 0
  private finish?: (result: UpdateResult) => void

  constructor(
    readonly kind: string,
    installed: string,
    readonly latest: string,
    readonly updatable = true,
  ) {
    this.installed = installed
  }

  maintenance(): Maintenance {
    return { installed: this.installed, latest: this.latest, ...(this.updatable ? { command: [this.kind, "update"], shown: `${this.kind} update` } : {}) }
  }

  /** An account with it: its own sign-in (`default`) or one you added. */
  account(account = "default"): Agent {
    const program = this
    return {
      id: this.kind,
      providerID: account === "default" ? `${this.kind}-cli` : `${this.kind}-cli@${account}`,
      name: this.kind,
      instance: { id: account },
      methods: () => [],
      account: async () => ({ installed: true, signedIn: true, label: "me@example.com" }),
      models: async () => [],
      maintenance: async () => program.maintenance(),
      update: () => {
        program.updates++
        return new Promise<UpdateResult>((resolve) => (program.finish = resolve))
      },
      programUpdated: () => program.told++,
    } as unknown as Agent
  }

  /** Its update ends: updated to `version`, left as it was, or failing with `message`. */
  end(result: UpdateResult) {
    if (result.version) this.installed = result.version
    this.finish!(result)
  }
}

/** The bridge's routes, for these agents alone; each ask is as a client of its own makes it. */
function bridge(agents: Agent[]) {
  const answer = handler({ roster: { all: () => agents, find: (id: string) => agents.find((agent) => agent.providerID === id) }, password: "pw" } as any)
  const ask = async (route: string, method = "GET", body?: unknown) => {
    const headers: Record<string, string> = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") }
    if (body !== undefined) headers["content-type"] = "application/json"
    const response = await answer(new Request(`http://box/api/${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
    return { status: response.status, value: (await response.json()) as any }
  }
  return {
    ask,
    /** Each account's metadata, by provider, as Settings › Accounts reads it. */
    accounts: async (): Promise<Record<string, any>> => Object.fromEntries((await ask("integration")).value.data.map((each: any) => [each.id, each.metadata])),
  }
}

/** The bridge's next word that `provider` changed: an update has ended once every account with it is told. */
function told(provider: string): Promise<void> {
  return new Promise((resolve) => {
    const stop = subscribe((event) => {
      if (event.type !== "integration.updated" || event.data.integrationID !== provider) return
      stop()
      resolve()
    })
  })
}

describe("updating the agents' programs", () => {
  test("Update All: the box picks each program behind that it can update, once, answers as they start, and a second client sees them under way, then how each went", async () => {
    // Claude, behind, with an account you added (the same program); Grok behind, but yours to
    // update; Codex up to date.
    const claude = new Program("claude-all", "1.0.0", "2.0.0")
    const grok = new Program("grok-all", "1.0.0", "1.1.0", false)
    const codex = new Program("codex-all", "3.0.0", "3.0.0")
    const box = bridge([claude.account(), claude.account("work"), grok.account(), codex.account()])

    const before = await box.accounts()
    expect([before["claude-all-cli"].updateAll, before["claude-all-cli@work"].updateAll]).toEqual([true, true])
    expect(before["grok-all-cli"].updateAll).toBe(false)
    expect(before["codex-all-cli"].updateAll).toBe(false)
    expect(before["claude-all-cli"].programUpdate).toBeUndefined()

    // The Mac's Update All: answered while the update still runs.
    expect((await box.ask("kuvo/updates", "POST", {})).value.data).toEqual({ updating: ["claude-all"] })
    // The phone, meanwhile: under way on every account with it, and not offered again.
    const during = await box.accounts()
    expect(during["claude-all-cli"].programUpdate.state).toBe("updating")
    expect(during["claude-all-cli@work"].programUpdate.state).toBe("updating")
    expect(during["claude-all-cli"].updateAll).toBe(false)
    expect((await box.ask("kuvo/updates", "POST", {})).value.data).toEqual({ updating: [] })
    expect(claude.updates).toBe(1)
    expect(grok.updates + codex.updates).toBe(0)

    const ended = told("claude-all-cli@work")
    claude.end({ updated: true, version: "2.0.0" })
    await ended
    const after = await box.accounts()
    expect(after["claude-all-cli"].programUpdate).toMatchObject({ state: "updated", version: "2.0.0" })
    expect(after["claude-all-cli@work"].programUpdate).toMatchObject({ state: "updated", version: "2.0.0" })
    expect([after["claude-all-cli"].version, after["claude-all-cli"].outdated, after["claude-all-cli"].updateAll]).toEqual(["2.0.0", false, false])
    expect(claude.told).toBe(2)
  })

  test("one that fails says why to every client, and is offered again until the version moves on", async () => {
    const grok = new Program("grok-stuck", "1.0.0", "1.1.0")
    const box = bridge([grok.account()])
    await box.accounts()

    expect((await box.ask("kuvo/updates/grok-stuck-cli", "POST")).value.data).toEqual({ updating: ["grok-stuck"] })
    const ended = told("grok-stuck-cli")
    grok.end({ updated: false, version: "1.0.0", message: "grok-stuck is still 1.0.0 after “grok update”." })
    await ended

    const failed = (await box.accounts())["grok-stuck-cli"]
    expect(failed.programUpdate).toMatchObject({ state: "failed", message: "grok-stuck is still 1.0.0 after “grok update”." })
    expect(failed.updateAll).toBe(true)
    expect(grok.told).toBe(0)

    // Updated in a terminal since: no longer news.
    grok.installed = "1.1.0"
    expect((await box.accounts())["grok-stuck-cli"].programUpdate).toBeUndefined()
  })

  test("an update a client asked for goes on after it stops waiting (the app quit), and the client opened again sees it, then that it was already the newest", async () => {
    const codex = new Program("codex-quit", "0.9.0", "1.0.0")
    const box = bridge([codex.account()])
    await box.accounts()

    // An older client's update, answered once it's done: the client quits while it waits.
    const waited = box.ask("integration/codex-quit-cli/update", "POST")
    // The same client opened again, or the phone.
    expect((await box.accounts())["codex-quit-cli"].programUpdate.state).toBe("updating")
    // Asked again meanwhile: the one under way.
    expect((await box.ask("kuvo/updates/codex-quit-cli", "POST")).value.data).toEqual({ updating: ["codex-quit"] })
    expect(codex.updates).toBe(1)

    const ended = told("codex-quit-cli")
    codex.end({ updated: false, version: "1.0.0" })
    await ended
    expect((await waited).value.data).toEqual({ updated: false, version: "1.0.0" })
    expect((await box.accounts())["codex-quit-cli"].programUpdate).toMatchObject({ state: "current", version: "1.0.0" })
  })

  test("a program its installer can't update isn't updated, alone or in Update All", async () => {
    const manual = new Program("grok-manual", "1.0.0", "1.1.0", false)
    const box = bridge([manual.account()])
    expect((await box.ask("kuvo/updates", "POST", {})).value.data).toEqual({ updating: [] })
    // Its `update` is the agent's; the box can't tell its version, so it isn't asked to.
    const unread = { ...manual.account(), providerID: "grok-unread-cli", id: "grok-unread", maintenance: undefined } as unknown as Agent
    expect((await bridge([unread]).ask("kuvo/updates/grok-unread-cli", "POST")).status).toBe(400)
    expect(manual.updates).toBe(0)
  })
})
