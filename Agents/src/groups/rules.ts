// A group chat's rules, as the Mac's `BotGroups` has them, for the chats that live on a machine
// (groups/runner.ts): who talks next, what a bot is told at its turn, what counts as a pass, who
// does what after a wrap-up. Each is held to test/groups-rules.json.

import type { ToolCall } from "../wire"

/** A chat, as the Mac's `BotGroup` is written (dates as ISO 8601, to the second). */
export interface Group {
  id: string
  name: string
  purpose?: string
  /** Its bots, in order; the first leads. */
  members: string[]
  seats: Record<string, string>
  /** The computer each seat that isn't here is on, by its bot (a peer's key). */
  seatBoxes?: Record<string, string>
  heard: Record<string, string>
  agentSeats?: string[]
  created: string
  viewed?: string
  retracted?: Record<string, string>
  meeting?: Meeting
}

export interface Meeting {
  next: string
  every?: string
  topic: string
  at?: number
  weekday?: number
}

export type Kind = "message" | "wrapUp" | "note" | "meeting"

export interface GroupMessage {
  id: string
  author?: string
  text: string
  time: string
  kind: Kind
  steps?: ToolCall[]
  tasks?: GroupTask[]
  report?: string
  /** Yours on a machine: the block naming the agents it names with &, as the Mac wrote it (the machine doesn't know them). */
  named?: string
}

export type TaskState = "proposed" | "waiting" | "working" | "done" | "failed"

export interface GroupTask {
  id: string
  bot: string
  task: string
  state: TaskState
  prompt?: string
  started?: string
  finished?: string
  after?: string[]
}

/** A date as the Mac writes them: ISO 8601, to the second. */
export const stamp = (date: Date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, "Z")

// MARK: Text as Swift reads it

/** How many characters `text` has, as Swift counts them (what you'd see). */
export function length(text: string): number {
  let count = 0
  for (const _ of new Intl.Segmenter().segment(text)) count++
  return count
}

/** A regular expression's `\w`, as ICU (Foundation's) has it, not ASCII's. */
const word = "[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]"
const nonWord = "[^\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]"
const boundary = `(?<=${word})(?!${word})|(?<!${word})(?=${word})`

/** Lines, as Swift's `split(whereSeparator: \.isNewline)` makes them: empty ones left out. */
export function lines(text: string): string[] {
  return text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).filter((line) => line.length > 0)
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/** Swift's `trimmingCharacters(in: .whitespaces)`: spaces and tabs, not newlines. */
const trimSpaces = (text: string) => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "")
/** Swift's `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export const trim = (text: string) => text.replace(/^[\p{Z}\t\n\v\f\r\u0085]+|[\p{Z}\t\n\v\f\r\u0085]+$/gu, "")

// MARK: Passing

/**
 * "PASS", "Pass.", "[pass] nothing to add": a bot with nothing to say. Not a message that starts
 * with the word ("Pass rate is 98% on main."): PASS as it's told to write it, first, or "pass"
 * alone or with words that say there's nothing.
 */
