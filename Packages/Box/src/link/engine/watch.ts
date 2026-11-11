// Watching this box's engine and its coding agents' bridge: their events followed, and what the
// box does as they come (its bots kept told, ended sign-ins noted, news for your phones, a message
// that steers an agent read at once).

import { pause } from "../../shared/wait";
import { noteSignIn } from "../areas/accounts";
import { letAttachmentsGo } from "../server/attached";
import { nameDueWorktrees, nameWorktreeBranch, settleNewSession, tidyWorktrees } from "../areas/worktrees";
import { finishDeletes } from "../bots/edit";
import { freshenBot, freshenBots } from "../bots/tell";
import { ANSWERED, GROUP_NEWS, NEWS, RUN_ENDS, groupNotice, noticeFor, settleHeld } from "../notices/news";
import { keepReadThroughSummary } from "../work/tree";
import { bridgeTarget, engineGet, peerTargets, readBridgeFile, readEngineFile } from "./client";
import { applyCompatibility, followSettingsFile, learnCompatibility } from "./compatibility";
import { modelsDue, settleDueModels, WORK_ENDS } from "./models";
import { goalHolds, settleGoalHolds } from "../work/goals";
import { workWatcher } from "../work/wakes";
import { reviewPermission, settleAskReview, settleRunReviews, takeUpWaitingAsks } from "../work/reviewing";
import { forgetReviews } from "../work/reviewer";
import { forgetDecided } from "../work/autopilot";
import { backUpSession } from "../work/backups";
import { markConversation, noteFullAccess, noteFullAccessAtWork } from "../work/full";
import { queueWatcher, scanQueues, type ScanFound } from "./queue";
import { adoptConversation } from "../areas/approval";
import { followAsks, forgetAsksOn, noteAskEvent } from "../glance/asked";
import { pullCatcher } from "../glance/pulls";
import type { Target } from "../../shared/records";
import type { SignInEvent } from "../areas/accounts";
import type { NoticeHold } from "../notices/hold";
import type { EngineEvent, GroupEvent } from "../notices/news";
import type { Notice } from "../notices/notice";
import type { QueueEvent } from "./queue";
import type { SessionNotes } from "./sessions";

/** An engine event `steering` follows, for its session: a tool call that started, was called or
 * ended (its `id`, its tool's `name`, and with its `input`, whether it runs in the background); a
 * message queued, sent now, put back, delivered or cancelled (its `inboxID`, what it is, and how
 * it's sent); a run that ended. */
export interface SteeringEvent {
  type: string;
  data?: {
    sessionID?: string;
    id?: string;
    name?: string;
    input?: { background?: unknown };
    inboxID?: string;
    item?: { type?: string; delivery?: string };
    delivery?: string;
  };
}

/** An event from the engine or the coding agents' bridge (`/api/event`), as this box reads them:
 * each part of its work takes what it knows of it, and a request answered names its `requestID`, a
 * session made its `info`. */
export type BoxEvent = EngineEvent & SignInEvent & GroupEvent & SteeringEvent & { data?: { requestID?: string; info?: { id?: string } } };

/** A session's notes changed to say it's archived, or without saying what they are now (the coding
 * agents' bridge names only the session). */
function isArchiving(event: BoxEvent): boolean {
  const metadata = (event.data as { metadata?: SessionNotes } | undefined)?.metadata;
  return !metadata || metadata["kuvo.archived"] === true || metadata.kuvo?.archived === true;
}

/** How `steering` waits: how long a call runs before a message is read at once (ms), and its clock
 * (a test's own), and `signal`, which stops it. */
export interface SteeringOptions {
  after?: number;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout> | undefined) => void;
  signal?: AbortSignal;
}

/** What `steering` keeps of a session: the tool of each call it's starting, when each call it
 * waits on started (ms), and the messages waiting for its next step. */
