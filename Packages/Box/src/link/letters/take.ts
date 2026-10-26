// Letters that come here (PROTOCOL.md, "Peers")
// Each is checked, delivered once, and with `wait`, answered by a letter back.

import fs from "node:fs";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { sleep } from "../../shared/wait";
import { asked } from "../engine/client";
import { messageID } from "../engine/sessions";
import { locked, writePrivate } from "../files";
import { PEER_LOCK, isPutAway, peerOf, readPeerAgents } from "../peers/directory";
import { movedOf, ownKey, peersOf } from "../peers/known";
import { readLink } from "../state";
import { LETTERS_SEEN, LETTER_ID, LETTER_LIFE, LETTER_MEMORY, composeLetter, cutText, placeOfSession } from "./letter";
import { answered } from "./outbox";
import type { ListedAgent, Target, ToldAgents } from "../../shared/records";
import type { Peer } from "../peers/known";
import type { SessionPlace } from "./letter";
import type { AnswerLetter, Delivered, OutboxLetter } from "./outbox";

/** Who a letter came from: the box that sent it, by its key, and its name when it's a peer. */
export interface LetterSender {
  key: string;
  name?: string;
}

/** What `takeLetter` works with: how it mails the sender (`send`), where conversations here run
 * (`targets`), how it leaves its answer back (`answer`), what the peers told of their agents
 * (`told`), who they are, the conversations a Mac moved, the time, how long it waits between looks
 * for an answer, and whether a conversation here is moving now (`moving`). */
export interface TakeLetterOptions {
  send: (to: LetterSender, message: { delivered: Delivered }) => void;
  targets: Target[];
  answer?: (letter: OutboxLetter) => void;
  told?: Record<string, ToldAgents>;
  peers?: Peer[];
  moved?: Map<string, string>;
  now?: number;
  wait?: number;
  moving?: (session: string) => Promise<boolean>;
}

/** A message in a session, as far as an answer is read from it: its id, whose it is, its blocks of text. */
interface EngineMessage {
  id: string;
  type: string;
  content?: { type: string; text?: string }[];
}

// Letters remembered, by id, with when: one seen again is said to be there, not delivered twice.
export function lettersSeen(now: number): Record<string, number> {
  let seen: Record<string, number> = {};
  try { seen = JSON.parse(fs.readFileSync(LETTERS_SEEN, "utf8")); } catch {}
  for (const [key, at] of Object.entries(seen)) if (now - at > LETTER_MEMORY) delete seen[key];
  return seen;
}
const seenAlready = (id: string, now = Date.now()) => id in lettersSeen(now);
function noteSeen(id: string, now = Date.now()) {
  locked(PEER_LOCK, () => {
    const seen = lettersSeen(now);
    seen[id] = now;
    writePrivate(LETTERS_SEEN, JSON.stringify(seen));
  });
}
// Letters being delivered now: one that comes again meanwhile waits for that one's answer.
const delivering = new Set<string>();

// Letters from each peer lately, a few at a time (as the Mac counts a machine's).
const lettersFrom = new Map<string, number[]>();
function tooMany(key: string, now = Date.now()) {
  const lately = (lettersFrom.get(key) ?? []).filter(at => now - at < 600_000);
  if (lately.length >= 20) return true;
  lettersFrom.set(key, [...lately, now]);
  return false;
}

