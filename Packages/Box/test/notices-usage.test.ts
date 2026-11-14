import "./safety"
import { expect, test } from "bun:test"
import { randomUUID, randomBytes } from "node:crypto"
import { newNotice, initialState, noticeAccountName } from "../src/agents/usage/notices"
import { usageNotices, usageSnapshot, catchUpUsage } from "../src/link/notices/usage"
import { readTold, toldLately } from "../src/link/notices/told"
import { NoticeHold } from "../src/link/notices/hold"
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { newKey, publicOf } from "../src/link/crypto/keys"
import { sendToPhones } from "../src/link/notices/push"
import { UsageDeliveryJournal, usageDelivered } from "../src/link/notices/usage-delivery"
import { macTell } from "../src/link/mac/notices"
import { macLink } from "../src/link/state"
import type { Notice } from "../src/link/notices/notice"

const fact = (at = Date.now()) => ({
  ...newNotice(`claude#${randomBytes(16).toString("hex")}`, "claude", { id: "seven_day", minutes: 10080, used: 0.85 }, "healthyToClose", at, initialState()),
  accountName: noticeAccountName("claude", "claude"),
})
const holdFor = (send: (notice: Notice) => boolean) => new NoticeHold({ send, setTimer: (() => 0) as any, clearTimer: () => {} })

test("queue acceptance is not delivery; a later successful hold send consumes the id", () => {
  const n = fact(); let attempts = 0, ready = false
  const hold = holdFor(() => { attempts++; return ready })
  usageNotices({ notices: [n], push: true }, notice => hold.tell(notice))
  usageNotices({ notices: [n], push: true }, notice => hold.tell(notice))
  expect(hold.count).toBe(1)
  expect(attempts).toBe(1)
  expect(usageDelivered(hold.held[0].notice)).toBe(false)
  ready = true
  // The existing hold retries when the relay becomes available.
  hold.held[0].retry = undefined
  hold.settle()
  usageNotices({ notices: [n], push: true }, notice => hold.tell(notice))
  expect(hold.count).toBe(0)
  expect(attempts).toBe(2)
  expect(readTold().filter(t => t.notice.data?.notice === n.id)).toHaveLength(1)
})

test("an unsent fact can retry on the next minute without being marked delivered", () => {
  const n = fact(); let attempts = 0
  usageNotices({ notices: [n], push: true }, () => { attempts++; return false })
  const hold = holdFor(() => { attempts++; return true })
  usageNotices({ notices: [n], push: true }, notice => hold.tell(notice))
  usageNotices({ notices: [n], push: true }, notice => hold.tell(notice))
  expect(attempts).toBe(2)
})

test("a queued notice does not push after its reset passes", () => {
  let wall = Date.now(), sent = 0
  const n = { ...fact(wall), resetsAt: wall + 30_000 }
  const hold = new NoticeHold({ send: () => { sent++; return false }, wall: () => wall, setTimer: (() => 0) as any, clearTimer: () => {} })
  usageNotices({ notices: [n], push: true }, notice => hold.tell(notice))
  expect(hold.count).toBe(1)
  wall += 31_000
  hold.settle()
  expect(hold.count).toBe(0)
  expect(sent).toBe(1)
})

test("peer notice is kept for Mac without pushing; source can still push once", () => {
  const n = fact(); let sent = 0
  const hold = holdFor(() => { sent++; return true })
  usageNotices({ notices: [n], push: false }, notice => hold.tell(notice))
  expect(sent).toBe(0)
  expect(readTold().find(t => t.notice.data?.notice === n.id)?.notice.subtitle).toBe("Claude Weekly")
  usageNotices({ notices: [n], push: true }, notice => hold.tell(notice))
  usageNotices({ notices: [n], push: true }, notice => hold.tell(notice))
  expect(sent).toBe(1)
})

test("catch-up keeps maker time, has a short age limit, and drops reset windows", () => {
  const now = Date.now()
  const n = { ...fact(now - 5 * 60_000), resetsAt: now + 60_000 }
  usageNotices({ notices: [n], push: false }, () => true)
  const entry = readTold().find(t => t.notice.data?.notice === n.id)!
  expect(entry.at).toBe(n.at)
  expect(toldLately(now).notices.some(t => t.id === entry.id)).toBe(true)
  expect(toldLately(now + 61_000).notices.some(t => t.id === entry.id)).toBe(false)
  expect(toldLately(now + 11 * 60_000).notices.some(t => t.id === entry.id)).toBe(false)
  let sent = 0
  const old = fact(now - 11 * 60_000), expired = { ...fact(), resetsAt: now - 1 }
  usageNotices({ notices: [old, expired, { ...fact(), milestone: "invented" }], push: true }, () => { sent++; return true })
  expect(sent).toBe(0)
  expect(readTold().some(t => [old.id, expired.id].includes(t.notice.data?.notice ?? ""))).toBe(false)
})

