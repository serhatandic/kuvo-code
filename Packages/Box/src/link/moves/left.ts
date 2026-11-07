// What a move left on the computer it came from (PROTOCOL.md, `kuvo/moves`): nothing there can run or
// reach it, and it's kept only as the way back. Once the conversation has run on the computer it went
// to, and `KEEP_LEFT` has gone by since, this box removes it by itself: its folder in this box's trash,
// and each coding agent's own files for it. Moved back before then, what's here is put to use again.
// A session it started isn't part of it: those stay on this computer for good, and nothing here
// touches them. Noted in `run/moves/left.json`, one entry each.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { MoveKind } from "../../shared/routes/moves";
import { writePrivate } from "../files";
import { K } from "../home";
import { MOVES } from "./records";

/** How long what a move left stays, from the first run on the computer it went to. */
export const KEEP_LEFT = 7 * 24 * 3600_000;
/** How often the computer it went to is asked whether it has run there. */
export const ASK_LEFT = 3600_000;

export interface LeftEntry {
  id: string;
  thing: string;
  kind: MoveKind;
  /** The box it went to. */
  to: string;
  at: number;
  /** Its own conversations, which went with it. */
  sessions: string[];
  /** Whether those talked with a coding agent. */
  lane?: boolean;
  /** Its folder, in this box's trash (one a Mac gave the Finder's Trash is yours). */
  trash?: string;
  /** Where each agent keeps its own files for it, as the agents bridge said (`carry.ts`). */
  left?: unknown[];
  /** When it first ran there, as that computer says. */
  ranAt?: number;
  /** A bot's own keys, which couldn't be taken away here as it went (your Keychain out of reach):
   * tried again until they're gone. */
  keys?: boolean;
}

const FILE = path.join(MOVES, "left.json");

const fits = (one: unknown): one is LeftEntry => isObject(one) && typeof one.id === "string" && typeof one.thing === "string" && typeof one.to === "string" && typeof one.at === "number" && Array.isArray(one.sessions);

export function readLeft(): LeftEntry[] {
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(kept) ? kept.filter(fits) : [];
  } catch {
    return [];
  }
}

function writeLeft(entries: LeftEntry[]): void {
  if (entries.length) writePrivate(FILE, JSON.stringify(entries));
  else fs.rmSync(FILE, { force: true });
}

/** What a move that's over left here (nothing noted when it left nothing). */
export function noteLeft(entry: LeftEntry): void {
  if (!entry.trash && !entry.left?.length && !entry.keys) return;
  writeLeft([...readLeft().filter(each => each.id !== entry.id), entry]);
}

export function forgetLeft(id: string): void {
  const entries = readLeft();
  if (entries.some(each => each.id === id)) writeLeft(entries.filter(each => each.id !== id));
}

/** Its keys gone here at last. */
export function keysGone(id: string): void {
  const entries = readLeft();
  const entry = entries.find(each => each.id === id);
  if (!entry?.keys) return;
  delete entry.keys;
  writeLeft(entries.filter(each => each.id !== id || each.trash || each.left?.length));
}

/** It first ran there at `at`, as the computer it went to says (only that one's word counts). */
export function noteRan(id: string, from: string, at: number): void {
  const entries = readLeft();
  const entry = entries.find(each => each.id === id && each.to === from);
  if (!entry || entry.ranAt !== undefined) return;
  // (Never from before it went there, however that computer's clock is set.)
  entry.ranAt = Math.max(at, entry.at);
  writeLeft(entries);
}

/** The folder in this box's trash, gone (never anything else: its path is checked to be there). */
export function removeTrashed(trash: string | undefined): void {
  if (!trash) return;
  const root = path.join(K, "trash") + path.sep;
  if (!path.normalize(trash).startsWith(root) || path.normalize(trash) !== trash) return;
  fs.rmSync(trash, { recursive: true, force: true });
  // The folder for that moment, once it's empty.
  try { fs.rmdirSync(path.dirname(trash)); } catch {}
}
