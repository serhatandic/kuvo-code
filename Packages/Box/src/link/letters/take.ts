// Letters that come here (PROTOCOL.md, "Peers")
// Each is checked, delivered once, and with `wait`, answered by a letter back.

import fs from "node:fs";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { pause } from "../../shared/wait";
import { asked } from "../engine/client";
import { sendInto } from "../engine/queue";
import { messageID } from "../engine/sessions";
import { locked, writePrivate } from "../files";
import { PEER_LOCK, isPutAway, peerOf, readPeerAgents } from "../peers/directory";
import { movedOf, ownKey, peersOf } from "../peers/known";
import { readLink } from "../state";
import { LETTERS_SEEN, LETTER_ID, LETTER_LIFE, LETTER_MEMORY, composeLetter, cutText, pausedNote, placeOfSession } from "./letter";
import { READ_BY_MAIL, excerpt, readConversation } from "./conversation";
import { allowed, takeBack } from "./limits";
import { ANSWER_TEXT, answered } from "./outbox";
import type { ListedAgent, Target, ToldAgents } from "../../shared/records";
import type { EngineAnswer } from "../engine/client";
import type { Peer } from "../peers/known";
import type { SessionPlace } from "./letter";
import type { AnswerLetter, Delivered, OutboxLetter } from "./outbox";

/** Who a letter came from: the box that sent it, by its key, its name when it's a peer, and where
 * it is on the relay when this box knows (a Mac's mail can come before a peers document says):
 * an answer goes back only to one with an address (`mailFor`). */
export interface LetterSender {
  key: string;
  name?: string;
  address?: string;
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
  /** Whether the coding agents' bridge runs here now, among `targets`: while it doesn't, a
   * conversation the engine doesn't know may be one of its, so a letter for it comes again. */
  bridge?: boolean;
}

/** A message in a session, as far as an answer is read from it: its id, whose it is, its blocks of text. */
interface EngineMessage {
  id: string;
  type: string;
  content?: { type: string; text?: string }[];
}

