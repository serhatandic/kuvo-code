// Calls between boxes (PROTOCOL.md, "Peers", `call`): a lead's tool run on the box its sessions are
// on, as that box's own tool runs it. list_sessions, stop_session, compact_session and answer_ask
// go there by mail, with who's calling (`as`) filled in by the lead's box from its own record, never
// from the agent's words; the box that has the sessions checks the lead may (its sessions only, the
// lead's own rules and mode for an allow), runs it, and answers with a letter whose id comes from the
// call's, so a call sent again is never answered twice. A stop, a compact or an answer for a box
// that's away is kept and goes when it's back (an allow for a day at most), and its outcome comes as
// a message. The receiving half is the same on a Mac and on a machine (`peerMail`).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { pause } from "../../shared/wait";
import { bridgeTarget, peerTargets, readEngineFile } from "../engine/client";
import { messageID } from "../engine/sessions";
import { listOf, writePrivate } from "../files";
import { HERE, IS_MAC } from "../home";
import { macSendOutbox } from "../mac/peers";
import { frozen } from "../moves/records";
import { peerOf, readPeerAgents } from "../peers/directory";
import { mailFor, movedOf, ownKey, peersOf, removedBoxes } from "../peers/known";
import { awaySince } from "../peers/reach";
import { macLink, readLink } from "../state";
import { homesOf, noteHomes } from "../work/homes";
import { rowsBox, rowsOf, startedOn } from "../work/elsewhere";
import { ALLOW_LIFE, answerAskTool, compactSessionTool, liveRows, stopSessionTool } from "../work/tools";
import { otherComputersAllowed } from "../work/approval";
import { AWAY_WORDS, computerName, noteLineHomes, START_FIELDS, OPEN_TOOLS, readHere, readJournal, START_FEATURE, startAsOfMail, startsRunning, stopLineWork, takeStart } from "./start-call";
import type { StartAs, StartJournal } from "./start-call";
import { deliverNote } from "./note";
import { cutText, LETTER_LIFE, letterTries, NOTE_MEMORY, placeOfSession, SENDING } from "./letter";
import { READ_BY_MAIL } from "./conversation";
import { letterAnswer, offRelay } from "./leave";
import { leaveLetterAs, macWaiting, outboxSoon, REPLIES, tellMovedAway } from "./outbox";
import { lettersSeen, noteSeen } from "./take";
import type { KitRule } from "../bots/kit";
import type { Target } from "../../shared/records";
import type { WorksFor } from "../../shared/routes/work";
import type { Peer } from "../peers/known";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { Lead, LiveRow, RowsThere } from "../work/tools";
import type { ToolAnswer, ToolPlace } from "./tools";
import type { Delivered, LetterReply } from "./outbox";
import type { LetterSender } from "./take";

/** The tools a call runs on another box: what a lead does to the sessions it started. */
export const CALL_TOOLS = ["list_sessions", "stop_session", "compact_session", "answer_ask", "start_session", "list_models", "list_projects", "stop_work"] as const;
export type CallTool = (typeof CALL_TOOLS)[number];
export const isCallTool = (name: unknown): name is CallTool => CALL_TOOLS.includes(name as CallTool);

/** What a box's agents' mail says when it takes calls (`kuvo/info`'s `features` too). */
export const CALLS_FEATURE = "work.elsewhere";

export const CALL_ID = /^cal_[A-Za-z0-9_-]{16,40}$/;
/** The id of a call's answer: the same however often it's made, so it's taken once. */
export const answerIdOf = (call: string): string => `${call}-a`;

/** Who's calling, as the lead's box knows it (`Lead`, without where it lives): carried in the call. */
export interface CallAs {
  name: string;
  bot?: WorksFor;
  rules: KitRule[];
  free: boolean;
  /** For a start: more of who's calling (`start-call.ts`). */
  start?: StartAs;
}

/** A call as it goes by mail (`{"call": …}`): its id, the conversation calling, the tool and its
 * arguments, who's calling (`as`), when it was made, and when this mail of it was sealed (`at`). */
export interface MailedCall {
  id: string;
  from: string;
  tool: CallTool;
  args: Record<string, unknown>;
  as: CallAs;
  made: number;
  at: number;
}

