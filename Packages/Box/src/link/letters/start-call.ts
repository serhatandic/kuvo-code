// Work on another of your computers (PROTOCOL.md, "Peers", `call`, start_session): a lead starts a
// session on another box as if it lived there, and reads the models and projects there first. It
// goes there as a call. Who's calling, with what approval, mode and rules (`as.start`), is filled
// in by the lead's own box from its own record, never from the agent's words; the box it's for
// takes it only while you let your other computers start work there (its switch), and starts it as
// its own start_session does, held to no more than the lead has there and no more than this box
// gives (Full Access only where you confirmed it here, Auto only where its sandbox runs), with the
// lead's Don't Allows held too. A start is made once however often its call comes (`run/calls`,
// and `kuvo.call` on the session), and one cut short by the box going down is finished from where it
// got to. A computer that isn't answering is said so at once: a start never waits for it.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { bridgeTarget, call as engineCall, readEngineFile } from "../engine/client";
import { listOf, writePrivate } from "../files";
import { HERE, IS_MAC, RUN } from "../home";
import { holdsBack } from "../bots/tell";
import { botHere } from "../bots/here";
import { readPeerAgents } from "../peers/directory";
import { ownKey, peersOf } from "../peers/known";
import { macLink, readLink } from "../state";
import { approvalOf, isApproval, otherComputersAllowed } from "../work/approval";
import { isAutopilot } from "../work/autopilot";
import { runningGoal } from "../work/goals";
import { homesOf, noteHomes } from "../work/homes";
import { noteStartedOn } from "../work/elsewhere";
import { botLimits, limitsFrom } from "../work/limits";
import { listModelsTool, listProjectsTool } from "../work/tools";
import { askingNow, botOfConversation, depthOf, lineOf, under, workingNow, workSessions, worksFor } from "../work/tree";
import { atWorkNow, hasWakeUps, stopWork } from "../work/background";
import { allowed, takeBack } from "./limits";
import { LETTER_LIFE, NOTE_MEMORY } from "./letter";
import { heldByLimits, markMade, promptMade, startedWords, startSession } from "./start";
import type { KitRule } from "../bots/kit";
import type { Target } from "../../shared/records";
import type { WorkLimits, WorksFor } from "../../shared/routes/work";
import type { Peer } from "../peers/known";
import type { Approval } from "../work/approval";
import type { Caller, Lead } from "../work/tools";
import type { Making, RemoteLead, StartGiven } from "./start";
import type { ToolAnswer, ToolPlace } from "./tools";

/** What a start's call asks for, as start_session takes it: never a step of a goal, nor where. */
export const START_FIELDS = ["task", "title", "project", "folder", "chat", "worktree", "model", "effort", "mode", "approval", "wake", "wait"] as const;

/** What a box's agents' mail says when it takes starts, and reads of its models and projects, from
 * your other computers (`kuvo/info`'s `features` too). */
export const START_FEATURE = "work.elsewhere.start";
/** The calls only a box that lets your other computers start work on it takes. */
export const OPEN_TOOLS = ["start_session", "list_models", "list_projects"] as const;

/** What a start's call carries of its lead (`as.start`), as the lead's own box knows it: its
 * approval as it comes to there now, its Don't Allows there (`held`), its mode, model and Autopilot,
 * the bot its work is for (`own`: the lead is that bot), the new session's depth and line, the limits
 * you set for that bot, and where each of the line's conversations lives, as the lead's box knows. */
export interface StartAs {
  approval: Approval;
  held: KitRule[];
  agent: "plan" | null;
  model: { providerID: string; id: string; variant?: string } | null;
  autopilot: boolean;
  works: WorksFor | null;
  own: boolean;
  depth: number;
  line: string[];
  limits: WorkLimits | null;
  homes: Record<string, string>;
}

const SESSION = /^ses_[A-Za-z0-9]{1,60}$/;
const MOST_HELD = 300;
// How long a start may take there before its tool stops waiting (a worktree of a big project takes a while).
export const START_WAIT = 45_000;

