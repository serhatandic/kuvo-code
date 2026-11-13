// Every client's session lists, from the box (PROTOCOL.md, "Session lists"): `GET kuvo/sessions/list`
// and `…/events`, each session's facts (what it is, its project, its flags, whether it runs and
// asks you) and the projects the lists show, then what changes. The list is kept in
// `run/lists/sessions.json`, one for the box whichever process works it out, under its lock: each
// entry with the change it came with (`seq`), and those gone kept a while, so a client that lost its
// stream resumes from where it was (`since`), across the box's restarts too, rather than read
// everything again. The box's long-running process works it out as its engine's and its coding
// agents' events come (`noteListEvent`), from each place read whole as it's heard
// (`listPlaceHeard`) and every five minutes; a route answered in a process of its own (`box route`,
// a machine reached over SSH) reads the places itself.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { listOf, locked, writePrivate } from "../files";
import { BOTS, BOX, RUN } from "../home";
import { watchFolders } from "../follow";
import { watchFolder } from "../../shared/watch";
import { bridgeTarget, call, engineGet } from "../engine/client";
import { processRuns } from "../../shared/platform";
import { isChatsFolder } from "../engine/chats";
import { filedProjects, projectFollowers, readProjects } from "../areas/projects";
import { botFollowers, botHere } from "../bots/here";
import { awaySessions, moveFollowers, MOVES } from "../moves/records";
import { askFollowers, readAsks } from "../glance/asked";
import { factsOf, listedProjects, type ListPlace } from "./rule";
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

/** The list as it's kept: where it's at, each session's facts with the change it came with and the
 * place it's on, those gone since (with theirs), the oldest change `since` can resume from, its
 * projects, the places it couldn't read (their sessions as they were last read), and the box's
 * long-running process that keeps it (`owner`), while it runs. */
export interface Kept {
  epoch: string;
  seq: number;
  floor: number;
  sessions: Record<string, { seq: number; facts: SessionFacts; place?: string }>;
  gone: Record<string, { seq: number; at: number }>;
  projects: Record<string, ListedProject>;
  pending?: string[];
  owner?: number;
  /** Which start of `owner` it is (the same process id may come again after a restart). */
  started?: string;
}

/** How far the list's count moves on as it's taken over from a long-running process that went:
 * past any change that one told but didn't write (its writes are a moment apart). */
const LOST_GAP = 1_000_000;
/** This process's own start, told apart from an earlier one with the same id. */
const STARTED = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** What a list is worked out to: each session's facts, the place each is on, the projects, and the
 * places that couldn't be read. */
interface Listed {
  sessions: Record<string, SessionFacts>;
  projects: Record<string, ListedProject>;
  placeOf?: Record<string, string>;
  pending?: string[];
}

// Whether this process is the box's long-running one, which keeps its places as their events come.
let keeping = false;
/** The list as this process last worked it out. */
let latest: Kept | null = null;
const places = new Map<string, Place>();
/** Told as the list changes (each `…/events` stream). */
export const listFollowers = new Set<() => void>();

/** A cursor: the epoch it's of and the change it's at. */
const cursorOf = (list: Pick<Kept, "epoch" | "seq">) => `${list.epoch}.${list.seq}`;

function parseCursor(given: string | null): { epoch: string; seq: number } | null {
  const match = given?.match(/^([A-Za-z0-9-]+)\.(\d+)$/);
  return match ? { epoch: match[1]!, seq: Number(match[2]) } : null;
}

/** What the box knows beside its sessions, read from its files: kept by the long-running process
 * until one of them changes (`keepList`), so a run's every step reads none of them. (A project's
 * git worktree made outside Kuvo Code, `linkedTrees`, is seen as it's read again: at the next
 * whole read, a route's ask or a stream's minute.) */
export interface BoxKnows {
  projects: ReturnType<typeof readProjects>;
  filed: Record<string, string>;
  botSessions: Set<string>;
  away: Set<string>;
  asks: ReturnType<typeof readAsks>;
}

export function readBoxKnows(): BoxKnows {
  const projects = readProjects();
  const botSessions = new Set<string>();
  for (const id of listOf(BOTS)) {
    const bot = botHere(id);
    if (bot) botSessions.add(bot.session);
  }
  return { projects, filed: filedProjects(projects), botSessions, away: new Set(awaySessions()), asks: readAsks() };
}