/** A call in the outbox (`run/outbox/sending/<id>.json`): its tool, arguments and caller, the box
 * it's for, when it was made (`at`), whether a tool waits for its answer, and with `quiet`, one sent
 * to every box in case it's there, whose "not here" no one needs to hear. */
export interface OutboxCall {
  call: { tool: CallTool; args: Record<string, unknown>; as: CallAs };
  from: string;
  to: string;
  peer: string;
  at: number;
  wait?: boolean;
  quiet?: boolean;
  sentTo?: string;
}

// How many bytes of rows a list's answer carries at most: within what a letter's words are cut to.
const LIST_BYTES = 22_000;
// How soon after a call goes the relay's word that its box isn't there means it never got there.
const BOUNCE = 3000;
// How long a box that doesn't answer may take before a tool stops waiting for it.
export const CALL_WAIT = 20_000;

/** How long a call is kept for a box that's away: a list only while its tool waits; an allow a day;
 * a stop, a compact or a refusal as long as news is. */
export function callLife(call: Pick<OutboxCall["call"], "tool" | "args">): number {
  if (call.tool === "list_sessions") return 15 * 60_000;
  // (A start, or a read of what's there, only while its tool waits: never started late.)
  if (isOpenTool(call.tool)) return 2 * 60_000;
  if (call.tool === "answer_ask" && call.args.decision === "allow") return ALLOW_LIFE;
  return NOTE_MEMORY;
}

/** What a box is called here: a machine by its name, a Mac by its own or "the Mac". */
export const boxName = computerName;

/** This box's own name, as it calls itself to others. */
const ownName = (): string => plainName(IS_MAC ? macLink.config?.name : readLink()?.name) || (IS_MAC ? "the Mac" : "a machine");

// What a call's words say a tool did: "stop", "summarize", "answer", "list".
const verbOf = (tool: CallTool) => (tool === "stop_session" || tool === "stop_work" ? "stop" : tool === "compact_session" ? "summary" : tool === "answer_ask" ? "answer" : tool === "start_session" ? "start" : "list");
const isOpenTool = (tool: unknown): tool is (typeof OPEN_TOOLS)[number] => OPEN_TOOLS.includes(tool as (typeof OPEN_TOOLS)[number]);
// The calls only for a tool that waits: a list, a start, a read of what's there.
const waitedFor = (tool: CallTool) => tool === "list_sessions" || isOpenTool(tool);

/** `call` left in the outbox for box `peer`: sent at once on this Mac, the next moment on a machine
 * (its link watches its outbox). Its id. */
export function leaveCall(peer: string, from: string, call: OutboxCall["call"], { wait, quiet = false }: { wait: boolean; quiet?: boolean }, now = Date.now()): string {
  const id = "cal_" + crypto.randomBytes(16).toString("base64url");
  fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
  writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ call, from, to: "", peer, at: now, wait, ...(quiet ? { quiet: true } : {}) } satisfies OutboxCall));
  if (IS_MAC) macSendOutbox();
  return id;
}

/** `call` in the outbox, sent (`sendOutbox`'s, for each round): kept for as long as its kind is
 * (`callLife`), then given up with the lead told; to its box only, again each minute until that box
 * says it has it; while that box doesn't answer, only the oldest for it each minute (`away`, those
 * sent this round). */