const rule = (given: unknown): KitRule | null => (isObject(given) && typeof given.action === "string" && typeof given.resource === "string" && typeof given.effect === "string" && given.effect !== ""
  ? { action: given.action.slice(0, 200), resource: given.resource.slice(0, 2000), effect: given.effect.slice(0, 40) } : null);
const text = (value: unknown, most: number) => (typeof value === "string" ? value.slice(0, most) : "");

/** `as.start` as it came, cleaned; null for one that isn't. */
export function startAsOfMail(given: unknown): StartAs | null {
  if (!isObject(given) || !isApproval(given.approval) || !Array.isArray(given.held) || given.held.length > MOST_HELD || !Array.isArray(given.line)) return null;
  const held = given.held.map(rule);
  if (held.some(each => each === null || !holdsBack(each))) return null;
  const line = given.line.filter((each): each is string => typeof each === "string" && SESSION.test(each)).slice(-20);
  if (line.length !== given.line.length || !line.length) return null;
  const model = isObject(given.model) && typeof given.model.providerID === "string" && typeof given.model.id === "string"
    ? { providerID: text(given.model.providerID, 120), id: text(given.model.id, 200), ...(typeof given.model.variant === "string" ? { variant: text(given.model.variant, 60) } : {}) } : null;
  const works = isObject(given.works) && typeof given.works.bot === "string" && /^bot_[A-Za-z0-9]{1,60}$/.test(given.works.bot) && typeof given.works.name === "string"
    ? { bot: given.works.bot, name: plainName(given.works.name).slice(0, 100) || "a bot" } : null;
  const depth = typeof given.depth === "number" && Number.isInteger(given.depth) && given.depth >= 1 ? Math.min(given.depth, 50) : 1;
  const homes: Record<string, string> = {};
  if (isObject(given.homes)) for (const [session, key] of Object.entries(given.homes).slice(0, 20)) if (SESSION.test(session) && typeof key === "string" && key.length <= 100) homes[session] = key;
  return {
    approval: given.approval, held: held as KitRule[], agent: given.agent === "plan" ? "plan" : null, model, autopilot: given.autopilot === true,
    works, own: given.own === true && works !== null, depth, line, limits: limitsFrom(given.limits), homes,
  };
}

// ---- Which computer ----

const folded = (name: string) => name.trim().replace(/^&/, "").toLowerCase();

/** What this box calls itself: a machine by its name, this Mac by its own. */
export function ownComputerNames(): string[] {
  const link = readLink();
  const names = IS_MAC ? [macLink.config?.name, "the mac", "this mac", "mac"] : [link?.id, link?.name, "this machine"];
  return [...names, "here", "this computer", HERE].filter((each): each is string => typeof each === "string" && each.trim() !== "").map(folded);
}

/** What a box is called by agents here: a machine by its name, a Mac by its own or "the Mac". */
export const computerName = (peer: Pick<Peer, "kind" | "name" | "id">): string => (peer.kind === "mac" ? plainName(peer.name) || "the Mac" : peer.id || plainName(peer.name) || "another computer");

const namesOf = (peer: Peer, macs: number): string[] => [peer.id, plainName(peer.name), computerName(peer), ...(peer.kind === "mac" && macs === 1 ? ["the mac", "mac"] : [])]
  .filter((each): each is string => typeof each === "string" && each.trim() !== "").map(folded);

/** Your other computers, in words. */
export const computersWords = (peers: Peer[] = peersOf(readLink())): string =>
  peers.length ? `Your other computers: ${peers.map(computerName).join(", ")}.` : "You have no other computers set up with Kuvo Code.";

/** The computer `given` names (`computer`): here (none, "here", this box's own name), or one of
 * your other computers by its name (a Mac also as "the Mac" when there's one); why not otherwise. */
