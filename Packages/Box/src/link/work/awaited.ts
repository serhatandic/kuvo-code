// Answers a conversation waits for now (send_message or start_session with `wait`): each a file the
// waiter keeps while it waits (`run/work/awaited/`, whichever process it is), and a minute after its
// answer came, with the id of the reply it ended with. A session's finish heard meanwhile waits for
// that wait to end: told to its starter unless the wait ended with that same reply, which came to it
// in the tool.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { writePrivate } from "../files";
import { WORK_FOLDER } from "./changes";

const AWAITED = path.join(WORK_FOLDER, "awaited");
// (Longer than any wait, for one a process left as it stopped.)
const AWAITED_FOR = 11 * 60_000;
const ANSWERED_FOR = 60_000;

// Each wait's file: its session's name, then its own (in one folder: none is removed under another).
const prefixOf = (session: string) => `${encodeURIComponent(session)}.`;

/** Waits (`wait`) for `session`'s answer to `by`: its words, and the id of the reply it ends with;
 * marked so meanwhile, and once it came. */
export async function awaitingAnswer(session: string, by: string | null | undefined, wait: () => Promise<{ text: string | null; reply?: string }>): Promise<{ text: string | null; reply?: string }> {
  if (!by) return wait();
  forgetOld();
  const file = path.join(AWAITED, prefixOf(session) + crypto.randomUUID());
  try {
    writePrivate(file, JSON.stringify({ by }));
  } catch {}
  let answer: { text: string | null; reply?: string } | null = null;
  try {
    return answer = await wait();
  } finally {
    try {
      if (answer?.text && answer.reply) writePrivate(file, JSON.stringify({ by, reply: answer.reply, answered: Date.now() }));
      else fs.rmSync(file, { force: true });
    } catch {}
  }
}

/** Whether `by` had `session`'s finish with `reply` (its last) as the answer it waited for
 * (`answered`), or still waits for one (`waits`), or neither (null). */
export function awaitedBy(session: string, by: string, reply: string | null | undefined, now = Date.now()): "answered" | "waits" | null {
  let waits = false;
  const prefix = prefixOf(session);
  for (const name of filesIn(AWAITED)) {
    if (!name.startsWith(prefix) || name.endsWith(".tmp")) continue;
    try {
      const file = path.join(AWAITED, name);
      const kept: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isObject(kept) || kept.by !== by) continue;
      if (typeof kept.answered !== "number") waits ||= now - fs.statSync(file).mtimeMs < AWAITED_FOR;
      else if (reply && kept.reply === reply && now - kept.answered < ANSWERED_FOR) return "answered";
    } catch {}
  }
  return waits ? "waits" : null;
}

const filesIn = (folder: string) => {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
};

// Those of waits long over (answered, or left by a process that stopped).
function forgetOld(now = Date.now()) {
  for (const name of filesIn(AWAITED)) {
    try {
      const file = path.join(AWAITED, name);
      if (now - fs.statSync(file).mtimeMs > AWAITED_FOR) fs.rmSync(file, { force: true });
    } catch {}
  }
}
