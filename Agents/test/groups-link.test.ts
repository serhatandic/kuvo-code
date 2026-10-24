import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "../src/groups/api"
import { linkRoutes } from "../src/groups/link"
import { SeatServer } from "../src/groups/peer"
import { LinkDirectory, PeerPost, peerRoutes } from "../src/groups/post"
import { GroupRunner } from "../src/groups/runner"
import type { Group, GroupMessage } from "../src/groups/rules"
import { GroupStore } from "../src/groups/store"

// This computer's group chats as a client reads and changes them (`kuvo/groups`, PROTOCOL.md): the
// shapes the phone and the window show, and every rule of what can be made or changed, decided
// here. The runner is real; its engine is nowhere (nothing here needs a bot to answer).

let root: string
let store: GroupStore
let runner: GroupRunner

function bot(id: string, name: string) {
  const folder = join(root, "bots", id)
  mkdirSync(join(folder, "workspace"), { recursive: true })
  writeFileSync(join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id, name, job: "Helps", look: { color: "mint", shape: "round", face: "calm" }, created: "2026-10-21T09:00:00Z", updated: "2026-10-21T09:00:00Z" }))
  writeFileSync(join(folder, "session"), "ses_" + id)
}

const group: Group = {
  id: "grp_box0000001", name: "k", members: ["bot_pal", "bot_lb"], seats: {}, heard: {}, created: "2026-10-21T09:00:00Z", viewed: "2026-10-22T07:00:00Z",
  meeting: { next: "2030-10-23T06:00:00Z", every: "1d", topic: "Standup", at: 540 },
}
const messages: GroupMessage[] = [
  { id: "gm_1", text: "Ship it?", time: "2026-10-22T07:59:00Z", kind: "message", named: "<named-agents>\n- &Scout (ses_x): a bot\n</named-agents>" } as GroupMessage,
  { id: "gm_2", author: "bot_pal", text: "Yes.", time: "2026-10-22T08:00:00Z", kind: "message", steps: [{ type: "tool", id: "call_1", name: "webfetch", state: { status: "completed", input: {}, content: [] } } as any] },
  { id: "gm_3", author: "bot_pal", text: "We ship.", time: "2026-10-22T08:01:00Z", kind: "wrapUp", tasks: [{ id: "gt_1", bot: "bot_lb", task: "Tag it", state: "proposed", started: "2026-10-22T08:02:00Z" }] },
  { id: "gm_4", text: "Lokum Builder couldn’t answer: away", time: "2026-10-22T08:03:00Z", kind: "note" },
]

async function ask(method: string, path: string, body?: unknown, signal?: AbortSignal) {
  const parts = path.split("/").filter(Boolean)
  const response = await linkRoutes(runner, store, method, parts, async () => body, signal)
  const streams = response.headers.get("Content-Type")?.includes("ndjson")
  return { status: response.status, json: streams ? undefined : ((await response.json().catch(() => undefined)) as any), response }
}

/** The lines a followed route sends, until `enough` says so. */
async function lines(path: string, enough: (lines: any[]) => boolean, act?: (lines: any[]) => void) {
  const abort = new AbortController()
  const { response } = await ask("GET", path, undefined, abort.signal)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const got: any[] = []
  let buffer = ""
  while (!enough(got)) {
    const read = await reader.read()
    if (read.done) break
    buffer += decoder.decode(read.value, { stream: true })
    let end: number
    while ((end = buffer.indexOf("\n")) >= 0) {
      got.push(JSON.parse(buffer.slice(0, end)))
      buffer = buffer.slice(end + 1)
      act?.(got)
    }
  }
  abort.abort()
  await reader.cancel().catch(() => {})
  return got
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-groups-link-"))
  bot("bot_pal", "Pal")
  bot("bot_lb", "Lokum Builder")
  store = new GroupStore(join(root, "groups"), join(root, "bots"))
  runner = new GroupRunner({ store, engine: server("http://127.0.0.1:9", "x"), bridge: () => undefined, trash: join(root, "trash"), pace: 0.05 })
  runner.put(group, messages, "active", false)
  runner.put({ ...group, id: "grp_moving0001", name: "Moving" }, [], "held", false)
})

