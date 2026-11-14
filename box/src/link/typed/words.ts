// What a typed message says (PROTOCOL.md, "What a typed message means"): the keywords that start one
// ("/goal", "/loop", "/plan", "/autopilot", "/review", "/btw", "/handoff", "/compact"), "/loop"'s
// how often, "/goal"'s words, "/review"'s what, for what and with whom, and "/name arguments" for
// a command of the engine's. Ported from the Swift both apps drew with (OpenCodeKit's `Keyword`,
// `LoopSchedule`, `LoopCommand`, `GoalCommand`, `ReviewCommand`; KuvoClient's `SlashCommands`), and
// held to the same cases (protocol/vectors/typed.json), so a client that draws a keyword as
// it's typed reads it as the box does when it's sent.
//
// Text is read as Swift reads it: whitespace is Unicode's White_Space (`Character.isWhitespace`,
// and `.whitespacesAndNewlines` for a trim), lengths in UTF-16 units.

import { instant, wall, zone } from "../work/clock";

// ——— Whitespace, as Swift has it ———

const SPACE = "\\t\\n\\u000b\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE_ONE = new RegExp(`^[${SPACE}]$`);
const SPACE_ENDS = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");
// `.whitespaces`: spaces and tabs, no line ends.
const BLANK = "\\t \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000";
const BLANK_ENDS = new RegExp(`^[${BLANK}]+|[${BLANK}]+$`, "g");

/** `Character.isWhitespace`. */
export const isSpace = (character: string | undefined): boolean => character !== undefined && SPACE_ONE.test(character);
/** `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export const trim = (text: string): string => text.replace(SPACE_ENDS, "");
/** `trimmingCharacters(in: .whitespaces)`. */
const trimBlanks = (text: string): string => text.replace(BLANK_ENDS, "");
/** Where the first character from `from` that isn't whitespace is (`text.length` for none). */
const nextWord = (text: string, from: number): number => {
  let at = from;
  while (at < text.length && isSpace(text[at])) at++;
  return at;
};
/** Where the word at `from` ends. */
const wordEnd = (text: string, from: number): number => {
  let at = from;
  while (at < text.length && !isSpace(text[at])) at++;
  return at;
};
const words = (text: string): string[] => text.split(new RegExp(`[${SPACE}]+`)).filter(Boolean);

// ——— Keywords ———

export const KEYWORDS = ["goal", "loop", "plan", "autopilot", "review", "btw", "handoff", "compact"] as const;
export type Keyword = (typeof KEYWORDS)[number];

/** What "/" lists for each: its name in a list, what it does in a line, and what follows it, in grey
 * until something's written (none for one that takes nothing). */
export const KEYWORD_WORDS: Record<Keyword, { title: string; summary: string; argument: string | null }> = {
  goal: { title: "Goal", summary: "Keep working until a condition is met", argument: "what should be true when it’s done, like “all tests pass”" },
  loop: { title: "Loop", summary: "Repeat a message on a schedule", argument: "what to do each time" },
  plan: { title: "Plan", summary: "Explore and plan first, without changing files", argument: "what to plan (or nothing, to turn Plan on or off)" },
  autopilot: { title: "Autopilot", summary: "Decide for itself; stop only for what needs you", argument: "what to do (or nothing, to turn Autopilot on or off)" },
  review: { title: "Review", summary: "A second model reviews your uncommitted changes", argument: null },
  btw: { title: "Side Question", summary: "A side question, kept out of this conversation", argument: "your question" },
  handoff: { title: "Handoff", summary: "Go on in a fresh conversation from a summary", argument: "what to do next (or nothing)" },
  compact: { title: "Compact", summary: "Summarize the conversation to free up context", argument: null },
};

/** "/review-quick": the engine's own review, where ours has the name. */
export const QUICK_REVIEW = "review-quick";

export interface Command {
  name: string;
  description?: string;
}

/** What "/" offers besides `keywords`: the engine's commands and yours, its own /review as
 * /review-quick where the keyword has the name, and none a keyword hides. The engine's own /goal is
 * never offered: a message that starts with "/goal" is always the box's. */
export function commandsOffered(own: Command[], keywords: readonly Keyword[]): Command[] {
  return own.flatMap(command => {
    if (command.name === "goal") return [];
    if (!keywords.some(keyword => keyword === command.name)) return [command];
    return command.name === "review" ? [{ name: QUICK_REVIEW, description: "The engine’s own review, in this conversation" }] : [];
  });
}

