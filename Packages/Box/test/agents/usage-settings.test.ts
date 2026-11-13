// The usage panel's settings on the boxes (PROTOCOL.md, "Usage settings"): read and changed through
// a box's routes, kept through a restart, the same on your own computers (newest change wins), a
// Mac's earlier settings brought in once without going over newer ones, and nothing shared with a
// box a peer vouches for. Stand-in boxes carry each other's mail through their real peer routes, as
// their links do; no real setting, sign-in or provider is read.

import "../safety"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { subscribe } from "../../src/agents/events"
import type { Clock } from "../../src/agents/groups/peer"
import { LinkDirectory, PeerPost, peerRoutes, type PeerParts } from "../../src/agents/groups/post"
import { PricingStore } from "../../src/agents/usage/pricing"
import { SettingsPeers, type SettingsMail } from "../../src/agents/usage/settings-peers"
import { Usage, usageRoutes, UsageSettings } from "../../src/agents/usage/usage"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-usage-settings-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const MINUTE = 60_000
const still: Clock = { setTimeout: () => undefined, clearTimeout: () => {} }

/** Carries each box's post to the box it's for, through its peer routes, as the link does. */
class Relay {
  boxes = new Map<string, Box>()
  off = new Set<string>()
  sent: { from: string; to: string; mail: SettingsMail }[] = []
  posted = 0
  done = 0
  carry(from: string, to: string, mail: any) {
    this.sent.push({ from, to, mail })
    if (this.off.has(from) || this.off.has(to)) {
      this.done++
      return
    }
    queueMicrotask(async () => {
      const target = this.boxes.get(to)
      if (target) await peerRoutes(target.parts, "POST", ["mail"], async () => ({ from, mail: structuredClone(mail) }))
      this.done++
    })
  }
  async settled() {
    while (this.done < this.posted) await new Promise((resolve) => setImmediate(resolve))
  }
}

class Post extends PeerPost {
  constructor(private readonly counted: () => void) {
    super(undefined, still)
  }
  override send(...given: Parameters<PeerPost["send"]>) {
    this.counted()
    super.send(...given)
  }
}

/** A box's bridge as far as its usage settings go: its real settings, peers, post, directory and routes. */
class Box {
  post: PeerPost
  directory: LinkDirectory
  settings: UsageSettings
  usage: Usage
  peers: SettingsPeers
  parts: PeerParts
  private following = new AbortController()

  constructor(
    readonly key: string,
    readonly name: string,
    relay: Relay,
    readonly home: string,
    now: () => number,
  ) {
    this.post = new Post(() => relay.posted++)
    this.directory = new LinkDirectory(this.post, still)
    this.settings = new UsageSettings(join(home, "usage", "settings.json"), now)
    this.usage = new Usage(() => [], new PricingStore(undefined, null), () => undefined, undefined, now)
    this.usage.settings = this.settings
    this.peers = new SettingsPeers(this.settings, this.post, this.directory, now)
    this.parts = { post: this.post, directory: this.directory, settings: this.peers }
    relay.boxes.set(key, this)
    void this.link(relay)
  }

  private async link(relay: Relay) {
    const reader = this.post.follow(this.following.signal).body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const read = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (read.done) return
      buffer += decoder.decode(read.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line) {
          const given = JSON.parse(line)
          relay.carry(this.key, given.to, given.mail)
        }
      }
    }
  }

  /** The link says who your computers are (`others`) and which boxes only a peer knows (`also`). */
  async meet(others: Box[], also: Box[] = []) {
    await peerRoutes(this.parts, "PUT", [], async () => ({ self: { key: this.key, name: this.name }, boxes: others.map((box) => ({ key: box.key, name: box.name, seats: true })), also: also.map((box) => ({ key: box.key, name: box.name })), bots: [] }))
  }

  async route(method: string, rest: string[] = [], given?: unknown) {
    const response = await usageRoutes(this.usage, method, ["settings", ...rest], new URLSearchParams(), async () => given ?? {})
    return { status: response.status, body: (await response.json()) as any }
  }

  async read() {
    return (await this.route("GET")).body.data
  }

  stop() {
    this.following.abort()
  }
}

