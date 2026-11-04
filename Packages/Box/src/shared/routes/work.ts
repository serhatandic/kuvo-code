// A bot's work (PROTOCOL.md, "Work"): the sessions it started and theirs, where each stands, the
// asks it answered for them, what it started today, and the limits you set for it, if any; a
// client stopping all of it; what's asked of a bot by its sessions, answered on the box; what a bot
// asks you before it does it (making a project), and where new projects go.

import { bool, type Infer, list, map, nullable, number, object, type RouteShape, string, words } from "../shape";
import { PROJECT } from "./projects";

/** Limits you set for a bot (Edit Bot › Work), each left out when you set none: sessions working
 * at once, started in a day, how deep its sessions may start theirs, and tokens in a day. */
export const LIMITS = object({ "atOnce?": number, "perDay?": number, "depth?": number, "tokensPerDay?": number });

/** The bot a session works for, as every session under it is marked (`kuvo.by`). */
export const WORKS_FOR = object({ bot: string, name: string });

/** An ask one of a bot's sessions had, as the bot answered it: the ask, the tool call it was for
 * (left out when the engine didn't say), what it asked in words, the answer and why, who answered
 * (a bot by its id and name; a session that isn't a bot's, by its name) and when (ms since 1970). */
export const ANSWER = object({
  "session?": string,
  ask: string,
  "call?": string,
  what: string,
  decision: words("allow", "deny", "answer"),
  reason: string,
  by: object({ "bot?": string, name: string }),
  at: number,
});

/** One of a bot's sessions: its address, title, folder and project (left out for a chat), the
 * session that started it, how deep it is (1 for the bot's own), its model and mode (left out when
 * the engine has none), where it stands (and, while it asks, what), when it started (ms), tokens
 * and cost so far (cost where the engine prices it), and the first lines of its last reply. */
export const WORK_SESSION = object({
  session: string,
  title: string,
  folder: string,
  "project?": string,
  startedBy: string,
  depth: number,
  "model?": object({ id: string, providerID: string, "variant?": string }),
  "mode?": string,
  state: words("working", "asking", "finished", "failed", "stopped", "idle"),
  "asks?": string,
  started: number,
  tokens: number,
  "cost?": number,
  "lastReply?": string,
});

/** Something a bot (or another conversation) asks you before it does it (`kuvo/work/asks`): making
 * a project, or cloning one into a new project. Who asks (its conversation, by its name, and the
 * bot, for a bot's), the project's name, the repository for a clone, the folder's name it gets and
 * where it would go (null while no projects folder is picked here, with a folder to offer, when
 * there's one), and when (ms). */
export const WORK_ASK = object({
  id: string,
  action: words("makeProject", "cloneProject"),
  session: string,
  name: string,
  "bot?": string,
  project: string,
  "clone?": string,
  folderName: string,
  folder: nullable(string),
  "suggested?": string,
  at: number,
});
/** What's asked here now, the oldest first. */
export const WORK_ASKS = object({ asks: list(WORK_ASK) });

/** How your answer went: what was done, in the words its asker reads, and whether it failed. */
export const WORK_ASK_ANSWERED = object({ answer: words("allow", "always", "deny"), text: string, isError: bool });

/** Where new projects go here (null until you pick a folder), and a folder to offer without one. */
export const WORK_SETTINGS = object({ projectsFolder: nullable(string), "suggested?": string });

/** A model, or an account's models, that can't answer now (`GET kuvo/work/unanswering`), as the
 * box holds them back from its bots: the provider, the model (left out for all of the account's,
 * or `only` its paid or free ones), why in the engine's words, since and until when (ms; sooner
 * when a session on it answers, or its key changes). */
export const UNANSWERING = object({ provider: string, "model?": string, "only?": words("paid", "free"), why: string, since: number, until: number });
export const UNANSWERING_LIST = object({ held: list(UNANSWERING) });

/** A bot's work, as `GET kuvo/work?bot=` answers: its sessions (the latest first), the asks it
 * answered for them (the latest first), what it started today and how many work now, and the
 * limits you set (null for none). */
export const WORK = object({
  bot: string,
  sessions: list(WORK_SESSION),
  answered: list(ANSWER),
  today: object({ started: number, working: number, tokens: number, "cost?": number }),
  limits: nullable(LIMITS),
  "asks?": list(WORK_ASK),
  "projects?": list(PROJECT),
});

/** When each bot's work last changed (`kuvo/work/events`), in ms by its id: a client reads a bot's
 * work again when its time moves. */
export const WORK_CHANGED = object({ changed: map(number) });

/** A step of a goal's plan, a track of its own: where it stands, how far along where the bot can
 * measure it (0 to 1; left out where it can't, never guessed), a word on it, the phase it's in, the
 * service it's done at (`site`, its address, for its icon), the steps it comes after (by id), the sessions working on it, while it waits for a limit to reset
 * until when, when the bot put it off until (`until`, a step that starts at a time), and when it
 * began and ended (ms), for a time axis. */
export const GOAL_STEP = object({
  id: string,
  text: string,
  state: words("todo", "doing", "done", "waiting", "paused", "skipped"),
  "progress?": number,
  "note?": string,
  "detail?": string,
  "phase?": string,
  "site?": string,
  "after?": list(string),
  "sessions?": list(string),
  "resumes?": number,
  "until?": number,
  "began?": number,
  "ended?": number,
});

