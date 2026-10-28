// How much agents may do unattended (PROTOCOL.md, "Agents' tools")
// Two agents shouldn't keep writing to each other for ever, nor one fill the window with sessions,
// while nobody's watching. The limits are this one table, and every route and letter goes through
// `allowed`: a `most` of Infinity switches one off. What each caller did lately is kept in
// `run/tool-limits.json`, so a tool's call answered by a process of its own (`box route`) counts too.

import fs from "node:fs";
import path from "node:path";
import { locked, writePrivate } from "../files";
import { RUN } from "../home";

/** What's counted: messages sent (by a conversation, or letters from another computer) and
 * sessions started; at most `most` in `within` ms. */
export const LIMITS = {
  messages: { most: 20, within: 600_000 },
  sessions: { most: 6, within: 600_000 },
} satisfies Record<string, { most: number; within: number }>;

export type LimitKind = keyof typeof LIMITS;

export const LIMITS_FILE = path.join(RUN, "tool-limits.json");
const LIMITS_LOCK = path.join(RUN, ".tool-limits.lock");

type Counts = Partial<Record<LimitKind, Record<string, number[]>>>;

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
