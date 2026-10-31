// A conversation carried on with the coding agents (PROTOCOL.md, `kuvo/sessions/<id>/agents`), as
// picking one of their models in it does; a session started with a task (`kuvo/sessions`), and the
// agents' tools every box answers (`kuvo/agent-tools`; PROTOCOL.md, "Agents' tools").

import { any, bool, type Infer, list, literal, map, nullable, number, object, oneOf, type RouteShape, string } from "../shape";

/** The coding agents' session it goes on in now. */
export const CARRIED = object({ session: string });

export type Carried = Infer<typeof CARRIED>;

/** A session started: its address, title, folder and project (null for a chat), whether it shows
 * beside the conversation that started it, and with `wait`, its first answer (null for none yet). */
export const STARTED = object({ session: string, title: nullable(string), folder: string, project: nullable(string), "answer?": nullable(string) });

export type StartedSession = Infer<typeof STARTED>;

/** What an agent's tool says back to it: its words, and whether it didn't do what was asked. */
export const TOOL_ANSWER = object({ text: string, isError: bool });

const REFUSED = object({ message: string });

/** A message waiting on the box while its conversation is paused: who it's from (none for yours),
 * what it says as shown, its files' names, and when it began to wait (ms). */
export const WAITING = object({ id: string, "from?": string, text: string, "files?": list(string), at: number });

/** A session's queue: whether it waits for Resume, what Stop held, in the order it goes, and what
 * waits on the box (left out when nothing does). */
export const QUEUE = object({ paused: bool, held: list(string), "waiting?": list(WAITING) });

/** `queue/add`'s answer: the queue, and whether the message waits on the box (else it went on). */
const ADDED = object({ paused: bool, held: list(string), "waiting?": list(WAITING), waits: bool });

/** What `DELETE …/queue/<item>` took away, whole, for Undo to add back (`queue/add` with `kept`),
 * where it was: ahead of `before`, what came after it (none: it was last). */
const REMOVED = object({ id: string, text: string, "files?": list(any), delivery: oneOf(literal("steer"), literal("queue")), "from?": string, words: string, "before?": string });

export type SessionQueue = Infer<typeof QUEUE>;

export const SESSION_ROUTES: RouteShape[] = [
  { route: "POST kuvo/sessions/:id/agents", answers: { 200: CARRIED } },
  { route: "POST kuvo/sessions", answers: { 200: STARTED, 400: REFUSED, 403: REFUSED, 404: REFUSED, 429: REFUSED, 502: object({ message: string, "session?": string }), 503: REFUSED } },
  { route: "POST kuvo/agent-tools", answers: { 200: TOOL_ANSWER, 400: REFUSED } },
  { route: "GET kuvo/sessions/queues/events", answers: { 200: object({ queues: map(QUEUE) }) } },
  { route: "GET kuvo/sessions/:id/queue", answers: { 200: QUEUE } },
  { route: "POST kuvo/sessions/:id/stop", answers: { 200: QUEUE, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/queue/hold", answers: { 200: QUEUE, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/queue/resume", answers: { 200: QUEUE, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/queue/:item/now", answers: { 200: QUEUE, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/queue/add", answers: { 200: ADDED, 400: REFUSED, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "DELETE kuvo/sessions/:id/queue/:item", answers: { 200: object({ paused: bool, held: list(string), "waiting?": list(WAITING), "removed?": REMOVED }), 404: REFUSED } },
];