export function computerOf(given: unknown, peers: Peer[] = peersOf(readLink())): { here: true } | { peer: Peer } | { refused: string } {
  if (given === undefined || given === null || (typeof given === "string" && !given.trim())) return { here: true };
  if (typeof given !== "string") return { refused: "computer is a computer's name, as list_agents shows it." };
  const wanted = folded(given);
  const macs = peers.filter(peer => peer.kind === "mac").length;
  const matches = peers.filter(peer => namesOf(peer, macs).includes(wanted));
  if (matches.length === 1) return { peer: matches[0]! };
  if (matches.length > 1) return { refused: `More than one of your computers is called ${given.trim()}. Ask the user which one they mean.` };
  if (ownComputerNames().includes(wanted)) return { here: true };
  return { refused: `There's no computer called ${given.trim()}. ${computersWords(peers)}` };
}

// ---- The caller's side ----

/** How a call went, as the caller's side sees it (`callPeer`'s, `calls.ts`). */
type Outcome = { answer: ToolAnswer } | { away: string; kept: boolean; sent?: boolean } | { failed: string } | { older: true } | { offline: true; kept: boolean };
type CallPeer = (peer: Peer, tool: "start_session" | "list_models" | "list_projects", args: Record<string, unknown>, lead: Lead, place: Pick<ToolPlace, "signal" | "step">, options: { keep: boolean; most?: number; start?: StartAs }) => Promise<Outcome>;

const asleep = (name: string, doing: string) => `${name} isn't answering: it may be asleep, off or offline, so ${doing}. Nothing can wake it from here: try again once it's back (a wake-up can remind you), or do it on another computer.`;
const olderWords = (name: string) => `${name} runs an older Kuvo Code that can't take work from other computers. Updating Kuvo Code on ${name} lets it: ask the user.`;
const offlineWords = (name: string) => `${HERE[0]!.toUpperCase()}${HERE.slice(1)} can't reach your other computers through the relay now, so nothing can be done on ${name}. Try again later.`;

/** list_models or list_projects on another of your computers. */
export async function readElsewhere(tool: "list_models" | "list_projects", peer: Peer, lead: Lead, place: Pick<ToolPlace, "signal" | "step">, callPeer: CallPeer): Promise<ToolAnswer> {
  const name = computerName(peer);
  if (!(readPeerAgents()[peer.key]?.features ?? []).includes(START_FEATURE)) return { text: olderWords(name), isError: true };
  const outcome = await callPeer(peer, tool, {}, lead, place, { keep: false });
  if ("answer" in outcome) return outcome.answer;
  if ("failed" in outcome) return { text: `On ${name}: ${outcome.failed}`, isError: true };
  if ("older" in outcome) return { text: olderWords(name), isError: true };
  if ("offline" in outcome) return { text: offlineWords(name), isError: true };
  return { text: asleep(name, tool === "list_models" ? "its models can't be read now" : "its projects can't be read now"), isError: true };
}

/** start_session on another of your computers (`peer`), from the conversation `caller` here: checked
 * here first as a start is (a seat, a goal, its mode and approval, where it works, the limits you
 * set and the net against a runaway), then sent there with who's calling as this box knows it. */
