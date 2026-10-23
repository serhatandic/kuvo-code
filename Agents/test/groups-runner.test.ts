import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { subscribe } from "../src/events"
import { server } from "../src/groups/api"
import { groupRoutes } from "../src/groups/routes"
import { GroupRunner } from "../src/groups/runner"
import { stamp, type Group } from "../src/groups/rules"
import { GroupStore } from "../src/groups/store"
import type { ServerEvent } from "../src/wire"

// A group chat that lives on a machine, as the machine's bridge runs it: against a stand-in engine
// whose seats answer with their bot's next line, as the Mac's GroupChatTests do.

/** The engine on the machine: each seat answers its turn with its bot's next line (PASS once it has none). */
class Engine {
  readonly requests: { method: string; path: string; body: any }[] = []
  private seats = new Map<string, string>()
  private conversations = new Map<string, any[]>()
  private next = 1
  private server: ReturnType<typeof Bun.serve>
  /** What each bot's seat says, in turn, and what its own conversation reports on a part. */
  lines: Record<string, string[]> = {}
  reports: Record<string, string> = {}
  /** A seat that asks permission before it answers. */
  asking = new Set<string>()
  private permissions = new Map<string, { id: string }[]>()
  /** Bots whose seats take a while (at work meanwhile), and ones whose prompts stay queued. */
  slow = new Map<string, number>()
  stuck = new Set<string>()
  /** How much a bot's seat sends the model at each step (its context, in tokens). */
  sizes: Record<string, number> = {}
  /** Prompts that take this long, by what they say. */
  slowPrompts = new Map<string, number>()
  /** A slow bot's thinking, shown with a file it reads, while it's at work. */
  working = new Map<string, string>()
  /** The accounts the engine lists, those it has ready, and seats whose provider turns them down with `failing`'s words. */
  integrations: any[] = [{ id: "p", name: "Provider P", methods: [{ type: "key" }], connections: [{ id: "c" }] }]
  providers: any[] = [{ id: "p" }]
  /** The model each bot's own conversation is on, when not its seat's ("m" of "p"). */
  ownModels: Record<string, { id: string; providerID: string }> = {}
  failing = new Map<string, string>()
  private busy = new Set<string>()
  private queued = new Map<string, { id: string }[]>()
  private deleted = new Set<string>()

