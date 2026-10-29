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
 * bot, for a bot's), the project's name, the repository for a clone, where it would go (null while
 * no projects folder is picked here, with a folder to offer, when there's one), and when (ms). */
export const WORK_ASK = object({
  id: string,
  action: words("makeProject", "cloneProject"),
  session: string,
  name: string,
  "bot?": string,
  project: string,
  "clone?": string,
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

const REFUSED = object({ message: string });

export type WorkLimits = Infer<typeof LIMITS>;
export type WorksFor = Infer<typeof WORKS_FOR>;
export type WorkAnswer = Infer<typeof ANSWER>;
export type WorkSession = Infer<typeof WORK_SESSION>;
export type BotWork = Infer<typeof WORK>;
export type WorkAskShape = Infer<typeof WORK_ASK>;

export const WORK_ROUTES: RouteShape[] = [
  { route: "GET kuvo/work", answers: { 200: WORK, 400: REFUSED, 404: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/work/events", answers: { 200: WORK_CHANGED } },
  { route: "POST kuvo/bots/:id/stop-all", answers: { 200: object({ stopped: number }), 404: REFUSED, 503: REFUSED } },
  { route: "GET kuvo/work/asks", answers: { 200: WORK_ASKS } },
  { route: "GET kuvo/work/asks/events", answers: { 200: WORK_ASKS } },
  { route: "POST kuvo/work/asks/:id", answers: { 200: WORK_ASK_ANSWERED, 400: REFUSED, 404: REFUSED } },
  { route: "GET kuvo/work/settings", answers: { 200: WORK_SETTINGS } },
  { route: "PATCH kuvo/work/settings", answers: { 200: WORK_SETTINGS, 400: REFUSED } },
  { route: "POST kuvo/projects/new", answers: { 201: object({ project: PROJECT, text: string }), 400: REFUSED, 403: object({ message: string, needs: string }), 409: REFUSED, 502: REFUSED } },
];
