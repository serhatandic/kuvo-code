import "./safety"
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"

// The box's writers of a session's notes (#581), each as it really runs, against a stand-in engine
// that keeps a session as the real one (2.2.5) does: a PATCH replaces its metadata (and its rules)
// whole, with nothing to say "only if unchanged". Each read takes a moment, so writers at once, or
// a client's write meanwhile, land between another's read and its write.

type Session = { id: string; title: string; location: { directory: string }; permissions: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[]; metadata: Record<string, any>; time: { created: number; updated: number } }

let engine: ReturnType<typeof Bun.serve>
let session: Session
let chats: string
// What came to the engine, in order: each PATCH's body, and who sent it.
let patches: { by: string; body: any }[] = []
let readDelay = 20
// Held before the next read of the session is answered, where a test holds it.
let nextRead: Promise<void> | null = null

const target = () => ({ port: engine.port!, password: "pw" })

beforeAll(async () => {
  // (Loaded as the box loads them: the Work tools' modules only once the rest are.)
  await import("../src/link/areas/approval")
  chats = (await import("../src/link/home")).CHATS
  mkdirSync(chats, { recursive: true })
  engine = Bun.serve({
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname
      if (route === `/api/session/${session.id}`) {
        if (request.method === "PATCH") {
          const body = await request.json() as Partial<Session>
          // (The phone's, in these tests, is the one that says nothing of `kuvo`.)
          patches.push({ by: body.metadata && !("kuvo" in body.metadata) ? "phone" : "box", body })
          session = { ...session, ...(body.metadata ? { metadata: body.metadata } : {}), ...(body.permissions ? { permissions: body.permissions } : {}), time: { ...session.time, updated: Date.now() } }
          return new Response(null, { status: 204 })
        }
        // (Read as it is now, and answered after a while: what lands meanwhile isn't in it.)
        const answer = structuredClone(session)
        const held = nextRead
        nextRead = null
        await held
        await new Promise(resolve => setTimeout(resolve, readDelay))
        return Response.json({ data: answer })
      }
      // Its instructions (Autopilot's), and anything else: taken.
      if (route.startsWith("/api/experimental/session/")) return Response.json({})
      return Response.json({ message: "Not here." }, { status: 404 })
    },
  })
})

afterAll(() => engine.stop(true))

beforeEach(() => {
  patches = []
  readDelay = 20
  nextRead = null
  session = { id: "ses_notes", title: "Plan the launch", location: { directory: chats }, permissions: [], metadata: { "kuvo.pinned": true }, time: { created: Date.now(), updated: Date.now() } }
})

test("the box's writers of one session at once (Autopilot, an answer, its approval, the chat mark) all land", async () => {
  const { setAutopilot } = await import("../src/link/work/autopilot")
  const { keepAnswer } = await import("../src/link/work/answers")
  const { setApproval } = await import("../src/link/areas/approval")
  const { markChat } = await import("../src/link/engine/chats")
  const read = structuredClone(session)
  await Promise.all([
    setAutopilot(target(), read, true),
    keepAnswer(target(), session.id, { ask: "per_1", what: "Run npm install", decision: "allow", reason: "Part of the plan.", by: { bot: "bot_pixel", name: "Pixel" }, at: 1 }),
    setApproval(session.id, "acceptEdits", target(), null),
    markChat(target(), session.id),
  ])
  expect(session.metadata["kuvo.pinned"]).toBe(true)
  expect(session.metadata.kuvo).toMatchObject({ autopilot: true, approval: "acceptEdits", applied: "acceptEdits", chat: chats })
  expect(session.metadata.kuvo.answers.map((each: { ask: string }) => each.ask)).toEqual(["per_1"])
})

test("a client's change made after the box read the session, before its turn, stays", async () => {
  const { setAutopilot } = await import("../src/link/work/autopilot")
  // Read by the route before it turns Autopilot on; a client archives it meanwhile.
  const read = structuredClone(session)
  session.metadata = { ...session.metadata, "kuvo.archived": true }
  expect(await setAutopilot(target(), read, true)).toBe(true)
  expect(session.metadata).toEqual({ "kuvo.pinned": true, "kuvo.archived": true, kuvo: { autopilot: true } })
})

test("a phone's change forwarded while a box writer is between its read and its write isn't written over by it", async () => {
  const { keepAnswer } = await import("../src/link/work/answers")
  const { forward } = await import("../src/link/server/forward")
  // The box's writer reads it (held there a while); the phone's change comes meanwhile.
  let release = () => {}
  nextRead = new Promise<void>(resolve => { release = resolve })
  const answering = keepAnswer(target(), session.id, { ask: "per_1", what: "Run npm install", decision: "allow", reason: "Part of the plan.", by: { bot: "bot_pixel", name: "Pixel" }, at: 1 })
  await new Promise(resolve => setTimeout(resolve, 10))
  const body = Buffer.from(JSON.stringify({ metadata: { "kuvo.pinned": false } }))
  const pieces = (async () => {
    for await (const _ of forward(target(), `/api/session/${session.id}`, { method: "PATCH", path: `/api/session/${session.id}`, headers: {}, body }, undefined, () => true)) {}
  })()
  await new Promise(resolve => setTimeout(resolve, 30))
  release()
  await Promise.all([answering, pieces])
  // The phone's change stands: the box's write went first, then the phone's. (The phone's is its
  // whole metadata, as it read it before, without the box's answer: that's what a client's whole
  // write still loses, PROTOCOL.md "Session notes".)
  expect(session.metadata["kuvo.pinned"]).toBe(false)
  expect(patches.map(each => each.by)).toEqual(["box", "phone"])
})

test("writers at once of a top-level note, and of kuvo's with the rules, each write only their own", async () => {
  const { rewriteOn } = await import("../src/link/engine/notes")
  const { withNotes } = await import("../src/shared/session-notes")
  session.metadata = { "kuvo.pinned": true, kuvo: { chat: chats } }
  await Promise.all([
    rewriteOn(target(), session.id, now => ({ metadata: withNotes(now.metadata, null, { "kuvo.archived": true }) })),
    rewriteOn(target(), session.id, now => ({ metadata: withNotes(now.metadata, { bot: "bot_a", approval: "auto", applied: "auto" }), permissions: [{ action: "edit", resource: "*", effect: "allow" }] })),
  ])
  expect(session.metadata).toEqual({ "kuvo.pinned": true, "kuvo.archived": true, kuvo: { chat: chats, bot: "bot_a", approval: "auto", applied: "auto" } })
  expect(session.permissions).toEqual([{ action: "edit", resource: "*", effect: "allow" }])
})