export function sendCall(host: Pick<LinkHost, "send">, id: string, file: string, call: OutboxCall, { link, now, offline, peers, away }: { link: LinkState; now: number; offline: boolean; peers: Peer[]; away: Set<string> }): Promise<void> | void {
  if (!isObject(call.call) || !isCallTool(call.call.tool) || typeof call.from !== "string") return void fs.rmSync(file, { force: true });
  const made = typeof call.at === "number" ? call.at : now;
  if (now - made > callLife(call.call)) {
    fs.rmSync(file, { force: true });
    letterTries.delete(id);
    if (call.quiet || waitedFor(call.call.tool)) return;
    const peer = peers.find(each => each.key === call.peer);
    return tellLead(call.from, `[Not done] Your ${call.call.tool} for ${String(call.call.args.session ?? "")} on ${peer ? boxName(peer) : "another computer"} wasn't done: that computer wasn't back in time.${call.call.tool === "answer_ask" && call.call.args.decision === "allow" ? " An allow waits a day at most, as what it was for may have changed. Look at what it asks with list_sessions once it's back." : ""}`).catch(() => {});
  }
  // Its lead lives on another computer now (it moved on since): that box doesn't take it from
  // here, so it ends, and the lead hears it to ask again from where it lives.
  const own = ownKey(link);
  const lives = homesOf(link).get(call.from) ?? movedOf(link).get(call.from);
  if (lives && lives !== own && !call.quiet) {
    fs.rmSync(file, { force: true });
    letterTries.delete(id);
    if (waitedFor(call.call.tool)) return;
    return tellLead(call.from, `[Not done] Your ${call.call.tool} for ${String(call.call.args.session ?? "")} wasn't done: you moved to another computer before it could go. Ask again from there.`).catch(() => {});
  }
  if (lives && lives !== own) return void fs.rmSync(file, { force: true });
  const peer = peers.find(each => each.key === call.peer);
  if (!peer) {
    // A computer you removed: no one to call.
    if (removedBoxes(link).has(call.peer)) fs.rmSync(file, { force: true });
    return;
  }
  // (While it's away, only its oldest is ever one to go: the outbox is read oldest first.)
  if (awaySince(peer.key) !== null) {
    if (away.has(peer.key)) return;
    away.add(peer.key);
  }
  if (offline || now - (letterTries.get(id) ?? 0) < 60_000) return;
  letterTries.set(id, now);
  const mailed: MailedCall = { id, from: call.from, tool: call.call.tool, args: call.call.args, as: call.call.as, made, at: now };
  const bytes = mailFor(peer, { call: mailed, at: now }, link);
  if (!bytes) {
    fs.rmSync(file, { force: true });
    if (call.wait) reply(id, "It's too long to send.");
    return;
  }
  if (call.sentTo !== peer.key) try { writePrivate(file, JSON.stringify({ ...call, sentTo: peer.key })); } catch {}
  try { host.send(bytes); } catch {}
}

// A tool waiting for call `id` hears it failed (on a machine through `run/replies`, on this Mac in memory).
function reply(id: string, failed: string): void {
  if (IS_MAC) return void macWaiting.get(id)?.done({ failed });
  try {
    fs.mkdirSync(REPLIES, { recursive: true, mode: 0o700 });
    writePrivate(path.join(REPLIES, `${id}.json`), JSON.stringify({ failed }));
  } catch {}
}

/** `text` for the conversation `session`, as this box's own word: here, or where it lives now. */
export async function tellLead(session: string, text: string, targets: Target[] = peerTargets()): Promise<void> {
  const note = { from: "Your other computers", words: text, delivery: "queue" as const };
  const place = await placeOfSession(session, targets).catch(() => undefined);
  if (place) return void await deliverNote(place.target, session, messageID(), text, note);
  if (place === null) tellMovedAway(session, text, note);
}

/** A kept call (no tool waits for it) the box it went to refused for good: the lead hears why,
 * unless it went to every box in case one had it (`quiet`). */
export function callRefused(call: OutboxCall, why: string, sender: Pick<Peer, "key">): void {
  if (call.quiet || call.wait === true || !isObject(call.call) || waitedFor(call.call.tool)) return;
  const peer = peersOf(readLink()).find(each => each.key === sender.key);
  tellLead(call.from, `[Not done] Your ${call.call.tool} for ${String(call.call.args.session ?? "")} on ${peer ? boxName(peer) : "another computer"}: ${why}`).catch(() => {});
}

// ---- The caller's side ----

/** How a call went, for the tool that made it: its answer; the box isn't answering (`away`, and
 * whether the call's kept for when it's back); it said it can't (`failed`); it's older; or this box
 * is off the relay. */
export type CallOutcome =
  | { answer: ToolAnswer }
  | { away: string; kept: boolean; sent?: boolean }
  | { failed: string }
  | { older: true }
  | { offline: true; kept: boolean };

const AWAY = AWAY_WORDS;

/** `tool` for `lead` on the box `peer`, waiting `most` ms at most for its answer, less once the
 * relay says that box isn't there. With `keep`, one that can't be answered now is kept for when
 * it's back. */
