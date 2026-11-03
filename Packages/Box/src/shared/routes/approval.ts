// How much a conversation's agent does on its own, kept on the box (PROTOCOL.md, "Approval").

import { bool, type Infer, list, number, object, type RouteShape, string, words } from "../shape";

const APPROVAL = words("askFirst", "acceptEdits", "auto", "fullAccess");

const REASON = words("sandbox", "fullAccessOff", "bot");

/** Why one can't be had here now: the sandbox isn't running (Auto), Full Access isn't confirmed
 * on this computer yet (`fullAccessOff`: ask, then `PATCH kuvo/approval {fullAccess: true}`), or
 * it's a bot's (never Full Access); in words to show (`why`). */
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

/** This computer's: whether you confirmed Full Access here (`fullAccess`: a client asks you the
 * first time you pick it, then sets it), and whether Auto runs for the engine's conversations and
 * the coding agents' (why it asks first for now, where it doesn't: `held`). */
export const APPROVAL_HERE = object({
  fullAccess: bool,
  auto: object({ engine: object({ "held?": UNAVAILABLE }), agents: object({ "held?": UNAVAILABLE }) }),
});

/** One of Auto's reviewer's decisions in a conversation: when, the action in words and what kind
 * (a command run outside the sandbox, a file outside its folder, a tool), what was decided, why in
 * a sentence, and by code (a hard line, what always comes to you, a pause) or the model; for one
 * that came to you, why it did (`why`, and `always`, which kind). */
export const REVIEW_DECISION = object({
  at: number, action: string, kind: words("command", "file", "tool"),
  decision: words("allowed", "refused", "asked"), reason: string, by: words("code", "model"),
  "why?": words("always", "reviewer", "unread", "unreadable", "noModel", "failed", "paused"),
  "always?": words("payment", "delete", "permissions", "account", "message", "credentials", "gitConfig"),
});

/** A conversation's decisions (the latest last), and since when Auto is paused there after too
 * many refusals (`paused`; `POST` with `{resume: true}` lets it go on). */
export const REVIEW_DECISIONS = object({ decisions: list(REVIEW_DECISION), "paused?": number });

export type SessionApproval = Infer<typeof SESSION_APPROVAL>;
export type ReviewDecisions = Infer<typeof REVIEW_DECISIONS>;
export type ApprovalHere = Infer<typeof APPROVAL_HERE>;

const REFUSED = object({ message: string });
/** Full Access refused: not confirmed on this computer yet, or for a bot's. */
const NOT_THAT = object({ message: string, reason: REASON });

export const APPROVAL_ROUTES: RouteShape[] = [
  { route: "GET kuvo/approval", answers: { 200: APPROVAL_HERE } },
  { route: "PATCH kuvo/approval", answers: { 200: APPROVAL_HERE, 400: REFUSED } },
  { route: "GET kuvo/sessions/:id/approval", answers: { 200: SESSION_APPROVAL, 404: REFUSED, 503: REFUSED } },
  { route: "PUT kuvo/sessions/:id/approval", answers: { 200: SESSION_APPROVAL, 400: REFUSED, 404: REFUSED, 409: NOT_THAT, 502: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/sessions/:id/decisions", answers: { 200: REVIEW_DECISIONS } },
  { route: "POST kuvo/sessions/:id/decisions", answers: { 200: REVIEW_DECISIONS, 400: REFUSED } },
];