/** The keyword a message starts with, and what follows it ("/btw why?" is btw, "why?"); null for any
 * other message. */
export function parseKeyword(text: string): { keyword: Keyword; rest: string } | null {
  const trimmed = trim(text);
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1, wordEnd(trimmed, 1));
  const keyword = KEYWORDS.find(each => each === name.toLowerCase());
  if (!keyword) return null;
  return { keyword, rest: trim(trimmed.slice(1 + name.length)) };
}

// ——— "!" and "/name arguments" ———

/** "!" at the start of a message: the rest is a command to run in the session's folder. */
export function shellCommand(text: string): string | null {
  if (!text.startsWith("!")) return null;
  const command = trim(text.slice(1));
  return command ? command : null;
}

/** "/name arguments", whatever the name. */
export function splitCommand(text: string): { name: string; arguments: string } | null {
  const trimmed = trim(text);
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1, wordEnd(trimmed, 1));
  if (!name) return null;
  return { name, arguments: trim(trimmed.slice(1 + name.length)) };
}

/** A message that runs one of `commands`: "/review main" is review, "main". */
export function parseCommand(text: string, commands: Command[]): { name: string; arguments: string } | null {
  const split = splitCommand(text);
  return split && commands.some(command => command.name === split.name) ? split : null;
}

// ——— /goal ———

export type GoalCommand = { kind: "set"; words: string } | { kind: "show" | "pause" | "resume" | "clear" };

/** The words that take a goal away (as Claude Code's /goal takes them). */
const CLEARING = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/** "/goal …" as typed, or null for anything else. */
export function parseGoal(text: string): GoalCommand | null {
  const trimmed = trim(text);
  if (!trimmed.toLowerCase().startsWith("/goal")) return null;
  const after = trimmed.slice("/goal".length);
  if (after && !isSpace(after[0])) return null;
  const rest = trim(after);
  const lower = rest.toLowerCase();
  if (!lower) return { kind: "show" };
  if (lower === "pause") return { kind: "pause" };
  if (lower === "resume") return { kind: "resume" };
  if (CLEARING.has(lower)) return { kind: "clear" };
  return { kind: "set", words: rest };
}

// ——— /loop ———

export type Repeat = { unit: "m" | "h" | "d" | "w"; count: number } | { unit: "weekdays" };

/** 30m, 2h, 1d, 1w or weekdays, as `kuvo-wake` takes it: at most a year, and no leading zero. */
export function parseRepeat(text: string): Repeat | null {
  if (text === "weekdays") return { unit: "weekdays" };
  const match = /^([1-9][0-9]{0,5})([mhdw])$/.exec(text);
  if (!match) return null;
  const count = Number(match[1]), unit = match[2] as "m" | "h" | "d" | "w";
  const most = { m: 525_600, h: 8_760, d: 366, w: 52 }[unit];
  if (count > most || (unit === "m" && count < 5)) return null;
  return { unit, count };
}

export const repeatText = (every: Repeat): string => (every.unit === "weekdays" ? "weekdays" : `${every.count}${every.unit}`);
/** By the clock (days, weeks, weekdays): it waits for its time; else it goes now, then again. */
export const keepsTimeOfDay = (every: Repeat): boolean => every.unit !== "m" && every.unit !== "h";

/** How often "/loop" sends its message again, and the time of day one by days or weeks keeps. */
export interface LoopSchedule {
  every: Repeat;
  hour?: number;
  minute?: number;
}

/** What follows "/loop", read: its schedule (none when it doesn't say one it can read) and the
 * message; how much of what follows says the schedule, in UTF-16 units with the spaces before it
 * (the composer draws it with the keyword), and the schedule as written. */
export interface LoopCommand {
  schedule: LoopSchedule | null;
  message: string;
  scheduleLength: number;
  scheduleText: string;
}

const MINUTE_UNITS = ["m", "min", "mins", "minute", "minutes"];
const HOUR_UNITS = ["h", "hr", "hrs", "hour", "hours"];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((word, at) => word === b[at]);