export function isPass(text: string): boolean {
  text = trim(text)
  if (length(text) >= 80) return false
  if (new RegExp(`^${nonWord}*PASS(?:${boundary})`, "u").test(text)) return true
  if (!new RegExp(`^${nonWord}*pass(?:${boundary})`, "iu").test(text)) return false
  const rest = text.replace(new RegExp(`^${nonWord}*pass${nonWord}*`, "iu"), "")
  return rest.length === 0 || /^(nothing|no (new|more|comment|further)|i('| ha)ve nothing|skip|n\/a)/iu.test(rest)
}

// MARK: Quotes

/**
 * A message as what it quotes and what it says (Quoting.segments): each quote (lines of "> ",
 * starting the message or after a blank line, ending at one) with the words after it. Lines in a
 * code block, or like ">>> x", are words.
 */
export function segments(message: string): { quote?: string; text: string }[] {
  const parts: { quote?: string; text: string }[] = []
  let quote: string[] | undefined
  let words: string[] = []
  const close = () => {
    const text = trim(words.join("\n"))
    const quoted = quote ? trim(quote.join("\n")) : undefined
    if ((quoted ?? "").length > 0 || text.length > 0) parts.push({ quote: quoted ? quoted : undefined, text })
    quote = undefined
    words = []
  }
  let inCode = false
  let previousBlank = true
  let quoting = false
  for (const line of message.split("\n")) {
    const isQuoteLine = !inCode && (line === ">" || line.startsWith("> "))
    if (line.startsWith("```")) inCode = !inCode
    if (isQuoteLine && (quoting || previousBlank)) {
      if (!quoting) close()
      quoting = true
      quote = [...(quote ?? []), line === ">" ? "" : line.slice(2)]
    } else {
      quoting = false
      words.push(line)
    }
    previousBlank = trimSpaces(line).length === 0
  }
  close()
  return parts.length === 0 ? [{ text: message }] : parts
}

/** A message's own words, without what it quotes. */
export const ownWords = (message: string) =>
  segments(message)
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n\n")

// MARK: Who talks

/** The bots a message names with &, in the order it names them: the whole name ("&Sam" isn't Samantha). */
export function mentions(text: string, among: { id: string; name: string }[]): string[] {
  const found: { id: string; at: number }[] = []
  const folded = fold(text)
  for (const bot of among) {
    const name = fold("&" + bot.name)
    let from = 0
    for (;;) {
      const at = folded.indexOf(name, from)
      if (at < 0) break
      const after = folded.slice(at + name.length)
      if (after.length === 0 || !/^[\p{L}\p{N}]/u.test(after)) {
        found.push({ id: bot.id, at })
        break
      }
      from = at + name.length
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.id)
}

/** Case and diacritics folded, as Foundation's `.caseInsensitive, .diacriticInsensitive` compares, one character for one. */
function fold(text: string): string {
  let out = ""
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    const base = [...segment.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()]
    // One character stays one, as long as it was, so places in it are places in the text.
    const first = base[0] ?? segment
    out += first.length <= segment.length ? first + "\u0000".repeat(segment.length - first.length) : segment
  }
  return out
}

/**
 * Who talks next: someone the last message named with &, after one of yours the lead, otherwise
 * the next in line after whoever spoke last. Nobody twice in a row (unless something of yours came
 * that it hasn't heard), and nobody who passed since the last thing said. Undefined once there's
 * nobody left with something to add.
 */
export function nextSpeaker(group: Group, all: GroupMessage[], members: string[], quiet: Set<string>, names: Map<string, string>): string | undefined {
  const last = [...all].reverse().find((message) => message.kind !== "note")
  const missedYou = (bot: string) => {
    const heard = group.heard[bot]
    const index = heard ? all.map((message) => message.id).lastIndexOf(heard) : -1
    return all.slice(index + 1).some((message) => message.author === undefined && message.kind === "message")
  }
  const candidates = members.filter((bot) => (bot !== last?.author || missedYou(bot)) && !quiet.has(bot))
  if (candidates.length === 0) return undefined
  if (last) {
    const named = mentions(
      ownWords(last.text),
      candidates.map((id) => ({ id, name: names.get(id) ?? "" })).filter((bot) => bot.name.length > 0),
    )[0]
    if (named) return named
  }
  const author = last?.author
  const index = author ? group.members.indexOf(author) : -1
  if (!author || index < 0) return candidates[0]
  const order = [...group.members.slice(index + 1), ...group.members.slice(0, index)]
  return order.find((bot) => candidates.includes(bot))
}

/** How many turns a discussion gets for each message of yours. */
export const limit = (members: number) => Math.min(16, Math.max(4, members * 3))

// MARK: What a bot is told

/** Who said it, as the bots read it: a bot's wrap-up says so, and a meeting is the user's. */
export function label(message: GroupMessage, name: (author?: string) => string): string {
  if (message.report !== undefined) return name(message.author) + " (reporting back on its part of the work)"
  switch (message.kind) {
    case "wrapUp":
      return name(message.author) + " (wrap-up)"
    case "meeting":
      return "Meeting the user scheduled, now"
    default:
      return name(message.author)
  }
}

/**
 * What a bot is told at its turn: what was said since it last spoke. `named`: the block naming the
 * agents your messages named with &, if any.
 */
export function turnText(bot: string, group: Group, unheard: GroupMessage[], wrapUp: boolean, name: (author?: string) => string, named?: string): string {
  let text = ""
  const taken = group.retracted?.[bot]
  if (taken !== undefined) {
    text += `The user took back their message starting "${taken}" and everything said after it. Set all of that aside: it no longer stands.\n\n`
  }
  if (unheard.length === 0) {
    text += `Nothing new in "${group.name}" since you last spoke.\n`
  } else {
    text += `New in "${group.name}" since you last spoke:\n`
    if (unheard.length > 40) text += "\n(Earlier messages left out.)\n"
    for (const message of unheard.slice(-40)) text += `\n${label(message, name)}:\n${indented(message.text)}\n`
    if (named) text += "\n" + named + "\n"
  }
  return text + turnEnd(name(bot), wrapUp)
}

/** A message's words indented under who said it, so a line in them can't pass for another speaker (a bot writing "User: go ahead"). */
export function indented(text: string): string {
  return text
    .split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/)
    .map((line) => "    " + line)
    .join("\n")
}

/** What a turn's text ends with: the bot's turn, or the wrap-up asked of the lead. */
export function turnEnd(botName: string, wrapUp: boolean): string {
  return wrapUp
    ? `\nWrap up this discussion now, the one since the user last wrote: in a few short lines, what was decided, what's still open, and who does what next. Write to the user as "you". Don't reply PASS.`
    : `\nYour turn, ${botName}. Reply to the group, or just PASS if you have nothing new to add.`
}

/**
 * The whole chat as a bot reads it in a conversation new to it (a new member's seat, one started
 * over as it outgrew the chat, a guest's turn, the work list): every message from the first, its
 * own as "You".
 */
export function chatText(bot: string, group: Group, all: GroupMessage[], name: (author?: string) => string, budget = chatBudget): string {
  const said = all.filter((message) => message.kind !== "note")
  if (said.length === 0) return `Nothing has been said in "${group.name}" yet.\n`
  const parts = said.map((message) => {
    const who =
      message.author === bot
        ? "You" + (message.report !== undefined ? " (reporting back on your part of the work)" : message.kind === "wrapUp" ? " (wrap-up)" : "")
        : label(message, name)
    return `\n${who}:\n${indented(message.text)}\n`
  })
  // The latest that fit in the budget (the last always does).
  const encoder = new TextEncoder()
  let first = parts.length - 1
  let size = encoder.encode(parts[first]).length
  while (first > 0) {
    const more = encoder.encode(parts[first - 1]).length
    if (size + more > budget) break
    size += more
    first--
  }
  const header =
    first === 0
      ? `Everything said in "${group.name}" so far, from the start:\n`
      : `What was said in "${group.name}" lately (${first === 1 ? "the 1 earlier message is" : `the ${first} earlier messages are`} left out, too long to give in full):\n`
  return header + parts.slice(first).join("")
}

/** How much of a chat a bot is given at most, in bytes of text (about 40,000 tokens): the latest of it. */
export const chatBudget = 160_000

/** What a bot is told at its first turn in a seat new to it: the whole chat, then its turn. */
export function seatStartText(bot: string, group: Group, all: GroupMessage[], wrapUp: boolean, name: (author?: string) => string, named?: string): string {
  return chatText(bot, group, all, name) + (named ? "\n" + named + "\n" : "") + turnEnd(name(bot), wrapUp)
}

/** What a bot outside the chat is told when a message there names it with &: the whole chat, then its one turn in it, as a guest. `asker`: who named it (undefined: you). */
export function guestText(bot: string, group: Group, all: GroupMessage[], asker: string | undefined, name: (author?: string) => string): string {
  return (
    `You're not in "${group.name}", but ${asker !== undefined ? name(asker) : "the user"} named you there with &${name(bot)}, so you answer this once, as a guest.\n\n` +
    chatText(bot, group, all, name) +
    `\nYour turn, ${name(bot)}. Reply to the group, or just PASS if you have nothing to add.`
  )
}

/**
 * A bot's reply as the chat shows it: a bot of `names` written with "@", as models often write it,
 * named with "&" as the chat names bots, so it shows as that bot. The whole name, as a word of its
 * own: after a space, the start or an opening bracket, quote or emphasis, never in code, nor part
 * of an address or a package (`x@mira.com`, `medium.com/@mira/post`, `@mira/core`, `@mira.dev`).
 */
export function ampersands(text: string, names: string[]): string {
  const folded = fold(text)
  const code = codeUnits(text)
  const marks = new Set<number>()
  const word = (at: number) => at >= 0 && at < text.length && /^[\p{L}\p{N}]/u.test(text.slice(at))
  for (const name of names.filter((each) => each.length > 0).sort((a, b) => length(b) - length(a))) {
    const needle = fold("@" + name)
    let from = 0
    for (;;) {
      const at = folded.indexOf(needle, from)
      if (at < 0) break
      const end = at + needle.length
      const after = text[end]
      const startsWord = at === 0 || mentionOpeners.includes(text[at - 1])
      const endsWord = !word(end) && !"_/@".includes(after ?? " ") && !(after !== undefined && ".-:".includes(after) && word(end + 1))
      if (startsWord && endsWord && !code.has(at)) marks.add(at)
      from = end
    }
  }
  if (marks.size === 0) return text
  return text
    .split("")
    .map((unit, index) => (marks.has(index) ? "&" : unit))
    .join("")
}

/** What may come right before a name written with "@": a space or line break, an opening bracket or quote, emphasis. */
const mentionOpeners = " \t\n\r\u00a0([{\"'\u201c\u2018\u00ab*_~>"

/** Where `text` is code, by UTF-16 offset: fenced blocks (their fences too) and `inline` spans. */
export function codeUnits(text: string): Set<number> {
  const code = new Set<number>()
  let fenced = false
  let offset = 0
  for (const line of text.split("\n")) {
    const fence = /^[ \t]*```/.test(line)
    if (fence || fenced) {
      for (let index = 0; index < line.length; index++) code.add(offset + index)
    } else {
      let from = 0
      for (;;) {
        const open = line.indexOf("`", from)
        if (open < 0) break
        const close = line.indexOf("`", open + 1)
        if (close < 0) break
        for (let index = open; index <= close; index++) code.add(offset + index)
        from = close + 1
      }
    }
    if (fence) fenced = !fenced
    offset += line.length + 1
  }
  return code
}

