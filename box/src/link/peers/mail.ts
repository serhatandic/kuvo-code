// Mail from other boxes
// What a Mac or a peer sends this box, opened and handed on: a Mac's lists, its peers' agents,
// documents, letters and how they went, and group chats' seats.

import { isObject } from "../../shared/json";
import { receiveDocs } from "../documents/exchange";
import { readEngineFile } from "../engine/client";
import { leaveAnswer, letterWent } from "../letters/outbox";
import { takeLetter } from "../letters/take";
import { callsBack, takeCall } from "../letters/calls";
import { rowsBack, rowsWent, takeRows } from "../work/elsewhere";
import { noteHeard } from "./reach";
import { takeMoving, tellMovingAgain } from "../moves/elsewhere";
import { takeMoveMail } from "../moves/move";
import { frozen } from "../moves/records";
import { attentionGiven } from "../notices/hold";
import { macSign, readLink, updateLink } from "../state";
import { announce, toldPeers, writeAgents } from "./agents";
import { takeAgents, vouchedOf } from "./directory";
import { forgetOldMacs, macsOf, mailFor, openMail, takeLegacyPeers } from "./known";
import { bridgeAsk, takeLimits, takeSeat } from "./seats";
import { queuesBack, takeWorkQueueMail, tellQueuesAgain } from "../work-queue/across";
import type { PeerPlaces } from "../engine/client";
import type { DocsMail } from "../documents/work";
import type { Delivered } from "../letters/outbox";
import type { LetterSender } from "../letters/take";
import type { Attention } from "../notices/hold";
import type { LinkHost } from "../relay/host";
import type { MailSender } from "./known";

// An answer to a peer's ask for this box's agents, under way; when each last asked.
let answeringAsk: Promise<void> | null = null;
const asksFrom = new Map<string, number>();

// What peers tell each other: their agents, letters, how letters went, and moves, theirs between
// them and what moves on each (PROTOCOL.md, "Peers").
export function peerMail(sender: MailSender, payload: Record<string, unknown>, host: LinkHost | null | undefined, places: () => PeerPlaces = () => ({ targets: [], bridge: true })): void {
  const send = (peer: LetterSender, message: { delivered: Delivered }) => {
    const link = readLink();
    const bytes = link && mailFor(peer, { ...message, at: Date.now() }, link);
    if (bytes) try { host?.send(bytes); } catch {}
  };
  if (isObject(payload.agents)) {
    if (takeAgents(sender, payload.agents)) writeAgents();
  }
  // Documents (PROTOCOL.md, "Documents"): given, in parts, or a digest of what it has.
  if (isObject(payload.docs)) receiveDocs(sender, payload.docs as DocsMail, host).catch(() => {});
  // It's just connected, and may have missed what this box told it (the relay keeps nothing):
  // told again now.
  if (payload.ask === "agents") {
    toldPeers.delete(sender.key);
    tellQueuesAgain(sender.key);
    tellMovingAgain();
    // One answer at a time, and once in a while from each (an ask again soon after is the same).
    const now = Date.now();
    if (host?.welcomed && !answeringAsk && now - (asksFrom.get(sender.key) ?? 0) > 10_000) {
      asksFrom.set(sender.key, now);
      answeringAsk = announce(host, readEngineFile).catch(() => {}).finally(() => { answeringAsk = null; });
    }
  }
  if (isObject(payload.letter)) takeLetter(sender, payload.letter, { send, ...places(), answer: leaveAnswer, moving: async session => frozen().has(session) }).catch(() => {});
  // A lead's tool, from the box it lives on, for sessions of its here (PROTOCOL.md, "Peers", `call`).
  if (isObject(payload.call)) takeCall(sender, payload.call, { send, ...places() }).catch(() => {});
  // What that box has of the sessions of leads that live here (PROTOCOL.md, "Work", `rows`): kept,
  // and said to be had.
  if (isObject(payload.rows) && typeof payload.rows.id === "string" && takeRows(sender, payload.rows)) send(sender, { delivered: { id: payload.rows.id, ok: true } });
  // A move between this box and that one (PROTOCOL.md, `kuvo/moves`).
  if (isObject(payload.move)) takeMoveMail(sender, payload.move).catch(() => {});
  // What moves on that box now, between it and any other (PROTOCOL.md, "Peers", `moving`).
  if (isObject(payload.moving)) takeMoving(sender, payload.moving);
  // Group chats across your computers: to the coding agents' bridge here.
  if (isObject(payload.seat) || isObject(payload.seatPart)) takeSeat(sender, payload, send).catch(() => {});
  // Its plan limits, as it read them: to the coding agents' bridge here (PROTOCOL.md, "Plan limits").
  if (isObject(payload.limits)) takeLimits(sender, payload.limits).catch(() => {});
  // The Work Queue across your computers: what each tells of its queue, numbers' asks and blocks,
  // and items handed between them (PROTOCOL.md, "The Work Queue", "Across your computers").
  if (isObject(payload.workQueue)) takeWorkQueueMail(sender, payload.workQueue, host, places).catch(() => {});
  if (isObject(payload.delivered) && typeof payload.delivered.id === "string") {
    letterWent(sender, payload.delivered as unknown as Delivered);
    if (payload.delivered.ok === true) rowsWent(sender, payload.delivered.id);
  }
}