/** "9", "9am", "9:30", "14:30", "2pm", "2:15pm". */
function clock(text: string): [number, number] | null {
  let said = text;
  const half = said.endsWith("am") ? "am" : said.endsWith("pm") ? "pm" : null;
  if (half) said = said.slice(0, -2);
  const parts = said.split(":").filter(part => part !== "");
  // (Swift's `split` drops empty parts; `Int` takes only digits, with a sign.)
  const int = (part: string | undefined) => (part !== undefined && /^[+-]?[0-9]+$/.test(part) ? Number(part) : null);
  const hour = int(parts[0]);
  if (hour === null || parts.length > 2) return null;
  const minute = parts.length === 2 ? int(parts[1]) : 0;
  if (minute === null || minute < 0 || minute >= 60 || hour < 0 || hour > 23 || (half !== null && (hour < 1 || hour > 12))) return null;
  if (half === "am") return [hour === 12 ? 0 : hour, minute];
  if (half === "pm") return [hour === 12 ? 12 : hour + 12, minute];
  return [hour, minute];
}

/** A schedule the whole of `said` (lowercased words) says, or null. */
function scheduleOf(said: string[]): LoopSchedule | null {
  const is = (...each: string[][]) => each.some(words => same(said, words));
  if (is(["hourly"], ["every", "hour"])) return { every: { unit: "h", count: 1 } };
  // By the day or week with no time said: at 9, as a morning's.
  if (is(["daily"], ["every", "day"], ["every", "morning"])) return { every: { unit: "d", count: 1 }, hour: 9, minute: 0 };
  if (is(["weekdays"], ["every", "weekday"])) return { every: { unit: "weekdays" }, hour: 9, minute: 0 };
  if (is(["weekly"], ["every", "week"])) return { every: { unit: "w", count: 1 }, hour: 9, minute: 0 };
  // "30m", "2h", "every 30 min", "every 2 hours".
  const spoken = said[0] === "every" ? said.slice(1) : said;
  if (spoken.length === 1) {
    const every = parseRepeat(spoken[0]);
    if (every) return keepsTimeOfDay(every) ? { every, hour: 9, minute: 0 } : { every };
  }
  if (spoken.length === 2 && /^[+]?[0-9]+$/.test(spoken[0]) && Number(spoken[0]) > 0) {
    const n = Number(spoken[0]), unit = spoken[1];
    if (MINUTE_UNITS.includes(unit)) {
      const every = parseRepeat(`${n}m`);
      if (every) return { every };
    }
    if (HOUR_UNITS.includes(unit)) {
      const every = parseRepeat(`${n}h`);
      if (every) return { every };
    }
  }
  // "every morning at 9", "every day at 14:30", "daily at 9am", "weekdays at 9", "every weekday at 8:30".
  const at = said.indexOf("at");
  if (at < 0 || at + 1 !== said.length - 1) return null;
  const time = clock(said[at + 1]);
  if (!time) return null;
  const [hour, minute] = time;
  const days = said.slice(0, at);
  const are = (...each: string[][]) => each.some(words => same(days, words));
  if (are(["every", "morning"], ["mornings"], ["every", "day"], ["daily"])) return { every: { unit: "d", count: 1 }, hour, minute };
  if (are(["weekdays"], ["every", "weekday"], ["on", "weekdays"])) return { every: { unit: "weekdays" }, hour, minute };
  if (are(["every", "week"], ["weekly"])) return { every: { unit: "w", count: 1 }, hour, minute };
  if (days.length === 3 && days[0] === "every" && ["days", "day", "weeks", "week"].includes(days[2])) {
    // "every 2 days at 9", "every 2 weeks at 9".
    if (!/^[+-]?[0-9]+$/.test(days[1])) return null;
    const every = parseRepeat(`${Number(days[1])}${days[2].startsWith("day") ? "d" : "w"}`);
    return every ? { every, hour, minute } : null;
  }
  return null;
}

/** What follows "/loop". */
export function parseLoop(rest: string): LoopCommand {
  const said = words(rest);
  for (let count = Math.min(said.length, 6); count >= 1; count--) {
    // "every morning at 25": a time was meant, and isn't one; not "every morning" with "at 25" to send.
    if (count < said.length && said[count].toLowerCase() === "at") continue;
    const schedule = scheduleOf(said.slice(0, count).map(word => word.toLowerCase()));
    if (!schedule) continue;
    // The message as written after the schedule, its lines kept.
    let index = 0;
    for (let each = 0; each < count; each++) index = wordEnd(rest, nextWord(rest, index));
    return { schedule, message: trim(rest.slice(index)), scheduleLength: index, scheduleText: trim(rest.slice(0, index)) };
  }
  return { schedule: null, message: trim(rest), scheduleLength: 0, scheduleText: "" };
}