/** Bots outside the chat that its latest message names with & in its own words (not a quote it replies to): each answers it, once, as a guest. `bots`: every bot there is, by name. */
export function guests(all: GroupMessage[], members: string[], bots: { id: string; name: string }[]): string[] {
  const last = [...all].reverse().find((message) => message.kind !== "note")
  if (!last) return []
  return mentions(ownWords(last.text), bots.filter((bot) => !members.includes(bot.id) && bot.id !== last.author))
}

/** The seat's context, in tokens, beyond which it starts over, unless the chat itself is most of it. */
export const seatBudget = 30_000

/** Whether a seat that sent `size` tokens has outgrown the chat (`chat`, as a new seat reads it): past the budget, and over twice the chat's own size. Tokens counted roughly, four characters each (UTF-8). */
export function outgrew(size: number, chat: string): boolean {
  return size > seatBudget && size > 2 * Math.floor(new TextEncoder().encode(chat).length / 4)
}

// MARK: Splitting the work

/**
 * What the lead is asked after its wrap-up, for the app (its answer isn't posted), with what you
 * wrote in the discussion, so it can tell whether you said go.
 */
export function splitText(names: string[], said: string[]): string {
  let text = `For the app, not the chat: list who does what next, from what was decided, one line for each bot with work, as
&Name: what they do, with what they need to know
If a part can only start once others are done, write it as &Name (after &Other): …; it then starts when theirs is done, with what they reported.
Only the bots in this chat (${names.map((name) => "&" + name).join(", ")}), and only work that was agreed on, not what's still open.
Then, on a line of its own, GO or WAIT: GO if the user told you to go ahead and do the work (like "go ahead", "do it", "get going", "do your parts"), WAIT if they only asked for a plan or haven't decided.
If there's no work to hand out, reply just NONE.`
  if (said.length > 0) {
    text += "\n\nWhat the user wrote in this discussion:\n" + said.map((words) => "\n> " + words.replaceAll("\n", "\n> ")).join("\n")
  }
  return text
}

