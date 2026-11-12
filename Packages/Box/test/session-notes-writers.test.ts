import "./safety"
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// The box's writers of a session's notes (#581), each as it really runs, against a stand-in engine
// that keeps a session as the real one (2.2.5) does: a PATCH replaces its metadata (and its rules)
// whole, with nothing to say "only if unchanged". Its reads are held until the test lets them go,
// so writers at once, or a client's write meanwhile, land between another's read and its write.

type Session = { id: string; title: string; location: { directory: string }; permissions: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[]; metadata: Record<string, any>; time: { created: number; updated: number } }

let engine: ReturnType<typeof Bun.serve>
let session: Session
let chats: string
// What came to the engine, in order: each PATCH's body, and who sent it.
let patches: { by: string; body: any }[] = []
// Reads of the session held (each answered with the session as it was when it was asked), while
// reads are held; and how many were asked.
let holdReads = false
let held: (() => void)[] = []
let reads = 0

const target = () => ({ port: engine.port!, password: "pw" })
const ses = "ses_notes"

// How many writers hold or wait for the session's turn in this process (none where there are no
// turns: a box from before).
let turnsOn: (place: string, id: string) => number = () => 0
const waiting = () => turnsOn(`127.0.0.1:${engine.port}`, ses)

/** Lets the rest of what's under way run (the stand-in's answers, the writers' next steps) until
 * `ready` says so. */
async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise(resolve => setImmediate(resolve))
}
const letReadsGo = () => {
  for (const each of held.splice(0)) each()
}
const answer = { ask: "per_1", what: "Run npm install", decision: "allow" as const, reason: "Part of the plan.", by: { bot: "bot_pixel", name: "Pixel" }, at: 1 }

// This computer's approval as it was (setting one's approval makes it the next one's default), put
// back once these are done, for the tests after them.
let approvalFile = ""
let approvalBefore: string | null = null

beforeAll(async () => {
  // (Loaded as the box loads them: the Work tools' modules only once the rest are.)
  await import("../src/link/areas/approval")
  approvalFile = (await import("../src/link/work/approval")).APPROVAL_FILE
  approvalBefore = existsSync(approvalFile) ? readFileSync(approvalFile, "utf8") : null
  chats = (await import("../src/link/home")).CHATS
  mkdirSync(chats, { recursive: true })
  turnsOn = (await import("../src/shared/session-notes").catch(() => null))?.turnsOn ?? turnsOn
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
        reads += 1
        // (As it is now, answered once it's let go: what lands meanwhile isn't in it.)
        const now = structuredClone(session)
        if (holdReads) await new Promise<void>(resolve => held.push(resolve))
        return Response.json({ data: now })
      }
      // Its instructions (Autopilot's), and anything else: taken.
      if (route.startsWith("/api/experimental/session/")) return Response.json({})
      return Response.json({ message: "Not here." }, { status: 404 })
    },
  })
})

afterAll(() => {
  engine.stop(true)
  if (approvalBefore === null) rmSync(approvalFile, { force: true })
  else writeFileSync(approvalFile, approvalBefore)
})

beforeEach(() => {
  patches = []
  holdReads = false
  held = []
  reads = 0
  session = { id: ses, title: "Plan the launch", location: { directory: chats }, permissions: [], metadata: { "kuvo.pinned": true }, time: { created: Date.now(), updated: Date.now() } }
})

