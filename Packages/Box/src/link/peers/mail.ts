// Mail from other boxes
// What a Mac or a peer sends this box, opened and handed on: a Mac's lists, its peers' agents,
// documents, letters and how they went, and group chats' seats.

import { isObject } from "../../shared/json";
import { receiveDocs } from "../documents/exchange";
import { readEngineFile } from "../engine/client";
import { leaveAnswer, letterWent } from "../letters/outbox";
import { takeLetter } from "../letters/take";
import { takeMoveMail } from "../moves/move";
import { frozen } from "../moves/records";
import { attentionGiven } from "../notices/hold";
import { macSign, readLink, updateLink } from "../state";
import { announce, toldPeers, writeAgents } from "./agents";
import { takeAgents } from "./directory";
import { forgetOldMacs, macsOf, mailFor, openMail, takeLegacyPeers } from "./known";
import { takeSeat } from "./seats";
import type { Target } from "../../shared/records";
import type { DocsMail } from "../documents/work";
import type { Delivered } from "../letters/outbox";
import type { LetterSender } from "../letters/take";
import type { Attention } from "../notices/hold";
import type { LinkHost } from "../relay/host";
import type { MailSender } from "./known";

// An answer to a peer's ask for this box's agents, under way; when each last asked.
let answeringAsk: Promise<void> | null = null;
const asksFrom = new Map<string, number>();

// What peers tell each other: their agents, letters, how letters went, and moves (PROTOCOL.md, "Peers").
export function peerMail(sender: MailSender, payload: Record<string, unknown>, host: LinkHost | null | undefined, targets: () => Target[] = () => []): void {
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
    // One answer at a time, and once in a while from each (an ask again soon after is the same).
    const now = Date.now();
    if (host?.welcomed && !answeringAsk && now - (asksFrom.get(sender.key) ?? 0) > 10_000) {
      asksFrom.set(sender.key, now);
      answeringAsk = announce(host, readEngineFile).catch(() => {}).finally(() => { answeringAsk = null; });
    }
  }
  if (isObject(payload.letter)) takeLetter(sender, payload.letter, { send, targets: targets(), answer: leaveAnswer, moving: async session => frozen().has(session) }).catch(() => {});
  // A move between this box and that one (PROTOCOL.md, `kuvo/moves`).
  if (isObject(payload.move)) takeMoveMail(sender, payload.move).catch(() => {});
  // Group chats across your computers: to the coding agents' bridge here.
  if (isObject(payload.seat) || isObject(payload.seatPart)) takeSeat(sender, payload, send).catch(() => {});
  if (isObject(payload.delivered) && typeof payload.delivered.id === "string") letterWent(sender, payload.delivered as unknown as Delivered);
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
  const opened = openMail(body, link);
  if (!opened) return;
  const { sender, payload } = opened;
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