export async function callPeer(peer: Peer, tool: CallTool, args: Record<string, unknown>, lead: Lead, place: Pick<ToolPlace, "signal" | "step">, { keep, quiet = false, most = CALL_WAIT, start }: { keep: boolean; quiet?: boolean; most?: number; start?: StartAs }): Promise<CallOutcome> {
  if (!(readPeerAgents()[peer.key]?.features ?? []).includes(isOpenTool(tool) || tool === "stop_work" ? START_FEATURE : CALLS_FEATURE)) return { older: true };
  const call: OutboxCall["call"] = { tool, args, as: { ...callAs(lead), ...(start ? { start } : {}) } };
  if (offRelay()) {
    if (keep) leaveCall(peer.key, lead.session, call, { wait: false, quiet });
    return { offline: true, kept: keep };
  }
  if (awaySince(peer.key) !== null) {
    if (keep) leaveCall(peer.key, lead.session, call, { wait: false, quiet });
    return { away: AWAY, kept: keep };
  }
  const sent = Date.now();
  const id = leaveCall(peer.key, lead.session, call, { wait: true, quiet });
  const { answer, unreachable } = await awaitAnswer(id, peer.key, sent, place, { most, cut: READ_BY_MAIL });
  // A start, or a read of what's there, not answered: never sent again, so it's never done late
  // (or twice). One that got there is told as a message.
  if (!answer && isOpenTool(tool)) {
    fs.rmSync(path.join(SENDING, `${id}.json`), { force: true });
    letterTries.delete(id);
  }
  if (answer && "failed" in answer) return { failed: answer.failed };
  if (answer && "note" in answer) return { answer: { text: answer.note, isError: false } };
  if (answer && "text" in answer && typeof answer.text === "string") return { answer: { text: answer.text, isError: answer.isError === true } };
  // (`sent`: it may have got there. The relay keeps nothing and says at once when nothing's
  // connected where a frame goes, so a box said away within moments of the call going never had it.)
  const since = awaySince(peer.key);
  const bounced = unreachable && since !== null && since - sent <= BOUNCE;
  return { away: unreachable ? AWAY : "it didn't answer in time", kept: keep && !place.signal?.aborted, sent: !bounced };
}

/** The answer to letter or call `id`, sent to box `peer` at `sent`: waited for until it comes, the
 * relay says that box isn't there (`unreachable`), it's been `most` ms, or its asker went; then it
 * goes on without waiting (one that's kept), or not at all (a read, a list). */
export async function awaitAnswer(id: string, peer: string, sent: number, place: Pick<ToolPlace, "signal" | "step">, { most, cut, every = 250 }: { most?: number; cut?: number; every?: number }): Promise<{ answer: LetterReply | null; unreachable: boolean }> {
  const stop = new AbortController();
  const gone = () => stop.abort();
  if (place.signal?.aborted) stop.abort();
  place.signal?.addEventListener("abort", gone, { once: true });
  const step = Math.min(place.step ?? every, every);
  let unreachable = false;
  const watching = (async () => {
    while (!stop.signal.aborted) {
      await pause(step, stop.signal);
      const since = awaySince(peer);
      if (since !== null && since >= sent - 1000) {
        unreachable = true;
        return stop.abort();
      }
    }
  })();
  try {
    return { answer: await letterAnswer(id, stop.signal, { ...(most ? { most } : {}), step, ...(cut ? { cut } : {}) }), unreachable };
  } finally {
    stop.abort();
    place.signal?.removeEventListener("abort", gone);
    await watching.catch(() => {});
  }
}

/** Who's calling, as a call carries it. */
// (Rules past what a call carries: none of them is dropped, as the last could be the one that holds
// it back; it goes as one that asks about everything, so it can't allow anything there.)
export const callAs = (lead: Lead): CallAs => ({ name: lead.name, ...(lead.bot ? { bot: lead.bot } : {}), rules: lead.rules.length <= MOST_RULES ? lead.rules : [{ action: "*", resource: "*", effect: "ask" }], free: lead.free });
const MOST_RULES = 300;

/** The box a session of the caller's lives on, as this box knows it: what that box told of it (its
 * rows), where it lives now, or the peer that lists it; null when none says. */
