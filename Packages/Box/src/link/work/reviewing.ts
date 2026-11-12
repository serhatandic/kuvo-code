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
import { review, clearPlaces, keptFromSessions, walledForOwn, type Decision, type ReviewedAction, type ReviewContext, type SmallModel, type Verdict } from "./reviewer";
import { botOfConversation, startedByOf, worksFor } from "./tree";
import { botHere } from "../bots/here";
import { readProjects } from "../areas/projects";
import { commandTemporary } from "../fence/state";
import { askedAbout, fencePolicy } from "../fence/policy";
import { inTime, projectWorktrees } from "./project-trees";
import { foundAt } from "./found-folders";
export { noteFolderFound } from "./found-folders";
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
  if (!inAuto(at)) {
    // (Out of Auto, the folders it allowed edits in go with it.)
    try { clearPlaces(at.data.id); } catch {}
    return null;
  }
  // (In a bot's, what you wrote in its conversation counts beside its goal; in its work, what you
  // wrote to the bot too, which the work is for.)
  const own = bot && !botOfConversation(at.data.id) ? botHere(bot.id)?.session : undefined;
  const ownAt = own && own !== at.data.id ? await conversationOf(own).catch(() => null) : null;
  const said = [...(ownAt ? await yourMessages(ownAt, signal) : []), ...await yourMessages(at, signal)];
  const [folders, task] = await Promise.all([workFolders(at), taskOf(at, signal)]);
  const context: ReviewContext = { session: at.data.id, said, ...(bot ? { bot } : {}), ...(folders.length ? { folders } : {}), ...(task ? { task } : {}) };
  let verdict: Verdict & { paused?: boolean };
  try {
    verdict = await review(action, context, { model: await reviewModelOf(at, signal), signal, pin, own: await ownFolders(at) });
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
// Asks already taken up in this process, with how each went (an event can come again as the stream
// reconnects, or while the asks waiting as it did are taken up: it's answered as the first was, so
// no notice goes to your phones for one the reviewer is deciding).
const reviewing = new Map<string, Promise<Verdict | null>>();

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

/** An ask Auto's reviewer took up that's over without its word (`settled` on `kuvo/sandbox/asks`,
 * `sandbox.reviews.settled`): still checked or left for you when it was `answered` (by you, on any
 * client, or by its engine) or `gone` (its run ended, its session was deleted, or its engine let it
 * go while the box wasn't listening), so no client takes it for one that waits. */
export interface SettledReview {
  id: string;
  session: string;
  call?: string;
  state: "answered" | "gone";
  at: number;
}

// The latest two hundred, as they changed last: an ask's step shows how it went after it's answered.
// Past that, a decided one goes first, so one still checked or waiting on you stays listed.
const askReviews = new Map<string, AskReview>();
// Those still checked or left for you that were answered or went since, the latest two hundred.
const settledReviews = new Map<string, SettledReview>();
// The place each ask still checked or left for you was asked on ("engine", "bridge"), which looks
// for it again as the box hears that place again.
const askedOn = new Map<string, string>();
const reviewFollowers = new Set<() => void>();

export const listAskReviews = (): AskReview[] => [...askReviews.values()];
export const listSettledReviews = (): SettledReview[] => [...settledReviews.values()];

/** Whether an ask Auto's reviewer took up is over (answered or gone): nothing to tell of it. */
export const isOver = (id: unknown): boolean => typeof id === "string" && settledReviews.has(id);

// The asks the reviewer is answering now, whose answer's event is its own; true once one came, which
// is someone else's should its own answer not go.
const replying = new Map<string, boolean>();

const waitsOnReview = (review: AskReview | undefined) => review?.state === "yours" || review?.state === "checking";

function settle(reviews: AskReview[], state: SettledReview["state"]): void {
  if (!reviews.length) return;
  for (const { id, session, call } of reviews) {
    askReviews.delete(id);
    askedOn.delete(id);
    settledReviews.delete(id);
    settledReviews.set(id, { id, session, ...(call ? { call } : {}), state, at: Date.now() });
    if (settledReviews.size > 200) settledReviews.delete(settledReviews.keys().next().value!);
  }
  for (const changed of reviewFollowers) changed();
}

/** An ask answered (here, on a client, by the reviewer): one left for you, or still checked, is
 * listed `answered` from now on, so what's listed as waiting is what waits; what the reviewer
 * decided stays, for the mark on its step. */
export function settleAskReview(id: string): void {
  // (The reviewer's own answer: what it decided is listed as it notes it.)
  if (replying.has(id)) {
    replying.set(id, true);
    return;
  }
  const review = askReviews.get(id);
  if (waitsOnReview(review)) settle([review!], "answered");
}

/** A run's end (or its session deleted), which takes what it asked with it, without a word of each:
 * its asks left for you or still checked are listed `gone`. */
export function settleRunReviews(session: string): void {
  settle([...askReviews.values()].filter(each => each.session === session && waitsOnReview(each)), "gone");
}

/** A place heard again (`place`: "engine", "bridge"), whose asks may have gone while the box wasn't
 * listening (its engine started again, a run ended unheard): each still checked or left for you
 * there, noted by `since`, that its session no longer asks is `gone`. One whose session
 * couldn't be read stays as it was. */
async function settleGoneReviews(source: Target, place: string, since: number, signal?: AbortSignal): Promise<void> {
  const looked = [...askReviews.values()].filter(each => waitsOnReview(each) && each.at <= since && askedOn.get(each.id) === place);
  const gone: AskReview[] = [];
  // (Each session's asks read once; one deleted meanwhile asks nothing.)
  for (const session of new Set(looked.map(each => each.session))) {
    if (signal?.aborted) return;
    const listed = await call(source, "GET", `/api/session/${encodeURIComponent(session)}/permission`, undefined, signal)
      .catch(error => ((error as { status?: number } | null)?.status === 404 ? [] : null));
    if (!Array.isArray(listed)) continue;
    const asked = new Set(listed.filter(isObject).map(each => each.id));
    // (Noted again meanwhile, as it's taken up again: it's that one's.)
    gone.push(...looked.filter(each => each.session === session && !asked.has(each.id) && askReviews.get(each.id) === each));
  }
  settle(gone, "gone");
}

/** Tells `changed` each time an ask's review changes, until the function it returns is called. */
export function onAskReviewsChanged(changed: () => void): () => void {
  reviewFollowers.add(changed);
  return () => { reviewFollowers.delete(changed); };
}

/** `fresh`: as it's heard (or found waiting); otherwise one answered or gone meanwhile stays so,
 * never checked or left for you again, and only what the reviewer decided is noted. (One that
 * just fell off the list, past two hundred, is listed again.) */
function noteReview(id: string, session: string, state: AskReview["state"], call?: string, place?: string, fresh = false): void {
  const waiting = state === "checking" || state === "yours";
  if (waiting && !fresh && settledReviews.has(id)) return;
  askReviews.delete(id);
  settledReviews.delete(id);
  askReviews.set(id, { id, session, ...(call ? { call } : {}), state, at: Date.now() });
  if (place) askedOn.set(id, place);
  if (state !== "checking" && state !== "yours") askedOn.delete(id);
  if (askReviews.size > 200) {
    const decided = [...askReviews.values()].find(each => each.state !== "checking" && each.state !== "yours");
    const dropped = decided?.id ?? askReviews.keys().next().value!;
    askReviews.delete(dropped);
    askedOn.delete(dropped);
  }
  for (const changed of reviewFollowers) changed();
}

/** A permission an engine (or the coding agents' bridge) asks in a conversation in Auto, taken up
 * by its reviewer: the agent's own file tools outside its folder (`external_directory`), by the
 * file the tool call names. Allowed, or refused with why for the agent, which goes on another way:
 * never left waiting for you. Anything that can't be read is left for you, and so is what your own
 * Settings › Permissions ask. */
export async function reviewPermission(source: Target, event: { type?: string; data?: { id?: unknown; sessionID?: unknown; action?: unknown } }, signal?: AbortSignal, found?: Conversation | null, place?: string): Promise<Verdict | null> {
  const { id, sessionID } = event.data ?? {};
  if (event.type !== "permission.asked" || typeof id !== "string" || typeof sessionID !== "string") return null;
  const taken = reviewing.get(id);
  if (taken) return taken;
  // Listed as checked at once, before anything is read, so no client shows it meanwhile.
  if (event.data?.action === "external_directory") noteReview(id, sessionID, "checking", undefined, place, true);
  // (Taken up again as the event comes again, should this one fail; meanwhile it's yours.)
  const answering = answerPermission(source, id, sessionID, signal, found).catch(error => {
    reviewing.delete(id);
    if (askReviews.has(id)) noteReview(id, sessionID, "yours", askReviews.get(id)?.call);
    throw error;
  });
  reviewing.set(id, answering.catch(() => null));
  if (reviewing.size > 500) reviewing.delete(reviewing.keys().next().value!);
  return answering;
}

/** The asks to work outside a folder already waiting as the box (re)connects to an engine or the
 * bridge (`place`: "engine", "bridge"), in the sessions at work there (an ask holds its session's
 * run): taken up as they would have been as they came, so the box lists each one, as
 * `sandbox.reviews.whole` says (one asked while it was starting again, or whose event went by
 * unheard). And each it listed as still checked or left for you there that's no longer asked (its
 * engine started again, its run ended unheard) is listed `gone`. */
export async function takeUpWaitingAsks(source: Target, sessions: string[], signal?: AbortSignal, place?: string): Promise<void> {
  const since = Date.now();
  const waiting: { id: string; asker: string; action: string }[] = [];
  for (const session of sessions) {
    if (signal?.aborted) return;
    const { permissions } = await asksIn(source, session, signal).catch(() => ({ permissions: [] as { id: string; asker: string; action: string }[] }));
    for (const each of permissions) {
      // (One listed as over that its engine still asks waits after all: taken up again.)
      if (each.action === "external_directory" && settledReviews.has(each.id)) reviewing.delete(each.id);
      if (each.action !== "external_directory" || reviewing.has(each.id) || askReviews.has(each.id)) continue;
      // Listed as checked at once, all of them, before any is read.
      noteReview(each.id, each.asker, "checking", undefined, place, true);
      waiting.push(each);
    }
  }
  if (place) await settleGoneReviews(source, place, since, signal);
  for (const each of waiting) {
    await reviewPermission(source, { type: "permission.asked", data: { id: each.id, sessionID: each.asker, action: each.action } }, signal, undefined, place).catch(() => null);
  }
}

/** Where the files sent with a conversation's messages are kept (in Kuvo Code's folders), its own. */
const attachedOf = (session: string): string[] => attachmentRoots().map(root => path.join(root, session));

/** The folders a conversation works in as its own: its project's, its commands' temporary folder
 * (their TMPDIR, in Kuvo Code's), the files sent with its messages (and with its parent's, for a
 * subagent's), its project's worktrees (`projectTrees`), and for a bot's conversation or work, the
 * bot's own folder, the projects it made and its running goal's. */
async function ownFolders(at: Conversation, withTrees = true): Promise<string[]> {
  const folder = at.data.location?.directory;
  const folders = typeof folder === "string" ? [folder, commandTemporary(folder)].filter((each): each is string => Boolean(each)) : [];
  folders.push(...[at.data.id, at.data.parentID].filter((each): each is string => typeof each === "string").flatMap(attachedOf));
  if (typeof folder === "string" && withTrees) folders.push(...await projectTrees(folder));
  const bot = botOfConversation(at.data.id) ?? worksFor(at.data);
  if (!bot) return folders;
  const own = botHere(bot.bot)?.folder;
  const made = readProjects().filter(project => !project.removed && project.madeBy?.bot === bot.bot).map(project => project.directory);
  return [...folders, ...(own ? [own] : []), ...made, ...(runningGoal(bot.bot)?.projects ?? [])];
}

/** A conversation's project's linked worktrees, wherever they are, where it works in the project's
 * main folder (`projectWorktrees`), by their real paths as found: its own, as its folder is. But
 * where an agent in Auto couldn't start a session either (`keptFromSessions`: your home, a whole
 * personal folder, your secrets, what runs at login, ~/Library), and Kuvo Code's own (another
 * session's worktree there), each judged as before. */
async function projectTrees(folder: string): Promise<string[]> {
  // (Worked out once for the asks of a moment: an ask is looked at several times as it's judged.)
  const known = treesFound.get(folder);
  if (known && Date.now() - known.at < TREES_FOR) return known.trees;
  const trees = foundTrees(folder).catch(() => [] as string[]);
  treesFound.set(folder, { at: Date.now(), trees });
  if (treesFound.size > 100) treesFound.delete(treesFound.keys().next().value!);
  return trees;
}
const treesFound = new Map<string, { at: number; trees: Promise<string[]> }>();
const TREES_FOR = 5_000;

async function foundTrees(folder: string): Promise<string[]> {
  const trees = await inTime(projectWorktrees(folder), []);
  if (!trees.length) return [];
  const policy = fencePolicy();
  const flags = process.platform === "darwin" ? "i" : "";
  // (In one of Kuvo Code's folders named by pattern, or one that holds the folders those are in.)
  const ours = (tree: string) => policy.kuvo.some(wall => tree === wall || tree.startsWith(wall + "/") || wall.startsWith(tree + "/"))
    || policy.kuvoPatterns.some(pattern => new RegExp(pattern, flags).test(tree + "/"))
    || (policy.patternFolders ?? []).some(pattern => holdsMatch(tree, pattern, flags));
  const kept = await Promise.all(trees.map(tree => ours(tree) ? Promise.resolve("Kuvo Code's own") : keptFromSessions(tree, policy)));
  return trees.filter((_, at) => !kept[at]);
}

/** Whether `tree` is, or holds, a folder `pattern` names (a whole path, a name a part: `^/a/[^/]+/b$`). */
function holdsMatch(tree: string, pattern: string, flags: string): boolean {
  const parts = pattern.replace(/^\^/, "").replace(/\$$/, "").replaceAll("[^/]+", "\0").split("/").slice(1).map(part => part.replaceAll("\0", "[^/]+"));
  const names = tree.split("/").slice(1);
  return names.length <= parts.length && names.every((name, at) => new RegExp(`^(?:${parts[at]})$`, flags).test(name));
}

/** Where a conversation works as its own, for its reviewer to judge by: its folder first, then its
 * project's other folders and worktrees. */
async function workFolders(at: Conversation): Promise<string[]> {
  const folder = at.data.location?.directory;
  if (typeof folder !== "string") return [];
  const others = readProjects().find(project => project.directory === folder)?.folders ?? [];
  return [...new Set([folder, ...others, ...await projectTrees(folder)])];
}

/** The task another agent started a conversation with (its first message, the letter from the one
 * that started it, `kuvo.startedBy`): that agent's name and words; none for one you started. */
async function taskOf(at: Conversation, signal?: AbortSignal): Promise<ReviewContext["task"]> {
  const starter = startedByOf(at.data);
  if (!starter) return undefined;
  const page = await call(at.target, "GET", `/api/session/${encodeURIComponent(at.data.id)}/message?limit=5&order=asc`, undefined, signal).catch(() => null);
  const first = (Array.isArray(page) ? page : []).find(message => isObject(message) && message.type === "user");
  const text = isObject(first) ? String(first.text ?? "") : "";
  const head = /^\[Message from (.{1,200}?) · (ses_[A-Za-z0-9_-]+)\][^\n]*\n\n/.exec(text);
  return head && head[2] === starter ? { from: head[1], text: text.slice(head[0].length) } : undefined;
}

// The tools that run a command (asked about the folders it names, its writes the sandbox's).
const RUNNING = new Set(["bash", "shell", "command", "exec", "local_shell", "terminal"]);

/** What a tool call changes, each by its path as given (`raw`) and as the engine takes it (from the
 * conversation's `folder`; `~` your home): every value of an argument that's a path, however deep
 * in it (a key the engine doesn't write to today might be one tomorrow), as a file or a folder; and
 * a patch tool's headers, read as the engine reads them (each line without its last \r, trimmed).
 * A tool that runs a command, nothing here (its folders, from the ask). */
function changedBy(seen: { tool: string; input: Record<string, unknown> }, folder: string): { raw: string; path: string; folder: boolean | null }[] | null {
  const tool = seen.tool.toLowerCase();
  if (RUNNING.has(tool)) return null;
  const named: { raw: string; folder: boolean | null }[] = [];
  const walk = (value: unknown, key: string, depth: number) => {
    // (Deeper than looked into: something no path of its own has, so it's never one.)
    if (depth > 6) { named.push({ raw: "\0", folder: false }); return; }
    if (typeof value === "string") {
      if (PATH_KEY.test(key)) named.push({ raw: value, folder: null });
      // A patch tool's text: the files its headers name.
      if (PATCHING.has(tool) && /^patch(text)?$/i.test(key)) {
        for (const line of value.split("\n").map(each => each.replace(/\r$/, "").trim())) {
          const header = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.*)$/s.exec(line);
          const each = header?.[1]?.trim();
          if (each) named.push({ raw: each, folder: false });
        }
      }
    } else if (Array.isArray(value)) for (const each of value) walk(each, key, depth + 1);
    else if (isObject(value)) for (const [inner, each] of Object.entries(value)) walk(each, PATH_KEY.test(inner) || !PATH_KEY.test(key) ? inner : key, depth + 1);
  };
  for (const [key, value] of Object.entries(seen.input)) walk(value, key, 0);
  return named.map(({ raw, folder: asFolder }) => ({ raw, path: path.resolve(folder, raw.replace(/^~(?=\/|$)/, homeFolder())), folder: asFolder }));
}

