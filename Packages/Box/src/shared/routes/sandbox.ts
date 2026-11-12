// The sandbox agents' commands run in on a box (PROTOCOL.md, "Sandbox").

import { any, bool, type Infer, list, NOTHING, number, object, type RouteShape, string, words } from "../shape";

/** Whether every command the engine runs here goes through the sandbox (checked; it's on wherever
 * it can run, with no switch), why not, whether this computer can at all, and whether the coding agents' own programs'
 * commands are sandboxed too (`outside`: one started before it was on still runs outside it), and whether it asks you to restart those started before it was on
 * (`restart`, once: `POST kuvo/sandbox/restart`, `{restart}` true or false). When it isn't on: why, as a word a client maps (`reason`), what you
 * can do (`action`) and the box's route that does it (`route`); what the computer needs first
 * (`needs`), which part of the check failed (`check`), and how many checks failed in a row. While
 * it's on, what it can't keep commands from here (`gaps`: `services`, the services your login runs,
 * where commands can't have a namespace of their own; `needs` says what for). */
export const SANDBOX = object({
  on: bool, "why?": string, able: bool, agents: bool, "outside?": bool, "restart?": bool,
  "reason?": words("kernel", "namespaces", "macos", "engineMissing", "checking", "checkFailed", "plugin", "engineDown", "waiting"),
  "action?": words("help", "softwareUpdate", "retry", "fix", "restartEngine"),
  "route?": string, "needs?": string,
  "check?": words("folder", "tempFiles", "readsOwn", "writesOwn", "services", "didntRun", "setup"),
  "failures?": number,
  "gaps?": list(words("services")),
});

export type SandboxState = Infer<typeof SANDBOX>;

/** What the sandbox refused a command, from the system's own log (a Mac's): a write, a read, a
 * connection, starting a job or an app; with its path where it has one. */
export const SANDBOX_STOP = object({ kind: words("write", "read", "connect", "job", "app", "other"), "path?": string });

/** Whose a conversation's folder is, as Also Allowed groups its rules and an ask's card names it: a
 * project's, a bot's own (`id`, the bot's; its folder's workspace) or the chats' (one folder, so a
 * rule there is every chat's). `name`: a project's folder's name, the bot's, or "Chats". */
export const SANDBOX_OWNER = object({ kind: words("project", "bot", "chats"), "id?": string, name: string });

/** A rule kept in Also Allowed: a folder (or file) a project's commands may write in the sandbox,
 * or a bot's own, or the chats'. (Never a command run outside it without asking: whatever a
 * command runs, its scripts, its project's settings, is what the sandbox writes, so that would let
 * anything out.) `owner`: whose (a box from before it says none); `gone`: its project's folder
 * isn't there any more (a bot moved away, a project deleted), shown so it can be removed. */
export const SANDBOX_RULE = object({
  id: string, project: string, kind: words("write"), path: string,
  at: number, "by?": string, "owner?": SANDBOX_OWNER, "gone?": bool,
});
/** `owners`: the bots here working in their own folder and the chats, which a client may add a
 * folder for (`POST` with `owner`), besides the projects it knows. */
export const SANDBOX_ALLOWED = object({ allowed: list(SANDBOX_RULE), "owners?": list(SANDBOX_OWNER) });

/** Why Auto's reviewer brought something to you: in a sentence to show, and as a word a client
 * maps (`always`: it always came to you, on a bot's, before bridge 0.9.189, and which kind; `reviewer`: the reviewer asked;
 * `unread`: a script it runs couldn't be read whole first; `unreadable`, `noModel`, `failed`: it
 * couldn't be reviewed; `paused`: Auto is paused there). */
export const REVIEW_ASKED = object({
  reason: string,
  why: words("always", "reviewer", "unread", "unreadable", "noModel", "failed", "paused"),
  "always?": words("payment", "delete", "permissions", "account", "message", "credentials", "gitConfig"),
});