/** What the box knows beside its sessions, as it is now (`known`: as it was read last). */
export function placeNow(running: ReadonlySet<string>, sessions: Iterable<EngineSession>, known: BoxKnows = readBoxKnows()): ListPlace {
  const parents = new Map<string, string>();
  for (const session of sessions) if (session.parentID) parents.set(session.id, session.parentID);
  // (A subagent's ask is the conversation's it works for.)
  const asked = new Map<string, number>();
  for (const ask of known.asks) {
    let root = ask.session;
    for (let step = 0; step < 10 && parents.has(root); step++) root = parents.get(root)!;
    asked.set(root, Math.min(asked.get(root) ?? Infinity, ask.at));
  }
  return { isChatsFolder, botsFolder: BOTS, botSessions: known.botSessions, filed: known.filed, projects: known.projects, running, asked, away: known.away };
}

// Each session's facts as last worked out, while what they come from is the same (the session as
// read, what the box knew then, whether it runs, asks or is away): not worked out again each time.
const factsMade = new WeakMap<EngineSession, { known: BoxKnows; running: boolean; asked?: number; away: boolean; facts: SessionFacts }>();

function factsNow(session: EngineSession, place: ListPlace, known?: BoxKnows): SessionFacts {
  if (!known) return factsOf(session, place);
  const running = place.running.has(session.id), asked = place.asked.get(session.id), away = place.away.has(session.id);
  const made = factsMade.get(session);
  if (made && made.known === known && made.running === running && made.asked === asked && made.away === away) return made.facts;
  const facts = factsOf(session, place);
  factsMade.set(session, { known, running, asked, away, facts });
  return facts;
}

/** Every session in `sessions` (the engine's or the bridge's, each once) with its facts, and the
 * projects. */
export function listOfSessions(sessions: EngineSession[], place: ListPlace, known?: BoxKnows): { sessions: Record<string, SessionFacts>; projects: Record<string, ListedProject> } {
  const facts: Record<string, SessionFacts> = {};
  for (const session of sessions) if (typeof session?.id === "string" && !(session.id in facts)) facts[session.id] = factsNow(session, place, known);
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
    // (On as long as the engine says where the next page starts: a page may be shorter than asked.)
    query = listed.length && fresh.length && typeof next === "string" && next ? `limit=200&cursor=${encodeURIComponent(next)}` : null;
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

// MARK: The list, kept

/** The list in its file; null where there's none yet (or it can't be read). */
export function readList(file = LIST_FILE): Kept | null {
  try {
    const read = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(read) && typeof read.epoch === "string" && typeof read.seq === "number" && typeof read.floor === "number" && isObject(read.sessions) && isObject(read.gone) && isObject(read.projects)
      ? read as unknown as Kept : null;
  } catch {
    return null;
  }
}

/** The list with `listed` taken in, as it is now, under its lock: each session whose facts changed
 * with the next change's number, each one no longer there kept as gone (a day, the latest 2000; a
 * `since` from before the oldest let go reads it all). A list that isn't there starts a new epoch. */
export function commit(listed: Listed, now = Date.now(), file = LIST_FILE, owner?: number): Kept {
  return locked(file + ".lock", () => {
    const list: Kept = readList(file) ?? { epoch: `${now.toString(36)}-${process.pid.toString(36)}`, seq: 0, floor: 0, sessions: {}, gone: {}, projects: {} };
    // A route's, while the long-running process keeps it (it started since the route looked): its
    // list stands, mark and all.
    if (owner === undefined && list.owner && list.owner !== process.pid && processRuns(list.owner, "kuvo-link")) return list;
    // Taken over from a long-running process that went (this one started again, or a route
    // answers in its place): it may have told changes it hadn't written yet. Numbered on past them,
    // and every cursor from before reads it all (one whole read after a restart).
    if (list.seq > 0 && list.owner !== undefined && (list.owner !== owner || list.started !== STARTED)) {
      list.seq += LOST_GAP;
      list.floor = list.seq;
    }
    const { changed, noted } = takeIn(list, listed, now, owner);
    if (changed || noted) try { writePrivate(file, JSON.stringify(list)); } catch {}
    return list;
  });
}

/** Whether two sessions' facts say the same (but `updated`, with `ignoring`). */
function sameFacts(a: SessionFacts, b: SessionFacts, ignoring?: "updated"): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof SessionFacts)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => key === ignoring || a[key] === b[key]);
}

