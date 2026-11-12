import "./safety"
import { expect, test } from "bun:test"
import { inTurn, rewriteSession, withNotes, type NotesPlace } from "../src/shared/session-notes"

// A session's notes written one writer at a time per place and session (#581), against a place that
// keeps them as the engine (2.2.5) does: a PATCH's metadata replaces it whole, with nothing to say
// "only if unchanged". Each read and write takes a moment, so writers at once interleave.

type Kept = { id: string; metadata: Record<string, unknown> }

let places = 0
function standIn(...ids: string[]) {
  const sessions = new Map<string, Kept>(ids.map(id => [id, { id, metadata: { pinned: true } }]))
  // Each read and write held until let go, where one is asked to be (by session).
  const holds = new Map<string, Promise<void>>()
  const writes: string[] = []
  let failing = 0
  const moment = () => new Promise(resolve => setTimeout(resolve, 5))
  const place: NotesPlace<Kept> = {
    name: `stand-in ${++places}`,
    read: async (id, signal) => {
      await moment()
      await Promise.race([holds.get(id), new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))])
      const kept = sessions.get(id)
      return kept ? structuredClone(kept) : null
    },
    write: async (id, change) => {
      await moment()
      if (failing > 0) {
        failing -= 1
        throw new Error("It answered 500.")
      }
      writes.push(id)
      sessions.get(id)!.metadata = change.metadata!
    },
  }
  const hold = (id: string) => {
    let release = () => {}
    holds.set(id, new Promise<void>(resolve => { release = resolve }))
    return () => { holds.delete(id); release() }
  }
  return { place, sessions, writes, hold, fail: (times = 1) => { failing = times } }
}

const add = (kuvo: Record<string, unknown>) => (session: Kept) => ({ metadata: withNotes(session.metadata, kuvo) })

test("two writes at once to different keys of one session both land, with what was there", async () => {
  const { place, sessions } = standIn("ses_one")
  await Promise.all([
    rewriteSession(place, "ses_one", add({ autopilot: true })),
    rewriteSession(place, "ses_one", add({ chat: "/chats" })),
    rewriteSession(place, "ses_one", add({ approval: "auto", applied: "auto" })),
  ])
  expect(sessions.get("ses_one")!.metadata).toEqual({ pinned: true, kuvo: { autopilot: true, chat: "/chats", approval: "auto", applied: "auto" } })
})

test("one session's writes don't wait on another's", async () => {
  const { place, sessions, hold } = standIn("ses_slow", "ses_quick")
  const release = hold("ses_slow")
  const slow = rewriteSession(place, "ses_slow", add({ autopilot: true }))
  // The slow one still reading: the other session's write lands meanwhile.
  await rewriteSession(place, "ses_quick", add({ autopilot: true }))
  expect(sessions.get("ses_quick")!.metadata.kuvo).toEqual({ autopilot: true })
  expect(sessions.get("ses_slow")!.metadata.kuvo).toBeUndefined()
  release()
  await slow
  expect(sessions.get("ses_slow")!.metadata.kuvo).toEqual({ autopilot: true })
})

test("a write that fails ends its turn: the next one goes ahead, on the session as it is", async () => {
  const { place, sessions, fail } = standIn("ses_one")
  fail()
  const [first, second] = await Promise.allSettled([
    rewriteSession(place, "ses_one", add({ autopilot: true })),
    rewriteSession(place, "ses_one", add({ chat: "/chats" })),
  ])
  expect(first.status).toBe("rejected")
  expect(second).toMatchObject({ status: "fulfilled", value: { written: true } })
  expect(sessions.get("ses_one")!.metadata).toEqual({ pinned: true, kuvo: { chat: "/chats" } })
  // And a change that throws ends it too.
  const thrown = rewriteSession(place, "ses_one", () => { throw new Error("No.") })
  await expect(thrown).rejects.toThrow("No.")
  expect(await rewriteSession(place, "ses_one", add({ autopilot: true }))).toMatchObject({ written: true })
  expect(sessions.get("ses_one")!.metadata.kuvo).toEqual({ chat: "/chats", autopilot: true })
})

test("a read that hangs past its writer's patience ends its turn", async () => {
  const { place, sessions, hold } = standIn("ses_one")
  const release = hold("ses_one")
  const hung = rewriteSession(place, "ses_one", add({ autopilot: true }), AbortSignal.timeout(30))
  const next = rewriteSession(place, "ses_one", add({ chat: "/chats" }))
  await expect(hung).rejects.toBeDefined()
  release()
  await next
  expect(sessions.get("ses_one")!.metadata.kuvo).toEqual({ chat: "/chats" })
})

test("nothing to change writes nothing; a session that isn't there is null", async () => {
  const { place, writes } = standIn("ses_one")
  expect(await rewriteSession(place, "ses_one", () => null)).toMatchObject({ written: false, session: { id: "ses_one" } })
  expect(await rewriteSession(place, "ses_gone", add({ autopilot: true }))).toBeNull()
  expect(writes).toEqual([])
})

test("a writer within its own turn doesn't wait on itself; others wait for the whole of it", async () => {
  const order: string[] = []
  await Promise.all([
    inTurn("place", "ses_one", async () => {
      order.push("outer starts")
      await inTurn("place", "ses_one", async () => { order.push("inner") })
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push("outer ends")
    }),
    inTurn("place", "ses_one", async () => { order.push("next") }),
  ])
  expect(order).toEqual(["outer starts", "inner", "outer ends", "next"])
})

test("a writer's own notes: its keys in kuvo and at the top changed, the rest as they are", () => {
  const before = { pinned: true, "kuvo.archived": true, kuvo: { chat: "/chats", autopilot: true } }
  expect(withNotes(before, { autopilot: undefined, approval: "auto" }, { "kuvo.archived": undefined })).toEqual({ pinned: true, kuvo: { chat: "/chats", approval: "auto" } })
  expect(withNotes(before, null, { "kuvo.carriedTo": "ses_new" })).toEqual({ ...before, "kuvo.carriedTo": "ses_new" })
  expect(withNotes(undefined, { bot: "bot_a" })).toEqual({ kuvo: { bot: "bot_a" } })
  // (What it was given stays as it was.)
  expect(before.kuvo).toEqual({ chat: "/chats", autopilot: true })
})