export function boxOf(session: string, link: LinkState | null = readLink()): Peer | null {
  const peers = peersOf(link);
  const own = ownKey(link ?? {});
  for (const key of [rowsBox(session)?.key, homesOf(link).get(session)]) {
    const peer = key && key !== own ? peers.find(each => each.key === key) : undefined;
    if (peer) return peer;
  }
  return peerOf(session, peers, readPeerAgents(), movedOf(link));
}

/** stop_session, compact_session or answer_ask for a session that isn't here: on the box it's on,
 * or, where nothing says which, on each that takes calls (kept for those away, in case it's there). */
export async function elsewhereTool(tool: Exclude<CallTool, "list_sessions">, lead: Lead, args: Record<string, unknown>, session: string, place: Pick<ToolPlace, "signal" | "step">): Promise<ToolAnswer> {
  const verb = verbOf(tool);
  const notHere = `There's no session ${session} here. Use list_sessions to see yours.`;
  const known = boxOf(session);
  const kept = (name: string, away: string) => ({ text: `${name} isn't answering (${away}). Your ${verb} is kept and done when it's back: you'll hear how it went as a message.`, isError: false });
  const offline = `Your other computers can't be reached through the relay now: your ${verb} goes once ${HERE}'s back on it, and you'll hear how it went as a message.`;
  if (known) {
    const outcome = await callPeer(known, tool, { ...args, session }, lead, place, { keep: true });
    const name = boxName(known);
    if ("answer" in outcome) return outcome.answer;
    if ("failed" in outcome) return { text: `On ${name}: ${outcome.failed}`, isError: true };
    if ("older" in outcome) return { text: `"${session}" is on ${name}, which runs an older Kuvo Code: its sessions can't be reached from here until it's updated. Ask the user.`, isError: true };
    if ("offline" in outcome) return { text: offline, isError: false };
    if (!outcome.kept) return { text: `${name} isn't answering (${outcome.away}). Try again later.`, isError: true };
    return kept(name, outcome.away);
  }
  // Nothing says where: each box that takes calls is asked, and kept for those away.
  const peers = peersOf(readLink()).filter(peer => (readPeerAgents()[peer.key]?.features ?? []).includes(CALLS_FEATURE));
  if (!peers.length) return { text: notHere, isError: true };
  const outcomes = await Promise.all(peers.map(async peer => ({ peer, outcome: await callPeer(peer, tool, { ...args, session }, lead, place, { keep: true, quiet: true }) })));
  const answered = outcomes.find(each => "answer" in each.outcome);
  if (answered && "answer" in answered.outcome) return answered.outcome.answer;
  if (outcomes.some(each => "offline" in each.outcome)) return { text: offline, isError: false };
  const away = outcomes.filter(each => "away" in each.outcome).map(each => boxName(each.peer));
  if (away.length) return { text: `There's no session ${session} here, or on your other computers that answered. ${away.join(" and ")} ${away.length > 1 ? "aren't" : "isn't"} answering (${AWAY}): your ${verb} is kept for ${away.length > 1 ? "them" : "it"}, in case it's there, and you'll hear if it was.`, isError: false };
  return { text: `There's no session ${session} here or on your other computers. Use list_sessions to see yours.`, isError: true };
}

/** What each other computer has of the caller's sessions (list_sessions): asked live of each that
 * told this one it has some (they tell as they change, so it knows before it's asleep), or that the
 * caller started one on; one that doesn't answer gives what it last told, as of then. */
export async function rowsEverywhere(lead: Lead, place: Pick<ToolPlace, "signal" | "step">, most = CALL_WAIT): Promise<RowsThere[]> {
  const told = readPeerAgents();
  const kept = new Map(rowsOf(lead.session).map(each => [each.key, each]));
  // (And those it started sessions on, whose first rows may not have come yet.)
  const started = new Set(startedOn(lead.session));
  const asked = peersOf(readLink()).filter(peer => (kept.has(peer.key) || started.has(peer.key)) && (told[peer.key]?.features ?? []).includes(CALLS_FEATURE));
  return (await Promise.all(asked.map(async (peer): Promise<RowsThere | null> => {
    const name = boxName(peer);
    const before = kept.get(peer.key);
    const outcome = await callPeer(peer, "list_sessions", {}, lead, place, { keep: false, most });
    let whole = false;
    if ("answer" in outcome && !outcome.answer.isError) {
      let rows: LiveRow[] = [];
      try {
        rows = (JSON.parse(outcome.answer.text) as { rows?: LiveRow[] }).rows ?? [];
        whole = true;
      } catch {}
      if (whole) return { name, rows: rows.filter(row => isObject(row) && typeof row.session === "string") };
    }
    if (!before) return null;
    return { name, rows: before.rows, asOf: before.at, away: "away" in outcome ? outcome.away : "offline" in outcome ? "this computer is off the relay" : "answer" in outcome ? "its answer didn't come whole" : AWAY };
  }))).filter((each): each is RowsThere => each !== null);
}

