// When each ask waiting on you came (`asked` in `kuvo/sessions/glance`): a permission or a question
// a session or one of its subagents asks, noted as its event comes from the engine or the coding
// agents' bridge, and let go as it's answered or its run ends. The box's long-running process
// notes them, in `run/glance/asks.json`, so a route answered in a process of its own (`box route`)
// reads them too. An ask made while the box wasn't listening has no time, and a client says how
// long since the session last changed instead.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { writePrivate } from "../files";
import { RUN } from "../home";
import { call } from "../engine/client";
import type { Target } from "../../shared/records";

export const ASKS_FILE = path.join(RUN, "glance", "asks.json");

/** An ask's event, as this reads it: what it is, its id (`requestID` once answered), and the
 * session asking (a form's under `form`, or as it is). */
export interface AskEvent {
  type: string;
  data?: { id?: unknown; requestID?: unknown; sessionID?: unknown; form?: unknown };
}

/** An ask waiting: the session asking (a subagent's own) and when it came (ms). */
interface OpenAsk {
  session: string;
  at: number;
  /** The port of the place it was asked on (the engine's, or the bridge's). */
  port?: number;
}

const ASKED = new Set(["permission.asked", "form.created"]);
const ANSWERED = new Set(["permission.replied", "permission.rejected", "form.replied", "form.cancelled"]);
const RUN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

/** Each ask waiting, by its id, as this process heard them. */
const open = new Map<string, OpenAsk>();
/** The session each subagent works for, as its engine said: a session's never changes. */
const parents = new Map<string, string | null>();
/** Whether this process has noted anything yet. */
let started = false;
/** Told as an ask comes or goes. */
export const askFollowers = new Set<() => void>();

/** Takes in an event from the engine or the coding agents' bridge: an ask noted as it comes, let go
 * as it's answered, and all of a session's as its run ends (the engine lets them go with it,
 * without a word of each). */
export function noteAskEvent(event: AskEvent, port?: number, now = Date.now()): void {
  const data = event.data ?? {};
  let changed = false;
  const asked = event.type === "form.created" && isObject(data.form) ? data.form : data;
  if (ASKED.has(event.type)) {
    if (typeof asked.id === "string" && typeof asked.sessionID === "string" && asked.sessionID.startsWith("ses") && !open.has(asked.id)) {
      open.set(asked.id, { session: asked.sessionID, at: now, ...(port ? { port } : {}) });
      changed = true;
    }
  } else if (ANSWERED.has(event.type)) {
    const id = data.requestID ?? data.id;
    changed = typeof id === "string" && open.delete(id);
  } else if (RUN_ENDS.has(event.type) && typeof data.sessionID === "string") {
    for (const [id, ask] of open) if (ask.session === data.sessionID) changed = open.delete(id) || changed;
  }
  if (changed) keep();
}

/** What's noted, for every process, and those following told. */
function keep(): void {
  started = true;
  try {
    writePrivate(ASKS_FILE, JSON.stringify({ asks: Object.fromEntries(open) }) + "\n");
  } catch {}
  for (const told of askFollowers) try { told(); } catch {}
}

/** A place heard again after it couldn't be (it restarted, its stream dropped): what it asked
 * meanwhile went by unheard, so what was noted of it goes, rather than say an answered ask still
 * waits. */
export function forgetAsksOn(port: number): void {
  // (What a process before this one noted goes the first time: none of it was heard here.)
  let changed = !started;
  started = true;
  for (const [id, ask] of open) if (ask.port === port) changed = open.delete(id) || changed;
  if (changed) keep();
}

/** The asks waiting, as the long-running process noted them. */
function readAsks(): OpenAsk[] {
  try {
    const kept = JSON.parse(fs.readFileSync(ASKS_FILE, "utf8")).asks;
    return isObject(kept) ? Object.values(kept).filter((ask): ask is OpenAsk => isObject(ask) && typeof ask.session === "string" && typeof ask.at === "number") : [];
  } catch {
    return [];
  }
}

/** The conversation `session` is part of (a subagent's, the one it works for), as `targets` say. */
async function rootOf(targets: Target[], session: string, signal?: AbortSignal): Promise<string> {
  let at = session;
  for (let step = 0; step < 10; step++) {
    if (!parents.has(at)) {
      let found: unknown;
      for (const target of targets) {
        found = await call(target, "GET", `/api/session/${encodeURIComponent(at)}`, undefined, signal).catch(() => undefined);
        if (found !== undefined) break;
      }
      if (found === undefined) return at;
      parents.set(at, isObject(found) && typeof found.parentID === "string" ? found.parentID : null);
    }
    const parent = parents.get(at);
    if (!parent) return at;
    at = parent;
  }
  return at;
}

/** Since when each of `sessions` has waited on you (ms), its subagents' asks counting as its own:
 * the oldest ask still open. */
export async function askedSince(sessions: string[], targets: Target[], signal?: AbortSignal): Promise<Map<string, number>> {
  const wanted = new Set(sessions);
  const since = new Map<string, number>();
  for (const ask of readAsks()) {
    const root = wanted.has(ask.session) ? ask.session : await rootOf(targets, ask.session, signal);
    if (wanted.has(root)) since.set(root, Math.min(since.get(root) ?? Infinity, ask.at));
  }
  return since;
}

/** Forgets every ask (a test's fresh start). */
export function forgetAsks(): void {
  open.clear();
  parents.clear();
  started = false;
  try { fs.rmSync(ASKS_FILE, { force: true }); } catch {}
}
