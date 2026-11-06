// A conversation on Autopilot (PROTOCOL.md, "Autopilot"): its agent decides what its own research
// settles, and a question it asks with a choice marked "(Recommended)" goes ahead on that choice at
// once, kept as a call it made, which you can change; one without a mark, and its permissions, wait
// for you as ever. Kept with the conversation (`kuvo.autopilot` in its notes), told to its agent
// in its instructions, and taken by the sessions it starts. Interactive, as every one was before,
// where it isn't so.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { boxNote } from "../../shared/queues";
import { call, engineGet } from "../engine/client";
import { sendInto } from "../engine/queue";
import { locked, textOf, writePrivate } from "../files";
import { askedBy, asksIn, recommendationOf, type PendingQuestion, type Recommendation } from "./answers";
import { addDecided, runningGoalOf } from "./goals";
import { worksFor } from "./tree";
import { WORK_FOLDER } from "./changes";
import type { EngineSession } from "../engine/sessions";
import type { Target } from "../../shared/records";
import type { DecidedShape } from "../../shared/routes/autopilot";

export const DECIDED_FILE = path.join(WORK_FOLDER, "decided.json");
/** Its instructions' entry while it's on. */
export const AUTOPILOT_ENTRY = "kuvo.autopilot";
/** Calls kept for each conversation, and conversations kept. */
const KEPT = 60;
const CONVERSATIONS = 200;

/** What an agent on Autopilot is told. */
export const AUTOPILOT_WORDS = [
  "This conversation runs on Autopilot: the user may be away, and wants the work carried through.",
  "Decide what your own research settles: say in a line what you chose and why, and go on.",
  "What only the user can do goes to them: paying, signing in, making an account, handing over a key, and anything destructive that can't be undone. Ask those with the question tool and no choice marked: that one waits for them, and they're notified.",
  "Anything else you do ask with the question tool, mark the choice you recommend \"(Recommended)\" and say why in a few words in its description: it goes ahead on that choice at once, and the user can change it later. So never mark a choice in what only the user can do.",
].join(" ");

/** Whether `session` is on Autopilot. */
export const isAutopilot = (session: Pick<EngineSession, "metadata"> | null | undefined): boolean =>
  isObject(session?.metadata?.kuvo) && session.metadata.kuvo.autopilot === true;

function readAll(file: string): Record<string, DecidedShape[]> {
  try {
    const all: unknown = JSON.parse(textOf(file) ?? "");
    return isObject(all) ? all as Record<string, DecidedShape[]> : {};
  } catch {
    return {};
  }
}

function changeAll<T>(change: (all: Record<string, DecidedShape[]>) => T, file: string): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return locked(`${file}.lock`, () => {
    const all = readAll(file);
    const value = change(all);
    // The latest conversations' only.
    const kept = Object.entries(all).filter(([, list]) => Array.isArray(list) && list.length)
      .sort(([, a], [, b]) => (b.at(-1)?.at ?? 0) - (a.at(-1)?.at ?? 0)).slice(0, CONVERSATIONS);
    const text = JSON.stringify(Object.fromEntries(kept), null, 2);
    if (text !== textOf(file)) writePrivate(file, text);
    return value;
  });
}

/** The calls Autopilot made in `session`, oldest first. */
export function decidedIn(session: string, file = DECIDED_FILE): DecidedShape[] {
  const list = readAll(file)[session];
  return Array.isArray(list) ? list : [];
}

/** Turns Autopilot on or off for `session` (on `target`): kept in its notes, and its agent told
 * how to work in its instructions (or no longer). Whether the engine took it: where it didn't, it
 * stays as it was. On, its agent is told before its questions go ahead; off, they stop going ahead
 * first. */
export async function setAutopilot(target: Target, session: Partial<EngineSession> & { id: string }, on: boolean, signal?: AbortSignal): Promise<boolean> {
  const metadata = isObject(session.metadata) ? session.metadata : {};
  const kuvo = isObject(metadata.kuvo) ? metadata.kuvo : {};
  const { autopilot: _, ...rest } = kuvo;
  // (Off is written as false, whether the engine replaces its notes or merges them.)
  const keep = () => (kuvo.autopilot === true) === on ? Promise.resolve()
    : call(target, "PATCH", `/api/session/${encodeURIComponent(session.id)}`, { metadata: { ...metadata, kuvo: { ...rest, autopilot: on } } }, signal);
  try {
    if (!on) {
      await keep();
      await tellAutopilot(target, session.id, false, signal);
      return true;
    }
    await tellAutopilot(target, session.id, true, signal);
  } catch {
    return false;
  }
  try {
    await keep();
    return true;
  } catch {
    if (kuvo.autopilot !== true) await tellAutopilot(target, session.id, false, signal).catch(() => {});
    return false;
  }
}

/** Its agent told how to work on Autopilot, or no longer. Throws where the engine didn't take it. */
export async function tellAutopilot(target: Target, session: string, on: boolean, signal?: AbortSignal): Promise<void> {
  const entry = `/api/experimental/session/${encodeURIComponent(session)}/instructions/entries/${AUTOPILOT_ENTRY}`;
  if (on) await call(target, "PUT", entry, { value: AUTOPILOT_WORDS }, signal);
  else await call(target, "DELETE", entry, undefined, signal);
}

/** A question asked in `conversation` (on Autopilot), by it or one of its subagents (`form`, as
 * the engine or the coding agents' bridge on `target` has it): answered with the choice it marked
 * "(Recommended)", and kept as a call it made. Null where it marks none (it waits for you), or the
 * answer didn't go. */