  constructor() {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.answer(request) })
  }

  get url() {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop() {
    this.server.stop(true)
  }

  seatsMade() {
    return this.requests.filter((request) => request.method === "POST" && request.path === "/api/session").map((request) => request.body.title as string)
  }

  prompts(session?: string) {
    return this.requests.filter((request) => request.path.endsWith("/prompt") && (!session || request.path.includes(session)))
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body: any = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json().catch(() => ({}))
    this.requests.push({ method: request.method, path: url.pathname, body })
    const ok = (data: unknown = {}) => Response.json({ data })
    const parts = url.pathname.split("/").filter(Boolean)
    if (request.method === "POST" && url.pathname === "/api/session") {
      const id = `ses_seat${this.next++}`
      this.seats.set(id, String(body.title).split(" ")[0])
      return ok({ id, title: body.title, model: body.model, location: body.location })
    }
    if (url.pathname === "/api/integration") return ok(this.integrations)
    if (url.pathname === "/api/provider") return ok(this.providers)
    if (url.pathname === "/api/session/active") return ok(Object.fromEntries([...this.busy].map((id) => [id, { type: "busy" }])))
    const session = parts[2]
    const what = parts[3]
    // A seat deleted: gone, its run with it.
    if (request.method === "DELETE" && !what) {
      this.deleted.add(session)
      this.busy.delete(session)
      return ok()
    }
    if (this.deleted.has(session)) return Response.json({ message: "No such session." }, { status: 404 })
    if (request.method === "GET" && !what) {
      const own = session.startsWith("ses_own_") ? this.ownModels[session.slice("ses_own_".length)] : undefined
      return ok({ id: session, model: own ?? { id: "m", providerID: "p" } })
    }
    if (what === "prompt" && this.stuck.has(this.seats.get(session) ?? "")) {
      this.queued.set(session, [...(this.queued.get(session) ?? []), { id: body.id }])
      return ok()
    }
    if (what === "prompt") {
      const bot = this.seats.get(session)
      const owner = session.startsWith("ses_own_") ? session.slice("ses_own_".length) : undefined
      const line = bot ? (this.lines[bot]?.shift() ?? "PASS") : owner ? (this.reports[owner] ?? "") : ""
      const at = Date.now()
      const conversation = this.conversations.get(session) ?? []
      conversation.push({ type: "user", id: body.id, time: { created: at }, text: body.text })
      if (bot && this.asking.has(bot)) this.permissions.set(session, [{ id: "per_" + session }])
      const refused = bot ? this.failing.get(bot) : undefined
      if (refused) {
        conversation.push({ type: "assistant", id: body.id + "_a", time: { created: at + 1, completed: at + 2 }, agent: "build", model: { id: "m", providerID: "p" }, content: [], error: { message: refused } })
      } else if (line) {
        const size = bot ? this.sizes[bot] : undefined
        conversation.push({ type: "assistant", id: body.id + "_a", time: { created: at + 1, completed: at + 2 }, agent: "build", model: { id: "m", providerID: "p" }, content: [{ type: "text", text: line }],
          ...(size ? { tokens: { input: size, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } : {}) })
      }
      const finish = () => {
        conversation.push({ type: "idle", id: body.id + "_i", time: { created: at + 3 }, outcome: "succeeded" })
        this.conversations.set(session, conversation)
        this.busy.delete(session)
      }
      const delay = (bot ? this.slow.get(bot) : undefined) ?? [...this.slowPrompts].find(([text]) => String(body.text).includes(text))?.[1]
      if (delay) {
        // At work a while, its answer not there yet.
        const said = conversation.pop()
        const thinking = bot ? this.working.get(bot) : undefined
        if (thinking) {
          conversation.push({ type: "assistant", id: body.id + "_w", time: { created: at + 1 }, agent: "build", model: { id: "m", providerID: "p" }, content: [
            { type: "reasoning", text: thinking },
            { type: "tool", id: "call_r", name: "read", state: { status: "completed", input: { path: "notes.txt" }, content: [{ type: "text", text: "what the notes say" }] } },
          ] })
        }
        this.conversations.set(session, conversation)
        this.busy.add(session)
        setTimeout(() => {
          if (said?.type === "assistant") conversation.push(said)
          finish()
        }, delay)
      } else {
        finish()
      }
      return ok()
    }
    if (what === "message") return ok([...(this.conversations.get(session) ?? [])].reverse())
    if (what === "inbox" && request.method === "GET") return ok(this.queued.get(session) ?? [])
    if (what === "inbox" && request.method === "DELETE") {
      this.queued.set(session, (this.queued.get(session) ?? []).filter((item) => item.id !== parts[4]))
      return ok()
    }
    if (what === "permission" && request.method === "GET") return ok(this.permissions.get(session) ?? [])
    if (what === "permission") {
      this.permissions.delete(session)
      return ok()
    }
    if (what === "form") return ok([])
    return ok()
  }
}

let root: string
let engine: Engine
let events: ServerEvent[]
let unsubscribe: () => void

function bot(id: string, name: string, memory = `# ${name}'s memory\n\n## Job\nHelps with the release\n`) {
  const folder = join(root, "bots", id)
  mkdirSync(join(folder, "workspace"), { recursive: true })
  writeFileSync(join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id, name, job: "Helps", look: { color: "mint", shape: "round", face: "calm" }, model: { id: "m", providerID: "p" }, created: stamp(), updated: stamp() }))
  writeFileSync(join(folder, "session"), "ses_own_" + name)
  writeFileSync(join(folder, "directory"), join(folder, "workspace"))
  writeFileSync(join(folder, "MEMORY.md"), memory)
}

