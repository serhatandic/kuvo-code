import "../safety"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { branch } from "../../src/agents/branch"
import { SeatAPI, type Requester } from "../../src/agents/groups/api"
import type { GoalPlaces } from "../../src/agents/goals"
import { notesBeside } from "../../src/agents/notes"
import { notesLock, waitingAcross } from "../../src/shared/session-notes"

// The bridge's writers of a conversation's notes through its place's API (#581): a branch's mark
// and a seat's, each in its turn, on its notes as they are then, never on what it read before. The
// place keeps a conversation as the engine (2.2.5) does: a PATCH's metadata replaces it whole.

function place({ forkSaysMetadata = true } = {}) {
  const sessions = new Map<string, { id: string; metadata?: Record<string, any> }>()
  // What another writer does to a conversation as it's made (the box's approval and chat mark, as it
  // hears of it), before the one that made it writes its own.
  let onMade = (_id: string) => {}
  let made = 0
  // Reads of a conversation, as they're asked.
  const reads: string[] = []
  const api: Requester = {
    async request(method: string, path: string, body?: any): Promise<any> {
      await new Promise(resolve => setImmediate(resolve))
      const fork = path.match(/^\/api\/session\/([^/]+)\/fork$/)
      if (fork && method === "POST") {
        const source = sessions.get(decodeURIComponent(fork[1]!))!
        const copy = { id: `ses_copy${++made}`, metadata: structuredClone(source.metadata) }
        sessions.set(copy.id, copy)
        const answer = forkSaysMetadata ? structuredClone(copy) : { id: copy.id }
        onMade(copy.id)
        return { data: answer }
      }
      if (path === "/api/session" && method === "POST") {
        const id = `ses_seat${++made}`
        sessions.set(id, { id, metadata: structuredClone(body.metadata) })
        onMade(id)
        return { data: { id, metadata: body.metadata } }
      }
      const one = path.match(/^\/api\/session\/([^/]+)$/)
      const session = one && sessions.get(decodeURIComponent(one[1]!))
      if (!session) throw Object.assign(new Error("Not here."), { status: 404 })
      if (method === "PATCH") {
        if (body.metadata) session.metadata = body.metadata
        return undefined
      }
      reads.push(session.id)
      return { data: structuredClone(session) }
    },
  }
  return { api, sessions, reads, made: (then: (id: string) => void) => { onMade = then } }
}

test("a branch's mark keeps what was written to the copy since it was made, and takes off only what it carried of its source", async () => {
  const { api, sessions, made } = place()
  sessions.set("ses_work", { id: "ses_work", metadata: { "kuvo.pinned": true, color: "blue", kuvo: { startedBy: "ses_lead", goal: "g", approval: "auto", applied: "auto" } } })
  // The box adopts the copy as it hears of it (its approval, its chat mark), and you pin it.
  made(id => {
    const copy = sessions.get(id)!
    copy.metadata = { ...copy.metadata, "kuvo.pinned": "again", kuvo: { ...copy.metadata!.kuvo, approval: "acceptEdits", applied: "acceptEdits", chat: "/chats" } }
  })
  const places: GoalPlaces = { engine: { api, listen: () => () => {} }, bridge: { api, listen: () => () => {} }, isBridge: () => false }
  const copy = await branch(places, "ses_work", "msg_1")
  expect(sessions.get(copy.id)!.metadata).toEqual({ "kuvo.pinned": "again", color: "blue", kuvo: { goal: "g", approval: "acceptEdits", applied: "acceptEdits", chat: "/chats", branchedFrom: "ses_work" } })
  expect(copy.metadata).toEqual(sessions.get(copy.id)!.metadata)
})

test("a branch whose place answers the copy without its metadata takes off what it carried of its source all the same", async () => {
  const { api, sessions } = place({ forkSaysMetadata: false })
  sessions.set("ses_work", { id: "ses_work", metadata: { "kuvo.pinned": true, kuvo: { startedBy: "ses_lead", goal: "g" } } })
  const places: GoalPlaces = { engine: { api, listen: () => () => {} }, bridge: { api, listen: () => () => {} }, isBridge: () => false }
  const copy = await branch(places, "ses_work", "msg_1")
  expect(sessions.get(copy.id)!.metadata).toEqual({ kuvo: { goal: "g", branchedFrom: "ses_work" } })
})

test("a seat's mark keeps what was written to it since it was made", async () => {
  const { api, sessions, made } = place()
  made(id => {
    const seat = sessions.get(id)!
    seat.metadata = { ...seat.metadata, kuvo: { ...seat.metadata!.kuvo, approval: "askFirst", applied: "askFirst" } }
  })
  const seats = new SeatAPI(api)
  const seat = { group: "grp_1", bot: "bot_ada" }
  const session = await seats.create("/srv/team", "Ada in Team", undefined, undefined, [], { kuvo: { seat } })
  await seats.markSeat(session.id, seat)
  expect(sessions.get(session.id)!.metadata).toEqual({ kuvo: { seat, approval: "askFirst", applied: "askFirst" } })
})

// The box's link holding a conversation's turn: its lock folder in the box's `run/notes`, named for
// the conversation as both name it. The bridge's writer waits for it, reading nothing, and goes
// ahead once it's gone.
test("a conversation's turn held by the box's link: the bridge's writer reads nothing until it's done", async () => {
  const run = mkdtempSync(join(tmpdir(), "kuvo-notes-run-"))
  notesBeside(run)
  try {
    const { api, sessions, reads } = place()
    sessions.set("ses_seat", { id: "ses_seat", metadata: { kuvo: { approval: "auto" } } })
    const lock = notesLock(join(run, "notes"), "ses_seat")
    mkdirSync(lock, { recursive: true })
    const seat = { group: "grp_1", bot: "bot_ada" }
    const marking = new SeatAPI(api).markSeat("ses_seat", seat)
    try {
      await until(() => waitingAcross(join(run, "notes"), "ses_seat") === 1)
      for (let round = 0; round < 50; round++) await new Promise(resolve => setImmediate(resolve))
      expect(waitingAcross(join(run, "notes"), "ses_seat")).toBe(1)
      expect(reads).toEqual([])
    } finally {
      rmdirSync(lock)
    }
    await marking
    expect(sessions.get("ses_seat")!.metadata).toEqual({ kuvo: { approval: "auto", seat } })
    expect(existsSync(lock)).toBe(false)
  } finally {
    notesBeside(undefined)
    rmSync(run, { recursive: true, force: true })
  }
})

async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise(resolve => setImmediate(resolve))
}
