// A conversation carried on with the coding agents (PROTOCOL.md, `kuvo/sessions/<id>/agents`), as
// picking one of their models in it does; a session started with a task (`kuvo/sessions`), and the
// agents' tools every box answers (`kuvo/agent-tools`; PROTOCOL.md, "Agents' tools").

import { any, bool, type Infer, list, literal, map, nullable, number, object, oneOf, type RouteShape, string, words } from "../shape";

/** The coding agents' session it goes on in now. */
export const CARRIED = object({ session: string });

export type Carried = Infer<typeof CARRIED>;

/** A session started: its address, title, folder and project (null for a chat), whether it shows
 * beside the conversation that started it, and with `wait`, its first answer (null for none yet).
 * A client's start with no task: the session as it's made (`info`, as the engine lists it), and the
 * worktree made for it (`worktree`, as `kuvo/worktrees` makes one). */
export const STARTED = object({ session: string, title: nullable(string), folder: string, project: nullable(string), "answer?": nullable(string), "got?": words("askFirst", "acceptEdits", "auto"), "info?": any, "worktree?": object({ project: string, root: string, "folder?": string, branch: string, "base?": string }) });

export type StartedSession = Infer<typeof STARTED>;

/** A conversation moved into a project (`kuvo/sessions/<id>/move`): where it goes, and the session
 * as it is now (`info`, as the engine lists it; it moves at its next step while it's at work). */
export const SESSION_MOVED = object({ session: string, directory: string, "info?": any });

export type SessionMoved = Infer<typeof SESSION_MOVED>;

/** What an agent's tool says back to it: its words, and whether it didn't do what was asked. */
export const TOOL_ANSWER = object({ text: string, isError: bool });

const REFUSED = object({ message: string });

/** A message waiting on the box while its conversation is paused: who it's from (none for yours),
 * what it says as shown, its files' names, and when it began to wait (ms). */
export const WAITING = object({ id: string, "from?": string, text: string, "files?": list(string), "keyword?": string, at: number });

/** A session's queue: whether it waits for Resume, what Stop held, in the order it goes, and what
 * waits on the box (left out when nothing does). */
export const QUEUE = object({ paused: bool, held: list(string), "waiting?": list(WAITING) });

/** `queue/add`'s answer: the queue, and whether the message waits on the box (else it went on). */
const ADDED = object({ paused: bool, held: list(string), "waiting?": list(WAITING), waits: bool });

/** What `DELETE …/queue/<item>` took away, whole, for Undo to add back (`queue/add` with `kept`),
 * where it was: ahead of `before`, what came after it (none: it was last). */
const REMOVED = object({ id: string, text: string, "files?": list(any), delivery: oneOf(literal("steer"), literal("queue")), "from?": string, words: string, "before?": string });

export type SessionQueue = Infer<typeof QUEUE>;

/** A pull request's checks as the box counts them from GitHub's: skipped and neutral ones count as
 * passed, cancelled, timed out and the like as failed, the rest still under way. */
export const GLANCE_CHECKS = object({ passed: number, failed: number, pending: number });

/** A session's pull request: its number and page, and once GitHub was read, its state, its size
 * and its checks (left out where it has none). */
export const GLANCE_PULL = object({
  number: number, url: string, "state?": words("open", "draft", "merged", "closed"),
  "additions?": number, "deletions?": number, "checks?": GLANCE_CHECKS,
});

/** What a session's row and its card show beyond the session itself (`kuvo/sessions/glance`): the
 * branch it has of its own (a worktree's, or its pull request's) and, without a pull request, the
 * lines it changed since its base; its pull request; the account it runs on; and since when it's
 * waited on you (ms), while it does. Each left out where there's none. */
export const GLANCE = object({
  "branch?": string, "additions?": number, "deletions?": number, "pull?": GLANCE_PULL,
  "account?": object({ name: string, "label?": string }), "asked?": number,
});

/** The sessions asked for, by id: one this box doesn't have is left out. */
export const GLANCES = object({ sessions: map(GLANCE) });

/** What a session's model button shows and whether its model can run (`kuvo/sessions/models`):
 * the model it runs on (its own, else the engine's default; null for none), its name as its
 * provider or agent lists it, whether it can run here now, and what's missing if not: a model to
 * choose, a sign-in to its account, a key, its coding agent installed, or the model itself, gone
 * from its provider's list. `account`: the account to sign in to, add a key for or install, or the
 * provider it's gone from. `plan`: for a key the engine needs where a plan goes through a coding
 * agent of its own (the engine's xAI, whose SuperGrok plan is Grok's), that plan, its agent and
 * the agent's provider. */
export const SESSION_MODEL = object({
  model: nullable(object({ providerID: string, id: string, "variant?": string })),
  "name?": string,
  runs: bool,
  "missing?": words("model", "signIn", "key", "install", "gone"),
  "account?": object({ id: string, name: string, "label?": string }),
  "plan?": object({ name: string, agent: string, provider: string }),
});

/** The sessions asked for, by id: one the box doesn't have, or can't say about yet, is left out. */
export const SESSION_MODELS = object({ sessions: map(SESSION_MODEL) });

export type SessionModel = Infer<typeof SESSION_MODEL>;