export async function goAheadOnAutopilot(target: Target, conversation: Pick<EngineSession, "id" | "metadata">, form: Record<string, unknown>, file = DECIDED_FILE, signal?: AbortSignal): Promise<DecidedShape | null> {
  const recommended = recommendationOf(form);
  const asker = typeof form.sessionID === "string" ? form.sessionID : null;
  if (!recommended || !asker || typeof form.id !== "string") return null;
  return goAhead(target, conversation, asker, form.id, recommended, file, signal, askedBy(form));
}

/** What `conversation` (on Autopilot) and its subagents ask now that recommends a choice, answered
 * with it: one asked while the box couldn't hear, or before it was turned on. The calls made. */
export async function goAheadOnWaiting(target: Target, conversation: Pick<EngineSession, "id" | "metadata">, file = DECIDED_FILE, signal?: AbortSignal): Promise<DecidedShape[]> {
  const { questions } = await asksIn(target, conversation.id, signal);
  const made: DecidedShape[] = [];
  for (const question of questions) {
    if (signal?.aborted) break;
    const one = await goAheadOnQuestion(target, conversation, question, file, signal);
    if (one) made.push(one);
  }
  return made;
}

/** A question `conversation` (on Autopilot) or a subagent asks, as the engine lists it: answered
 * with what it recommends and kept, as one heard as it's asked is. Null where it recommends nothing,
 * or the answer didn't go. */
export const goAheadOnQuestion = (target: Target, conversation: Pick<EngineSession, "id" | "metadata">, question: PendingQuestion, file = DECIDED_FILE, signal?: AbortSignal): Promise<DecidedShape | null> =>
  question.recommended ? goAhead(target, conversation, question.asker, question.id, question.recommended, file, signal, question.call) : Promise.resolve(null);

/** As the box starts, or hears `target` again: what its conversations on Autopilot (the latest
 * few hundred) ask that recommends a choice, answered with it. */
export async function catchUpAutopilot(target: Target, file = DECIDED_FILE, signal?: AbortSignal): Promise<void> {
  const page = await engineGet(target, "api/session?limit=200&order=desc&parentID=null") as { data?: unknown } | null;
  for (const data of Array.isArray(page?.data) ? page.data as EngineSession[] : []) {
    if (signal?.aborted) return;
    if (!data?.id || data.parentID || data.time?.archived || data.metadata?.kuvo?.archived === true || !isAutopilot(data)) continue;
    await goAheadOnWaiting(target, data, file, signal).catch(() => {});
  }
}

// Answered with what it recommends, and kept: with the conversation, and on its bot's running goal
// (as the goal's own Autopilot keeps it), so the goal shows it too. Not while you have that goal
// paused: it waits for you.
async function goAhead(target: Target, conversation: Pick<EngineSession, "id" | "metadata">, asker: string, id: string, recommended: Recommendation, file: string, signal?: AbortSignal, asked?: string | null): Promise<DecidedShape | null> {
  const goal = runningGoalOf(conversation.id, worksFor(conversation)?.bot ?? null);
  if (goal?.heldByYou) return null;
  const went = await call(target, "POST", `/api/session/${encodeURIComponent(asker)}/form/${encodeURIComponent(id)}/reply`, { answer: recommended.answer }, signal).then(() => true, () => false);
  if (!went) return null;
  const kept = changeAll(all => {
    const list = all[conversation.id] ?? [];
    const same = list.find(each => each.id === id);
    if (same) return same;
    const made: DecidedShape = {
      id, text: recommended.text, choice: recommended.choice,
      ...(recommended.why ? { why: recommended.why } : {}),
      ...(recommended.options ? { options: recommended.options } : {}),
      ...(asker !== conversation.id ? { session: asker } : {}),
      ...(asked ? { call: asked } : {}),
      at: Date.now(),
    };
    all[conversation.id] = [...list, made].slice(-KEPT);
    return made;
  }, file);
  if (goal) addDecided(goal.bot, {
    text: recommended.text, choice: recommended.choice, session: conversation.id,
    ...(recommended.why ? { why: recommended.why } : {}), ...(recommended.options ? { options: recommended.options } : {}),
  }, undefined, `ask:${conversation.id}:${id}`);
  return kept;
}

/** Your choice on a call Autopilot made in `conversation` (on `target`): the same confirms it,
 * quietly; another tells its agent to go that way from here. */
export async function decidedByYou(target: Target, conversation: string, id: string, choice: string, file = DECIDED_FILE): Promise<{ decided: DecidedShape[] } | { status: 404 | 502; message: string }> {
  // (What it goes by now: your last choice, else its own.)
  const before = changeAll(all => {
    const made = all[conversation]?.find(each => each.id === id);
    if (!made) return null;
    const was = { text: made.text, choice: made.yours?.choice ?? made.choice, yours: Boolean(made.yours) };
    made.yours = { choice, at: Date.now() };
    return was;
  }, file);
  if (!before) return { status: 404, message: "There's no such call in that conversation." };
  if (choice.toLowerCase() !== before.choice.toLowerCase()) {
    const said = before.yours
      ? `[Decision changed] For "${before.text}" the user now picked ${choice}, not ${before.choice}. Go that way from here: redo what depends on it, and say in a line what changes.`
      : `[Decision changed] For "${before.text}" the user picked ${choice}, not ${before.choice} as you decided. Go that way from here: redo what depends on it, and say in a line what changes.`;
    const told = await sendInto(target, conversation, { text: said, delivery: "queue", metadata: boxNote("Autopilot", `You picked ${choice}`) }, { from: "Autopilot", words: `You picked ${choice}` }).then(() => true, () => false);
    if (!told) return { status: 502, message: "Your choice is kept, but the conversation couldn't be told: the engine didn't take it." };
  }
  return { decided: decidedIn(conversation, file) };
}
