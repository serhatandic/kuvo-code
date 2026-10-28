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
  wasPaused: boolean;
  folder?: string;
  hash?: string;
  /** Where it is between the boxes: the source waits for `ready`, `arrived`, `switched`, `dropped`. */
  step?: "offer" | "parts" | "arrive" | "switch" | "drop" | "done";
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
  /** Since when the box it leaves has asked the other to let its copy go (taken back). */
  dropSince?: number;
  started: number;
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
  return { id, kind, thing, name, from, to, role, stage, sessions, ...(sent !== undefined ? { sent } : {}), ...(size !== undefined ? { size } : {}) };
}

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
  return new Set(records.flatMap(record => [record.thing, ...record.sessions]));
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
}

/** Moved here again (back from where it went): no longer away. */
export function forgetMovedAway(sessions: readonly string[], now = Date.now()): void {
  const kept = movedAway(now);
  if (!kept.some(each => sessions.includes(each.session))) return;
  writePrivate(MOVED_FILE, JSON.stringify(kept.filter(each => !sessions.includes(each.session))));
}

export type { Move, MoveKind, MoveStage };

// How each move that came here ended, for a week (`switched` or `dropped`): a step about it sent
// again later is answered as it ended, never taken for one this box doesn't know.
const ENDED_FILE = path.join(MOVES, "ended.json");
const ENDED_FOR = 7 * 24 * 3600_000;

export function endedAs(id: string, now = Date.now()): "switched" | "dropped" | null {
  try {
    const kept = JSON.parse(fs.readFileSync(ENDED_FILE, "utf8")) as Record<string, { as?: unknown; at?: unknown }>;
    const one = kept?.[id];
    if (!one || typeof one.at !== "number" || now - one.at > ENDED_FOR) return null;
    return one.as === "switched" || one.as === "dropped" ? one.as : null;
  } catch {
    return null;
  }
}

export function noteEnded(id: string, as: "switched" | "dropped", now = Date.now()): void {
  let kept: Record<string, { as: string; at: number }> = {};
  try { kept = JSON.parse(fs.readFileSync(ENDED_FILE, "utf8")) ?? {}; } catch {}
  for (const [other, one] of Object.entries(kept)) if (!(typeof one?.at === "number" && now - one.at < ENDED_FOR)) delete kept[other];
  kept[id] = { as, at: now };
  writePrivate(ENDED_FILE, JSON.stringify(kept));
}