// What it wrote after message `id`, oldest first: up to the next message someone else gave it once
// it had answered (said something and gone on to no tool), whose answer is theirs. One that came
// while it was still at it (before it answered, or as it ran a tool) it answers with this.
function answerAfter(messages: EngineMessage[], id: string): string[] {
  const replies: string[] = [];
  let answered = false;
  for (const message of messages) {
    if (message.id <= id) continue;
    if (message.type === "assistant") {
      const parts = message.content ?? [];
      const text = parts.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (text) replies.push(text);
      answered = Boolean(text) && !parts.some(part => part.type === "tool");
    } else if (message.type === "user" && answered) break;
  }
  return replies;
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


/** How `answerTo` waits: between looks (ms), and until its asker goes (`signal`). */
export interface AnswerWait {
  wait?: number;
  signal?: AbortSignal;
}

// Its answer to message `id` (one this box made, so later ones sort after it): what it wrote after,
// once it's done, ten minutes at most; null for none, or once its asker went.
export async function answerTo(target: Target, session: string, id: string, { wait = 2000, signal }: AnswerWait = {}): Promise<string | null> {
  const began = Date.now();
  let started = false;
  while (Date.now() - began < 600_000) {
    await pause(wait, signal);
    if (signal?.aborted) return null;
    // (As the engine and the agents' bridge answer it: the sessions at work, as a list or by id.)
    const active: string[] | Record<string, unknown> = (await asked(target, "GET", "api/session/active").catch(() => null) as EngineAnswer<string[] | Record<string, unknown>> | null)?.data ?? {};
    if (Array.isArray(active) ? active.includes(session) : active[session]) {
      started = true;
      continue;
    }
    if (!started && Date.now() - began < 3 * wait) continue;
    const page: { data?: EngineMessage[] } | null = await asked(target, "GET", `api/session/${encodeURIComponent(session)}/message?limit=20&order=desc`).catch(() => null) as EngineAnswer<EngineMessage[]> | null;
    const replies = answerAfter((page?.data ?? []).slice().reverse(), id);
    if (replies.length) return cutText(replies.join("\n\n"), ANSWER_TEXT);
    if (started) break;
  }
  return null;
}

// Not known to the engine while the coding agents' bridge isn't running (it's starting, or starting
// over): maybe a Claude Code or Codex conversation, so asked again later, as for any other retry.
const BRIDGE_AWAY = "Its coding agents aren't running here now: it comes again once they are.";
// How long a letter waits for them that way, from the first time it was told to: past that, they
// aren't coming back by themselves (stopped for good), and it's refused as one for no conversation.
export const BRIDGE_WAIT = 30 * 60_000;
const bridgeWaits = new Map<string, number>();

// What a letter for a conversation this box doesn't have is told: to come again while the bridge
// may be starting (`bridge`: it runs), else that there's none.
function noConversation(id: string, bridge: boolean, now: number): [string, boolean] {
  if (bridge) {
    bridgeWaits.delete(id);
    return ["There's no such conversation here.", false];
  }
  for (const [letter, since] of bridgeWaits) if (now - since > LETTER_MEMORY) bridgeWaits.delete(letter);
  const since = bridgeWaits.get(id) ?? now;
  bridgeWaits.set(id, since);
  if (now - since < BRIDGE_WAIT) return [BRIDGE_AWAY, true];
  return ["There's no such conversation here, and its coding agents aren't running.", false];
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
export async function takeLetter(sender: LetterSender, letter: unknown, { send, targets, answer = () => {}, told = readPeerAgents(), peers = peersOf(readLink()), moved = movedOf(readLink()), now = Date.now(), wait, moving = async () => false, bridge = true }: TakeLetterOptions = {} as TakeLetterOptions): Promise<void> {
  if (!isObject(letter) || typeof letter.id !== "string" || !LETTER_ID.test(letter.id)) return;
  const { id } = letter;
  const no = (why: string, again = false) => send(sender, { delivered: { id, ok: false, why, ...(again ? { retry: true } : {}) } });
  if (typeof letter.at !== "number" || Math.abs(now - letter.at) > LETTER_LIFE) return no("It's too old to deliver.");
  if (typeof letter.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(letter.to) || typeof letter.text !== "string" || !letter.text.trim()) return no("That isn't a letter.");
  if (delivering.has(id)) return;
  if (seenAlready(id, now)) return send(sender, { delivered: { id, ok: true } });
  // An answer a tool here waits for (from the box its letter went to): to it. A conversation read
  // that nothing waits for now just goes: it isn't a message.
  if (typeof letter.answers === "string" && LETTER_ID.test(letter.answers) && (answered(sender, letter as AnswerLetter, now) || isObject(letter.read))) {
    noteSeen(id, now);
    return send(sender, { delivered: { id, ok: true } });
  }
  if (isObject(letter.read)) return readFor(sender, letter as ReadLetter, { send, targets, answer, now, moved, moving, bridge });
  // Letters from each peer lately, a few at a time, as a conversation's messages are counted: not
  // one that can't be delivered yet, so one tried again and again leaves room for the rest.
  let counted: number | null = allowed("messages", `peer:${sender.key}`, now);
  if (counted === null) return no("It's sent a lot of messages in the last few minutes.", true);
  const notDelivered = (why: string, again = false) => {
    if (again && counted !== null) takeBack("messages", `peer:${sender.key}`, counted);
    counted = null;
    return no(why, again);
  };
  delivering.add(id);
  let place: SessionPlace | null, prompt: string, fromAgent: ListedAgent | null = null, went: "sent" | "waits";
  try {
    const lives = moved.get(letter.to);
    if ((lives && lives !== ownKey(readLink() ?? {})) || (await moving(letter.to))) return notDelivered("It's moving to another computer: it comes again once it's there.", true);
    place = await placeOfSession(letter.to, targets);
    if (!place) return notDelivered(...noConversation(id, bridge, now));
    const kuvo = place.data?.metadata?.kuvo ?? {};
    if (place.data?.parentID || kuvo.seat || isPutAway(place.data)) return notDelivered("That conversation doesn't take messages.");
    // Its sender: that box's own agent, as it named it; one of this box's own claimed from there isn't.
    // (`from` isn't checked: one that's no session finds no agent.)
    const listed = peerOf(letter.from as string, peers, told, moved)?.key === sender.key ? (told[sender.key]?.list ?? []).find(agent => agent.session === letter.from) : null;
    if (listed && !(await placeOfSession(letter.from as string, targets).catch(() => ({})))) fromAgent = listed;
    const name = fromAgent?.name ?? `an agent on ${plainName(sender.name) || "another computer"}`;
    prompt = messageID();
    const waits = letter.wait === true && Boolean(fromAgent);
    const by = fromAgent ? letter.from as string : "unknown";
    went = await sendInto(place.target, letter.to, { id: prompt, text: composeLetter(name, by, cutText(letter.text), waits), delivery: "steer" },
      { from: name, words: cutText(letter.text), kept: composeLetter(name, by, cutText(letter.text), false) });
  } catch (error) {
    return notDelivered(`It didn't reach it: ${String((error as Error | null)?.message ?? error)}`, true);
  } finally {
    delivering.delete(id);
  }
  noteSeen(id, now);
  // Waiting for an answer it can't have (its sender couldn't be told): it hears no answer's coming.
  if (letter.wait === true && !fromAgent) return send(sender, { delivered: { id, ok: true, answer: false, why: "Its answer can't come back to you: it doesn't know who you are." } });
  // Stopped by the user here: it waits for them, and its answer comes as a message.
  if (went === "waits") return send(sender, { delivered: { id, ok: true, ...(letter.wait === true ? { answer: false, why: pausedNote() } : {}) } });
  send(sender, { delivered: { id, ok: true } });
  if (letter.wait !== true) return;
  const text = await answerTo(place.target, letter.to, prompt, { wait });
  if (text) answer({ from: letter.to, to: letter.from as string, text, answers: id, peer: sender.key });
}
/** A letter asking for a conversation here (`read`), once `takeLetter` checked it. */
type ReadLetter = { id: string; to: string; from?: unknown; read: { query?: unknown } };

// A conversation here asked for from another computer (read_conversation there): said to be there,
// then its words go back as the letter's answer, as much as fits in one. Any agent of your other
// computers may read one here, as on this one, but only one an agent could be (not a subagent's, a
// group chat's seat, nor one put away). Reading isn't writing to it: it isn't counted.
async function readFor(sender: LetterSender, letter: ReadLetter, { send, targets, answer = () => {}, now = Date.now(), moved = new Map(), moving = async () => false, bridge = true }: Pick<TakeLetterOptions, "send" | "targets" | "answer" | "now" | "moved" | "moving" | "bridge">): Promise<void> {
  const { id } = letter;
  const no = (why: string, again = false) => send(sender, { delivered: { id, ok: false, why, ...(again ? { retry: true } : {}) } });
  if (typeof letter.from !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(letter.from)) return no("Its answer has nowhere to go.");
  if (delivering.has(id)) return;
  delivering.add(id);
  let words: string;
  try {
    // Moving to or from another computer, or living on another now: asked again once it's there.
    const lives = moved.get(letter.to);
    if ((lives && lives !== ownKey(readLink() ?? {})) || (await moving(letter.to))) return no("It's moving to another computer: it's read once it's there.", true);
    const place = await placeOfSession(letter.to, targets);
    if (!place) return no(...noConversation(id, bridge, now));
    const kuvo = place.data?.metadata?.kuvo ?? {};
    if (place.data?.parentID || kuvo.seat || isPutAway(place.data)) return no("That conversation can't be read.");
    const markdown = await readConversation(place.target, letter.to, place.data ?? {}, String(place.data?.title || "New session"));
    const query = typeof letter.read.query === "string" && letter.read.query.trim() ? letter.read.query.trim() : null;
    words = excerpt(markdown, query, READ_BY_MAIL);
  } catch (error) {
    return no(`It couldn't be read: ${String((error as Error | null)?.message ?? error)}`, true);
  } finally {
    delivering.delete(id);
  }
  noteSeen(id, now);
  send(sender, { delivered: { id, ok: true } });
  answer({ from: letter.to, to: letter.from, text: words, answers: id, peer: sender.key, read: {} });
}
