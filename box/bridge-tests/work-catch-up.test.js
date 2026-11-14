// A box starting again tells a bot what its sessions did while it was down (PROTOCOL.md, "Work"),
// from each place they run (the engine, and the coding agents' bridge, found when each is), and
// only once it could look: an engine too slow or not yet there to list them is looked at again,
// never taken for one with nothing to tell. The real box code; only the engine and the bridge are
// stand-ins, and the watcher's clock is the test's.
//
// Run with `node --test box/bridge-tests/work-catch-up.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-work-catch-up-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

const tidepool = path.join(home, "work", "tidepool");
fs.mkdirSync(tidepool, { recursive: true });
const by = { bot: "bot_pixel00001", name: "Pixel" };
const toldFile = path.join(home, "run", "work", "told.json");

// A stand-in for the engine or the coding agents' bridge: its sessions, each with its last reply
// (none when `replied` is null), a turn after it that wrote none (`after`, the id of your message, or
// of the box's own with `startedBy: "synthetic"`), and messages after that (`later`: commands you
// ran, a model switch);
// `listing` false answers its list as an engine still starting does, and `unread` the sessions
// whose messages it can't read (an engine too slow); `looking` runs as it's asked what's working.
function place(sessions) {
  const state = { sessions, listing: true, unread: new Set(), prompts: [] };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url.startsWith("/api/session?")) return state.listing ? reply({ data: Object.values(sessions) }) : reply({ message: "Starting." }, 503);
      if (request.url === "/api/session/active") {
        state.looking?.();
        return reply({ data: {} });
      }
      if (/\/(permission|form)$/.test(request.url)) return reply({ data: [] });
      const one = request.url.match(/^\/api\/session\/([^/?]+)(\/[^?]*)?/);
      const id = one && decodeURIComponent(one[1]);
      if (one && !one[2]) return sessions[id] ? reply({ data: sessions[id] }) : reply({ message: "No such session." }, 404);
      if (one?.[2] === "/message" && state.unread.has(id)) return reply({ message: "Busy." }, 503);
      if (one?.[2] === "/message" && sessions[id]) {
        // A turn started after its reply that wrote none: what started it (your message, or the box's
        // own, as a goal's nudge), then its end (newest first). As many as the page asks for.
        const after = sessions[id].after ? [{ id: `${sessions[id].after}_end`, type: "idle", time: { created: 10 }, outcome: "failed" }, { id: sessions[id].after, type: sessions[id].startedBy ?? "user", time: { created: 10 }, content: [] }] : [];
        const later = (sessions[id].later ?? []).map(each => ({ ...each, time: { created: 11 } }));
        const limit = Number(new URL(request.url, "http://engine").searchParams.get("limit") ?? Infinity);
        const page = data => reply({ data: data.slice(0, limit) });
        if (sessions[id].replied === null) return page([...later, ...after]);
        return page([...later, ...after, ...(after.length ? [{ id: `msg_${id}_end`, type: "idle", time: { created: sessions[id].replied ?? 9 } }] : []), { id: `msg_${id}`, type: "assistant", time: { created: sessions[id].replied ?? 9 }, content: [{ type: "text", text: sessions[id].said ?? "Done." }] }, { id: `msg_${id}_asked`, type: "user", time: { created: 8 }, content: [] }]);
      }
      if (one?.[2] === "/prompt" && sessions[id]) {
        state.prompts.push({ to: id, ...JSON.parse(body) });
        return reply({});
      }
      reply({ message: "Not here." }, 404);
    });
  });
  const ready = new Promise(resolve => server.listen(0, "127.0.0.1", resolve)).then(() => {
    state.target = { port: server.address().port, password: "p" };
  });
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return Object.assign(state, { ready });
}

// Pixel's conversation and Sign-in, in the engine; Port, a Codex session Pixel started, in the bridge.
// Both finished while the box was down (updated at 10, after it last heard of anything, at 5).
const engine = place({
  ses_pixel: { id: "ses_pixel", title: "Pixel", location: { directory: path.join(home, "bots", "bot_pixel00001", "workspace") }, time: { created: 1, updated: 1 } },
  ses_signin: { id: "ses_signin", title: "Sign-in", location: { directory: tidepool }, time: { created: 1, updated: 10 }, said: "Sign-in works.", metadata: { kuvo: { startedBy: "ses_pixel", by, depth: 1, wake: ["finished"] } } },
  ses_docs: { id: "ses_docs", title: "Docs", location: { directory: tidepool }, time: { created: 1, updated: 1 }, said: "Docs written.", metadata: { kuvo: { startedBy: "ses_pixel", by, depth: 1, wake: ["finished"] } } },
});
const bridge = place({
  ses_port: { id: "ses_port", title: "Port", location: { directory: tidepool }, time: { created: 1, updated: 10 }, said: "Ported to Swift 6.", metadata: { kuvo: { startedBy: "ses_pixel", by, depth: 1, wake: ["finished"] } } },
});
await Promise.all([engine.ready, bridge.ready]);

