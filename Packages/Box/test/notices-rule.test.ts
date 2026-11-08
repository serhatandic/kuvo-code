import "./safety"
import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { noticeFor } from "../src/link/notices/news"
import { oneSentence } from "../src/link/notices/sentence"
import { notifyUserTool, NOTIFY_LIMITS } from "../src/link/notices/notify"
import { readTold, TOLD_FOLDER, keepTold, toldLately, watchSentByAgents } from "../src/link/notices/told"
import { noticesRoute } from "../src/link/areas/notices"
import type { Notice } from "../src/link/notices/notice"

// Your phones and the Mac tell you only what you need (task #152): a reply to what you asked, a
// question or a failure, and what an agent sends you on purpose (notify_user). Never a bot's
// wake-up, a session's own timer, or a session answering the agent that started it. Each says it in
// one sentence.

afterEach(() => rmSync(TOLD_FOLDER, { recursive: true, force: true }))

const yours = { id: "ses_main", title: "Fix the tests", location: { directory: "/home/me/kuvo-ai" } }
const bot = { id: "ses_bot", title: "Fixer", metadata: { kuvo: { bot: "bot_1" } }, location: { directory: "/home/me/.kuvo-code/bots/bot_1/workspace" } }
const started = { id: "ses_work", title: "Check the docs", metadata: { kuvo: { startedBy: "ses_bot", by: { bot: "bot_1", name: "Fixer" }, depth: 1 } }, location: { directory: "/home/me/kuvo-ai" } }
const sessions: Record<string, object> = { ses_main: yours, ses_bot: bot, ses_work: started }

const reply = (text: string) => ({ type: "assistant", content: [{ type: "text", text }] })
const idle = { type: "idle", outcome: "succeeded" }
const user = (text: string, metadata?: unknown) => ({ type: "user", text, ...(metadata ? { metadata } : {}) })

// An engine whose sessions' latest messages (newest first) are `page`.
const engine = (page: unknown[]) => async (route: string) => {
  if (route.includes("/message?")) return { data: page }
  const id = decodeURIComponent(route.split("/").pop()!)
  if (!sessions[id]) throw new Error("404")
  return { data: sessions[id] }
}
const ended = (session: string, page: unknown[], type = "session.execution.succeeded", data: object = {}) =>
  noticeFor({ type, data: { sessionID: session, ...data } }, engine(page))

test("a reply to what you asked is news, said in its first sentence", async () => {
  const notice = await ended("ses_main", [idle, reply("**All** 42 tests pass now.\n\nI changed `Parser.swift` and the fixtures, and ran the suite twice."), user("Fix the failing tests")])
  expect(notice).toMatchObject({ title: "Fix the tests", subtitle: "kuvo-ai", category: "finished", body: "All 42 tests pass now.", data: { session: "ses_main" } })
})

test("a bot's reply to you is its report; its own wake-up's isn't news", async () => {
  expect((await ended("ses_bot", [idle, reply("Done."), user("How are the builds?")]))?.category).toBe("report")
  // Its wake-up, with the summary its agent gave it, and from before wake-ups were marked.
  expect(await ended("ses_bot", [idle, reply("Builds are green."), user("[Wake-up] Check the builds", { kuvo: { wake: { summary: "Check builds" } } })])).toBeNull()
  expect(await ended("ses_bot", [idle, reply("Builds are green."), user("[Wake-up] Check the builds")])).toBeNull()
  // A turn that's a reply to you, though an older wake-up turn came before it: news.
  expect(await ended("ses_bot", [idle, reply("Yes."), user("Is it green?"), idle, reply("Green."), user("[Wake-up] Check")])).not.toBeNull()
})

test("a session's own timer turn isn't news, in your own conversation too", async () => {
  expect(await ended("ses_main", [idle, reply("The build passed."), user("[Wake-up] Check the build", { kuvo: { wake: { summary: "Check the build" } } })])).toBeNull()
})

test("a session a bot started, answering the bot, isn't news; your own word to it is", async () => {
  const letter = '[Message from Fixer · ses_bot] (To answer, use send_message to ses_bot.)\n\nCheck the docs for broken links.'
  expect(await ended("ses_work", [idle, reply("Found two broken links."), user(letter)])).toBeNull()
  // What it left running coming back, there: the bot's business.
  expect(await ended("ses_work", [idle, reply("The crawl finished."), { type: "synthetic", metadata: { source: "shell" } }])).toBeNull()
  // You opened it and asked it something yourself.
  expect(await ended("ses_work", [idle, reply("Two, both in the README."), user("How many did you find?")])).not.toBeNull()
})

test("a goal's word to its bot isn't news; its sessions' news coming back is, in a conversation of yours only", async () => {
  expect(await ended("ses_bot", [idle, reply("Carrying on."), user("[Goal] Nothing of the goal is at work now.", { kuvo: { note: { from: "Goal", line: "Reminded to carry on" } } })])).toBeNull()
  const news = user('[Session finished] "Docs" in kuvo-ai (address ses_work):\nDone.', { kuvo: { note: { from: "Its sessions", line: "“Docs” finished" } } })
  expect(await ended("ses_main", [idle, reply("The docs session is done: two links fixed."), news])).not.toBeNull()
  expect(await ended("ses_bot", [idle, reply("The docs session is done."), news])).toBeNull()
  // Your answer to a question, passed on by the box, is yours.
  expect(await ended("ses_bot", [idle, reply("Using Postgres."), user("[The user answered] Postgres")])).not.toBeNull()
})

