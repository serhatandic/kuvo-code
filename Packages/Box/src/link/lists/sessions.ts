// Every client's session lists, from the box (PROTOCOL.md, "Session lists"): `GET kuvo/sessions/list`
// and `…/events`, each session's facts (what it is, its project, its flags, whether it runs and
// asks you) and the projects the lists show, then what changes. The box's long-running process keeps
// the list as its engine's and its coding agents' events come (`noteListEvent`), read whole as each
// place is heard (`listPlaceHeard`) and every five minutes, and keeps it in `run/lists/sessions.json`
// for a route answered in a process of its own (`box route`). Each entry carries the change it came
// with (`seq`), and those gone are kept a while, so a client that lost its stream resumes from where
// it was (`since`) rather than read everything again.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { listOf, writePrivate } from "../files";
import { BOTS, RUN } from "../home";
import { call, engineGet } from "../engine/client";
import { isChatsFolder } from "../engine/chats";
import { filedProjects, projectFollowers, readProjects } from "../areas/projects";
import { botFollowers, botHere } from "../bots/here";
import { awaySessions, moveFollowers } from "../moves/records";
import { askFollowers, readAsks } from "../glance/asked";
import { factsOf, listedProjects, type ListPlace } from "./rule";
import { targetsOf } from "../letters/tools";
import type { EngineSession } from "../engine/sessions";
import type { ListedProject, SessionFacts, SessionList } from "../../shared/routes/sessions";
import type { Target } from "../../shared/records";
import type { AnswerPiece, RouteContext } from "../server/context";

export const LIST_ROUTE = /^kuvo\/sessions\/list(\/events)?$/;
export const LIST_FILE = path.join(RUN, "lists", "sessions.json");

/** How many sessions gone are kept for `since`, and for how long. */
export const GONE_KEPT = 2000;
const GONE_FOR = 24 * 3600_000;
/** How often the list is read whole while the box runs. */
const READ_EVERY = 5 * 60_000;
/** A session's events that change what's listed of it: it's read again. */
const RELOADS = new Set(["session.created", "session.updated", "session.renamed", "session.moved", "session.metadata.updated", "session.revert.staged", "session.revert.cleared", "session.revert.committed"]);
const STARTS = "session.execution.started";
const ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

/** One place's sessions (the engine's, or the coding agents' bridge's), and those at work there. */
interface Place {
  sessions: Map<string, EngineSession>;
  running: Set<string>;
}

/** The list as it's kept: where it's at, each session's facts with the change it came with, those
 * gone since (with theirs), the oldest change `since` can resume from, and its projects. */
interface Kept {
  epoch: string;
  seq: number;
  floor: number;
  pid: number;
  sessions: Record<string, { seq: number; facts: SessionFacts }>;
  gone: Record<string, { seq: number; at: number }>;
  projects: Record<string, ListedProject>;
}

// The long-running process's own list: null in any other (a route answered alone reads the file).
let kept: Kept | null = null;
const places = new Map<string, Place>();
/** Told as the list changes (each `…/events` stream). */
export const listFollowers = new Set<() => void>();

/** A cursor: the epoch it's of and the change it's at. */
const cursorOf = (list: Pick<Kept, "epoch" | "seq">) => `${list.epoch}.${list.seq}`;

function parseCursor(given: string | null): { epoch: string; seq: number } | null {
  const match = given?.match(/^([A-Za-z0-9-]+)\.(\d+)$/);
  return match ? { epoch: match[1]!, seq: Number(match[2]) } : null;
}

/** What the box knows beside its sessions, as it is now. */
export function placeNow(running: ReadonlySet<string>, sessions: Iterable<EngineSession>): ListPlace {
  const projects = readProjects();
  const parents = new Map<string, string>();
  for (const session of sessions) if (session.parentID) parents.set(session.id, session.parentID);
  // (A subagent's ask is the conversation's it works for.)
  const asked = new Map<string, number>();
  for (const ask of readAsks()) {
    let root = ask.session;
    for (let step = 0; step < 10 && parents.has(root); step++) root = parents.get(root)!;
    asked.set(root, Math.min(asked.get(root) ?? Infinity, ask.at));
  }
  const botSessions = new Set<string>();
  for (const id of listOf(BOTS)) {
    const bot = botHere(id);
    if (bot) botSessions.add(bot.session);
  }
  return { isChatsFolder, botsFolder: BOTS, botSessions, filed: filedProjects(projects), projects, running, asked, away: new Set(awaySessions()) };
}