// The watcher's clock: the time (`at`, from 1000 on, later than all the sessions' times unless a
// test says), and what it would run later, run when the test says (and waited on).
function clock() {
  const later = [];
  const kept = { at: 1000 };
  return Object.assign(kept, { now: () => kept.at, schedule: run => { later.push(run); }, runAll: async () => { for (const run of later.splice(0)) await run(); } });
}

beforeEach(() => {
  engine.prompts.length = 0;
  engine.listing = true;
  bridge.listing = true;
  engine.unread.clear();
  delete engine.looking;
  delete engine.sessions.ses_review;
  delete engine.sessions.ses_build;
  delete engine.sessions.ses_fix;
  engine.sessions.ses_signin.time = { created: 1, updated: 10 };
  fs.rmSync(path.join(home, "run", "work"), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(toldFile), { recursive: true });
  fs.writeFileSync(toldFile, JSON.stringify({ since: 5, sessions: {} }));
});

test("what finished while the box was down still reaches the bot when its engine couldn't list it yet as the box started: looked at again, not taken for nothing", async () => {
  engine.listing = false;
  const { schedule, runAll, now } = clock();
  const watch = link.workWatcher(engine.target, () => [engine.target], { schedule, now });
  await watch.caughtUp;
  await runAll();
  assert.deepEqual(engine.prompts, [], "nothing to tell yet: it couldn't look");
  engine.listing = true;
  await runAll();
  await runAll();
  assert.equal(engine.prompts.length, 1, "told once it could look");
  assert.equal(engine.prompts[0].to, "ses_pixel");
  assert.match(engine.prompts[0].text, /^\[Session finished\] "Sign-in" in tidepool \(address ses_signin\)/);
});

test("a box stopped again before it could look still tells it as it starts the next time", async () => {
  engine.listing = false;
  const first = clock();
  const watch = link.workWatcher(engine.target, () => [engine.target], { schedule: first.schedule, now: first.now });
  await watch.caughtUp;
  // Meanwhile another of Pixel's sessions finishes, heard as it happens.
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_docs" } });
  engine.listing = true;
  const again = clock();
  await link.workWatcher(engine.target, () => [engine.target], { schedule: again.schedule, now: again.now }).caughtUp;
  await again.runAll();
  assert.equal(engine.prompts.length, 1, "with what it heard meanwhile, as one message");
  assert.match(engine.prompts[0].text, /\[Session finished\] "Docs"/);
  assert.match(engine.prompts[0].text, /\[Session finished\] "Sign-in"/);
});

test("a coding agents' bridge found after the engine still tells what finished there while the box was down", async () => {
  const targets = () => [engine.target, bridge.target];
  const first = clock();
  await link.workWatcher(engine.target, targets, { schedule: first.schedule, now: first.now }).caughtUp;
  await first.runAll();
  assert.equal(engine.prompts.length, 1, "the engine's told");
  assert.match(engine.prompts[0].text, /^\[Session finished\] "Sign-in"/);
  // The bridge listens a moment later (it waits for the box's sandbox).
  const then = clock();
  await link.workWatcher(bridge.target, targets, { schedule: then.schedule, now: then.now, from: "bridge" }).caughtUp;
  await then.runAll();
  assert.equal(engine.prompts.length, 2, "the bridge's too");
  assert.equal(engine.prompts[1].to, "ses_pixel");
  assert.match(engine.prompts[1].text, /^\[Session finished\] "Port" in tidepool \(address ses_port\)[^\n]*:\nPorted to Swift 6\./);
  // And not again, from either, as the box starts the next time.
  const next = clock();
  await link.workWatcher(engine.target, targets, { schedule: next.schedule, now: next.now }).caughtUp;
  await link.workWatcher(bridge.target, targets, { schedule: next.schedule, now: next.now, from: "bridge" }).caughtUp;
  await next.runAll();
  assert.equal(engine.prompts.length, 2);
});

test("a session told as it finished while the box couldn't look back yet isn't told again once it can, even when its reply couldn't be read then", async () => {
  engine.listing = false;
  const { schedule, runAll, now } = clock();
  const watch = link.workWatcher(engine.target, () => [engine.target], { schedule, now });
  await watch.caughtUp;
  // Sign-in's finish is heard as it happens, with its engine too slow to show its reply.
  engine.unread.add("ses_signin");
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_signin" } });
  engine.unread.clear();
  // Changed since (renamed, say), with nothing new said.
  engine.sessions.ses_signin.time = { created: 1, updated: 1500 };
  engine.listing = true;
  await runAll();
  await runAll();
  assert.equal(engine.prompts.length, 1);
  assert.equal(engine.prompts[0].text.match(/\[Session finished\] "Sign-in"/g)?.length, 1, "told once");
});