test("the box's writers of one session at once (Autopilot, an answer, its approval, the chat mark) all land", async () => {
  const { setAutopilot } = await import("../src/link/work/autopilot")
  const { keepAnswer } = await import("../src/link/work/answers")
  const { setApproval } = await import("../src/link/areas/approval")
  const { markChat } = await import("../src/link/engine/chats")
  const read = structuredClone(session)
  holdReads = true
  let finished = 0
  const writers = [
    setAutopilot(target(), read, true),
    keepAnswer(target(), ses, answer),
    setApproval(ses, "acceptEdits", target(), null),
    markChat(target(), ses),
  ].map(each => Promise.resolve(each).finally(() => { finished += 1 }))
  // Each read let go once every writer still going waits: on a read of its own, or for its turn.
  while (finished < writers.length) {
    await until(() => finished === writers.length || (held.length > 0 && held.length + Math.max(waiting() - 1, 0) >= writers.length - finished))
    letReadsGo()
  }
  await Promise.all(writers)
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
  // The box's writer reads it, held there; the phone's change comes meanwhile.
  holdReads = true
  const answering = keepAnswer(target(), ses, answer)
  await until(() => held.length === 1)
  const body = Buffer.from(JSON.stringify({ metadata: { "kuvo.pinned": false } }))
  const pieces = (async () => {
    for await (const _ of forward(target(), `/api/session/${ses}`, { method: "PATCH", path: `/api/session/${ses}`, headers: {}, body }, undefined, () => true)) {}
  })()
  // It waits for the box's turn; a box without turns reads it at once, and writes it.
  await until(() => waiting() >= 2 || held.length === 2)
  if (held.length === 2) {
    held.pop()!()
    await until(() => patches.some(each => each.by === "phone"))
  }
  holdReads = false
  letReadsGo()
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
    rewriteOn(target(), ses, now => ({ metadata: withNotes(now.metadata, null, { "kuvo.archived": true }) })),
    rewriteOn(target(), ses, now => ({ metadata: withNotes(now.metadata, { bot: "bot_a", approval: "auto", applied: "auto" }), permissions: [{ action: "edit", resource: "*", effect: "allow" }] })),
  ])
  expect(session.metadata).toEqual({ "kuvo.pinned": true, "kuvo.archived": true, kuvo: { chat: chats, bot: "bot_a", approval: "auto", applied: "auto" } })
  expect(session.permissions).toEqual([{ action: "edit", resource: "*", effect: "allow" }])
})

// Another of this computer's processes (a client's `box route`, the coding agents' bridge) holding
// the session's turn: its lock folder in `run/notes`, just made. This one's writer waits for it,
// reading nothing, and goes ahead once it's gone.
test("a session's turn held by another process: its writer here reads nothing until that one's done", async () => {
  const { NOTES_LOCKS, rewriteOn } = await import("../src/link/engine/notes")
  const { notesLock, waitingAcross, withNotes } = await import("../src/shared/session-notes")
  const lock = notesLock(NOTES_LOCKS, ses)
  mkdirSync(lock, { recursive: true })
  let done = false
  const writing = rewriteOn(target(), ses, now => ({ metadata: withNotes(now.metadata, { autopilot: true }) })).finally(() => { done = true })
  try {
    // In its turn here, it waits for the folder; and still does, everything else let run a while.
    await until(() => waitingAcross(NOTES_LOCKS, ses) === 1)
    for (let round = 0; round < 50; round++) await new Promise(resolve => setImmediate(resolve))
    expect(waitingAcross(NOTES_LOCKS, ses)).toBe(1)
    expect(reads).toBe(0)
    expect(done).toBe(false)
  } finally {
    rmdirSync(lock)
  }
  expect(await writing).toMatchObject({ written: true })
  expect(session.metadata.kuvo).toEqual({ autopilot: true })
  expect(existsSync(lock)).toBe(false)
})

// A box from before #581 beside this one (an update taking over): its one lock for every session's
// notes, held, is waited for, and never taken.
test("a box from before's one lock, held, is waited for", async () => {
  const { RUN } = await import("../src/link/home")
  const { NOTES_LOCKS, rewriteOn } = await import("../src/link/engine/notes")
  const { waitingAcross, withNotes } = await import("../src/shared/session-notes")
  const old = join(RUN, "work", ".notes.lock")
  mkdirSync(old, { recursive: true })
  const writing = rewriteOn(target(), ses, now => ({ metadata: withNotes(now.metadata, { autopilot: true }) }))
  try {
    await until(() => waitingAcross(NOTES_LOCKS, ses) === 1)
    for (let round = 0; round < 50; round++) await new Promise(resolve => setImmediate(resolve))
    expect(waitingAcross(NOTES_LOCKS, ses)).toBe(1)
    expect(reads).toBe(0)
  } finally {
    rmdirSync(old)
  }
  expect(await writing).toMatchObject({ written: true })
})

test("lock folders left by a box cut off are cleared as it starts; one held now stays", async () => {
  const { clearNotesLocks, NOTES_LOCKS } = await import("../src/link/engine/notes")
  const { NOTES_STALE, notesLock } = await import("../src/shared/session-notes")
  const left = notesLock(NOTES_LOCKS, "ses_left"), now = notesLock(NOTES_LOCKS, "ses_now")
  mkdirSync(left, { recursive: true })
  mkdirSync(now, { recursive: true })
  const then = (Date.now() - NOTES_STALE - 1_000) / 1000
  utimesSync(left, then, then)
  clearNotesLocks()
  expect(existsSync(left)).toBe(false)
  expect(existsSync(now)).toBe(true)
  rmdirSync(now)
  expect(dirname(now)).toBe(NOTES_LOCKS)
})