interface SteeredSession {
  names: Map<string, string | undefined>;
  blocking: Map<string, number>;
  steers: Set<string>;
}

/** What `watchBox` is told: where its news goes (`tell`), where it waits (`hold`), which part of the
 * box's work it does, and for a test, `signal` and `signedIn`. */
export interface WatchBoxOptions {
  tell?: (notice: Notice) => void;
  hold?: NoticeHold | null;
  bots?: boolean;
  notices?: boolean;
  signal?: AbortSignal;
  signedIn?: (event: BoxEvent) => void;
  learned?: () => void;
  attachmentsLooked?: (session: string | null) => void;
}

/** Which part of the box's work `watchEvents` does as events come (and `steerAfter`, a test's wait
 * for `steering`). */
export interface WatchOptions {
  bots?: boolean;
  notices?: boolean;
  signIns?: boolean;
  hold?: NoticeHold | null;
  signedIn?: (event: BoxEvent) => void;
  steers?: boolean;
  steerAfter?: number;
  learns?: boolean;
  learned?: () => void;
  queues?: boolean;
  /** Whoever started a session told as it finishes or asks, as which of the box's places this is
   * (`work/wakes.ts`, `WorkWatch.from`). */
  work?: "engine" | "bridge" | false;
  /** The agents' bridge's, which keeps conversations' goals: one paused or resumed held or let go. */
  goals?: boolean;
  /** Told each time a deleted session's files were looked at (`session`), or, as the box finds
   * its engine, those of every session it no longer has (null): a test waits on it. */
  attachmentsLooked?: (session: string | null) => void;
}

// The events in a `text/event-stream` body, parsed.
async function* serverEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<BoxEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "") {
        if (data.length) {
          try { yield JSON.parse(data.join("\n")); } catch {}
        }
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
}

// A message that reaches an agent while it waits on a command or a subagent it started in the
// foreground is read at once, as it would be at the agent's next step, rather than when the command
// ends: what it waits on goes on in the background, and the agent is told when it ends (the engine's
// own Ctrl+B in its terminal). Only messages sent to steer (yours, or another agent's letter), never
// one queued for after the turn, a wake-up or the engine's own notes; and only once what it waits
// on has run for `after` ms, so a quick command simply ends first. While one still waits behind it
// (the call was asking you something first, say), it's tried again every `after` ms.
// `background(session)` does it; each event from the engine goes to what this returns.
export const STEER_AFTER = 3000;
// How often a box reads its engine's models again, at most, while the engine's at work.
const LEARN_EVERY = 600_000;
// The engine's events after which it reads them again at once: an account added, removed, signed in
// to again or switched to, and the engine's list of models changed (an account's models come a
// moment after its sign-in).
const LEARN_NOW = new Set(["credential.updated", "credential.switched", "integration.updated", "model.updated"]);
export function steering(background: (session: string) => unknown, { after = STEER_AFTER, now = Date.now, schedule = setTimeout, cancel = clearTimeout, signal }: SteeringOptions = {}): (event: SteeringEvent) => void {
  const sessions = new Map<string, SteeredSession>(); // session → { names: call → tool, blocking: call → when it started, steers: messages waiting for its next step }
  const users = new Set<string>(); // messages sent as a message (steered or queued) that wait
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const of = (session: string): SteeredSession => {
    if (!sessions.has(session)) sessions.set(session, { names: new Map(), blocking: new Map(), steers: new Set() });
    return sessions.get(session)!;
  };
  const forget = (session: string) => {
    sessions.delete(session);
    cancel(timers.get(session));
    timers.delete(session);
  };
  signal?.addEventListener("abort", () => { for (const session of [...timers.keys()]) forget(session); }, { once: true });
  const consider = (session: string): void => {
    const { blocking, steers } = of(session);
    if (!blocking.size || !steers.size || timers.has(session) || signal?.aborted) return;
    const due = Math.min(...blocking.values()) + after;
    timers.set(session, schedule(() => {
      timers.delete(session);
      const { blocking, steers } = of(session);
      if (!blocking.size || !steers.size) return;
      // The call it was timed by ended meanwhile: the next one gets its moment too.
      if (Math.min(...blocking.values()) + after > now()) return consider(session);
      background(session);
      timers.set(session, schedule(() => { timers.delete(session); consider(session); }, after));
    }, Math.max(0, due - now())));
  };
  const steer = (session: string, inbox: string) => {
    of(session).steers.add(inbox);
    consider(session);
  };
  return event => {
    const data = event?.data ?? {};
    const session = data.sessionID;
    if (typeof session !== "string") return;
    // Each event names what it's about: a tool call's, its call (`id`); a message's, its `inboxID`.
    switch (event.type) {
      case "session.tool.input.started":
        if (typeof data.id === "string") of(session).names.set(data.id, data.name);
        break;
      case "session.tool.called": {
        const kept = of(session);
        const name = data.name ?? kept.names.get(data.id!);
        kept.names.delete(data.id!);
        if (!(["shell", "subagent"] as (string | undefined)[]).includes(name) || data.input?.background === true) break;
        kept.blocking.set(data.id!, now());
        consider(session);
        break;
      }
      case "session.tool.success":
      case "session.tool.failed":
        sessions.get(session)?.names.delete(data.id!);
        sessions.get(session)?.blocking.delete(data.id!);
        break;
      case "session.inbox.enqueued":
        if (data.item?.type !== "user") break;
        users.add(data.inboxID!);
        if (data.item.delivery === "steer") steer(session, data.inboxID!);
        break;
      // Sent now, from the queue (Send Now): read at once too; put back in the queue: not.
      case "session.inbox.delivery.changed":
        if (data.delivery === "steer" && users.has(data.inboxID!)) steer(session, data.inboxID!);
        else sessions.get(session)?.steers.delete(data.inboxID!);
        break;
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        users.delete(data.inboxID!);
        sessions.get(session)?.steers.delete(data.inboxID!);
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        forget(session);
        break;
    }
  };
}