test("Mac before its hold is ready leaves usage eligible; deliberately disabled phone link consumes it", () => {
  const n = fact()
  const hold = macLink.hold, config = macLink.config
  try {
    macLink.hold = undefined
    macLink.config = null
    let notice: Notice | undefined
    usageNotices({ notices: [n], push: true }, value => { notice = value; return macTell(value) })
    expect(usageDelivered(notice!)).toBe(false)
    macLink.config = { phones: false } as any
    expect(macTell(notice!)).toBe(true)
    expect(usageDelivered(notice!)).toBe(true)
  } finally { macLink.hold = hold; macLink.config = config }
})

test("partial delivery to two phones retries only the phone whose send failed", () => {
  const notice: Notice = { category: "usage", data: { notice: fact().id }, title: "Cutting It Close", subtitle: "Claude Weekly" }
  const link = {
    key: newKey().toString("base64url"),
    phones: [0, 1].map(() => ({ key: publicOf(newKey()).toString("base64url"), address: randomBytes(32).toString("base64url"), name: "Test phone" })),
  } as any
  let calls = 0
  const partial = { welcomed: true, send: () => ++calls === 1 }
  expect(sendToPhones(partial, link, notice)).toBe(false)
  expect(calls).toBe(2)
  const retry = { welcomed: true, send: () => { calls++; return true } }
  expect(sendToPhones(retry, link, notice)).toBe(true)
  expect(calls).toBe(3)
  expect(sendToPhones(retry, link, notice)).toBe(true)
  expect(calls).toBe(3)
})

test("journal write failure retains in-memory marks and retries persistence without throwing", () => {
  const folder = mkdtempSync(join(tmpdir(), "usage-journal-"))
  try {
    const parent = join(folder, "blocked")
    writeFileSync(parent, "a file blocks creating the journal folder")
    const file = join(parent, "delivery.json")
    const journal = new UsageDeliveryJournal(file)
    expect(() => journal.mark("sent")).not.toThrow()
    expect(journal.has("sent")).toBe(true)
    unlinkSync(parent)
    expect(journal.has("sent")).toBe(true)
    expect(new UsageDeliveryJournal(file).has("sent")).toBe(true)
    writeFileSync(file, "null")
    const malformed = new UsageDeliveryJournal(file)
    expect(malformed.has("missing")).toBe(false)
    expect(() => malformed.mark("new")).not.toThrow()
    expect(new UsageDeliveryJournal(file).has("new")).toBe(true)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test("a usage notification shown by Mac suppresses only its stable id, not another on the same row", () => {
  let now = 0; const sent: string[] = []
  const hold = new NoticeHold({ send: notice => { sent.push(notice.data!.notice!); return true }, now: () => now, setTimer: (() => 0) as any, clearTimer: () => {} })
  const first = fact(), second = { ...fact(), row: "same-row" }
  first.row = second.row
  hold.attend("mac", { seconds: 45 })
  usageNotices({ notices: [first, second], push: true }, notice => hold.tell(notice))
  hold.attend("mac", { seconds: 45, shown: [{ session: `usage:${first.row}`, ask: false, request: first.id }] })
  now = 61_000
  hold.settle()
  expect(sent).toEqual([second.id])
})

test("a queued losing forwarder copy is cancelled when a snapshot agrees on another holder", () => {
  let now = 0; const sent: string[] = []
  const hold = new NoticeHold({ send: notice => { sent.push(notice.data!.notice!); return true }, now: () => now, setTimer: (() => 0) as any, clearTimer: () => {} })
  const n = { ...fact(), forwarder: "z" }
  hold.attend("mac", { seconds: 90 })
  usageSnapshot({ notices: [n], ownNotices: [n] }, notice => hold.tell(notice), hold)
  expect(hold.count).toBe(1)
  usageSnapshot({ notices: [{ ...n, forwarder: "a" }], ownNotices: [] }, notice => hold.tell(notice), hold)
  now = 120000; hold.settle()
  expect(hold.count).toBe(0)
  expect(sent).toEqual([])
})

test("a catch-up resolving after a reconnect cannot replace the new connection's snapshot", async () => {
  const old = new AbortController(), current = new AbortController()
  let finish!: (answer: unknown) => void
  const late = new Promise(resolve => { finish = resolve })
  const applied: string[] = []
  const pending = catchUpUsage(old.signal, () => 0, () => late, data => applied.push(String(data.id)))
  old.abort()
  await catchUpUsage(current.signal, () => 0, async () => ({data:{id:"current"}}), data => applied.push(String(data.id)))
  finish({data:{id:"old"}})
  await pending
  expect(applied).toEqual(["current"])
})

test("a newer usage-notices event invalidates an in-flight catch-up", async () => {
  const connection = new AbortController()
  let revision = 0, finish!: (answer: unknown) => void
  const late = new Promise(resolve => { finish = resolve })
  const delivered: string[] = []
  const pending = catchUpUsage(connection.signal, () => revision, () => late, data => usageSnapshot(data, n => delivered.push(n.data!.notice!)))
  const fresh = fact(), stale = fact()
  // The watcher advances this revision when it receives kuvo.usage.notices.
  revision++
  usageNotices({notices:[fresh],push:true}, n => delivered.push(n.data!.notice!))
  finish({data:{notices:[stale],ownNotices:[stale]}})
  await pending
  expect(delivered).toEqual([fresh.id])
})