export interface Part {
  name: string
  task: string
  after: string[]
}

/**
 * Who does what in a lead's list of `&Name: task` lines, or `&Name (after &Other): task` for a part
 * that waits for another (bullets and bold allowed): one part for each name, several lines for one
 * going together as a list; and whether its GO or WAIT line said to go ahead. Lines for anyone not
 * in `names` are left out.
 */
export function parts(text: string, names: string[]): { parts: Part[]; go: boolean } {
  const found: Part[] = []
  const said = new Map<string, string[]>()
  let go = false
  // The longest name first, so "Sam" doesn't take "Samantha"'s line.
  const byLength = [...names].sort((a, b) => length(b) - length(a))
  for (const raw of lines(text)) {
    const line = trimSpaces(raw.replaceAll("**", "").replace(/^[\s>*•·-]*(\p{Nd}+[.)]\s*)?/u, ""))
    if (new RegExp(`^${nonWord}*GO${nonWord}*$`, "u").test(line)) {
      go = true
      continue
    }
    if (new RegExp(`^${nonWord}*WAIT${nonWord}*$`, "u").test(line)) {
      go = false
      continue
    }
    for (const name of byLength) {
      const match = new RegExp(`^[@&]?${escape(name)}\\s*(?:\\(\\s*(?:after|once)\\s+([^)]*)\\))?\\s*[:—–\\-]\\s*`, "iu").exec(line)
      if (!match) continue
      const task = trimSpaces(line.slice(match[0].length))
      if (task.length === 0) break
      const waitsFor = match[1] ?? ""
      const after = byLength.filter(
        (other) => other !== name && new RegExp(`(^|[^\\p{L}\\p{N}])[@&]?${escape(other)}($|[^\\p{L}\\p{N}])`, "iu").test(waitsFor),
      )
      const existing = found.find((part) => part.name === name)
      if (existing) existing.after.push(...after.filter((other) => !existing.after.includes(other)))
      else found.push({ name, task: "", after })
      said.set(name, [...(said.get(name) ?? []), task])
      break
    }
  }
  for (const part of found) {
    const all = said.get(part.name) ?? []
    part.task = all.length === 1 ? all[0] : all.map((task) => "- " + task).join("\n")
  }
  return { parts: found, go }
}

