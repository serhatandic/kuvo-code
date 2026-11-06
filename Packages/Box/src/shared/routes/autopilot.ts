// Whether a conversation runs Interactive or on Autopilot, and the calls it made there
// (PROTOCOL.md, "Autopilot").

import { bool, type Infer, list, number, object, type RouteShape, string } from "../shape";

/** A call Autopilot made where a question would have waited: the question's form (`id`; its field
 * too, `<form>/<key>`, where a form asks several, each a call of its own), what it asked, the choice
 * it went with and why, the choices it had (`multiple`, it takes several, joined with ", "), the
 * session that asked where it isn't the conversation itself (a subagent's), the tool call that asked it (`call`,
 * where its form names one: the step a client shows it at), when; and your choice since
 * (`yours`). */
export const DECIDED = object({
  id: string, text: string, choice: string, "why?": string, "options?": list(string), "multiple?": bool, "session?": string, "call?": string, at: number,
  "yours?": object({ choice: string, at: number }),
});

/** A conversation's: on Autopilot or not, and the calls it made (the latest last). */
export const SESSION_AUTOPILOT = object({ autopilot: bool, decided: list(DECIDED) });

/** Whether a question a client heard asked waits on you, once the box has looked. */
export const ASK_WAITING = object({ waiting: bool });

export type DecidedShape = Infer<typeof DECIDED>;
export type SessionAutopilot = Infer<typeof SESSION_AUTOPILOT>;

const REFUSED = object({ message: string });

export const AUTOPILOT_ROUTES: RouteShape[] = [
  { route: "GET kuvo/sessions/:id/autopilot", answers: { 200: SESSION_AUTOPILOT, 404: REFUSED, 503: REFUSED } },
  { route: "PUT kuvo/sessions/:id/autopilot", answers: { 200: SESSION_AUTOPILOT, 400: REFUSED, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/autopilot", answers: { 200: SESSION_AUTOPILOT, 400: REFUSED, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/autopilot/asked", answers: { 200: ASK_WAITING, 400: REFUSED, 404: REFUSED, 503: REFUSED } },
];