// Its answer to message `id`, as kuvo-browser.js's replyTo waits for it: what it wrote after,
// once it's done, ten minutes at most; null for none.
async function answerTo(target: Target, session: string, id: string, wait = 2000): Promise<string | null> {
  const began = Date.now();
  let started = false;
  while (Date.now() - began < 600_000) {
    await sleep(wait);
    const active: string[] | Record<string, unknown> = (await asked(target, "GET", "api/session/active").catch(() => null))?.data ?? {};
    if (Array.isArray(active) ? active.includes(session) : active[session]) {
      started = true;
      continue;
    }
    if (!started && Date.now() - began < 3 * wait) continue;
    const page: { data?: EngineMessage[] } | null = await asked(target, "GET", `api/session/${encodeURIComponent(session)}/message?limit=20&order=desc`).catch(() => null);
    const replies = (page?.data ?? [])
      .filter(message => message.type === "assistant" && message.id > id)
      .reverse()
      .map(message => (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n"))
      .filter(Boolean);
    if (replies.length) return replies.join("\n\n").slice(0, 8000);
    if (started) break;
  }
  return null;
}

// A letter from a peer: delivered once, said to be there (or why not, and whether to try again),
// and with `wait`, answered by a letter back. Who it's from is the sending box's own agent, by the
// name that box gave it, only when that box alone lists it and it isn't one of this box's own;
// otherwise "an agent on" that box, with no address to answer (anything there could claim
// another's). It goes to a conversation here that an agent could be (not a subagent's, a group
// chat's seat, nor one put away); an answer (`answers`) to a letter a tool here waits for goes to
// that tool. One for a conversation moving to or from another computer now (`moving`), or that
// lives on another now, comes again, and reaches it where it lives then. `send(peer, payload)`
// mails the peer; `answer(letter)` sends this box's answer back.
// (`send` and `targets` are always given: the `{}` is only there as the default.)
export async function takeLetter(sender: LetterSender, letter: unknown, { send, targets, answer = () => {}, told = readPeerAgents(), peers = peersOf(readLink()), moved = movedOf(readLink()), now = Date.now(), wait, moving = async () => false }: TakeLetterOptions = {} as TakeLetterOptions): Promise<void> {
  if (!isObject(letter) || typeof letter.id !== "string" || !LETTER_ID.test(letter.id)) return;
  const { id } = letter;
  const no = (why: string, again = false) => send(sender, { delivered: { id, ok: false, why, ...(again ? { retry: true } : {}) } });
  if (typeof letter.at !== "number" || Math.abs(now - letter.at) > LETTER_LIFE) return no("It's too old to deliver.");
  if (typeof letter.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(letter.to) || typeof letter.text !== "string" || !letter.text.trim()) return no("That isn't a letter.");
  if (delivering.has(id)) return;
  if (seenAlready(id, now)) return send(sender, { delivered: { id, ok: true } });
  // An answer a tool here waits for (from the box its letter went to): to it.
  if (typeof letter.answers === "string" && LETTER_ID.test(letter.answers) && answered(sender, letter as AnswerLetter, now)) {
    noteSeen(id, now);
    return send(sender, { delivered: { id, ok: true } });
  }
  if (tooMany(sender.key, now)) return no("It's sent a lot of messages in the last few minutes.", true);
  delivering.add(id);
  let place: SessionPlace | null, prompt: string, fromAgent: ListedAgent | null = null;
  try {
    const lives = moved.get(letter.to);
    if ((lives && lives !== ownKey(readLink() ?? {})) || (await moving(letter.to))) return no("It's moving to another computer: it comes again once it's there.", true);
    place = await placeOfSession(letter.to, targets);
    if (!place) return no("There's no such conversation here.");
    const kuvo = place.data?.metadata?.kuvo ?? {};
    if (place.data?.parentID || kuvo.seat || isPutAway(place.data)) return no("That conversation doesn't take messages.");
    // Its sender: that box's own agent, as it named it; one of this box's own claimed from there isn't.
    // (`from` isn't checked: one that's no session finds no agent.)
    const listed = peerOf(letter.from as string, peers, told, moved)?.key === sender.key ? (told[sender.key]?.list ?? []).find(agent => agent.session === letter.from) : null;
    if (listed && !(await placeOfSession(letter.from as string, targets).catch(() => ({})))) fromAgent = listed;
    const name = fromAgent?.name ?? `an agent on ${plainName(sender.name) || "another computer"}`;
    prompt = messageID();
    const waits = letter.wait === true && Boolean(fromAgent);
    await asked(place.target, "POST", `api/session/${encodeURIComponent(letter.to)}/prompt`, { id: prompt, text: composeLetter(name, fromAgent ? letter.from as string : "unknown", cutText(letter.text), waits), delivery: "steer" });
  } catch (error) {
    return no(`It didn't reach it: ${String((error as Error | null)?.message ?? error)}`, true);
  } finally {
    delivering.delete(id);
  }
  noteSeen(id, now);
  // Waiting for an answer it can't have (its sender couldn't be told): it hears no answer's coming.
  if (letter.wait === true && !fromAgent) return send(sender, { delivered: { id, ok: true, answer: false, why: "Its answer can't come back to you: it doesn't know who you are." } });
  send(sender, { delivered: { id, ok: true } });
  if (letter.wait !== true) return;
  const text = await answerTo(place.target, letter.to, prompt, wait);
  if (text) answer({ from: letter.to, to: letter.from as string, text, answers: id, peer: sender.key });
}