const projectsSaid = (projects: Record<string, ListedProject>, withUpdated: boolean) =>
  JSON.stringify(withUpdated ? projects : Object.fromEntries(Object.entries(projects).map(([folder, { updated: _, ...rest }]) => [folder, rest])));

/** `listed` taken into `list` (changed in place): each session whose facts changed with the next
 * change's number, each one no longer there kept as gone (a day, the latest 2000; a `since` from
 * before the oldest let go reads it all). Whether it changed, whether only what the file says did
 * (`noted`), and whether anything but when sessions last changed did (`telling`). */
function takeIn(list: Kept, listed: Listed, now: number, owner?: number): { changed: boolean; noted: boolean; telling: boolean } {
  const next = list.seq + 1;
  let changed = false, telling = false;
  // (What only the file says, not the list: written, with no change to tell.)
  let noted = list.owner !== owner;
  if (owner === undefined) { delete list.owner; delete list.started; }
  else { noted ||= list.started !== STARTED; list.owner = owner; list.started = STARTED; }
  for (const [id, facts] of Object.entries(listed.sessions)) {
    const before = list.sessions[id];
    const place = listed.placeOf?.[id];
    if (before && sameFacts(before.facts, facts)) {
      if (place && before.place !== place) { before.place = place; noted = true; }
      continue;
    }
    if (!before || !sameFacts(before.facts, facts, "updated")) telling = true;
    list.sessions[id] = { seq: next, facts, ...(place ? { place } : {}) };
    delete list.gone[id];
    changed = true;
  }
  for (const id of Object.keys(list.sessions)) {
    if (id in listed.sessions) continue;
    delete list.sessions[id];
    list.gone[id] = { seq: next, at: now };
    changed = telling = true;
  }
  if (projectsSaid(list.projects, true) !== projectsSaid(listed.projects, true)) {
    if (projectsSaid(list.projects, false) !== projectsSaid(listed.projects, false)) telling = true;
    list.projects = listed.projects;
    changed = true;
  }
  const pending = listed.pending?.length ? [...listed.pending].sort() : undefined;
  if (JSON.stringify(list.pending) !== JSON.stringify(pending)) {
    if (pending) list.pending = pending;
    else delete list.pending;
    changed = telling = true;
  }
  if (!changed) return { changed, noted, telling };
  list.seq = next;
  const gone = Object.entries(list.gone).sort((a, b) => b[1].seq - a[1].seq);
  for (const [index, [id, { seq, at }]] of gone.entries()) {
    if (index < GONE_KEPT && now - at < GONE_FOR) continue;
    delete list.gone[id];
    list.floor = Math.max(list.floor, seq);
  }
  return { changed, noted, telling };
}

/** The list from `list`: what changed after `since` (in its epoch, not before the oldest change it
 * can still say), else all of it. */
export function answerFrom(list: Kept, since: string | null): SessionList {
  const from = parseCursor(since);
  const whole = !from || from.epoch !== list.epoch || from.seq < list.floor || from.seq > list.seq;
  const sessions: Record<string, SessionFacts> = {};
  for (const [id, entry] of Object.entries(list.sessions)) if (whole || entry.seq > from!.seq) sessions[id] = entry.facts;
  const pending = list.pending?.length ? { pending: list.pending } : {};
  if (whole) return { at: cursorOf(list), full: true, sessions, projects: list.projects, ...pending };
  const gone = Object.entries(list.gone).filter(([, entry]) => entry.seq > from!.seq).map(([id]) => id).sort();
  return { at: cursorOf(list), sessions, ...(gone.length ? { gone } : {}), projects: list.projects, ...pending };
}

// MARK: The long-running process's list

/** The box's files a list goes by, which another process may change (a `box route` over SSH, a
 * move, kuvo-wake): its projects and worktrees (`box`, only those files), its bots and its moves. */
