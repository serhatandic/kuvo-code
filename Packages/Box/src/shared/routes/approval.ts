// How much a conversation's agent does on its own, kept on the box (PROTOCOL.md, "Approval").

import { bool, type Infer, list, object, type RouteShape, string, words } from "../shape";

const APPROVAL = words("askFirst", "acceptEdits", "auto", "fullAccess");

const REASON = words("sandbox", "fullAccessOff", "bot");

/** Why one can't be had here now: the sandbox isn't running (Auto), Full Access isn't switched on
 * here, or it's a bot's (never Full Access); in words to show (`why`). */
export const UNAVAILABLE = object({ reason: REASON, why: string });

/** A conversation's approval: the one picked (`approval`; as its rules say, for one from before:
 * `stored` false, and nothing `held`), what it comes to here now (`effective`, and `held`, why
 * that's less), whether it plans (Plan mode, beside this), and each one it can be set to: one that
 * can't be picked says why (`unavailable`: Full Access), one that would ask first for now says why
 * (`held`: Auto without the sandbox). */
export const SESSION_APPROVAL = object({
  approval: APPROVAL, effective: APPROVAL, stored: bool, "held?": UNAVAILABLE, plan: bool,
  options: list(object({ approval: APPROVAL, "unavailable?": UNAVAILABLE, "held?": UNAVAILABLE })),
});

/** This computer's: whether Full Access may be picked (`fullAccess`, its switch), and whether Auto
 * runs for the engine's conversations and the coding agents' (why it asks first for now, where it
 * doesn't: `held`). */
export const APPROVAL_HERE = object({
  fullAccess: bool,
  auto: object({ engine: object({ "held?": UNAVAILABLE }), agents: object({ "held?": UNAVAILABLE }) }),
});

export type SessionApproval = Infer<typeof SESSION_APPROVAL>;
export type ApprovalHere = Infer<typeof APPROVAL_HERE>;

const REFUSED = object({ message: string });
/** Full Access refused: without its switch, or for a bot's. */
const NOT_THAT = object({ message: string, reason: REASON });

export const APPROVAL_ROUTES: RouteShape[] = [
  { route: "GET kuvo/approval", answers: { 200: APPROVAL_HERE } },
  { route: "PATCH kuvo/approval", answers: { 200: APPROVAL_HERE, 400: REFUSED } },
  { route: "GET kuvo/sessions/:id/approval", answers: { 200: SESSION_APPROVAL, 404: REFUSED, 503: REFUSED } },
  { route: "PUT kuvo/sessions/:id/approval", answers: { 200: SESSION_APPROVAL, 400: REFUSED, 404: REFUSED, 409: NOT_THAT, 502: REFUSED, 503: REFUSED } },
];
