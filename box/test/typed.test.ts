// What a typed message means (PROTOCOL.md, "What a typed message means"): the words read as every
// client reads them (protocol/vectors/typed.json, which KuvoClient's TypedVectorsTests
// holds the apps' Swift to as well), and `kuvo/sessions/<id>/typed` deciding and doing it, with the
// engine and the agents bridge as stand-ins (their HTTP APIs) and the box's code real.

import "./safety"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { decide, KEYWORD_UNAVAILABLE } from "../src/link/typed/decide"
import { commandsOffered, firstWake, focusAsked, parseCommand, parseGoal, parseKeyword, parseLoop, parseReview, repeatText, reviewUnfinished, scopeAsked, shellCommand, splitCommand } from "../src/link/typed/words"
import type { AnswerPiece, RouteContext } from "../src/link/server/context"

const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/typed.json", import.meta.url), "utf8"))

describe("the words, as every client reads them", () => {
  test.each(vectors.keywords.map((each: any) => [each.text, each]))("keyword: %j", (_, each: any) => {
    expect(parseKeyword(each.text)).toEqual(each.parsed)
  })
  test.each(vectors.goals.map((each: any) => [each.text, each]))("goal: %j", (_, each: any) => {
    expect(parseGoal(each.text)).toEqual(each.goal)
  })
  test.each(vectors.loops.map((each: any) => [each.rest, each]))("loop: %j", (_, each: any) => {
    const loop = parseLoop(each.rest)
    const schedule = loop.schedule ? { every: repeatText(loop.schedule.every), ...(loop.schedule.hour !== undefined ? { hour: loop.schedule.hour, minute: loop.schedule.minute } : {}) } : null
    expect({ schedule, message: loop.message, scheduleLength: loop.scheduleLength, scheduleText: loop.scheduleText }).toEqual({ schedule: each.schedule, message: each.message, scheduleLength: each.scheduleLength, scheduleText: each.scheduleText })
  })
  test.each(vectors.firstWakes.map((each: any) => [`${each.rest} at ${each.now} in ${each.timeZone}`, each]))("first wake: %s", (_, each: any) => {
    expect(new Date(firstWake(parseLoop(each.rest).schedule!, Date.parse(each.now), each.timeZone)).toISOString()).toBe(each.due)
  })
  test.each(vectors.reviews.map((each: any) => [each.rest, each]))("review: %j", (_, each: any) => {
    const review = parseReview(each.rest, vectors.reviewReaders, each.preferring)
    expect({
      scope: review.scope, described: review.described, preset: review.preset, reader: review.reader?.ref ?? null, focus: review.focus, readerLength: review.readerLength,
      searching: review.searching, asking: review.asking, head: review.head, scopeAsked: scopeAsked(review), focusAsked: focusAsked(review), unfinished: reviewUnfinished(review),
    }).toEqual({
      scope: each.scope, described: each.described, preset: each.preset, reader: each.reader, focus: each.focus, readerLength: each.readerLength,
      searching: each.searching, asking: each.asking, head: each.head, scopeAsked: each.scopeAsked, focusAsked: each.focusAsked, unfinished: each.unfinished,
    })
  })
  test.each(vectors.commands.map((each: any) => [each.text, each]))("command: %j", (_, each: any) => {
    const offered = commandsOffered(each.commands.map((name: string) => ({ name })), each.keywords)
    expect(offered.map(command => command.name)).toEqual(each.offered)
    expect(splitCommand(each.text)).toEqual(each.split)
    expect(parseCommand(each.text, offered)).toEqual(each.parsed)
  })
  test.each(vectors.shell.map((each: any) => [each.text, each]))("shell: %j", (_, each: any) => {
    expect(shellCommand(each.text)).toBe(each.command)
  })
})

describe("what a whole text means", () => {
  test.each(vectors.decide.map((each: any) => [each.text, JSON.stringify(each.facts), each]))("%j with %s", (_, __, each: any) => {
    const facts = { ...vectors.decideFacts, ...each.facts }
    const decided = decide(each.text, {
      ...facts,
      commands: facts.commands.map((name: string) => ({ name })),
      readers: facts.keywords.includes("review") ? vectors.reviewReaders : [],
      now: Date.parse(facts.now),
    })
    expect(JSON.parse(JSON.stringify(decided))).toEqual(each.decision)
  })
})

// ——— The route ———