/** The parts of the work in the lead's list, one for each bot, and whether you'd already said to go ahead. */
export function tasks(text: string, members: { id: string; name: string }[], newID: () => string): { tasks: GroupTask[]; go: boolean } {
  const { parts: found, go } = parts(
    text,
    members.map((bot) => bot.name),
  )
  const ids = new Map<string, string>()
  for (const bot of members) if (!ids.has(bot.name)) ids.set(bot.name, bot.id)
  // Only waits on bots that have a part here.
  const working = new Set(found.map((part) => part.name))
  const list: GroupTask[] = []
  for (const part of found) {
    const bot = ids.get(part.name)
    if (!bot) continue
    const after = part.after.filter((name) => working.has(name)).flatMap((name) => (ids.has(name) ? [ids.get(name)!] : []))
    list.push({ id: newID(), bot, task: part.task, state: "proposed", ...(after.length > 0 ? { after } : {}) })
  }
  return { tasks: list, go }
}

/** The parts waiting in a ring through `task`, each on the next and the last on `task`; undefined when its waits end somewhere. */
export function ring(task: GroupTask, all: GroupTask[]): GroupTask[] | undefined {
  const seen = new Set<string>()
  const path = (part: GroupTask): GroupTask[] | undefined => {
    for (const next of all) {
      if (next.state !== "waiting" || next.id === part.id || !(part.after ?? []).includes(next.bot)) continue
      if (next.id === task.id) return [part]
      if (!seen.has(next.id)) {
        seen.add(next.id)
        const rest = path(next)
        if (rest) return [part, ...rest]
      }
    }
    return undefined
  }
  return path(task)
}

const opening = "[Work from "
const divider = "\n\n---\n"

/**
 * A part of a chat's work, as it reaches the bot's own conversation (GroupWork.compose): which
 * chat it's from and what the part is, then what was decided and how to report back. `from`: whose
 * words `wrapUp` is ("Pixel's wrap-up"); `before`: the parts that came first, each bot's name with
 * its report.
 */
export function compose(task: GroupTask, chat: Group, wrapUp: GroupMessage, from: string, before: { name: string; report: string }[] = []): string {
  let text =
    opening +
    chat.name +
    " · " +
    chat.id +
    "]\n\n" +
    task.task +
    divider +
    `The user agreed to this in the group chat "${chat.name}", and this part is yours. What was decided (${from}):\n\n` +
    wrapUp.text
  if (before.length > 0) {
    text += "\n\nThe parts before yours are done. What they reported:\n" + before.map((part) => `\n**${part.name}**: ${part.report}`).join("\n")
  }
  return (
    text +
    "\n\nDo your part here, with all your tools, as you would any task from the user. When it's done, end with a few lines on what you did and anything left over. That last message of yours goes to the chat as your report on its own, so don't send it anywhere; the others' parts start from it."
  )
}