export async function startElsewhere(peer: Peer, args: Record<string, unknown>, caller: Caller, lead: Lead, place: ToolPlace, callPeer: CallPeer): Promise<ToolAnswer> {
  const no = (words: string): ToolAnswer => ({ text: words, isError: true });
  const name = computerName(peer);
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return no("Say what it's to do (task).");
  if (!(readPeerAgents()[peer.key]?.features ?? []).includes(START_FEATURE)) return no(olderWords(name));
  const data = caller.place.data;
  const ownBot = botOfConversation(caller.session);
  const bot = ownBot ?? worksFor(data);
  // (Until goals reach across computers, a goal's sessions are started on its bot's own.)
  if (bot && runningGoal(bot.bot)) return no(`Your goal's sessions start on ${HERE} for now: a goal can't follow work on ${name} yet. Start it here, or once the goal is done.`);
  if (args.mode !== undefined && args.mode !== null && args.mode !== "build" && args.mode !== "plan") return no("mode is build or plan.");
  if (args.mode === "build" && data.agent === "plan") return no("This conversation is in Plan mode, so the sessions it starts plan too. Start it in plan mode, or ask the user to switch to Build.");
  if (args.approval !== undefined && args.approval !== null && !isApproval(args.approval)) return no("approval is askFirst, acceptEdits, auto or fullAccess.");
  // (A folder here means nothing there.)
  const named = args.chat === true || (typeof args.project === "string" && args.project.trim()) || (typeof args.folder === "string" && args.folder.trim());
  if (!named) return no(`Say where it works on ${name}: one of its projects (project; list_projects with computer "${name}" lists them), a folder there (folder, a full path), or chat.`);
  // Who's calling, as this box knows it: its approval as it comes to here now, and its Don't Allows.
  let bridgePort: number | null = null;
  try { bridgePort = place.bridge()?.port ?? null; } catch {}
  const approval = approvalOf(data, { agents: bridgePort !== null && caller.place.target.port === bridgePort, bot: Boolean(bot) }).effective;
  const held = lead.rules.filter(holdsBack);
  if (held.length > MOST_HELD) return no(`Your rules are too many to carry to ${name}. Start it here, or ask the user.`);
  const depth = ownBot ? 1 : depthOf(data) + 1;
  const limits = bot ? botLimits(bot.bot) ?? limitsFrom(data.metadata?.kuvo?.limits) : null;
  const targets: Target[] = [];
  try { targets.push(place.readEngine()); } catch {}
  const bridge = place.bridge();
  if (bridge) targets.push(bridge);
  // The limits you set for its bot, counting its sessions here and on your other computers.
  const limited = bot && limits ? await heldByLimits(bot, limits, depth, false, targets, place.signal) : null;
  if (limited && "refused" in limited) return no(limited.refused.message);
  const went = limited?.went ?? (() => {});
  const kind = bot ? "botSessions" : "sessions";
  const key = bot ? `bot:${bot.bot}` : caller.session;
  const counted = allowed(kind, key);
  if (counted === null) {
    went(null);
    return no(bot ? "You've started a great many sessions in the last few minutes, which looks like a loop. Stop, check on the ones you have (list_sessions), and tell the user." : "You've started several sessions in the last few minutes. Write to those (send_message), or ask the user before starting more.");
  }
  const failed = (words: string): ToolAnswer => {
    takeBack(kind, key, counted);
    went(null);
    return no(words);
  };
  const link = readLink();
  const homes = homesOf(link);
  const own = ownKey(link ?? {});
  const line = [...lineOf(data), caller.session].slice(-20);
  const start: StartAs = {
    approval, held, agent: data.agent === "plan" ? "plan" : null,
    model: data.model?.providerID && data.model.id ? { providerID: data.model.providerID, id: data.model.id, ...(data.model.variant ? { variant: data.model.variant } : {}) } : null,
    autopilot: isAutopilot(data), works: bot, own: Boolean(ownBot), depth, line, limits,
    homes: Object.fromEntries(line.flatMap(session => { const at = homes.get(session) ?? own; return at ? [[session, at]] : []; })),
  };
  const sent: Record<string, unknown> = {};
  for (const field of START_FIELDS) if (args[field] !== undefined && args[field] !== null) sent[field] = args[field];
  sent.task = task;
  let outcome = await callPeer(peer, "start_session", sent, lead, place, { keep: false, most: START_WAIT, start });
  if ("answer" in outcome) {
    // (Its words are that computer's: said so, as they would be had they come as a message.)
    const text = outcome.answer.text.startsWith("[On ") ? outcome.answer.text : `[On ${name}] ${outcome.answer.text}`;
    outcome = { answer: { text, isError: outcome.answer.isError } };
    const session = /\(address (ses_[A-Za-z0-9]+)\)/.exec(outcome.answer.text)?.[1] ?? null;
    // Refused there, with nothing made: it didn't start.
    if (!session) return outcome.answer.isError ? failed(outcome.answer.text) : (went(null), outcome.answer);
    // Made there (its task may not have reached it): it lives there, so a stop or an answer for it
    // goes there at once, before its first rows come.
    noteHomes([session], peer.key);
    noteStartedOn(caller.session, peer.key);
    went(session, !outcome.answer.isError);
    return outcome.answer;
  }
  if ("failed" in outcome) return failed(`On ${name}: ${outcome.failed}`);
  if ("older" in outcome) return failed(olderWords(name));
  if ("offline" in outcome) return failed(offlineWords(name));
  // Not answering before it went: nothing was started.
  if (outcome.away === AWAY_WORDS && !outcome.sent) return failed(asleep(name, "nothing was started"));
  // It went, and no answer came (that computer stopped answering, or took too long): it may have
  // started. Not tried again, so it's never started twice.
  went(null);
  const why = outcome.away === AWAY_WORDS ? `it stopped answering (${AWAY_WORDS}) after the start went` : "it didn't answer in time";
  return no(`Couldn't confirm the session started on ${name}: ${why}. It may still have started, and if it did you'll hear as a message${outcome.away === AWAY_WORDS ? ` once ${name} is back` : ""}. Check with list_sessions before you start it again.`);
}

