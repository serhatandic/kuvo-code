// The limits you set for a bot (Edit Bot › Work), kept in its `bot.json` as `work.limits`: none
// until you set one. The bot sizes its work to the job; these are yours, and the box holds it to
// them as it starts a session.

import { isObject } from "../../shared/json";
import { botHere } from "../bots/here";
import type { WorkLimits } from "../../shared/routes/work";

const NAMES = ["atOnce", "perDay", "depth", "tokensPerDay"] as const;

/** Limits as they're kept: only whole numbers of 1 or more, each left out otherwise; null for none. */
export function limitsFrom(given: unknown): WorkLimits | null {
  if (!isObject(given)) return null;
  const limits: WorkLimits = {};
  for (const name of NAMES) {
    const value = given[name];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) limits[name] = value;
  }
  return Object.keys(limits).length ? limits : null;
}

/** The limits you set for the bot `id`, or null for none. */
export function botLimits(id: string): WorkLimits | null {
  const work = botHere(id)?.described.work;
  return isObject(work) ? limitsFrom(work.limits) : null;
}

/** Which limit you set a new session at `depth` would be past, and why in the words its bot reads;
 * null when it isn't. `working`: its sessions working now; `today`: started today, and their tokens.
 * A day's limit resets at midnight (`daily`). */
export function pastLimit(limits: WorkLimits | null, { depth, working, started, tokens }: { depth: number; working: number; started: number; tokens: number }): { words: string; daily: boolean } | null {
  if (!limits) return null;
  const ask = " Wait for one to finish, or ask the user to raise it (Edit Bot › Work).";
  if (limits.depth !== undefined && depth > limits.depth) return { daily: false, words: `The user set your sessions to go ${limits.depth === 1 ? "one level deep" : `${limits.depth} levels deep`} at most, so this one can't start another. Do it in this session, or ask the user.` };
  if (limits.atOnce !== undefined && working >= limits.atOnce) return { daily: false, words: `The user set you to ${limits.atOnce} session${limits.atOnce === 1 ? "" : "s"} at once at most, and that many are working.` + ask };
  if (limits.perDay !== undefined && started >= limits.perDay) return { daily: true, words: `The user set you to ${limits.perDay} new session${limits.perDay === 1 ? "" : "s"} a day at most, and you've started that many today.` };
  if (limits.tokensPerDay !== undefined && tokens >= limits.tokensPerDay) return { daily: true, words: `Your sessions have used the ${limits.tokensPerDay.toLocaleString("en-US")} tokens a day the user set.` };
  return null;
}
