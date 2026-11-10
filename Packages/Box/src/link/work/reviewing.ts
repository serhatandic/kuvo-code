// Auto's reviewer for a conversation here (`reviewer.ts` judges): which conversation an ask is in
// (a subagent's is its own conversation's), whether it's in Auto (or Full Access) here now, what you
// said in it (or its bot's goal), and the small model of the maker it runs on: the engine's
// provider's own (its Haiku, Flash, mini…) through the engine, a coding agent's (Claude Code's
// Haiku, Codex's Luna) through the agents bridge, so it's counted on that account. One that isn't
// in Auto isn't reviewed: what it asks goes to you as before. A refusal goes back to the agent,
// which carries on another way; one you approve later is told to the conversation. A pause stops
// the conversation's run. A review that fails (a full disk, say) is a refusal too: never an ask.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { oneLine } from "../../shared/text";
import { bridgeTarget, call, call as engineCall, engineGet, readEngineFile } from "../engine/client";
import { attachmentRoots, homeFolder } from "../home";
import { sendInto, stopSession, writtenByYou } from "../engine/queue";
import { boxNote } from "../../shared/queues";
import { messageID } from "../engine/sessions";
import { approvalOf } from "./approval";
import { asksIn, callOf } from "./answers";
import { pauseGoal, REVIEW_PAUSE, runningGoal } from "./goals";
import { usableModels, type Usable } from "./models";
import { review, type Decision, type ReviewedAction, type ReviewContext, type SmallModel, type Verdict } from "./reviewer";
import { botOfConversation, worksFor } from "./tree";
import { botHere } from "../bots/here";
import { readProjects } from "../areas/projects";
import { commandTemporary } from "../fence/state";
import { askedAbout } from "../fence/policy";
import type { EngineAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import type { Target } from "../../shared/records";

/** A conversation where it is: its target, whether it's the coding agents', and what it is. */
export interface Conversation {
  target: Target;
  agents: boolean;
  data: EngineSession;
}

const ownEngine = (): Target | null => {
  try {
    const engine = readEngineFile();
    return engine?.port ? engine : null;
  } catch {
    return null;
  }
};

/** The conversation `session` is in (a subagent's, its own conversation's; a run the coding agents
 * have the engine make, the bridge's conversation it's for), on the engine or the coding agents'
 * bridge; null where it's on neither. */
export async function conversationOf(session: string, engine = ownEngine(), bridge = bridgeTarget()): Promise<Conversation | null> {
  return (await findConversation(session, engine, bridge)).at;
}

// Conversations as last found, so one the engine doesn't answer for a moment (busy, starting
// again) is still known: in Auto, what it asks meanwhile is held back, never left waiting for you.
const lastFound = new Map<string, Conversation>();

/** The conversation `session` is in, as `conversationOf` finds it; where the engine (or the bridge)
 * didn't answer, as it was last found, and `unreached` where it never was. */
export async function findConversation(session: string, engine = ownEngine(), bridge = bridgeTarget()): Promise<{ at: Conversation | null; unreached: boolean }> {
  let unreached = !engine;
  const found = await lookUp(session, engine, bridge, () => { unreached = true; });
  if (found) {
    if (lastFound.size >= 500) lastFound.delete(lastFound.keys().next().value!);
    lastFound.delete(session);
    lastFound.set(session, found);
    return { at: found, unreached: false };
  }
  const last = unreached ? lastFound.get(session) : undefined;
  return { at: last ?? null, unreached: unreached && !last };
}

async function lookUp(session: string, engine: Target | null, bridge: Target | null, unanswered: () => void): Promise<Conversation | null> {
  for (const [target, agents] of [[engine, false], [bridge, true]] as const) {
    if (!target) continue;
    // (One it doesn't have answers 404; anything else is the engine not answering.)
    const get = async (id: string) => (await engineGet(target, `api/session/${encodeURIComponent(id)}`).catch(error => {
      if (String((error as Error)?.message) !== "404") unanswered();
      return null;
    }) as EngineAnswer<EngineSession> | null)?.data ?? null;
    let data = await get(session);
    for (let up = 0; data?.parentID && up < 5; up++) data = await get(data.parentID) ?? data;
    const runFor = data?.metadata?.kuvo?.engineFor;
    if (!agents && bridge && typeof runFor === "string" && runFor !== data?.id) {
      const owner = await lookUp(runFor, null, bridge, unanswered);
      if (owner) return owner;
    }
    if (data?.id) return { target, agents, data };
  }
  return null;
}

/** What's decided about `action` in a conversation the engine didn't answer for, and the box hasn't
 * found before: held back for you to approve (code's lines still refused), as one the reviewer
 * couldn't judge; never left waiting for you, whatever its mode turns out to be. */
export async function heldUnreached(session: string, action: ReviewedAction, signal?: AbortSignal): Promise<Verdict & { paused?: boolean }> {
  const unanswered: SmallModel = async () => { throw new Error("the engine didn't answer"); };
  // (Its folder, the one its command was asked from, its commands' temporary folder and the files sent
  // with its messages are its own.)
  const own = [action.folder, commandTemporary(action.folder), ...attachedOf(session)].filter((each): each is string => Boolean(each));
  return review(action, { session, said: [] }, { model: unanswered, signal, own });
}

/** The bot whose conversation or work this is, and its goal while it has one running, with the
 * plan you approved by starting it (what it publishes or deploys there is what you asked for). */
function botOf(data: EngineSession): ReviewContext["bot"] | undefined {
  const bot = botOfConversation(data.id) ?? worksFor(data);
  if (!bot) return undefined;
  const running = runningGoal(bot.bot);
  const plan = running?.steps.map((step, at) => `${at + 1}. ${step.text}`).join(" ");
  const goal = running ? `${running.goal}${plan ? `\n(The plan the user approved by starting it: ${plan})` : ""}` : undefined;
  return { id: bot.bot, name: bot.name, ...(goal ? { goal } : {}) };
}

/** Whether a conversation, where it is, is in Full Access here now: nothing is reviewed or asked. */
export const inFullAccess = (at: Conversation): boolean =>
  approvalOf(at.data, { agents: at.agents, bot: Boolean(botOfConversation(at.data.id) ?? worksFor(at.data)) }).effective === "fullAccess";

/** Whether a conversation is in Auto, where its reviewer decides (as `reviewIn` finds it). */
export const inAuto = (at: Conversation): boolean => approvalOf(at.data, { agents: at.agents, bot: Boolean(botOf(at.data)) }).effective === "auto";

/** What you wrote in a conversation, oldest first: never what the box, another agent or a
 * wake-up put there. */
export async function yourMessages(at: Conversation, signal?: AbortSignal): Promise<string[]> {
  const page = await call(at.target, "GET", `/api/session/${encodeURIComponent(at.data.id)}/message?limit=60&order=desc`, undefined, signal).catch(() => null);
  const said: string[] = [];
  for (const message of Array.isArray(page) ? page : []) {
    if (!isObject(message) || message.type !== "user" || !writtenByYou(message.text, message.metadata)) continue;
    const text = String(message.text ?? "").trim();
    if (text) said.unshift(text);
  }
  return said;
}

// What makes a model its maker's small one, best first.
const SMALL = [/haiku/i, /luna/i, /flash-lite/i, /flash/i, /(^|[-_ ])mini\b/i, /(^|[-_ ])(nano|small|lite)\b/i];

/** The maker's small model, of those that can be used here: the provider's own, by its name; null
 * where it has none. */
export function smallModelOf(providerID: string, models: readonly Usable[]): Usable | null {
  const own = models.filter(each => each.providerID === providerID && !each.retiring);
  for (const pattern of SMALL) {
    const found = own.find(each => pattern.test(each.id) || pattern.test(each.name));
    if (found) return found;
  }
  return null;
}

/** The small model a conversation's reviews are asked on: its maker's small one, or where it has
 * none, the conversation's own; null where it has no model. */
export async function reviewModelOf(at: Conversation, signal?: AbortSignal): Promise<SmallModel> {
  const own = at.data.model;
  if (!own?.providerID || !own.id) return null;
  const models = await usableModels(at.agents ? null : at.target, at.agents ? at.target : null, signal).catch(() => [] as Usable[]);
  const picked = smallModelOf(own.providerID, models) ?? { providerID: own.providerID, id: own.id };
  const model = { providerID: picked.providerID, id: picked.id };
  return async (prompt, stop) => {
    const answer = at.agents
      ? await call(at.target, "POST", `/api/session/${encodeURIComponent(at.data.id)}/generate`, { prompt, model }, stop)
      : await call(at.target, "POST", "/api/experimental/generate", { prompt, model }, stop);
    const text = isObject(answer) && typeof answer.text === "string" ? answer.text : "";
    if (!text.trim()) throw new Error("the model answered nothing");
    return text;
  };
}

/** What Auto's reviewer decides about `action` in `session`'s conversation, where it's in Auto here
 * now; null where it isn't (what it asks goes to you, and in Full Access nothing asks: callers look
 * at `inFullAccess` first). A pause stops its run. `pin`: false where a script from the web it runs
 * can't be made the copy reviewed (`reviewer.ts`). */
export async function reviewIn(session: string, action: ReviewedAction, signal?: AbortSignal, found?: Conversation | null, pin = true): Promise<(Verdict & { paused?: boolean; conversation: Conversation }) | null> {
  const at = found === undefined ? await conversationOf(session) : found;
  if (!at) return null;
  const bot = botOf(at.data);
  if (!inAuto(at)) return null;
  // (In a bot's, what you wrote in its conversation counts beside its goal; in its work, what you
  // wrote to the bot too, which the work is for.)
  const own = bot && !botOfConversation(at.data.id) ? botHere(bot.id)?.session : undefined;
  const ownAt = own && own !== at.data.id ? await conversationOf(own).catch(() => null) : null;
  const said = [...(ownAt ? await yourMessages(ownAt, signal) : []), ...await yourMessages(at, signal)];
  const context: ReviewContext = { session: at.data.id, said, ...(bot ? { bot } : {}) };
  let verdict: Verdict & { paused?: boolean };
  try {
    verdict = await review(action, context, { model: await reviewModelOf(at, signal), signal, pin, own: ownFolders(at) });
  } catch (error) {
    // (Only when its log can't be kept, so there's nothing on it to approve.)
    return { decision: "refuse", reason: `Auto's reviewer couldn't review it (${oneLine(String((error as Error)?.message ?? error), 120)}).`, by: "code", held: false, why: "failed", conversation: at };
  }
  if (verdict.paused) {
    await stopSession(at.target, at.data.id, false).catch(() => {});
    // A bot's: on its goal's card too.
    if (bot) try { pauseGoal(bot.id, { why: REVIEW_PAUSE, session: at.data.id }); } catch {}
  }
  return { ...verdict, conversation: at };
}

/** What the agent is told of a refusal: why, that it goes on another way, and for one held back,
 * that you can approve it (and it'll hear when you do). */
export function refusalWords(verdict: Extract<Verdict, { decision: "refuse" }> & { paused?: boolean }): string {
  const paused = verdict.paused ? " Auto is paused here now: the user decides what's next." : "";
  return verdict.held
    ? `Auto's reviewer held this back: ${verdict.reason}${paused} Don't run it, nor get around the sandbox another way: carry on with the rest of the task another way, or without it. The user can approve it; if they do, you'll be told, and it will be allowed once.`
    : `Auto's reviewer refused: ${verdict.reason}${paused} Don't run it, nor get around it another way: carry on without it.`;
}

/** One held back that you approved, told to its conversation: it's allowed once now, should the
 * agent still need it. False where the conversation isn't here or can't be told. */
export async function tellApproved(session: string, decision: Decision, found?: Conversation | null): Promise<boolean> {
  const at = found === undefined ? await conversationOf(session) : found;
  if (!at) return false;
  const line = `You approved: ${decision.action}`;
  const text = `[The user approved what Auto's reviewer held back] ${decision.action}\nIt's allowed once now: run it again, the same way, if the task still needs it.`;
  return sendInto(at.target, at.data.id, { id: messageID(), text, delivery: "steer", metadata: boxNote("Your answer", line) }, { from: "Your answer", words: line }).then(() => true, () => false);
}

// The agent's own file tools, as their calls read (Claude Code's capitalised): which only read.
const READING = new Set(["read", "glob", "grep", "list", "ls", "view", "notebookread"]);
// Of those, the ones that read one file, as named.
const OWN_READING = new Set(["read", "view", "notebookread"]);
// Asks already taken up in this process (an event can come again as the stream reconnects).
const reviewing = new Set<string>();

/** How an ask to work outside a conversation's folder was taken up, as every client hears it
 * (`reviews` on `kuvo/sandbox/asks`): being checked by Auto's reviewer, allowed (by it, or in the
 * conversation's own project), held back for you to approve, refused, or left for you to answer.
 * `call`: the tool call it's for, whose step shows it. */
export interface AskReview {
  id: string;
  session: string;
  call?: string;
  state: "checking" | "allowed" | "heldBack" | "refused" | "yours";
  at: number;
}

// The latest two hundred, as they changed last: an ask's step shows how it went after it's answered.
// Past that, a decided one goes first, so one still checked or waiting on you stays listed.
const askReviews = new Map<string, AskReview>();
const reviewFollowers = new Set<() => void>();

export const listAskReviews = (): AskReview[] => [...askReviews.values()];

/** Tells `changed` each time an ask's review changes, until the function it returns is called. */
export function onAskReviewsChanged(changed: () => void): () => void {
  reviewFollowers.add(changed);
  return () => { reviewFollowers.delete(changed); };
}

function noteReview(id: string, session: string, state: AskReview["state"], call?: string): void {
  askReviews.delete(id);
  askReviews.set(id, { id, session, ...(call ? { call } : {}), state, at: Date.now() });
  if (askReviews.size > 200) {
    const decided = [...askReviews.values()].find(each => each.state !== "checking" && each.state !== "yours");
    askReviews.delete(decided?.id ?? askReviews.keys().next().value!);
  }
  for (const changed of reviewFollowers) changed();
}

/** A permission an engine (or the coding agents' bridge) asks in a conversation in Auto, taken up
 * by its reviewer: the agent's own file tools outside its folder (`external_directory`), by the
 * file the tool call names. Allowed, or refused with why for the agent, which goes on another way:
 * never left waiting for you. Anything that can't be read is left for you, and so is what your own
 * Settings › Permissions ask. */
export async function reviewPermission(source: Target, event: { type?: string; data?: { id?: unknown; sessionID?: unknown; action?: unknown } }, signal?: AbortSignal, found?: Conversation | null): Promise<Verdict | null> {
  const { id, sessionID } = event.data ?? {};
  if (event.type !== "permission.asked" || typeof id !== "string" || typeof sessionID !== "string" || reviewing.has(id)) return null;
  reviewing.add(id);
  if (reviewing.size > 500) reviewing.delete(reviewing.values().next().value!);
  // Listed as checked at once, before anything is read, so no client shows it meanwhile.
  if (event.data?.action === "external_directory") noteReview(id, sessionID, "checking");
  // (Taken up again as the event comes again, should this one fail; meanwhile it's yours.)
  try {
    return await answerPermission(source, id, sessionID, signal, found);
  } catch (error) {
    reviewing.delete(id);
    if (askReviews.has(id)) noteReview(id, sessionID, "yours", askReviews.get(id)?.call);
    throw error;
  }
}

/** Where the files sent with a conversation's messages are kept (in Kuvo Code's folders), its own. */
const attachedOf = (session: string): string[] => attachmentRoots().map(root => path.join(root, session));

/** The folders a conversation works in as its own: its project's, its commands' temporary folder
 * (their TMPDIR, in Kuvo Code's), the files sent with its messages (and with its parent's, for a
 * subagent's), and for a bot's conversation or work, the bot's own folder, the projects it made and
 * its running goal's. */
function ownFolders(at: Conversation): string[] {
  const folder = at.data.location?.directory;
  const folders = typeof folder === "string" ? [folder, commandTemporary(folder)].filter((each): each is string => Boolean(each)) : [];
  folders.push(...[at.data.id, at.data.parentID].filter((each): each is string => typeof each === "string").flatMap(attachedOf));
  const bot = botOfConversation(at.data.id) ?? worksFor(at.data);
  if (!bot) return folders;
  const own = botHere(bot.bot)?.folder;
  const made = readProjects().filter(project => !project.removed && project.madeBy?.bot === bot.bot).map(project => project.directory);
  return [...folders, ...(own ? [own] : []), ...made, ...(runningGoal(bot.bot)?.projects ?? [])];
}

/** Whether `file` is `folder` or in it, as the disk has them: links followed, as far as they exist. */
function isWithin(file: string, folder: string): boolean {
  const inside = path.relative(realPath(folder), realPath(file));
  return inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside));
}