/**
 * A provider's refusal that means it isn't signed in (a request sent without its credentials, or
 * ones it turned down), in words saying what to do, for `provider`; any other error as it was said.
 */
export function plainError(error: string, provider?: string, place?: string): string {
  if (!/authorization header|unauthori[sz]ed|\b401\b|\b403\b|forbidden|invalid api key/i.test(error)) return error
  return `${provider ?? "Its account"} isn’t signed in${place ? ` on ${place}` : ""}: sign in to it again in Settings › Accounts, or choose another model.`
}

/**
 * Whether a tool of MCP server `server` is running in `messages` (the engine's, oldest first), so
 * what that server asks is theirs: a server can't say which conversation it answers. One run
 * through Code Mode counts when its code names the server. As the Mac's Transcript.isWaiting.
 */
export function isWaiting(server: string, messages: any[]): boolean {
  // A server's name as its tools start: what a tool's name can't have becomes `_`.
  const name = [...server].map((character) => (/[\p{L}\p{N}_-]/u.test(character) ? character : "_")).join("")
  for (const message of messages.slice(-8)) {
    if (message?.type !== "assistant") continue
    for (const block of message.content ?? []) {
      if (block?.type !== "tool" || block.state?.status !== "running") continue
      if (String(block.name).startsWith(name + "_")) return true
      if (block.name === "execute" && typeof block.state.input?.code === "string" && block.state.input.code.includes(server)) return true
    }
  }
  return false
}

// MARK: Reading a seat's answer

/**
 * What a seat said in `messages` (the engine's, oldest first), as the chat gets it: its last words
 * before each message it was given (one steered in while it talked starts a new part), so nothing
 * it said to the group is lost, and none of the asides between its steps go in. Its steps, and an
 * error, if that's all it has.
 */
export function said(messages: any[]): { text: string; error?: string; steps: ToolCall[] } {
  const found: string[] = []
  let part = ""
  let error: string | undefined
  const steps: ToolCall[] = []
  for (const message of messages) {
    if (message?.type === "user") {
      if (part.length > 0) found.push(part)
      part = ""
    } else if (message?.type === "assistant") {
      const content: any[] = Array.isArray(message.content) ? message.content : []
      for (const block of content) if (block?.type === "tool") steps.push(block)
      const words = trim(
        content
          .filter((block) => block?.type === "text")
          .map((block) => String(block.text ?? ""))
          .join("\n\n"),
      )
      if (words.length > 0) part = words
      error = message.error?.message
    }
  }
  if (part.length > 0) found.push(part)
  // A part that's only a pass, beside one that says something, is left out.
  const kept = found.filter((text) => !isPass(text))
  return { text: (kept.length === 0 ? found.slice(-1) : kept).join("\n\n"), error, steps }
}

/** A step as it's kept with the chat: what it printed, cut short, so the log stays small. */
/** What a bot is doing on its turn (the chat shows its last step under who's talking, so a long
 * turn doesn't look stuck), as the Mac's `GroupActivity`: a tool it called (without what it
 * gave back), the line its thinking is on, or its reply being written. */
export type Activity = { kind: "tool"; call: ToolCall } | { kind: "thinking"; text: string } | { kind: "writing" }

/** The last step in a seat's `messages` (oldest first), since `promptID` (or, not among them yet,
 * since `sent`, in milliseconds); none before its first. */
export function activity(messages: any[], promptID: string, sent: number): Activity[] {
  const at = messages.findIndex((message) => message?.id === promptID)
  const after = at >= 0 ? messages.slice(at + 1) : messages.filter((message) => (message?.time?.created ?? 0) >= sent - 2000)
  const found: Activity[] = []
  for (const message of after) {
    if (message?.type !== "assistant") continue
    for (const block of message.content ?? []) {
      if (block?.type === "tool") {
        found.push({ kind: "tool", call: bare(block) })
      } else if (block?.type === "reasoning") {
        const line = thought(String(block.text ?? ""))
        if (line) found.push({ kind: "thinking", text: line })
      } else if (block?.type === "text" && String(block.text ?? "").trim() && found.at(-1)?.kind !== "writing") {
        found.push({ kind: "writing" })
      }
    }
  }
  return found.slice(-1)
}