type Asked = { method: string; path: string; folder: string | null; body: any }
type Conversation = { id: string; parentID?: string; agent?: string; model?: { providerID: string; id: string }; location: { directory: string }; time: { created: number; updated: number }; metadata?: any }

let engine: ReturnType<typeof Bun.serve>
let bridge: ReturnType<typeof Bun.serve>
let engineAsked: Asked[] = []
let bridgeAsked: Asked[] = []
let conversations: Record<string, Conversation> = {}
/** The coding agents' conversations, the bridge's. */
let bridgeConversations: Record<string, Conversation> = {}
let bridgeRuns = true
const COMMANDS = { status: 200, body: { data: [{ name: "init", description: "Set it up" }, { name: "review", description: "Review" }, { name: "goal", description: "Goal" }] } as unknown }
let commandsAnswer = COMMANDS
/** What the engine lists of its providers, models and accounts (by path), where a test says. */
let engineLists: Record<string, unknown> = {}
/** Held: the bridge answers once it's let go (`release`), and says when it's asked (`reached`). */
let held: { reached: () => void; release: Promise<void> } | null = null
/** What the bridge answers a goal, side question, handoff or review: its status and body. */
let bridgeSays: (asked: Asked) => { status: number; body: unknown } = () => ({ status: 200, body: {} })
let typedRoute: typeof import("../src/link/areas/typed").typedRoute
let forgetModelLists: () => void
let forgetModelNames: () => void
let TYPED_SENT: string
let TYPED_ROUTE: RegExp

const asked = async (request: Request): Promise<Asked> => {
  const url = new URL(request.url)
  const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text()
  const folder = request.headers.get("x-opencode-directory")
  return { method: request.method, path: url.pathname, folder: folder ? decodeURIComponent(folder) : null, body: text ? JSON.parse(text) : null }
}

function startBridge() {
  bridge = Bun.serve({
    port: 0,
    async fetch(request) {
      const each = await asked(request)
      bridgeAsked.push(each)
      if (held && each.method === "POST") {
        held.reached()
        await held.release
      }
      // (It has none of the engine's conversations: its own only.)
      const own = /^\/api\/session\/([^/]+)$/.exec(each.path)?.[1]
      if (own && bridgeConversations[decodeURIComponent(own)]) return Response.json({ data: bridgeConversations[decodeURIComponent(own)] })
      if (/^\/api\/session\//.test(each.path)) return Response.json({ message: "Not here." }, { status: 404 })
      const said = bridgeSays(each)
      return Response.json(said.body, { status: said.status })
    },
  })
}

beforeAll(async () => {
  ;({ typedRoute, TYPED_ROUTE, TYPED_SENT } = await import("../src/link/areas/typed"))
  ;({ forgetModelLists, forgetModelNames } = await import("../src/link/work/model-rule"))
  engine = Bun.serve({
    port: 0,
    async fetch(request) {
      const each = await asked(request)
      engineAsked.push(each)
      const session = /^\/api\/session\/([^/]+)$/.exec(each.path)?.[1]
      if (session) {
        const conversation = conversations[decodeURIComponent(session)]
        if (!conversation) return Response.json({ message: "Not here." }, { status: 404 })
        if (each.method === "PATCH") Object.assign(conversation, each.body)
        return Response.json({ data: conversation })
      }
      const switched = /^\/api\/session\/([^/]+)\/agent$/.exec(each.path)
      if (switched && each.method === "POST") {
        const conversation = conversations[decodeURIComponent(switched[1])]
        if (conversation) conversation.agent = each.body.agent
        return Response.json({ data: {} })
      }
      if (each.path === "/api/command") return Response.json(commandsAnswer.body, { status: commandsAnswer.status })
      const listed = engineLists[each.path]
      if (listed !== undefined) return Response.json({ data: listed })
      return Response.json({ data: {} })
    },
  })
  startBridge()
})

afterAll(() => {
  engine.stop(true)
  bridge.stop(true)
})

beforeEach(() => {
  engineAsked = []
  bridgeAsked = []
  bridgeRuns = true
  commandsAnswer = COMMANDS
  engineLists = {}
  // (What the engine listed in one test isn't another's, nor the names it kept.)
  forgetModelLists()
  forgetModelNames()
  rmSync(TYPED_SENT, { force: true })
  held = null
  bridgeSays = () => ({ status: 200, body: {} })
  bridgeConversations = {}
  conversations = {
    ses_main: { id: "ses_main", location: { directory: "/srv/app" }, time: { created: 1, updated: 1 }, metadata: {} },
    ses_sub: { id: "ses_sub", parentID: "ses_main", location: { directory: "/srv/app" }, time: { created: 1, updated: 1 } },
  }
})

/** The route's answer to `method kuvo/sessions/<session>/typed` with `body`: its status and JSON. */
async function ask(method: string, session: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; json: any }> {
  const route = `kuvo/sessions/${session}/typed`
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }]
  const record = (server: ReturnType<typeof Bun.serve>) => ({ pid: process.pid, port: server.port!, password: "pw", version: "test" })
  const context = {
    request: { method, path: route, headers: {}, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)) },
    phone: undefined, signal, route,
    readEngine: () => record(engine), readBridge: () => record(bridge), bridge: () => (bridgeRuns ? record(bridge) : null),
    info: { name: "Test" }, phonesChanged: () => {}, hold: null, json,
    text: (status: number, words: string): AnswerPiece[] => [{ head: { status, headers: {} } }, { body: Buffer.from(words) }],
  } as unknown as RouteContext
  let status = 0
  const parts: Buffer[] = []
  for await (const piece of typedRoute(context, route.match(TYPED_ROUTE)!)) {
    if ("head" in piece) status = piece.head.status
    else parts.push(piece.body)
  }
  return { status, json: JSON.parse(Buffer.concat(parts).toString("utf8")) }
}

