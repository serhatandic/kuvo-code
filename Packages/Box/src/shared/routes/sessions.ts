// A conversation carried on with the coding agents (PROTOCOL.md, `kuvo/sessions/<id>/agents`), as
// picking one of their models in it does; a session started with a task (`kuvo/sessions`), and the
// agents' tools every box answers (`kuvo/agent-tools`; PROTOCOL.md, "Agents' tools").

import { bool, type Infer, nullable, object, type RouteShape, string } from "../shape";

/** The coding agents' session it goes on in now. */
export const CARRIED = object({ session: string });

export type Carried = Infer<typeof CARRIED>;

/** A session started: its address, title, folder and project (null for a chat), whether it shows
 * beside the conversation that started it, and with `wait`, its first answer (null for none yet). */
export const STARTED = object({ session: string, title: nullable(string), folder: string, project: nullable(string), beside: bool, "answer?": nullable(string) });

export type StartedSession = Infer<typeof STARTED>;

/** What an agent's tool says back to it: its words, and whether it didn't do what was asked. */
export const TOOL_ANSWER = object({ text: string, isError: bool });

const REFUSED = object({ message: string });

export const SESSION_ROUTES: RouteShape[] = [
  { route: "POST kuvo/sessions/:id/agents", answers: { 200: CARRIED } },
  { route: "POST kuvo/sessions", answers: { 200: STARTED, 400: REFUSED, 403: REFUSED, 404: REFUSED, 429: REFUSED, 502: object({ message: string, "session?": string }), 503: REFUSED } },
  { route: "POST kuvo/agent-tools", answers: { 200: TOOL_ANSWER, 400: REFUSED } },
];
