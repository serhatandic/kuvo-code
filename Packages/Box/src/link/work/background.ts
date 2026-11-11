// What still runs for a session once its own turn is over (PROTOCOL.md, "Work › Background work"): a
// command it left running, a subagent it sent off, or another task its agent keeps going. One fact,
// worked out here and kept in `run/work/background.json`, for each place a session runs (its engine,
// the coding agents' bridge), read by what a lead hears (work/wakes.ts), by a bot's work and by every
// client (`kuvo/work/background`). Stopping one of a bot's or a lead's sessions ends all of that, and
// its wake-ups; `run/work/stopped.json` says which were stopped, so nothing comes of them until
// someone writes to them again.
//
// The engine lists its commands a folder at a time, and asking about a folder starts that folder's
// tools there, so only folders that are at work are asked about: those its events name, a session's
// that just ran, and those of the last hour as the box starts (which have them running anyway). Its
// events say when to look again; what's found is what the engine says then, so an event missed (the
// box restarting, the stream dropping) is put right by the next look.
//
// Platform: only the engine's and the bridge's APIs, and a process group's signal: the same on macOS
// and Linux.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { BackgroundList } from "../../shared/routes/work";
import { endShellJob, type ShellJob } from "../areas/engine";
import { wakesChanged } from "../areas/wakes";
import { call } from "../engine/client";
import { stopSession } from "../engine/queue";
import { isHiddenRun, type EngineSession } from "../engine/sessions";
import { locked, writePrivate } from "../files";
import { SESSION_WAKES } from "../home";
import { noteWorkChanged, WORK_FOLDER } from "./changes";
import { workingNow, worksFor } from "./tree";

export const WORK_BACKGROUND = path.join(WORK_FOLDER, "background.json");
export const WORK_STOPPED = path.join(WORK_FOLDER, "stopped.json");
const LOCK = path.join(WORK_FOLDER, ".background.lock");

/** How long a command or subagent that never ends counts as work, from when it started (ms): after
 * that its session no longer shows at work for it, though it may still run (a dev server), and a
 * finish that waited on it is told. */
export const AT_WORK_LIMIT = 6 * 3_600_000;
// As the box starts: the sessions updated this recently have their folders' tools running still.
const RECENT = 3_600_000;

export interface BackgroundCommand { id: string; command: string; started: number; folder?: string }
export interface BackgroundHelper { id: string; since: number }
/** What runs for a session besides its own turn. `tasks`: what else its agent keeps going. */
export interface BackgroundWork { commands: BackgroundCommand[]; subagents: BackgroundHelper[]; tasks: BackgroundHelper[] }

interface Kept { sessions: Record<string, BackgroundWork>; folders: string[] }
type KeptPlaces = Record<string, Kept>;

const readKept = (file: string): KeptPlaces => {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(kept) ? kept as KeptPlaces : {};
  } catch {
    return {};
  }
};

// What of `work` still counts at `now`; null for nothing.
function counting(work: BackgroundWork | undefined, now: number): BackgroundWork | null {
  if (!work) return null;
  const kept = {
    commands: (work.commands ?? []).filter(each => now - each.started < AT_WORK_LIMIT),
    subagents: (work.subagents ?? []).filter(each => now - each.since < AT_WORK_LIMIT),
    tasks: (work.tasks ?? []).filter(each => now - each.since < AT_WORK_LIMIT),
  };
  return kept.commands.length || kept.subagents.length || kept.tasks.length ? kept : null;
}

/** Those following it here, in this process: told at once of a change made here. */
export const backgroundFollowers = new Set<() => void>();

/** Every session here with something running besides its turn, as clients read it: how many of
 * each, and since when (ms). */
export function readBackground(file = WORK_BACKGROUND, now = Date.now()): BackgroundList["sessions"] {
  const sessions: BackgroundList["sessions"] = {};
  for (const place of Object.values(readKept(file))) {
    for (const [id, work] of Object.entries(place.sessions ?? {})) {
      const left = counting(work, now);
      if (!left) continue;
      const was = sessions[id];
      const since = Math.min(...left.commands.map(each => each.started), ...left.subagents.map(each => each.since), ...left.tasks.map(each => each.since));
      sessions[id] = {
        commands: (was?.commands ?? 0) + left.commands.length,
        subagents: (was?.subagents ?? 0) + left.subagents.length,
        tasks: (was?.tasks ?? 0) + left.tasks.length,
        since: Math.min(was?.since ?? since, since),
      };
    }
  }
  return sessions;
}