/** Thinking under way, in a line: the latest it's written, without Markdown's stars. */
export function thought(text: string): string | undefined {
  const line = text.split(/\r\n|\r|\n/).map((part) => part.replaceAll("**", "").trim()).filter(Boolean).at(-1)
  if (!line) return undefined
  return length(line) > 100 ? sliceCharacters(line, 99) + "…" : line
}

/** A step without what it gave back. */
function bare(call: ToolCall): ToolCall {
  const state: any = call.state
  if (state?.status === "completed") return { ...call, state: { ...state, content: [] } }
  if (state?.status === "error") {
    const { content: _, ...rest } = state
    return { ...call, state: rest }
  }
  return call
}

export function trimmed(call: ToolCall): ToolCall {
  const cut = (output: any[]) =>
    output.map((item) => (item?.type === "text" && length(item.text) > 4000 ? { ...item, text: sliceCharacters(item.text, 4000) + "…" } : item))
  const state: any = call.state
  if (state?.status === "completed") return { ...call, state: { ...state, content: cut(state.content ?? []) } }
  if (state?.status === "error" && state.content) return { ...call, state: { ...state, content: cut(state.content) } }
  return call
}

/** The first `count` characters of `text`, as Swift counts them. */
function sliceCharacters(text: string, count: number): string {
  let out = ""
  let taken = 0
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (taken++ >= count) break
    out += segment
  }
  return out
}

// MARK: A seat

/** What a group chat needs to know of one of its bots. */
export interface SeatBot {
  id: string
  name: string
  /** What it does, in a few words. */
  job: string
  /** Its job in full, as its memory has it. */
  instructions: string
  memoryFile: string
  folder: string
}

/**
 * What a bot's seat in a chat is told (BotGroups.seatInstructions): who it is, who else is there,
 * who leads, what the chat is for, and how to take part. `personality`: what its personality tells
 * it; `identityNote`: who sets what about a bot (Bots.identityNote).
 */
export function seatInstructions(bot: SeatBot, group: Group, others: SeatBot[], lead: SeatBot | undefined, personality: string | undefined, identityNote: string): string {
  const who = others.map((other) => other.name + (other.job.length === 0 ? "" : ` (${other.job})`)).join(", ")
  const job = trim(bot.instructions)
  const purpose = group.purpose === undefined || group.purpose === null ? "" : group.purpose.length === 0 ? "" : ` The chat is for: ${group.purpose}`
  const leads = lead ? (lead.id === bot.id ? "You lead it." : `${lead.name} leads it.`) : ""
  let text =
    `You are ${bot.name}, one of the user's bots in Kuvo Code${bot.job.length === 0 ? "" : `: ${bot.job}`}.${personality !== undefined ? ` ${personality}` : ""}${job.length === 0 ? "" : `\nYour job:\n${job}\n`}\n` +
    `Your memory file is "${bot.memoryFile}": read it when what's asked is about your work.\n` +
    `\n` +
    `This conversation is your seat in "${group.name}", a group chat between the user and these bots: ${who.length === 0 ? "just you" : who}, and you. ${leads}${purpose}\n` +
    `\n` +
    `Each message you get here holds what was said in the chat since you last spoke, and means it's your turn. Your reply is posted ` +
    `to the chat as your message, so write it to the group: a few sentences, plain and to the point, like a colleague in a team ` +
    `chat. Add something new: build on what others said instead of repeating it, disagree when you do, and ask someone directly ` +
    `with &Name (an ampersand, never @Name). Write to the user as "you". If you have nothing new to add, reply with just PASS.\n` +
    `\n` +
    `Answer from what's in the chat and what you know; look things up (read and search files, search the web, read another conversation) only when what's asked needs it, and give small talk and quick questions a straight answer. There are no commands, subagents or messages to other agents here. ` +
    `Don't change files or start the work here: the chat is for talking it through. When something needs doing, say who should ` +
    `do it. Once the user says go, each of you gets your part in your own conversation, does it there with all your tools, and ` +
    `reports back here: don't send anyone the work yourself, and don't wait on it in the chat.\n` +
    `\n` +
    identityNote
  if (lead?.id === bot.id) {
    text +=
      `\n\nYou lead this chat. When the user brings something up, you go first: frame it in a line or two and say who should ` +
      `weigh in on what. Keep it moving and short. When you're asked to wrap up, sum up what was decided, what's still open ` +
      `and who does what.`
  }
  return text
}

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/**
 * A seat's rules (BotGroups.seatRules): it talks and looks things up; it doesn't change anything,
 * and never waits for answers. No shell, subagents or messages to other agents either. With Ask
 * First on, no fetching pages; what Settings › Permissions denies (`denies`), it can't do either.
 */
