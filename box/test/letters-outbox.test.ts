// A message sent without waiting that won't be delivered: its sender hears it once, as the box's own
// word (queued, marked, by its agent's name and computer), and the message never goes again.

import "./safety"
import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { RUN } from "../src/link/home"
import { writeLink, readLink } from "../src/link/state"
import { newKey, publicOf } from "../src/link/crypto/keys"
import { letterWent, sendOutbox } from "../src/link/letters/outbox"
import { LETTER_MEMORY, SENDING } from "../src/link/letters/letter"
import { MOVED_FOR, MOVES, noteEnded, switchedHere } from "../src/link/moves/records"
import { boxNoteOf } from "../src/shared/queues"

const mine = newKey(), remote = newKey(), stranger = newKey(), mac = publicOf(newKey()).toString("base64url")
const own = publicOf(mine).toString("base64url")
const key = publicOf(remote).toString("base64url")
const file = path.join(SENDING, "ltr_failure.json")
const now = Date.now()
const host = { send: () => { throw new Error("A message that won't be delivered must never be sent again") } }
const write = (extra = {}) => fs.writeFileSync(file, JSON.stringify({ from: "ses_sender", to: "ses_target", text: "Hello", wait: false, at: now, peer: key, sentTo: key, ...extra }))

beforeEach(() => {
  fs.mkdirSync(SENDING, { recursive: true })
  writeLink({ key: mine.toString("base64url"), id: "here", macs: [mac], legacy: { [mac]: { at: 1, peers: [{ key, address: "a".repeat(22), kind: "machine", name: "Studio", id: "studio" }] } } } as any)
  fs.writeFileSync(path.join(RUN, "peer-agents.json"), JSON.stringify({ [key]: { at: now, list: [{ session: "ses_target", name: "Planning", kind: "session" }] } }))
})
afterEach(() => {
  for (const name of fs.readdirSync(SENDING)) fs.rmSync(path.join(SENDING, name), { force: true })
  for (const name of ["peer-agents.json", "engine.json", "agents.json"]) fs.rmSync(path.join(RUN, name), { force: true })
})

// The notice in the letter's place: for its sender, here, as the box's own word, queued and marked
// (both apps show its line, not a message of yours), naming the chat and never its address.
function notice(where = "studio") {
  const left = fs.readdirSync(SENDING)
  expect(left).toHaveLength(1)
  // (An id of its own: no word on the message acts on it.)
  expect(left[0]).toMatch(/^ltr_[A-Za-z0-9_-]{22}\.json$/)
  const letter = JSON.parse(fs.readFileSync(path.join(SENDING, left[0]), "utf8"))
  expect(letter.to).toBe("ses_sender")
  expect(letter.peer).toBe(own)
  expect(letter.wait).toBe(false)
  expect(letter.note).toMatchObject({ from: "Your other computers", delivery: "queue", line: `Your message to Planning on ${where} wasn't delivered` })
  expect(letter.note.words).toBe(letter.text)
  expect(boxNoteOf(letter.text, { kuvo: { note: { from: letter.note.from, line: letter.note.line } } })).toEqual({ from: "Your other computers", line: letter.note.line })
  expect(letter.text).toStartWith(`[Not delivered] ${letter.note.line}`)
  expect(letter.text).not.toContain("ses_target")
  return letter
}

test("refused by the box it went to: its sender hears why, in that computer's words, said by it", () => {
  write()
  // (Only the box it went to has a say.)
  letterWent({ key: publicOf(stranger).toString("base64url") }, { id: "ltr_failure", ok: false, why: "No." }, now)
  expect(JSON.parse(fs.readFileSync(file, "utf8")).note).toBeUndefined()
  letterWent({ key }, { id: "ltr_failure", ok: false, why: "That conversation isn't one this computer lists." }, now)
  expect(notice().text).toBe(`[Not delivered] Your message to Planning on studio wasn't delivered: studio said "That conversation isn't one this computer lists."`)
  // Told once: the notice isn't the message, and a word on that again is no second notice.
  letterWent({ key }, { id: "ltr_failure", ok: false, why: "No." }, now)
  expect(notice().text).toEndWith(`studio said "That conversation isn't one this computer lists."`)
})

test("one sent without waiting that no box took for two days: one notice, never sent", async () => {
  write({ at: now - LETTER_MEMORY - 1 })
  await sendOutbox(host, readLink(), now, 1)
  expect(notice().text).toEndWith("wasn't delivered. It couldn't get there in two days of trying.")
  await sendOutbox(host, readLink(), now, 1)
  notice()
})

test("one tried again until its two days were up: in this box's words, not the other's last word for now", () => {
  write({ at: now - LETTER_MEMORY - 1 })
  letterWent({ key }, { id: "ltr_failure", ok: false, retry: true, why: "It's moving to another computer: it comes again once it's there." }, now)
  const letter = notice()
  expect(letter.text).toEndWith("wasn't delivered. It couldn't get there in two days of trying.")
  expect(letter.text).not.toContain("moving")
})

test("one whose tool gave up waiting just before: its sender hears it, not the tool that's gone", () => {
  const replies = path.join(RUN, "replies")
  fs.mkdirSync(replies, { recursive: true })
  fs.writeFileSync(path.join(replies, "ltr_failure.gaveup"), "")
  write({ wait: true })
  try {
    letterWent({ key }, { id: "ltr_failure", ok: false, why: "No." }, now)
    notice()
    expect(fs.existsSync(path.join(replies, "ltr_failure.json"))).toBe(false)
  } finally {
    fs.rmSync(path.join(replies, "ltr_failure.gaveup"), { force: true })
  }
})