const LIST_FILES = new Set(["projects.json", "worktrees.json"]);
const BOT_FILES = new Set(["bot.json", "session"]);

/** Starts keeping the list here (the box's long-running process), worked out again as its
 * projects, worktrees, bots, moves or asks change, here or in another process (as the system says
 * their files changed). How to stop. */
export function keepList(): () => void {
  keeping = true;
  latest = null;
  places.clear();
  known = null;
  lastWrite = -Infinity;
  // (What the box knows read again, once, at the next working out.)
  const again = () => { known = null; scheduleWorkOut(); };
  const followers = [projectFollowers, botFollowers, moveFollowers, askFollowers];
  for (const each of followers) each.add(again);
  // (Only what a list goes by: the box's other files, and what a bot keeps in its folder as it
  // works, change often and say nothing of it.)
  const box = watchFolders([BOX], (...told: unknown[]) => { if (typeof told[1] !== "string" || LIST_FILES.has(told[1])) again(); }, { recursive: false, missed: again });
  const moves = watchFolders([MOVES], again, { recursive: false });
  // Each bot's own folder, not what's in it (where its agent works: a repository, its packages,
  // which on Linux would each take a watch of the user's): watched as bots come and go.
  const botWatches = new Map<string, fs.FSWatcher>();
  const watchBots = () => {
    const now = new Set(listOf(BOTS).filter(id => /^bot_[A-Za-z0-9]+$/.test(id)));
    for (const [id, watch] of botWatches) if (!now.has(id)) { watch.close(); botWatches.delete(id); }
    for (const id of now) {
      if (botWatches.has(id)) continue;
      try {
        const watch = watchFolder(path.join(BOTS, id), (_, name) => { if (!name || BOT_FILES.has(name)) again(); }, { missed: again });
        watch.on("error", () => { watch.close(); botWatches.delete(id); });
        botWatches.set(id, watch);
      } catch {}
    }
  };
  const bots = watchFolders([BOTS], () => { watchBots(); again(); }, { recursive: false });
  watchBots();
  // (A watch the system couldn't keep: what the box knows read each time instead.)
  watchesWhole = () => box.whole && moves.whole && bots.whole;
  const whole = setInterval(() => { for (const [name, place] of placeTargets) readPlace(name, place).catch(() => {}); }, READ_EVERY);
  whole.unref?.();
  return () => {
    for (const watch of [box, moves, bots, ...botWatches.values()]) watch.close();
    botWatches.clear();
    for (const each of followers) each.delete(again);
    clearInterval(whole);
    clearTimeout(workOutTimer);
    workOutTimer = undefined;
    // (What's not written yet, written now: a box started again goes on from it.)
    if (writeTimer) writeNow();
    keeping = false;
    latest = null;
    known = null;
    watchesWhole = () => true;
    asked.clear();
    deleted.clear();
    places.clear();
    placeTargets.clear();
    reading.clear();
    wholeReads.clear();
  };
}

// Each place as it was last heard, to read it whole again now and then.
const placeTargets = new Map<string, Target>();
// The sessions each place's events named while it was read whole, to read again once it's in.
const reading = new Map<string, Set<string>>();
// Each place's whole read under way: one at a time, and one more after it if it's asked for meanwhile.
const wholeReads = new Map<string, { done: Promise<void>; again: boolean; target: Target }>();

/** A place heard (it started, or its events came back after they couldn't be): read whole now, as
 * what it did meanwhile went by unheard. */
export function listPlaceHeard(name: string, target: Target): Promise<void> {
  if (!keeping) return Promise.resolve();
  placeTargets.set(name, target);
  return readPlace(name, target);
}

/** `name` read whole: after the one under way, if there is one (so an older read never lands over a
 * newer one), and once however often it's asked for meanwhile. */
function readPlace(name: string, target: Target): Promise<void> {
  const under = wholeReads.get(name);
  if (under) {
    under.again = true;
    under.target = target;
    return under.done;
  }
  const read = { done: Promise.resolve(), again: false, target };
  read.done = (async () => {
    try {
      do {
        read.again = false;
        await readOnce(name, read.target);
      } while (read.again && keeping);
    } finally {
      if (wholeReads.get(name) === read) wholeReads.delete(name);
    }
  })();
  wholeReads.set(name, read);
  return read.done;
}