function realPath(file: string): string {
  const rest: string[] = [];
  for (let at = path.resolve(file); ; ) {
    try {
      return path.join(fs.realpathSync(at), ...rest.reverse());
    } catch {
      const up = path.dirname(at);
      if (up === at) return path.resolve(file);
      rest.push(path.basename(at));
      at = up;
    }
  }
}

async function answerPermission(source: Target, id: string, sessionID: string, signal?: AbortSignal, found?: Conversation | null): Promise<Verdict | null> {
  const { permissions } = await asksIn(source, sessionID, signal);
  const permission = permissions.find(each => each.id === id && each.asker === sessionID);
  // (Anything else asked is your own rules'.)
  if (permission?.action !== "external_directory") return null;
  const seen = await callOf(source, permission, signal);
  const at = found === undefined ? await conversationOf(sessionID) : found;
  const folder = at?.data.location?.directory;
  const call = permission.call;
  if (!at || !folder) {
    noteReview(id, sessionID, "yours", call);
    return null;
  }
  // By the file its tool call names; where none does (Codex asks for room of its own, with no
  // tool call), by the paths the ask names, each judged as a write; where it names none, by
  // what it asked, as the model reads it.
  const file = seen && [seen.input.filePath, seen.input.file_path, seen.input.notebook_path, seen.input.path, seen.input.file].find((each): each is string => typeof each === "string" && each.startsWith("/"));
  // (Each as a command's path reads: \`~\` as your home, one not from \`/\` from its folder.)
  const named = permission.resources.filter(each => each !== "*").map(each => path.resolve(folder, each.replace(/^~(?=\/|$)/, homeFolder()).replace(/\/\*$/, "") || "/"));
  const actions: ReviewedAction[] = seen && file ? [{ kind: "file", path: file, access: READING.has(seen.tool.toLowerCase()) ? "read" : "write", folder, tool: seen.tool, input: seen.input }]
    : named.length ? named.map(each => ({ kind: "file" as const, path: each, access: "write" as const, folder }))
    : [{ kind: "tool", tool: seen?.tool || "work outside its folder", args: seen?.input ?? { asked: permission.resources }, folder }];
  // What its own tools read, one file at a time, of its commands' temporary files (a screenshot a
  // command took) and of the files sent with its messages is its own to read in any mode, as what's
  // in its folder is: never asked of you, nor reviewed. (By name first; then by where each really is,
  // so never through a link out of them. Not a tool that walks a folder, which could follow one.)
  const readsOwn = [commandTemporary(folder), ...[at.data.id, at.data.parentID].filter((each): each is string => typeof each === "string").flatMap(attachedOf)]
    .filter((each): each is string => Boolean(each));
  const ownReads = (within: (file: string, place: string) => boolean) => actions.every(action => action.kind === "file" && action.access === "read"
    && OWN_READING.has(String(action.tool).toLowerCase()) && readsOwn.some(place => within(action.path, place)));
  const ownByName = ownReads((file, place) => { const inside = path.relative(place, path.resolve(file)); return inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside)); });
  // (Else, outside Auto, it's yours as it is: nothing is opened for it, nor waits on macOS.)
  if (!ownByName && !inAuto(at)) {
    noteReview(id, sessionID, "yours", call);
    return null;
  }
  // (Each path macOS may ask about, asked off the box's thread first: a project on your Desktop.)
  await askedAbout([folder, ...actions.flatMap(action => action.kind === "file" ? [action.path] : [])]);
  if (ownByName && ownReads(isWithin)) {
    await engineCall(source, "POST", `/api/session/${encodeURIComponent(permission.asker)}/permission/${encodeURIComponent(permission.id)}/reply`, { decision: "once" }, signal);
    noteReview(id, sessionID, "allowed", call);
    return { decision: "allow", reason: "Its own files.", by: "code" };
  }
  // Its own project, and a bot's (one it made, its goal's), are its to work in as its folder is:
  // nothing there is reviewed, by where each path really is (a link to it, /tmp as /private/tmp).
  if (!inAuto(at)) {
    noteReview(id, sessionID, "yours", call);
    return null;
  }
  const reply = (body: Record<string, unknown>) => engineCall(source, "POST", `/api/session/${encodeURIComponent(permission.asker)}/permission/${encodeURIComponent(permission.id)}/reply`, body, signal);
  const own = ownFolders(at);
  if (actions.every(action => action.kind === "file" && own.some(folder => isWithin(action.path, folder)))) {
    await reply({ decision: "once" });
    noteReview(id, sessionID, "allowed", call);
    return { decision: "allow", reason: "Its own project.", by: "code" };
  }
  noteReview(id, sessionID, "checking", call);
  // (The engine runs a command it asked about itself: a script from the web in it can't be pinned
  // to the copy reviewed, so that one is held back. Of several paths, the first refused decides.)
  let verdict: Awaited<ReturnType<typeof reviewIn>> = null;
  for (const action of actions) {
    verdict = await reviewIn(sessionID, action, signal, at, false);
    if (!verdict || verdict.decision === "refuse") break;
  }
  if (!verdict) {
    noteReview(id, sessionID, "yours", call);
    return null;
  }
  await reply(verdict.decision === "allow" ? { decision: "once" } : { decision: "reject", message: refusalWords(verdict) });
  noteReview(id, sessionID, verdict.decision === "allow" ? "allowed" : verdict.held ? "heldBack" : "refused", call);
  return verdict;
}
