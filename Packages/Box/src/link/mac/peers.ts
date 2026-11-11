// This Mac's box among your other computers
// As a machine's link does it (`run`): its agents told to them, its letters sent and their answers
// waited for, its group chats' mail carried, and whether this Mac's in use.

import { isObject } from "../../shared/json";
import type { Body } from "../../shared/json";
import { peerTargets, readEngineFile } from "../engine/client";
import { deliverLeftAnswers, givenUp, macWaiting, outboxSoon, sendOutbox } from "../letters/outbox";
import { pushRows } from "../work/elsewhere";
import { pushNumbers } from "../work-queue/numbers";
import { noteSetupNow } from "../setup/lead";
import { pushQueues } from "../work-queue/across";
import { handUpkeepSoon } from "../work-queue/hand";
import { attentionGiven } from "../notices/hold";
import { announce, refreshOwn } from "../peers/agents";
import { mailFor, peersOf } from "../peers/known";
import { watchSeats } from "../peers/seats";
import { watchMoves } from "../moves/move";
import { macLink, readLink } from "../state";
import type { LetterReply, MacWaiter } from "../letters/outbox";
import type { Attention } from "../notices/hold";

/** What a conversation waiting for a letter's answer gets (`macLetterAnswer`): the answer, why none
 * will come, or no words (`text: null`) once it's waited long enough or its asker went. */
export type MacLetterAnswer = LetterReply | { text: null };

// This Mac in use, or not any more, as its app says (`kuvo/attention`): each of your machines hears
// it by mail, with what of its own this Mac's notifications showed (`elsewhere`, by its id here), so
// notices for your phones wait a little there too, and one you saw here doesn't go.
export function macAttendPeers(body: Body<"elsewhere">, given: Pick<Attention, "seconds" | "sessions">): void {
  const host = macLink.host;
  const link = readLink();
  if (!host?.welcomed || !link?.key) return;
  const at = Date.now();
  for (const peer of peersOf(link)) {
    // (A peer with no id has none.)
    const shown = isObject(body?.elsewhere) && Array.isArray(body.elsewhere[peer.id as string]) ? body.elsewhere[peer.id as string] : [];
    const theirs = attentionGiven({ for: 0, shown })?.shown ?? [];
    const bytes = mailFor(peer, { attention: { for: given.seconds, sessions: given.sessions, ...(theirs.length ? { shown: theirs } : {}) }, at }, link);
    if (bytes) try { host.send(bytes); } catch {}
  }
}

// This Mac's box's agents and their letters, as a machine's link keeps them (`run`): its own listed
// here, link or not (its group chats name them); told to your other computers, and its letters
// sent, while the link's up; its group chats' mail carried on it.
export function runMacPeers(): void {
  const stop = new AbortController();
  watchSeats(() => macLink.host, stop.signal);
  watchMoves(() => macLink.host, stop.signal);
  refreshOwn(readEngineFile).catch(() => {});
  // What this box answers goes at once.
  outboxSoon.send = () => void macSendOutbox();
  const rounds = [
    setInterval(() => {
      const host = macLink.host;
      if (host?.welcomed) announce(host, readEngineFile).catch(() => {});
      else refreshOwn(readEngineFile).catch(() => {});
    }, 60_000),
    setInterval(() => {
      macSendOutbox();
      // The rows of sessions here whose lead lives on another computer, told to it as they change.
      const host = macLink.host;
      if (host?.welcomed) pushRows(host, readLink(), peerTargets()).catch(() => {});
      // Your setup, as this Mac leads it (once a minute), before its numbers go by it.
      noteSetupNow();
      // The Work Queue's ask for more numbers, to the primary (when that isn't this Mac's box); and
      // its queue told to your other computers as it changes, with what it's handing to theirs.
      try { pushNumbers(host); } catch {}
      if (host?.welcomed) pushQueues(host, readLink(), peerTargets()).catch(() => {});
      else try { handUpkeepSoon(readLink()); } catch {}
    }, 3_000),
  ];
  macLink.stopPeers = () => {
    outboxSoon.send = () => {};
    stop.abort();
    for (const round of rounds) clearInterval(round);
  };
}

// Stops them (a test's, as it ends).
export function stopMacPeers(): void {
  macLink.stopPeers?.();
  macLink.stopPeers = null;
}

// The outbox, sent now while this Mac's box is on the relay (and its letters kept, not sent, while
// it isn't); and answers its conversations' tools never took, to them as messages, as a machine's
// link does each round. (What it set going, for a test to wait on.)
export async function macSendOutbox(): Promise<void> {
  const host = macLink.host;
  try { await sendOutbox(host?.welcomed ? host : { send() {} }, undefined, Date.now(), host?.welcomed ? 0 : 1); } catch {}
  await deliverLeftAnswers().catch(() => {});
}

// How long one of this Mac's conversations waits for a letter's answer at most.
export const LETTER_WAIT = 660_000;

// The answer to letter `id` (`macWaiting`): its words; or how it went, when it didn't get there or
// its answer can't come; or `{text: null}` once it's waited `most`, or its asker went (`signal`).
// Then it goes on without waiting, and an answer that comes later reaches the conversation as a
// message.
// `cut`: how much of its answer it takes.
export function macLetterAnswer(id: string, signal?: AbortSignal | null, most = LETTER_WAIT, cut?: number): Promise<MacLetterAnswer> {
  return new Promise<MacLetterAnswer>(resolve => {
    const waiter: MacWaiter = { sentTo: null, gone: () => Boolean(signal?.aborted), done: value => finish(value), ...(cut ? { most: cut } : {}) };
    const timer = setTimeout(() => finish(null), most);
    const abort = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    function finish(value: LetterReply | null): void {
      if (macWaiting.get(id) !== waiter) return;
      macWaiting.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!value) givenUp(id);
      resolve(value ?? { text: null });
    }
    macWaiting.set(id, waiter);
    // Its asker gone already: nothing waits.
    if (signal?.aborted) finish(null);
  });
}
