// The box's own word as a letter (PROTOCOL.md, "Peers", `note`)
// What a box has to tell one of its conversations that moved to another computer since (its
// sessions' news, your answer told late, an answer its tool never took) goes there as a letter with
// a `note`: who it's from and how it's shown, and whether it's queued or steered. The box it goes to
// delivers it as this one would have here, not as a letter from an agent no one knows.

import { isObject } from "../../shared/json";
import { boxNote } from "../../shared/queues";
import { sendInto } from "../engine/queue";
import { cutText } from "./letter";
import type { Target } from "../../shared/records";

/** How a letter that's the box's own word is delivered: from whom it's shown (`from`), the words a
 * client shows with it (`words`), queued or steered (`delivery`), and with `line`, marked as the
 * box's note (`boxNote`) with that line shown in its place. `about`: the sessions on the sending box
 * it speaks of. */
export interface LetterNote {
  from: string;
  words: string;
  delivery: "queue" | "steer";
  line?: string;
  about?: string[];
}

/** A letter's `note`, if it's a whole one (its words cut as a letter's are); null for none, or one
 * that isn't (it's a letter as any). */
export function noteOf(value: unknown): LetterNote | null {
  if (!isObject(value) || typeof value.from !== "string" || !value.from.trim() || typeof value.words !== "string") return null;
  if (value.delivery !== "queue" && value.delivery !== "steer") return null;
  if (value.line !== undefined && (typeof value.line !== "string" || !value.line.trim())) return null;
  const about = Array.isArray(value.about) ? value.about.filter((each): each is string => typeof each === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each)).slice(0, 100) : [];
  return { from: cutText(value.from, 200), words: cutText(value.words), delivery: value.delivery, ...(value.line !== undefined ? { line: cutText(value.line) } : {}), ...(about.length ? { about } : {}) };
}

/** `text` to `session` as the box's own word, as `note` says (see `sendInto`). */
export const deliverNote = (target: Target, session: string, id: string, text: string, note: LetterNote): Promise<"sent" | "waits"> =>
  sendInto(target, session, { id, text, delivery: note.delivery, ...(note.line !== undefined ? { metadata: boxNote(note.from, note.line) } : {}) }, { from: note.from, words: note.words });
