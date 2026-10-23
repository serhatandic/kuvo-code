import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  compose,
  isPass,
  jobInMemory,
  mentions,
  nextSpeaker,
  parts,
  ring,
  said,
  seatInstructions,
  seatRules,
  splitText,
  turnText,
  chatText,
  seatStartText,
  guestText,
  guests,
  outgrew,
  type Group,
  type GroupMessage,
  type GroupTask,
  type SeatBot,
} from "../src/groups/rules"
import { next, parseRepeat, planMeeting } from "../src/groups/time"

// What the Mac's group chat rules say (KuvoCodeTests/GroupRulesVectorsTests, written by
// scripts/group-vectors.sh): a group chat that lives on a machine goes by the same.
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "groups-vectors.json"), "utf8"))

describe("a group chat on a machine goes by the Mac's rules", () => {
  test("what counts as a pass", () => {
    for (const { text, pass } of vectors.isPass) expect([text, isPass(text)]).toEqual([text, pass])
  })

  test("who does what, from the lead's list", () => {
    for (const vector of vectors.parts) {
      const found = parts(vector.text, vector.names)
      expect({ text: vector.text, ...found }).toEqual({ text: vector.text, go: vector.go, parts: vector.parts })
    }
  })

  test("parts waiting on each other", () => {
    for (const vector of vectors.ring) {
      const tasks: GroupTask[] = vector.tasks.map((task: any) => ({ id: task.id, bot: task.bot, task: "t", state: task.state, after: task.after }))
      const through = tasks.find((task) => task.id === vector.task)!
      expect(ring(through, tasks)?.map((task) => task.id) ?? null).toEqual(vector.ring)
    }
  })

  test("a part as it reaches a bot's own conversation", () => {
    for (const vector of vectors.compose) {
      const chat: Group = { id: vector.chat.id, name: vector.chat.name, members: [], seats: {}, heard: {}, created: "" }
      const wrapUp: GroupMessage = { id: "gm_1", author: "bot_ada", text: vector.wrapUp, time: "", kind: "wrapUp" }
      const task: GroupTask = { id: "gt_1", bot: "bot_ben", task: vector.task, state: "proposed" }
      expect(compose(task, chat, wrapUp, vector.from, vector.before)).toBe(vector.text)
    }
  })

  test("what the lead is asked after its wrap-up", () => {
    for (const vector of vectors.splitText) expect(splitText(vector.names, vector.said)).toBe(vector.text)
  })

  test("what a bot is told at its turn", () => {
    for (const vector of vectors.turnText) {
      const name = (author?: string) => (author === undefined ? "User" : (vector.names[author] ?? "A bot that left"))
      const group: Group = vector.group
      expect(turnText(vector.bot, group, vector.unheard, vector.wrapUp, name, vector.named ?? undefined)).toBe(vector.text)
    }
  })

  test("what a bot reads in a conversation new to it: the whole chat", () => {
    for (const vector of vectors.freshText) {
      const name = (author?: string) => (author === undefined ? "User" : (vector.names[author] ?? "A bot that left"))
      const group: Group = vector.group
      expect(chatText(vector.bot, group, vector.all, name)).toBe(vector.chat)
      expect(seatStartText(vector.bot, group, vector.all, vector.wrapUp, name, vector.named ?? undefined)).toBe(vector.start)
      expect(guestText(vector.bot, group, vector.all, vector.asker ?? undefined, name)).toBe(vector.guest)
    }
  })

  test("who's asked in as a guest", () => {
    for (const vector of vectors.guests) expect(guests(vector.messages, vector.members, vector.bots)).toEqual(vector.guests)
  })

  test("when a seat has outgrown its chat", () => {
    for (const vector of vectors.outgrew) expect([vector.size, outgrew(vector.size, vector.chat)]).toEqual([vector.size, vector.outgrew])
  })

  test("who talks next", () => {
    for (const vector of vectors.nextSpeaker) {
      const names = new Map<string, string>(Object.entries(vector.names))
      const found = nextSpeaker(vector.group, vector.messages, vector.members, new Set(vector.quiet), names)
      expect([vector.messages.at(-1)?.text, found ?? null]).toEqual([vector.messages.at(-1)?.text, vector.next])
    }
  })

  test("who a message names with @", () => {
    for (const vector of vectors.mentions) {
      const bots = vector.names.map((name: string) => ({ id: "bot_" + name, name }))
      expect([vector.text, mentions(vector.text, bots)]).toEqual([vector.text, vector.ids])
    }
  })

  test("what a seat said", () => {
    for (const vector of vectors.said) {
      const found = said(vector.messages)
      expect({ text: found.text, error: found.error ?? null, steps: found.steps.map((step) => step.id) }).toEqual({ text: vector.text, error: vector.error, steps: vector.steps })
    }
  })

  test("what a seat is told", () => {
    for (const vector of vectors.seatInstructions) {
      const seat = (bot: any): SeatBot => ({ id: bot.id, name: bot.name, job: bot.job, instructions: bot.instructions, folder: bot.folder, memoryFile: bot.folder + "/MEMORY.md" })
      const others = vector.others.map(seat)
      const me = seat(vector.bot)
      const lead = vector.lead === null ? undefined : [me, ...others].find((bot) => bot.id === vector.lead)
      expect(seatInstructions(me, vector.group, others, lead, vector.personality ?? undefined, vector.identityNote)).toBe(vector.text)
    }
  })

  test("a seat's rules", () => {
    for (const vector of vectors.seatRules) expect(seatRules(vector.folder, vector.askFirst, vector.denies)).toEqual(vector.rules)
  })

  test("a bot's job, from its memory", () => {
    for (const vector of vectors.job) {
      const job = jobInMemory(vector.memory)
      expect([vector.memory, job?.line ?? null, job?.section ?? null]).toEqual([vector.memory, vector.line, vector.section])
    }
  })

  test("a meeting as you set it up, as the Mac plans it", () => {
    const wrong: string[] = []
    for (const vector of vectors.planMeeting) {
      const planned = planMeeting({ next: vector.next, every: vector.every ?? null, topic: vector.topic }, vector.before, vector.zone, vector.now * 1000)
      const found = typeof planned === "string" ? null : { ...planned, next: Date.parse(planned.next) / 1000 }
      if (JSON.stringify(found) !== JSON.stringify(vector.meeting === null ? null : { next: vector.meeting.next, ...(vector.meeting.every ? { every: vector.meeting.every } : {}), topic: vector.meeting.topic, ...(vector.meeting.at !== undefined ? { at: vector.meeting.at } : {}), ...(vector.meeting.weekday !== undefined ? { weekday: vector.meeting.weekday } : {}) })) {
        wrong.push(`${vector.zone} ${vector.every ?? "once"} at ${new Date(vector.next * 1000).toISOString()}: ${JSON.stringify(found)}, not ${JSON.stringify(vector.meeting)}`)
      }
    }
    expect(vectors.planMeeting.length).toBeGreaterThan(10)
    expect(wrong.slice(0, 10)).toEqual([])
  })

  test("when a repeating meeting comes back", () => {
    const wrong: string[] = []
    for (const vector of vectors.next) {
      const every = parseRepeat(vector.every)!
      const found = next(every, vector.due * 1000, vector.now * 1000, vector.zone, vector.at, vector.weekday) / 1000
      if (found !== vector.next) wrong.push(`${vector.zone} ${vector.every} due ${new Date(vector.due * 1000).toISOString()} now ${new Date(vector.now * 1000).toISOString()} at ${vector.at} weekday ${vector.weekday}: ${new Date(found * 1000).toISOString()}, not ${new Date(vector.next * 1000).toISOString()}`)
    }
    expect(wrong.slice(0, 10)).toEqual([])
  })
})