const layout = (placed: string[], pinned: string[] = []) => ({ placed, providerOrder: ["claude", "codex"], metricOrder: { claude: placed.filter((id) => id.startsWith("claude.")) }, pinned, expanded: [], expandOnEnable: [], seeded: placed })
const alerts = (underTenPercent: boolean) => ({ underTenPercent, healthyToClose: false, closeToRunningOut: false })

let at: number
const now = () => at
let relay: Relay
const boxes: Box[] = []
const make = (key: string, name: string, home = mkdtempSync(join(base, `${name}-`))) => {
  const box = new Box(key, name, relay, home, now)
  boxes.push(box)
  return box
}

beforeEach(() => {
  for (const box of boxes.splice(0)) box.stop()
  at = Date.parse("2026-11-13T12:00:00Z")
  relay = new Relay()
})

describe("on one box", () => {
  test("a client reads them, changes a part at a time, and is told; one that isn't what it should be is refused; they stay through a restart", async () => {
    const home = mkdtempSync(join(base, "mac-"))
    const mac = make("mac-key", "MacBook", home)
    // Nothing set yet: each part is the panel's own default.
    expect(await mac.read()).toEqual({ settings: {}, imported: false })

    const told: unknown[] = []
    const stop = subscribe((event) => event.type === "kuvo.usage.settings" && told.push(event.data))
    try {
      const changed = await mac.route("PUT", [], { layout: layout(["claude.session", "codex.weekly"], ["claude.session"]), totalSpend: { show: false, period: "today" } })
      expect(changed.status).toBe(200)
      expect(changed.body.data.settings).toEqual({ layout: layout(["claude.session", "codex.weekly"], ["claude.session"]), totalSpend: { show: false, period: "today" } })
      expect(told).toEqual([{ units: ["layout", "totalSpend"] }])
      // The same again: no change, nobody told.
      await mac.route("PUT", [], { totalSpend: { show: false, period: "today" } })
      expect(told.length).toBe(1)
    } finally {
      stop()
    }

    for (const wrong of [{ layout: { placed: "claude.session" } }, { notifications: { underTenPercent: "yes" } }, { colors: {} }, { codexFallback: "not-a-model" }, [1]]) {
      const refused = await mac.route("PUT", [], wrong)
      expect(refused.status).toBe(400)
      expect(typeof refused.body.message).toBe("string")
    }
    // (Nothing of a refused change was kept.)
    expect(Object.keys((await mac.read()).settings).sort()).toEqual(["layout", "totalSpend"])

    // Codex's fallback model: one of the models the box can price with, or none.
    const choice = mac.usage.codexChoices()[0]!
    expect((await mac.route("PUT", [], { codexFallback: choice })).body.data.settings.codexFallback).toBe(choice)
    expect(mac.usage.view("UTC").pricing.codex).toMatchObject({ fallback: choice, chosen: true })

    // A restart.
    mac.stop()
    const again = make("mac-key", "MacBook", home)
    expect((await again.read()).settings).toEqual({ layout: layout(["claude.session", "codex.weekly"], ["claude.session"]), totalSpend: { show: false, period: "today" }, codexFallback: choice })
    // A box from before reads Codex's fallback model where it always did.
    expect(JSON.parse(readFileSync(join(home, "usage", "settings.json"), "utf8")).codex).toEqual({ fallback: choice })
  })

  test("the Codex fallback model a box chose before it kept these counts as chosen, and gives way to a change", async () => {
    const home = mkdtempSync(join(base, "older-"))
    mkdirSync(join(home, "usage"), { recursive: true })
    writeFileSync(join(home, "usage", "settings.json"), JSON.stringify({ codex: { fallback: null } }))
    const box = make("box-key", "devbox", home)
    expect(box.usage.view("UTC").pricing.codex).toMatchObject({ fallback: null, chosen: true })
    // A Mac's earlier choice doesn't go over it.
    const choice = box.usage.codexChoices()[0]!
    expect((await box.route("POST", ["import"], { codexFallback: choice })).body.data.took).toEqual([])
    expect((await box.route("PUT", [], { codexFallback: choice })).body.data.settings.codexFallback).toBe(choice)
  })
})

