// Group chats across your computers (PROTOCOL.md, "Peers": `seat`)
// The coding agents' bridge here runs this box's group chats, and its bots' turns in chats on your
// other computers (src/agents/groups/peer.ts). This link carries what goes between them: what the
// bridge sends, now (a turn, how it goes) or until it's there (a part of the work, its report, what
// a bot remembers, a seat gone: as letters go, resent each minute until `delivered`); in parts
// when it's big, as documents go; and what comes, to the bridge. Who your other computers are and
// their bots, the bridge hears from here.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { pause } from "../../shared/wait";
import { DOC_PART, MOST_PARTS } from "../documents/format";
import { assemble } from "../documents/parts";
import { readBridgeFile } from "../engine/client";
import { listOf, writePrivate } from "../files";
import { LETTER_ID, LETTER_MEMORY, SENDING, letterTries } from "../letters/letter";
import { IS_MAC } from "../home";
import { macLink, readLink } from "../state";
import { readPeerAgents, vouchedOf } from "./directory";
import { mailFor, ownKey, peersOf } from "./known";
import type { ToldAgents } from "../../shared/records";
import type { SeatLine as SharedLine, SeatMailKind, SeatPeers } from "../../shared/seats";
import type { DocPart, PendingParts } from "../documents/parts";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { MailSender, Peer } from "./known";

// The bridge's mail (`SeatMail`, src/agents/groups/peer.ts) as far as this link reads it; what
// the two say to each other is src/shared/seats.ts.

/** A mail between two computers' bridges: its kind, and for what a bot remembers of a chat
 * (`memory`), whose and which chat's. The rest goes as it is. `limits`: the bridge's plan limits
 * (PROTOCOL.md, "Plan limits"), which go as `{"limits": …}`, not as a seat's; `usage`: what its
 * accounts used (PROTOCOL.md, "Usage history"), which goes as a seat's, in parts when it's big. */
export interface SeatMail {
  kind: SeatMailKind | "limits" | "usage";
  memory?: { bot: string; chat: string; [field: string]: unknown };
  [field: string]: unknown;
}

/** One line of what the bridge sends. */
export type SeatLine = SharedLine<SeatMail>;

/** A letter of seat mail that mustn't be lost (`run/outbox/sending/<id>.json`): for the computer
 * `peer`, when it was left, whom it was last sent to, whether it's given up, and how long it's
 * waited with this link online (ms). */
export interface SeatLetter {
  peer: string;
  seat: SeatMail;
  at: number;
  sentTo?: string;
  gaveUp?: boolean;
  aged?: number;
}

/** What goes in a mail for a seat: the mail whole (with its letter's id when it mustn't be lost),
 * or a part of it. */
export type SeatPayload = { seat: SeatMail; seatID?: string } | { seatPart: DocPart };

/** What sends a mail on the relay. */
export type SeatHost = Pick<LinkHost, "send">;

/** An ask of the coding agents' bridge's `/api/kuvo/peers` routes: its answer, or why not (an
 * error, with the `status` it answered). */
export type BridgeAsk = (method: string, route: string, body?: unknown, signal?: AbortSignal) => Promise<Response>;

// A mail's whole seat at most this big; bigger, in parts of DOC_PART.
const SEAT_WHOLE = 48_000;
const seatParts = new Map<string, PendingParts>();

/** How long the bridge has to answer an ask without a signal of its own (a test's clock instead). */
export const bridgeClock = {
  answerIn: (): AbortSignal => AbortSignal.timeout(10_000),
  /** `work` in `ms`, unless what it gives back calls it off first. */
  after: (ms: number, work: () => void): (() => void) => {
    const timer = setTimeout(work, ms);
    return () => clearTimeout(timer);
  },
};

// Without a signal, the bridge has a while to answer, not to finish: what it sends as it goes (its
// mail, `GET /mail`, followed for as long as it runs) isn't cut off once that while is up.
export const bridgeAsk: BridgeAsk = async (method, route, body, signal) => {
  const target = readBridgeFile();
  if (!target?.port || !target?.password) throw new Error("The coding agents' bridge isn't running.");
  const waiting = signal ? null : new AbortController();
  const deadline = signal ? null : bridgeClock.answerIn();
  const late = () => waiting?.abort(deadline?.reason);
  deadline?.addEventListener("abort", late, { once: true });
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/peers${route}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? waiting!.signal,
    });
  } finally {
    deadline?.removeEventListener("abort", late);
  }
  if (!response.ok) throw Object.assign(new Error(`The coding agents' bridge answered ${response.status}.`), { status: response.status });
  return response;
};

