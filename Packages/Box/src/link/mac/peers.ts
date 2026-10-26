// @ts-nocheck
// This Mac's box among your other computers
// As a machine's link does it (`run`): its agents told to them, its letters sent and their answers
// waited for, its group chats' mail carried, and whether this Mac's in use.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { readEngineFile } from "../engine/client";
import { writePrivate } from "../files";
import { RUN } from "../home";
import { LETTER_ID, SENDING } from "../letters/letter";
import { macWaiting, sendOutbox } from "../letters/outbox";
import { attentionGiven } from "../notices/hold";
import { announce, refreshOwn } from "../peers/agents";
import { mailFor, peersOf } from "../peers/known";
import { watchSeats } from "../peers/seats";
import { macLink, readLink } from "../state";

// This Mac in use, or not any more, as its app says (`kuvo/attention`): each of your machines hears
// it by mail, with what of its own this Mac's notifications showed (`elsewhere`, by its id here), so
// notices for your phones wait a little there too, and one you saw here doesn't go.
export function macAttendPeers(body, given) {
  const host = macLink.host;
  const link = readLink();
  if (!host?.welcomed || !link?.key) return;
  const at = Date.now();
  for (const peer of peersOf(link)) {
    const shown = isObject(body?.elsewhere) && Array.isArray(body.elsewhere[peer.id]) ? body.elsewhere[peer.id] : [];
    const theirs = attentionGiven({ for: 0, shown })?.shown ?? [];
    const bytes = mailFor(peer, { attention: { for: given.seconds, sessions: given.sessions, ...(theirs.length ? { shown: theirs } : {}) }, at }, link);
    if (bytes) try { host.send(bytes); } catch {}
  }
}

// This Mac's box's agents and their letters, as a machine's link keeps them (`run`): its own listed
// here, link or not (its group chats name them); told to your other computers, and its letters
// sent, while the link's up; its group chats' mail carried on it.
export function runMacPeers() {
  const stop = new AbortController();
  takeSeatLetters();
  watchSeats(() => macLink.host, stop.signal);
  refreshOwn(readEngineFile).catch(() => {});
  const rounds = [
    setInterval(() => {
      const host = macLink.host;
      if (host?.welcomed) announce(host, readEngineFile).catch(() => {});
      else refreshOwn(readEngineFile).catch(() => {});
    }, 60_000),
    setInterval(macSendOutbox, 3_000),
  ];
  macLink.stopPeers = () => {
    stop.abort();
    for (const round of rounds) clearInterval(round);
  };
}

// Stops them (a test's, as it ends).
export function stopMacPeers() {
  macLink.stopPeers?.();
  macLink.stopPeers = null;
}

// The outbox, sent now while this Mac's box is on the relay (and its letters kept, not sent, while
// it isn't).
export function macSendOutbox() {
  const host = macLink.host;
  try { sendOutbox(host?.welcomed ? host : { send() {} }, undefined, Date.now(), host?.welcomed ? 0 : 1); } catch {}
}

// How long one of this Mac's conversations waits for a letter's answer at most.
export const LETTER_WAIT = 660_000;
export const OFFLINE_LETTER = "Your other computers can't be reached through the relay now: it goes once this Mac's back on it, and its answer comes to you as a message.";

// The answer to letter `id` (`macWaiting`): its words; or how it went, when it didn't get there or
// its answer can't come; or `{text: null}` once it's waited `most`, or its asker went (`signal`).
// Then it goes on without waiting, and an answer that comes later reaches the conversation as a
// message.
export function macLetterAnswer(id, signal, most = LETTER_WAIT) {
  return new Promise(resolve => {
    const waiter = { sentTo: null, gone: () => Boolean(signal?.aborted), done: value => finish(value) };
    const timer = setTimeout(() => finish(null), most);
    const abort = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    function finish(value) {
      if (macWaiting.get(id) !== waiter) return;
      macWaiting.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!value) {
        const file = path.join(SENDING, `${id}.json`);
        try { writePrivate(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), wait: false })); } catch {}
      }
      resolve(value ?? { text: null });
    }
    macWaiting.set(id, waiter);
  });
}

// Group chats' letters an earlier Kuvo Code kept itself (`run/seat-letters.json`, its SeatRelay),
// in the outbox now, as this box carries them.
export function takeSeatLetters(file = path.join(RUN, "seat-letters.json")) {
  let kept;
  try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  try {
    fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
    for (const [id, letter] of Object.entries(isObject(kept) ? kept : {})) {
      if (!LETTER_ID.test(id) || !isObject(letter) || typeof letter.peer !== "string" || typeof letter.seat !== "string") continue;
      let seat = null;
      try { seat = JSON.parse(Buffer.from(letter.seat, "base64").toString("utf8")); } catch {}
      if (!isObject(seat)) continue;
      writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ peer: letter.peer, seat, at: typeof letter.at === "number" ? letter.at : Date.now(),
        ...(typeof letter.sentTo === "string" ? { sentTo: letter.sentTo } : {}), ...(letter.gaveUp === true ? { gaveUp: true } : {}),
        ...(typeof letter.aged === "number" ? { aged: letter.aged } : {}) }));
    }
    fs.rmSync(file, { force: true });
  } catch {}
}