// A message's envelope and its parts (PROTOCOL.md, "A message's parts"): the box writes what the agent
// reads from a client's fields, in the words Kuvo Code wrote before, byte for byte, and reads the
// parts back, from the text of one from before too (Packages/KuvoLink/Vectors/message-parts.json,
// which KuvoClient's MessagePartsTests reads as a client does). Then `kuvo/sessions/<id>/send`,
// `queue/add` and `kuvo/messages/parts`, with the engine and the agents bridge as stand-ins (their
// HTTP APIs) and the box's code real.

import "./safety"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { composeMessage, partsOf } from "../src/link/messages/parts"
import type { AnswerPiece, RouteContext } from "../src/link/server/context"

const vectors = JSON.parse(readFileSync(new URL("../../KuvoLink/Vectors/message-parts.json", import.meta.url), "utf8"))

describe("the envelope, as Kuvo Code wrote it before", () => {
  test.each(vectors.compose.map((each: any) => [each.about, each]))("%s", (_, each: any) => {
    const text = composeMessage(each.fields, { excluding: each.excluding ?? null, here: each.here ?? null, agents: vectors.agents }, each.kept ?? {}, each.phone === true)
    expect(text).toBe(each.text)
    expect(JSON.parse(JSON.stringify(partsOf(text)))).toEqual(each.parts)
  })
})

describe("the parts of a message from before", () => {
  test.each(vectors.read.map((each: any) => [each.about, each]))("%s", (_, each: any) => {
    expect(JSON.parse(JSON.stringify(partsOf(each.text)))).toEqual(each.parts)
  })
})

// ——— The routes ———

type Asked = { method: string; path: string; body: any }

let engine: ReturnType<typeof Bun.serve>
let bridge: ReturnType<typeof Bun.serve>
let engineAsked: Asked[] = []
let bridgeAsked: Asked[] = []
let engineAnswers = 200
let sendRoute: typeof import("../src/link/areas/messages").sendRoute
let partsRoute: typeof import("../src/link/areas/messages").partsRoute
let SEND_ROUTE: RegExp
let queueRoute: typeof import("../src/link/areas/queue").queueRoute
let QUEUE_ROUTE: RegExp