/** The sessions at work now on `targets`, their own turns and what they left running alike: what
 * every count of sessions at work goes by. */
export async function atWorkNow(targets: Target[], signal?: AbortSignal, file = WORK_BACKGROUND): Promise<Set<string>> {
  const working = await workingNow(targets, signal);
  for (const id of Object.keys(readBackground(file))) working.add(id);
  return working;
}

/** Whether any of `work` started at `at` (ms) or since. */
export const startedSince = (work: BackgroundWork, at: number) => [...work.commands.map(each => each.started), ...work.subagents.map(each => each.since), ...work.tasks.map(each => each.since)].some(started => started >= at);

const emptyKept = (): Kept => ({ sessions: {}, folders: [] });

function write(file: string, from: string, change: (kept: Kept) => Kept): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    locked(LOCK, () => {
      const all = readKept(file);
      all[from] = change(all[from] ?? emptyKept());
      writePrivate(file, JSON.stringify(all));
    });
  } catch {}
  for (const tell of backgroundFollowers) tell();
}

/** An event the watcher reads. */
export interface BackgroundEvent {
  type: string;
  location?: { directory?: string };
  data?: { sessionID?: string; id?: string; info?: Partial<ShellJob> & { cwd?: string } };
}

export interface BackgroundWatch {
  /** The folder's commands and what's at work looked at now: what `session` has running. */
  of: (session: string, folder?: string) => Promise<BackgroundWork | null>;
  /** What's known of it as of the last look. */
  known: (session: string) => BackgroundWork | null;
  /** Each event, looked at again if it says something changed; whether it was. */
  noted: (event: BackgroundEvent) => Promise<boolean>;
  /** Its source gone: what ran there went with it. */
  gone: () => void;
  /** Looks at what runs as it starts (again, if it couldn't then); done once it has. */
  start: () => Promise<void>;
}