/** Every session in `sessions` (the engine's or the bridge's, each once) with its facts, and the
 * projects. */
export function listOfSessions(sessions: EngineSession[], place: ListPlace): { sessions: Record<string, SessionFacts>; projects: Record<string, ListedProject> } {
  const facts: Record<string, SessionFacts> = {};
  for (const session of sessions) if (typeof session?.id === "string" && !(session.id in facts)) facts[session.id] = factsOf(session, place);
  return { sessions: facts, projects: listedProjects(facts, place) };
}

/** Every session on `target`, subagents' too, page after page; null where its list can't be read. */
export async function readSessions(target: Target, signal?: AbortSignal): Promise<EngineSession[] | null> {
  const all: EngineSession[] = [];
  const seen = new Set<string>();
  let query: string | null = "limit=200&order=desc";
  for (let pages = 0; query && pages < 500; pages++) {
    if (signal?.aborted) return null;
    const page = await engineGet(target, `api/session?${query}`).catch(() => null) as { data?: unknown; cursor?: { next?: unknown } | null } | null;
    const listed: unknown[] | null = Array.isArray(page?.data) ? page.data : null;
    if (!listed) return null;
    const fresh = listed.filter((each): each is EngineSession => isObject(each) && typeof each.id === "string" && !seen.has(each.id));
    for (const each of fresh) seen.add(each.id);
    all.push(...fresh);
    const next = page?.cursor?.next;
    query = listed.length === 200 && fresh.length && typeof next === "string" ? `limit=200&cursor=${encodeURIComponent(next)}` : null;
  }
  return all;
}

/** Those at work on `target`; null where it can't say. */
export async function readRunning(target: Target, signal?: AbortSignal): Promise<Set<string> | null> {
  try {
    const active: unknown = await call(target, "GET", "/api/session/active", undefined, signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000));
    if (Array.isArray(active)) return new Set(active.filter((id): id is string => typeof id === "string"));
    return isObject(active) ? new Set(Object.keys(active)) : null;
  } catch {
    return null;
  }
}

// MARK: The long-running process's list

/** Starts keeping the list here (the box's long-running process): from what's kept from before
 * under a fresh epoch, and worked out again as its projects, bots, moves or asks change. How to stop. */
export function keepList(now = Date.now()): () => void {
  kept = { epoch: `${now.toString(36)}-${process.pid.toString(36)}`, seq: 0, floor: 0, pid: process.pid, sessions: {}, gone: {}, projects: {} };
  places.clear();
  const again = () => scheduleWorkOut();
  const followers = [projectFollowers, botFollowers, moveFollowers, askFollowers];
  for (const each of followers) each.add(again);
  const whole = setInterval(() => { for (const [name, place] of placeTargets) readPlace(name, place).catch(() => {}); }, READ_EVERY);
  whole.unref?.();
  return () => {
    for (const each of followers) each.delete(again);
    clearInterval(whole);
    clearTimeout(workOutTimer);
    kept = null;
    places.clear();
    placeTargets.clear();
  };
}

/** Whether this process keeps the list. */
export const keepsList = () => kept !== null;

// Each place as it was last heard, to read it whole again now and then.
const placeTargets = new Map<string, Target>();

/** A place heard (it started, or its events came back after they couldn't be): read whole now, as
 * what it did meanwhile went by unheard. */
export function listPlaceHeard(name: string, target: Target): Promise<void> {
  if (!kept) return Promise.resolve();
  placeTargets.set(name, target);
  return readPlace(name, target);
}

