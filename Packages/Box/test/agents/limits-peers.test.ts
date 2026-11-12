// Your plans' limits across your computers (PROTOCOL.md, "Plan limits", "Across your computers"):
// each box tells its peers what it read, an account a peer read lately isn't read again, and every
// box lists every account across them, one row each, with the computers it's signed in on. Here,
// three in-memory computers, each with its real bridge parts (its limits, its post, its directory of
// your other computers, its peer routes), on a stand-in relay that plays each box's link; the maker
// (Anthropic, say) is a stand-in that counts the reads it gets.

import "../safety"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LinkDirectory, PeerPost, peerRoutes, type PeerParts } from "../../src/agents/groups/post"
import type { Clock } from "../../src/agents/groups/peer"
import { Limits, LimitsProblem, limitsRoutes, type LimitedAccount, type LimitsSource } from "../../src/agents/limits"
import { LimitsPeers, PEER_AWAY, TELL_AGAIN, type LimitsMail } from "../../src/agents/limits-peers"
import type { LimitRow } from "../../src/agents/limits-rows"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-limits-peers-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const MINUTE = 60_000
/** Claude's time between reads. */
const EVERY = 15 * MINUTE

/** Waits that look again only when mail came. */
const wakes = new Set<() => void>()
const beat = () => {
  for (const wake of [...wakes]) wake()
}
async function until(condition: () => boolean) {
  while (!condition()) {
    await new Promise<void>((resolve) => {
      const wake = () => {
        wakes.delete(wake)
        resolve()
      }
      wakes.add(wake)
    })
  }
}

/** The clock every box here reads (each may be off from it by `off`), moved on by hand. */
let time = Date.parse("2026-11-12T09:00:00.000Z")
const pass = (ms: number) => (time += ms)
/** The post's heartbeat never goes in a test. */
const still: Clock = { setTimeout: () => undefined, clearTimeout: () => {} }

/** The maker: what it answers each account (by who it is), and each read it got, by the computer that asked. */
class Maker {
  reads: { box: string; who: string }[] = []
  used = new Map<string, number>()
  /** Computers it turns away now (a 429), and until when. */
  refuses = new Map<string, number>()
  /** An account's sign-in on `box`: read with its own token there, the same account everywhere. */
  source(box: string, who: string): LimitsSource {
    return {
      every: EVERY,
      identity: () => who,
      read: async (now) => {
        this.reads.push({ box, who })
        const until = this.refuses.get(box)
        if (until) throw new LimitsProblem("rate-limited", "Anthropic turned the read away (429).", until)
        return { plan: "Max 20x", windows: [{ id: "five_hour", used: this.used.get(who) ?? 0.1, minutes: 300, resetsAt: now + 3 * 60 * MINUTE }] }
      },
    }
  }
}

/** The relay, and each box's link on it: what a box's post sends goes to the box it's for, unless one of them is off. */
class Relay {
  boxes = new Map<string, Box>()
  off = new Set<string>()
  sent: { from: string; to: string; mail: LimitsMail }[] = []
  /** Mail that's been given to its box, or lost to one that's off. */
  done = 0
  carry(from: string, to: string, mail: LimitsMail) {
    this.sent.push({ from, to, mail: structuredClone(mail) })
    if (this.off.has(from) || this.off.has(to)) {
      this.done++
      return beat()
    }
    queueMicrotask(async () => {
      const target = this.boxes.get(to)
      if (target) await peerRoutes(target.parts, "POST", ["mail"], async () => ({ from, mail: structuredClone(mail) }))
      this.done++
      beat()
    })
  }

  /** What the boxes' bridges sent. */
  posted = 0
  /** Once every mail any box's bridge sent is where it went. */
  settled() {
    return until(() => this.done === this.posted)
  }
}

/** A box's real post, counting what its bridge sends. */
class Post extends PeerPost {
  constructor(private readonly counted: () => void) {
    super(undefined, still)
  }
  override send(...given: Parameters<PeerPost["send"]>) {
    this.counted()
    super.send(...given)
  }
}

/** One of your computers: its accounts' sign-ins, and its bridge's limits shared through its link. */
class Box {
  readonly root: string
  post!: Post
  directory!: LinkDirectory
  limits!: Limits
  peers!: LimitsPeers
  parts!: PeerParts
  private following = new AbortController()

