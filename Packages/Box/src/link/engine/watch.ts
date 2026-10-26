// @ts-nocheck
// The events in a `text/event-stream` body, parsed.

import { pause } from "../../shared/wait";
import { noteSignIn } from "../areas/accounts";
import { nameWorktreeBranch, tellWorktree } from "../areas/worktrees";
import { freshenBot, freshenBots } from "../bots/tell";
import { ANSWERED, GROUP_NEWS, NEWS, groupNotice, noticeFor, settleHeld } from "../notices/news";
import { engineGet, readBridgeFile, readEngineFile } from "./client";

async function* serverEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
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
export function steering(background, { after = STEER_AFTER, now = Date.now, schedule = setTimeout, cancel = clearTimeout, signal } = {}) {
  const sessions = new Map(); // session → { names: call → tool, blocking: call → when it started, steers: messages waiting for its next step }
  const users = new Set(); // messages sent as a message (steered or queued) that wait
  const timers = new Map();
  const of = session => {
    if (!sessions.has(session)) sessions.set(session, { names: new Map(), blocking: new Map(), steers: new Set() });
    return sessions.get(session);
  };
  const forget = session => {
    sessions.delete(session);
    cancel(timers.get(session));
    timers.delete(session);
  };
  signal?.addEventListener("abort", () => { for (const session of [...timers.keys()]) forget(session); }, { once: true });
  const consider = session => {
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
  const steer = (session, inbox) => {
    of(session).steers.add(inbox);
    consider(session);
  };
  return event => {
    const data = event?.data ?? {};
    const session = data.sessionID;
    if (typeof session !== "string") return;
    switch (event.type) {
      case "session.tool.input.started":
        if (typeof data.id === "string") of(session).names.set(data.id, data.name);
        break;
      case "session.tool.called": {
        const kept = of(session);
        const name = data.name ?? kept.names.get(data.id);
        kept.names.delete(data.id);
        if (!["shell", "subagent"].includes(name) || data.input?.background === true) break;
        kept.blocking.set(data.id, now());
        consider(session);
        break;
      }
      case "session.tool.success":
      case "session.tool.failed":
        sessions.get(session)?.names.delete(data.id);
        sessions.get(session)?.blocking.delete(data.id);
        break;
      case "session.inbox.enqueued":
        if (data.item?.type !== "user") break;
        users.add(data.inboxID);
        if (data.item.delivery === "steer") steer(session, data.inboxID);
        break;
      // Sent now, from the queue (Send Now): read at once too; put back in the queue: not.
      case "session.inbox.delivery.changed":
        if (data.delivery === "steer" && users.has(data.inboxID)) steer(session, data.inboxID);
        else sessions.get(session)?.steers.delete(data.inboxID);
        break;
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        users.delete(data.inboxID);
        sessions.get(session)?.steers.delete(data.inboxID);
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
function backgroundTools(engine, session) {
  return fetch(`http://127.0.0.1:${engine.port}/api/session/${encodeURIComponent(session)}/background`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  });
}


// Follows `source`'s events (the engine's, or the coding agents' bridge's: `read` gives its port
// and password) for as long as the bridge runs (or until `signal` stops it, a test's), handing
// each one's notification to `tell` and each request answered to `answered`, and doing what the
// box does as they come.
// `bots`: only its bots' part (this Mac's box, whose app does the rest of a machine's work);
// `notices`: news for your phones too (a machine's, and this Mac's box while its phone link is
// on); `signIns`: sign-ins its engine's runs were refused noted (`kuvo/accounts/ended`); `hold`:
// where those notices wait, settled each time the events are heard again (`settleHeld`).
// What a box watches its engine and its coding agents' bridge for, as a machine's link (`run`)
// and a box's own work (`serve`) both start it: its bots kept told what they are, its sign-ins that
// ended noted, and with `notices`, its news for your phones (`tell`, held in `hold`). `bots`: only
// its bots' part of the box's work (this Mac's box, whose app does the rest).
export function watchBox({ tell = () => true, hold = null, bots = false, notices = !bots, signal, signedIn } = {}) {
  const answered = id => hold?.resolve(id);
  watchEvents(readEngineFile, tell, signal, answered, { bots, notices, signIns: true, hold, signedIn, steers: true });
  watchEvents(readBridgeFile, tell, signal, answered, { bots, notices });
}

// `signedIn`: told once each event's been looked at for sign-ins (a test waits on it).
// `steers`: your messages to an agent waiting on a command read at once (`steering`), the engine's.
export async function watchEvents(read, tell, signal, answered = () => {}, { bots = false, notices = !bots, signIns = false, hold = null, signedIn = () => {}, steers = false, steerAfter } = {}) {
  let attempt = 0;
  while (!signal?.aborted) {
    // What this connection set going ends with it: what it heard of can't be settled once it's gone.
    const connection = new AbortController();
    const stop = () => connection.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const source = read();
      const steer = steers ? steering(session => backgroundTools(source, session).catch(() => {}), { after: steerAfter, signal: connection.signal }) : null;
      const response = await fetch(`http://127.0.0.1:${source.port}/api/event`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${source.password}`).toString("base64")}`, accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`${response.status}`);
      attempt = 0;
      // What was answered while its events couldn't be heard (it restarted, the stream dropped).
      if (notices && hold) settleHeld(source, hold).catch(() => {});
      // Found it (it started, or this did): its bots told what they are now, before their next turn.
      freshenBots(source).catch(() => {});
      for await (const event of serverEvents(response.body)) {
        // The box's own work, Mac connected or not: a session made in one of its worktrees told
        // so; a worktree's branch named after its session; a bot's job read from its memory as
        // its run ends.
        // A bot's run starting: what it's told brought up to date first.
        if (event.type === "session.execution.started") freshenBot(source, event.data?.sessionID).catch(() => {});
        steer?.(event);
        if (signIns) noteSignIn(event, source).catch(() => {}).finally(() => signedIn(event));
        if (!bots) {
          if (event.type === "session.created") tellWorktree(source, event.data?.sessionID ?? event.data?.info?.id).catch(() => {});
          if (event.type === "session.renamed") nameWorktreeBranch(source, event.data?.sessionID).catch(() => {});
        }
        if (!notices) continue;
        if (ANSWERED.has(event.type)) answered(event.data?.requestID ?? event.data?.id);
        if (!NEWS.has(event.type) && !GROUP_NEWS.has(event.type)) continue;
        if (GROUP_NEWS.has(event.type)) {
          const notice = groupNotice(event);
          if (notice) tell(notice);
          continue;
        }
        noticeFor(event, route => engineGet(source, route)).then(notice => notice && tell(notice)).catch(() => {});
      }
    } catch {}
    stop();
    signal?.removeEventListener("abort", stop);
    attempt += 1;
    await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), signal);
  }
}