async function asked(request: Request): Promise<Asked> {
  const text = await request.text()
  return { method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  ;({ sendRoute, partsRoute, SEND_ROUTE } = await import("../src/link/areas/messages"))
  ;({ queueRoute, QUEUE_ROUTE } = await import("../src/link/areas/queue"))
  engine = Bun.serve({
    port: 0,
    async fetch(request) {
      const each = await asked(request)
      engineAsked.push(each)
      if (each.path === "/api/session/ses_main") return Response.json({ data: { id: "ses_main", location: { directory: "/srv/app" }, time: { created: 1, updated: 1 } } })
      if (each.path === "/api/session/ses_main/inbox") return Response.json({ data: [] })
      if (/^\/api\/session\/ses_main\//.test(each.path)) return Response.json({ data: {} }, { status: engineAnswers })
      if (/^\/api\/session\//.test(each.path)) return Response.json({ message: "Not here." }, { status: 404 })
      return Response.json({ data: null })
    },
  })
  bridge = Bun.serve({
    port: 0,
    async fetch(request) {
      const each = await asked(request)
      bridgeAsked.push(each)
      if (each.path === "/api/session/ses_claude") return Response.json({ data: { id: "ses_claude", location: { directory: "/srv/app" }, time: { created: 1, updated: 1 } } })
      if (/^\/api\/session\/ses_claude\//.test(each.path)) return Response.json({ data: {} })
      return Response.json({ message: "Not here." }, { status: 404 })
    },
  })
})

afterAll(() => {
  engine.stop(true)
  bridge.stop(true)
})

beforeEach(() => {
  engineAsked = []
  bridgeAsked = []
  engineAnswers = 200
})

/** A route's answer to `method route` with `body`, asked by `from` (a phone, unless the app or a Mac). */
async function ask(answer: (context: RouteContext) => AsyncIterable<AnswerPiece>, method: string, route: string, body: unknown, from: "phone" | "app" | "mac" = "app"): Promise<{ status: number; json: any }> {
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }]
  const record = (server: ReturnType<typeof Bun.serve>) => ({ pid: process.pid, port: server.port!, password: "pw", version: "test" })
  const context = {
    request: { method, path: route, headers: {}, body: Buffer.from(JSON.stringify(body)), fromApp: from === "app", fromMac: from === "mac" },
    phone: undefined, signal: undefined, route,
    readEngine: () => record(engine), readBridge: () => record(bridge), bridge: () => record(bridge),
    info: { name: "Test" }, phonesChanged: () => {}, hold: null, json,
    text: (status: number, words: string): AnswerPiece[] => [{ head: { status, headers: {} } }, { body: Buffer.from(words) }],
  } as unknown as RouteContext
  let status = 0
  const parts: Buffer[] = []
  for await (const piece of answer(context)) {
    if ("head" in piece) status = piece.head.status
    else parts.push(piece.body)
  }
  const text = Buffer.concat(parts).toString("utf8")
  return { status, json: text ? JSON.parse(text) : null }
}

const send = (session: string, body: unknown, from: "phone" | "app" | "mac" = "app") => {
  const route = `kuvo/sessions/${session}/send`
  return ask(context => sendRoute(context, route.match(SEND_ROUTE)!), "POST", route, body, from)
}
const prompted = (asked: Asked[]) => asked.filter(each => each.method === "POST" && /\/(prompt|command)$/.test(each.path))

describe("kuvo/sessions/<id>/send", () => {
  test("the box writes what the agent reads and keeps its parts with it", async () => {
    const comments = [{ file: "a.js", line: 4, side: "new", snippet: "x()", text: "Call it once" }]
    const { status } = await send("ses_main", { id: "msg_one", words: " Have a look ", keyword: "/plan", comments, notes: { paths: ["/x/y.txt"] }, delivery: "steer" })
    expect(status).toBe(200)
    const [sent] = prompted(engineAsked)
    expect(sent.path).toBe("/api/session/ses_main/prompt")
    expect(sent.body.id).toBe("msg_one")
    expect(sent.body.delivery).toBe("steer")
    expect(sent.body.text).toBe(composeMessage({ words: "Have a look", keyword: "/plan", comments: comments as any, notes: { paths: ["/x/y.txt"] } }, { excluding: "ses_main", here: null, agents: [] }))
    expect(sent.body.text.startsWith("Have a look\n\n<sent-with>\n")).toBe(true)
    expect(sent.body.metadata.kuvo.parts).toEqual({ words: "Have a look", keyword: "/plan", comments, paths: ["/x/y.txt"] })
  })

  test("a phone's says it's from the phone; a Mac's doesn't", async () => {
    await send("ses_main", { id: "msg_phone", words: "What's in the report?" }, "phone")
    await send("ses_main", { id: "msg_mac", words: "What's in the report?" }, "mac")
    const [phone, mac] = prompted(engineAsked)
    expect(phone.body.text).toEndWith("</from-phone>")
    expect(phone.body.metadata.kuvo.parts).toEqual({ words: "What's in the report?", phone: true })
    expect(mac.body.text).toBe("What's in the report?")
  })

  test("a file it carries is kept here, and the note says where", async () => {
    const zip = `data:application/zip;base64,${Buffer.from("PK").toString("base64")}`
    await send("ses_main", { id: "msg_files", words: "Here", files: [{ uri: zip, name: "b.zip" }], notes: { unsent: ["/Users/me/huge.mov"] } }, "mac")
    const [sent] = prompted(engineAsked)
    expect(sent.body.files).toBeUndefined()
    const note = sent.body.text.split("\n")
    expect(note.slice(0, 5)).toEqual(["Here", "", "<attached-files>", "These attached files stayed on the user's Mac (they couldn't be read, or copied to this machine):", "/Users/me/huge.mov"])
    expect(note[5]).toBe("Open these attached files with your tools if you need them:")
    expect(note[6]).toMatch(/\/attachments\/ses_main\/[0-9a-f]{8}\/b\.zip$/)
    expect(sent.body.metadata.kuvo.parts.paths).toEqual(["/Users/me/huge.mov", note[6]])
    rmSync(note[6], { force: true })
  })

  test("sent again under its id, it goes once", async () => {
    const body = { id: "msg_twice", words: "Only once" }
    expect((await send("ses_main", body)).status).toBe(200)
    expect((await send("ses_main", body)).status).toBe(200)
    expect(prompted(engineAsked).length).toBe(1)
  })

  test("a refusal goes back as the engine said it, and the same send then goes again", async () => {
    engineAnswers = 500
    expect((await send("ses_main", { id: "msg_again", words: "Try" })).status).toBe(500)
    engineAnswers = 200
    expect((await send("ses_main", { id: "msg_again", words: "Try" })).status).toBe(200)
    expect(prompted(engineAsked).length).toBe(2)
  })

  test("a coding agent's conversation gets it through their bridge", async () => {
    await send("ses_claude", { id: "msg_claude", words: "Hello" })
    expect(prompted(engineAsked)).toEqual([])
    expect(prompted(bridgeAsked)[0].body.metadata.kuvo.parts).toEqual({ words: "Hello" })
  })

  test("one sent again (Retry) goes as the agent read it, its parts kept", async () => {
    const text = "Ask again\n\n<sent-with>\nThe user sent this with a Kuvo Code keyword, which Kuvo Code has already done (switched to Plan, or set the message to repeat), so there's nothing for you to do about it:\n/plan\n</sent-with>"
    await send("ses_main", { id: "msg_retry", text, files: [{ uri: "file:///x/a.png", name: "a.png" }] })
    const [sent] = prompted(engineAsked)
    expect(sent.body.text).toBe(text)
    expect(sent.body.files).toEqual([{ uri: "file:///x/a.png", name: "a.png" }])
    expect(sent.body.metadata.kuvo.parts).toEqual({ words: "Ask again", keyword: "/plan" })
  })

  test("a command runs with its arguments and its files' note", async () => {
    await send("ses_main", { words: "the tests", command: "review-quick", notes: { paths: ["/x/y.txt"] } })
    const [ran] = prompted(engineAsked)
    expect(ran.path).toBe("/api/session/ses_main/command")
    expect(ran.body.name).toBe("review-quick")
    expect(ran.body.text).toBe("the tests\n\n<attached-files>\nOpen these attached files with your tools if you need them:\n/x/y.txt\n</attached-files>")
  })

  test("a phone's command runs with its arguments alone, as its prompt passed on before did", async () => {
    await send("ses_main", { words: "main", command: "review-quick" }, "phone")
    expect(prompted(engineAsked)[0].body.text).toBe("main")
  })

  test("a command with nothing after its name runs", async () => {
    expect((await send("ses_main", { words: "", command: "init" })).status).toBe(200)
    const [ran] = prompted(engineAsked)
    expect(ran.path).toBe("/api/session/ses_main/command")
    expect(ran.body).toMatchObject({ name: "init", text: "" })
  })

  test("nothing written and nothing with it isn't sent; nor is it to a conversation that isn't here", async () => {
    expect((await send("ses_main", { words: "  " })).status).toBe(400)
    expect((await send("ses_main", { text: " " })).status).toBe(400)
    expect((await send("ses_gone", { words: "Hi" })).status).toBe(404)
    expect(prompted(engineAsked)).toEqual([])
  })
})

describe("queue/add", () => {
  test("a message as fields is written by the box, its parts kept, and goes on while nothing's paused", async () => {
    const route = "kuvo/sessions/ses_main/queue/add"
    const { status, json } = await ask(context => queueRoute(context, route.match(QUEUE_ROUTE)!), "POST", route, { id: "msg_queued", words: "After this", widget: "Plans", delivery: "queue" })
    expect(status).toBe(200)
    expect(json.waits).toBe(false)
    const [sent] = prompted(engineAsked)
    expect(sent.body.text).toBe("After this\n\n<from-widget>\nThe user sent this from a widget shown in this conversation (show_widget), titled:\nPlans\n</from-widget>")
    expect(sent.body.metadata.kuvo.parts).toEqual({ words: "After this", widget: "Plans" })
  })

  test("one waiting on the box while the queue's paused shows the keyword it was sent with", async () => {
    const stop = "kuvo/sessions/ses_main/stop"
    expect((await ask(context => queueRoute(context, stop.match(QUEUE_ROUTE)!), "POST", stop, {})).status).toBe(200)
    const route = "kuvo/sessions/ses_main/queue/add"
    const { json } = await ask(context => queueRoute(context, route.match(QUEUE_ROUTE)!), "POST", route, { id: "msg_held", words: "check CI", keyword: "/loop every hour", delivery: "queue" })
    expect(json.waits).toBe(true)
    expect(json.waiting.find((each: any) => each.id === "msg_held")).toMatchObject({ text: "check CI", keyword: "/loop every hour" })
    const resume = "kuvo/sessions/ses_main/queue/resume"
    await ask(context => queueRoute(context, resume.match(QUEUE_ROUTE)!), "POST", resume, {})
  })

  test("one a client wrote itself, the way before, keeps the parts of its text where there's more to them; a plain one keeps none", async () => {
    const route = "kuvo/sessions/ses_main/queue/add"
    const goal = "[Goal] ship it\n\n(The user asked for this as a goal: plan it, check what it needs, and put it to them with propose_goal before doing any of the work.)"
    await ask(context => queueRoute(context, route.match(QUEUE_ROUTE)!), "POST", route, { id: "msg_old", text: goal, words: "ship it", delivery: "queue" })
    await ask(context => queueRoute(context, route.match(QUEUE_ROUTE)!), "POST", route, { id: "msg_plain", text: "[Goal] ship it", delivery: "queue" })
    const [old, plain] = prompted(engineAsked)
    expect(old.body.metadata.kuvo.parts).toEqual({ words: "ship it", keyword: "/goal" })
    expect(plain.body.metadata).toBeUndefined()
  })
})

describe("kuvo/messages/parts", () => {
  test("reads each text from before, in order", async () => {
    const texts = vectors.read.map((each: any) => each.text)
    const { status, json } = await ask(context => partsRoute(context), "POST", "kuvo/messages/parts", { texts })
    expect(status).toBe(200)
    expect(json.parts).toEqual(vectors.read.map((each: any) => each.parts))
  })

  test("takes texts only, and not too many at once", async () => {
    expect((await ask(context => partsRoute(context), "POST", "kuvo/messages/parts", { texts: [1] })).status).toBe(400)
    expect((await ask(context => partsRoute(context), "POST", "kuvo/messages/parts", { texts: Array(501).fill("a") })).status).toBe(400)
  })
})