describe("a Mac's settings from before", () => {
  test("come in once: the parts no box has set, never again, never over a part changed since; a fallback model the box can't price with is left out", async () => {
    const mac = make("mac-key", "MacBook")
    await mac.route("PUT", [], { notifications: alerts(true) })
    const choice = mac.usage.codexChoices()[0]!
    const first = await mac.route("POST", ["import"], { layout: layout(["claude.session"]), notifications: alerts(false), totalSpend: { show: true }, codexFallback: "not-a-model", nonsense: 1 })
    expect(first.status).toBe(200)
    expect(first.body.data.took).toEqual(["layout", "totalSpend"])
    expect(first.body.data.imported).toBe(true)
    // The notification set here since stays; the rest came in.
    expect(first.body.data.settings).toEqual({ notifications: alerts(true), layout: layout(["claude.session"]), totalSpend: { show: true } })

    // Once: a second import takes nothing, whatever it says.
    const second = await mac.route("POST", ["import"], { layout: layout(["codex.weekly"]), codexFallback: choice })
    expect(second.body.data.took).toEqual([])
    expect(second.body.data.settings.layout).toEqual(layout(["claude.session"]))
    expect(second.body.data.settings.codexFallback).toBeUndefined()
    // Any change goes over what came in.
    expect((await mac.route("PUT", [], { layout: layout(["codex.weekly"]) })).body.data.settings.layout).toEqual(layout(["codex.weekly"]))
  })

  test("two Macs' imports: the one made first stays on both, a later Mac's first-run defaults never go over it; a change made since goes over both", async () => {
    const air = make("air-key", "Air")
    const pro = make("pro-key", "Pro")
    // The Air brings in the panel you made on it; the Pro, set up later and not yet in touch, its defaults.
    await air.route("POST", ["import"], { layout: layout(["claude.session", "codex.weekly"], ["codex.weekly"]) })
    at += 3 * MINUTE
    await pro.route("POST", ["import"], { layout: layout(["claude.session"]) })
    await air.meet([pro])
    await pro.meet([air])
    await relay.settled()
    for (const box of [air, pro]) expect((await box.read()).settings.layout).toEqual(layout(["claude.session", "codex.weekly"], ["codex.weekly"]))
    at += MINUTE
    await pro.route("PUT", [], { layout: layout(["codex.weekly"]) })
    await relay.settled()
    for (const box of [air, pro]) expect((await box.read()).settings.layout).toEqual(layout(["codex.weekly"]))
  })
})