// A group chat's letter is given up after two days of this link online without a word from its
// computer. Only time online counts: while this computer sleeps, or has no relay, nobody could have
// answered, so a laptop closed over the weekend doesn't give up what it sent on Friday. From one
// round of the outbox to the next counts ONLINE_STEP at most: a longer gap is this computer asleep.
export const SEAT_LETTER_LIFE = LETTER_MEMORY;
export const ONLINE_STEP = 5 * 60_000;
// Each letter's last round, as counted (none yet since the link started: its first round doesn't count).
export const seatRounds = new Map<string, number>();
export const seatAge = (letter: Pick<SeatLetter, "aged"> | null | undefined): number => (typeof letter?.aged === "number" && Number.isFinite(letter.aged) ? letter.aged : 0);

// What goes for one seat mail: whole, or in parts that are put together where it goes (its JSON's
// UTF-8 bytes, base64url, so each part fits a mail whatever the words are); null for one too big to
// be put together there (more than MOST_PARTS). `id`: one that mustn't be lost, as its letter is
// named (said back, `delivered`, once it's whole there).
export function seatPayloads(mail: SeatMail, id?: string): SeatPayload[] | null {
  const json = JSON.stringify(mail);
  if (Buffer.byteLength(json) <= SEAT_WHOLE) return [{ seat: mail, ...(id ? { seatID: id } : {}) }];
  const d = Buffer.from(json).toString("base64url");
  const of = Math.ceil(d.length / DOC_PART);
  if (of > MOST_PARTS) return null;
  const whole = crypto.createHash("sha256").update(d).digest("base64url");
  return Array.from({ length: of }, (_, i) => ({ seatPart: { whole, i, of, d: d.slice(i * DOC_PART, (i + 1) * DOC_PART), s: id ?? "" } }));
}

// The bridge's mail for `to`, sent now, each part as a mail of its own: whether it all went, or
// "too big" for one that can't go at all (said in the log).
function sendSeat(host: SeatHost | null | undefined, to: string, mail: SeatMail, id: string | undefined, link: LinkState | null = readLink()): boolean | "too big" {
  // (Plan limits and usage go to a box a peer vouches for too.)
  const peer = peersOf(link).find(each => each.key === to) ?? (mail.kind === "limits" || mail.kind === "usage" ? vouchedOf(link).find(each => each.key === to) : undefined);
  if (!peer || !host) return false;
  // Its plan limits: a mail of their own, whole (the bridge sends no more than fits).
  if (mail.kind === "limits") {
    const { kind: _, ...limits } = mail;
    const bytes = mailFor(peer, { limits, at: Date.now() }, link!);
    if (!bytes) return false;
    try { host.send(bytes); } catch { return false; }
    return true;
  }
  const payloads = seatPayloads(mail, id);
  if (!payloads) {
    console.error(`kuvo-link: a group chat's ${String(mail?.kind ?? "mail")} for ${plainName(peer.name) || "another computer"} is too big to send, so it wasn't.`);
    return "too big";
  }
  for (const payload of payloads) {
    // (A peer found, so a link.)
    const bytes = mailFor(peer, { ...payload, at: Date.now() }, link!);
    if (!bytes) return false;
    try { host.send(bytes); } catch { return false; }
  }
  return true;
}

// A peer's plan limits, to the bridge here (PROTOCOL.md, "Plan limits"): told again in ten
// minutes, so one the bridge couldn't take now is let go.
export async function takeLimits(sender: MailSender, limits: Record<string, unknown>, ask: BridgeAsk = bridgeAsk): Promise<void> {
  await ask("POST", "/mail", { from: sender.key, mail: { ...limits, kind: "limits" } }).catch(() => {});
}