// ---- The receiving side ----

const SESSION = /^ses_[A-Za-z0-9]{1,60}$/;
// Calls being run now: one that comes again meanwhile isn't run twice.
const running = new Set<string>();

/** What `takeCall` works with: how it mails the sender (`send`), where conversations here run, how
 * it leaves its answer (`answer`), the time, and whether the coding agents' bridge runs here. */
export interface TakeCallOptions {
  send: (to: LetterSender, message: { delivered: Delivered }) => void;
  targets: Target[];
  answer?: (id: string, letter: { to: string; text: string; peer: string; answers: string; words: string; refused: boolean; list: boolean; about?: string }) => void;
  now?: number;
  bridge?: boolean;
  moved?: Map<string, string>;
  /** Where a session it starts runs: the engine here and the coding agents' bridge. */
  places?: { readEngine: () => Target; bridge: () => Target | null };
}

// `as` as it came, cleaned; null for one that isn't.
function asOfMail(given: unknown): CallAs | null {
  if (!isObject(given) || typeof given.name !== "string" || typeof given.free !== "boolean" || !Array.isArray(given.rules)) return null;
  const rules = given.rules.filter((rule): rule is KitRule => isObject(rule) && typeof rule.action === "string" && typeof rule.resource === "string" && typeof rule.effect === "string" && rule.effect !== "")
    .slice(0, MOST_RULES).map(rule => ({ action: rule.action.slice(0, 200), resource: rule.resource.slice(0, 2000), effect: rule.effect }));
  if (rules.length !== given.rules.length) return null;
  const bot = isObject(given.bot) && typeof given.bot.bot === "string" && /^bot_[A-Za-z0-9]{1,60}$/.test(given.bot.bot) && typeof given.bot.name === "string" ? { bot: given.bot.bot, name: plainName(given.bot.name).slice(0, 100) } : undefined;
  const start = given.start === undefined ? undefined : startAsOfMail(given.start);
  if (start === null) return null;
  return { name: plainName(given.name).slice(0, 100) || "another agent", ...(bot ? { bot } : {}), rules, free: given.free, ...(start ? { start } : {}) };
}

/** A call from a peer (PROTOCOL.md, "Peers", `call`): checked, run once, and answered by a letter
 * back whose id comes from the call's. Who it's for (`from`) must be a conversation that isn't
 * here, and that this box doesn't know to live elsewhere than the box that sent it (that may be a
 * stale word: tried again); its session must be here and under it (each tool checks that); an
 * allow goes only within what the lead could do itself, where it lives, and within what this box's
 * own rules (its Settings › Permissions) allow too, each judged on its own; and never for a session
 * in Ask First. Anything else a call can't reach. */
