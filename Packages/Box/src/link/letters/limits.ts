// How much agents may do unattended (PROTOCOL.md, "Agents' tools")
// Two agents shouldn't keep writing to each other for ever, nor one fill the window with sessions,
// while nobody's watching. The limits are this one table, and every route and letter goes through
// `allowed`: a `most` of Infinity switches one off. A bot's work is its own to size (the limits you
// set for it are in `work/limits.ts`): for it, only a net against a runaway (`botSessions`, counted
// by bot, its sessions' starts included). What each caller did lately is kept in
// `run/tool-limits.json`, so a tool's call answered by a process of its own (`box route`) counts too.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { locked, writePrivate } from "../files";
import { RUN } from "../home";

/** What's counted: messages sent (by a conversation, or letters from another computer), sessions
 * started, and a bot's sessions started; at most `most` in `within` ms. */
export const LIMITS = {
  messages: { most: 20, within: 600_000 },
  sessions: { most: 6, within: 600_000 },
  botSessions: { most: 40, within: 600_000 },
} satisfies Record<string, { most: number; within: number }>;

export type LimitKind = keyof typeof LIMITS;

export const LIMITS_FILE = path.join(RUN, "tool-limits.json");
const LIMITS_LOCK = path.join(RUN, ".tool-limits.lock");

/** A bot's session being started: when, the session once it's made, and whether it was given its
 * task (from then on the engine says whether it's working). */
interface Starting { at: number; session?: string; prompted?: boolean }

type Counts = Partial<Record<LimitKind, Record<string, number[]>>> & { starting?: Record<string, Record<string, Starting>> };

// How long a start is counted on its own: long after its session shows where it works (one cut off
// before saying so isn't counted for ever).
const STARTING_FOR = 120_000;

// What's counted now, the old left out.
function changeCounts<T>(now: number, change: (counts: Counts) => T, file: string): T {
  return locked(LIMITS_LOCK, () => {
    let counts: Counts = {};
    try { counts = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
    for (const kind of Object.keys(LIMITS) as LimitKind[]) {
      const byKey = counts[kind] ?? {};
      for (const [key, times] of Object.entries(byKey)) {
        const lately = Array.isArray(times) ? times.filter(at => typeof at === "number" && now - at < LIMITS[kind].within) : [];
        if (lately.length) byKey[key] = lately;
        else delete byKey[key];
      }
      counts[kind] = byKey;
    }
    const starting: Record<string, Record<string, Starting>> = {};
    for (const [bot, starts] of Object.entries(isObject(counts.starting) ? counts.starting : {})) {
      const lately = Object.entries(isObject(starts) ? starts : {}).filter(([, start]) => isObject(start) && typeof start.at === "number" && now - start.at < STARTING_FOR);
      if (lately.length) starting[bot] = Object.fromEntries(lately) as Record<string, Starting>;
    }
    counts.starting = starting;
    const value = change(counts);
    try { writePrivate(file, JSON.stringify(counts)); } catch {}
    return value;
  });
}

/** Whether `key` (a conversation, or `peer:<key>`) may do one more `kind` now: when it's counted
 * (to take it back if it doesn't go after all), or null when it's done that many lately. Counted
 * as it starts, before anything's awaited, so ones sent at once count each other. */
export function allowed(kind: LimitKind, key: string, now = Date.now(), file = LIMITS_FILE): number | null {
  return changeCounts(now, counts => {
    const lately = counts[kind]![key] ?? [];
    if (lately.length >= LIMITS[kind].most) return null;
    counts[kind]![key] = [...lately, now];
    return now;
  }, file);
}

/** One counted at `at` that didn't go, so one tried again isn't counted twice. */
export function takeBack(kind: LimitKind, key: string, at: number, file = LIMITS_FILE): void {
  changeCounts(Date.now(), counts => {
    const lately = counts[kind]![key] ?? [];
    const index = lately.indexOf(at);
    if (index >= 0) lately.splice(index, 1);
    if (lately.length) counts[kind]![key] = lately;
    else delete counts[kind]![key];
  }, file);
}

/** A session `bot` starts, noted before its limits are looked at, so starts asked for at once each
 * count the ones before them that the engine doesn't show yet: its token, and theirs. */
export function noteStarting(bot: string, now = Date.now(), file = LIMITS_FILE): { token: string; before: string[] } {
  const token = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  return changeCounts(now, counts => {
    const starts = counts.starting![bot] ?? {};
    counts.starting![bot] = { ...starts, [token]: { at: now } };
    return { token, before: Object.keys(starts) };
  }, file);
}

/** The starts noted `before` one, as they are now (their sessions may be made by then); those gone
 * didn't start. */
export function startsBefore(bot: string, before: string[], file = LIMITS_FILE): Starting[] {
  return changeCounts(Date.now(), counts => {
    const starts = counts.starting![bot] ?? {};
    return before.flatMap(token => starts[token] ? [starts[token]] : []);
  }, file);
}

/** How the start `token` went: its session (and whether it was given its task), kept a while so
 * starts after it count it until the engine does; or null, it didn't start. */
export function startedAs(bot: string, token: string, session: string | null, prompted = false, file = LIMITS_FILE): void {
  changeCounts(Date.now(), counts => {
    const starts = counts.starting![bot] ?? {};
    if (!starts[token]) return;
    if (session) starts[token] = { ...starts[token], session, ...(prompted ? { prompted } : {}) };
    else delete starts[token];
    if (Object.keys(starts).length) counts.starting![bot] = starts;
    else delete counts.starting![bot];
  }, file);
}