describe("across your own computers", () => {
  test("three boxes: a change on any reaches the others, the newest change wins on all, part by part; one with a clock behind still counts on from what it has seen", async () => {
    const mac = make("mac-key", "MacBook")
    const dev = make("dev-key", "devbox")
    const pi = make("pi-key", "raspberry")
    for (const box of [mac, dev, pi]) await box.meet([mac, dev, pi].filter((other) => other !== box))
    await relay.settled()

    await mac.route("PUT", [], { layout: layout(["claude.session"]), notifications: alerts(true) })
    await relay.settled()
    for (const box of [dev, pi]) expect((await box.read()).settings).toEqual({ layout: layout(["claude.session"]), notifications: alerts(true) })

    // A later change on the devbox, to one part: it wins everywhere, the other part as it was.
    at += MINUTE
    await dev.route("PUT", [], { notifications: alerts(false) })
    await relay.settled()
    for (const box of [mac, dev, pi]) expect((await box.read()).settings).toEqual({ layout: layout(["claude.session"]), notifications: alerts(false) })

    // The Pi's clock is an hour behind: its change is still newer than what it has seen.
    at -= 60 * MINUTE
    await pi.route("PUT", [], { layout: layout(["codex.weekly"]) })
    await relay.settled()
    for (const box of [mac, dev, pi]) expect((await box.read()).settings.layout).toEqual(layout(["codex.weekly"]))
    at += 60 * MINUTE

    // Two changes to one part at the same moment, each box not yet told the other's: one wins, the same on all.
    at += MINUTE
    relay.off.add("mac-key")
    await mac.route("PUT", [], { totalSpend: { show: true, period: "month" } })
    await dev.route("PUT", [], { totalSpend: { show: false } })
    relay.off.delete("mac-key")
    await relay.settled()
    // Every ten minutes each says what it holds; one that holds something else gets all of it, and is asked for its own.
    at += 10 * MINUTE
    for (const box of [mac, dev, pi]) box.peers.tell()
    await relay.settled()
    const held = await Promise.all([mac, dev, pi].map(async (box) => (await box.read()).settings.totalSpend))
    expect(new Set(held.map((each) => JSON.stringify(each))).size).toBe(1)
    // (At the same version, the box whose key sorts last.)
    expect(held[0]).toEqual({ show: true, period: "month" })
  })

  test("a box that was off catches up once it says what it holds; settings came from another computer stay through its restart", async () => {
    const mac = make("mac-key", "MacBook")
    const devHome = mkdtempSync(join(base, "devbox-"))
    let dev = make("dev-key", "devbox", devHome)
    await mac.meet([dev])
    await dev.meet([mac])
    await relay.settled()
    relay.off.add("dev-key")
    await mac.route("PUT", [], { providers: { enabled: ["claude", "cursor"], known: ["claude", "codex", "cursor"] } })
    await relay.settled()
    expect((await dev.read()).settings).toEqual({})

    relay.off.delete("dev-key")
    at += 10 * MINUTE
    dev.peers.tell()
    await relay.settled()
    expect((await dev.read()).settings.providers).toEqual({ enabled: ["claude", "cursor"], known: ["claude", "codex", "cursor"] })

    dev.stop()
    dev = make("dev-key", "devbox", devHome)
    expect((await dev.read()).settings.providers).toEqual({ enabled: ["claude", "cursor"], known: ["claude", "codex", "cursor"] })
  })

  test("a box a peer vouches for (another person's Mac beside a machine you share) gets nothing, and what it sends is taken by no one; nothing goes before the link says which are yours", async () => {
    const mac = make("mac-key", "MacBook")
    const other = make("other-key", "Someone's Air")
    // Before the link has said: nothing goes, nothing's taken.
    await mac.route("PUT", [], { notifications: alerts(true) })
    await relay.settled()
    other.settings.change({ layout: layout(["claude.session"]) })
    mac.peers.take("other-key", { kind: "settings", at, digest: "x", usage: other.settings.kept() })
    expect((await mac.read()).settings.layout).toBeUndefined()

    await mac.meet([], [other])
    await other.meet([], [mac])
    await relay.settled()
    at += MINUTE
    await mac.route("PUT", [], { notifications: alerts(false) })
    at += 10 * MINUTE
    mac.peers.tell()
    other.peers.tell()
    await relay.settled()
    expect(relay.sent.filter((each) => each.mail.kind === "settings")).toEqual([])
    // Its mail, should it come anyway: not taken.
    mac.peers.take("other-key", { kind: "settings", at, digest: "x", usage: other.settings.kept() })
    await peerRoutes(mac.parts, "POST", ["mail"], async () => ({ from: "other-key", mail: { kind: "settings", at, digest: "x", usage: other.settings.kept() } }))
    expect((await mac.read()).settings).toEqual({ notifications: alerts(false) })
    expect((await other.read()).settings).toEqual({ layout: layout(["claude.session"]) })

    // One of yours that becomes a box a peer vouches for: told nothing more.
    const dev = make("dev-key", "devbox")
    await mac.meet([dev], [other])
    await dev.meet([mac])
    await relay.settled()
    expect((await dev.read()).settings).toEqual({ notifications: alerts(false) })
    await mac.meet([], [other, dev])
    const before = relay.sent.length
    at += MINUTE
    await mac.route("PUT", [], { notifications: alerts(true) })
    at += 10 * MINUTE
    mac.peers.tell()
    await relay.settled()
    expect(relay.sent.slice(before).filter((each) => each.mail.kind === "settings")).toEqual([])
    expect((await dev.read()).settings).toEqual({ notifications: alerts(false) })
  })
})
