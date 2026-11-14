// Moves on your other computers (PROTOCOL.md, "Peers", `moving`, and `kuvo/moves`' `elsewhere`): a
// move between two machines is seen on every box, so a client that follows one box (the Mac follows
// its own; it reads a machine's only now and then) sees it too. Each box tells its peers what it
// moves as that changes, again each minute while it moves (a peer that started again, or missed it:
// the relay keeps nothing), and once that it's over. Each keeps what its peers said in
// `run/moves/elsewhere.json` (so a `box route` process answers it too), until a peer says it's over
// or goes quiet a few minutes (gone mid-move). Mail from one peer comes in the order it was sent
// (one relay connection), so the latest that came is what it says now, whatever its clock reads.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { Move, MovesElsewhere } from "../../shared/routes/moves";
import { plainName } from "../../shared/text";
import { writePrivate } from "../files";
import { mailFor, ownKey, peersOf } from "../peers/known";
import type { MailSender, Peer } from "../peers/known";
import type { LinkHost } from "../relay/host";
import { readLink } from "../state";
import { listedMoves, MOVES, movesChanged, shownMove } from "./records";

const FILE = path.join(MOVES, "elsewhere.json");
/** The moves said, and the conversations of each, at most (so the mail fits). */
const MOST_MOVES = 20;
const MOST_SESSIONS = 50;
/** Said again this often while anything moves; a peer's word kept this long after it last said it. */
const AGAIN = 60_000;
const KEPT = 3 * 60_000;

const KINDS = new Set(["bot", "chat", "group"]);
const STAGES = new Set(["holding", "copying", "switching", "finishing"]);

/** What a peer said, as kept: when it came (`at`, this box's clock), and its moves. */
interface Said {
  at: number;
  moves: Move[];
}

const sent = (moves: Move[]): Move[] => moves.slice(0, MOST_MOVES).map(move => ({ ...move, sessions: move.sessions.slice(0, MOST_SESSIONS) }));

// ---- Telling ----

// What was last said (each move's ID, stage and whether it waits for its other computer: how much of
// its copy went isn't news), and when.
let saidLast: string | null = null;
let saidAt = 0;

/** This box's moves told to its peers by the relay connection that's up (`host`), at each of its
 * looks (`keepMoving`): when they changed (a move began, went a stage on or ended), or a minute after
 * they were last told while any are under way. A box that has had nothing moving says nothing. One
 * the connection took for none of them (it's closing, or not welcomed yet): said again next look. */
export function tellMoving(host: Pick<LinkHost, "send"> | null | undefined, now = Date.now()): void {
  const moves = sent(listedMoves().map(shownMove));
  const these = JSON.stringify(moves.map(({ id, stage, waiting }) => [id, stage, waiting === true]));
  if (these === saidLast && (!moves.length || now - saidAt < AGAIN)) return;
  if (saidLast === null && !moves.length) {
    saidLast = these;
    return;
  }
  const link = readLink();
  const peers = peersOf(link);
  let told = !peers.length;
  for (const peer of peers) {
    const bytes = link && host && mailFor(peer, { moving: { moves }, at: now }, link);
    try { if (bytes && host?.send(bytes) === true) told = true; } catch {}
  }
  if (!told) return;
  saidLast = these;
  saidAt = now;
}

/** A peer just connected (it asks for agents): what moves here is told again at the next look. */
export function tellMovingAgain(): void {
  saidAt = 0;
}

// ---- What peers said ----

function readSaid(): Record<string, Said> {
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return isObject(kept) ? kept as Record<string, Said> : {};
  } catch {
    return {};
  }
}

const fresh = (one: unknown, now: number): one is Said => isObject(one) && typeof one.at === "number" && Array.isArray(one.moves) && now - one.at < KEPT;

const short = (text: string, most: number) => text.slice(0, most);

/** A move as a peer says it, as clients see it; null for what isn't one. */
function takenMove(given: unknown): Move | null {
  if (!isObject(given)) return null;
  const { id, kind, thing, name, from, to, role, stage, sessions, sent, size, waiting } = given;
  if (typeof id !== "string" || typeof thing !== "string" || typeof name !== "string" || typeof from !== "string" || typeof to !== "string") return null;
  if (!KINDS.has(kind as string) || (role !== "from" && role !== "to") || !STAGES.has(stage as string) || !Array.isArray(sessions)) return null;
  return {
    id: short(id, 100), kind: kind as Move["kind"], thing: short(thing, 200), name: short(plainName(name), 200), from: short(from, 100), to: short(to, 100), role, stage: stage as Move["stage"],
    sessions: sessions.filter((session): session is string => typeof session === "string").slice(0, MOST_SESSIONS).map(session => short(session, 100)),
    ...(typeof sent === "number" && Number.isFinite(sent) ? { sent } : {}),
    ...(typeof size === "number" && Number.isFinite(size) ? { size } : {}),
    ...(waiting === true ? { waiting } : {}),
  };
}

/** A peer's `moving` mail: kept, in place of what it said before (none: it's over). Only from one
 * of this box's peers. */
export function takeMoving(sender: MailSender, given: unknown, now = Date.now()): void {
  if (!isObject(given) || !Array.isArray(given.moves)) return;
  if (!peersOf(readLink()).some(peer => peer.key === sender.key)) return;
  const kept = readSaid();
  for (const [key, one] of Object.entries(kept)) if (!fresh(one, now)) delete kept[key];
  const moves = given.moves.slice(0, MOST_MOVES).map(takenMove).filter((move): move is Move => move !== null);
  if (moves.length) kept[sender.key] = { at: now, moves };
  else delete kept[sender.key];
  try { writePrivate(FILE, JSON.stringify(kept)); } catch {}
  movesChanged();
}

/** What a peer quiet a few minutes said, forgotten at a look (`keepMoving`), and clients told: its
 * moves no longer show, and a client reading that peer for them stops. */
export function forgetQuiet(now = Date.now()): void {
  const kept = readSaid();
  const quiet = Object.keys(kept).filter(key => !fresh(kept[key], now));
  if (!quiet.length) return;
  for (const key of quiet) delete kept[key];
  try { writePrivate(FILE, JSON.stringify(kept)); } catch {}
  movesChanged();
}

/** The moves your other computers said they have under way between them (`peers`: this box's now),
 * by box. One to or from this box is its own to show (`kuvo/moves`' `moves`, as it hears of it), so
 * one that ended here never shows as moving while the other's word that it's over is on its way. */
export function movesElsewhere(peers: Pick<Peer, "key">[] = peersOf(readLink()), now = Date.now()): MovesElsewhere[] {
  const link = readLink();
  const own = link ? ownKey(link) : null;
  const keys = new Set(peers.map(peer => peer.key));
  return Object.entries(readSaid())
    .filter((entry): entry is [string, Said] => keys.has(entry[0]) && fresh(entry[1], now))
    .map(([box, one]) => ({ box, moves: one.moves.filter(move => move.from !== own && move.to !== own) }))
    .filter(one => one.moves.length > 0)
    .sort((one, other) => one.box.localeCompare(other.box));
}