function group(meeting?: Group["meeting"]): Group {
  return { id: "grp_team000001", name: "Team", members: ["bot_ada", "bot_ben"], seats: {}, heard: {}, created: stamp(), ...(meeting ? { meeting } : {}) }
}

function runner() {
  const store = new GroupStore(join(root, "groups"), join(root, "bots"))
  const groups = new GroupRunner({ store, engine: server(engine.url, "x"), bridge: () => undefined, trash: join(root, "trash"), pace: 0.05 })
  return { store, groups }
}

async function until(condition: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!condition() && Date.now() < end) await Bun.sleep(10)
  expect(condition()).toBe(true)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-groups-"))
  engine = new Engine()
  bot("bot_ada", "Ada")
  bot("bot_ben", "Ben")
  events = []
  unsubscribe = subscribe((event) => events.push(event))
})

afterEach(() => {
  unsubscribe()
  engine.stop()
  rmSync(root, { recursive: true, force: true })
})

describe("a group chat on a machine", () => {
  test("a bot whose account was signed out of says so, rather than going without a word", async () => {
    const { groups } = runner()
    engine.integrations = [{ id: "p", name: "Provider P", methods: [{ type: "key" }], connections: [] }]
    engine.providers = [{ id: "opencode" }]
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Anyone there?")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.kind === "note") ?? false))
    const notes = groups.get("grp_team000001")!.messages.filter((message) => message.kind === "note").map((message) => message.text)
    expect(notes[0]).toBe("Ada couldn’t answer: m needs a sign-in on this machine: sign in to Provider P in Settings › Accounts, or choose another model.")
    expect(engine.prompts().length).toBe(0)
  })

  test("a model that needs no sign-in (OpenCode Zen's free ones) answers, with nothing connected", async () => {
    const { groups } = runner()
    // Zen's account has ways to sign in, none made, and the engine has it ready all the same.
    engine.integrations = [{ id: "p", name: "OpenCode Zen", methods: [{ type: "key" }, { type: "oauth" }], connections: [] }]
    engine.providers = [{ id: "p" }]
    engine.lines = { Ada: ["Hello!", "PASS"], Ben: ["PASS"] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Anyone there?")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.author === "bot_ada") ?? false))
    expect(groups.get("grp_team000001")!.messages.some((message) => message.kind === "note")).toBe(false)
  })

  test("a bot whose own model's account was signed out of talks on what its conversation is on now", async () => {
    const { groups } = runner()
    engine.integrations = [{ id: "p", name: "Provider P", methods: [{ type: "key" }], connections: [] }, { id: "zen", name: "Zen", methods: [], connections: [] }]
    engine.providers = [{ id: "zen" }]
    engine.ownModels = { Ada: { id: "q", providerID: "zen" }, Ben: { id: "q", providerID: "zen" } }
    engine.lines = { Ada: ["Hello!", "PASS"], Ben: ["PASS"] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Anyone there?")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.author === "bot_ada") ?? false))
    expect(groups.get("grp_team000001")!.messages.some((message) => message.kind === "note")).toBe(false)
    const seat = engine.requests.find((request) => request.method === "POST" && request.path === "/api/session" && String(request.body.title).startsWith("Ada"))
    expect(seat?.body.model).toEqual({ id: "q", providerID: "zen" })
  })

  test("a provider of the project's own settings, which the engine lists only there, isn't taken for signed out", async () => {
    const { groups } = runner()
    engine.integrations = []
    engine.providers = [{ id: "opencode" }]
    engine.lines = { Ada: ["Hello!", "PASS"], Ben: ["PASS"] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Anyone there?")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.author === "bot_ada") ?? false))
    expect(groups.get("grp_team000001")!.messages.some((message) => message.kind === "note")).toBe(false)
  })

  test("a provider that turns a bot's sign-in down is said in words that say what to do", async () => {
    const { groups } = runner()
    engine.failing.set("Ada", "Missing required Authorization header")
    engine.lines = { Ben: ["PASS"] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Anyone there?")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.kind === "note") ?? false))
    const notes = groups.get("grp_team000001")!.messages.filter((message) => message.kind === "note").map((message) => message.text)
    expect(notes[0]).toBe("Ada couldn’t answer: Provider P isn’t signed in on this machine: sign in to it again in Settings › Accounts, or choose another model.")
  })

  test("the lead first, nobody twice in a row, until everyone passes; then the wrap-up and the work", async () => {
    const { groups, store } = runner()
    engine.lines = { Ada: ["Let's ship. &Ben, the build?", "Agreed.", "PASS", "We ship Friday; Ben fixes the build.", "&Ada: write the notes\n&Ben (after &Ada): fix the build\nGO"], Ben: ["Build is red; I'll fix it.", "Done soon."] }
    engine.reports = { Ada: "Notes written.", Ben: "Build fixed." }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Should we ship this week? Go ahead and do it.")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.report !== undefined && message.author === "bot_ben") ?? false), 8000)
    const messages = groups.get("grp_team000001")!.messages
    const talk = messages.filter((message) => message.kind === "message" && message.report === undefined).map((message) => message.author ?? "you")
    expect(talk).toEqual(["you", "bot_ada", "bot_ben", "bot_ada", "bot_ben"])
    const wrapUp = messages.find((message) => message.kind === "wrapUp")!
    expect(wrapUp.author).toBe("bot_ada")
    expect(wrapUp.tasks?.map((task) => [task.bot, task.state])).toEqual([
      ["bot_ada", "done"],
      ["bot_ben", "done"],
    ])
    // Ben's part started with Ada's report.
    const benPart = engine.prompts("ses_own_Ben")[0]?.body.text as string
    expect(benPart).toContain("[Work from Team · grp_team000001]")
    expect(benPart).toContain("**Ada**: Notes written.")
    expect(messages.filter((message) => message.report !== undefined).map((message) => message.text)).toEqual(["Notes written.", "Build fixed."])
    // Each seat made once, with its rules, told who it is; the chat kept on disk as the Mac writes it.
    // The work list asked apart from Ada's seat, given the whole chat, in a conversation that goes
    // once it's answered.
    expect(engine.seatsMade()).toEqual(["Ada in Team", "Ben in Team", "Ada handing out the work in Team"])
    const asked = engine.prompts().find((request) => String(request.body.text).includes("For the app, not the chat"))!
    expect(asked.body.text).toContain('Everything said in "Team" so far, from the start:')
    expect(asked.body.text).toContain("You (wrap-up):")
    const listed = asked.path.split("/")[3]
    await until(() => engine.requests.some((request) => request.method === "DELETE" && request.path === `/api/session/${listed}`))
    const seat = engine.requests.find((request) => request.method === "POST" && request.path === "/api/session")!
    expect(seat.body.permissions.some((rule: any) => rule.action === "edit" && rule.effect === "deny")).toBe(true)
    const told = engine.requests.find((request) => request.method === "PUT" && request.path.endsWith("/instructions/entries/kuvo.seat"))!
    expect(told.body.value).toContain("You are Ada, one of the user's bots in Kuvo Code: Helps with the release.")
    expect(told.body.value).toContain("You lead it.")
    const kept = JSON.parse(readFileSync(join(root, "groups", "grp_team000001", "group.json"), "utf8"))
    expect(kept.kuvo).toBe(1)
    expect(Object.keys(kept.group.seats).sort()).toEqual(["bot_ada", "bot_ben"])
    expect(store.read("grp_team000001")!.messages.length).toBe(messages.length)
    // Its bots remember it in their own conversations, under the machine's key.
    await until(() => engine.requests.some((request) => request.path.endsWith("/instructions/entries/kuvo.groups.machine")), 6000)
    expect(existsSync(join(root, "bots", "bot_ada", "groups", "grp_team000001.md"))).toBe(true)
    expect(events.some((event) => event.type === "kuvo.group.done")).toBe(true)
  }, 20_000)

  test("a bot outside the chat that you name with & answers as a guest, in a conversation of its own that goes", async () => {
    const { groups } = runner()
    bot("bot_carl", "Carl")
    engine.lines = { Carl: ["Carl here: ship it."], Ada: ["PASS"], Ben: ["PASS"] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "&Carl, what do you think?")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.author === "bot_carl") ?? false))
    const kept = groups.get("grp_team000001")!
    expect(kept.messages.find((message) => message.author === "bot_carl")?.text).toBe("Carl here: ship it.")
    expect(kept.group.members).toEqual(["bot_ada", "bot_ben"])
    expect(kept.group.seats.bot_carl).toBeUndefined()
    const asked = engine.prompts().find((request) => String(request.body.text).startsWith("You're not in"))!
    expect(asked.body.text).toStartWith(`You're not in "Team", but the user named you there with &Carl, so you answer this once, as a guest.`)
    expect(asked.body.text).toContain("&Carl, what do you think?")
    const session = asked.path.split("/")[3]
    await until(() => engine.requests.some((request) => request.method === "DELETE" && request.path === `/api/session/${session}`))
  })

  test("a seat grown well past the chat starts over at the bot's next turn, given the whole chat", async () => {
    const { groups } = runner()
    engine.sizes = { Ada: 40_000 }
    engine.lines = { Ada: ["Hi there.", "PASS", "Still here."], Ben: ["PASS", "PASS"] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Anyone there?")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.text === "Hi there.") ?? false))
    // Her seat went, with what it carried.
    const first = engine.prompts().find((request) => String(request.body.text).includes("Anyone there?"))!.path.split("/")[3]
    await until(() => engine.requests.some((request) => request.method === "DELETE" && request.path === `/api/session/${first}`))
    expect(groups.get("grp_team000001")!.group.seats.bot_ada).toBeUndefined()
    engine.sizes = {}
    groups.send("grp_team000001", "Again?")
    await until(() => !groups.talk("grp_team000001").discussing && (groups.get("grp_team000001")?.messages.some((message) => message.text === "Still here.") ?? false))
    expect(engine.seatsMade().filter((title) => title === "Ada in Team").length).toBe(2)
    const fresh = engine.prompts().find((request) => String(request.body.text).includes("Again?"))!.body.text as string
    expect(fresh).toStartWith(`Everything said in "Team" so far, from the start:`)
    expect(fresh).toContain("You:\n    Hi there.")
    expect(fresh).toContain("User:\n    Anyone there?")
  })

  test("writing while the work is handed out stops it, and your message has the next turn", async () => {
    const { groups } = runner()
    engine.slowPrompts.set("For the app, not the chat", 3000)
    engine.lines = { Ada: ["Let's ship. &Ben?", "Agreed.", "We ship.", "NONE", "Hello again."], Ben: ["Yes.", "PASS", "PASS"] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Should we ship?")
    await until(() => engine.prompts().some((request) => String(request.body.text).includes("For the app, not the chat")), 8000)
    const list = engine.prompts().find((request) => String(request.body.text).includes("For the app, not the chat"))!.path.split("/")[3]
    groups.send("grp_team000001", "One more thing")
    await until(() => engine.requests.some((request) => request.path === `/api/session/${list}/interrupt`), 3000)
    await until(() => engine.requests.some((request) => request.method === "DELETE" && request.path === `/api/session/${list}`))
    await until(() => groups.get("grp_team000001")?.messages.some((message) => message.text === "Hello again.") ?? false, 8000)
    expect(groups.get("grp_team000001")!.messages.find((message) => message.kind === "wrapUp")?.tasks).toBeUndefined()
  }, 20_000)

  test("a bot you name with @ speaks first", async () => {
    const { groups } = runner()
    engine.lines = { Ada: [], Ben: ["Here."] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "&Ben, are you there?")
    await until(() => !groups.talk("grp_team000001").discussing && groups.get("grp_team000001")!.messages.length > 1)
    expect(groups.get("grp_team000001")!.messages.filter((message) => message.author).map((message) => message.author)).toEqual(["bot_ben"])
  })

  test("a long debate pauses, and Keep Going carries on", async () => {
    const { groups } = runner()
    engine.lines = { Ada: Array.from({ length: 8 }, (_, index) => `Ada ${index}`), Ben: Array.from({ length: 8 }, (_, index) => `Ben ${index}`) }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Debate it.")
    await until(() => groups.talk("grp_team000001").paused && !groups.talk("grp_team000001").discussing, 8000)
    const said = () => groups.get("grp_team000001")!.messages.filter((message) => message.author && message.kind === "message").length
    expect(said()).toBe(6)
    groups.keepGoing("grp_team000001")
    await until(() => said() > 6 && !groups.talk("grp_team000001").discussing, 8000)
  }, 20_000)

  test("undo from your message", async () => {
    const { groups } = runner()
    engine.lines = { Ada: ["First thought."], Ben: [] }
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Hello")
    await until(() => !groups.talk("grp_team000001").discussing && groups.get("grp_team000001")!.messages.length >= 2)
    const yours = groups.get("grp_team000001")!.messages[0]
    expect(groups.undo("grp_team000001", yours.id)).toBe("Hello")
    expect(groups.get("grp_team000001")!.messages).toEqual([])
    expect(groups.get("grp_team000001")!.group.retracted?.bot_ada).toBe("Hello")
    expect(events.some((event) => event.type === "kuvo.group.reset")).toBe(true)
  })

  test("stopped while a bot talks: what it says then doesn't reach the chat", async () => {
    const { groups } = runner()
    engine.lines = { Ada: ["A long answer."], Ben: [] }
    engine.slow.set("Ada", 400)
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Go")
    await until(() => groups.talk("grp_team000001").speaking === "bot_ada" && engine.prompts().length > 0)
    groups.stop("grp_team000001")
    await Bun.sleep(700)
    expect(groups.get("grp_team000001")!.messages.map((message) => message.author ?? "you")).toEqual(["you"])
    expect(engine.requests.some((request) => request.path.endsWith("/interrupt"))).toBe(true)
  })

  test("a bot taken out of the chat as it speaks: the chat goes on without it", async () => {
    const { groups } = runner()
    engine.lines = { Ada: ["A long answer."], Ben: ["Here."] }
    // Never done by itself.
    engine.slow.set("Ada", 60_000)
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Go")
    await until(() => groups.talk("grp_team000001").speaking === "bot_ada" && engine.prompts().length > 0)
    await groups.update("grp_team000001", { members: ["bot_ben"] })
    await until(() => !groups.talk("grp_team000001").discussing)
    expect(groups.get("grp_team000001")!.messages.some((message) => message.author === "bot_ben")).toBe(true)
    // It left quietly: no note that it couldn't answer.
    expect(groups.get("grp_team000001")!.messages.filter((message) => message.kind === "note")).toEqual([])
  })

  test("what a bot does on its turn shows while it's at it, and goes when it's done", async () => {
    const { groups } = runner()
    engine.lines = { Ada: ["Here's the plan."], Ben: [] }
    engine.slow.set("Ada", 1500)
    engine.working.set("Ada", "**Checking the notes**\nReading what we wrote")
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Plan?")
    await until(() => (groups.talk("grp_team000001").activity?.length ?? 0) > 0)
    // Its last step only: the file it read after thinking, without what the file said.
    const shown: any[] = groups.talk("grp_team000001").activity!
    expect(shown.map((step) => step.kind)).toEqual(["tool"])
    expect(shown[0].call.state.input.path).toBe("notes.txt")
    expect(shown[0].call.state.content).toEqual([])
    await until(() => !groups.talk("grp_team000001").discussing, 8000)
    expect(groups.talk("grp_team000001").activity).toBeUndefined()
  })

  test("what a bot thinks shows as it thinks, from the engine's stream, before its messages have it", async () => {
    const store = new GroupStore(join(root, "groups"), join(root, "bots"))
    const listeners = new Map<string, { event(event: any): void }>()
    const groups = new GroupRunner({
      store, engine: server(engine.url, "x"), bridge: () => undefined, trash: join(root, "trash"), pace: 0.05,
      listen: (session, listener) => {
        listeners.set(session, listener)
        return () => listeners.delete(session)
      },
    })
    engine.lines = { Ada: ["Sushi it is."], Ben: [] }
    engine.slow.set("Ada", 2000)
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Where for lunch?")
    await until(() => listeners.size > 0)
    const [listener] = [...listeners.values()]
    listener.event({ type: "session.reasoning.started", data: {} })
    listener.event({ type: "session.reasoning.delta", data: { delta: "**Thinking about lunch**\nLooking at the " } })
    listener.event({ type: "session.reasoning.delta", data: { delta: "menus" } })
    await until(() => (groups.talk("grp_team000001").activity as any[] | undefined)?.[0]?.kind === "thinking")
    expect(groups.talk("grp_team000001").activity).toEqual([{ kind: "thinking", text: "Looking at the" }])
    await Bun.sleep(350)
    listener.event({ type: "session.reasoning.delta", data: { delta: "!" } })
    await until(() => (groups.talk("grp_team000001").activity as any[] | undefined)?.[0]?.text === "Looking at the menus!")
    listener.event({ type: "session.text.started", data: {} })
    await until(() => (groups.talk("grp_team000001").activity as any[] | undefined)?.[0]?.kind === "writing")
    await until(() => !groups.talk("grp_team000001").discussing, 8000)
    expect(listeners.size).toBe(0)
  })

  test("a bot whose message stays queued (held after a stop) is woken, then passes", async () => {
    const { groups } = runner()
    engine.lines = { Ada: [], Ben: ["Here."] }
    engine.stuck.add("Ada")
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Anyone?")
    await until(() => !groups.talk("grp_team000001").discussing && groups.get("grp_team000001")!.messages.length >= 2, 8000)
    expect(engine.requests.some((request) => request.method === "PATCH" && request.path.includes("/inbox/") && request.body.delivery === "steer")).toBe(true)
    expect(engine.requests.some((request) => request.method === "DELETE" && request.path.includes("/inbox/"))).toBe(true)
    expect(groups.get("grp_team000001")!.messages.at(-1)?.author).toBe("bot_ben")
  }, 15_000)

  test("a meeting in a time zone this machine doesn't know comes once, on its own clock", () => {
    const { groups, store } = runner()
    store.writeSettings({ personalities: {}, identityNote: "", askFirst: false, denies: [], timeZone: "GMT+0300" })
    groups.put(group({ next: stamp(new Date(Date.now() - 1000)), every: "1d", topic: "Standup" }), [], "active", false)
    groups.meetDue()
    groups.meetDue()
    groups.stop("grp_team000001")
    expect(groups.get("grp_team000001")!.messages.filter((message) => message.kind === "meeting").length).toBe(1)
    expect(Date.parse(groups.get("grp_team000001")!.group.meeting!.next)).toBeGreaterThan(Date.now())
  })

  test("a seat that asks permission is turned down: nobody's there to answer", async () => {
    const { groups } = runner()
    engine.lines = { Ada: ["Checked."], Ben: [] }
    engine.asking.add("Ada")
    groups.put(group(), [], "active", false)
    groups.send("grp_team000001", "Check something")
    await until(() => engine.requests.some((request) => request.method === "POST" && request.path.endsWith("/reply")))
    const reply = engine.requests.find((request) => request.path.endsWith("/reply"))!
    expect(reply.body.decision).toBe("reject")
  })

  test("a meeting comes once and clears; a repeating one moves on, in the user's time zone", async () => {
    const { groups, store } = runner()
    store.writeSettings({ personalities: {}, identityNote: "", askFirst: false, denies: [], timeZone: "Europe/Istanbul" })
    const due = new Date(Date.now() - 1000)
    groups.put(group({ next: stamp(due), topic: "Standup: what's new?" }), [], "active", false)
    expect(existsSync(join(root, "groups", "grp_team000001", "awake"))).toBe(true)
    groups.meetDue()
    expect(groups.get("grp_team000001")!.messages[0]?.kind).toBe("meeting")
    expect(groups.get("grp_team000001")!.group.meeting).toBeUndefined()
    groups.stop("grp_team000001")
    expect(existsSync(join(root, "groups", "grp_team000001", "awake"))).toBe(false)

    const daily = { ...group({ next: "2027-01-14T06:00:00Z", every: "1d", topic: "Standup" }), id: "grp_daily00001" }
    groups.put(daily, [], "active", false)
    groups.meetDue(Date.parse("2027-01-14T06:00:30Z"))
    groups.stop("grp_daily00001")
    // 9:00 in Istanbul, the next day.
    expect(groups.get("grp_daily00001")!.group.meeting).toEqual({ next: "2027-01-15T06:00:00Z", every: "1d", topic: "Standup", at: 540 })
  })

  test("a chat brought here waits until it's started; one here already isn't replaced", async () => {
    const { groups } = runner()
    const due = new Date(Date.now() - 1000)
    expect(groups.put(group({ next: stamp(due), topic: "Standup" }), [], "held", false)).toBe(true)
    groups.meetDue()
    expect(groups.get("grp_team000001")!.messages).toEqual([])
    expect(groups.send("grp_team000001", "Hello")).toBeUndefined()
    expect(groups.put(group(), [], "active", false)).toBe(false)
    groups.activate("grp_team000001")
    groups.meetDue()
    expect(groups.get("grp_team000001")!.messages.map((message) => message.kind)).toEqual(["meeting"])
    groups.stop("grp_team000001")
  })

  test("one talking when the engine started over waits for Keep Going", () => {
    const { store } = runner()
    store.saveGroup({ group: group(), status: "active", talking: true, messages: [] })
    const { groups } = runner()
    expect(groups.talk("grp_team000001")).toEqual({ speaking: undefined, discussing: false, paused: true })
  })

  test("let go of (moved away), its seats stay; deleted, they go", async () => {
    const { groups } = runner()
    const seated = { ...group(), seats: { bot_ada: "ses_seatA" } }
    groups.put(seated, [], "active", false)
    expect(groups.hold("grp_team000001")?.group.seats).toEqual({ bot_ada: "ses_seatA" })
    groups.release("grp_team000001")
    expect(groups.get("grp_team000001")).toBeUndefined()
    expect(engine.requests.some((request) => request.method === "DELETE" && request.path === "/api/session/ses_seatA")).toBe(false)
    expect(existsSync(join(root, "trash"))).toBe(true)

    groups.put({ ...seated, id: "grp_other00001" }, [], "active", false)
    await groups.delete("grp_other00001")
    expect(engine.requests.some((request) => request.method === "DELETE" && request.path === "/api/session/ses_seatA")).toBe(true)
  })

  test("its routes: the list, a chat that's here already, one that's moving", async () => {
    const { groups, store } = runner()
    const call = (method: string, parts: string[], body: unknown = {}) => groupRoutes(groups, store, method, parts, async () => body)
    expect((await call("PUT", ["grp_team000001"], { group: group(), messages: [], status: "held" })).status).toBe(200)
    expect((await call("PUT", ["grp_team000001"], { group: group(), messages: [], status: "held" })).status).toBe(409)
    expect((await call("POST", ["grp_team000001", "send"], { text: "Hi" })).status).toBe(409)
    const listed: any = await (await call("GET", [])).json()
    expect(listed.data.map((each: any) => [each.group.id, each.status])).toEqual([["grp_team000001", "held"]])
    expect((await call("PUT", ["grp_other00001"], { group: group(), messages: [] })).status).toBe(400)
    expect((await call("GET", ["../x"])).status).toBe(404)
  })
})