/** Why a box isn't answering, in `callPeer`'s words, when the relay says it isn't there. */
export const AWAY_WORDS = "it may be asleep, off or offline";

// ---- The receiving side ----

/** Where calls that start work are kept as they're done (`run/calls/<id>.json`): so one is done
 * once, and finished from the step it got to should this box go down meanwhile. */
export const CALLS = path.join(RUN, "calls");

/** A start's call, as it's kept here: from whom (the lead, its box and that box's name), what it
 * asked and who it is (`given`, `as`), when it was made, where it's got to (`making`, then the
 * session made, marked, told its task), and once it's done, what it said. */
export interface StartJournal {
  id: string;
  from: string;
  sender: string;
  computer: string;
  name: string;
  given: Record<string, unknown>;
  start: StartAs;
  made: number;
  at: number;
  making?: Making;
  session?: string;
  marked?: boolean;
  prompted?: boolean;
  done?: { text: string; refused: boolean };
}

const journalFile = (id: string) => path.join(CALLS, `${id}.json`);
export function readJournal(id: string): StartJournal | null {
  try {
    const kept = JSON.parse(fs.readFileSync(journalFile(id), "utf8"));
    return isObject(kept) && kept.id === id ? kept as unknown as StartJournal : null;
  } catch {
    return null;
  }
}
export const keepJournal = (journal: StartJournal) => {
  fs.mkdirSync(CALLS, { recursive: true, mode: 0o700 });
  writePrivate(journalFile(journal.id), JSON.stringify(journal));
};

/** Calls that start work, being done now in this process: one that comes again meanwhile, or the
 * round that finishes those cut short, leaves it be. */
export const startsRunning = new Set<string>();

/** A lead on another computer starting a session here (`takeCall`'s, once it's checked who it's
 * from): started once, kept as it goes, and what it said. */
export async function takeStart(journal: StartJournal, places: { readEngine: () => Target; bridge: () => Target | null }): Promise<{ text: string; refused: boolean }> {
  if (journal.done) return journal.done;
  startsRunning.add(journal.id);
  try {
    const done = await finishStart(journal, places);
    journal.done = done;
    keepJournal(journal);
    return done;
  } finally {
    startsRunning.delete(journal.id);
  }
}