/**
 * A command an agent wants to run outside the sandbox (its `sandbox_ask`), waiting for your answer:
 * the conversation and its project, its bot, the command, why, what the sandbox stopped (`stopped`,
 * from a Mac's log) or the error the command got (`error`), and what Always would allow (`always`:
 * the one folder it was stopped writing in, when the box knows it and it may be given; none, and
 * it's only once or no, for anything else). `machine`: the
 * computer's name, on a machine. `owner`: whose its folder is, which Always would give it to.
 * `review`: in Auto, why its reviewer brought it to you (`reason`, a sentence to show; `why`: it
 * came to you on a bot's before bridge 0.9.189, the reviewer asked, or it couldn't be reviewed,
 * and what kind for the first).
 */
export const SANDBOX_ASK = object({
  id: string, at: number,
  "session?": string, "sessionName?": string, "bot?": string, "botName?": string,
  project: string, command: string, why: string,
  "stopped?": list(SANDBOX_STOP), "error?": string,
  "always?": object({ kind: words("write"), path: string }),
  "machine?": string, "owner?": SANDBOX_OWNER, "review?": REVIEW_ASKED,
});
/**
 * How an ask to work outside a conversation's folder was taken up, in Auto: being checked by its
 * reviewer, allowed (by it, or in the conversation's own project), held back for you to approve,
 * refused, or left for you to answer (`yours`: in Auto, a client shows its card only then). `call`:
 * the tool call it’s for. The latest two hundred, from bridge 0.9.192.
 */
export const ASK_REVIEW = object({
  id: string, session: string, "call?": string,
  state: words("checking", "allowed", "heldBack", "refused", "yours"), at: number,
});
/**
 * An ask Auto's reviewer was checking or had left for you that's over without its word: `answered`
 * (by you, on any client, or by its engine) or `gone` (its run ended, its session was deleted, or
 * its engine let it go while the box wasn't listening). A client never takes one listed so for one
 * that waits, heard or not. The latest two hundred (`sandbox.reviews.settled`).
 */
export const SETTLED_REVIEW = object({
  id: string, session: string, "call?": string,
  state: words("answered", "gone"), at: number,
});
export const SANDBOX_ASKS = object({ asks: list(SANDBOX_ASK), "restart?": bool, "reviews?": list(ASK_REVIEW), "settled?": list(SETTLED_REVIEW) });

/** The agents' sandbox tool (`sandbox_ask`), as a tool server lists it, and what a call answers. */
export const SANDBOX_TOOL_LIST = object({ tools: list(any) });
export const SANDBOX_TOOL = object({ text: string, isError: bool });
/** A command the sandbox stopped, as the engine's plugin tells the box (`POST kuvo/sandbox/stopped`,
 * `{session, input, output}`): in Auto, what the agent gets instead, its reviewer having run it
 * again outside the sandbox (`text`, and how it ended: `exit`), or why not, added after what it
 * printed (`text` alone); `{}` leaves it as it was. */
export const SANDBOX_STOPPED = object({ "text?": string, "exit?": number });

export type SandboxStop = Infer<typeof SANDBOX_STOP>;
export type SandboxRule = Infer<typeof SANDBOX_RULE>;
export type SandboxOwner = Infer<typeof SANDBOX_OWNER>;
export type SandboxAsk = Infer<typeof SANDBOX_ASK>;

export const SANDBOX_ROUTES: RouteShape[] = [
  { route: "GET kuvo/sandbox", answers: { 200: SANDBOX } },
  { route: "POST kuvo/sandbox/check", answers: { 200: SANDBOX } },
  { route: "POST kuvo/sandbox/restart", answers: { 200: SANDBOX, 503: object({ message: string }) } },
  { route: "GET kuvo/sandbox/asks", answers: { 200: SANDBOX_ASKS } },
  { route: "POST kuvo/sandbox/asks/:id", answers: { 200: NOTHING } },
  { route: "GET kuvo/sandbox/allowed", answers: { 200: SANDBOX_ALLOWED } },
  { route: "POST kuvo/sandbox/allowed", answers: { 200: SANDBOX_ALLOWED } },
  { route: "DELETE kuvo/sandbox/allowed/:id", answers: { 200: SANDBOX_ALLOWED } },
  { route: "GET kuvo/sandbox/tools", answers: { 200: SANDBOX_TOOL_LIST } },
  { route: "POST kuvo/sandbox/tools", answers: { 200: SANDBOX_TOOL } },
  { route: "POST kuvo/sandbox/stopped", answers: { 200: SANDBOX_STOPPED } },
];