// A seat mail that came (whole, or once its parts are all here), to the bridge; one that mustn't be
// lost said to have come, once the bridge has it, or to be sent again when it couldn't be given.
// `only`: the kinds taken from this sender (a box a peer vouches for: `usage`), the rest dropped.
export async function takeSeat(sender: MailSender, payload: Record<string, unknown>, send: (to: MailSender, message: { delivered: { id: string; ok: boolean; why?: string; retry?: boolean } }) => void, ask: BridgeAsk = bridgeAsk, only?: string[]): Promise<void> {
  let mail: unknown = null, id: string | null = null;
  if (isObject(payload.seat)) {
    mail = payload.seat;
    id = typeof payload.seatID === "string" ? payload.seatID : null;
  } else if (isObject(payload.seatPart)) {
    // (Checked as a part there.)
    const whole = assemble(seatParts, sender.key, payload.seatPart);
    if (!whole) return;
    try { mail = JSON.parse(Buffer.from(whole.d, "base64url").toString("utf8")); } catch { return; }
    id = whole.s || null;
  }
  if (!isObject(mail) || (id !== null && !LETTER_ID.test(id))) return;
  if (only && !only.includes(String(mail.kind))) return;
  try {
    await ask("POST", "/mail", { from: sender.key, mail });
  } catch {
    if (id) send(sender, { delivered: { id, ok: false, why: "Not now.", retry: true } });
    return;
  }
  if (id) send(sender, { delivered: { id, ok: true } });
}

// Who can be in this box's group chats from your other computers: each peer (taking a chat's turns
// when its `features` say `groups.seats`), and the bots it told of, by their id.
export function seatPeers(link: LinkState | null = readLink(), told: Record<string, ToldAgents> = readPeerAgents()): SeatPeers {
  const peers = peersOf(link);
  const key = link ? ownKey(link) : null;
  const name = plainName(IS_MAC ? macLink.config?.name : link?.name) || os.hostname();
  return {
    ...(key ? { self: { key, name } } : {}),
    // Boxes only a peer knows, for plan limits alone.
    also: vouchedOf(link, told).map(box => ({ key: box.key, name: plainName(box.name) || "another computer" })),
    boxes: peers.map(peer => ({ key: peer.key, name: plainName(peer.name) || "another computer", seats: (told[peer.key]?.features ?? []).includes("groups.seats") })),
    bots: peers.flatMap(peer => (told[peer.key]?.list ?? []).filter(agent => agent.kind === "bot" && agent.id)
      .map(agent => ({ id: agent.id!, name: agent.name, job: agent.about ?? "", box: peer.key, session: agent.session, ...(agent.look ? { look: agent.look } : {}) }))),
  };
}

let toldSeatPeers = "";
export async function tellSeatPeers(link: LinkState | null = readLink(), force = false, ask: BridgeAsk = bridgeAsk): Promise<void> {
  const peers = seatPeers(link);
  const text = JSON.stringify(peers);
  if (!force && text === toldSeatPeers) return;
  await ask("PUT", "", peers);
  toldSeatPeers = text;
}

// One line of what the bridge sends (`{id, to, mail, durable}`): what goes now, sent; what mustn't
// be lost, left as a letter (`run/outbox/sending`, which `sendOutbox` sends again each minute until
// it's there) and sent at once. What a bot remembers of a chat goes for any of the same bot and chat
// still waiting to go: only the newest matters. True once it's this link's to deliver.
export function carrySeat(host: SeatHost | null | undefined, given: SeatLine, link: LinkState | null = readLink(), now = Date.now()): boolean {
  if (!isObject(given) || typeof given.to !== "string" || !isObject(given.mail) || typeof given.id !== "string") return false;
  if (given.durable !== true) {
    sendSeat(host, given.to, given.mail, undefined, link);
    return true;
  }
  const id = given.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  if (!LETTER_ID.test(id)) return false;
  const letter: SeatLetter = { peer: given.to, seat: given.mail, at: now };
  try {
    fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
    if (given.mail.kind === "memory") {
      for (const name of listOf(SENDING)) {
        if (!name.endsWith(".json")) continue;
        let other: SeatLetter | null;
        try { other = JSON.parse(fs.readFileSync(path.join(SENDING, name), "utf8")); } catch { continue; }
        if (other?.peer !== given.to || other?.seat?.kind !== "memory" || other.seat.memory?.bot !== given.mail.memory?.bot || other.seat.memory?.chat !== given.mail.memory?.chat) continue;
        fs.rmSync(path.join(SENDING, name), { force: true });
        letterTries.delete(name.slice(0, -5));
      }
    }
    writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify(letter));
  } catch { return false; }
  const to = peersOf(link).find(each => each.key === given.to);
  if (to && host) sendSeatLetter(host, to, id, letter, link, now);
  return true;
}

