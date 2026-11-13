import "./safety"
import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { usageNotices } from "../src/link/notices/usage"
import { readTold, toldLately } from "../src/link/notices/told"

const fact = (at = Date.now()) => ({ id: `usage_${randomUUID()}`, row: "claude#0123456789abcdef", service: "claude", window: "seven_day", milestone: "healthyToClose", at, remaining: 0.15 })
test("usage adapter persists once only after phone delivery succeeds", () => {
  const n = fact(); let attempts = 0
  usageNotices({notices:[n],push:true}, () => { attempts++; return false })
  usageNotices({notices:[n],push:true}, () => { attempts++; return true })
  usageNotices({notices:[n],push:true}, () => { attempts++; return true })
  expect(attempts).toBe(2)
  expect(readTold().filter(t => t.notice.data?.notice === n.id)).toHaveLength(1)
})
test("peer notice is kept for Mac without pushing; source can still push once", () => {
  const n = fact(); let sent = 0
  usageNotices({notices:[n],push:false}, () => { sent++; return true })
  expect(sent).toBe(0)
  expect(readTold().find(t => t.notice.data?.notice === n.id)?.notice.category).toBe("usage")
  usageNotices({notices:[n],push:true}, () => { sent++; return true })
  expect(sent).toBe(1)
})
test("native usage facts survive app closed longer than ten minutes", () => {
  const n = fact()
  usageNotices({notices:[n],push:false}, () => true)
  expect(toldLately(Date.now()+60*60_000).notices.some(t => t.notice.data?.notice === n.id)).toBe(true)
})
test("expired and malformed facts never deliver", () => {
  let sent = 0
  usageNotices({notices:[fact(Date.now()-25*60*60_000),{...fact(),milestone:"invented"}],push:true}, () => { sent++; return true })
  expect(sent).toBe(0)
})