  constructor(
    readonly key: string,
    readonly name: string,
    readonly relay: Relay,
    readonly accounts: LimitedAccount[],
    /** How far its clock is off. */
    readonly off = 0,
    root?: string,
  ) {
    this.root = root ?? mkdtempSync(join(base, `${name}-`))
    this.start()
  }

  /** Its bridge started (again, from what it kept). */
  start() {
    this.following.abort()
    this.following = new AbortController()
    const now = () => time + this.off
    this.post = new Post(() => this.relay.posted++)
    this.directory = new LinkDirectory(this.post, still)
    this.limits = new Limits(() => this.accounts, join(this.root, "limits.json"), now)
    this.peers = new LimitsPeers(this.limits, this.post, this.directory, join(this.root, "limits-peers.json"), now)
    this.parts = { post: this.post, directory: this.directory, limits: this.peers }
    this.relay.boxes.set(this.key, this)
    void this.link()
  }

  /** The box's link: follows what its post sends and carries it on the relay. */
  private async link() {
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
        if (!line) continue
        const given = JSON.parse(line)
        this.relay.carry(this.key, given.to, given.mail)
      }
    }
  }

  /** Its link says who your other computers are (`PUT /api/kuvo/peers`). */
  async meet(others: Box[]) {
    await peerRoutes(this.parts, "PUT", [], async () => ({ self: { key: this.key, name: this.name }, boxes: others.map((box) => ({ key: box.key, name: box.name, seats: true })), bots: [] }))
  }

  async route(method = "GET", rest: string[] = []) {
    return ((await (await limitsRoutes(this.limits, method, rest)).json()) as any).data as { accounts: any[]; services: string[]; rows: LimitRow[] }
  }

  rows() {
    return this.limits.rows()
  }

  stop() {
    this.following.abort()
  }
}

const claude = (maker: Maker, box: string, who: string, provider = "claude-code"): LimitedAccount => ({
  provider,
  service: "claude",
  agent: { kind: "claude", account: provider === "claude-code" ? "default" : provider.split("@")[1]! },
  limits: maker.source(box, who),
})

let maker: Maker
let relay: Relay

beforeEach(() => {
  maker = new Maker()
  relay = new Relay()
})

/** Three computers, each signed in to `work`; lokum to `home` too. */
async function threeComputers() {
  const mac = new Box("key-mac", "MacBook Pro", relay, [claude(maker, "mac", "anthropic:work|org")])
  const hetzner = new Box("key-hetzner", "hetzner", relay, [claude(maker, "hetzner", "anthropic:work|org")])
  const lokum = new Box("key-lokum", "lokum", relay, [claude(maker, "lokum", "anthropic:work|org"), claude(maker, "lokum", "anthropic:home|org", "claude-code@home0001")])
  const all = [mac, hetzner, lokum]
  for (const box of all) await box.meet(all.filter((other) => other !== box))
  return { mac, hetzner, lokum, all }
}

