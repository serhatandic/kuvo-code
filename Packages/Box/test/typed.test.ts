// What a typed message means (PROTOCOL.md, "What a typed message means"): the words read as every
// client reads them (Packages/KuvoLink/Vectors/typed.json, which KuvoClient's TypedVectorsTests
// holds the apps' Swift to as well), and `kuvo/sessions/<id>/typed` deciding and doing it, with the
// engine and the agents bridge as stand-ins (their HTTP APIs) and the box's code real.

import "./safety"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { decide, KEYWORD_UNAVAILABLE } from "../src/link/typed/decide"
import { commandsOffered, firstWake, focusAsked, parseCommand, parseGoal, parseKeyword, parseLoop, parseReview, repeatText, reviewUnfinished, scopeAsked, shellCommand, splitCommand } from "../src/link/typed/words"
import type { AnswerPiece, RouteContext } from "../src/link/server/context"

const vectors = JSON.parse(readFileSync(new URL("../../KuvoLink/Vectors/typed.json", import.meta.url), "utf8"))

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
type Conversation = { id: string; parentID?: string; location: { directory: string }; time: { created: number; updated: number }; metadata?: any }

let engine: ReturnType<typeof Bun.serve>
let bridge: ReturnType<typeof Bun.serve>
let engineAsked: Asked[] = []
let bridgeAsked: Asked[] = []
let conversations: Record<string, Conversation> = {}
let bridgeRuns = true
const COMMANDS = { status: 200, body: { data: [{ name: "init", description: "Set it up" }, { name: "review", description: "Review" }, { name: "goal", description: "Goal" }] } as unknown }
let commandsAnswer = COMMANDS
/** What the bridge answers a goal, side question, handoff or review: its status and body. */
let bridgeSays: (asked: Asked) => { status: number; body: unknown } = () => ({ status: 200, body: {} })
let typedRoute: typeof import("../src/link/areas/typed").typedRoute
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
      // (It has none of the engine's conversations.)
      if (/^\/api\/session\//.test(each.path)) return Response.json({ message: "Not here." }, { status: 404 })
      const said = bridgeSays(each)
      return Response.json(said.body, { status: said.status })
    },
  })
}

beforeAll(async () => {
  ;({ typedRoute, TYPED_ROUTE } = await import("../src/link/areas/typed"))
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
      if (each.path === "/api/command") return Response.json(commandsAnswer.body, { status: commandsAnswer.status })
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
  bridgeSays = () => ({ status: 200, body: {} })
  conversations = {
    ses_main: { id: "ses_main", location: { directory: "/srv/app" }, time: { created: 1, updated: 1 }, metadata: {} },
    ses_sub: { id: "ses_sub", parentID: "ses_main", location: { directory: "/srv/app" }, time: { created: 1, updated: 1 } },
  }
})

/** The route's answer to `method kuvo/sessions/<session>/typed` with `body`: its status and JSON. */
async function ask(method: string, session: string, body?: unknown): Promise<{ status: number; json: any }> {
  const route = `kuvo/sessions/${session}/typed`
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }]
  const record = (server: ReturnType<typeof Bun.serve>) => ({ pid: process.pid, port: server.port!, password: "pw", version: "test" })
  const context = {
    request: { method, path: route, headers: {}, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)) },
    phone: undefined, signal: undefined, route,
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
    expect((await ask("POST", "ses_main", { text: "/plan" })).json).toEqual({ keyword: "plan", plan: "toggle" })
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
      expect(json).toEqual({ keyword: "handoff", restore: { text: "/handoff write the docs" }, error: KEYWORD_UNAVAILABLE })
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

  test("a model that can't run: said, all of it kept; a \"!\" command still runs", async () => {
    expect((await ask("POST", "ses_main", { text: "fix it", refusal: "Sign in to Anthropic again." })).json).toEqual({ restore: { text: "fix it" }, error: "Sign in to Anthropic again." })
    expect((await ask("POST", "ses_main", { text: "!npm test", refusal: "Sign in to Anthropic again." })).json).toEqual({ shell: "npm test" })
  })

  test("a conversation that isn't here, and a send without text", async () => {
    const none = await ask("POST", "ses_none", { text: "/goal ship it" })
    expect(none.status).toBe(404)
    // What was written goes back as a keyword's does: beside words typed meanwhile, its words.
    expect(none.json).toEqual({ message: "There's no such conversation here.", restore: { text: "/goal ship it", beside: "ship it" } })
    expect((await ask("POST", "ses_main", {})).status).toBe(400)
  })
})
