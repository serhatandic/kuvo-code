// A bot's work (PROTOCOL.md, "Work"): the sessions it started and theirs, where each stands, the
// asks it answered for them, what it started today, and the limits you set for it, if any; a
// client stopping all of it; what's asked of a bot by its sessions, answered on the box; what a bot
// asks you before it does it (making a project), and where new projects go.

import { bool, BYTES, type Infer, list, map, nullable, number, object, type RouteShape, string, words } from "../shape";
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

/** The account a session runs on, as Settings › Accounts lists it where it runs: its provider's
 * name ("Claude Code", "GitHub Copilot"), and for a coding agent's account you added, the name you
 * gave it (`label`, "Work"). */
export const WORK_ACCOUNT = object({ name: string, "label?": string });

/** One of a bot's sessions: its address, title, folder and project (left out for a chat), the
 * session that started it, how deep it is (1 for the bot's own), its model and mode (left out when
 * the engine has none), the account it runs on (left out on Custom Auto, which picks one each turn,
 * or when where it runs can't say), where it stands (and, while it asks, what), when it started (ms), tokens
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
  "account?": WORK_ACCOUNT,
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
  action: words("makeProject", "cloneProject", "resetLimits"),
  session: string,
  name: string,
  "bot?": string,
  /** The project's name; for a reset, the account's ("Codex"). */
  project: string,
  "clone?": string,
  folderName: string,
  folder: nullable(string),
  "suggested?": string,
  /** For a reset (`use_limit_reset`): the account (its row in "Plan limits"), how many resets it has, what one refills, and the computer of yours that uses it where that isn't this one. */
  "reset?": object({ row: string, account: string, service: string, count: number, "refills?": list(string), "on?": string }),
  at: number,
});
/** What's asked here now, the oldest first. */
export const WORK_ASKS = object({ asks: list(WORK_ASK) });

/** How your answer went: what was done, in the words its asker reads, and whether it failed. */
export const WORK_ASK_ANSWERED = object({ answer: words("allow", "always", "deny"), text: string, isError: bool });

/** Where new projects go here (null until you pick a folder), and a folder to offer without one; on a
 * Mac's box that keeps its Mac awake itself (one in a home of its own), whether it does while agents
 * work, and whether it is now. */
export const WORK_SETTINGS = object({ projectsFolder: nullable(string), "suggested?": string, "keepsAwake?": bool, "awakeNow?": bool });

/** A model, or an account's models, that can't answer now (`GET kuvo/work/unanswering`), as the
 * box holds them back from its bots: the provider, the model (left out for all of the account's,
 * or `only` its paid or free ones, then the `models` that covers, by id, when its engine could
 * say), why in the engine's words, since and until when (ms; sooner when a session on it answers,
 * or its key changes). */
export const UNANSWERING = object({ provider: string, "model?": string, "only?": words("paid", "free"), "models?": list(string), why: string, since: number, until: number });
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

/** What a bot just did to one of its sessions (`kuvo/work/oversight`): started it, wrote to it
 * (`told`), read it, answered what it asked, stopped it, or saw it finish. Each with an `id` of its
 * own, so a client plays each once, and when (ms). */
export const OVERSIGHT_MARK = object({ id: string, bot: string, session: string, kind: words("started", "told", "read", "answered", "stopped", "finished"), at: number });
/** The marks of the latest minute, the oldest first. */
export const OVERSIGHT = object({ marks: list(OVERSIGHT_MARK) });

/** When each bot's work last changed (`kuvo/work/events`), in ms by its id: a client reads a bot's
 * work again when its time moves. */
export const WORK_CHANGED = object({ changed: map(number) });

/** What still runs for each session here besides its own turn (`kuvo/work/background`, PROTOCOL.md
 * "Work › Background work"), by its id: how many commands it left running, subagents at work under
 * it and other tasks its agent keeps going, and since when (ms). One here counts as at work; one that
 * never ends stops counting a while after it started. Clients take this as it is. */
export const BACKGROUND_LIST = object({ sessions: map(object({ commands: number, subagents: number, tasks: number, since: number })) });

/** An app on the box's computer something is done in, as the bot named it (`name`): with its `id`
 * once the box found it installed there, whose icon is `kuvo/work/apps/icon?app=<id>`; none for one
 * that isn't there. */
export const GOAL_APP = object({ name: string, "id?": string });

/** A step of a goal's plan, a track of its own: where it stands, how far along where the bot can
 * measure it (0 to 1; left out where it can't, never guessed), a word on it, the phase it's in, the
 * service it's done at (`site`, its address, for its icon), the app it's done in (`app`), the steps it comes after (by id), the sessions working on it, while it waits for a limit to reset
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
  "app?": GOAL_APP,
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

/** What waits for you: what only you can fix, a call only you can make, something
 * outside the plan, or an ask (a permission or a question one of its sessions has, waiting for you).
 * A page to open for it, the site or app it's at, and the session it's in. */
export const GOAL_WAITING = object({
  id: string,
  kind: words("you", "judgment", "outside", "ask"),
  text: string,
  "detail?": string,
  "url?": string,
  "site?": string,
  "app?": GOAL_APP,
  "session?": string,
  /** The step it holds up, by id: it goes once the bot goes on with that step. */
  "step?": string,
  at: number,
});

/** A call the bot made on its own (Autopilot): what it was, what it chose and why, the other choices
 * there were, the session that asked (a question the box answered with its recommendation) or none
 * (one the bot kept with goal_progress), when, and once you've seen it, the choice you made (`yours`:
 * the same confirms it; another, the bot was told to go that way). */
export const GOAL_DECIDED = object({
  id: string,
  text: string,
  choice: string,
  "why?": string,
  "options?": list(string),
  "multiple?": bool,
  "session?": string,
  at: number,
  "yours?": object({ choice: string, at: number }),
});