describe("plan limits across your computers", () => {
  test("an account signed in on three computers is read from its maker once each round, by one of them, and every one lists it once with its newest reading", async () => {
    const { mac, hetzner, lokum } = await threeComputers()
    maker.used.set("anthropic:work|org", 0.42)
    await mac.limits.tick()
    await relay.settled()
    await hetzner.limits.tick()
    await lokum.limits.tick()
    // The work account read once (by the Mac), and lokum's own other account by lokum.
    expect(maker.reads.filter((read) => read.who === "anthropic:work|org")).toEqual([{ box: "mac", who: "anthropic:work|org" }])

    // Round after round: the Mac reads it when it's due, and the others, whose minutes come round
    // a little later, don't.
    for (let round = 1; round <= 3; round++) {
      pass(round === 1 ? EVERY : EVERY - 5 * MINUTE)
      await mac.limits.tick()
      await relay.settled()
      pass(5 * MINUTE)
      await hetzner.limits.tick()
      await lokum.limits.tick()
      expect(maker.reads.filter((read) => read.who === "anthropic:work|org").map((read) => read.box)).toEqual(Array(round + 1).fill("mac"))
    }

    // Every box lists it once, with the Mac's reading, and the computers it's signed in on.
    for (const box of [mac, hetzner, lokum]) {
      const work = box.rows().filter((row) => row.windows[0]?.used === 0.42)
      expect(work).toHaveLength(1)
      expect(work[0]!.plan).toBe("Max 20x")
      expect(work[0]!.boxes.map((each) => each.name).sort()).toEqual(["MacBook Pro", "hetzner", "lokum"])
      expect(work[0]!.boxes.filter((each) => each.here).map((each) => each.name)).toEqual([box.name])
      // This box's first.
      expect(work[0]!.boxes[0]!.name).toBe(box.name)
    }
    // lokum's other account: one row, on lokum only, on every box.
    for (const box of [mac, hetzner]) {
      const home = box.rows().filter((row) => row.boxes.length === 1 && row.boxes[0]!.name === "lokum")
      expect(home).toHaveLength(1)
      expect(home[0]!.label).toBeUndefined()
      expect(home[0]!.windows).toHaveLength(1)
    }
    // The route says the same, and keeps what older clients read: each box's own accounts.
    const said = await hetzner.route()
    expect(said.rows).toEqual(JSON.parse(JSON.stringify(hetzner.rows())))
    expect(said.accounts.map((account) => account.provider)).toEqual(["claude-code"])
    expect(said.rows).toHaveLength(2)
  })

  test("computers that read at the same moment settle on one reader by the next round", async () => {
    const { mac, hetzner, lokum, all } = await threeComputers()
    // Nothing heard yet: each reads it.
    await Promise.all(all.map((box) => box.limits.tick()))
    await relay.settled()
    const work = () => maker.reads.filter((read) => read.who === "anthropic:work|org").map((read) => read.box)
    expect(work().sort()).toEqual(["hetzner", "lokum", "mac"])
    // A round later, as their minutes come round: the first reads it, and the others hear it did.
    pass(EVERY)
    await hetzner.limits.tick()
    await relay.settled()
    await lokum.limits.tick()
    await mac.limits.tick()
    expect(work().slice(3)).toEqual(["hetzner"])
  })

  test("a refresh asked of one computer reads there only what's due, and asks the computer an account is on for one it doesn't have", async () => {
    const { mac, hetzner, lokum } = await threeComputers()
    await lokum.limits.tick()
    await relay.settled()
    maker.used.set("anthropic:home|org", 0.2)
    const before = maker.reads.length
    // Read a minute ago on lokum: a refresh on the Mac doesn't ask Anthropic again.
    pass(MINUTE)
    await mac.route("POST", ["refresh"])
    // (Once lokum, asked, has looked.)
    await relay.settled()
    await lokum.limits.tick()
    expect(maker.reads.length).toBe(before)

    // Long after: the Mac reads its own (the work account), and lokum, asked, reads its home account.
    pass(EVERY + MINUTE)
    maker.used.set("anthropic:home|org", 0.77)
    await mac.route("POST", ["refresh"])
    await until(() => mac.rows().some((row) => row.windows[0]?.used === 0.77))
    // The work account once: by the Mac, which lokum heard of before it was asked.
    expect(maker.reads.slice(before).map((read) => `${read.box} ${read.who}`)).toEqual(["mac anthropic:work|org", "lokum anthropic:home|org"])
  })

  test("a computer that's off keeps its last reading, listed as of when it was read and away, through a restart; what it read is read elsewhere once it's due", async () => {
    const { mac, hetzner, lokum } = await threeComputers()
    maker.used.set("anthropic:home|org", 0.3)
    await lokum.limits.tick()
    const read = time
    await relay.settled()
    relay.off.add("key-lokum")
    lokum.stop()

    // Not heard from past PEER_AWAY (it would have told again each ten minutes).
    pass(PEER_AWAY + MINUTE)
    const home = () => hetzner.rows().find((row) => row.boxes.some((each) => each.provider === "claude-code@home0001"))
    expect(home()?.away).toBe(true)
    expect(home()?.boxes[0]?.away).toBe(true)
    expect(home()?.windows[0]?.read).toBe(read)
    expect(home()?.windows[0]?.used).toBe(0.3)
    // The work account, signed in here too, isn't away.
    expect(hetzner.rows().find((row) => row.boxes.some((each) => each.here))?.away).toBeUndefined()

    // Through a restart of hetzner's bridge.
    hetzner.stop()
    hetzner.start()
    expect(home()?.away).toBe(true)
    expect(home()?.windows[0]?.read).toBe(read)

    // lokum read the work account last: past its next read and a little, the others take it on.
    const before = maker.reads.length
    await hetzner.limits.tick()
    expect(maker.reads.slice(before)).toEqual([{ box: "hetzner", who: "anthropic:work|org" }])
  })

  test("a maker that turns one computer away holds that one only: another reads the account, and a read that failed never stands in for one", async () => {
    const mac = new Box("key-mac", "MacBook Pro", relay, [claude(maker, "mac", "anthropic:work|org")])
    const hetzner = new Box("key-hetzner", "hetzner", relay, [claude(maker, "hetzner", "anthropic:work|org")])
    await mac.meet([hetzner])
    await hetzner.meet([mac])
    maker.used.set("anthropic:work|org", 0.5)
    await mac.limits.tick()
    await relay.settled()
    await hetzner.limits.tick()
    // Due again, the Mac is turned away for an hour.
    pass(EVERY)
    maker.refuses.set("mac", time + 60 * MINUTE)
    await mac.limits.tick()
    await relay.settled()
    // hetzner's minute comes round: the Mac's last good reading is a round old, so it reads.
    pass(3 * MINUTE)
    maker.used.set("anthropic:work|org", 0.6)
    await hetzner.limits.tick()
    await relay.settled()
    // The Mac, held, asks nothing; its hold isn't hetzner's.
    pass(10 * MINUTE)
    await mac.limits.tick()
    expect(maker.reads.map((read) => read.box)).toEqual(["mac", "mac", "hetzner"])
    // Read on hetzner: listed with that, and no problem (one box could read it).
    for (const box of [mac, hetzner]) {
      const [row] = box.rows()
      expect(row!.windows[0]!.used).toBe(0.6)
      expect(row!.problem).toBeUndefined()
      expect(row!.boxes.find((each) => each.key === "key-mac")).toBeDefined()
    }
  })

  test("a computer you removed goes from the list, with its accounts", async () => {
    const { mac, hetzner, lokum } = await threeComputers()
    await lokum.limits.tick()
    await relay.settled()
    expect(hetzner.rows().some((row) => row.boxes.some((each) => each.name === "lokum"))).toBe(true)
    await hetzner.meet([mac])
    expect(hetzner.rows().some((row) => row.boxes.some((each) => each.name === "lokum"))).toBe(false)
  })

  test("a peer whose clock is an hour ahead holds this box back no longer than one whose clock is right", async () => {
    const mac = new Box("key-mac", "MacBook Pro", relay, [claude(maker, "mac", "anthropic:work|org")])
    const ahead = new Box("key-ahead", "ahead", relay, [claude(maker, "ahead", "anthropic:work|org")], 60 * MINUTE)
    await mac.meet([ahead])
    await ahead.meet([mac])
    await ahead.limits.tick()
    await relay.settled()
    // Its reading is as of now here, not an hour on.
    expect(Math.max(...mac.rows()[0]!.windows.map((window) => window.read))).toBe(time)
    pass(EVERY + 3 * MINUTE)
    const before = maker.reads.length
    await mac.limits.tick()
    expect(maker.reads.slice(before)).toEqual([{ box: "mac", who: "anthropic:work|org" }])
  })

  test("what goes between them is the readings, never a sign-in or who the account is at its maker", async () => {
    const { mac, hetzner } = await threeComputers()
    await mac.limits.tick()
    await relay.settled()
    const mails = JSON.stringify(relay.sent)
    expect(mails).toContain("five_hour")
    expect(mails).not.toContain("anthropic:work")
    // Told again each ten minutes though nothing changed (the relay keeps nothing).
    const told = relay.sent.filter((each) => each.from === "key-mac" && each.to === "key-hetzner").length
    pass(TELL_AGAIN)
    await mac.limits.tick()
    expect(relay.sent.filter((each) => each.from === "key-mac" && each.to === "key-hetzner").length).toBe(told + 1)
  })
})