// The start, from where it got to: not made yet (or made with nothing to show for it), started;
// made, marked and told its task as far as it wasn't.
async function finishStart(journal: StartJournal, places: { readEngine: () => Target; bridge: () => Target | null }): Promise<{ text: string; refused: boolean }> {
  keepJournal(journal);
  if (journal.making && !journal.session) {
    const found = await madeFor(journal.making.target, journal.id).catch(() => null);
    if (found) journal.session = found;
  }
  if (journal.making && journal.session) {
    const making = journal.making;
    const session = journal.session;
    if (!journal.marked) {
      journal.marked = await markMade(making, session);
      keepJournal(journal);
    }
    if (!journal.prompted) {
      try {
        if (!(await toldAlready(making, session))) await promptMade(making, session);
      } catch (error) {
        return { text: `Started a session (address ${session}), but the task didn't reach it: ${String((error as Error | null)?.message ?? error)}`, refused: true };
      }
      journal.prompted = true;
      keepJournal(journal);
    }
    const words = startedWords({ started: { session, ...making.started, ...(journal.marked ? {} : { wakes: undefined }) } }, false);
    return { text: words.text, refused: words.isError };
  }
  const remote: RemoteLead = {
    call: journal.id, computer: journal.computer, key: journal.sender, approval: journal.start.approval, held: journal.start.held, agent: journal.start.agent,
    model: journal.start.model, autopilot: journal.start.autopilot, works: journal.start.works, own: journal.start.own, depth: journal.start.depth,
    line: journal.start.line, limits: journal.start.limits,
  };
  const outcome = await startSession(journal.given as StartGiven, { session: journal.from, place: null, name: journal.name, remote }, {
    readEngine: places.readEngine, bridge: places.bridge,
    steps: {
      making: making => { journal.making = making; keepJournal(journal); },
      made: session => { journal.session = session; keepJournal(journal); },
      marked: () => { journal.marked = true; keepJournal(journal); },
      prompted: () => { journal.prompted = true; keepJournal(journal); },
    },
  });
  const words = startedWords(outcome, false);
  return { text: words.text, refused: words.isError };
}

// The session a start's call made, as its mark says (`kuvo.call`), among the latest on `target`.
async function madeFor(target: Target, id: string): Promise<string | null> {
  const page = await engineCall(target, "GET", "/api/session?limit=50&order=desc&parentID=null") as unknown;
  const list = Array.isArray(page) ? page : isObject(page) && Array.isArray(page.data) ? page.data : [];
  const found = list.find((each: unknown) => isObject(each) && isObject(each.metadata) && isObject(each.metadata.kuvo) && each.metadata.kuvo.call === id) as { id?: unknown } | undefined;
  return typeof found?.id === "string" ? found.id : null;
}

// Whether the session was given its task already (its message with the task's id is there).
async function toldAlready(making: Making, session: string): Promise<boolean> {
  const page = await engineCall(making.target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=20&order=desc`) as unknown;
  const list = Array.isArray(page) ? page : isObject(page) && Array.isArray(page.data) ? page.data : [];
  return list.some((each: unknown) => isObject(each) && each.id === making.prompt.id);
}

/** Starts cut short (this box went down while one was being made), finished from the step each got
 * to, and its lead told how it went, as the call's answer; one older than a day isn't started any
 * more (what it was for may have changed), and the lead hears that. Done ones go after 30 days.
 * `answer`: how the answer is left for the lead's box. Looked at each round. */
export async function resumeStarts(answer: (journal: StartJournal, done: { text: string; refused: boolean }) => void, now = Date.now(), places = { readEngine: readEngineFile, bridge: bridgeTarget }): Promise<void> {
  for (const name of listOf(CALLS)) {
    if (!name.endsWith(".json")) continue;
    const journal = readJournal(name.slice(0, -5));
    if (!journal) continue;
    if (journal.done) {
      if (now - journal.at > NOTE_MEMORY) fs.rmSync(journalFile(journal.id), { force: true });
      continue;
    }
    if (startsRunning.has(journal.id)) continue;
    // (Switched off since, or the computer it's from removed: not finished here; said as far as
    // it got.)
    if (!otherComputersAllowed() || !peersOf(readLink()).some(peer => peer.key === journal.sender)) {
      const why = !otherComputersAllowed() ? "this computer stopped taking work from your other computers" : "your computer was removed from this one";
      if (journal.making && !journal.session) journal.session = await madeFor(journal.making.target, journal.id).catch(() => null) ?? undefined;
      journal.done = journal.making && journal.session && journal.prompted
        ? { text: startedWords({ started: { session: journal.session, ...journal.making.started, ...(journal.marked ? {} : { wakes: undefined }) } }, false).text, refused: false }
        : journal.session
          ? { text: `Started a session (address ${journal.session}), but it wasn't given its task: ${why} first.`, refused: true }
          : { text: `The session wasn't started: ${why} before it was made.`, refused: true };
      keepJournal(journal);
      answer(journal, journal.done);
      continue;
    }
    if (now - journal.made > LETTER_LIFE && !journal.session) {
      journal.done = { text: `The session wasn't started: this computer went down while starting it, and it's been over a day since you asked. Start it again if it's still needed.`, refused: true };
      keepJournal(journal);
      answer(journal, journal.done);
      continue;
    }
    let engine: Target | null = null;
    try { engine = places.readEngine(); } catch {}
    // (Its engine isn't running yet: the next round.)
    if (!engine) continue;
    const done = await takeStart(journal, places).catch(() => null);
    if (done) answer(journal, done);
  }
}