// Moves what a session waits on in the foreground (its commands, its subagents) to the background.
function backgroundTools(engine: Target, session: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${engine.port}/api/session/${encodeURIComponent(session)}/background`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  });
}


// What a box watches its engine and its coding agents' bridge for, as a machine's link (`run`)
// and a box's own work (`serve`) both start it: its bots kept told what they are, its sign-ins that
// ended noted, and with `notices`, its news for your phones (`tell`, held in `hold`). `bots`: only
// its bots' part of the box's work (this Mac's box, whose app does the rest).
// `learned`: told each time it's read its engine's models for what they need (a test waits on it),
// and `attachmentsLooked`, each time it's looked at what deleted sessions left.
export function watchBox({ tell = () => true, hold = null, bots = false, notices = !bots, signal, signedIn, learned, attachmentsLooked }: WatchBoxOptions = {}): void {
  const answered = (id: string | undefined) => hold?.resolve(id);
  // What waits on you that the box asks itself, and what Auto's reviewer takes up, for the rows'
  // "since" (glance/asked.ts).
  const stopAsks = followAsks();
  signal?.addEventListener("abort", stopAsks, { once: true });
  watchEvents(readEngineFile, tell, signal, answered, { bots, notices, signIns: true, hold, signedIn, steers: true, learns: true, learned, queues: true, work: "engine", attachmentsLooked });
  watchEvents(readBridgeFile, tell, signal, answered, { bots, notices, queues: true, work: "bridge", goals: true, attachmentsLooked });
}

// The files deleted sessions left on this box (`session`'s, or with none, any deleted while it
// wasn't listening) let go, the box's sessions as they are now: then `looked` told.
function letSessionFilesGo(looked: (session: string | null) => void, session?: string): void {
  let places;
  try { places = { engine: readEngineFile(), bridge: bridgeTarget() }; } catch { return looked(session ?? null); }
  letAttachmentsGo(places, session).finally(() => looked(session ?? null));
}

// Follows `source`'s events (the engine's, or the coding agents' bridge's: `read` gives its port
// and password) for as long as the bridge runs (or until `signal` stops it, a test's), handing
// each one's notification to `tell` and each request answered to `answered`, and doing what the
// box does as they come.
// `bots`: only its bots' part (this Mac's box, whose app does the rest of a machine's work);
// `notices`: news for your phones too (a machine's, and this Mac's box while its phone link is
// on); `signIns`: sign-ins its engine's runs were refused noted (`kuvo/accounts/ended`); `hold`:
// where those notices wait, settled each time the events are heard again (`settleHeld`).
// `signedIn`: told once each event's been looked at for sign-ins (a test waits on it).
// `steers`: your messages to an agent waiting on a command read at once (`steering`), the engine's.
// `learns`: what its providers' models need from it learned and applied to it at once
// (`learnCompatibility`), the engine's: as it's found, at once as an account is added, removed or
// signed in to again and as its models change, and every ten minutes at most while it's at work
// besides; `learned` told each time. And the folders a refresh of its models left at work closed
// once their work is done (`settleDueModels`).
// `queues`: its sessions' queues carried on (engine/queue.ts). `work`: whoever started a session
// told as it finishes or asks (work/wakes.ts), as the place it is ("engine" or "bridge").
// Either way, a deleted session's files go with it (`letAttachmentsGo`), and any a session deleted
// meanwhile left as it's found again.
export async function watchEvents(read: () => Target, tell: (notice: Notice) => void, signal?: AbortSignal, answered: (id: string | undefined) => void = () => {}, { bots = false, notices = !bots, signIns = false, hold = null, signedIn = () => {}, steers = false, steerAfter, learns = false, learned = () => {}, queues = false, work = false, goals = false, attachmentsLooked = () => {} }: WatchOptions = {}): Promise<void> {
  let attempt = 0;
  let lastLearned = 0;
  let learning = false;
  let learnAgain: Target | null = null;
  // Counted once it's learned: one the engine couldn't answer yet (just started) goes again with
  // its next event. `now`: at once, whenever it last did (an account added, removed or signed in
  // to again, or its models changed), and once more after one under way, which may have read
  // the engine before the change.
  const learn = (source: Target, now = false) => {
    if (!learns) return;
    if (learning) {
      // (With the engine as it was found last.)
      if (now) learnAgain = source;
      return;
    }
    if (!now && Date.now() - lastLearned < LEARN_EVERY) return;
    learning = true;
    learnCompatibility(source).then(() => { lastLearned = Date.now(); }, () => {}).finally(() => {
      learning = false;
      learned();
      const again = learnAgain;
      learnAgain = null;
      if (again) learn(again, true);
    });
  };
  // What its engine applies at once (`applyCompatibility`), as this box last learned it: a box
  // that learned it before it kept it there.
  if (learns) {
    try { applyCompatibility(); } catch {}
  }
  while (!signal?.aborted) {
    // What this connection set going ends with it: what it heard of can't be settled once it's gone.
    const connection = new AbortController();
    const stop = () => connection.abort();
    signal?.addEventListener("abort", stop, { once: true });
    let workGone: (() => void) | null = null;
    try {
      const source = read();
      const steer = steers ? steering(session => backgroundTools(source, session).catch(() => {}), { after: steerAfter, signal: connection.signal }) : null;
      // (What the scan finds at work, the watcher settles once it's free.)
      const found: ScanFound = new Map();
      const queue = queues ? queueWatcher(source, { found }) : null;
      const followWork = work ? workWatcher(source, peerTargets, { signal: connection.signal, from: work }) : null;
      workGone = followWork?.gone ?? null;
      // A goal paused or resumed (the agents' bridge says so): its conversation held or let go.
      const goalHeld = goals ? goalHolds(peerTargets) : null;
      // A pull request a session made itself with `gh`, kept as its own (glance/pulls.ts).
      const catchPull = pullCatcher(() => source);
      const response = await fetch(`http://127.0.0.1:${source.port}/api/event`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${source.password}`).toString("base64")}`, accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`${response.status}`);
      attempt = 0;
      // When what it asks came: what it asked meanwhile went by unheard (glance/asked.ts).
      forgetAsksOn(work || String(source.port));
      // What was answered while its events couldn't be heard (it restarted, the stream dropped).
      if (notices && hold) settleHeld(source, hold).catch(() => {});
      // Found it (it started, or this did): its bots told what they are now, before their next turn,
      // and a queue it left waiting held for Resume.
      freshenBots(source).catch(() => {});
      // What bots deleted while it wasn't answering left of it, and sessions deleted meanwhile.
      finishDeletes(readEngineFile, bridgeTarget).catch(() => {});
      letSessionFilesGo(attachmentsLooked);
      lastLearned = 0;
      learn(source);
      if (learns) followSettingsFile();
      if (learns && modelsDue()) settleDueModels(source).catch(() => {});
      if (queues) scanQueues(source, found).catch(() => {});
      // Its worktrees' sessions titled while it wasn't listening: their branches named; and those
      // whose last session went meanwhile tidied.
      if (!bots) nameDueWorktrees(source, connection.signal).then(() => tidyWorktrees(connection.signal)).catch(() => {});
      // A goal's change it missed meanwhile: what's held for one let go, or kept, as it is now.
      if (goalHeld) settleGoalHolds(source, goalHeld).catch(() => {});
      // Full Access's list for the sandbox's launcher, for those at work now (one changed meanwhile).
      if (work) noteFullAccessAtWork(source, atWork).catch(() => {});
      // Asks to work outside a folder waiting already (it started again as they came, or their
      // event went by unheard): taken up now, so every client's list of them is whole.
      if (work) atWork(source).then(sessions => takeUpWaitingAsks(source, sessions, connection.signal)).catch(() => {});
      for await (const event of serverEvents(response.body)) {
        // The box's own work, Mac connected or not: a session made in one of its worktrees told
        // so; a worktree's branch named after its session (as it's made with a title, or given
        // one); a bot's job read from its memory as its run ends.
        // A bot's run starting: what it's told brought up to date first (a run's events name its session).
        if (event.type === "session.execution.started") freshenBot(source, event.data?.sessionID!).catch(() => {});
        // Its repository's branches and stashes kept as each run starts and ends, whatever the agent
        // and its approval, so what a turn takes from them can be taken back (work/backups.ts).
        if (work && (event.type === "session.execution.started" || RUN_ENDS.has(event.type)) && typeof event.data?.sessionID === "string") backUpSession(source, event.data.sessionID).catch(() => {});
        // Whether its commands run outside the sandbox (Full Access), kept for the launcher as each
        // run starts, before any command of it, and as its approval changes.
        if (work && (event.type === "session.execution.started" || event.type === "session.created" || event.type === "session.metadata.updated" || event.type === "session.updated")) noteFullAccess(event.data?.sessionID ?? event.data?.info?.id).catch(() => {});
        if (work && event.type === "session.deleted" && typeof event.data?.sessionID === "string") markConversation(event.data.sessionID, false);
        // One a client made without a kept approval: the one it was made with, else this computer's
        // default (a client from before never gets Full Access unasked).
        if (work && event.type === "session.created") adoptConversation(source, event.data?.sessionID ?? event.data?.info?.id, work === "bridge").catch(() => {});
        if (event.type === "session.deleted" && typeof event.data?.sessionID === "string") {
          letSessionFilesGo(attachmentsLooked, event.data.sessionID);
          forgetReviews(event.data.sessionID);
          forgetDecided(event.data.sessionID);
        }
        learn(source, LEARN_NOW.has(event.type));
        noteAskEvent(event, work || String(source.port));
        catchPull(event);
        // Your settings changed by hand meanwhile: the model your subagents use follows them.
        if (learns && (event.type === "session.execution.started" || event.type === "config.updated")) followSettingsFile();
        // Folders a refresh of the models left at work, closed once their work is done.
        if (learns && WORK_ENDS.has(event.type) && modelsDue()) settleDueModels(source).catch(() => {});
        steer?.(event);
        queue?.(event as QueueEvent);
        const followed = followWork?.(event);
        // A conversation in Auto: what its agent's file tools ask outside its folder, reviewed (and
        // told to your phones below only where it isn't: the reviewer never leaves one for you).
        const reviewed = work && event.type === "permission.asked" ? reviewPermission(source, event, connection.signal).catch(() => null) : null;
        goalHeld?.(event).catch(() => {});
        if (signIns) noteSignIn(event, source).catch(() => {}).finally(() => signedIn(event));
        if (work && event.type === "session.execution.succeeded" && typeof event.data?.sessionID === "string") keepReadThroughSummary(source, event.data.sessionID, connection.signal).catch(() => {});
        if (!bots) {
          if (event.type === "session.created") settleNewSession(source, event.data?.sessionID ?? event.data?.info?.id).catch(() => {});
          if (event.type === "session.renamed") nameWorktreeBranch(source, event.data?.sessionID).catch(() => {});
          // A worktree's last session archived or deleted, or an agent that kept one done: tidied.
          // One made there marks it as used, so deleting it before anything else happens takes it too.
          if (event.type === "session.created" || event.type === "session.deleted" || RUN_ENDS.has(event.type) || (event.type === "session.metadata.updated" && isArchiving(event))) tidyWorktrees(connection.signal).catch(() => {});
        }
        // An ask answered: off the list of what waits (on every source, the bridge's too).
        const settled = ANSWERED.has(event.type) ? event.data?.requestID ?? event.data?.id : undefined;
        if (typeof settled === "string") settleAskReview(settled);
        // A run's end takes what it asked with it, with no word of each.
        if (RUN_ENDS.has(event.type) && typeof event.data?.sessionID === "string") settleRunReviews(event.data.sessionID);
        if (!notices) continue;
        if (ANSWERED.has(event.type)) answered(event.data?.requestID ?? event.data?.id);
        // A run's end: what it asked the engine let go with it, without a word (stopped, say). Looked
        // up before what comes next, which may be its news.
        if (RUN_ENDS.has(event.type) && hold && typeof event.data?.sessionID === "string") await settleHeld(source, hold, event.data.sessionID).catch(() => {});
        if (!NEWS.has(event.type) && !GROUP_NEWS.has(event.type)) continue;
        if (GROUP_NEWS.has(event.type)) {
          const notice = groupNotice(event);
          if (notice) tell(notice);
          continue;
        }
        // (What it asks, once the box has looked: on Autopilot it may have gone ahead.)
        Promise.all([reviewed, event.type === "form.created" ? followed : null])
          .then(([verdict]) => (verdict ? null : noticeFor(event, (route, folder) => engineGet(source, route, folder))))
          .then(notice => notice && tell(notice))
          .catch(() => {});
      }
    } catch {}
    // (Before it's aborted, so what ran there isn't said to run while it can't be heard.)
    workGone?.();
    stop();
    signal?.removeEventListener("abort", stop);
    attempt += 1;
    await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), signal);
  }
}

/** The sessions at work on `target` now. */
async function atWork(target: Target): Promise<string[]> {
  const active = (await engineGet(target, "api/session/active").catch(() => null) as { data?: string[] | Record<string, unknown> } | null)?.data ?? {};
  return Array.isArray(active) ? active : Object.keys(active);
}
