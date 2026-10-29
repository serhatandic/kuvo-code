// A tool's letter for an agent on another of your computers: left in the outbox for this box's link
// to send (each three seconds, `sendOutbox`), and with `wait`, its answer waited for. On this Mac the
// box answering the tool is the one on the relay, and waits in memory (`macWaiting`); on a machine
// the tool's call is answered by a process of its own (`box route`), which waits for the answer the
// link leaves in `run/replies`.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pause } from "../../shared/wait";
import { writePrivate } from "../files";
import { IS_MAC, RUN } from "../home";
import { LETTER_WAIT, macLetterAnswer, macSendOutbox } from "../mac/peers";
import { macLink } from "../state";
import { cutText, SENDING } from "./letter";
import { REPLIES } from "./outbox";
import type { LetterRead, LetterReply } from "./outbox";

// There while a machine's link has been off the relay a while: its tools say so rather than wait.
export const RELAY_DOWN = path.join(RUN, "relay-down");
const DOWN_AFTER = 30_000;

/** The link's word on the relay, each round (`run`): `since`, when it was last on it. */
export function noteRelay(online: boolean, since: number, now = Date.now()): void {
  try {
    if (online) fs.rmSync(RELAY_DOWN, { force: true });
    else if (now - since > DOWN_AFTER && !fs.existsSync(RELAY_DOWN)) writePrivate(RELAY_DOWN, "");
  } catch {}
}

/** Whether this box is off the relay now, so a letter goes only once it's back. */
export const offRelay = (): boolean => (IS_MAC ? !macLink.host?.welcomed : fs.existsSync(RELAY_DOWN));

/** A letter as a tool leaves it: from and for which conversations, its words (or what it asks to
 * read), the box it's for, whether it's waited for. */
export interface LeftLetter {
  from: string | null;
  to: string;
  text: string;
  peer: string;
  wait: boolean;
  read?: LetterRead;
}

/** `letter` in the outbox, sent at once on this Mac (the next round on a machine): its id. */
export function leaveLetter(letter: LeftLetter, now = Date.now()): string {
  const id = "ltr_" + crypto.randomBytes(16).toString("base64url");
  fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
  writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ ...letter, text: cutText(letter.text), at: now }));
  if (IS_MAC) macSendOutbox();
  return id;
}

/** How long a tool waits for a letter's answer, and between looks for it. */
export interface LetterWait {
  most?: number;
  step?: number;
  /** How much of the answer it takes. */
  cut?: number;
}

/** The answer to letter `id`: its words, or why none will come (`failed`, `note`); null once it's
 * waited long enough, or its asker went (`signal`). Then the letter goes on without waiting, and an
 * answer that comes later reaches the conversation as a message (`<id>.gaveup`, for the link). */
export async function letterAnswer(id: string, signal?: AbortSignal, { most = LETTER_WAIT, step = 2000, cut }: LetterWait = {}): Promise<LetterReply | null> {
  if (IS_MAC) {
    const answer = await macLetterAnswer(id, signal, most, cut);
    return "text" in answer && answer.text === null ? null : answer as LetterReply;
  }
  const file = path.join(REPLIES, `${id}.json`);
  // Still waiting, as the link sees it: an answer that comes once this isn't (its turn stopped)
  // comes as a message instead.
  const alive = path.join(REPLIES, `${id}.alive`);
  const began = Date.now();
  try {
    fs.mkdirSync(REPLIES, { recursive: true, mode: 0o700 });
    while (Date.now() - began < most && !signal?.aborted) {
      fs.writeFileSync(alive, "", { mode: 0o600 });
      await pause(step, signal);
      // Stopped meanwhile: an answer there now is the link's to deliver as a message.
      if (signal?.aborted) break;
      let answer: LetterReply | null = null;
      try { answer = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (!answer) continue;
      fs.rmSync(file, { force: true });
      return answer;
    }
    fs.writeFileSync(path.join(REPLIES, `${id}.gaveup`), "", { mode: 0o600 });
  } catch {
  } finally {
    fs.rmSync(alive, { force: true });
  }
  return null;
}