test("one session whose reply can't be read doesn't keep the bot from hearing of the others", async () => {
  // Review, started after Sign-in, finished too; its engine can't show its messages.
  engine.sessions.ses_review = { ...engine.sessions.ses_signin, id: "ses_review", title: "Review", time: { created: 2, updated: 10 }, said: "Reviewed." };
  engine.unread.add("ses_review");
  const { schedule, runAll, now } = clock();
  await link.workWatcher(engine.target, () => [engine.target], { schedule, now }).caughtUp;
  await runAll();
  assert.equal(engine.prompts.length, 1, "Sign-in, told");
  assert.match(engine.prompts[0].text, /^\[Session finished\] "Sign-in"/);
  assert.equal(JSON.parse(fs.readFileSync(toldFile, "utf8")).since, 5, "not counted as looked at: Review wasn't");
  // Once Review can be read, it's told too, and Sign-in not again.
  engine.unread.clear();
  await runAll();
  await runAll();
  assert.equal(engine.prompts.length, 2);
  assert.match(engine.prompts[1].text, /^\[Session finished\] "Review"[^\n]*:\nReviewed\./);
});

test("a session that can't be read for long is let go of for now, and told as the box starts the next time", async () => {
  engine.sessions.ses_review = { ...engine.sessions.ses_signin, id: "ses_review", title: "Review", time: { created: 2, updated: 10 }, said: "Reviewed." };
  engine.unread.add("ses_review");
  const first = clock();
  await link.workWatcher(engine.target, () => [engine.target], { schedule: first.schedule, now: first.now }).caughtUp;
  for (let tries = 0; tries < 12; tries++) await first.runAll();
  assert.equal(engine.prompts.length, 1, "Sign-in, told");
  engine.unread.clear();
  const next = clock();
  await link.workWatcher(engine.target, () => [engine.target], { schedule: next.schedule, now: next.now }).caughtUp;
  await next.runAll();
  assert.equal(engine.prompts.length, 2);
  assert.match(engine.prompts[1].text, /^\[Session finished\] "Review"/);
});

test("a session that can't be read on a few starts in a row is let go of, so what comes after is looked back on from then", async () => {
  engine.sessions.ses_review = { ...engine.sessions.ses_signin, id: "ses_review", title: "Review", time: { created: 2, updated: 10 }, said: "Reviewed." };
  engine.unread.add("ses_review");
  for (const at of [1000, 2000, 3000]) {
    const start = clock();
    start.at = at;
    await link.workWatcher(engine.target, () => [engine.target], { schedule: start.schedule, now: start.now }).caughtUp;
    for (let tries = 0; tries < 12; tries++) await start.runAll();
  }
  assert.equal(engine.prompts.length, 1, "Sign-in, told once");
  assert.equal(JSON.parse(fs.readFileSync(toldFile, "utf8")).since, 3000, "from the third start on");
});

test("a session that finishes while the box looks back, unheard (its connection lost), is still told as it starts the next time", async () => {
  // Review finishes just after the list was read (as the box asks what's working), before it's
  // done looking.
  const first = clock();
  engine.looking = () => {
    delete engine.looking;
    engine.sessions.ses_review = { ...engine.sessions.ses_signin, id: "ses_review", title: "Review", time: { created: 2, updated: 1500 }, replied: 1500, said: "Reviewed." };
    first.at = 2000;
  };
  await link.workWatcher(engine.target, () => [engine.target], { schedule: first.schedule, now: first.now }).caughtUp;
  await first.runAll();
  assert.equal(engine.prompts.length, 1, "Sign-in, told");
  const next = clock();
  await link.workWatcher(engine.target, () => [engine.target], { schedule: next.schedule, now: next.now }).caughtUp;
  await next.runAll();
  assert.equal(engine.prompts.length, 2, "Review, as the box starts again");
  assert.match(engine.prompts[1].text, /^\[Session finished\] "Review"/);
});