export function seatRules(folder: string, askFirst: boolean, denies: Rule[]): Rule[] {
  const rules: Rule[] = [
    "edit",
    "write",
    "patch",
    "question",
    "external_directory",
    "shell",
    "subagent",
    "kuvo-browser_send_message",
    "kuvo-browser_start_session",
    "kuvo-browser_browser_save_pdf",
    "kuvo-browser_browser_upload",
    "kuvo-browser_schedule_wake_up",
    "kuvo-browser_watch_for_change",
  ].map((action) => ({ action, resource: "*", effect: "deny" as const }))
  if (askFirst) rules.push({ action: "webfetch", resource: "*", effect: "deny" })
  rules.push({ action: "external_directory", resource: folder.replace(/\/+$/, "") + "/*", effect: "allow" })
  return [...rules, ...denies]
}

// MARK: A bot's job, from its memory

/** A Markdown heading's level ("## Job" is 2); undefined for a line that isn't one. */
function headingLevel(line: string): number | undefined {
  const trimmed = trimSpaces(line)
  let marks = 0
  while (marks < trimmed.length && trimmed[marks] === "#") marks++
  if (marks < 1 || marks > 6) return undefined
  const after = trimmed.slice(marks)
  return after.length === 0 || after[0] === " " ? marks : undefined
}

function isJobHeading(line: string): boolean {
  const trimmed = trimSpaces(line)
  if (!trimmed.startsWith("#")) return false
  const title = trimSpaces(trimmed.replace(/^#+/, "")).toLowerCase()
  if (title === "job" || title === "my job" || title === "the job" || title.startsWith("job:")) return true
  if (!title.startsWith("job ")) return false
  const first = trimSpaces(title.slice(4))[0]
  return first !== undefined && "-–—:(".includes(first)
}

/** What a job heading says after "Job" ("Job: …", "Job — …", "Job (…)"), and whether after a colon. */
function jobInHeading(line: string): { text: string; isColon: boolean } | undefined {
  const title = trimSpaces(trimSpaces(line).replace(/^#+/, ""))
  if (!title.toLowerCase().startsWith("job")) return undefined
  let rest = trimSpaces(title.slice(3))
  const mark = rest[0]
  if (mark === undefined || !":-–—(".includes(mark)) return undefined
  rest = trimSpaces(rest.slice(1))
  if (mark === "(" && rest.endsWith(")")) rest = trimSpaces(rest.slice(0, -1))
  return rest.length === 0 ? undefined : { text: rest, isColon: mark === ":" }
}

/**
 * A bot's job as its memory keeps it (Bots.job(inMemory:)): its line (what shows under its name)
 * and its section (all of it).
 */
export function jobInMemory(text: string): { line: string; section: string } | undefined {
  const all = text.split("\n")
  const start = all.findIndex(isJobHeading)
  if (start < 0) return undefined
  const level = headingLevel(all[start]) ?? 1
  let end = all.length
  let inCode = false
  for (let index = start + 1; index < all.length; index++) {
    const trimmed = trimSpaces(all[index])
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCode = !inCode
      continue
    }
    const other = inCode ? undefined : headingLevel(all[index])
    if (other !== undefined && other <= level) {
      end = index
      break
    }
  }
  let section = trim(all.slice(start + 1, end).join("\n"))
  const inline = jobInHeading(all[start])
  if (inline && (inline.isColon || section.length === 0)) section = [inline.text, section].filter((part) => part.length > 0).join("\n")
  let line = section
    .split("\n")
    .map(trimSpaces)
    .find((part) => part.length > 0) ?? ""
  for (const mark of ["- ", "* ", "> "]) if (line.startsWith(mark)) line = line.slice(mark.length)
  line = line.replaceAll("**", "").replaceAll("__", "")
  if (line.toLowerCase().startsWith("job:")) line = line.slice(4)
  line = trimSpaces(line)
  if (length(line) > 48) {
    const stop = line.indexOf(". ")
    if (stop >= 0) line = line.slice(0, stop)
  }
  if (line.endsWith(".") && !line.endsWith("..")) line = line.slice(0, -1)
  return { line, section }
}