/** What a goal needs, checked before you start it: by the bot (its tools, keys, services) or by
 * the box (whether it may work on its own here, on power, where new projects go). `needs` is yours to
 * do, with what you'd press (a page to open, or the projects folder to pick); `failed` can't be done
 * here (the goal can still run with you there). */
export const GOAL_CHECK = object({
  id: string,
  text: string,
  "detail?": string,
  state: words("ok", "needs", "failed"),
  by: words("bot", "box"),
  "site?": string,
  "action?": object({ kind: words("open", "projectsFolder"), label: string, "url?": string }),
});

/** What waits for you: what only you can fix, a judgment call before anything public, something
 * outside the plan, or an ask (a permission or a question one of its sessions has, waiting for you).
 * A page to open for it, and the session it's in. */
export const GOAL_WAITING = object({
  id: string,
  kind: words("you", "judgment", "outside", "ask"),
  text: string,
  "detail?": string,
  "url?": string,
  "site?": string,
  "session?": string,
  at: number,
});

/** What it may spend, each with a cap for a period (a day, a week, a month, or the whole goal), what
 * it spent in the period now, and, once the cap's reached, until when what spends waits (ms). */
export const GOAL_SPEND = object({ what: string, cap: number, currency: string, per: words("day", "week", "month", "goal"), spent: number, "until?": number });

/** A bot's goal (PROTOCOL.md, "Work › Goals"): the goal in your words and its plan, kept on the box
 * beside the conversation's own goal (`kuvo/agents/api/kuvo/goals`), which keeps the bot at it. The
 * steps (one track each), what it checked, what it may spend, its public steps with your switch for
 * each (off until you turn it on), the projects it may make, whether what needs you wakes you, how
 * often you hear how it goes (`digest`), when it ends if you set an end, where it stands, what waits
 * for you, what's paused at a limit and until when, how long it has waited at limits (ms), what's
 * still watched, when it goes on next while nothing of it can before a time (`next`: its bot's
 * wake-up, or the steps it put off), the last digest and the final report. Proposed by the bot; only you start it,
 * decline it or stop it. `alone`: whether this box may work on it on its own (else it runs with you
 * there). Times in ms since 1970. */
export const GOAL_PLAN = object({
  id: string,
  bot: string,
  name: string,
  session: string,
  goal: string,
  "title?": string,
  state: words("proposed", "running", "done", "stopped", "declined"),
  steps: list(GOAL_STEP),
  checks: list(GOAL_CHECK),
  spend: list(GOAL_SPEND),
  public: list(object({ id: string, text: string, on: bool })),
  projects: list(string),
  wake: bool,
  digest: words("day", "week", "milestones", "none"),
  "ends?": number,
  proposed: number,
  "started?": number,
  "ended?": number,
  waiting: list(GOAL_WAITING),
  paused: list(object({ why: string, "until?": number, "session?": string })),
  waited: number,
  watching: list(string),
  "next?": number,
  "lastDigest?": object({ at: number, text: string }),
  "report?": string,
  alone: bool,
});
/** The goals here: each bot's latest, while it's proposed or running, or ended in the last day. */
export const GOAL_PLANS = object({ goals: list(GOAL_PLAN) });

const REFUSED = object({ message: string });

export type WorkLimits = Infer<typeof LIMITS>;
export type WorksFor = Infer<typeof WORKS_FOR>;
export type WorkAnswer = Infer<typeof ANSWER>;
export type WorkSession = Infer<typeof WORK_SESSION>;
export type BotWork = Infer<typeof WORK>;
export type UnansweringList = Infer<typeof UNANSWERING_LIST>;
export type WorkAskShape = Infer<typeof WORK_ASK>;
export type GoalPlanShape = Infer<typeof GOAL_PLAN>;
export type GoalWaitingShape = Infer<typeof GOAL_WAITING>;
export type GoalCheckShape = Infer<typeof GOAL_CHECK>;
export type GoalStepShape = Infer<typeof GOAL_STEP>;

export const WORK_ROUTES: RouteShape[] = [
  { route: "GET kuvo/work", answers: { 200: WORK, 400: REFUSED, 404: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/work/events", answers: { 200: WORK_CHANGED } },
  { route: "POST kuvo/bots/:id/stop-all", answers: { 200: object({ stopped: number }), 404: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/work/asks", answers: { 200: WORK_ASKS } },
  { route: "GET kuvo/work/asks/events", answers: { 200: WORK_ASKS } },
  { route: "POST kuvo/work/asks/:id", answers: { 200: WORK_ASK_ANSWERED, 400: REFUSED, 404: REFUSED } },
  { route: "GET kuvo/work/settings", answers: { 200: WORK_SETTINGS } },
  { route: "PATCH kuvo/work/settings", answers: { 200: WORK_SETTINGS, 400: REFUSED } },
  { route: "GET kuvo/work/unanswering", answers: { 200: UNANSWERING_LIST } },
  { route: "GET kuvo/work/goals", answers: { 200: GOAL_PLANS } },
  { route: "GET kuvo/work/goals/events", answers: { 200: GOAL_PLANS } },
  { route: "POST kuvo/work/goals/ask", answers: { 200: object({ text: string }), 400: REFUSED, 404: REFUSED, 409: REFUSED } },
  { route: "POST kuvo/work/goals/:id", answers: { 200: object({ goal: GOAL_PLAN }), 400: REFUSED, 404: REFUSED, 409: REFUSED } },
  { route: "POST kuvo/projects/new", answers: { 201: object({ project: PROJECT, text: string }), 400: REFUSED, 403: object({ message: string, needs: string }), 409: REFUSED, 502: REFUSED } },
];