async function readOnce(name: string, target: Target): Promise<void> {
  const touched = new Set<string>();
  reading.set(name, touched);
  let sessions: EngineSession[] | null = null;
  let running: Set<string> | null = null;
  try {
    [sessions, running] = await Promise.all([readSessions(target), readRunning(target)]);
  } finally {
    if (reading.get(name) === touched) reading.delete(name);
  }
  if (!keeping || !sessions) return;
  // (Only a whole read makes a place: until then its events have nothing to change.)
  const place = places.get(name) ?? { sessions: new Map(), running: new Set() };
  // (Not one deleted as it was read: a read begun before says it's there.)
  const gone = deleted.get(name);
  place.sessions = new Map(sessions.filter(each => !gone?.has(each.id)).map(each => [each.id, each]));
  deleted.delete(name);
  // (Its events' count starts again: a read under way for an earlier one answers for nothing now.)
  for (const key of asked.keys()) if (key.startsWith(name + " ")) asked.delete(key);
  // And what the box knows read again, in case a watch missed a change.
  known = null;
  if (running) place.running = running;
  places.set(name, place);
  // What its events said meanwhile may be newer than what was read: read those again.
  if (touched.size) {
    await Promise.all([...touched].map(id => readOne(name, target, id)));
    const now = await readRunning(target);
    if (now) place.running = now;
  }
  workOut();
}

// Each session's events so far, by place, so a read answers only for the latest (one read after an
// earlier event, landing after a later one's, says nothing); and the sessions deleted since each
// place was last read whole, which no read brings back until the next whole read.
const asked = new Map<string, number>();
const deleted = new Map<string, Set<string>>();
let eventCount = 0;

/** One session of `name`'s read again: as it is now, or gone; unless another event came for it
 * since (a later read answers for that), or it was deleted. */
async function readOne(name: string, target: Target, id: string): Promise<void> {
  const key = `${name} ${id}`;
  const at = asked.get(key);
  const current = () => asked.get(key) === at && !deleted.get(name)?.has(id);
  try {
    const session = await call(target, "GET", `/api/session/${encodeURIComponent(id)}`, undefined, AbortSignal.timeout(10_000));
    if (current() && isObject(session) && session.id === id) places.get(name)?.sessions.set(id, session as unknown as EngineSession);
  } catch (error) {
    if (current() && (error as { status?: number }).status === 404) places.get(name)?.sessions.delete(id);
  }
}

/** Takes in an event from `name` (the engine, or the bridge, at `target`): a session read again as
 * it's made or changes, its run starting or ending; dropped as it's deleted. A place not read whole
 * yet takes nothing (its whole read reads it again). Settled once what it read is in (a test waits
 * on it); worked out a moment after, so a few events at once are one. */
export async function noteListEvent(name: string, target: Target, event: { type?: string; data?: { sessionID?: unknown; info?: { id?: unknown } } }): Promise<void> {
  if (!keeping || typeof event?.type !== "string") return;
  const id = event.data?.sessionID ?? event.data?.info?.id;
  if (typeof id !== "string" || !id.startsWith("ses")) return;
  // Only those that change what's listed of it count (not what it streams meanwhile: a read for a
  // pin or a move still out isn't undone by the next word it says).
  if (event.type !== "session.deleted" && event.type !== STARTS && !ENDS.has(event.type) && !RELOADS.has(event.type)) return;
  // (Read whole now: it's read again once that's in.)
  reading.get(name)?.add(id);
  asked.set(`${name} ${id}`, ++eventCount);
  if (event.type === "session.deleted") {
    deleted.set(name, (deleted.get(name) ?? new Set()).add(id));
    if (deleted.get(name)!.size > 5000) deleted.get(name)!.clear();
  }
  const place = places.get(name);
  if (!place) return;
  if (event.type === "session.deleted") {
    place.sessions.delete(id);
    place.running.delete(id);
    return scheduleWorkOut();
  }
  if (event.type === STARTS) place.running.add(id);
  else if (ENDS.has(event.type)) place.running.delete(id);
  scheduleWorkOut();
  // As it is now: its folder, title, notes and times.
  await readOne(name, target, id);
  scheduleWorkOut();
}