describe("kuvo/sessions/<id>/typed", () => {
  test("\"/\" offers every keyword while the bridge runs, and the engine's commands with /review as /review-quick and no /goal", async () => {
    const { status, json } = await ask("GET", "ses_main")
    expect(status).toBe(200)
    expect(json.keywords.map((each: any) => each.name)).toEqual(["goal", "loop", "plan", "autopilot", "review", "btw", "handoff", "compact"])
    expect(json.keywords[1]).toEqual({ name: "loop", title: "Loop", summary: "Repeat a message on a schedule", argument: "what to do each time" })
    expect(json.commands).toEqual([{ name: "init", description: "Set it up" }, { name: "review-quick", description: "The engine’s own review, in this conversation" }])
    expect(engineAsked.find(each => each.path === "/api/command")?.folder).toBe("/srv/app")
  })

  test("without the bridge, what it runs isn't offered; a subagent's conversation offers none", async () => {
    bridgeRuns = false
    expect((await ask("GET", "ses_main")).json.keywords.map((each: any) => each.name)).toEqual(["loop", "plan", "autopilot", "compact"])
    bridgeRuns = true
    expect((await ask("GET", "ses_sub")).json.keywords).toEqual([])
  })

  test("a plain message is the client's to send, with its quotes; the engine isn't asked for its commands", async () => {
    const { json } = await ask("POST", "ses_main", { text: "fix the tests", files: true })
    expect(json).toEqual({ send: { text: "fix the tests", quoted: true } })
    expect(engineAsked.some(each => each.path === "/api/command")).toBe(false)
  })

  test("a command of the engine's in the conversation's folder runs as typed", async () => {
    expect((await ask("POST", "ses_main", { text: "/init now" })).json).toEqual({ command: { name: "init", arguments: "now" } })
    expect((await ask("POST", "ses_main", { text: "/review-quick main" })).json).toEqual({ command: { name: "review", arguments: "main" } })
  })

  test("the engine's commands unread: a keyword still runs; what might be one of them waits, saying so", async () => {
    commandsAnswer = { status: 500, body: { message: "Restarting." } }
    expect((await ask("POST", "ses_main", { text: "/plan" })).json).toEqual({ keyword: "plan", agent: "plan" })
    expect((await ask("POST", "ses_main", { text: "/plan sketch it" })).json).toEqual({ keyword: "plan", agent: "plan", send: { text: "sketch it", typed: "/plan" } })
    const { status, json } = await ask("POST", "ses_main", { text: "/deploy prod" })
    expect(status).toBe(503)
    expect(json.message).toBeString()
  })

  test("/goal sets the goal on the bridge, and the answer shows it before its event comes", async () => {
    bridgeSays = each => ({ status: 200, body: { data: { session: "ses_main", condition: each.body.condition, state: "working" } } })
    const { json } = await ask("POST", "ses_main", { text: "/goal all tests pass" })
    expect(bridgeAsked.at(-1)).toMatchObject({ method: "PUT", path: "/api/kuvo/goals/ses_main", body: { condition: "all tests pass" } })
    expect(json).toEqual({ goal: { session: "ses_main", condition: "all tests pass", state: "working" } })
  })

  test("a goal the bridge turns down goes back as written, saying why in its words", async () => {
    bridgeSays = () => ({ status: 409, body: { message: "The goal is still being checked." } })
    const { json } = await ask("POST", "ses_main", { text: "/goal pause" })
    expect(json).toEqual({ restore: { text: "/goal pause", beside: "" }, error: "The goal is still being checked." })
  })

  test("/btw asks the bridge, and /review for security starts one there", async () => {
    bridgeSays = each => ({ status: 200, body: { data: each.path.includes("btw") ? { id: "q1", question: each.body.question } : { id: "r1", focus: each.body.focus } } })
    expect((await ask("POST", "ses_main", { text: "/btw why this way?" })).json).toEqual({ keyword: "btw", sideQuestion: { id: "q1", question: "why this way?" } })
    expect((await ask("POST", "ses_main", { text: "/review for security" })).json).toEqual({ keyword: "review", review: { id: "r1", focus: "security" } })
    expect(bridgeAsked.at(-1)).toMatchObject({ method: "POST", path: "/api/kuvo/reviews/ses_main", body: { focus: "security" } })
  })

  test("the bridge gone between the list and the send: a keyword it runs comes back, saying so", async () => {
    const keywords = (await ask("GET", "ses_main")).json.keywords
    expect(keywords.some((each: any) => each.name === "handoff")).toBe(true)
    bridge.stop(true)
    try {
      const { json } = await ask("POST", "ses_main", { text: "/handoff write the docs" })
      expect(json).toEqual({ keyword: "handoff", restore: { text: "/handoff write the docs", beside: "write the docs" }, error: KEYWORD_UNAVAILABLE })
    } finally {
      startBridge()
    }
  })

  test("/loop's wake-up that can't be kept on this computer: what was written goes back, saying why", async () => {
    const { json } = await ask("POST", "ses_main", { text: "/loop every 30 min check the build", files: true })
    expect(json.keyword).toBe("loop")
    expect(json.send).toBeUndefined()
    expect(json.restore).toEqual({ text: "/loop every 30 min check the build", beside: "every 30 min check the build" })
    expect(json.error).toBeString()
  })

  test("/autopilot with words: Autopilot on on its box first, then the words are the client's to send", async () => {
    const { json } = await ask("POST", "ses_main", { text: "/autopilot do it all" })
    expect(json).toEqual({ keyword: "autopilot", autopilot: { autopilot: true, decided: [] }, send: { text: "do it all", typed: "/autopilot" } })
    expect(conversations.ses_main.metadata?.kuvo?.autopilot).toBe(true)
    // Alone, the client turns it on or off, as its Mode menu does.
    expect((await ask("POST", "ses_main", { text: "/autopilot" })).json).toEqual({ keyword: "autopilot", toggleAutopilot: true })
  })

  test("the same send again, by its id (a link resending after its connection dropped): answered as it was, done once", async () => {
    bridgeSays = each => ({ status: 200, body: { data: { id: `q${bridgeAsked.length}`, question: each.body.question } } })
    const first = await ask("POST", "ses_main", { text: "/btw why this way?", id: "snd_1" })
    const again = await ask("POST", "ses_main", { text: "/btw why this way?", id: "snd_1" })
    expect(again).toEqual(first)
    expect(bridgeAsked.filter(each => each.method === "POST" && each.path === "/api/kuvo/btw/ses_main")).toHaveLength(1)
    // Another send, another question.
    await ask("POST", "ses_main", { text: "/btw why this way?", id: "snd_2" })
    expect(bridgeAsked.filter(each => each.method === "POST" && each.path === "/api/kuvo/btw/ses_main")).toHaveLength(2)
  })

  test("its link dropping mid-step: the same send again gets the real answer, the bridge asked once", async () => {
    const { forgetModelLists } = await import("../src/link/work/model-rule")
    forgetModelLists()
    let reached = () => {}
    let release = () => {}
    const asked = new Promise<void>(resolve => { reached = resolve })
    held = { reached: () => reached(), release: new Promise<void>(resolve => { release = resolve }) }
    bridgeSays = each => ({ status: 200, body: { data: { id: "q1", question: each.body.question } } })
    const dropped = new AbortController()
    const first = ask("POST", "ses_main", { text: "/btw why this way?", id: "snd_drop" }, dropped.signal)
    await asked
    // The phone's session drops: its request's signal ends; then the bridge answers.
    dropped.abort()
    release()
    await first.catch(() => null)
    const again = await ask("POST", "ses_main", { text: "/btw why this way?", id: "snd_drop" })
    expect(again.json).toEqual({ keyword: "btw", sideQuestion: { id: "q1", question: "why this way?" } })
    expect(bridgeAsked.filter(each => each.method === "POST" && each.path === "/api/kuvo/btw/ses_main")).toHaveLength(1)
  })

  test("a model its provider is retiring can still read a review: the composer offers it", async () => {
    engineLists = {
      "/api/provider": [{ id: "deepseek" }],
      "/api/model": [{ id: "v3", providerID: "deepseek", name: "DeepSeek V3", status: "deprecated" }, { id: "v4", providerID: "deepseek", name: "DeepSeek V4" }],
      "/api/integration": [{ id: "deepseek", name: "DeepSeek", methods: [{ type: "key" }], connections: [{ type: "credential" }] }],
      "/api/model/default": { providerID: "deepseek", id: "v4" },
    }
    bridgeSays = each => ({ status: 200, body: { data: { id: "r1", model: each.body.model } } })
    const { json } = await ask("POST", "ses_main", { text: "/review with DeepSeek V3 the parser" })
    expect(json).toEqual({ keyword: "review", review: { id: "r1", model: { providerID: "deepseek", id: "v3" } } })
  })

  test("\"/plan\" alone in Plan goes back to Build, or to the first mode there is where Build is off", async () => {
    expect((await ask("POST", "ses_main", { text: "/plan" })).json).toEqual({ keyword: "plan", agent: "plan" })
    // Switched by the box, so the next "/plan" reads it, whatever the client has sent since.
    expect(engineAsked.filter(each => each.method === "POST" && each.path === "/api/session/ses_main/agent").map(each => each.body.agent)).toEqual(["plan"])
    expect((await ask("POST", "ses_main", { text: "/plan" })).json).toEqual({ keyword: "plan", agent: "build" })
    conversations.ses_main.agent = "plan"
    engineLists = { "/api/agent": [{ id: "explore", mode: "subagent" }, { id: "draft", mode: "primary" }, { id: "plan", mode: "primary" }] }
    expect((await ask("POST", "ses_main", { text: "/plan" })).json).toEqual({ keyword: "plan", agent: "draft" })
    // With words, it stays in Plan.
    expect((await ask("POST", "ses_main", { text: "/plan the next step" })).json).toEqual({ keyword: "plan", agent: "plan", send: { text: "the next step", typed: "/plan" } })
  })

  test("the same send again after the box started again: answered as it was, its step not done twice", async () => {
    const { forgetEverythingSent } = await import("../src/link/server/sent-once")
    bridgeSays = each => ({ status: 200, body: { data: { id: "q1", question: each.body.question } } })
    const first = await ask("POST", "ses_main", { text: "/btw why this way?", id: "snd_restart" })
    // The box stops and starts again: what it held in memory is gone.
    forgetEverythingSent()
    const again = await ask("POST", "ses_main", { text: "/btw why this way?", id: "snd_restart" })
    expect(again).toEqual(first)
    expect(bridgeAsked.filter(each => each.method === "POST" && each.path === "/api/kuvo/btw/ses_main")).toHaveLength(1)
  })

  test("two \"/plan\" at once are two switches, one after the other", async () => {
    const [one, two] = await Promise.all([ask("POST", "ses_main", { text: "/plan" }), ask("POST", "ses_main", { text: "/plan" })])
    expect([one.json.agent, two.json.agent]).toEqual(["plan", "build"])
    expect(engineAsked.filter(each => each.method === "POST" && each.path === "/api/session/ses_main/agent").map(each => each.body.agent)).toEqual(["plan", "build"])
    expect(conversations.ses_main.agent).toBe("build")
  })

  test("\"/plan\" never goes back to Plan itself, listed first with Build off", async () => {
    conversations.ses_main.agent = "plan"
    engineLists = { "/api/agent": [{ id: "plan", mode: "primary" }, { id: "draft", mode: "primary" }] }
    expect((await ask("POST", "ses_main", { text: "/plan" })).json).toEqual({ keyword: "plan", agent: "draft" })
  })

  test("a model that can't run: said in the box's words with what to do, all of it kept; a \"!\" command still runs", async () => {
    engineLists = {
      "/api/provider": [{ id: "deepseek" }],
      "/api/model": [{ id: "v4", providerID: "deepseek", name: "DeepSeek V4" }, { id: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5" }],
      "/api/integration": [
        { id: "deepseek", name: "DeepSeek", methods: [{ type: "key" }], connections: [{ type: "credential" }] },
        { id: "anthropic", name: "Anthropic", methods: [{ type: "oauth", id: "browser" }, { type: "key" }], connections: [] },
      ],
      "/api/model/default": { providerID: "anthropic", id: "claude-opus-5-5" },
    }
    // (What a client sends as its own words is no longer what's said: the box decides.)
    expect((await ask("POST", "ses_main", { text: "/goal ship it", refusal: "Sign in to Anthropic again." })).json).toEqual({
      restore: { text: "/goal ship it" }, error: "Claude Opus 5.5 needs a sign-in to Anthropic: sign in, or choose another model.",
      action: { do: "signIn", label: "Sign In", help: "Sign in to Anthropic" },
    })
    expect((await ask("POST", "ses_main", { text: "!npm test" })).json).toEqual({ shell: "npm test" })
    // On a model that runs, it goes, whatever a client says.
    conversations.ses_main.model = { providerID: "deepseek", id: "v4" }
    expect((await ask("POST", "ses_main", { text: "fix it", refusal: "Sign in to Anthropic again." })).json).toEqual({ send: { text: "fix it", quoted: true } })
  })

  test("a coding agent's own subagent isn't refused for its model: its agent runs it on what it gives it", async () => {
    // Claude Code signed out on the bridge: its conversation is refused, its subagent isn't.
    bridgeSays = each => {
      if (each.path === "/api/integration") return { status: 200, body: { data: [{ id: "claude-code", name: "Claude Code", metadata: { source: "agent", installed: true, modelsComplete: true }, methods: [{ type: "oauth", id: "browser" }], connections: [] }] } }
      if (each.path === "/api/model") return { status: 200, body: { data: [] } }
      if (each.path === "/api/kuvo/auto") return { status: 200, body: { data: { lists: [] } } }
      return { status: 200, body: {} }
    }
    const on = { location: { directory: "/srv/app" }, time: { created: 1, updated: 1 }, model: { providerID: "claude-code", id: "opus" } }
    bridgeConversations = { ses_agent: { id: "ses_agent", ...on }, ses_agentSub: { id: "ses_agentSub", parentID: "ses_agent", ...on } }
    expect((await ask("POST", "ses_agent", { text: "fix it" })).json.error).toBe("opus needs a sign-in to Claude Code: sign in, or choose another model.")
    expect((await ask("POST", "ses_agentSub", { text: "fix it" })).json).toEqual({ send: { text: "fix it", quoted: true } })
  })

  test("none to run on: choose one; the engine not saying its lists lets it go, as a client does", async () => {
    engineLists = { "/api/provider": [{ id: "deepseek" }], "/api/model": [{ id: "v4", providerID: "deepseek", name: "DeepSeek V4" }], "/api/integration": [], "/api/model/default": null }
    expect((await ask("POST", "ses_main", { text: "fix it" })).json).toEqual({
      restore: { text: "fix it" }, error: "Choose a model to send it.", action: { do: "choose", label: "Choose a Model", help: "Choose a model" },
    })
    forgetModelLists()
    engineLists = {}
    expect((await ask("POST", "ses_main", { text: "fix it" })).json).toEqual({ send: { text: "fix it", quoted: true } })
  })

  test("a conversation that isn't here, and a send without text", async () => {
    const none = await ask("POST", "ses_none", { text: "/goal ship it" })
    expect(none.status).toBe(404)
    // What was written goes back as a keyword's does: beside words typed meanwhile, its words.
    expect(none.json).toEqual({ message: "There's no such conversation here.", restore: { text: "/goal ship it", beside: "ship it" } })
    expect((await ask("POST", "ses_main", {})).status).toBe(400)
  })
})
