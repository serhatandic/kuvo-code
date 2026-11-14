// Move to Computer (PROTOCOL.md, `kuvo/moves`): a bot, a chat or a group chat moved whole to another
// of your computers, the boxes doing it between themselves; clients ask once and watch.

import { bool, type Infer, list, number, object, type RouteShape, string, words } from "../shape";

/** What can move: a bot (by its ID), a chat (by its session) or a group chat (by its ID). */
export const MOVE_KIND = words("bot", "chat", "group");
/** How far a move is: its conversations settling and held, its copy on its way, the switch to it,
 * and the original going. */
export const MOVE_STAGE = words("holding", "copying", "switching", "finishing");

/** A computer it could go to: its box's key, its name and kind, and whether it can go there now
 * (with why not, in words to show, and `note`, the same in a few words, for beside its name). */
export const MOVE_PLACE = object({ key: string, name: string, kind: words("mac", "machine"), ok: bool, "why?": string, "note?": string });
/** What of a bot or chat stays on this computer as it moves (each left out when none): the sessions
 * it started (it still reaches them from there), what it asked you that's unanswered, the goals it
 * proposed, and `agent` when its coding agent's own copy of its conversation is kept here as the way
 * back, until a week after it first runs there. */
export const MOVE_STAYS = object({ "sessions?": number, "asks?": number, "goals?": number, "agent?": bool, "startsOver?": string });
export const MOVE_PLACES = object({ places: list(MOVE_PLACE), "stays?": MOVE_STAYS });

/** A move under way, as either box says it: what moves (`thing`, `name`), from which box to which
 * (keys), whether this box is where it was (`from`) or where it's going (`to`), how far it is, its
 * conversations (root first), the other computer's name (`place`, when this box knows it), while
 * its copy's on its way, how much of it went (bytes), and `waiting` while the other computer has
 * gone quiet about it (its engine away, or the computer off; on the box it's going to, its copy's
 * parts or, set up, the switch): it carries on once it's back. */
export const MOVE = object({
  id: string,
  kind: MOVE_KIND,
  thing: string,
  name: string,
  from: string,
  to: string,
  role: words("from", "to"),
  stage: MOVE_STAGE,
  sessions: list(string),
  "place?": string,
  "sent?": number,
  "size?": number,
  "waiting?": bool,
});

/** Moves under way on another of your computers, as that computer's box last said them (its key,
 * `box`): one between two machines is seen on every box. */
export const MOVES_ELSEWHERE = object({ box: string, moves: list(MOVE) });

/** A conversation that moved away from this box in the last two days (`session`), the box it went
 * to (`key`), and when (`at`, ms). */
export const MOVED_AWAY = object({ session: string, key: string, at: number });

/** The moves under way here, the conversations this box's engine lists that don't live here (a
 * copy not switched to yet, or an original still going), for clients to leave out, the moves
 * your other computers said they have under way (left out when none), and the conversations that
 * moved away from here lately (left out when none): a client that has a row of one from this box,
 * or hears of one from it, leaves it out too, and finds it where it went. */
export const MOVES = object({ moves: list(MOVE), away: list(string), "elsewhere?": list(MOVES_ELSEWHERE), "moved?": list(MOVED_AWAY) });
/** A move that ended well: where it went. */
export const MOVED = object({ move: MOVE });

export type MoveKind = Infer<typeof MOVE_KIND>;
export type MoveStage = Infer<typeof MOVE_STAGE>;
export type MovePlace = Infer<typeof MOVE_PLACE>;
export type MovePlaces = Infer<typeof MOVE_PLACES>;
export type MoveStays = Infer<typeof MOVE_STAYS>;
export type Move = Infer<typeof MOVE>;
export type MovesElsewhere = Infer<typeof MOVES_ELSEWHERE>;
export type MovedAwayShown = Infer<typeof MOVED_AWAY>;
export type Moves = Infer<typeof MOVES>;

export const MOVE_ROUTES: RouteShape[] = [
  { route: "GET kuvo/moves", answers: { 200: MOVES } },
  { route: "GET kuvo/moves/places", answers: { 200: MOVE_PLACES } },
  { route: "POST kuvo/moves", answers: { 200: MOVED } },
];
