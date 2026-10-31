// Group chats (PROTOCOL.md, `kuvo/groups`): those that live on the box asked, one chat's messages,
// who can be in one, and what a client does to them. The coding agents' bridge there runs them and
// answers (src/agents/groups/link.ts), and the box passes its answers on as they are: these are
// the shapes it answers in.

import { any, bool, type Infer, list, literal, NOTHING, nullable, number, object, oneOf, type RouteShape, string, words } from "../shape";
import { LOOK } from "./bots";

/** A bot as a chat lists it: who it is, how it looks (left out when its description doesn't
 * say), its own conversation and folder, and whether that runs with the coding agents. One of
 * another of your computers has `computer`, that computer's name; its folder is empty (it's
 * there), and its conversation too when that computer didn't say. */
export const MEMBER = object({
  id: string,
  name: string,
  "look?": LOOK,
  session: string,
  directory: string,
  agents: bool,
  "computer?": string,
});

/** Who does what after a wrap-up: its bot, its part, how it's going, when it started and
 * finished (seconds since 1970), and the tasks whose parts come first. */
export const TASK = object({
  id: string,
  bot: string,
  task: string,
  state: words("proposed", "waiting", "working", "done", "failed"),
  "prompt?": string,
  "started?": number,
  "finished?": number,
  "after?": list(string),
});

/** A message in a chat: who wrote it (left out, or null in a chat a Mac wrote, for yours and the
 * chat's own), its words, when (seconds since 1970) and what kind it is; a bot's tool calls on its
 * turn (`steps`, each as the agents' bridge records a tool call, passed on as it is; left out in a
 * list's `last`), the parts a wrap-up hands out, and the task a bot reports back on. */
export const MESSAGE = object({
  id: string,
  "author?": string,
  text: string,
  time: number,
  kind: words("message", "wrapUp", "note", "meeting"),
  "steps?": list(any),
  "tasks?": list(TASK),
  "report?": string,
});

/** A chat's meeting: the next one (seconds since 1970), how often it comes back (as kuvo-wake
 * writes it; left out for once), its topic, and the time of day (minutes) and day of the week (1 is
 * Sunday) one that repeats keeps. */
export const MEETING = object({
  next: number,
  "every?": string,
  topic: string,
  "at?": number,
  "weekday?": number,
});

/** A chat that lives here, as a client lists it: its name and purpose (left out for none), its bots, who's talking (left out when nobody is), whether a
 * discussion is under way or paused, whether a bot said something since you last looked, the last
 * thing said (left out before anything was), and its meeting, if it has one. */
export const GROUP = object({
  id: string,
  name: string,
  "purpose?": string,
  members: list(MEMBER),
  "speaking?": string,
  discussing: bool,
  paused: bool,
  unread: bool,
  "last?": MESSAGE,
  "meeting?": MEETING,
});
/** The chats that live here. */
export const GROUPS = object({ groups: list(GROUP) });
/** A chat just made or changed, as the list has it now (null should it not list now). */
export const GROUP_CHANGED = object({ group: nullable(GROUP) });

/** What the bot talking is doing: a tool it called (as the agents' bridge records a tool call,
 * without what it gave back; passed on as it is), the line its thinking is on, or its reply being
 * written. */
export const ACTIVITY = oneOf(
  object({ kind: literal("tool"), call: any }),
  object({ kind: literal("thinking"), text: string }),
  object({ kind: literal("writing") }),
);
/** One chat: its latest messages, who's talking, whether a discussion is under way or paused,
 * what the bot talking is doing now (left out when nothing is said of it), and the bots whose
 * part of the work waits on their conversation, stopped by you (left out for none). */
export const CHAT = object({
  messages: list(MESSAGE),
  "speaking?": string,
  discussing: bool,
  paused: bool,
  "activity?": list(ACTIVITY),
  "stopped?": list(string),
});

/** Who can be in a chat made here: this box's bots, the first made first, then those of your
 * other computers that take a chat's turns. */
export const JOINABLE = object({ bots: list(MEMBER) });
/** A message of yours taken back: what it said. */
export const UNDONE = object({ text: string });

export type GroupMember = Infer<typeof MEMBER>;
export type GroupTask = Infer<typeof TASK>;
export type GroupMessage = Infer<typeof MESSAGE>;
export type GroupMeeting = Infer<typeof MEETING>;
export type ListedGroup = Infer<typeof GROUP>;
export type Groups = Infer<typeof GROUPS>;
export type GroupChanged = Infer<typeof GROUP_CHANGED>;
export type GroupActivity = Infer<typeof ACTIVITY>;
export type GroupChat = Infer<typeof CHAT>;
export type Joinable = Infer<typeof JOINABLE>;

export const GROUP_ROUTES: RouteShape[] = [
  { route: "GET kuvo/groups", answers: { 200: GROUPS } },
  { route: "POST kuvo/groups", answers: { 201: GROUP_CHANGED } },
  { route: "GET kuvo/groups/joinable", answers: { 200: JOINABLE } },
  { route: "GET kuvo/groups/:id", answers: { 200: CHAT } },
  { route: "POST kuvo/groups/:id", answers: { 200: NOTHING } },
  { route: "PATCH kuvo/groups/:id", answers: { 200: GROUP_CHANGED } },
  { route: "DELETE kuvo/groups/:id", answers: { 200: NOTHING } },
  { route: "POST kuvo/groups/:id/stop", answers: { 200: NOTHING } },
  { route: "POST kuvo/groups/:id/keep-going", answers: { 200: NOTHING } },
  { route: "POST kuvo/groups/:id/viewed", answers: { 200: NOTHING } },
  { route: "POST kuvo/groups/:id/undo", answers: { 200: UNDONE } },
  { route: "POST kuvo/groups/:id/start", answers: { 200: NOTHING } },
];
