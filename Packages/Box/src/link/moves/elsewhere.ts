// Moves on your other computers (PROTOCOL.md, "Peers", `moving`, and `kuvo/moves`' `elsewhere`): a
// move between two machines is seen on every box, so a client that follows one box (the Mac follows
// its own; it reads a machine's only now and then) sees it too. Each box tells its peers what it
// moves as that changes, again each minute while it moves (a peer that started again, or missed it:
// the relay keeps nothing), and once that it's over. Each keeps what its peers said in
// `run/moves/elsewhere.json` (so a `box route` process answers it too), until a peer says it's over
// or goes quiet a few minutes (gone mid-move).

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { Move, MovesElsewhere } from "../../shared/routes/moves";
import { plainName } from "../../shared/text";
import { writePrivate } from "../files";
import { mailFor, peersOf } from "../peers/known";
import type { MailSender, Peer } from "../peers/known";
import type { LinkHost } from "../relay/host";
import { readLink } from "../state";
import { listedMoves, MOVES, moveFollowers, movesChanged, shownMove } from "./records";

const FILE = path.join(MOVES, "elsewhere.json");
/** The moves said, and the conversations of each, at most (so the mail fits). */
const MOST_MOVES = 20;
const MOST_SESSIONS = 50;
/** Said again this often while anything moves; a peer's word kept this long after it last said it. */
const AGAIN = 60_000;
const KEPT = 3 * 60_000;

const KINDS = new Set(["bot", "chat", "group"]);
const STAGES = new Set(["holding", "copying", "switching", "finishing"]);

/** What a peer said, as kept: when it came (`at`, this box's clock), the mail's own `at` (`said`,
 * the peer's: one older than the last that came is late, and changes nothing), and its moves (none:
 * it's over). */
interface Said {
  at: number;
  said: number;
  moves: Move[];
}

const sent = (moves: Move[]): Move[] => moves.slice(0, MOST_MOVES).map(move => ({ ...move, sessions: move.sessions.slice(0, MOST_SESSIONS) }));

// ---- Telling ----

// The relay connection that's up, in the process that moves things (`watchMoving`); what was last
// said (each move's ID and stage: how much of its copy went isn't news), and when.
let hostOf: () => Pick<LinkHost, "send"> | null | undefined = () => null;
let saidLast: string | null = null;
let saidAt = 0;

// Where it goes instead of the relay: a test's.
let sendInstead: ((peer: string, moving: { moves: Move[] }) => boolean) | null = null;
export function sendMovingWith(send: typeof sendInstead): void {
  sendInstead = send;
}

function send(peer: Peer, moving: { moves: Move[] }, now: number): boolean {
  if (sendInstead) return sendInstead(peer.key, moving);
  const link = readLink();
  const host = hostOf();
  const bytes = link && host && mailFor(peer, { moving, at: now }, link);
  if (!bytes) return false;
  try {
    host.send(bytes);
    return true;
  } catch {
    return false;
  }
}

/** This box's moves told to its peers: when they changed (a move began, went a stage on or ended),
 * or a minute after they were last told while any are under way. A box that has had nothing moving
 * says nothing. Not told to any (the relay down): tried again next time. */
export function tellMoving(now = Date.now()): void {
  const moves = sent(listedMoves().map(shownMove));
  const these = JSON.stringify(moves.map(({ id, stage }) => [id, stage]));
  if (these === saidLast && (!moves.length || now - saidAt < AGAIN)) return;
  if (saidLast === null && !moves.length) {
    saidLast = these;
    return;
  }
  const peers = peersOf(readLink());
  let told = !peers.length;
  for (const peer of peers) told = send(peer, { moves }, now) || told;
  if (!told) return;
  saidLast = these;
  saidAt = now;
}

/** A peer just connected (it asks for agents): what moves here is told again at the next look. */
export function tellMovingAgain(): void {
  saidAt = 0;
}

/** Told by the relay connection `host` gives: a moment after they change (one mail for a burst of
 * changes), and looked at every few seconds (a move another process began, the minute's word). */
export function watchMoving(host: () => Pick<LinkHost, "send"> | null | undefined, signal?: AbortSignal): void {
  hostOf = host;
  let soon: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    soon ??= setTimeout(() => {
      soon = null;
      tellMoving();
    }, 1_000);
  };
  moveFollowers.add(changed);
  const timer = setInterval(() => tellMoving(), 5_000);
  signal?.addEventListener("abort", () => {
    moveFollowers.delete(changed);
    clearInterval(timer);
    if (soon) clearTimeout(soon);
  }, { once: true });
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

const fresh = (one: unknown, now: number): one is Said => isObject(one) && typeof one.at === "number" && typeof one.said === "number" && Array.isArray(one.moves) && now - one.at < KEPT;

const short = (text: string, most: number) => text.slice(0, most);

/** A move as a peer says it, as clients see it; null for what isn't one. */
function takenMove(given: unknown): Move | null {
  if (!isObject(given)) return null;
  const { id, kind, thing, name, from, to, role, stage, sessions, sent, size } = given;
  if (typeof id !== "string" || typeof thing !== "string" || typeof name !== "string" || typeof from !== "string" || typeof to !== "string") return null;
  if (!KINDS.has(kind as string) || (role !== "from" && role !== "to") || !STAGES.has(stage as string) || !Array.isArray(sessions)) return null;
  return {
    id: short(id, 100), kind: kind as Move["kind"], thing: short(thing, 200), name: short(plainName(name), 200), from: short(from, 100), to: short(to, 100), role, stage: stage as Move["stage"],
    sessions: sessions.filter((session): session is string => typeof session === "string").slice(0, MOST_SESSIONS).map(session => short(session, 100)),
    ...(typeof sent === "number" && Number.isFinite(sent) ? { sent } : {}),
    ...(typeof size === "number" && Number.isFinite(size) ? { size } : {}),
  };
}

/** A peer's `moving` mail, sent at `at` (its clock): kept, in place of what it said before. Only from
 * one of this box's peers, and not one older than what it last said. */
export function takeMoving(sender: MailSender, given: unknown, at: unknown, now = Date.now()): void {
  if (!isObject(given) || !Array.isArray(given.moves) || typeof at !== "number") return;
  if (!peersOf(readLink()).some(peer => peer.key === sender.key)) return;
  const kept = readSaid();
  const before = kept[sender.key];
  if (fresh(before, now) && at <= before.said) return;
  for (const [key, one] of Object.entries(kept)) if (!fresh(one, now)) delete kept[key];
  const moves = given.moves.slice(0, MOST_MOVES).map(takenMove).filter((move): move is Move => move !== null);
  // (One that says it's over is kept a while too, so its word that comes late changes nothing.)
  kept[sender.key] = { at: now, said: at, moves };
  try { writePrivate(FILE, JSON.stringify(kept)); } catch {}
  movesChanged();
}

/** The moves your other computers said they have under way (`peers`: this box's now), by box. */
export function movesElsewhere(peers: Pick<Peer, "key">[] = peersOf(readLink()), now = Date.now()): MovesElsewhere[] {
  const keys = new Set(peers.map(peer => peer.key));
  return Object.entries(readSaid())
    .filter((entry): entry is [string, Said] => keys.has(entry[0]) && fresh(entry[1], now) && entry[1].moves.length > 0)
    .sort(([one], [other]) => one.localeCompare(other))
    .map(([box, one]) => ({ box, moves: one.moves }));
}