let workOutTimer: ReturnType<typeof setTimeout> | undefined;
/** Worked out again in a moment: a few changes at once are one. */
function scheduleWorkOut(): void {
  if (!keeping || workOutTimer) return;
  workOutTimer = setTimeout(() => { workOutTimer = undefined; workOut(); }, 50);
  workOutTimer.unref?.();
}

/** The places that run whose sessions aren't read whole (the coding agents' bridge, running but
 * not answering yet): their sessions stay as they were last read. */
const pendingPlaces = (): string[] => (places.has("bridge") || bridgeTarget() === null ? [] : ["bridge"]);

/** `sessions` (each with its place) as listed, with the sessions of `pending` places carried over as
 * `before` had them. */
function withPending(sessions: EngineSession[], placeOf: Record<string, string>, running: Set<string>, pending: string[], before: Kept | null, knows?: BoxKnows): Listed {
  const box = placeNow(running, sessions, knows);
  const listed = listOfSessions(sessions, box, knows).sessions;
  if (pending.length && before) {
    for (const [id, entry] of Object.entries(before.sessions)) {
      if (id in listed || !entry.place || !pending.includes(entry.place)) continue;
      listed[id] = entry.facts;
      placeOf[id] = entry.place;
    }
  }
  return { sessions: listed, projects: listedProjects(listed, box), placeOf, pending };
}

/** Every session's facts worked out again from what's kept of its places, once the engine's has
 * been read whole, and kept; followers told of a change. */
export function workOut(now = Date.now()): void {
  if (!keeping) return;
  clearTimeout(workOutTimer);
  workOutTimer = undefined;
  if (!places.has("engine")) return;
  const sessions: EngineSession[] = [];
  const placeOf: Record<string, string> = {};
  const running = new Set<string>();
  for (const [name, place] of places) {
    for (const session of place.sessions.values()) {
      sessions.push(session);
      placeOf[session.id] ??= name;
    }
    for (const id of place.running) running.add(id);
  }
  const was = latest ? cursorOf(latest) : null;
  if (!watchesWhole()) known = null;
  known ??= readBoxKnows();
  const listed = withPending(sessions, placeOf, running, pendingPlaces(), latest ?? readList(), known);
  if (latest?.owner === process.pid && latest.started === STARTED) {
    // Its own, as it keeps it: what changed taken in here, the file written a moment after (a few
    // changes at once are one write; one of when sessions last changed alone, more slowly).
    const { changed, noted, telling } = takeIn(latest, listed, now, process.pid);
    if (changed || noted) scheduleWrite(telling || noted);
  } else {
    latest = commit(listed, now, LIST_FILE, process.pid);
    lastWrite = performance.now();
  }
  if (was === cursorOf(latest)) return;
  for (const tell of [...listFollowers]) try { tell(); } catch {}
}

// What's not written yet, written as the process ends (it's stopped: the keeper, an update).
process.once("exit", () => { if (writeTimer) writeNow(); });

/** The list as this process keeps it (the long-running one's), else as its file has it. */
export const keptList = (): Kept | null => latest ?? readList();

// What the box knows beside its sessions, as last read (`readBoxKnows`): null to read again.
let known: BoxKnows | null = null;
let watchesWhole = (): boolean => true;

/** How often the file is written at most: once a second, or every ten while only when sessions
 * last changed did (a run's every step). */
const WRITE_EVERY = 1000;
const QUIET_WRITE_EVERY = 10_000;
let lastWrite = -Infinity;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let writeDue = Infinity;

function scheduleWrite(soon: boolean): void {
  const now = performance.now();
  const due = Math.max(now, lastWrite + (soon ? WRITE_EVERY : QUIET_WRITE_EVERY));
  if (due <= now) return writeNow();
  if (writeTimer && writeDue <= due) return;
  clearTimeout(writeTimer);
  writeDue = due;
  writeTimer = setTimeout(writeNow, due - now);
  writeTimer.unref?.();
}

function writeNow(): void {
  clearTimeout(writeTimer);
  writeTimer = undefined;
  writeDue = Infinity;
  lastWrite = performance.now();
  const kept = latest;
  if (!kept) return;
  try { locked(LIST_FILE + ".lock", () => writePrivate(LIST_FILE, JSON.stringify(kept))); } catch {}
}

