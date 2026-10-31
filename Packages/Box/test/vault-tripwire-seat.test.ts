import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A bot's seat in a group chat browses too, and a page can steer it to sign in where its item
// isn't for. The fill is refused and the bot paused, as anywhere; the notice your phones get opens
// the group chat it happened in, as the seat's asks do, not the seat (a conversation nobody opens).

test("a group chat's seat steered to another site pauses its bot, and the notice opens the chat", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuvo-tripwire-seat-"))
  const before = process.env.KUVO_HOME
  process.env.KUVO_HOME = home
  try {
    const { makeVault, pausedFor } = await import("../src/link/vault/store")
    const { setVaultTell, tripwire } = await import("../src/link/vault/use")
    makeVault()
    const told: any[] = []
    setVaultTell(notice => { told.push(notice); return true })
    const item = { id: "itm_gh", name: "GitHub", kind: "login", sites: ["github.com"], fields: [] } as any
    const message = tripwire(item, { session: "ses_seat", root: "ses_seat", bot: "bot_ship", botName: "Ship", seat: true, group: "grp_release" }, "evil.example")
    expect(message).toContain("isn't one of its sites")
    expect(pausedFor("bot_ship")).toContain("evil.example")
    expect(told).toHaveLength(1)
    expect(told[0].title).toBe("Ship paused")
    expect(told[0].data).toEqual({ group: "grp_release" })
    expect(told[0].thread).toBe("grp_release")
  } finally {
    if (before === undefined) delete process.env.KUVO_HOME
    else process.env.KUVO_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
})