// ---- Stop All, on your other computers ----

/** Every session under `lead` here that's working, waiting on an answer or on a timer of its own,
 * made before `before`, stopped (a bot's Stop All, from the computer it lives on): how many. */
export async function stopLineWork(lead: string, before: number, targets: Target[], signal?: AbortSignal): Promise<number> {
  const work = under(lead, await workSessions(targets, signal)).filter(each => (each.data.time?.created ?? 0) <= before);
  if (!work.length) return 0;
  const [working, turns] = await Promise.all([atWorkNow(targets, signal), workingNow(targets, signal)]);
  let stopped = 0;
  for (const each of work) {
    const asking = !turns.has(each.data.id) && await askingNow(each, signal);
    if (!working.has(each.data.id) && !hasWakeUps(each.data.id) && !asking) continue;
    if (await stopWork(each.target, each.data.id, turns.has(each.data.id) || Boolean(asking)).then(() => true, () => false)) stopped += 1;
  }
  return stopped;
}

/** A bot's Stop All reaching your other computers: each that takes it is told to stop the work
 * under the bot's conversation there, kept for one that's away until it's back (only what was
 * started before now: work the bot starts after it's back is its own). `leave`: how it's left. */
export function stopBotWorkElsewhere(bot: string, leave: (peer: string, from: string, call: { tool: "stop_work"; args: Record<string, unknown>; as: { name: string; rules: KitRule[]; free: boolean } }) => void, now = Date.now()): number {
  const here = botHere(bot);
  if (!here?.session) return 0;
  const told = readPeerAgents();
  const peers = peersOf(readLink()).filter(peer => (told[peer.key]?.features ?? []).includes(START_FEATURE));
  for (const peer of peers) leave(peer.key, here.session, { tool: "stop_work", args: { before: now }, as: { name: plainName(here.described.name) || "a bot", rules: [], free: false } });
  return peers.length;
}

/** The list_models and list_projects of this box, for a lead on another computer. */
export async function readHere(tool: "list_models" | "list_projects", places: { readEngine: () => Target; bridge: () => Target | null }, where: string): Promise<ToolAnswer> {
  if (tool === "list_projects") return listProjectsTool(where);
  let engine: Target | null = null;
  try { engine = places.readEngine(); } catch {}
  return listModelsTool(engine, places.bridge(), undefined, where);
}

/** Word from the box that called that the conversations above its lead live where it says, kept
 * only for those this box has no word on yet, and only on boxes it knows. */
export function noteLineHomes(homes: Record<string, string>, line: readonly string[], at = Date.now()): void {
  const keys = new Set(peersOf(readLink()).map(peer => peer.key));
  const known = homesOf(readLink());
  for (const [session, key] of Object.entries(homes)) if (line.includes(session) && keys.has(key) && !known.has(session)) noteHomes([session], key, at);
}