/** The models a session can use here (`kuvo/models/offered`), as a picker offers them: every one
 * that runs now (`retiring`: its provider is retiring it; `hidden`: its agent keeps it out of its
 * picker; a picker leaves either out, though a conversation on it carries on); whether the engine's and the coding agents' could be said
 * (`known`); the coding agents' accounts still listing theirs (`listing`: one of theirs not
 * listed may still run); and the model a new session starts on, for the one wanted (`starting`: null for none
 * that runs; left out while the engine can't say). */
const MODEL_REF = object({ providerID: string, id: string, "variant?": string });
export const MODELS_OFFERED = object({
  models: list(object({ providerID: string, id: string, name: string, "retiring?": bool, "hidden?": bool })),
  known: object({ engine: bool, agents: bool }),
  "listing?": list(string),
  "starting?": nullable(MODEL_REF),
});

/** What a session is, as every client's lists go by it (`kuvo/sessions/list`, PROTOCOL.md "Session
 * lists"): a project's session, a chat, a bot's conversation, a bot's seat in a group chat, a run
 * kept out of sight, or a subagent's. */
export const SESSION_KINDS = ["project", "chat", "bot", "seat", "hidden", "subagent"] as const;

/** One session's facts: its kind, the project it's filed under (a project's session's), its
 * folder, title and times (`updated`, its order), the session it works for (a subagent's), whether
 * it's pinned, archived, running, since when it's waited on you (ms), and whether this copy isn't
 * its own (it moved, or is on its way here). Each flag left out where it isn't. */
export const SESSION_FACTS = object({
  kind: words(...SESSION_KINDS),
  "project?": string,
  directory: string,
  "title?": string,
  created: number,
  updated: number,
  "parent?": string,
  "pinned?": bool,
  "archived?": bool,
  "running?": bool,
  "asked?": number,
  "away?": bool,
});

/** A project the lists show: its name where it isn't its folder's, and when its newest session
 * listed in it changed (none for one with none). */
export const LISTED_PROJECT = object({ "name?": string, "updated?": number });

/** The list (`kuvo/sessions/list`): where it's at (`since` resumes from it), whether it's whole
 * (`full`) or only what changed since, the sessions by id, those gone since, its projects, and the
 * places it couldn't read now (`bridge`: the coding agents' sessions as they were last read). */
export const SESSION_LIST = object({
  at: string,
  "full?": bool,
  sessions: map(SESSION_FACTS),
  "gone?": list(string),
  projects: map(LISTED_PROJECT),
  "pending?": list(string),
});

export type SessionKind = (typeof SESSION_KINDS)[number];
export type SessionFacts = Infer<typeof SESSION_FACTS>;
export type ListedProject = Infer<typeof LISTED_PROJECT>;
export type SessionList = Infer<typeof SESSION_LIST>;

export type Glance = Infer<typeof GLANCE>;
export type GlancePull = Infer<typeof GLANCE_PULL>;
export type GlanceChecks = Infer<typeof GLANCE_CHECKS>;

export const SESSION_ROUTES: RouteShape[] = [
  { route: "POST kuvo/sessions/:id/agents", answers: { 200: CARRIED } },
  { route: "POST kuvo/sessions/:id/folders", answers: { 200: object({ session: string }), 404: REFUSED, 405: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/move", answers: { 200: SESSION_MOVED, 400: REFUSED, 404: REFUSED, 405: REFUSED, 409: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions", answers: { 200: STARTED, 400: REFUSED, 403: REFUSED, 404: REFUSED, 409: object({ message: string, reason: words("fullAccessOff") }), 429: REFUSED, 502: object({ message: string, "session?": string }), 503: REFUSED } },
  { route: "POST kuvo/agent-tools", answers: { 200: TOOL_ANSWER, 400: REFUSED } },
  { route: "GET kuvo/sessions/queues/events", answers: { 200: object({ queues: map(QUEUE) }) } },
  { route: "GET kuvo/sessions/glance", answers: { 200: GLANCES, 400: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/read", answers: { 200: object({ read: number }), 503: REFUSED } },
  { route: "GET kuvo/sessions/glance/events", answers: { 200: GLANCES, 400: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/sessions/list", answers: { 200: SESSION_LIST, 405: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/sessions/list/events", answers: { 200: SESSION_LIST, 405: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/sessions/models", answers: { 200: SESSION_MODELS, 400: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/models/offered", answers: { 200: MODELS_OFFERED, 503: REFUSED } },
  { route: "GET kuvo/sessions/:id/queue", answers: { 200: QUEUE } },
  { route: "POST kuvo/sessions/:id/stop", answers: { 200: QUEUE, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/queue/hold", answers: { 200: QUEUE, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/queue/resume", answers: { 200: QUEUE, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/queue/:item/now", answers: { 200: QUEUE, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/queue/add", answers: { 200: ADDED, 400: REFUSED, 404: REFUSED, 502: REFUSED, 503: REFUSED } },
  { route: "DELETE kuvo/sessions/:id/queue/:item", answers: { 200: object({ paused: bool, held: list(string), "waiting?": list(WAITING), "removed?": REMOVED }), 404: REFUSED } },
];