/** Follows what runs in `source`, the place `from` ("engine" or "bridge"), keeping it as it is. */
/** `ranOut`: told after a look as something stops counting by its time (`AT_WORK_LIMIT`). */
export function backgroundWatcher(source: Target, from: string, { file = WORK_BACKGROUND, now = Date.now, schedule = setTimeout, signal, ranOut }: { file?: string; now?: () => number; schedule?: (run: () => Promise<void>, ms: number) => unknown; signal?: AbortSignal; ranOut?: () => unknown } = {}): BackgroundWatch {
  const kept = readKept(file)[from] ?? emptyKept();
  let sessions: Record<string, BackgroundWork> = kept.sessions ?? {};
  const folders = new Set(kept.folders ?? []);
  const commandsIn = new Map<string, ShellJob[]>();
  let helpers = new Map<string, BackgroundHelper[]>();
  const above = new Map<string, string>();
  const hidden = new Set<string>();

  // The session at the top of `id`, as far as its parents go; null for one that can't be read.
  const topOf = async (id: string): Promise<string | null> => {
    let at = id;
    for (let step = 0; step < 8; step++) {
      let parent = above.get(at);
      if (parent === undefined) {
        const data = await call(source, "GET", `/api/session/${encodeURIComponent(at)}`, undefined, signal).catch(() => null) as Partial<EngineSession> | null;
        if (!data?.id) return null;
        if (isHiddenRun(data)) hidden.add(at);
        parent = data.parentID ?? "";
        above.set(at, parent);
      }
      if (!parent) return at;
      at = parent;
    }
    return null;
  };

  const readEngine = async (looked: string[]): Promise<Record<string, BackgroundWork>> => {
    for (const folder of looked) {
      const listed = await call(source, "GET", "/api/shell", undefined, signal, folder).catch(() => null);
      if (!Array.isArray(listed)) continue;
      const running = listed.filter((job): job is ShellJob => isObject(job) && job.status === "running" && typeof job.id === "string");
      if (running.length) commandsIn.set(folder, running);
      else {
        commandsIn.delete(folder);
        folders.delete(folder);
      }
    }
    // (One that can't be read now keeps what it was found to have.)
    const active = await call(source, "GET", "/api/session/active", undefined, signal).catch(() => null);
    if (active !== null) {
      const ids = (Array.isArray(active) ? active : isObject(active) ? Object.keys(active) : []).filter((id): id is string => typeof id === "string");
      const found = new Map<string, BackgroundHelper[]>();
      for (const id of ids) {
        const top = await topOf(id);
        if (!top || top === id || hidden.has(id)) continue;
        // (Since it was first found: kept as the box starts again.)
        const since = sessions[top]?.subagents?.find(each => each.id === id)?.since ?? now();
        found.set(top, [...(found.get(top) ?? []), { id, since }]);
      }
      helpers = found;
    }
    const all: Record<string, BackgroundWork> = {};
    const of = (id: string) => (all[id] ??= { commands: [], subagents: [], tasks: [] });
    for (const [top, each] of helpers) of(top).subagents.push(...each);
    for (const [folder, jobs] of commandsIn) {
      for (const job of jobs) {
        const session = isObject(job.metadata) && typeof job.metadata.sessionID === "string" ? job.metadata.sessionID : null;
        const top = session ? await topOf(session) : null;
        if (top) of(top).commands.push({ id: job.id, command: String(job.command ?? ""), started: job.time?.started ?? now(), folder });
      }
    }
    return all;
  };

  const readBridge = async (): Promise<Record<string, BackgroundWork> | null> => {
    const answer = await call(source, "GET", "/api/session/background", undefined, signal).catch(() => null);
    return isObject(answer) ? answer as Record<string, BackgroundWork> : null;
  };

  // The next time something counted runs out, so its session stops showing at work then.
  let timed = false;
  const lookWhenOneRunsOut = () => {
    const times = Object.values(sessions).flatMap(work => [...work.commands.map(each => each.started), ...work.subagents.map(each => each.since), ...work.tasks.map(each => each.since)]).map(at => at + AT_WORK_LIMIT).filter(at => at > now());
    if (timed || !times.length || signal?.aborted) return;
    timed = true;
    const timer = schedule(async () => {
      timed = false;
      await look([]);
      if (!signal?.aborted && !ended) await ranOut?.();
    }, Math.min(...times) - now() + 1000);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  };

  // Clients read a bot's work again when one of its sessions starts or stops counting (running out
  // of its time too, so as of the last look, not as it would count now).
  let counted = new Set(Object.keys(sessions).filter(id => counting(sessions[id], now())));
  const tellBots = async (after: Record<string, BackgroundWork>) => {
    const counts = new Set(Object.keys(after).filter(id => counting(after[id], now())));
    const changed = [...counted, ...counts].filter(id => counted.has(id) !== counts.has(id));
    counted = counts;
    for (const id of new Set(changed)) {
      const data = await call(source, "GET", `/api/session/${encodeURIComponent(id)}`, undefined, signal).catch(() => null) as Partial<EngineSession> | null;
      const bot = worksFor(data)?.bot;
      if (bot) noteWorkChanged(bot);
    }
  };

  let lookedLast = "";
  // Its source gone: a look under way says nothing of it after that.
  let ended = false;
  const lookNow = async (looked: string[]) => {
    if (signal?.aborted || ended) return;
    const found = from === "bridge" ? await readBridge() : await readEngine(looked);
    if (!found || signal?.aborted || ended) return;
    sessions = found;
    const line = JSON.stringify([found, [...folders]]);
    if (line !== lookedLast) {
      lookedLast = line;
      write(file, from, () => ({ sessions: found, folders: [...folders] }));
    }
    await tellBots(found);
    lookWhenOneRunsOut();
  };

  // One at a time, in order: each goes by what the engine says then.
  let going: Promise<void> = Promise.resolve();
  const look = (looked: string[]) => (going = going.then(() => lookNow(looked)).catch(() => {}));

  let started: Promise<void> | null = null;
  const start = () => (started ??= (async () => {
    const page = await call(source, "GET", "/api/session?limit=50&order=desc&parentID=null", undefined, signal).catch(() => null);
    if (page === null) started = null;
    for (const each of (Array.isArray(page) ? page : []) as Partial<EngineSession>[]) {
      const folder = each?.location?.directory ?? each?.directory;
      if (from !== "bridge" && folder && (each?.time?.updated ?? 0) > now() - RECENT) folders.add(folder);
    }
    await look([...folders]);
  })());

  return {
    known: id => counting(sessions[id], now()),
    of: async (id, folder) => {
      // (Its own folder, and those its commands were found in.)
      const looked = from === "bridge" ? [] : [...new Set([folder, ...(sessions[id]?.commands ?? []).map(each => each.folder)].filter((each): each is string => Boolean(each)))];
      for (const each of looked) folders.add(each);
      await look(looked);
      return counting(sessions[id], now());
    },
    noted: async event => {
      const folder = event.location?.directory ?? event.data?.info?.cwd;
      if (event.type === "shell.created" || event.type === "shell.exited" || event.type === "shell.deleted") {
        if (folder && from !== "bridge") folders.add(folder);
        await look(folder && from !== "bridge" ? [folder] : [...folders]);
        return true;
      }
      if (event.type !== "session.background.updated" && event.type !== "session.deleted" && !event.type.startsWith("session.execution.")) return false;
      await look([]);
      return true;
    },
    gone: () => {
      ended = true;
      sessions = {};
      lookedLast = "";
      // (Nothing to say of a place that isn't running: looked at often, until it does.)
      if (Object.keys(readKept(file)[from]?.sessions ?? {}).length) write(file, from, kept => ({ sessions: {}, folders: kept.folders }));
    },
    start,
  };
}

