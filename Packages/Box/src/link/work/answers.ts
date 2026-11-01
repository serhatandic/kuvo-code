// A bot answering what its sessions ask (answer_ask, PROTOCOL.md "Work"): a permission it may allow
// only where it could go ahead itself (the engine's rules for its own conversation allow it, part
// by part) and what it allows reads as safe (`policy.ts`: what it can't tell is safe, pushing,
// publishing, deploying and deleting outside the project come to you), and saying no is always its
// to do. An ask one of a session's subagents makes is the
// session's. Each answer is kept on the session (`kuvo.answers`), for every client to show it on
// the step that asked ("Allowed by Pixel") and in the bot's work. A question it answers in words.

import path from "node:path";
import { isObject } from "../../shared/json";
import { call } from "../engine/client";
import { stopSession } from "../engine/queue";
import { lockedWhile } from "../files";
import { homeFolder } from "../home";
import { permissionsHere } from "../bots/tell";
import { describePermission } from "../notices/news";
import { WORK_FOLDER } from "./changes";
import type { Target } from "../../shared/records";
import type { WorkAnswer } from "../../shared/routes/work";
import type { KitRule } from "../bots/kit";
import type { EngineSession } from "../engine/sessions";

// A rule's resource as the engine matches it: `*` any text, `?` one character.
const matches = (pattern: string, resource: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, ".")}$`).test(resource);

/** What `rules` say for `action` on `resource`: the last that matches wins, and none matching lets
 * it through. */
export function ruleFor(rules: readonly KitRule[], action: string, resource: string): KitRule["effect"] {
  let effect: KitRule["effect"] = "allow";
  for (const rule of rules) if ((rule.action === action || rule.action === "*") && matches(rule.resource, resource)) effect = rule.effect;
  return effect;
}

/** The engine's own, before Settings › Permissions (its default agent's): reading a `.env` file
 * asks (not `.env.example`), a folder outside the project asks, and so does carrying on after
 * failing again and again. */
const ENGINE_DEFAULTS: KitRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "doom_loop", resource: "*", effect: "ask" },
];

/** The rules a conversation goes by, as the engine applies them: its defaults, this box's Settings ›
 * Permissions, then the conversation's own. */
export const rulesOf = (own: readonly KitRule[]): KitRule[] => [...ENGINE_DEFAULTS, ...(permissionsHere() ?? []), ...own];


/** A permission a session asks (it, or one of its subagents: `asker`), as the engine lists it. */
export interface PendingPermission {
  id: string;
  asker: string;
  action: string;
  resources: string[];
  call?: string;
  /** The message its tool call is in. */
  message?: string;
  /** The coding agents' bridge says the agent asking runs in the box's sandbox now (its whole
   * program, so its commands too). The engine says nothing: its own state does. */
  sandboxed?: boolean;
}

/** A tool call, as the engine keeps it in its message: its tool and its whole input. */
export interface ToolCallSeen {
  tool: string;
  input: Record<string, unknown>;
}

/** The tool call a permission asks for (`call` in `message`, of `asker`), whole: never only the
 * parts the engine lists in the ask (it leaves out a command's `cd`), so what's judged is what
 * would run. Null when it can't be found. */
export async function callOf(target: Target, permission: Pick<PendingPermission, "asker" | "call" | "message">, signal?: AbortSignal): Promise<ToolCallSeen | null> {
  if (!permission.call) return null;
  const page = await call(target, "GET", `/api/session/${encodeURIComponent(permission.asker)}/message?limit=30&order=desc`, undefined, signal).catch(() => null);
  for (const message of Array.isArray(page) ? page : []) {
    if (!isObject(message) || (permission.message && message.id !== permission.message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isObject(part) || part.type !== "tool" || part.id !== permission.call) continue;
      const state = isObject(part.state) ? part.state : {};
      return { tool: String(part.name ?? ""), input: isObject(state.input) ? state.input as Record<string, unknown> : {} };
    }
  }
  return null;
}

/** A question a session asks (it, or a subagent: `asker`): its one field's key. */
export interface PendingQuestion {
  id: string;
  asker: string;
  key: string | null;
  text: string;
}

/** The session and its subagents (theirs too, a few levels down), which ask in its name. */
export async function askersOf(target: Target, session: string, signal?: AbortSignal): Promise<string[]> {
  const found = [session];
  for (let at = 0; at < found.length && at < 40; at++) {
    if (at > 0 && found.length > 30) break;
    const listed = await call(target, "GET", `/api/session?limit=50&order=desc&parentID=${encodeURIComponent(found[at])}`, undefined, signal).catch(() => null);
    for (const child of Array.isArray(listed) ? listed : []) if (isObject(child) && typeof child.id === "string" && child.parentID === found[at] && !found.includes(child.id)) found.push(child.id);
  }
  return found;
}

/** What `session` (or one of its subagents) asks now: its permissions and questions. */
export async function asksIn(target: Target, session: string, signal?: AbortSignal): Promise<{ permissions: PendingPermission[]; questions: PendingQuestion[] }> {
  const permissions: PendingPermission[] = [];
  const questions: PendingQuestion[] = [];
  for (const asker of await askersOf(target, session, signal)) {
    const at = `/api/session/${encodeURIComponent(asker)}`;
    const listed = await call(target, "GET", `${at}/permission`, undefined, signal).catch(() => null);
    for (const each of Array.isArray(listed) ? listed : []) {
      if (!isObject(each) || typeof each.id !== "string") continue;
      const resources = Array.isArray(each.resources) ? each.resources.filter((one: unknown): one is string => typeof one === "string") : [];
      const source = isObject(each.source) ? each.source : null;
      permissions.push({ id: each.id, asker, action: String(each.action ?? ""), resources, ...(typeof source?.id === "string" ? { call: source.id } : {}), ...(typeof source?.messageID === "string" ? { message: source.messageID } : {}), ...(each.sandboxed === true ? { sandboxed: true } : {}) });
    }
    const forms = await call(target, "GET", `${at}/form`, undefined, signal).catch(() => null);
    for (const form of Array.isArray(forms) ? forms : []) {
      if (!isObject(form) || typeof form.id !== "string") continue;
      const fields = (Array.isArray(form.fields) ? form.fields : []).filter((field: unknown) => isObject(field) && !field.hidden && !(Array.isArray(field.when) && field.when.length));
      const one = fields.length === 1 && fields[0].type === "string" ? fields[0] : null;
      questions.push({ id: form.id, asker, key: typeof one?.key === "string" ? one.key : null, text: String(one?.description || one?.title || form.title || "a question") });
    }
  }
  return { permissions, questions };
}

/** Archived while it waits on you (a permission or a question, its subagents' too): its run stops,
 * as a bot's Stop and Archive has it, rather than wait out of sight for an answer no one sees (and
 * keep counting on the Dock). One that waits on nothing goes on. Whether it was stopped. */
export async function stopIfWaiting(target: Target, session: string): Promise<boolean> {
  const { permissions, questions } = await asksIn(target, session).catch(() => ({ permissions: [], questions: [] }));
  if (!permissions.length && !questions.length) return false;
  return stopSession(target, session, false).then(() => true, () => false);
}

/** The ask `ask` in `session` (or one of its subagents), as it's asked now; null when it isn't
 * (answered, or it moved on). */
export async function pendingAsk(target: Target, session: string, ask: string, signal?: AbortSignal): Promise<{ permission: PendingPermission } | { question: PendingQuestion } | null> {
  const { permissions, questions } = await asksIn(target, session, signal);
  const permission = permissions.find(each => each.id === ask);
  if (permission) return { permission };
  const question = questions.find(each => each.id === ask);
  return question ? { question } : null;
}

/** The answers kept on a session, at most this many (the latest). */
const KEPT = 40;

/** A session's notes changed, one change at a time across processes: the engine keeps them whole,
 * so they're read first and sent back with the change (to its `kuvo`, and to the rest of them). */
export async function noteSession(target: Target, session: string, change: (kuvo: Record<string, unknown>, metadata: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  // (Held for as long as the engine takes to answer twice: never taken from a slow one.)
  await lockedWhile(path.join(WORK_FOLDER, ".notes.lock"), async () => {
    const at = `/api/session/${encodeURIComponent(session)}`;
    const data = await call(target, "GET", at) as Partial<EngineSession> | null;
    const metadata: Record<string, unknown> = isObject(data?.metadata) ? { ...data.metadata } : {};
    const kuvo = change(isObject(metadata.kuvo) ? { ...metadata.kuvo } : {}, metadata);
    await call(target, "PATCH", at, { metadata: { ...metadata, kuvo } });
  }, { stale: 120_000, wait: 30_000 });
}

/** An answer kept on its session, for every client to show. */
export async function keepAnswer(target: Target, session: string, answer: Omit<WorkAnswer, "session">): Promise<void> {
  await noteSession(target, session, kuvo => {
    const before = Array.isArray(kuvo.answers) ? kuvo.answers : [];
    return { ...kuvo, answers: [...before, answer].slice(-KEPT) };
  });
}

/** What a permission asks, in words, as the session's card and the bot's work say it. */
export const permissionWords = (permission: Pick<PendingPermission, "action" | "resources">) => describePermission({ action: permission.action, resources: permission.resources });

/** A session's answers as kept on it. */
export function answersOn(metadata: unknown): WorkAnswer[] {
  const answers = isObject(metadata) && isObject(metadata.kuvo) ? metadata.kuvo.answers : null;
  return Array.isArray(answers) ? answers.filter((each): each is WorkAnswer => isObject(each) && typeof each.ask === "string" && typeof each.decision === "string") : [];
}