// A letter of a group chat's mail that mustn't be lost, sent to its computer now: noted as tried
// (sent again in a minute), or, too big ever to go, given up (the log says so).
export function sendSeatLetter(host: SeatHost | null | undefined, to: Peer, id: string, letter: SeatLetter, link: LinkState | null, now: number, ask: BridgeAsk = bridgeAsk): Promise<void> | null {
  const file = path.join(SENDING, `${id}.json`);
  if (letter.sentTo !== to.key) try { writePrivate(file, JSON.stringify({ ...letter, sentTo: to.key })); } catch {}
  const went = sendSeat(host, to.key, letter.seat, id, link);
  if (went === "too big") return giveUpSeat(id, letter, ask);
  if (went) letterTries.set(id, now);
  return null;
}

// A letter of a group chat's mail given up (two days online without its computer saying it has it,
// too big ever to go, or turned down): the bridge is told (`POST /gaveup`), which decides what comes
// of it (sent again as a new letter while that computer is one of yours and it still matters), and
// the letter goes once the bridge has answered at all: a 4xx (an older bridge, group chats off here)
// is an answer too, so it isn't told again forever. Until then it's kept, marked, and not sent. The
// telling, or null while one is under way.
const tellingGaveUp = new Set<string>();
export function giveUpSeat(id: string, letter: SeatLetter, ask: BridgeAsk = bridgeAsk): Promise<void> | null {
  const file = path.join(SENDING, `${id}.json`);
  letterTries.delete(id);
  if (letter.gaveUp !== true) try { writePrivate(file, JSON.stringify({ ...letter, gaveUp: true })); } catch {}
  if (tellingGaveUp.has(id)) return null;
  tellingGaveUp.add(id);
  const heard = () => fs.rmSync(file, { force: true });
  return ask("POST", "/gaveup", { to: letter.peer, mail: letter.seat, at: letter.at })
    .then(heard, error => { if (error?.status >= 400 && error.status < 500) heard(); })
    .finally(() => tellingGaveUp.delete(id));
}

// The bridge says it's still there every 20 seconds while nothing goes (MAIL_HEARTBEAT, an empty
// line); this long without a word, it's stuck, and it's followed anew.
export const MAIL_QUIET = 60_000;

// Follows what the bridge sends, while it runs (`carrySeat`), saying what mustn't be lost is taken
// once it's left as a letter. Each time it follows anew, it tells the bridge who your computers are.
export async function watchSeats(host: () => SeatHost | null | undefined, signal?: AbortSignal): Promise<void> {
  let attempt = 0;
  while (!signal?.aborted) {
    const connection = new AbortController();
    const end = () => connection.abort();
    signal?.addEventListener("abort", end, { once: true });
    let quiet = false;
    let hush = () => {};
    const heard = () => {
      hush();
      hush = bridgeClock.after(MAIL_QUIET, () => {
        quiet = true;
        connection.abort();
      });
    };
    try {
      heard();
      const response = await bridgeAsk("GET", "/mail", undefined, connection.signal);
      attempt = 0;
      await tellSeatPeers(readLink(), true).catch(() => {});
      let buffer = "";
      const decoder = new TextDecoder();
      // (An answer that follows has a body.)
      for await (const chunk of response.body!) {
        heard();
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let given: SeatLine;
          try { given = JSON.parse(line); } catch { continue; }
          if (carrySeat(host(), given) && given.durable === true) bridgeAsk("POST", "/sent", { ids: [given.id] }).catch(() => {});
        }
      }
    } catch {
    } finally {
      hush();
      signal?.removeEventListener("abort", end);
    }
    // Gone quiet: followed anew at once.
    if (quiet) continue;
    attempt += 1;
    await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), signal);
  }
}