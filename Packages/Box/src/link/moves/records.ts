// Moves under way on this box, as each side keeps them (PROTOCOL.md, `kuvo/moves`): one file each in
// `run/moves`, so a move cut short by a restart finishes or is taken back; who's told as they change;
// and the conversations that don't live here, or moved away from here lately.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { Move, MoveKind, MoveStage } from "../../shared/routes/moves";
import { writePrivate } from "../files";
import { RUN } from "../home";

export const MOVES = path.join(RUN, "moves");
// Conversations moved away from here, by where they live now, for two days.
const MOVED_FILE = path.join(MOVES, "moved.json");
export const MOVED_FOR = 2 * 24 * 3600_000;

/** A move as this box keeps it: what clients see of it (`Move`), and what it needs to carry on. On
 * the box it's leaving (`from`): whether it was paused before, its folder here, and the bundle's
 * hash and size; tries made; when each step was last sent. On the box it's going to (`to`): the
 * folder its copy went in, and the parts of the bundle that came. */
export interface MoveRecord extends Move {
  /** The other box's key. */
  peer: string;
  /** The Work Queue's items it carries, as they were packed (`updated.at`, by id): forgotten here
   * once it's over, unless changed since. */
  workQueue?: Record<string, number>;
  wasPaused: boolean;
  folder?: string;
  hash?: string;
  /** Where it is between the boxes: the source waits for `ready`, `arrived`, `switched`, `dropped`. */
  step?: "check" | "offer" | "parts" | "arrive" | "switch" | "drop" | "done";
  tries: number;
  /** The box it goes to: all its parts came, and it's being (or was) put in place; parts that come
   * after are ignored. */
  complete?: boolean;
  /** What its folder's `paused` said before it moved (your own pause), to put back. */
  pausedAs?: string;
  /** The box it goes to: its folder was put in place by this move (and goes if it's taken back). */
  placed?: boolean;
  /** A group chat's bots, which the box it goes to checks it has. */
  members?: string[];
  /** Offered to the other box at least once: a copy may be there, to drop if it's taken back. */
  offered?: boolean;
  sentAt?: number;
  /** The box it leaves: when an offer or an ask whether it arrived was last sent again (quiet is
   * counted from `sentAt`, the step's first, and what was last heard). */
  againAt?: number;
  /** The box it leaves: its conversation kept in its folder as the original goes (a try at that cut
   * short doesn't keep it again, with less of it). */
  kept?: boolean;
  /** The box it leaves: tries at letting its original go that its engine, up, didn't take. */
  finishTries?: number;
  /** The box it goes to: its conversations whose queue the move brought going on where it came
   * from (not paused), to go on here once it's switched to. */
  queuesGoOn?: string[];
  /** The box it goes to: its copy is being let go of (it won't be switched to), which is tried again
   * until all of it's gone (its engine or group chats were down). */
  dropping?: boolean;
  /** The box it leaves: since when it's been getting it ready to go (held, settled, packed). */
  holdSince?: number;
  /** The box it goes to: since when it's been setting its copy up. */
  setUpSince?: number;
  /** The box it goes to: when its copy was set up (and said so), to wait for the switch from. */
  setUpAt?: number;
  /** Since when the box it leaves has asked the other to switch to its copy. */
  switchSince?: number;
  /** Since when the box it leaves has asked the other to let its copy go (taken back); on the box it
   * goes to, since when its copy's been let go of. */
  dropSince?: number;
  started: number;
  /** It talks with a coding agent: its conversations are on the agents bridge, not the engine, and
   * each agent's own go with them (`carry.ts`). */
  lane?: boolean;
  /** The box it leaves: where each agent kept what it carried, to clear later (`left.ts`). */
  leftOf?: unknown[];
  /** The box it goes to: the hash of what's in place, said back as it arrives. */
  digest?: string;
  /** The box it goes to: where it was, to tell it as it's switched to. */
  was?: { place: string; folder?: string };
  /** The model it talks with, for the box it goes to to check (`check`). */
  model?: { providerID: string; id: string };
  /** What the box it goes to said it does differently there (another account of its coding agent). */
  note?: string;
  /** Taken back, with why (said to whoever asked). */
  failed?: string;
  /** The status a failure answers: 409 (it can't, now) or 503 (the other computer can't be reached). */
  failedStatus?: number;
}