// The tools that patch, and the arguments that name a place, by their keys (`filePath`, `files`,
// `destination`, `move_path`, `outputDir`, `cwd`…).
const PATCHING = new Set(["patch", "apply_patch", "applypatch"]);
const PATH_KEY = /path|file|dir|folder|destination|save_?as|^(dest|dst|src|source|from|to|target|output|out|location|cwd|workdir|movedto|root|uri|url|name)$/i;
// The tools whose changes may be its own by code: the engine's and the coding agents' that write
// files (the engine's write, edit and patch; Claude Code's Write, Edit, MultiEdit and NotebookEdit;
// Codex's changes), besides those that only read and those that run a command (by their folders).
const WRITING = new Set(["write", "edit", "multiedit", "patch", "apply_patch", "applypatch", "notebookedit"]);

/** Whether a name is what it looks like, on any disk: composed (NFC), and folding by case to what it
 * folds to lower-case (a Mac's disk takes `ſ` for `s`, the Kelvin sign for `k`). */
const plainName = (raw: string) => raw === raw.normalize("NFC") && raw.toUpperCase().toLowerCase() === raw.toLowerCase();

// What no path of its own has in it: control characters and the line and paragraph separators a
// reader might split on and the engine doesn't (`\r`, U+2028…).
// (And those a disk may skip as it compares names, as HFS+ does: a joiner in `opencode.j\u200dson`
// would be `opencode.json` there; a direction mark would make it read otherwise.)
const UNPLAIN = /[\x00-\x1f\x7f\u0085\u2028\u2029\\]|\p{Default_Ignorable_Code_Point}/u;

