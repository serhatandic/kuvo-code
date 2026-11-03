// Auto's reviewer for a conversation here (`reviewer.ts` judges): which conversation an ask is in
// (a subagent's is its own conversation's), whether it's in Auto here now, what you said in it (or
// its bot's goal), and the small model of the maker it runs on: the engine's provider's own (its
// Haiku, Flash, mini…) through the engine, a coding agent's (Claude Code's Haiku, Codex's Luna)
// through the agents bridge, so it's counted on that account. One that isn't in Auto isn't
// reviewed: what it asks goes to you as before. A pause stops the conversation's run.

import { isObject } from "../../shared/json";
import { bridgeTarget, call, engineGet, readEngineFile } from "../engine/client";
import { stopSession, writtenByYou } from "../engine/queue";
import { approvalOf } from "./approval";
import { asksIn, callOf } from "./answers";
import { pauseGoal, REVIEW_PAUSE, runningGoal } from "./goals";
import { usableModels, type Usable } from "./models";
import { review, type ReviewedAction, type ReviewContext, type SmallModel, type Verdict } from "./reviewer";
import { botOfConversation, worksFor } from "./tree";
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

/** The conversation `session` is in (a subagent's, its own conversation's), on the engine or the
 * coding agents' bridge; null where it's on neither. */
export async function conversationOf(session: string, engine = ownEngine(), bridge = bridgeTarget()): Promise<Conversation | null> {
  for (const [target, agents] of [[engine, false], [bridge, true]] as const) {
    if (!target) continue;
    const get = async (id: string) => (await engineGet(target, `api/session/${encodeURIComponent(id)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data ?? null;
    let data = await get(session);
    for (let up = 0; data?.parentID && up < 5; up++) data = await get(data.parentID) ?? data;
    if (data?.id) return { target, agents, data };
  }
  return null;
}

/** The bot whose conversation or work this is, and its goal while it has one running. */
function botOf(data: EngineSession): ReviewContext["bot"] | undefined {
  const bot = botOfConversation(data.id) ?? worksFor(data);
  if (!bot) return undefined;
  const goal = runningGoal(bot.bot)?.goal;
  return { id: bot.bot, name: bot.name, ...(goal ? { goal } : {}) };
}

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
 * now; null where it isn't (what it asks goes to you). A pause stops its run. */
export async function reviewIn(session: string, action: ReviewedAction, signal?: AbortSignal, found?: Conversation | null): Promise<(Verdict & { paused?: boolean; conversation: Conversation }) | null> {
  const at = found === undefined ? await conversationOf(session) : found;
  if (!at) return null;
  const bot = botOf(at.data);
  if (approvalOf(at.data, { agents: at.agents, bot: Boolean(bot) }).effective !== "auto") return null;
  const context: ReviewContext = { session: at.data.id, said: bot ? [] : await yourMessages(at, signal), ...(bot ? { bot } : {}) };
  const verdict = await review(action, context, { model: await reviewModelOf(at, signal), signal });
  if (verdict.paused) {
    await stopSession(at.target, at.data.id, false).catch(() => {});
    // A bot's: on its goal's card too.
    if (bot) pauseGoal(bot.id, { why: REVIEW_PAUSE, session: at.data.id });
  }
  return { ...verdict, conversation: at };
}

// The agent's own file tools, as their calls read: which only read.
const READING = new Set(["read", "glob", "grep", "list", "ls", "view"]);
// Asks already taken up in this process (an event can come again as the stream reconnects).
const reviewing = new Set<string>();

/** A permission an engine (or the coding agents' bridge) asks in a conversation in Auto, taken up
 * by its reviewer: for now, the agent's own file tools outside its folder (`external_directory`),
 * by the file the tool call names. Allowed or refused here; one that comes to you is left asked,
 * with why in the conversation's log. Anything that can't be read is left for you. */
export async function reviewPermission(source: Target, event: { type?: string; data?: { id?: unknown; sessionID?: unknown; action?: unknown } }, signal?: AbortSignal, found?: Conversation | null): Promise<Verdict | null> {
  const { id, sessionID, action } = event.data ?? {};
  if (event.type !== "permission.asked" || action !== "external_directory" || typeof id !== "string" || typeof sessionID !== "string" || reviewing.has(id)) return null;
  reviewing.add(id);
  if (reviewing.size > 500) reviewing.delete(reviewing.values().next().value!);
  const { permissions } = await asksIn(source, sessionID, signal);
  const permission = permissions.find(each => each.id === id && each.asker === sessionID);
  const seen = permission ? await callOf(source, permission, signal) : null;
  const file = [seen?.input.filePath, seen?.input.path, seen?.input.file].find((each): each is string => typeof each === "string" && each.startsWith("/"));
  const at = found === undefined ? await conversationOf(sessionID) : found;
  if (!permission || !seen || !file || !at?.data.location?.directory) return null;
  const verdict = await reviewIn(sessionID, { kind: "file", path: file, access: READING.has(seen.tool) ? "read" : "write", folder: at.data.location.directory }, signal, at);
  if (!verdict || verdict.decision === "ask") return verdict;
  const reply = verdict.decision === "allow" ? { decision: "once" } : { decision: "reject", message: `Auto's reviewer: ${verdict.reason}` };
  await call(source, "POST", `/api/session/${encodeURIComponent(permission.asker)}/permission/${encodeURIComponent(permission.id)}/reply`, reply, signal);
  return verdict;
}