/** The engine's place read whole, where this process hasn't yet (it just started), and the bridge's
 * begun beside it if it runs (not waited for: a bridge that doesn't answer holds nothing up). */
async function readPlaces(context: Pick<RouteContext, "readEngine" | "bridge">): Promise<void> {
  let engine: Target | null = null;
  try { engine = context.readEngine(); } catch {}
  const bridge = context.bridge();
  if (bridge && !places.has("bridge")) readPlace("bridge", bridge).catch(() => {});
  if (engine && !places.has("engine")) await readPlace("engine", engine);
}

/** The list now, for a route; null while the engine can't be read. In the long-running process: as
 * it keeps it, the engine read first where it hasn't been (it just started), worked out again with
 * the box's files as they are now (a project another process changed). In any other: as the
 * long-running process keeps it, while it runs; else read from the places now (the bridge's
 * sessions as last read where it doesn't answer), and kept. */
async function listNow(context: Pick<RouteContext, "readEngine" | "bridge">, signal?: AbortSignal): Promise<Kept | null> {
  if (keeping) {
    if (!places.has("engine") || (context.bridge() && !places.has("bridge"))) await readPlaces(context);
    if (!places.has("engine")) return null;
    // (With the box's files as they are now: a watch the system couldn't keep misses changes.)
    known = null;
    workOut();
    return latest;
  }
  const file = readList();
  if (file?.owner && file.owner !== process.pid && processRuns(file.owner, "kuvo-link")) return file;
  let engine: Target;
  try { engine = context.readEngine(); } catch { return null; }
  const bridge = context.bridge();
  const [engineSessions, engineRunning, bridgeSessions, bridgeRunning] = await Promise.all([
    readSessions(engine, signal), readRunning(engine, signal),
    bridge ? readSessions(bridge, signal) : Promise.resolve(null), bridge ? readRunning(bridge, signal) : Promise.resolve(null),
  ]);
  if (!engineSessions) return null;
  const sessions = [...engineSessions];
  const placeOf: Record<string, string> = Object.fromEntries(engineSessions.map(each => [each.id, "engine"]));
  if (bridgeSessions) for (const each of bridgeSessions) if (!(each.id in placeOf)) { sessions.push(each); placeOf[each.id] = "bridge"; }
  // (Those at work where it couldn't say: as last read.)
  const wasRunning = (name: string) => Object.entries(file?.sessions ?? {}).filter(([, entry]) => entry.place === name && entry.facts.running).map(([id]) => id);
  const running = new Set([...(engineRunning ?? wasRunning("engine")), ...(bridgeRunning ?? (bridge ? wasRunning("bridge") : []))]);
  const pending = bridge && !bridgeSessions ? ["bridge"] : [];
  return commit(withPending(sessions, placeOf, running, pending, file));
}

export async function* listRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, { message: "Only GET." });
  const since = new URLSearchParams(request.path.split("?")[1] ?? "").get("since");
  const list = await listNow(context, signal ?? undefined);
  if (!list) return yield* json(503, { message: "The engine isn’t running." });
  if (!match[1]) return yield* json(200, answerFrom(list, since));
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  // (Streamed only where it's kept: elsewhere its first line, as `box route` answers.)
  if (!keeping) return yield { body: Buffer.from(JSON.stringify(answerFrom(list, since)) + "\n") };
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
      const now = latest;
      if (!keeping || !now) return;
      const answer = answerFrom(now, at);
      // (Nothing changed since: no line, but the first.)
      if (first || answer.full || at !== answer.at) yield { body: Buffer.from(JSON.stringify(answer) + "\n") };
      first = false;
      at = answer.at;
      if (dirty) continue;
      // A minute at most between looks: worked out again then, with the box's files as they are.
      const woke = await new Promise<boolean>(done => {
        const timer = setTimeout(() => done(false), 60_000);
        wake = () => { clearTimeout(timer); done(true); };
      });
      wake = null;
      if (!woke) { known = null; workOut(); }
    }
  } finally {
    listFollowers.delete(told);
  }
}