afterEach(() => {
  runner.stop(group.id)
  rmSync(root, { recursive: true, force: true })
})

describe("a computer's group chats, as a client reads them", () => {
  test("listed with their bots, who's talking, the last thing said and the meeting, in seconds; one moving here isn't listed yet", async () => {
    const { status, json } = await ask("GET", "")
    expect(status).toBe(200)
    expect(json.groups.map((each: any) => each.id)).toEqual([group.id])
    const [chat] = json.groups
    expect(chat.members).toEqual([
      { id: "bot_pal", name: "Pal", look: { color: "mint", shape: "round", face: "calm" }, session: "ses_bot_pal", directory: join(root, "bots", "bot_pal", "workspace"), agents: false },
      { id: "bot_lb", name: "Lokum Builder", look: { color: "mint", shape: "round", face: "calm" }, session: "ses_bot_lb", directory: join(root, "bots", "bot_lb", "workspace"), agents: false },
    ])
    expect(chat.unread).toBe(true)
    expect(chat.discussing).toBe(false)
    expect(chat.meeting).toEqual({ next: Date.parse("2030-10-23T06:00:00Z") / 1000, every: "1d", topic: "Standup", at: 540 })
    // The last thing said, not a note, without its steps.
    expect(chat.last.id).toBe("gm_3")
    expect(chat.last.time).toBe(Date.parse("2026-10-22T08:01:00Z") / 1000)
    expect(chat.last.tasks[0].started).toBe(Date.parse("2026-10-22T08:02:00Z") / 1000)
  })

  test("one chat: its messages with their steps, without the block naming agents; gone or moving, none", async () => {
    const { json } = await ask("GET", group.id)
    expect(json.messages.map((each: any) => each.id)).toEqual(["gm_1", "gm_2", "gm_3", "gm_4"])
    expect(json.messages[0].named).toBeUndefined()
    expect(json.messages[1].steps.length).toBe(1)
    expect((await ask("GET", "grp_moving0001")).status).toBe(404)
    expect((await ask("GET", "grp_nothing0001")).status).toBe(404)
    expect((await ask("GET", "../x")).status).toBe(404)
  })

  test("followed: a line now, and one each time it changes; a line where only the talk changed leaves its messages out", async () => {
    let started = false
    const got = await lines(`${group.id}/events`, (each) => each.some((line) => line.discussing && !("messages" in line)), (each) => {
      if (each.length === 1 && !started) {
        started = true
        runner.keepGoing(group.id)
      }
    })
    expect(got[0].messages.length).toBe(4)
    expect(got.some((line) => line.discussing && !("messages" in line))).toBe(true)
  })

  test("the list followed: a line as the chats change, as the runner says (no polling)", async () => {
    const got = await lines("events", (each) => each.length >= 2, (each) => {
      if (each.length === 1) void ask("PATCH", group.id, { name: "Daily" })
    })
    expect(got[0].groups[0].name).toBe("k")
    expect(got[1].groups[0].name).toBe("Daily")
  })
})