async function readPlace(name: string, target: Target): Promise<void> {
  const [sessions, running] = await Promise.all([readSessions(target), readRunning(target)]);
  if (!kept || !sessions) return;
  places.set(name, { sessions: new Map(sessions.map(each => [each.id, each])), running: running ?? places.get(name)?.running ?? new Set() });
  workOut();
}

/** Takes in an event from `name` (the engine, or the bridge, at `target`): a session read again as
 * it's made or changes, its run starting or ending; dropped as it's deleted. Settled once what it
 * read is in the list (a test waits on it). */
export async function noteListEvent(name: string, target: Target, event: { type?: string; data?: { sessionID?: unknown; info?: { id?: unknown } } }): Promise<void> {
  if (!kept || typeof event?.type !== "string") return;
  const id = event.data?.sessionID ?? event.data?.info?.id;
  if (typeof id !== "string" || !id.startsWith("ses")) return;
  const place = places.get(name) ?? { sessions: new Map(), running: new Set() };
  places.set(name, place);
  if (event.type === "session.deleted") {
    place.sessions.delete(id);
    place.running.delete(id);
    return scheduleWorkOut();
  }
  if (event.type === STARTS) place.running.add(id);
  else if (ENDS.has(event.type)) place.running.delete(id);
  else if (!RELOADS.has(event.type)) return;
  scheduleWorkOut();
  // As it is now: its folder, title, notes and times.
  try {
    const session = await call(target, "GET", `/api/session/${encodeURIComponent(id)}`, undefined, AbortSignal.timeout(10_000));
    if (isObject(session) && session.id === id && places.get(name) === place) {
      place.sessions.set(id, session as unknown as EngineSession);
      workOut();
    }
  } catch (error) {
    if ((error as { status?: number }).status === 404 && places.get(name) === place) {
      place.sessions.delete(id);
      workOut();
    }
  }
}

let workOutTimer: ReturnType<typeof setTimeout> | undefined;
/** Worked out again in a moment: a few changes at once are one. */
function scheduleWorkOut(): void {
  if (!kept || workOutTimer) return;
  workOutTimer = setTimeout(() => { workOutTimer = undefined; workOut(); }, 50);
  workOutTimer.unref?.();
}

/** Every session's facts worked out again from what's kept of its places; what changed gets the
 * next change's number, and followers are told. */
export function workOut(now = Date.now()): void {
  if (!kept) return;
  clearTimeout(workOutTimer);
  workOutTimer = undefined;
  const sessions: EngineSession[] = [];
  const running = new Set<string>();
  for (const place of places.values()) {
    for (const session of place.sessions.values()) sessions.push(session);
    for (const id of place.running) running.add(id);
  }
  const listed = listOfSessions(sessions, placeNow(running, sessions));
  const next = kept.seq + 1;
  let changed = false;
  for (const [id, facts] of Object.entries(listed.sessions)) {
    const before = kept.sessions[id];
    if (before && JSON.stringify(before.facts) === JSON.stringify(facts)) continue;
    kept.sessions[id] = { seq: next, facts };
    delete kept.gone[id];
    changed = true;
  }
  for (const id of Object.keys(kept.sessions)) {
    if (id in listed.sessions) continue;
    delete kept.sessions[id];
    kept.gone[id] = { seq: next, at: now };
    changed = true;
  }
  if (JSON.stringify(kept.projects) !== JSON.stringify(listed.projects)) {
    kept.projects = listed.projects;
    changed = true;
  }
  if (!changed) return;
  kept.seq = next;
  // Those gone kept a day, the latest 2000: `since` from before the oldest let go reads it all.
  const gone = Object.entries(kept.gone).sort((a, b) => b[1].seq - a[1].seq);
  for (const [index, [id, { seq, at }]] of gone.entries()) {
    if (index < GONE_KEPT && now - at < GONE_FOR) continue;
    delete kept.gone[id];
    kept.floor = Math.max(kept.floor, seq);
  }
  keepFile();
  for (const tell of [...listFollowers]) try { tell(); } catch {}
}

/** The list in its file, for a route answered in a process of its own; not over another live
 * process's (one box, one list). */