test("a session whose turn failed before it replied while the box was down is told it failed: its first turn, or one after a reply told before", async () => {
  // Build failed on its first turn, before it said anything (its model couldn't be reached, say).
  engine.sessions.ses_build = { ...engine.sessions.ses_signin, id: "ses_build", title: "Build", outcome: "failed", replied: null, after: "msg_build_you" };
  // Fix finished once, told as it did (at 7); its next turn failed before a reply, at 10.
  engine.sessions.ses_fix = { ...engine.sessions.ses_signin, id: "ses_fix", title: "Fix", outcome: "failed", said: "Fixed the first one.", after: "msg_fix_you" };
  fs.writeFileSync(toldFile, JSON.stringify({ since: 5, sessions: { ses_fix: { reply: "msg_ses_fix", at: 7 } } }));
  const first = clock();
  await link.workWatcher(engine.target, () => [engine.target], { schedule: first.schedule, now: first.now }).caughtUp;
  await first.runAll();
  assert.equal(engine.prompts.length, 1);
  assert.match(engine.prompts[0].text, /\[Session failed\] "Build" in tidepool \(address ses_build\) stopped with an error/);
  assert.match(engine.prompts[0].text, /\[Session failed\] "Fix" in tidepool \(address ses_fix\) stopped with an error/);
  assert.match(engine.prompts[0].text, /\[Session finished\] "Sign-in"/);
  // Not again as the box starts the next time, though nothing new was said.
  engine.sessions.ses_build.time = { created: 1, updated: 1500 };
  const next = clock();
  next.at = 2000;
  await link.workWatcher(engine.target, () => [engine.target], { schedule: next.schedule, now: next.now }).caughtUp;
  await next.runAll();
  assert.equal(engine.prompts.length, 1, "told once");
});

test("a failure told once isn't told again: not as it was heard, after a command you ran in it, nor one told before the box kept the turn it was", async () => {
  // Build failed before it replied, heard as it happened; then you ran a command in it.
  engine.sessions.ses_build = { ...engine.sessions.ses_signin, id: "ses_build", title: "Build", outcome: "failed", replied: null, after: "msg_build_you", time: { created: 1, updated: 2 } };
  const first = clock();
  const watch = link.workWatcher(engine.target, () => [engine.target], { schedule: first.schedule, now: first.now });
  await watch.caughtUp;
  await first.runAll();
  assert.equal(engine.prompts.length, 1, "Sign-in, as the box started");
  first.at = 1500;
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_build" } });
  await first.runAll();
  assert.equal(engine.prompts.length, 2);
  assert.match(engine.prompts[1].text, /^\[Session failed\] "Build"/);
  engine.sessions.ses_build.later = [{ id: "msg_build_shell", type: "shell" }];
  engine.sessions.ses_build.time = { created: 1, updated: 2500 };
  // Fix failed after its reply, told by a box from before (which kept the reply it told, not
  // the turn); renamed since.
  engine.sessions.ses_fix = { ...engine.sessions.ses_signin, id: "ses_fix", title: "Fix", outcome: "failed", said: "Couldn't fix it.", time: { created: 1, updated: 2500 } };
  const told = JSON.parse(fs.readFileSync(toldFile, "utf8"));
  told.sessions.ses_fix = { reply: "msg_ses_fix" };
  fs.writeFileSync(toldFile, JSON.stringify(told));
  const next = clock();
  next.at = 3000;
  await link.workWatcher(engine.target, () => [engine.target], { schedule: next.schedule, now: next.now }).caughtUp;
  await next.runAll();
  assert.equal(engine.prompts.length, 2, `told once: ${engine.prompts.slice(2).map(each => each.text)}`);
});

test("a failed turn the box started itself (a goal's nudge) is told after the box was down, and one with commands you ran after it", async () => {
  // Ship's goal nudged it on after its reply, and that turn failed before it replied.
  engine.sessions.ses_ship = { ...engine.sessions.ses_signin, id: "ses_ship", title: "Ship", outcome: "failed", said: "Not yet.", after: "msg_ship_nudge", startedBy: "synthetic" };
  // Lint failed on its first turn; then you ran commands in it, more than a few.
  engine.sessions.ses_lint = { ...engine.sessions.ses_signin, id: "ses_lint", title: "Lint", outcome: "failed", replied: null, after: "msg_lint_you",
    later: Array.from({ length: 8 }, (_, index) => ({ id: `msg_lint_shell${index}`, type: "shell" })) };
  // Ship's reply was told as it came (at 7).
  const told = JSON.parse(fs.readFileSync(toldFile, "utf8"));
  told.sessions.ses_ship = { reply: "msg_ses_ship", at: 7 };
  fs.writeFileSync(toldFile, JSON.stringify(told));
  const first = clock();
  await link.workWatcher(engine.target, () => [engine.target], { schedule: first.schedule, now: first.now }).caughtUp;
  await first.runAll();
  assert.equal(engine.prompts.length, 1);
  assert.match(engine.prompts[0].text, /\[Session failed\] "Ship"/);
  assert.match(engine.prompts[0].text, /\[Session failed\] "Lint"/);
});
