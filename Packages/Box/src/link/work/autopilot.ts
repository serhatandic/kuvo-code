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
import { call } from "../engine/client";
import { sendInto } from "../engine/queue";
import { locked, textOf, writePrivate } from "../files";
import { recommendationOf } from "./answers";
import { WORK_FOLDER } from "./changes";
import type { EngineSession } from "../engine/sessions";
import type { Target } from "../../shared/records";
import type { DecidedShape } from "../../shared/routes/autopilot";

export const DECIDED_FILE = path.join(WORK_FOLDER, "decided.json");
const LOCK = path.join(WORK_FOLDER, ".decided.lock");
/** Its instructions' entry while it's on. */
export const AUTOPILOT_ENTRY = "kuvo.autopilot";
/** Calls kept for each conversation, and conversations kept. */
const KEPT = 60;
const CONVERSATIONS = 200;

/** What an agent on Autopilot is told. */
export const AUTOPILOT_WORDS = [
  "This conversation runs on Autopilot: the user may be away, and wants the work carried through.",
  "Decide what your own research settles: say in a line what you chose and why, and go on.",
  "Stop only for what only the user can do: pay on their own account, sign in, make an account, hand over a key.",
  "When you do ask with the question tool, mark the choice you recommend \"(Recommended)\" and say why in a few words in its description: it goes ahead on that choice at once, and the user can change it later.",
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
  return locked(file === DECIDED_FILE ? LOCK : `${file}.lock`, () => {
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
 * how to work in its instructions (or no longer). Whether the engine took it. */
export async function setAutopilot(target: Target, session: EngineSession, on: boolean, signal?: AbortSignal): Promise<boolean> {
  const metadata = isObject(session.metadata) ? session.metadata : {};
  const kuvo = isObject(metadata.kuvo) ? metadata.kuvo : {};
  const address = encodeURIComponent(session.id);
  try {
    if ((kuvo.autopilot === true) !== on) {
      const { autopilot: _, ...rest } = kuvo;
      await call(target, "PATCH", `/api/session/${address}`, { metadata: { ...metadata, kuvo: on ? { ...rest, autopilot: true } : rest } }, signal);
    }
    await tellAutopilot(target, session.id, on, signal);
    return true;
  } catch {
    return false;
  }
}

/** Its agent told how to work on Autopilot, or no longer. Throws where the engine didn't take it. */
export async function tellAutopilot(target: Target, session: string, on: boolean, signal?: AbortSignal): Promise<void> {
  const entry = `/api/experimental/session/${encodeURIComponent(session)}/instructions/entries/${AUTOPILOT_ENTRY}`;
  if (on) await call(target, "PUT", entry, { value: AUTOPILOT_WORDS }, signal);
  else await call(target, "DELETE", entry, undefined, signal).catch(() => {});
}

/** A question asked in `conversation` (on Autopilot), by it or one of its subagents (`form`, as
 * the engine or the coding agents' bridge on `target` has it): answered with the choice it marked
 * "(Recommended)", and kept as a call it made. Null where it marks none (it waits for you), or the
 * answer didn't go. */
export async function goAheadOnAutopilot(target: Target, conversation: string, form: Record<string, unknown>, file = DECIDED_FILE, signal?: AbortSignal): Promise<DecidedShape | null> {
  const recommended = recommendationOf(form);
  const asker = typeof form.sessionID === "string" ? form.sessionID : null;
  if (!recommended || !asker || typeof form.id !== "string") return null;
  const id = form.id;
  const went = await call(target, "POST", `/api/session/${encodeURIComponent(asker)}/form/${encodeURIComponent(id)}/reply`, { answer: recommended.answer }, signal).then(() => true, () => false);
  if (!went) return null;
  return changeAll(all => {
    const list = all[conversation] ?? [];
    const same = list.find(each => each.id === id);
    if (same) return same;
    const made: DecidedShape = {
      id, text: recommended.text, choice: recommended.choice,
      ...(recommended.why ? { why: recommended.why } : {}),
      ...(recommended.options ? { options: recommended.options } : {}),
      ...(asker !== conversation ? { session: asker } : {}),
      at: Date.now(),
    };
    all[conversation] = [...list, made].slice(-KEPT);
    return made;
  }, file);
}

/** Your choice on a call Autopilot made in `conversation` (on `target`): the same confirms it,
 * quietly; another tells its agent to go that way from here. */
export async function decidedByYou(target: Target, conversation: string, id: string, choice: string, file = DECIDED_FILE): Promise<{ decided: DecidedShape[] } | { status: 404 | 502; message: string }> {
  let before: DecidedShape | undefined;
  const found = changeAll(all => {
    before = all[conversation]?.find(each => each.id === id);
    if (!before) return false;
    const old = { ...before };
    before.yours = { choice, at: Date.now() };
    before = old;
    return true;
  }, file);
  if (!found || !before) return { status: 404, message: "There's no such call in that conversation." };
  if (choice.toLowerCase() !== before.choice.toLowerCase()) {
    const said = `[Decision changed] For "${before.text}" the user picked ${choice}, not ${before.choice} as you decided. Go that way from here: redo what depends on it, and say in a line what changes.`;
    const told = await sendInto(target, conversation, { text: said, delivery: "queue", metadata: boxNote("Autopilot", `You picked ${choice}`) }, { from: "Autopilot", words: `You picked ${choice}` }).then(() => true, () => false);
    if (!told) return { status: 502, message: "Your choice is kept, but the conversation couldn't be told: the engine didn't take it." };
  }
  return { decided: decidedIn(conversation, file) };
}
