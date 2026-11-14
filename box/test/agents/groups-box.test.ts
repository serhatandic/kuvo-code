import "../safety"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { subscribe } from "../../src/agents/events"
import { server } from "../../src/agents/groups/api"
import { linkRoutes } from "../../src/agents/groups/link"
import { namedBlock, namedIn } from "../../src/agents/groups/named"
import { GroupRunner } from "../../src/agents/groups/runner"
import { stamp, type Group } from "../../src/agents/groups/rules"
import { GroupStore } from "../../src/agents/groups/store"
import type { ServerEvent } from "../../src/agents/wire"
import { Engine } from "./support/engine"

// What a computer's box does for every client alike, now that this Mac's group chats run in its
// bridge as a machine's do: who a message names with & is worked out there, what it lets go of
// is said as it goes to its trash, and what a bot was still to be told of its chats is told.

let root: string
let engine: Engine
let events: ServerEvent[]
let unsubscribe: () => void
const id = "grp_team000001"

const wakes = new Set<() => void>()
function beat() {
  for (const wake of [...wakes]) wake()
}
async function until(condition: () => boolean) {
  while (!condition()) await new Promise<void>((resolve) => wakes.add(() => (wakes.clear(), resolve())))
}

function bot(botID: string, name: string) {
  const folder = join(root, "bots", botID)
  mkdirSync(join(folder, "workspace"), { recursive: true })
  writeFileSync(join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: botID, name, job: "Helps", look: { color: "mint", shape: "round", face: "calm" }, model: { id: "m", providerID: "p" }, created: stamp(), updated: stamp() }))
  writeFileSync(join(folder, "session"), "ses_own_" + name)
  writeFileSync(join(folder, "directory"), join(folder, "workspace"))
  writeFileSync(join(folder, "MEMORY.md"), `# ${name}'s memory\n`)
  // Its job, as its box keeps it.
  writeFileSync(join(folder, "job.json"), JSON.stringify({ line: "Helps with the release", details: "Helps with the release" }))
}

function group(): Group {
  return { id, name: "Team", members: ["bot_ada", "bot_ben"], seats: {}, heard: {}, created: stamp() }
}

/** A runner on the Mac (no place named), its agents file where the app writes it. */
function runner() {
  const store = new GroupStore(join(root, "groups"), join(root, "bots"), join(root, "run", "agents.json"))
  const groups = new GroupRunner({ store, engine: server(engine.url, "x"), bridge: () => undefined, trash: join(root, "trash"), pace: 0.05, memoryKey: "kuvo.groups" })
  return { store, groups }
}

