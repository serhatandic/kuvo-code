// Wake-ups and watches (PROTOCOL.md, `kuvo/wakes`): a conversation's or a bot's, as the bar over
// the Mac's composer shows them.

import { bool, type Infer, list, NOTHING, number, object, type RouteShape, string } from "../shape";

/** A wake-up waiting: when it's due (seconds since 1970), what it says, and how often it comes
 * back (left out for one that doesn't). */
export const WAKE = object({ id: string, due: number, note: string, "every?": string });
/** A watch: its letters, how often it looks, the check it runs and what to do when that changes. */
export const WATCH = object({ letters: string, every: string, check: string, note: string });
/** A conversation's wake-ups (soonest first), its watches, and whether you paused them. */
export const WAKES = object({ wakes: list(WAKE), watches: list(WATCH), paused: bool });
/** Each conversation here with some: its soonest wake-up, and whether it watches; and, from a
 * newer box, its wake-ups, watches and pause as `kuvo/wakes/:session` says them, so a client
 * reads them all at once (an older box leaves them out). */
export const WAKE_LIST = object({
  sessions: list(object({ session: string, "next?": number, watching: bool, "wakes?": list(WAKE), "watches?": list(WATCH), "paused?": bool })),
});

export type Wake = Infer<typeof WAKE>;
export type Watch = Infer<typeof WATCH>;
export type Wakes = Infer<typeof WAKES>;
export type WakeList = Infer<typeof WAKE_LIST>;

export const WAKE_ROUTES: RouteShape[] = [
  { route: "GET kuvo/wakes", answers: { 200: WAKE_LIST } },
  { route: "GET kuvo/wakes/:session", answers: { 200: WAKES } },
  { route: "POST kuvo/wakes/:session", answers: { 200: WAKES } },
  { route: "POST kuvo/wakes/:session/watch", answers: { 200: WAKES } },
  { route: "POST kuvo/wakes/:session/pause", answers: { 200: WAKES } },
  { route: "POST kuvo/wakes/:session/cancel", answers: { 200: NOTHING } },
  { route: "POST kuvo/wakes/:session/now", answers: { 200: NOTHING } },
];