// MARK: Stopped

/** The sessions stopped and not written to since, each with when it was stopped (ms). */
export function readStopped(file = WORK_STOPPED): Record<string, number> {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(kept) ? Object.fromEntries(Object.entries(kept).filter(([, at]) => typeof at === "number")) as Record<string, number> : {};
  } catch {
    return {};
  }
}

function changeStopped(change: (stopped: Record<string, number>) => void, file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    locked(`${LOCK}-stopped`, () => {
      const stopped = readStopped(file);
      change(stopped);
      const ids = Object.keys(stopped);
      for (const id of ids.slice(0, Math.max(0, ids.length - 400))) delete stopped[id];
      writePrivate(file, JSON.stringify(stopped));
    });
  } catch {}
}

/** `session` was stopped, now: nothing comes of it until someone writes to it. */
export function noteStopped(session: string, file = WORK_STOPPED, at = Date.now()): void {
  changeStopped(stopped => {
    delete stopped[session];
    stopped[session] = at;
  }, file);
}

/** `session` was written to since it was stopped: it's at work again. */
export function forgetStopped(session: string, file = WORK_STOPPED): void {
  if (readStopped(file)[session] !== undefined) changeStopped(stopped => { delete stopped[session]; }, file);
}

/** Whether a session has wake-ups or watches of its own waiting. */
export function hasWakeUps(session: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(session)) return false;
  return ["wakes", "watches"].some(kind => {
    try {
      return fs.readdirSync(path.join(SESSION_WAKES, session, kind)).length > 0;
    } catch {
      return false;
    }
  });
}

// The wake-ups and watches a session keeps of its own (not a bot's, whose are its bot's).
function endWakeUps(session: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(session)) return;
  const folder = path.join(SESSION_WAKES, session);
  for (const kind of ["wakes", "watches"]) fs.rmSync(path.join(folder, kind), { recursive: true, force: true });
  wakesChanged();
}

// What it left running, ended: a command with its process group's signal, as Stop on its row does
// (a coding agent's has none: its agent ends it), and its subagents.
async function endBackground(target: Target, session: string, file = WORK_BACKGROUND): Promise<void> {
  const answered = await call(target, "DELETE", `/api/session/${encodeURIComponent(session)}/background`).then(() => true, () => false);
  if (answered) return;
  const work = readKept(file).engine?.sessions?.[session];
  for (const command of work?.commands ?? []) {
    // (The engine knows a command only in its own folder.)
    const job = await call(target, "GET", `/api/shell/${encodeURIComponent(command.id)}`, undefined, undefined, command.folder).catch(() => null) as ShellJob | null;
    if (job?.status === "running") await endShellJob(job, `http://127.0.0.1:${target.port}/api/shell/${encodeURIComponent(job.id)}`, { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(command.folder ? { "x-opencode-directory": encodeURIComponent(command.folder) } : {}) }).catch(() => {});
  }
  for (const helper of work?.subagents ?? []) await call(target, "POST", `/api/session/${encodeURIComponent(helper.id)}/interrupt`).catch(() => {});
}

/**
 * Stop for a session someone started (a bot's work, a lead's): the turn under way (as `stopSession`,
 * `holds` as there), what it left running, and its wake-ups and watches, so nothing comes of it until
 * it's written to again. Noted first: the end of a command stopped here must not read as news.
 */
export async function stopWork(target: Target, session: string, holds = false): ReturnType<typeof stopSession> {
  noteStopped(session);
  endWakeUps(session);
  const state = await stopSession(target, session, holds);
  await endBackground(target, session).catch(() => {});
  return state;
}

