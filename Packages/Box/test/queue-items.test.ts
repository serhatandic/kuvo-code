import "./safety"
import { afterAll, beforeEach, expect, test } from "bun:test"
import { ask, follow } from "./route-answer"

// The queue as one list every client draws (PROTOCOL.md, "The queue", `queue.items`): what the
// engine holds and what waits on the box, in the order they go, each as it was written; and Edit
// taking back one the engine holds, with what the composer needs. Only the engine is a stand-in,
// keeping each session's inbox and messages as the engine does.

const { engineHandler } = await import("../src/link/server/router")
const { forgetQueue, queueWatcher } = await import("../src/link/engine/queue")

let inboxes: Record<string, any[]>, delivered: Record<string, string[]>, keeps: Set<string>, got: { method: string; path: string }[]
beforeEach(() => {
  for (const session of ["ses_q", "ses_late"]) forgetQueue(session)
  got = []
  keeps = new Set()
  delivered = {}
  inboxes = {
    ses_q: [
      // Yours, its parts kept with it: what you wrote, and the keyword, not what the agent reads.
      { id: "msg_steer", sessionID: "ses_q", type: "user", delivery: "steer", payload: {
        text: "Use the blue one.\n\n<attached-files>\n- /tmp/shot.png\n</attached-files>",
        files: [{ mime: "image/png", name: "shot.png", data: "iVBORw0K", source: { type: "uri", uri: "file:///Users/me/shot.png" } }],
        metadata: { kuvo: { parts: { words: "Use the blue one.", keyword: "/goal" } } },
      } },
      // Another agent's letter, in its own words.
      { id: "msg_mail", sessionID: "ses_q", type: "user", delivery: "queue", payload: { text: "[Message from Mira · ses_mira] (Answer with send_message.)\n\nCan you check the build?" } },
      // A summary waiting is no message of yours.
      { id: "msg_sum", sessionID: "ses_q", type: "compaction", delivery: "queue", payload: {} },
    ],
    ses_late: [{ id: "msg_late", sessionID: "ses_late", type: "user", delivery: "queue", payload: { text: "Too late." } }],
  }
})

const engine = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    got.push({ method: request.method, path: url.pathname })
    const reply = (value: unknown, status = 200) => Response.json(value, { status })
    if (url.pathname === "/api/session/active") return reply({ data: {} })
    const [, id, kind, item] = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/) ?? []
    if (id === "ses_broken") return reply({ message: "Busy." }, 500)
    if (!id || !inboxes[id]) return reply({ message: "No such session." }, 404)
    if (!kind) return reply({ data: { id, location: { directory: "/w" }, time: { created: 1, updated: 1 } } })
    if (kind === "message") return reply({ data: (delivered[id] ?? []).map(each => ({ id: each, type: "user" })) })
    if (kind !== "inbox") return reply({ message: "Not here." }, 404)
    if (!item) return reply({ data: inboxes[id] })
    const entry = inboxes[id]!.find(each => each.id === item)
    if (!entry) return reply({ message: "Not in the inbox." }, 404)
    if (request.method === "PATCH") {
      entry.delivery = (await request.json() as { delivery: string }).delivery
      return reply({ data: entry })
    }
    if (request.method === "DELETE") {
      // (One the agent took first: the cancel comes too late, and says nothing.)
      if (id === "ses_late") delivered[id] = [...(delivered[id] ?? []), item]
      if (!keeps.has(item)) inboxes[id] = inboxes[id]!.filter(each => each.id !== item)
      return reply({ data: true })
    }
    return reply({ message: "Not here." }, 404)
  },
})
const target = { port: engine.port, password: "pw" } as any
const handler = engineHandler(() => target, { name: "test" }, () => { throw new Error("none") })
afterAll(() => {
  engine.stop(true)
  for (const session of ["ses_q", "ses_late"]) forgetQueue(session)
})