describe("a computer's group chats, as a client changes them", () => {
  test("made as New Group Chat makes one, of bots that live here, its meeting worked out here", async () => {
    expect((await ask("POST", "", { members: ["bot_pal", "bot_lb"] })).json).toEqual({ message: "A group chat needs a name." })
    expect((await ask("POST", "", { name: "Standup", members: ["bot_pal", "bot_pal"] })).json).toEqual({ message: "A group chat needs at least two bots." })
    const stranger = await ask("POST", "", { name: "Standup", members: ["bot_pal", "bot_nobody"] })
    expect([stranger.status, stranger.json]).toEqual([404, { message: "There’s no bot “bot_nobody”." }])
    expect((await ask("POST", "", { name: "Standup", members: ["bot_pal", "bot_lb"], meeting: { next: 1_000_000 } })).json).toEqual({ message: "That time has passed. Pick one to come." })
    expect(runner.list().length).toBe(2)
    const made = await ask("POST", "", { name: "  Stand\nup ", members: ["bot_pal", "bot_lb"], purpose: "  Ship it  ", meeting: { next: Date.parse("2031-01-01T09:00:00Z") / 1000, topic: "" } })
    expect(made.status).toBe(201)
    expect(made.json.group).toMatchObject({ name: "Stand up", purpose: "Ship it", discussing: false })
    expect(made.json.group.meeting.topic).toBe("Our regular meeting: where things stand, and what's next.")
    expect(runner.get(made.json.group.id)?.status).toBe("active")
  })

  test("who can be in one: every bot that lives here", async () => {
    expect((await ask("GET", "joinable")).json.bots.map((each: any) => each.id).sort()).toEqual(["bot_lb", "bot_pal"])
  })

  test("changed as Edit Group Chat changes it, and refused what can't be", async () => {
    expect((await ask("PATCH", group.id, { name: " " })).json).toEqual({ message: "A group chat needs a name." })
    expect((await ask("PATCH", group.id, { members: ["bot_pal"] })).json).toEqual({ message: "A group chat needs at least two bots." })
    expect((await ask("PATCH", group.id, { members: ["bot_pal", "bot_far"] })).status).toBe(404)
    expect((await ask("PATCH", group.id, { meeting: { next: Date.parse("2031-01-01T09:00:00Z") / 1000, every: "fortnightly" } })).status).toBe(400)
    const changed = await ask("PATCH", group.id, { name: " Daily ", purpose: "", meeting: null })
    expect(changed.json.group).toMatchObject({ id: group.id, name: "Daily" })
    expect(changed.json.group.purpose).toBeUndefined()
    expect(changed.json.group.meeting).toBeUndefined()
    const weekly = await ask("PATCH", group.id, { meeting: { next: Date.parse("2031-01-01T09:00:00Z") / 1000, every: "1w", topic: "Weekly" } })
    expect(weekly.json.group.meeting).toMatchObject({ next: Date.parse("2031-01-01T09:00:00Z") / 1000, every: "1w", topic: "Weekly" })
    expect((await ask("PATCH", "grp_moving0001", { name: "Ghost" })).status).toBe(409)
    expect((await ask("PATCH", "grp_nothing0001", { name: "Ghost" })).status).toBe(404)
  })

  test("deleted: gone, and gone already is as good as deleted; one moving here stays, and says why", async () => {
    expect([(await ask("DELETE", group.id)).status, (await ask("DELETE", group.id)).json]).toEqual([200, {}])
    expect((await ask("GET", "")).json.groups).toEqual([])
    const moving = await ask("DELETE", "grp_moving0001")
    expect([moving.status, moving.json]).toEqual([409, { message: "That chat is moving. Try again once it’s there." }])
  })

  test("written to, stopped, looked at, a message taken back, the work started; a chat moving here takes none of it", async () => {
    expect((await ask("POST", group.id, { text: "  " })).status).toBe(400)
    expect((await ask("POST", group.id, { text: "Go" })).status).toBe(200)
    expect(runner.get(group.id)!.messages.at(-1)?.text).toBe("Go")
    expect((await ask("POST", `${group.id}/stop`)).status).toBe(200)
    expect((await ask("POST", `${group.id}/viewed`)).status).toBe(200)
    expect((await ask("GET", "")).json.groups[0].unread).toBe(false)
    expect((await ask("POST", `${group.id}/start`, { message: "gm_3" })).status).toBe(200)
    expect(runner.get(group.id)!.messages.find((each) => each.id === "gm_3")!.tasks![0].state).not.toBe("proposed")
    const taken = await ask("POST", `${group.id}/undo`, { message: "gm_1" })
    expect([taken.status, taken.json]).toEqual([200, { text: "Ship it?" }])
    expect((await ask("POST", `${group.id}/undo`, { message: "gm_gone" })).status).toBe(404)
    expect((await ask("POST", "grp_moving0001", { text: "Go" })).status).toBe(409)
    expect((await ask("POST", "grp_moving0001/undo", { message: "gm_1" })).status).toBe(409)
    expect((await ask("POST", "grp_nothing0001", { text: "Go" })).status).toBe(404)
  })
})