/** What it may spend, each with a cap for a period (a day, a week, a month, or the whole goal), what
 * it spent in the period now, and, once the cap's reached, until when what spends waits (ms). */
export const GOAL_SPEND = object({ what: string, cap: number, currency: string, per: words("day", "week", "month", "goal"), spent: number, "until?": number });

/** Where Start makes a project the plan names, worked out as making it will: the full path
 * (`folder`; null while the plan names no folder for it and no projects folder is picked), the same
 * with `~` for the home folder (`shown`), and whether something with files is there already
 * (`there`, shown only: it never holds Start back). */
export const GOAL_FOLDER = object({ project: string, folder: nullable(string), shown: nullable(string), "there?": bool });

/** A bot's goal (PROTOCOL.md, "Work › Goals"): the goal in your words and its plan, kept on the box
 * beside the conversation's own goal (`kuvo/agents/api/kuvo/goals`), which keeps the bot at it. The
 * steps (one track each), what it checked, what it may spend, `public` (always empty now: what it
 * publishes goes as its conversation's mode allows), the projects it may make, whether what needs you wakes you, how
 * often you hear how it goes (`digest`), when it ends if you set an end, where it stands, what waits
 * for you, what's paused at a limit and until when, how long it has waited at limits (ms), what's
 * still watched, when it goes on next while nothing of it can before a time (`next`: its bot's
 * wake-up, or the steps it put off), the last digest and the final report. Proposed by the bot; only you start it,
 * decline it or stop it. `alone`: whether this box may work on it on its own (else it runs with you
 * there). How it runs (`mode`): Interactive, asking you the calls that are yours, or Autopilot,
 * deciding what its research settles and stopping only at what only you can do; the calls it made
 * on its own (`decided`). While it's proposed, where Start makes its projects (`folders`). Times in
 * ms since 1970. */
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
  mode: words("interactive", "autopilot"),
  decided: list(GOAL_DECIDED),
  alone: bool,
  "folders?": list(GOAL_FOLDER),
});
/** The goals here: each bot's latest, while it's proposed or running, or ended in the last day. */
export const GOAL_PLANS = object({ goals: list(GOAL_PLAN) });

const REFUSED = object({ message: string });

export type BackgroundList = Infer<typeof BACKGROUND_LIST>;
export type WorkLimits = Infer<typeof LIMITS>;
export type WorksFor = Infer<typeof WORKS_FOR>;
export type WorkAnswer = Infer<typeof ANSWER>;
export type WorkSession = Infer<typeof WORK_SESSION>;
export type WorkAccount = Infer<typeof WORK_ACCOUNT>;
export type BotWork = Infer<typeof WORK>;
export type UnansweringList = Infer<typeof UNANSWERING_LIST>;
export type WorkAskShape = Infer<typeof WORK_ASK>;
export type OversightMark = Infer<typeof OVERSIGHT_MARK>;
export type OversightKind = OversightMark["kind"];
export type GoalPlanShape = Infer<typeof GOAL_PLAN>;
export type GoalWaitingShape = Infer<typeof GOAL_WAITING>;
export type GoalCheckShape = Infer<typeof GOAL_CHECK>;
export type GoalStepShape = Infer<typeof GOAL_STEP>;
export type GoalAppShape = Infer<typeof GOAL_APP>;
export type GoalFolderShape = Infer<typeof GOAL_FOLDER>;
export type GoalDecidedShape = Infer<typeof GOAL_DECIDED>;

export const WORK_ROUTES: RouteShape[] = [
  { route: "GET kuvo/work", answers: { 200: WORK, 400: REFUSED, 404: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/work/events", answers: { 200: WORK_CHANGED } },
  { route: "GET kuvo/work/background", answers: { 200: BACKGROUND_LIST } },
  { route: "GET kuvo/work/background/events", answers: { 200: BACKGROUND_LIST } },
  { route: "POST kuvo/bots/:id/stop-all", answers: { 200: object({ stopped: number }), 404: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/work/oversight", answers: { 200: OVERSIGHT } },
  { route: "GET kuvo/work/oversight/events", answers: { 200: OVERSIGHT } },
  { route: "GET kuvo/work/asks", answers: { 200: WORK_ASKS } },
  { route: "GET kuvo/work/asks/events", answers: { 200: WORK_ASKS } },
  { route: "POST kuvo/work/asks/:id", answers: { 200: WORK_ASK_ANSWERED, 400: REFUSED, 404: REFUSED } },
  { route: "GET kuvo/work/settings", answers: { 200: WORK_SETTINGS } },
  { route: "PATCH kuvo/work/settings", answers: { 200: WORK_SETTINGS, 400: REFUSED } },
  { route: "GET kuvo/work/unanswering", answers: { 200: UNANSWERING_LIST } },
  { route: "GET kuvo/work/goals", answers: { 200: GOAL_PLANS } },
  { route: "GET kuvo/work/goals/events", answers: { 200: GOAL_PLANS } },
  { route: "POST kuvo/work/goals/ask", answers: { 200: object({ text: string }), 400: REFUSED, 404: REFUSED, 409: REFUSED } },
  { route: "POST kuvo/work/goals/:id", answers: { 200: object({ goal: GOAL_PLAN }), 400: REFUSED, 404: REFUSED, 409: REFUSED, 502: REFUSED } },
  { route: "GET kuvo/work/apps/icon", answers: { 200: BYTES, 400: REFUSED, 404: REFUSED } },
  { route: "POST kuvo/projects/new", answers: { 201: object({ project: PROJECT, text: string }), 400: REFUSED, 403: object({ message: string, needs: string }), 409: REFUSED, 502: REFUSED } },
];