const DAY = 86_400_000;
const isWeekend = (at: number, timeZone?: string) => {
  const { year, month, day } = wall(at, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
};

/** `hour:minute` on the day `days` after `today`, in `timeZone`; in the hour clocks skip going
 * forward, the first time after it that exists (as a Mac's calendar sets a time of day). */
function timeOfDay(today: { year: number; month: number; day: number }, days: number, hour: number, minute: number, timeZone?: string): number {
  let at = instant(today.year, today.month, today.day + days, hour, minute, timeZone);
  const asked = hour * 60 + minute;
  const minutes = (moment: number) => {
    const seen = wall(moment, timeZone);
    return seen.hour * 60 + seen.minute;
  };
  // (Skipped: it came out later that day, by as much as the clocks went forward.)
  if (minutes(at) !== asked) while (minutes(at - 60_000) > asked && minutes(at - 60_000) < minutes(at)) at -= 60_000;
  return at;
}

/** When `schedule` sends its message first (ms since 1970): now, or at its next time of day, by this
 * box's clock (its zone, `work/clock.ts`). */
export function firstRun(schedule: LoopSchedule, now: number, timeZone = zone()): number {
  if (!keepsTimeOfDay(schedule.every) || schedule.hour === undefined) return now;
  const today = wall(now, timeZone);
  let days = 0;
  let next = timeOfDay(today, days, schedule.hour, schedule.minute ?? 0, timeZone);
  while (next <= now || (schedule.every.unit === "weekdays" && isWeekend(next, timeZone))) {
    days++;
    next = timeOfDay(today, days, schedule.hour, schedule.minute ?? 0, timeZone);
    if (days > 14) return now + DAY;
  }
  return next;
}

/** When the wake-up that repeats it is due first (ms since 1970): its first time by the clock, or
 * one period after now for one that goes now. */
export function firstWake(schedule: LoopSchedule, now: number, timeZone = zone()): number {
  if (keepsTimeOfDay(schedule.every)) return firstRun(schedule, now, timeZone);
  const every = schedule.every as { unit: "m" | "h"; count: number };
  return now + every.count * (every.unit === "h" ? 3_600_000 : 60_000);
}

// ——— /review ———

export interface ModelRef {
  providerID: string;
  id: string;
}

/** A model a review can be read by: its name as the lists show it, and who serves it. */
export interface Reader {
  name: string;
  ref: ModelRef;
  provider: string;
}

export type ReviewScope =
  | { kind: "uncommitted" }
  | { kind: "branch"; base?: string }
  | { kind: "commits"; from: string; to?: string }
  | { kind: "folder"; path: string }
  | { kind: "project" }
  | { kind: "described"; words: string };

export const PRESETS = ["security", "performance", "accessibility"] as const;
export type Preset = (typeof PRESETS)[number];

/** Which of the composer's lists what's typed is answering, and what's typed in it so far. */
export type Asking = { list: "what" | "commit" | "folder" | "lookFor"; typed: string };

/** What follows "/review", read. */
export interface ReviewCommand {
  scope: ReviewScope | null;
  described: string | null;
  preset: Preset | null;
  reader: Reader | null;
  focus: string;
  readerLength: number;
  searching: string | null;
  asking: Asking | null;
  head: string;
  readerTyped: string | null;
}

const UNCOMMITTED = "changes not committed yet";
const BRANCH = "this branch";
const PROJECT = "the whole project";
const WHAT_WORDS = [UNCOMMITTED, "uncommitted", BRANCH, "branch", "since ", "commits", "folder ", "a folder", PROJECT, "whole project", "project", "something else"];
const LOOK_FOR_WORDS = [...PRESETS.flatMap(preset => [`for ${preset}`, preset]), "anything wrong", "something else"];

/** `text` from `at` starts with `word`, in any case, as a whole word. */
function isWord(word: string, text: string, at = 0): boolean {
  if (text.length - at < word.length || text.slice(at, at + word.length).toLowerCase() !== word) return false;
  return at + word.length === text.length || isSpace(text[at + word.length]);
}

const isQuote = (character: string | undefined) => character === "\"" || character === "“" || character === "”";

/** A commit, branch or tag as git names them (never an option, never a range). */
function isRef(ref: string): boolean {
  if (ref.length < 1 || ref.length > 200 || ref.startsWith("-") || ref.includes("..")) return false;
  return /^[A-Za-z0-9._/~^@{}+-]+$/.test(ref);
}

const sameRef = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) => !!a && !!b && a.id === b.id && a.providerID === b.providerID;