// What came by mail, from a Mac or a peer: a Mac's lists, or what peers tell each other
// (`peerMail`, its agents and their letters); `attended(mac, given, at)`: a Mac in use, or not any
// more, as of its mail's `at` (PROTOCOL.md, "kuvo/attention").
export function receiveMail(
  body: Buffer,
  host: LinkHost | null | undefined,
  peerMail: (sender: MailSender, payload: Record<string, unknown>) => void = () => {},
  attended: (mac: string, given: Attention, at: number) => void = () => {},
): void {
  const link = readLink();
  const opened = openMail(body, link, () => vouchedOf(link));
  if (!opened) return;
  const { sender, payload } = opened;
  // A box a peer vouches for, not one of this box's own: its plan limits and usage, nothing else.
  if (opened.vouched) {
    if (isObject(payload.limits)) takeLimits(sender, payload.limits).catch(() => {});
    if (isObject(payload.seat) || isObject(payload.seatPart)) takeSeat(sender, payload, () => {}, bridgeAsk, ["usage"]).catch(() => {});
    return;
  }
  // It answers: whatever this box's tools last heard of it (PROTOCOL.md, "Peers", `run/peer-reach.json`).
  // Back after not answering: what's kept for it goes now, not at its next minute.
  if (noteHeard(sender.key)) {
    callsBack(sender.key);
    rowsBack();
    queuesBack(sender.key);
  }
  if (macsOf(link).includes(sender.key)) heardFromMac(sender.key, payload);
  const attention = macsOf(link).includes(sender.key) ? attentionGiven(payload.attention) : null;
  if (attention && typeof payload.at === "number") attended(sender.key, attention, payload.at);
  peerMail(sender, payload);
}

// COMPAT(beta.1 peers-list): the list of peers a beta.1 Mac mails. Goes when 0.8.0 ships.
// Mail from one of this box's Macs: heard from (the 30 days a Mac counts for start again, noted
// once an hour at most), and, from a Mac that signs no documents yet, its list of peers (Kuvo Code
// 0.8.0-beta.1, PROTOCOL.md "For released Macs").
function heardFromMac(mac: string, payload: Record<string, unknown>, now = Date.now()): void {
  const link = readLink();
  const legacy = !macSign(link, mac) && Array.isArray(payload.peers) && typeof payload.at === "number" && payload.at > (link?.legacy?.[mac]?.at ?? 0);
  if (!legacy && now - (link?.macSeen?.[mac] ?? 0) < 3_600_000) return;
  const changed = updateLink(link => {
    if (!link || !macsOf(link).includes(mac)) return null;
    if (legacy) takeLegacyPeers(link, mac, payload.peers, payload.at, payload.moved);
    forgetOldMacs(link, mac, now);
    return link;
  });
  if (changed && legacy) writeAgents(changed);
}