export async function takeCall(sender: LetterSender & { name?: string }, given: unknown, { send, targets, answer = leaveCallAnswer, now = Date.now(), bridge = true, moved = movedOf(readLink()), places = { readEngine: readEngineFile, bridge: bridgeTarget } }: TakeCallOptions): Promise<void> {
  if (!isObject(given) || typeof given.id !== "string" || !CALL_ID.test(given.id)) return;
  const id = given.id;
  const no = (why: string, again = false) => send(sender, { delivered: { id, ok: false, why, ...(again ? { retry: true } : {}) } });
  // (Sealed as it's sent, so one this old is a replay, or a clock that's off: the real one comes again.)
  if (typeof given.at !== "number" || Math.abs(now - given.at) > LETTER_LIFE) return no("It's too old to deliver.", true);
  if (!isCallTool(given.tool)) return no("That isn't something another computer can do here.");
  if (typeof given.from !== "string" || !SESSION.test(given.from) || typeof given.made !== "number" || !isObject(given.args)) return no("That isn't a call.");
  const as = asOfMail(given.as);
  if (!as) return no("That isn't a call.");
  const { from, tool, made } = given as { from: string; tool: CallTool; made: number };
  const args = given.args as Record<string, unknown>;
  if (running.has(id) || startsRunning.has(id)) return;
  if (id in lettersSeen(now) || `note:${id}` in lettersSeen(now)) return send(sender, { delivered: { id, ok: true } });
  // Work started here from your other computers only while you let them (this box's switch).
  if (isOpenTool(tool) && !otherComputersAllowed()) return no(`${ownName()} doesn't take work from your other computers. Ask the user to allow it in Settings › Permissions on ${ownName()}.`);
  if (tool === "start_session" && (!as.start || as.start.line.at(-1) !== from)) return no("That isn't a call.");
  // (A start that's a day old, from a box whose clock is off or a relay that held it: what it was for may have changed.)
  if (tool === "start_session" && Math.abs(now - made) > LETTER_LIFE) return no("It's too old to start now.");
  // Kept for a box that was away, as long as news is (an allow's day is the tool's to judge).
  if (tool !== "list_sessions" && now - made > NOTE_MEMORY + LETTER_LIFE) return no("It's too old to deliver.");
  running.add(id);
  try {
    // Who it's for: not one of this box's own, nor one this box knows lives on another computer
    // (while it's moving, or as a word that may be stale: again later).
    const own = ownKey(readLink() ?? {});
    if (frozen().has(from)) return no("That conversation is moving between computers: it comes again once it's there.", true);
    const lives = moved.get(from) ?? homesOf(readLink()).get(from);
    if (lives && lives !== sender.key && lives !== own) return no("That conversation lives on another computer, as this one knows it: it comes again.", true);
    if (await placeOfSession(from, targets).catch(() => undefined)) return no("That conversation is on this computer: another can't speak for it.");
    const session = typeof args.session === "string" ? args.session.trim() : "";
    if (tool === "start_session" || tool === "list_models" || tool === "list_projects" || tool === "stop_work") {
      if (!lives) noteHomes([from], sender.key, now);
      if (tool === "stop_work") {
        // A bot's Stop All: what's under it here stops, and nothing's said back (it would wake the bot).
        // (On this box's clock: the call was sealed as it went, `at`, on the other's.)
        const before = (typeof args.before === "number" ? args.before : made) + (now - (given.at as number));
        await stopLineWork(from, before, targets);
        noteSeen(`note:${id}`, now);
        return send(sender, { delivered: { id, ok: true } });
      }
      if (tool !== "start_session") {
        const said = await readHere(tool, places, ownName());
        answer(answerIdOf(id), { to: from, text: said.text, peer: sender.key, answers: id, words: said.text, refused: said.isError, list: true });
        noteSeen(id, now);
        return send(sender, { delivered: { id, ok: true } });
      }
      const peer = peersOf(readLink()).find(each => each.key === sender.key);
      const journal = readJournal(id) ?? { id, from, sender: sender.key, computer: peer ? boxName(peer) : plainName(sender.name) || "another computer", name: as.name, given: startGiven(args), start: as.start!, made, at: now };
      const done = await takeStart(journal, places);
      // The conversations above the lead live where its box says, where this one knows no better
      // (once it's started: a refused start leaves no word behind).
      if (!done.refused) noteLineHomes(as.start!.homes, as.start!.line, now);
      answer(answerIdOf(id), { to: from, text: done.text, peer: sender.key, answers: id, words: done.text, refused: done.refused, list: false });
      noteSeen(`note:${id}`, now);
      return send(sender, { delivered: { id, ok: true } });
    }
    if (tool !== "list_sessions") {
      if (!SESSION.test(session)) return no("Say which session.");
      if (frozen().has(session)) return no("It's moving between computers: it comes again once it's there.", true);
      // (Not one here: said so, so a call sent to each box in case it's there ends quietly. While the
      // coding agents' bridge isn't running, it may be one of its: again later.)
      if (!(await placeOfSession(session, targets))) return no(`There's no session ${session} on this computer.`, !bridge);
    }
    // The lead lives on the box that called, as of now.
    if (!lives) noteHomes([from], sender.key, now);
    const lead: Lead = { session: from, name: as.name, bot: as.bot ?? null, rules: as.rules, free: as.free, from: plainName(sender.name) || "another computer" };
    let said: ToolAnswer;
    if (tool === "list_sessions") {
      let rows = await liveRows(from, targets);
      // As many as fit in an answer, the latest first.
      // (Measured in UTF-8, as the mail cuts a letter's words, so it's never cut there: a list cut
      // short isn't a list.)
      const size = () => Buffer.byteLength(JSON.stringify({ rows }));
      while (rows.length > 1 && size() > LIST_BYTES) rows = rows.slice(0, Math.min(rows.length - 1, Math.floor(rows.length * 0.7)));
      if (size() > LIST_BYTES) rows = rows.map(row => ({ ...row, title: row.title.slice(0, 100), lastReply: undefined, asks: row.asks?.slice(0, 200) }));
      if (size() > LIST_BYTES) rows = [];
      said = { text: JSON.stringify({ rows }), isError: false };
    } else if (tool === "stop_session") said = await stopSessionTool(lead, { ...args, session }, targets);
    else if (tool === "compact_session") said = await compactSessionTool(lead, { ...args, session }, targets);
    else said = await answerAskTool(lead, { ...args, session }, targets, undefined, { made });
    answer(answerIdOf(id), { to: from, text: said.text, peer: sender.key, answers: id, words: said.text, refused: said.isError, list: tool === "list_sessions", ...(session ? { about: session } : {}) });
  } catch (error) {
    return no(`It couldn't be done now: ${String((error as Error | null)?.message ?? error)}`, true);
  } finally {
    running.delete(id);
  }
  // (A list may be asked again harmlessly: remembered as a letter is, not as long as news.)
  noteSeen(tool === "list_sessions" ? id : `note:${id}`, now);
  send(sender, { delivered: { id, ok: true } });
}