/** A scope `text` starts with at `start`, where it ends, and the list it's still being typed in
 * when it ends what's typed. */
function scopeAt(text: string, start: number): { scope: ReviewScope | null; end: number; asking: Asking | null } | null {
  const phrases: [string, ReviewScope][] = [[UNCOMMITTED, { kind: "uncommitted" }], ["uncommitted", { kind: "uncommitted" }], [BRANCH, { kind: "branch" }], ["branch", { kind: "branch" }],
    [PROJECT, { kind: "project" }], ["whole project", { kind: "project" }], ["project", { kind: "project" }]];
  for (const [phrase, scope] of phrases) if (isWord(phrase, text, start)) return { scope, end: start + phrase.length, asking: null };
  if (isWord("since", text, start)) {
    const after = start + 5;
    const at = nextWord(text, after);
    // "since" alone, sent or still typed: the commit is still to come.
    if (at === text.length) return { scope: null, end: text.length, asking: { list: "commit", typed: "" } };
    const end = wordEnd(text, at);
    const ref = text.slice(at, end);
    if (!isRef(ref)) return null;
    return { scope: { kind: "commits", from: ref + "^" }, end, asking: end === text.length ? { list: "commit", typed: ref } : null };
  }
  if (isWord("folder", text, start)) {
    const at = nextWord(text, start + 6);
    if (at === text.length) return { scope: null, end: text.length, asking: { list: "folder", typed: "" } };
    if (isQuote(text[at])) {
      const inside = at + 1;
      let close = inside;
      while (close < text.length && !isQuote(text[close])) close++;
      if (close === text.length) {
        const path = text.slice(inside);
        return { scope: path ? { kind: "folder", path } : null, end: text.length, asking: { list: "folder", typed: path } };
      }
      return { scope: { kind: "folder", path: text.slice(inside, close) }, end: close + 1, asking: null };
    }
    const end = wordEnd(text, at);
    const path = text.slice(at, end);
    return { scope: { kind: "folder", path }, end, asking: end === text.length ? { list: "folder", typed: path } : null };
  }
  return null;
}

function presetAt(text: string, start: number): { preset: Preset; end: number } | null {
  if (!isWord("for", text, start)) return null;
  const after = nextWord(text, start + 3);
  for (const preset of PRESETS) if (isWord(preset, text, after)) return { preset, end: after + preset.length };
  return null;
}

/** Those whose name, or who serves them, has each of the words of `query`. */
export function searchReaders(query: string, readers: Reader[]): Reader[] {
  const wanted = words(query.toLowerCase());
  return readers.filter(reader => {
    const said = `${reader.name} ${reader.provider}`.toLowerCase();
    return wanted.every(word => said.includes(word));
  });
}

/** A model named at the end of `text` after "with", and the words before it. */
function readerAtEnd(text: string, readers: Reader[], preferred: ModelRef | null): { reader: Reader; before: string } | null {
  const lower = text.toLowerCase();
  const named = readers.filter(reader => lower.endsWith(" with " + reader.name.toLowerCase()));
  if (!named.length) return null;
  const longest = Math.max(...named.map(reader => reader.name.length));
  const candidates = named.filter(reader => reader.name.length === longest);
  const reader = candidates.find(each => sameRef(each.ref, preferred)) ?? candidates[0];
  return { reader, before: trimBlanks(text.slice(0, text.length - longest - " with ".length)) };
}