/** Where `file` really is, where it's reached plainly from the folder whose real path is `folder`:
 * one of the folders it's named through leads to `folder` itself, and below that no part of it is
 * a link, each folder a folder, and the file, where it's there, a file with no other name (a hard
 * link to one elsewhere would be written there too; so a package manager's hard-linked files are
 * the reviewer's), or with `asFolder` a folder (`null`: either, as it is). What isn't there yet is made where it's named. Null otherwise: a link anywhere below, one that leads nowhere yet, `..` in it. (Checked as
 * it's asked: what a command changes between the answer and the write isn't.) */
function plainlyIn(file: string, folder: string, asFolder: boolean | null = false): string | null {
  if (!path.isAbsolute(file) || file.split("/").includes("..")) return null;
  const parts = path.resolve(file).split("/");
  for (let top = 1; top <= parts.length; top++) {
    const named = parts.slice(0, top).join("/") || "/";
    let real: string;
    try { real = fs.realpathSync(named); } catch { return null; }
    if (real !== folder) continue;
    // (Below the place, each name as it looks: the place's own the box found itself.)
    if (!parts.slice(top).every(plainName)) return null;
    for (let at = top; at < parts.length; at++) {
      let kind: fs.Stats;
      try { kind = fs.lstatSync(parts.slice(0, at + 1).join("/")); }
      catch (error) {
        // (Not there yet: made where it's named. Anything else that can't be looked at isn't plain.)
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") break;
        return null;
      }
      if (kind.isSymbolicLink()) return null;
      const last = at === parts.length - 1;
      // (The last a folder for a folder asked about; a file for a file; either, as it is, for one
      // the ask leaves open.)
      const asDirectory = !last || asFolder === true || (asFolder === null && kind.isDirectory());
      if (asDirectory ? !kind.isDirectory() : !kind.isFile() || kind.nlink !== 1) return null;
    }
    return path.join(folder, ...parts.slice(top));
  }
  return null;
}