test("a failure is news, with its reason on one line, whoever began the turn", async () => {
  const failed = await ended("ses_bot", [idle, user("[Wake-up] Check")], "session.execution.failed", { error: { message: "Rate limited by the provider.\nTry again in 20 minutes." } })
  expect(failed).toMatchObject({ category: "failed", body: "Stopped with an error: Rate limited by the provider." })
  expect((await ended("ses_main", [], "session.execution.failed"))?.body).toBe("Stopped with an error.")
})

test("a question is news, said as its question", async () => {
  const form = { id: "frm_1", sessionID: "ses_bot", metadata: { kind: "question" }, fields: [{ type: "string", description: "Which database should the new service use?" }] }
  const notice = await noticeFor({ type: "form.created", data: { form } as never }, engine([]))
  expect(notice).toMatchObject({ category: "question", body: "Which database should the new service use?", data: { session: "ses_bot", request: "frm_1" } })
})

test("a reply's sentence: past headings, code and lists, a lead-in with its first item, cut at a word", () => {
  expect(oneSentence("## Summary\n\nFixed the parser. Also cleaned up tests.")).toBe("Fixed the parser.")
  expect(oneSentence("```sh\nnpm test\n```\nAll green, e.g. the parser tests. More here.")).toBe("All green, e.g. the parser tests.")
  expect(oneSentence("Here's what changed:\n\n- Parser handles v1.2 dates.\n- Fixtures updated.")).toBe("Here's what changed: Parser handles v1.2 dates.")
  expect(oneSentence("Is it ok to [deploy](https://example.com) now? I'm ready.")).toBe("Is it ok to deploy now?")
  const long = oneSentence("word ".repeat(80))
  expect(long.length).toBeLessThanOrEqual(160)
  expect(long.endsWith("word…")).toBe(true)
  expect(oneSentence("   \n\n")).toBe("")
})

test("notify_user tells you once, in a sentence, and an agent in a loop can't keep at it", () => {
  const caller = { session: "ses_bot", data: bot, name: "Fixer" }
  let now = 1_000_000_000
  const first = notifyUserTool(caller, { text: "I need your **Stripe** key to go on. The rest is done." }, now)
  expect(first.isError).toBe(false)
  const told = readTold()
  expect(told).toHaveLength(1)
  expect(told[0]).toMatchObject({ by: "agent", notice: { title: "Fixer", category: "report", body: "I need your Stripe key to go on.", thread: "ses_bot", data: { session: "ses_bot" } } })
  // The same again, or another at once: refused.
  now += NOTIFY_LIMITS.apart + 1
  expect(notifyUserTool(caller, { text: "I need your Stripe key to go on." }, now).isError).toBe(true)
  expect(notifyUserTool(caller, { text: "Something else entirely." }, now - NOTIFY_LIMITS.apart).isError).toBe(true)
  // Up to the hour's limit, then refused until the hour's past.
  for (let sent = 1; sent < NOTIFY_LIMITS.hour; sent++) {
    now += NOTIFY_LIMITS.apart + 1
    expect(notifyUserTool(caller, { text: `Update number ${sent}.` }, now).isError).toBe(false)
  }
  now += NOTIFY_LIMITS.apart + 1
  const over = notifyUserTool(caller, { text: "One more thing." }, now)
  expect(over.isError).toBe(true)
  expect(over.text).toContain("this hour")
  expect(notifyUserTool(caller, { text: "One more thing." }, now + 60 * 60_000).isError).toBe(false)
  // Nothing to say, and a group chat's seat: refused.
  expect(notifyUserTool({ session: "ses_x", data: { id: "ses_x" }, name: null }, { text: "  " }).isError).toBe(true)
  expect(notifyUserTool({ session: "ses_seat", data: { id: "ses_seat", metadata: { kuvo: { seat: { group: "grp_1" } } } }, name: null }, { text: "Hi." }).isError).toBe(true)
  // Your own conversation: by its title, with its project.
  notifyUserTool({ session: "ses_main", data: yours, name: "Fix the tests" }, { text: "Can I delete the old fixtures?" })
  expect(readTold().at(-1)?.notice).toMatchObject({ title: "Fix the tests", subtitle: "kuvo-ai", category: "finished", body: "Can I delete the old fixtures?" })
})

test("what an agent sends goes to your phones once, from the process that tells them; news isn't sent twice", () => {
  const sent: Notice[] = []
  const watch = watchSentByAgents(notice => { sent.push(notice); return true }, { every: 60_000 })
  try {
    // A run's news kept as told is the box's own telling: not sent again from here.
    keepTold({ title: "Fix the tests", body: "Done.", category: "finished", thread: "ses_main", data: { session: "ses_main" } })
    notifyUserTool({ session: "ses_main", data: yours, name: null }, { text: "Can I push to main?" })
    watch.look()
    watch.look()
    expect(sent.map(each => each.body)).toEqual(["Can I push to main?"])
  } finally {
    watch.stop()
  }
})

test("clients read what the box told lately, to show it as their own notifications", async () => {
  keepTold({ title: "Fix the tests", body: "All green.", category: "finished", thread: "ses_main", data: { session: "ses_main" } })
  expect(toldLately().notices.map(each => each.notice.body)).toEqual(["All green."])
  // Long past: no longer listed.
  expect(toldLately(Date.now() + 11 * 60_000).notices).toHaveLength(0)
  const json = (status: number, value: unknown) => [{ head: { status, headers: {} } }, { body: Buffer.from(JSON.stringify(value)) }]
  const pieces = []
  for await (const piece of noticesRoute({ request: { method: "GET", path: "kuvo/notices", headers: {} }, route: "kuvo/notices", json } as never)) pieces.push(piece)
  const answer = JSON.parse(String((pieces[1] as { body: Buffer }).body))
  expect(answer.notices[0]).toMatchObject({ notice: { body: "All green.", category: "finished" } })
  expect(typeof answer.telling).toBe("boolean")
})