function agents(list: unknown[], machine: string | null = null) {
  mkdirSync(join(root, "run"), { recursive: true })
  writeFileSync(join(root, "run", "agents.json"), JSON.stringify({ ...(machine ? { machine } : {}), agents: list }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-groups-box-"))
  engine = new Engine(beat)
  bot("bot_ada", "Ada")
  bot("bot_ben", "Ben")
  events = []
  unsubscribe = subscribe((event) => {
    events.push(event)
    beat()
  })
})

afterEach(() => {
  unsubscribe()
  engine.stop()
  rmSync(root, { recursive: true, force: true })
})

describe("who a message to a group chat names with &", () => {
  test("worked out where the chat lives, for every client: each agent once, with its address and what it is; the chat's own bots not again", async () => {
    agents([
      { session: "ses_own_Ada", name: "Ada", kind: "bot", about: "Helps" },
      { session: "ses_fix", name: "Fix login", kind: "session", project: "api" },
      { session: "ses_scout", name: "Scout", kind: "bot", machine: "devbox", about: "Watches CI" },
    ])
    const { groups, store } = runner()
    engine.lines = { Ada: ["On it.", "PASS"], Ben: ["PASS"] }
    groups.put(group(), [], "active", false)
    // As a phone writes it, and the Mac's window: only the words.
    const answer = await linkRoutes(groups, store, "POST", [id], async () => ({ text: "&Ada, ask &Scout and read &fix login, then &Scout again" }))
    expect(answer.status).toBe(200)
    const sent = groups.get(id)!.messages[0] as any
    expect(sent.text).toBe("&Ada, ask &Scout and read &fix login, then &Scout again")
    expect(sent.named).toBe(
      [
        "<named-agents>",
        "Agents the user named with & in this message, by their address. Read one's conversation with read_conversation only when what the user asks needs what it knows or did, and write to it with send_message only to ask it something or hand it work; when the user only mentions one, do neither:",
        "- &Scout (ses_scout): bot, on devbox: Watches CI",
        "- &Fix login (ses_fix): session, on the Mac, in api",
        "</named-agents>",
      ].join("\n"),
    )
    // What a client reads of it leaves the block out.
    const read: any = await (await linkRoutes(groups, store, "GET", [id], async () => undefined)).json()
    expect(read.messages[0].named).toBeUndefined()
    await until(() => !groups.talk(id).discussing)
  })

  test("a block a client sends is not taken: the box names them itself", async () => {
    agents([])
    const { groups, store } = runner()
    engine.lines = { Ada: ["PASS"], Ben: ["PASS"] }
    groups.put(group(), [], "active", false)
    await linkRoutes(groups, store, "POST", [id], async () => ({ text: "Hello", named: "<named-agents>\nmade up\n</named-agents>" }))
    expect((groups.get(id)!.messages[0] as any).named).toBeUndefined()
    await until(() => !groups.talk(id).discussing)
  })

  test("on a machine, what lives there is here, and the Mac's on the Mac", () => {
    const directory = {
      machine: "devbox",
      agents: [
        { session: "ses_a", name: "Ops", kind: "bot", machine: "devbox" },
        { session: "ses_b", name: "Pixel", kind: "bot" },
      ],
    }
    expect(namedBlock("&ops and &PIXEL", directory)?.split("\n").slice(2, 4)).toEqual(["- &Ops (ses_a): bot, here", "- &Pixel (ses_b): bot, on the Mac"])
  })

  test("a name ends where a word does, and the longest one wins; any case, any accents", () => {
    const list = [
      { session: "ses_1", name: "Mira", kind: "bot" },
      { session: "ses_2", name: "Miranda", kind: "bot" },
      { session: "ses_3", name: "Zoë", kind: "bot" },
    ]
    expect(namedIn("&Miranda and &Mira", list).map((agent) => agent.session)).toEqual(["ses_2", "ses_1"])
    expect(namedIn("&Miras and a&Mira", list)).toEqual([])
    expect(namedIn("ask &zoe", list).map((agent) => agent.session)).toEqual(["ses_3"])
  })
})

describe("a bot's words", () => {
  test("reach the chat as soon as the engine says its run ended, not at the next look", async () => {
    const listeners = new Map<string, { event(event: any): void }>()
    // An engine whose seats' runs end at once, and say so on their live events; its looks so far
    // apart (pace) that only that could end a turn in time.
    const told = new Engine(() => {
      const last = told.requests.at(-1)
      if (last?.path.endsWith("/prompt")) {
        const seat = last.path.split("/")[3]
        queueMicrotask(() => listeners.get(seat)?.event({ type: "session.execution.succeeded", data: { sessionID: seat } }))
      }
      beat()
    })
    try {
      told.lines = { Ada: ["Ship it."], Ben: [] }
      const store = new GroupStore(join(root, "groups"), join(root, "bots"))
      const groups = new GroupRunner({
        store, engine: server(told.url, "x"), bridge: () => undefined, trash: join(root, "trash"), pace: 1000,
        listen: (session, listener) => {
          listeners.set(session, listener)
          return () => listeners.delete(session)
        },
      })
      groups.put(group(), [], "active", false)
      groups.send(id, "Ready?")
      await until(() => !groups.talk(id).discussing && groups.get(id)!.messages.some((message) => message.author === "bot_ada"))
      expect(groups.get(id)!.messages.filter((message) => message.kind === "message").map((message) => message.text)).toEqual(["Ready?", "Ship it."])
    } finally {
      told.stop()
    }
  })
})

describe("a bot a move holds", () => {
  test("sits its turn out, saying why, and nothing goes to an engine for it; the others go on", async () => {
    writeFileSync(join(root, "bots", "bot_ada", "paused"), "moving")
    const { groups } = runner()
    engine.lines = { Ben: ["Here.", "PASS"] }
    groups.put(group(), [], "active", false)
    groups.send(id, "Where are we?")
    await until(() => !groups.talk(id).discussing && groups.get(id)!.messages.some((message) => message.author === "bot_ben"))
    expect(groups.get(id)!.messages.filter((message) => message.kind === "note").map((message) => message.text)).toContain("Ada is moving to another computer, so it sat this out.")
    expect(engine.seatsMade().some((title) => title.startsWith("Ada"))).toBe(false)
  })
})

describe("what a box lets go of", () => {
  test("goes to its trash, and it says where (this Mac's app puts it in the Finder's Trash)", async () => {
    const { groups } = runner()
    groups.put(group(), [], "active", false)
    await groups.delete(id)
    const trashed = events.find((event) => event.type === "kuvo.group.trashed")?.data as any
    expect(trashed?.id).toBe(id)
    expect(trashed?.path.startsWith(join(root, "trash"))).toBe(true)
    expect(existsSync(join(trashed.path, id, "group.json"))).toBe(true)
  })
})

describe("what a bot was still to be told of its chats", () => {
  test("told once it's known here: the chats it forgets go from its folder, and it remembers the rest", async () => {
    const { groups, store } = runner()
    mkdirSync(join(root, "bots", "bot_ada", "groups"), { recursive: true })
    writeFileSync(join(root, "bots", "bot_ada", "groups", "grp_gone000001.md"), "# Gone")
    groups.put(group(), [{ id: "gm_1", text: "Hello", time: stamp(), kind: "message" }], "active", false)
    store.setPendingMemory({ bot_ada: ["grp_gone000001"], bot_far: ["grp_other00001"] })
    await groups.catchUpMemory()
    expect(existsSync(join(root, "bots", "bot_ada", "groups", "grp_gone000001.md"))).toBe(false)
    expect(engine.requests.some((request) => request.method === "PUT" && request.path === "/api/experimental/session/ses_own_Ada/instructions/entries/kuvo.groups")).toBe(true)
    // One no computer has told of yet waits.
    expect(JSON.parse(readFileSync(join(root, "groups", "pending-memory.json"), "utf8"))).toEqual({ bot_far: ["grp_other00001"] })
  })
})