const fileOf = (id: string) => path.join(MOVES, `${id}.json`);
export const bundleOf = (id: string) => path.join(MOVES, id);

const fits = (record: unknown): record is MoveRecord => isObject(record) && typeof record.id === "string" && typeof record.thing === "string"
  && typeof record.peer === "string" && (record.role === "from" || record.role === "to") && Array.isArray(record.sessions);

export function readMoves(): MoveRecord[] {
  let names: string[] = [];
  try { names = fs.readdirSync(MOVES).filter(name => /^mov_[A-Za-z0-9]+\.json$/.test(name)); } catch {}
  const records: MoveRecord[] = [];
  for (const name of names) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(MOVES, name), "utf8"));
      if (fits(record)) records.push(record);
    } catch {}
  }
  return records.sort((one, other) => one.started - other.started);
}

export const readMove = (id: string): MoveRecord | null => readMoves().find(record => record.id === id) ?? null;

/** The moves under way: not one taken back, whose copy there is still being let go (`failed`):
 * what it moved is free here again. */
export const liveMoves = (records = readMoves()): MoveRecord[] => records.filter(record => !record.failed);

/** The moves under way that clients see: not a copy here being let go of (the move was taken back,
 * and goes on where it came from), whose conversations alone are left out (`away`) until it's gone. */
export const listedMoves = (records = liveMoves()): MoveRecord[] => records.filter(record => !(record.role === "to" && record.dropping));

/** The move of `thing` under way here, either way. */
export const moveOf = (thing: string): MoveRecord | null => liveMoves().find(record => record.thing === thing) ?? null;

// Told each time a move changes (`kuvo/moves/events`).
export const moveFollowers = new Set<() => void>();
export function movesChanged(): void {
  for (const follower of [...moveFollowers]) try { follower(); } catch {}
}

export function saveMove(record: MoveRecord): void {
  writePrivate(fileOf(record.id), JSON.stringify(record));
  movesChanged();
}

/** Gone, with what came of its bundle. */
export function forgetMove(id: string): void {
  try { fs.rmSync(fileOf(id), { force: true }); } catch {}
  try { fs.rmSync(bundleOf(id), { recursive: true, force: true }); } catch {}
  movesChanged();
}

export function changeMove(id: string, change: (record: MoveRecord) => void): MoveRecord | null {
  const record = readMove(id);
  if (!record) return null;
  change(record);
  saveMove(record);
  return record;
}

/** What clients see of it. */
export function shownMove(record: MoveRecord): Move {
  const { id, kind, thing, name, from, to, role, stage, sessions, sent, size } = record;
  return { id, kind, thing, name, from, to, role, stage, sessions, ...(sent !== undefined ? { sent } : {}), ...(size !== undefined ? { size } : {}), ...(waitingFor.has(id) ? { waiting: true } : {}) };
}

/** The moves here whose other computer has gone quiet about them a while (`keepMoving` keeps
 * it): shown as waiting for it. In memory only: a box started again waits a while before it says so. */
export const waitingFor = new Set<string>();

/** The conversations this box's engine has that don't live here: a copy that came, until the box it
 * left switches to it; an original that's switched away, until it's gone. */
export function awaySessions(records = liveMoves()): string[] {
  const away = new Set<string>();
  for (const record of records) {
    const switched = record.stage === "switching" || record.stage === "finishing";
    if ((record.role === "to" && !switched) || (record.role === "from" && switched)) for (const session of record.sessions) away.add(session);
  }
  return [...away];
}

/** The conversations held while they move (nothing reaches them: prompts wait, letters come
 * again later), and the bots and group chats. */
export function frozen(records = liveMoves()): Set<string> {
  // (Not while the box it goes to is only asked whether it can run it: nothing's held yet.)
  return new Set(records.filter(record => record.step !== "check").flatMap(record => [record.thing, ...record.sessions]));
}

/** A conversation moved away from here in the last two days, and where it lives now (a box's key). */
export interface MovedAway {
  session: string;
  key: string;
  at: number;
}

export function movedAway(now = Date.now()): MovedAway[] {
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(MOVED_FILE, "utf8"));
    if (!Array.isArray(kept)) return [];
    return kept.filter((each): each is MovedAway => isObject(each) && typeof each.session === "string" && typeof each.key === "string" && typeof each.at === "number" && now - each.at < MOVED_FOR);
  } catch {
    return [];
  }
}

