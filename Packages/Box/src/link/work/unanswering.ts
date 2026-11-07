// Models that can't answer now (`run/work/unanswering.json`): one whose session's turn failed at its
// account (out of funds, at a plan's limit, signed out), which holds back every model of that
// provider (those that cost something, for funds: a free one spends none; the free ones, for the
// free usage it allows), or at its own limit (a rate limit), which holds back that model. Its starter hears why;
// list_models leaves them out, and start_session on one says so and names one that can, so a bot
// moves its work to a model that can rather than trying the same again. None is kept for good: each
// lasts until its reset (when the error says), else half an hour (a rate limit a few minutes), or
// until a session on it answers, or that account's sign-in or key changes (funds added, say).

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { isLimit, resetsIn, resetTime } from "../../shared/limits";
import { cut } from "../../shared/text";
import { call } from "../engine/client";
import { locked, writePrivate } from "../files";
import { WORK_FOLDER } from "./changes";
import type { Target } from "../../shared/records";
import type { UnansweringList } from "../../shared/routes/work";
import { lastTurnEnd } from "../../shared/summaries";

export const UNANSWERING = path.join(WORK_FOLDER, "unanswering.json");

const UNKNOWN_RESET = 30 * 60_000;
const BRIEF_RESET = 3 * 60_000;

/** A model, as a session names it, and whether it's free (costs nothing), where that's known. */
interface ModelRef {
  providerID: string;
  id: string;
  free?: boolean;
}

/** What's held back: a provider ("opencode") or one model ("opencode/gpt-6.1-sol"), only those of
 * it that cost something (`paid`: its funds ran out) or only its free ones (`free`: its free usage
 * did), why in its engine's words, since when and until when. */
export interface Unanswering {
  key: string;
  scope: "provider" | "model";
  paid?: boolean;
  free?: boolean;
  why: string;
  at: number;
  until: number;
}

/** An error a turn failed with, as its engine gives it, and when (if known). */
export interface TurnError {
  type: string;
  message: string;
  at?: number;
}

// The engine's words for an account that can't (its funds, its plan's spend), or that's signed out;
// for a model at its own limit.
const FUNDS = ["provider.quota", "provider.budget-limit"];
const FREE_USAGE = "provider.free-limit";
const ACCOUNT = [...FUNDS, FREE_USAGE, "provider.auth"];
const MODEL_LIMITS = ["provider.rate-limit", "provider.model-budget-limit", "limit"];

/** Whether `error` says the model can't answer for now, and how widely: the whole account, or the
 * model alone. An error the engine didn't type counts by its words, if they say a limit (not that
 * it's busy, overloaded or at capacity, which passes). */
export function scopeOf(error: TurnError): Unanswering["scope"] | null {
  if (ACCOUNT.includes(error.type)) return "provider";
  if (MODEL_LIMITS.includes(error.type)) return "model";
  if (error.type && error.type !== "provider.unknown") return null;
  return isLimit(error.message) && !/overloaded|capacity/i.test(error.message) ? "model" : null;
}

/** An error as the engine gives it, if it's one. */
export function errorOf(value: unknown, at?: number): TurnError | null {
  if (!isObject(value) || (typeof value.type !== "string" && typeof value.message !== "string")) return null;
  return { type: String(value.type ?? ""), message: String(value.message ?? "").trim(), ...(at ? { at } : {}) };
}