/** Whether the real path `file` is the real path `folder` or in it. */
function within(file: string, folder: string): boolean {
  const inside = path.relative(folder, file);
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
  let { permissions } = await asksIn(source, sessionID, signal);
  let permission = permissions.find(each => each.id === id && each.asker === sessionID);
  // Not listed: read once more a moment later (its engine slow to answer), before it's taken as
  // answered meanwhile or unreadable.
  if (!permission) {
    await new Promise(done => setTimeout(done, 1_000));
    ({ permissions } = await asksIn(source, sessionID, signal));
    permission = permissions.find(each => each.id === id && each.asker === sessionID);
  }
  // Still not listed: never left checked, which no client would show. Gone, where its session's
  // asks were read and it isn't among them (answered meanwhile, or gone with its run); else yours,
  // as an ask it doesn't take up is.
  if (!permission) {
    if (askReviews.get(id)?.state === "checking") {
      // (Its session deleted meanwhile asks nothing.)
      const own = await engineCall(source, "GET", `/api/session/${encodeURIComponent(sessionID)}/permission`, undefined, signal)
        .catch(error => ((error as { status?: number } | null)?.status === 404 ? [] : null));
      const now = askReviews.get(id);
      if (now?.state !== "checking") return null;
      if (Array.isArray(own) && !own.some(each => isObject(each) && each.id === id)) settle([now], "gone");
      else noteReview(id, sessionID, "yours", now.call);
    }
    return null;
  }
  // (Anything else asked is your own rules'.)
  if (permission.action !== "external_directory") return null;
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
    try { clearPlaces(at.data.id); } catch {}
    noteReview(id, sessionID, "yours", call);
    return null;
  }
  // Its answer, and how it decided, listed as it answers (its answer's event isn't taken for yours).
  const reply = async (body: Record<string, unknown>, decided: AskReview["state"]) => {
    replying.set(id, false);
    try {
      await engineCall(source, "POST", `/api/session/${encodeURIComponent(permission.asker)}/permission/${encodeURIComponent(permission.id)}/reply`, body, signal);
      noteReview(id, sessionID, decided, call);
    } catch (error) {
      // (Answered elsewhere meanwhile: so it's listed.)
      if (replying.get(id)) {
        replying.delete(id);
        settleAskReview(id);
      }
      throw error;
    } finally {
      replying.delete(id);
    }
  };
  // (Each path macOS may ask about, asked off the box's thread first: a project on your Desktop.)
  await askedAbout([folder, ...actions.flatMap(action => action.kind === "file" ? [action.path] : [])]);
  if (ownByName && ownReads((file, place) => within(realPath(file), foundAt(place)))) {
    await reply({ decision: "once" }, "allowed");
    return { decision: "allow", reason: "Its own files.", by: "code" };
  }
  // Its own project, and a bot's (one it made, its goal's), are its to work in as its folder is:
  // nothing there is reviewed, by where each path really is (a link to it, /tmp as /private/tmp).
  if (!inAuto(at)) {
    noteReview(id, sessionID, "yours", call);
    return null;
  }
  // Its own folders and its project's worktrees, each by where it was found (a worktree as found, its
  // own folders as first seen), a file in one allowed only as reached plainly (`plainlyIn`: no link
  // on the way down, nor `..`, a file of one name only), and never what's walled from its own
  // wherever it is (`walledForOwn`). Anything else is the reviewer's.
  const own = await ownFolders(at, false);
  await askedAbout(own);
  const trees = typeof folder === "string" ? await projectTrees(folder) : [];
  const policy = fencePolicy();
  const places = [...own.map(foundAt), ...trees];
  // What it changes, all of it its own, reached plainly (`plainlyIn`): every resource the engine
  // asks about (the authority: its own reading of the call; `…/*` a folder, else a file, or a folder
  // where one is), the file it says it asks about, and every file the tool call names (its
  // arguments, a patch's headers). None that climbs (`..`) or has a character no path of its own
  // has; never on nothing named, nor `*`.
  const resolve = (raw: string) => path.resolve(folder, raw.replace(/^~(?=\/|$)/, homeFolder()));
  const resources = permission.resources.map(raw => ({ raw, path: resolve(raw.replace(/\/\*$/, "") || "/"), folder: raw.endsWith("/*") ? true : null }));
  const changes = [...resources, ...(permission.filepath ? [{ raw: permission.filepath, path: resolve(permission.filepath), folder: false as boolean | null }] : []),
    ...(seen ? changedBy(seen, folder) ?? [] : [])];
  // (A call the ask names that couldn't be read, or the image tool, which writes by another name
  // than the one it's given: never its own by code.)
  const unread = Boolean(permission.call) && !seen;
  const renames = seen?.tool.toLowerCase() === "experimental_image_generate";
  const plainly = (change: { path: string; folder: boolean | null }) => places.some(place => {
    const real = plainlyIn(change.path, place, change.folder);
    return real !== null && !walledForOwn(real, policy, own);
  });
  // (Only a tool known to write, read or run a command; only resources named from `/`; never a name
  // that's other than it looks once composed or cased as a Mac's disk does, `opencode.jſon`.)
  const known = !seen || [WRITING, READING, RUNNING].some(each => each.has(seen.tool.toLowerCase()));
  const ownChanges = known && !unread && !renames && resources.length > 0 && permission.resources.every(each => each.startsWith("/"))
    && changes.every(each => !each.raw.split("/").includes("..") && !UNPLAIN.test(each.raw) && plainly(each))
    && actions.every(action => action.kind === "file");
  if (ownChanges) {
    await reply({ decision: "once" }, "allowed");
    return { decision: "allow", reason: "Its own project.", by: "code" };
  }
  noteReview(id, sessionID, "checking", call);
  // (Answered or gone meanwhile, its run stopped, say: nothing to review.)
  if (!askReviews.has(id)) return null;
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
  await reply(verdict.decision === "allow" ? { decision: "once" } : { decision: "reject", message: refusalWords(verdict) }, verdict.decision === "allow" ? "allowed" : verdict.held ? "heldBack" : "refused");
  return verdict;
}