export function noteMovedAway(sessions: readonly string[], key: string, now = Date.now()): void {
  const kept = movedAway(now).filter(each => !sessions.includes(each.session));
  writePrivate(MOVED_FILE, JSON.stringify([...kept, ...sessions.map(session => ({ session, key, at: now }))]));
  // (Clients leave them out from here on: `kuvo/moves`' `moved`.)
  movesChanged();
}

/** Moved here again (back from where it went): no longer away. */
export function forgetMovedAway(sessions: readonly string[], now = Date.now()): void {
  const kept = movedAway(now);
  if (!kept.some(each => sessions.includes(each.session))) return;
  writePrivate(MOVED_FILE, JSON.stringify(kept.filter(each => !sessions.includes(each.session))));
  movesChanged();
}

export type { Move, MoveKind, MoveStage };

// How each move that came here ended (`switched` or `dropped`): a step about it sent again later is
// answered as it ended, never taken for one this box doesn't know. One dropped, for a week; one
// switched, for a year: the box it came from, asleep all that while, still hears it switched (and
// lets its original go) rather than `dropped` (and keeps it, a second copy).
const ENDED_FILE = path.join(MOVES, "ended.json");
const ENDED_FOR = { dropped: 7 * 24 * 3600_000, switched: 365 * 24 * 3600_000 };
const keptFor = (one: { as?: unknown; at?: unknown; sessions?: unknown } | undefined, now: number): boolean =>
  typeof one?.at === "number" && (one.as === "switched" || one.as === "dropped") && now - one.at < ENDED_FOR[one.as];

export function endedAs(id: string, now = Date.now()): "switched" | "dropped" | null {
  try {
    const kept = JSON.parse(fs.readFileSync(ENDED_FILE, "utf8")) as Record<string, { as?: unknown; at?: unknown }>;
    const one = kept?.[id];
    return keptFor(one, now) ? one!.as as "switched" | "dropped" : null;
  } catch {
    return null;
  }
}

/** When a move that came here was switched to, or let go of. */
export function endedAt(id: string, now = Date.now()): number | null {
  try {
    const kept = JSON.parse(fs.readFileSync(ENDED_FILE, "utf8")) as Record<string, { as?: unknown; at?: unknown }>;
    const one = kept?.[id];
    return keptFor(one, now) ? one!.at as number : null;
  } catch {
    return null;
  }
}

/** The newest message of a copy switched to here, as it came. */
export function endedLast(id: string, now = Date.now()): string | undefined {
  try {
    const one = JSON.parse(fs.readFileSync(ENDED_FILE, "utf8"))?.[id];
    return keptFor(one, now) && typeof one.last === "string" ? one.last : undefined;
  } catch {
    return undefined;
  }
}

/** `sessions`: those of a copy here let go of, which live on where they came from. `last`: the newest
 * message of one switched to, as it came (what's after it ran here, whatever the clocks say). */
export function noteEnded(id: string, as: "switched" | "dropped", now = Date.now(), sessions: readonly string[] = [], last?: string): void {
  let kept: Record<string, { as: string; at: number; sessions?: string[]; last?: string }> = {};
  try { kept = JSON.parse(fs.readFileSync(ENDED_FILE, "utf8")) ?? {}; } catch {}
  for (const [other, one] of Object.entries(kept)) if (!keptFor(one, now)) delete kept[other];
  kept[id] = { as, at: now, ...(sessions.length ? { sessions: [...sessions] } : {}), ...(last ? { last } : {}) };
  writePrivate(ENDED_FILE, JSON.stringify(kept));
}

/** The conversations of copies here let go of lately (their moves taken back): deleted here, they
 * live on on the computer they came from. */
export function droppedHere(now = Date.now()): string[] {
  try {
    const kept = JSON.parse(fs.readFileSync(ENDED_FILE, "utf8")) as Record<string, { as?: unknown; at?: unknown; sessions?: unknown }>;
    return Object.values(kept ?? {}).filter(one => keptFor(one, now) && one.as === "dropped" && Array.isArray(one.sessions))
      .flatMap(one => (one.sessions as unknown[]).filter((each): each is string => typeof each === "string"));
  } catch {
    return [];
  }
}
