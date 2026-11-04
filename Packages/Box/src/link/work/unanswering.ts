// Models that can't answer now (`run/work/unanswering.json`): one whose session's turn failed at its
// account (out of funds, at a plan's limit, signed out), which holds back every model of that
// provider, or at its own limit (a rate limit), which holds back that model. Its starter hears why;
// list_models leaves them out, and start_session on one says so and names one that can, so a bot
// moves its work to a model that can rather than trying the same again. None is kept for good: each
// lasts until its reset (when the error says), else half an hour (a rate limit a few minutes), or
// until a session on it answers, or an account's sign-in or key changes (funds added, say).

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { isLimit, resetsIn, resetTime } from "../../shared/limits";
import { cut } from "../../shared/text";
import { call } from "../engine/client";
import { locked, writePrivate } from "../files";
import { WORK_FOLDER } from "./changes";
import type { Target } from "../../shared/records";

export const UNANSWERING = path.join(WORK_FOLDER, "unanswering.json");

const UNKNOWN_RESET = 30 * 60_000;
const BRIEF_RESET = 3 * 60_000;

/** A model, as a session names it. */
interface ModelRef {
  providerID: string;
  id: string;
}

/** What's held back: a provider ("opencode") or one model ("opencode/gpt-6.1-sol"), why in its
 * engine's words, since when and until when. */
export interface Unanswering {
  key: string;
  scope: "provider" | "model";
  why: string;
  at: number;
  until: number;
}

/** An error a turn failed with, as its engine gives it. */
export interface TurnError {
  type: string;
  message: string;
}

/** Whether `error` says the model can't answer for now, and how widely: the whole account, or the
 * model alone. */
export function scopeOf(error: TurnError): Unanswering["scope"] | null {
  if (["provider.quota", "provider.budget-limit", "provider.auth"].includes(error.type)) return "provider";
  if (["provider.rate-limit", "provider.model-budget-limit", "provider.free-limit", "limit"].includes(error.type)) return "model";
  return isLimit(error.message) ? "model" : null;
}

/** The error `session`'s latest turn failed with, or null when it didn't fail. */
export async function turnError(target: Target, session: string, signal?: AbortSignal): Promise<TurnError | null> {
  const page = await call(target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=5&order=desc`, undefined, signal).catch(() => null);
  for (const message of Array.isArray(page) ? page : []) {
    if (!isObject(message) || message.type !== "idle") continue;
    if (message.outcome !== "failed") return null;
    const error = isObject(message.error) ? message.error : {};
    return { type: String(error.type ?? ""), message: String(error.message ?? "").trim() };
  }
  return null;
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

/** What can't answer now. */
export const unansweringNow = (file = UNANSWERING, now = Date.now()): Unanswering[] => read(file, now);

/** Why `model` can't answer now, if it can't: its provider's hold, or its own. */
export function holdOf(model: ModelRef, held: Unanswering[]): Unanswering | null {
  return held.find(each => each.key === model.providerID) ?? held.find(each => each.key === `${model.providerID}/${model.id}`) ?? null;
}

/** `model`'s turn failed with `error`: held back, when that says it can't answer for now. */
export function noteFailed(model: ModelRef, error: TurnError, file = UNANSWERING, now = Date.now()): Unanswering | null {
  const scope = scopeOf(error);
  if (!scope) return null;
  const brief = error.type === "provider.rate-limit" && !resetsIn(error.message, now);
  const held: Unanswering = { key: keyOf(model, scope), scope, why: error.message || "It's at a usage limit.", at: now, until: resetsIn(error.message, now) ?? now + (brief ? BRIEF_RESET : UNKNOWN_RESET) };
  change(file, now, all => [...all.filter(each => each.key !== held.key), held]);
  return held;
}

/** A session on `model` answered: it, and its provider, can again. */
export function noteAnswered(model: ModelRef, file = UNANSWERING, now = Date.now()): void {
  if (!read(file, now).some(each => each.key === model.providerID || each.key === `${model.providerID}/${model.id}`)) return;
  change(file, now, all => all.filter(each => each.key !== model.providerID && each.key !== `${model.providerID}/${model.id}`));
}

/** What a hold is, in a line for an agent: "Every opencode model can't answer now: …". */
export function holdWords(held: Unanswering): string {
  const what = held.scope === "provider" ? `Every ${held.key} model` : held.key;
  return `${what} can't answer now: ${cut(held.why.replace(/\.+$/, ""), 200)} (since ${resetTime(held.at)}; tried again after ${resetTime(held.until)}, or once a session on it answers)`;
}

// What the engine says when an account's sign-in or key changes.
const ACCOUNT_CHANGES = new Set(["credential.updated", "credential.switched", "credential.removed", "integration.updated", "provider.updated"]);

/** What can't answer, as the engine's events change it: all of it once an account changes (its key
 * or sign-in: tried again), a model and its provider once a turn on it ends well. */
export async function followUnanswering(source: Target, event: { type: string; data?: { sessionID?: string } }, file = UNANSWERING, now = Date.now()): Promise<void> {
  if (!read(file, now).length) return;
  if (ACCOUNT_CHANGES.has(event.type)) return change(file, now, () => []);
  if (event.type !== "session.execution.succeeded" || typeof event.data?.sessionID !== "string") return;
  const session = await call(source, "GET", `/api/session/${encodeURIComponent(event.data.sessionID)}`).catch(() => null);
  const model = isObject(session) && isObject(session.model) ? session.model : null;
  if (model && typeof model.providerID === "string" && typeof model.id === "string") noteAnswered({ providerID: model.providerID, id: model.id }, file, now);
}