test("one whose tool's process is gone (it noted it waits a minute ago, and no more): its sender hears it", async () => {
  const replies = path.join(RUN, "replies")
  fs.mkdirSync(replies, { recursive: true })
  const alive = path.join(replies, "ltr_failure.alive")
  fs.writeFileSync(alive, "")
  fs.utimesSync(alive, (now - 60_000) / 1000, (now - 60_000) / 1000)
  write({ wait: true })
  try {
    letterWent({ key }, { id: "ltr_failure", ok: false, why: "No." }, now)
    notice()
    expect(fs.existsSync(path.join(replies, "ltr_failure.json"))).toBe(false)
    // One cut short as it was told is finished for its sender too, whatever the letter says.
    for (const name of fs.readdirSync(SENDING)) fs.rmSync(path.join(SENDING, name))
    fs.writeFileSync(path.join(SENDING, "ltr_failure.failed"), JSON.stringify({ from: "ses_sender", to: "ses_target", text: "Hello", wait: true, at: now, peer: key, sentTo: key }))
    fs.utimesSync(alive, now / 1000, now / 1000)
    await sendOutbox(host, readLink(), now, 1)
    expect(notice().text).toBe("[Not delivered] Your message to Planning on studio wasn't delivered.")
    expect(fs.existsSync(path.join(replies, "ltr_failure.json"))).toBe(false)
  } finally {
    fs.rmSync(alive, { force: true })
  }
})

test("one a tool still waits for, a note, or an answer: no notice", () => {
  const replies = path.join(RUN, "replies")
  fs.mkdirSync(replies, { recursive: true })
  fs.writeFileSync(path.join(replies, "ltr_failure.alive"), "")
  write({ wait: true })
  letterWent({ key }, { id: "ltr_failure", ok: false, why: "No." }, now)
  expect(fs.readdirSync(SENDING)).toEqual([])
  expect(JSON.parse(fs.readFileSync(path.join(replies, "ltr_failure.json"), "utf8"))).toEqual({ failed: "No." })
  fs.rmSync(path.join(replies, "ltr_failure.json"))
  fs.rmSync(path.join(replies, "ltr_failure.alive"))
  write({ from: "ses_sender", note: { from: "Its sessions", words: "Hi", delivery: "queue", line: "News" } })
  letterWent({ key }, { id: "ltr_failure", ok: false, why: "No." }, now)
  write({ answers: "ltr_asked" })
  letterWent({ key }, { id: "ltr_failure", ok: false, why: "No." }, now)
  expect(fs.readdirSync(SENDING)).toEqual([])
})

test("a notice cut short: the message never goes again, and the notice is finished later", async () => {
  write()
  const original = fs.writeFileSync
  fs.writeFileSync = ((target: any, ...args: any[]) => {
    if (String(target).startsWith(SENDING)) throw new Error("The disk is full.")
    return (original as any)(target, ...args)
  }) as any
  try {
    letterWent({ key }, { id: "ltr_failure", ok: false, why: "No." }, now)
    expect(fs.readdirSync(SENDING)).toEqual(["ltr_failure.failed"])
    await sendOutbox(host, readLink(), now, 1)
    expect(fs.readdirSync(SENDING)).toEqual(["ltr_failure.failed"])
  } finally { fs.writeFileSync = original }
  await sendOutbox(host, readLink(), now, 1)
  // (Why wasn't kept.)
  expect(notice().text).toBe("[Not delivered] Your message to Planning on studio wasn't delivered.")
})

test("one for a chat that moved here since, that it doesn't take: the same notice, from this computer", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
    if (new URL(request.url).pathname === "/api/session/ses_target") return Response.json({ data: { id: "ses_target", title: "Planning", time: { archived: 1 } } })
    return new Response("", { status: 404 })
  } })
  fs.writeFileSync(path.join(RUN, "engine.json"), JSON.stringify({ port: server.port, password: "pw" }))
  fs.writeFileSync(path.join(RUN, "agents.json"), JSON.stringify({ machine: "here", agents: [{ session: "ses_target", name: "Planning", machine: "here" }] }))
  write({ peer: own, sentTo: key })
  try {
    await sendOutbox(host, readLink(), now)
    expect(notice("this machine").text).toEndWith("wasn't delivered. That conversation doesn't take messages.")
  } finally {
    server.stop(true)
  }
})

test("a chat switched to here is taken for two days, the subagents it brought too", () => {
  noteEnded("mov_switched", "switched", now, ["ses_moved", "ses_moved_sub"])
  noteEnded("mov_dropped", "dropped", now, ["ses_dropped"])
  expect([...switchedHere(now)].sort()).toEqual(["ses_moved", "ses_moved_sub"])
  expect(switchedHere(now + MOVED_FOR).size).toBe(0)
  // Kept no longer than that: the move's record stays a year, its sessions don't.
  noteEnded("mov_later", "switched", now + MOVED_FOR, ["ses_later"])
  expect([...switchedHere(now + MOVED_FOR)]).toEqual(["ses_later"])
  expect(JSON.parse(fs.readFileSync(path.join(MOVES, "ended.json"), "utf8")).mov_switched).toEqual({ as: "switched", at: now })
})