// Stopped: what was for its next step held, the queue paused; then one of yours put back while it's
// paused (a new id each time: one sent again under its id is added once).
let adds = 0
async function stopAndAdd(): Promise<string> {
  const id = `msg_box${++adds}`
  expect((await ask(handler, "POST", "kuvo/sessions/ses_q/queue/hold")).status).toBe(200)
  const added = await ask(handler, "POST", "kuvo/sessions/ses_q/queue/add", { id, text: "Also the docs.", kept: true, words: "Also the docs.", files: [{ uri: "file:///Users/me/notes.md", name: "notes.md" }] })
  expect(added.json.waits).toBe(true)
  return id
}

test("the queue lists every message waiting, in the order they go, as each was written", async () => {
  const box = await stopAndAdd()
  const { status, json } = await ask(handler, "GET", "kuvo/sessions/ses_q/queue")
  expect(status).toBe(200)
  expect(json.paused).toBe(true)
  expect(json.held).toEqual(["msg_steer"])
  expect(json.items).toEqual([
    { id: "msg_steer", words: "Use the blue one.", files: ["shot.png"], keyword: "/goal", from: null, on: "engine", delivery: "queue", held: true },
    { id: "msg_mail", words: "Can you check the build?", files: [], keyword: null, from: "Mira", on: "engine", delivery: "queue", held: false },
    { id: box, words: "Also the docs.", files: ["notes.md"], keyword: null, from: null, on: "box", delivery: "queue", held: false },
  ])
})

test("Edit takes back one the engine holds, with its words and files for the composer, and what came after it", async () => {
  const box = await stopAndAdd()
  const { status, json } = await ask(handler, "DELETE", "kuvo/sessions/ses_q/queue/msg_steer")
  expect(status).toBe(200)
  expect(json.removed).toEqual({
    id: "msg_steer", text: "Use the blue one.\n\n<attached-files>\n- /tmp/shot.png\n</attached-files>",
    files: [{ uri: "file:///Users/me/shot.png", name: "shot.png" }], delivery: "queue", words: "Use the blue one.", before: "msg_mail",
  })
  expect(got).toContainEqual({ method: "DELETE", path: "/api/session/ses_q/inbox/msg_steer" })
  // Gone from the list, and from what's held.
  const now = (await ask(handler, "GET", "kuvo/sessions/ses_q/queue")).json
  expect(now.held).toEqual([])
  expect(now.items.map((each: any) => each.id)).toEqual(["msg_mail", box])
  // Not waiting anywhere: 404.
  expect((await ask(handler, "DELETE", "kuvo/sessions/ses_q/queue/msg_none")).status).toBe(404)
})

test("one the agent took first isn't taken back, and one the engine keeps says so", async () => {
  expect((await ask(handler, "DELETE", "kuvo/sessions/ses_late/queue/msg_late")).status).toBe(404)
  keeps.add("msg_mail")
  expect((await ask(handler, "DELETE", "kuvo/sessions/ses_q/queue/msg_mail")).status).toBe(502)
})

test("while the engine can't be read the queue says what waits on the box, and that its items can't be said", async () => {
  const { json } = await ask(handler, "GET", "kuvo/sessions/ses_broken/queue")
  expect(json).toEqual({ paused: false, held: [], items: null })
  // A session no place has: nothing waits for it.
  expect((await ask(handler, "GET", "kuvo/sessions/ses_none/queue")).json.items).toEqual([])
})

test("followed, a session's queue comes again as the engine's inbox for it changes", async () => {
  const stream = follow(handler, "kuvo/sessions/ses_q/queue/events")
  try {
    expect((await stream.next()).items.map((each: any) => each.id)).toEqual(["msg_steer", "msg_mail"])
    // A message comes: the engine says so, as the box's long-running process hears it.
    inboxes.ses_q!.push({ id: "msg_new", sessionID: "ses_q", type: "user", delivery: "queue", payload: { text: "One more thing." } })
    queueWatcher(target, { schedule: () => 0, cancel: () => {} })({ type: "session.inbox.enqueued", data: { sessionID: "ses_q", inboxID: "msg_new", item: { type: "user", delivery: "queue", payload: { text: "One more thing." } } } })
    expect((await stream.next()).items.at(-1)).toMatchObject({ id: "msg_new", words: "One more thing.", on: "engine" })
  } finally {
    stream.stop()
  }
})