/** What follows "/review", read against `readers`; of two with the same name, `preferred`. */
export function parseReview(rest: string, readers: Reader[], preferred: ModelRef | null = null): ReviewCommand {
  const read: ReviewCommand = { scope: null, described: null, preset: null, reader: null, focus: "", readerLength: 0, searching: null, asking: null, head: "", readerTyped: null };
  let at = 0;
  // What's drawn with the keyword ends where the last thing it reads ends.
  let drawn = 0;
  // Where the thing a list is answering starts, when what's typed ends inside it.
  let open: number | null = null;
  let scopeRead = false;
  while (true) {
    const start = nextWord(rest, at);
    if (start >= rest.length) break;
    const scope = scopeRead ? null : scopeAt(rest, start);
    if (scope) {
      scopeRead = true;
      read.scope = scope.scope;
      at = drawn = scope.end;
      if (scope.asking) {
        read.asking = scope.asking;
        open = start;
      }
      continue;
    }
    const preset = read.preset ? null : presetAt(rest, start);
    if (preset) {
      read.preset = preset.preset;
      at = drawn = preset.end;
      continue;
    }
    if (!read.reader && read.searching === null && isWord("with", rest, start)) {
      const from = nextWord(rest, start + 4);
      const name = rest.slice(from);
      // The longest name it starts with, as a whole word: "Claude Sonnet 4.5", not "Claude".
      const named = readers.filter(reader => {
        const length = reader.name.length;
        if (!length || name.length < length || name.slice(0, length).toLowerCase() !== reader.name.toLowerCase()) return false;
        return length === name.length || isSpace(name[length]);
      });
      if (named.length) {
        const longest = Math.max(...named.map(reader => reader.name.length));
        const candidates = named.filter(reader => reader.name.length === longest);
        read.reader = candidates.find(each => sameRef(each.ref, preferred)) ?? candidates[0];
        const end = from + longest;
        if (end === rest.length) read.readerTyped = name.slice(0, longest);
        at = drawn = end;
        continue;
      }
      const query = trim(name);
      // (A coding agent's conversation has none to look for: its own agent reads it.)
      if (readers.length && (!query || searchReaders(query, readers).length)) {
        read.searching = query;
        read.readerLength = drawn;
        read.head = rest.slice(0, start);
        read.asking = null;
        return read;
      }
    }
    break;
  }
  read.readerLength = drawn;
  if (open !== null) {
    read.head = rest.slice(0, open);
    return read;
  }
  const tailStart = nextWord(rest, at);
  const typed = rest.slice(tailStart);
  read.head = rest.slice(0, tailStart);
  // A pick goes after a space: "/review for security" + "this branch".
  if (read.head && !isSpace(read.head[read.head.length - 1])) read.head += " ";
  let written = trim(typed);
  // Who reads it, named after your own words: "for the sign-in with Claude Sonnet 4.5".
  if (!read.reader) {
    const named = readerAtEnd(written, readers, preferred);
    if (named) {
      read.reader = named.reader;
      written = named.before;
    }
  }
  const ownFocus = isWord("for", written);
  read.focus = ownFocus ? trimBlanks(written.slice(3)) : written;
  // Alone after "/review", they say what to read; after anything else named, what to look at.
  if (!read.scope && !read.preset && !read.reader && !ownFocus && written) read.described = written;
  // Nothing of your own yet, or the start of what a list offers: that list, for it.
  const lower = typed.toLowerCase();
  const ownWords = lower.startsWith("for ") && [...lower.slice(4)].every(isSpace);
  if (!read.scope && WHAT_WORDS.some(word => word.startsWith(lower))) read.asking = { list: "what", typed };
  else if (!read.preset && !ownWords && (!lower || LOOK_FOR_WORDS.some(word => word.startsWith(lower)))) read.asking = { list: "lookFor", typed };
  return read;
}

/** What it reads, as the box is asked: what's named, or what your words describe. */
export const scopeAsked = (command: ReviewCommand): ReviewScope | null =>
  command.scope ?? (command.described !== null ? { kind: "described", words: command.described } : null);

/** What it's asked to look at: the preset, your words, or both (not words that say what to read). */
export function focusAsked(command: ReviewCommand): string | null {
  const focus = command.described === null ? command.focus : "";
  if (!command.preset) return focus ? focus : null;
  return focus ? `${command.preset}: ${focus}` : command.preset;
}

/** What's still to be written before it can start (a commit after "since", a folder after "folder"). */
export function reviewUnfinished(command: ReviewCommand): string | null {
  if (command.scope) return null;
  if (command.asking?.list === "commit" && command.asking.typed === "") return "Write the commit to start with after “since”.";
  if (command.asking?.list === "folder" && command.asking.typed === "") return "Write the folder to review after “folder”.";
  return null;
}