function keepFile(): void {
  if (!kept) return;
  const there = readFile();
  if (there && there.pid !== process.pid && processRuns(there.pid)) return;
  try { writePrivate(LIST_FILE, JSON.stringify(kept)); } catch {}
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function readFile(): Kept | null {
  try {
    const read = JSON.parse(fs.readFileSync(LIST_FILE, "utf8"));
    return isObject(read) && typeof read.epoch === "string" && typeof read.seq === "number" && isObject(read.sessions) ? read as unknown as Kept : null;
  } catch {
    return null;
  }
}

/** The list from `list`: what changed after `since` (in its epoch, not before the oldest change it
 * can still say), else all of it. */
export function answerFrom(list: Kept, since: string | null): SessionList {
  const from = parseCursor(since);
  const whole = !from || from.epoch !== list.epoch || from.seq < list.floor || from.seq > list.seq;
  const sessions: Record<string, SessionFacts> = {};
  for (const [id, entry] of Object.entries(list.sessions)) if (whole || entry.seq > from!.seq) sessions[id] = entry.facts;
  if (whole) return { at: cursorOf(list), full: true, sessions, projects: list.projects };
  const gone = Object.entries(list.gone).filter(([, entry]) => entry.seq > from!.seq).map(([id]) => id).sort();
  return { at: cursorOf(list), sessions, ...(gone.length ? { gone } : {}), projects: list.projects };
}

/** The list now, for a route: this process's own, else the long-running process's file while it
 * runs, else read from the places here at once (whole, under an epoch of its own). Null when no
 * place could be read. */
async function listNow(context: Pick<RouteContext, "readEngine" | "bridge">, signal?: AbortSignal): Promise<Kept | null> {
  if (kept) return kept;
  const file = readFile();
  if (file && processRuns(file.pid)) return file;
  const targets = targetsOf(context);
  let read = false;
  const sessions: EngineSession[] = [];
  const running = new Set<string>();
  for (const target of targets) {
    const [listed, active] = await Promise.all([readSessions(target, signal), readRunning(target, signal)]);
    if (!listed) continue;
    read = true;
    sessions.push(...listed);
    for (const id of active ?? []) running.add(id);
  }
  if (!read) return null;
  const listed = listOfSessions(sessions, placeNow(running, sessions));
  // (Never resumed from: what it said is whole every time, `floor` past it.)
  return {
    epoch: `once-${Date.now().toString(36)}`, seq: 1, floor: 2, pid: 0,
    sessions: Object.fromEntries(Object.entries(listed.sessions).map(([id, facts]) => [id, { seq: 1, facts }])),
    gone: {}, projects: listed.projects,
  };
}

export async function* listRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, { message: "Only GET." });
  const since = new URLSearchParams(request.path.split("?")[1] ?? "").get("since");
  const list = await listNow(context, signal ?? undefined);
  if (!list) return yield* json(503, { message: "The engine isn’t running." });
  if (!match[1] || !kept) {
    // (Streamed only where it's kept: elsewhere its first line, as `box route` answers.)
    if (!match[1]) return yield* json(200, answerFrom(list, since));
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield { body: Buffer.from(JSON.stringify(answerFrom(list, since)) + "\n") };
  }
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  let wake: (() => void) | null = null;
  let dirty = false;
  const told = () => { dirty = true; wake?.(); };
  listFollowers.add(told);
  signal?.addEventListener("abort", () => wake?.(), { once: true });
  try {
    let at: string | null = since;
    let first = true;
    while (!signal?.aborted) {
      dirty = false;
      const now = kept;
      if (!now) return;
      const answer = answerFrom(now, at);
      // (Nothing changed since: no line, but the first. Its projects changed alone: a line.)
      if (first || answer.full || at !== answer.at) yield { body: Buffer.from(JSON.stringify(answer) + "\n") };
      first = false;
      at = answer.at;
      if (dirty) continue;
      // A minute at most between looks: what changes is told at once.
      await new Promise<void>(done => {
        const timer = setTimeout(done, 60_000);
        wake = () => { clearTimeout(timer); done(); };
      });
      wake = null;
    }
  } finally {
    listFollowers.delete(told);
  }
}
