import "./safety"
import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { forgetKeys, makeVault, pausedFor, VAULT_FOLDER } from "../src/link/vault/store"
import { setVaultTell, tripwire } from "../src/link/vault/use"

// A bot's seat in a group chat browses too, and a page can steer it to sign in where its item
// isn't for. The fill is refused and the bot paused, as anywhere; the notice your phones get opens
// the group chat it happened in, as the seat's asks do, not the seat (a conversation nobody opens).

test("a group chat's seat steered to another site pauses its bot, and the notice opens the chat", () => {
  // A vault of its own, made here: none from another test in this run's home (test/preload.ts).
  rmSync(VAULT_FOLDER, { recursive: true, force: true })
  forgetKeys()
  const told: any[] = []
  try {
    makeVault()
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
    setVaultTell(() => false)
    forgetKeys()
    rmSync(VAULT_FOLDER, { recursive: true, force: true })
  }
})