describe("a computer's group chats with bots on your other computers", () => {
  test("who can be in one: this computer's bots, then those of your others that take a chat's turns; none of one that doesn't yet", async () => {
    const post = new PeerPost()
    const directory = new LinkDirectory(post)
    runner = new GroupRunner({ store, engine: server("http://127.0.0.1:9", "x"), bridge: () => undefined, trash: join(root, "trash"), pace: 0.05, peers: directory })
    directory.set({
      boxes: [{ key: "key_spare", name: "spare", seats: true }, { key: "key_old", name: "old", seats: false }],
      bots: [{ id: "bot_far", name: "Far", job: "Far's job", box: "key_spare", session: "ses_far" }, { id: "bot_older", name: "Older", job: "", box: "key_old" }],
    })
    const bots = (await ask("GET", "joinable")).json.bots
    expect(bots.map((each: any) => each.id)).toEqual(["bot_lb", "bot_pal", "bot_far"])
    expect(bots[2]).toEqual({ id: "bot_far", name: "Far", session: "ses_far", agents: false, computer: "spare" })
    const made = await ask("POST", "", { name: "Across", members: ["bot_pal", "bot_far"] })
    expect(made.status).toBe(201)
    expect(made.json.group.members.map((each: any) => [each.id, each.computer])).toEqual([["bot_pal", undefined], ["bot_far", "spare"]])
    expect((await ask("POST", "", { name: "Older", members: ["bot_pal", "bot_older"] })).status).toBe(404)
  })
})

describe("the box's link and this bridge", () => {
  test("what goes follows as it goes, what mustn't be lost first and until the link has it; what came is handed on; who your computers are is taken only whole", async () => {
    const file = join(root, "peer-outbox.json")
    let post = new PeerPost(file)
    post.send("key_spare", { kind: "drop", seat: "ses_seat1", agents: false }, true)
    post.send("key_spare", { kind: "stop", id: "trn_gone" }, false)
    // A bridge started again still has what mustn't be lost.
    post = new PeerPost(file)
    const directory = new LinkDirectory(post)
    runner = new GroupRunner({ store, engine: server("http://127.0.0.1:9", "x"), bridge: () => undefined, trash: join(root, "trash"), pace: 0.05, peers: directory })
    const parts = { post, directory, runner, server: new SeatServer(runner.seats, post, { store, remembered: async () => {} }) }
    const abort = new AbortController()
    const reader = (await peerRoutes(parts, "GET", ["mail"], async () => ({}), abort.signal)).body!.getReader()
    const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).trim())
    const kept = await next()
    expect([kept.to, kept.mail.kind, kept.durable]).toEqual(["key_spare", "drop", true])
    post.send("key_spare", { kind: "stop", id: "trn_now" }, false)
    expect((await next()).mail).toEqual({ kind: "stop", id: "trn_now" })
    expect((await peerRoutes(parts, "POST", ["sent"], async () => ({ ids: [kept.id] }))).status).toBe(200)
    expect(new PeerPost(file).follow).toBeDefined()
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([])
    abort.abort()
    await reader.cancel().catch(() => {})
    expect((await peerRoutes(parts, "POST", ["mail"], async () => ({ from: "key_spare", mail: { kind: "nonsense" } }))).status).toBe(400)
    expect((await peerRoutes(parts, "PUT", [], async () => ({ boxes: "no" }))).status).toBe(400)
    expect((await peerRoutes(parts, "PUT", [], async () => ({ boxes: [{ key: "key_spare", name: "spare", seats: true }], bots: [] }))).status).toBe(200)
    expect(directory.takesSeats("key_spare")).toBe(true)
    expect((await peerRoutes(undefined, "GET", ["mail"], async () => ({}))).status).toBe(404)
  })
})