// What a start's call asks for, as start_session takes it here: never where the lead's own
// conversation is (it's on another computer), nor a step of a goal (goals stay on their bot's).
function startGiven(args: Record<string, unknown>): Record<string, unknown> {
  const given: Record<string, unknown> = {};
  for (const field of START_FIELDS) if (args[field] !== undefined) given[field] = args[field];
  return given;
}

/** A start finished from where it got to (`resumeStarts`), told to its lead as its call's answer. */
export function answerResumed(journal: StartJournal, done: { text: string; refused: boolean }): void {
  leaveCallAnswer(answerIdOf(journal.id), { to: journal.from, text: done.text, peer: journal.sender, answers: journal.id, words: done.text, refused: done.refused, list: false });
}

// A call's answer, left in the outbox for the box that called: a list's only for the tool that
// waits for it; any other as the box's own word, kept until it's there, which reaches the lead as
// a message when no tool waits for it any more.
function leaveCallAnswer(id: string, letter: Parameters<NonNullable<TakeCallOptions["answer"]>>[1]): void {
  const name = ownName();
  const text = letter.list ? cutText(letter.text, READ_BY_MAIL) : `[On ${name}] ${cutText(letter.text, 4000)}`;
  leaveLetterAs(id, {
    from: null, to: letter.to, text, peer: letter.peer, answers: letter.answers, ...(letter.refused ? { refused: true } : {}),
    ...(letter.list ? { read: {} } : { note: { from: name, words: cutText(letter.words, READ_BY_MAIL), line: cutText(letter.words, 300), delivery: "queue" as const, ...(letter.about ? { about: [letter.about] } : {}) } }),
  });
}

/** The box `key` answers again: the calls kept for it go at once (each was waiting for its next minute). */
export function callsBack(key: string): void {
  let any = false;
  for (const name of listOf(SENDING)) {
    if (!name.endsWith(".json")) continue;
    try {
      const kept = JSON.parse(fs.readFileSync(path.join(SENDING, name), "utf8"));
      if (isObject(kept?.call) && kept.peer === key) {
        letterTries.delete(name.slice(0, -5));
        any = true;
      }
    } catch {}
  }
  if (any) outboxSoon.send();
}