/** The error `session`'s latest turn failed with, or null when it didn't fail. */
export async function turnError(target: Target, session: string, signal?: AbortSignal): Promise<TurnError | null> {
  const page = await call(target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=5&order=desc`, undefined, signal).catch(() => null);
  // (Past a summary after it, whose own end says how that went.)
  const end = lastTurnEnd(page) as { outcome?: unknown; error?: unknown; time?: { created?: number } } | undefined;
  if (end?.outcome !== "failed") return null;
  return errorOf(end.error, Number(end.time?.created ?? 0) || undefined) ?? { type: "", message: "" };
}

/** Whether `model` costs nothing, by its engine's prices (an OpenCode Zen model's name may say so). */
export function isFree(model: unknown): boolean {
  if (!isObject(model)) return false;
  const cost = Array.isArray(model.cost) ? model.cost : isObject(model.cost) ? [model.cost] : [];
  if (cost.length && cost.every(each => isObject(each) && each.input === 0 && each.output === 0)) return true;
  return model.providerID === "opencode" && typeof model.name === "string" && /\sfree$/i.test(model.name);
}

/** Whether `model` is free, by `target`'s engine. */
async function freeThere(target: Target, model: ModelRef): Promise<boolean> {
  const listed = await call(target, "GET", "/api/model").catch(() => null);
  return isFree((Array.isArray(listed) ? listed : []).find(each => isObject(each) && each.providerID === model.providerID && each.id === model.id));
}

const keyOf = (model: ModelRef, scope: Unanswering["scope"]) => (scope === "provider" ? model.providerID : `${model.providerID}/${model.id}`);

function read(file: string, now: number): Unanswering[] {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    return (Array.isArray(kept) ? kept : []).filter((each): each is Unanswering => isObject(each) && typeof each.key === "string" && (each.scope === "provider" || each.scope === "model") && typeof each.why === "string" && typeof each.at === "number" && typeof each.until === "number" && each.until > now);
  } catch {
    return [];
  }
}

function change(file: string, now: number, edit: (held: Unanswering[]) => Unanswering[]): void {
  try {
    locked(file + ".lock", () => writePrivate(file, JSON.stringify(edit(read(file, now)))));
  } catch {}
}

/** What can't answer now, as a client reads it (`GET kuvo/work/unanswering`): with the models a hold
 * on an account's paid or free ones covers, out of `listed` (its engine's, when it could say). */
export function unansweringList(held = unansweringNow(), listed: unknown[] | null = null): UnansweringList {
  return {
    held: held.map(each => {
      const [provider, ...model] = each.key.split("/");
      const only = each.scope === "provider" && (each.paid || each.free);
      const models = only && listed ? listed.filter((one): one is { id: string } => isObject(one) && one.providerID === provider && typeof one.id === "string" && covers(each, { providerID: provider, id: one.id, free: isFree(one) })).map(one => one.id) : null;
      return { provider, ...(each.scope === "model" ? { model: model.join("/") } : {}), ...(each.paid ? { only: "paid" as const } : each.free ? { only: "free" as const } : {}), ...(models ? { models } : {}), why: each.why, since: each.at, until: each.until };
    }),
  };
}

/** What can't answer now. */
export const unansweringNow = (file = UNANSWERING, now = Date.now()): Unanswering[] => read(file, now);

/** Why `model` can't answer now, if it can't: its provider's hold (one for funds, if it costs
 * something), or its own. */
export function holdOf(model: ModelRef & { aliases?: string[] }, held: Unanswering[]): Unanswering | null {
  // (A hold kept under another name it's known by counts: a session on Claude Code's `default`.)
  const keys = [model.id, ...(model.aliases ?? [])].map(id => `${model.providerID}/${id}`);
  return held.find(each => each.key === model.providerID && covers(each, model)) ?? held.find(each => keys.includes(each.key)) ?? null;
}
// Whether a provider's hold is one on `model`: its paid ones', or its free ones', or all of them.
const covers = (held: Unanswering, model: ModelRef) => !(held.paid && model.free) && !(held.free && !model.free);

/** `model`'s turn failed with `error`: held back, when that says it can't answer for now. A free
 * model that fails for want of funds is held alone. Counted from when it failed: one that's over
 * by now (a failure caught up on later) isn't kept. */
export function noteFailed(model: ModelRef, error: TurnError, file = UNANSWERING, now = Date.now()): Unanswering | null {
  let scope = scopeOf(error);
  if (!scope) return null;
  const funds = FUNDS.includes(error.type);
  const freeUsage = error.type === FREE_USAGE;
  if (scope === "provider" && ((funds && model.free) || (freeUsage && !model.free))) scope = "model";
  const at = Math.min(error.at ?? now, now);
  const reset = resetsIn(error.message, at);
  const brief = !reset && (error.type === "provider.rate-limit" || (scope === "model" && /\b429\b|rate.?limit|too many requests/i.test(error.message)));
  const held: Unanswering = { key: keyOf(model, scope), scope, ...(scope === "provider" && funds ? { paid: true } : scope === "provider" && freeUsage ? { free: true } : {}), why: error.message || "It's at a usage limit.", at, until: reset ?? at + (brief ? BRIEF_RESET : UNKNOWN_RESET) };
  if (held.until <= now) return null;
  // (In place of the same one: an account's free models may be held apart from its paid ones.)
  change(file, now, all => [...all.filter(each => each.key !== held.key || Boolean(each.paid) !== Boolean(held.paid) || Boolean(each.free) !== Boolean(held.free)), held]);
  return held;
}

/** A session on `model` answered: it, and its provider, can again (a free one says nothing of the
 * provider's funds, nor a paid one of its free usage). */
export function noteAnswered(model: ModelRef, file = UNANSWERING, now = Date.now()): void {
  const clears = (each: Unanswering) => each.key === `${model.providerID}/${model.id}` || (each.key === model.providerID && covers(each, model));
  if (!read(file, now).some(clears)) return;
  change(file, now, all => all.filter(each => !clears(each)));
}

/** A session on `model`, at `target`, answered: as noteAnswered, knowing whether it's free where
 * that matters (a hold for its provider's funds). */
export async function answeredOn(target: Target, model: ModelRef, file = UNANSWERING, now = Date.now()): Promise<void> {
  const held = read(file, now);
  if (!held.some(each => each.key === model.providerID || each.key === `${model.providerID}/${model.id}`)) return;
  const free = held.some(each => each.key === model.providerID && (each.paid || each.free)) ? await freeThere(target, model) : false;
  noteAnswered({ ...model, free }, file, now);
}

/** `model`, at `target`, failed with `error`: as noteFailed, knowing whether it's free where that
 * matters (a failure for want of funds). */
export async function failedOn(target: Target, model: ModelRef, error: TurnError, file = UNANSWERING, now = Date.now()): Promise<Unanswering | null> {
  const free = model.free ?? (FUNDS.includes(error.type) || error.type === FREE_USAGE ? await freeThere(target, model) : false);
  return noteFailed({ ...model, free }, error, file, now);
}

/** What a hold is, in a line for an agent: "No opencode model can answer now: …". */
export function holdWords(held: Unanswering): string {
  const what = held.scope === "provider" ? `No ${held.paid ? "paid " : held.free ? "free " : ""}${held.key} model can answer now` : `${held.key} can't answer now`;
  return `${what}: ${cut(held.why.replace(/\.+$/, ""), 200)} (since ${resetTime(held.at)}; offered again after ${resetTime(held.until)}, or once a session on it answers)`;
}

// What the engine says when an account's sign-in or key changes.
const ACCOUNT_CHANGES = new Set(["credential.updated", "credential.switched", "credential.removed", "integration.updated", "provider.updated"]);

/** What can't answer, as the engine's events change it: an account's models once it changes (its
 * key or sign-in: tried again; all of them, when the event doesn't name one, except the bare
 * `credential.updated` that comes with every change and with a sign-in's refresh), a model and its
 * provider once a turn on it ends well. */
export async function followUnanswering(source: Target, event: { type: string; data?: unknown }, file = UNANSWERING, now = Date.now()): Promise<void> {
  if (!read(file, now).length) return;
  const data = isObject(event.data) ? event.data : {};
  if (ACCOUNT_CHANGES.has(event.type)) {
    const named = [data.integrationID, data.providerID, data.id].find((each): each is string => typeof each === "string" && each !== "");
    if (named) return change(file, now, all => all.filter(each => each.key !== named && !each.key.startsWith(`${named}/`)));
    if (event.type !== "credential.updated") change(file, now, () => []);
    return;
  }
  if (event.type !== "session.execution.succeeded" || typeof data.sessionID !== "string") return;
  const session = await call(source, "GET", `/api/session/${encodeURIComponent(data.sessionID)}`).catch(() => null);
  const model = isObject(session) && isObject(session.model) ? session.model : null;
  if (model && typeof model.providerID === "string" && typeof model.id === "string") await answeredOn(source, { providerID: model.providerID, id: model.id }, file, now);
}
