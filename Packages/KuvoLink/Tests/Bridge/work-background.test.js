// A lead hears a session finished once it's really done, and a session with a command or subagent
// still running counts as at work, one fact from the box (PROTOCOL.md, "Work › Background work"). The
// real box code; only the engine is a stand-in, as a real one answers (its commands listed a folder at
// a time, a job's end waking its agent with a `synthetic` message), and the watcher's clock is the test's.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/work-background.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-work-background-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const tidepool = path.join(home, "work", "tidepool");
const otherFolder = path.join(home, "work", "other");
fs.mkdirSync(tidepool, { recursive: true });
fs.mkdirSync(otherFolder, { recursive: true });
const bot = "bot_pixel00001";
fs.mkdirSync(path.join(home, "bots", bot), { recursive: true });
fs.writeFileSync(path.join(home, "bots", bot, "session"), "ses_pixel");
fs.writeFileSync(path.join(home, "bots", bot, "bot.json"), JSON.stringify({ kuvo: 1, id: bot, name: "Pixel" }));
const by = { bot, name: "Pixel" };
const work = (id, title, extra = {}) => ({ id, title, location: { directory: tidepool }, time: { created: 1, updated: Date.now() }, metadata: { kuvo: { startedBy: "ses_pixel", by, depth: 1, wake: ["finished", "asks"] } }, ...extra });

// A stand-in for the engine: its sessions, what's at work (`active`), its commands by folder (each
// listed only in its own), each session's messages newest first, and what was asked of it.
let state;
const fresh = () => ({
  sessions: {
    ses_pixel: { id: "ses_pixel", title: "Pixel", location: { directory: path.join(home, "bots", bot, "workspace") }, time: { created: 1, updated: 1 } },
    ses_tests: work("ses_tests", "Tests"),
    ses_helper: { id: "ses_helper", parentID: "ses_tests", title: "Helper", location: { directory: tidepool }, time: { created: 1, updated: Date.now() } },
    ses_part: { id: "ses_part", parentID: "ses_tests", title: "Part", location: { directory: tidepool }, time: { created: 1, updated: Date.now() }, metadata: { kuvo: { reviewPart: { review: "rev_1" } } } },
    ses_mine: { id: "ses_mine", title: "Mine", location: { directory: otherFolder }, time: { created: 1, updated: Date.now() } },
  },
  active: new Set(),
  shells: new Map(),
  messages: { ses_tests: [] },
  prompts: [],
  interrupted: [],
  removedShells: [],
  folderAsks: [],
  counter: 0,
});

const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = request.url;
    if (url.startsWith("/api/session?")) return reply({ data: Object.values(state.sessions).filter(each => !each.parentID) });
    if (url === "/api/session/active" && state.hold) {
      const { asked, until } = state.hold;
      state.hold = null;
      asked();
      return until.then(() => reply({ data: {} }));
    }
    if (url === "/api/session/active") return reply({ data: Object.fromEntries([...state.active].map(id => [id, { type: "busy" }])) });
    if (url === "/api/shell") {
      const folder = decodeURIComponent(request.headers["x-opencode-directory"] ?? "");
      state.folderAsks.push(folder);
      return reply({ location: { directory: folder }, data: state.shells.get(folder) ?? [] });
    }
    const shell = url.match(/^\/api\/shell\/([^/?]+)$/);
    if (shell) {
      // (As the engine's: a command is known only in its own folder.)
      const job = state.shells.get(decodeURIComponent(request.headers["x-opencode-directory"] ?? ""))?.find(each => each.id === shell[1]);
      if (!job) return reply({ message: "No such command." }, 404);
      if (request.method === "DELETE") {
        state.removedShells.push(job.id);
        endJob(job.id);
        return reply({});
      }
      return reply({ data: job });
    }
    if (/\/(permission|form)$/.test(url)) return reply({ data: state.forms ?? [] });
    const answered = url.match(/^\/api\/session\/[^/]+\/form\/([^/]+)\/reply$/);
    if (answered) {
      (state.answered ??= []).push(answered[1]);
      state.forms = (state.forms ?? []).filter(each => each.id !== answered[1]);
      return reply({});
    }
    const one = url.match(/^\/api\/session\/([^/?]+)(\/[^?]*)?/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2] && state.unreachable) return reply({ message: "Busy." }, 500);
    if (one && !one[2]) {
      // (As the engine's, it last changed as it last wrote.)
      const each = state.sessions[id];
      if (!each) return reply({ message: "No such session." }, 404);
      const wrote = Math.max(0, ...(state.messages[id] ?? []).map(message => message.time?.created ?? 0));
      return reply({ data: { ...each, time: { ...each.time, updated: Math.max(each.time?.updated ?? 0, wrote) } } });
    }
    if (one?.[2] === "/message") {
      const answer = () => {
        const asks = new URL(url, "http://engine").searchParams;
        const limit = Number(asks.get("limit") ?? 100);
        const offset = Number(asks.get("cursor") ?? 0);
        const all = state.messages[id] ?? [];
        reply({ data: all.slice(offset, offset + limit), cursor: offset + limit < all.length ? { next: String(offset + limit) } : null });
      };
      if (state.reads?.session === id) return state.reads.hold(answer, () => reply({ message: "Timed out." }, 500));
      return answer();
    }
    if (one?.[2] === "/prompt") {
      // (Sent again under the same id, as a retry is, it's taken once.)
      const prompt = { to: id, ...JSON.parse(body) };
      if (!state.prompts.some(each => each.to === id && each.id === prompt.id)) state.prompts.push(prompt);
      // Taken, but its answer lost on the way back (the engine slow to answer, the box's wait over).
      if (state.lostAnswers > 0) return (state.lostAnswers -= 1, reply({ message: "Timed out." }, 500));
      return reply({});
    }
    if (one?.[2] === "/interrupt") {
      state.interrupted.push(id);
      state.active.delete(id);
      return reply({ interrupted: true });
    }
    if (url.startsWith("/api/session/") && one?.[2]?.startsWith("/inbox")) return reply({ data: [] });
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const source = { port: engine.address().port, password: "p" };

// What a session said and when, as the engine keeps it: newest first, each later than the last.
const at = () => (state.counter += 1, Date.now() + state.counter);
const endJob = id => { for (const [folder, jobs] of state.shells) state.shells.set(folder, jobs.filter(each => each.id !== id)); };
const startJob = (id, command = "npm test", when = at(), session = "ses_tests", folder = tidepool) => {
  const job = { id, status: "running", command, cwd: folder, metadata: { sessionID: session }, time: { started: when } };
  state.shells.set(folder, [...(state.shells.get(folder) ?? []), job]);
  return { type: "shell.created", location: { directory: folder }, data: { info: job } };
};
const exited = (id, folder = tidepool) => { endJob(id); return { type: "shell.exited", location: { directory: folder }, data: { id, exit: 0, status: "exited" } }; };
// A run's end writes its idle message, whichever way it ended.
const idle = session => state.messages[session]?.unshift({ id: `msg_${state.counter + 1}`, type: "idle", time: { created: at() } });
const ended = (session = "ses_tests") => (idle(session), { type: "session.execution.succeeded", data: { sessionID: session } });
const started = (session = "ses_tests") => ({ type: "session.execution.started", data: { sessionID: session } });
const delivered = (session = "ses_tests") => ({ type: "session.inbox.delivered", data: { sessionID: session, inboxID: `inb_${state.counter}` } });

const said = (text, session = "ses_tests") => state.messages[session].unshift({ id: `msg_${state.counter + 1}`, type: "assistant", time: { created: at() }, content: text ? [{ type: "text", text }] : [] });
const asked = (text = "Run the tests.", session = "ses_tests") => state.messages[session].unshift({ id: `msg_${state.counter + 1}`, type: "user", text, time: { created: at() } });
const ownWord = (session = "ses_tests") => state.messages[session].unshift({ id: `msg_${state.counter + 1}`, type: "synthetic", text: "<shell>done</shell>", metadata: { source: "shell" }, time: { created: at() } });
const notice = (text = "Going on with another account.", session = "ses_tests") => state.messages[session].unshift({ id: `msg_${state.counter + 1}`, type: "synthetic", text, time: { created: at() } });
const boxWord = (text = '[Session finished] "Part" in tidepool (address ses_part)\n\nDone.', session = "ses_tests") => state.messages[session].unshift({ id: `msg_${state.counter + 1}`, type: "user", text, time: { created: at() } });
const wokenUp = (session = "ses_tests") => state.messages[session].unshift({ id: `msg_${state.counter + 1}`, type: "user", text: "[Wake-up] Look again.", time: { created: at() } });
const long = text => `${text} ${"It went on to say a good deal more about what it found and what it changed. ".repeat(4)}`;
// The engine slow to read a session's messages (a box under heavy load): each read waits, answered
// (`pass`) or timed out (`fail`) as the test says, until `stop`; or, from `failAll`, every one times out.
function holdReads(session = "ses_tests") {
  const held = [];
  let arrived = () => {};
  let failing = false;
  state.reads = { session, hold: (pass, fail) => { if (failing) return fail(); held.push({ pass, fail }); arrived(); } };
  return {
    next: async () => {
      while (!held.length) await new Promise(resolve => { arrived = resolve; });
      return held.shift();
    },
    stop: () => { state.reads = null; },
    failAll: () => { failing = true; for (const each of held.splice(0)) each.fail(); },
  };
}

// The watcher's clock: its time, and what it would run later, run when the test says, when it's due.
function clock(start = Date.now() + 60 * 1000) {
  const later = [];
  const kept = { at: start };
  return Object.assign(kept, {
    now: () => kept.at,
    schedule: (run, ms = 0) => { later.push({ run, due: kept.at + ms }); },
    // What's due by `kept.at`, again until none is, and waited on.
    run: async () => {
      for (let round = 0; round < 20; round++) {
        const due = later.filter(each => each.due <= kept.at);
        if (!due.length) return;
        for (const each of due) later.splice(later.indexOf(each), 1);
        for (const each of due) await each.run();
      }
    },
    pass: async ms => { kept.at += ms; await kept.run(); },
  });
}
const SECONDS = 1000;
const watcher = time => link.workWatcher(source, () => [source], { schedule: time.schedule, now: time.now });
const leadLines = () => state.prompts.filter(each => each.to === "ses_pixel").flatMap(each => each.text.split("\n\n").filter(line => line.startsWith("[Session ")));
const finished = () => leadLines().filter(line => line.startsWith("[Session finished]"));
// (#420: a lead is never told "still working": a session at work shows so in its list.)
const stillWorking = () => leadLines().filter(line => line.startsWith("[Session still working]"));
const atWork = async () => [...await link.atWorkNow([source])];
const handle = link.engineHandler(() => source, { name: "test" }, () => null);
async function route(method, where) {
  const parts = [];
  for await (const part of handle({ method, path: where, headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, body: JSON.parse(text) };
}

beforeEach(() => {
  state = fresh();
  fs.rmSync(path.join(home, "run", "work"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "wakes"), { recursive: true, force: true });
});

test("a session waiting on its own command isn't finished: told once, when it's over, with no reply after it", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1"));
  said("Started the tests; they'll take a while.");
  await watch(ended());
  await time.pass(10 * SECONDS);
  assert.deepEqual(leadLines(), [], "nothing at all while its command runs: not 'still working' either");
  assert.deepEqual(await atWork(), ["ses_tests"], "and it counts as at work");
  // It ends with nothing more to say.
  await watch(exited("sh_1"));
  assert.deepEqual(await atWork(), [], "no longer at work");
  await time.pass(9 * SECONDS);
  assert.deepEqual(finished(), [], "a moment first: its end may wake its agent");
  await time.pass(2 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /^\[Session finished\] "Tests"/);
  assert.match(finished()[0], /Started the tests/);
  assert.doesNotMatch(finished()[0], /Still running/);
  // Nothing brings it back.
  await time.pass(3_600 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
});

test("a finish waiting on its command, summarized meanwhile: told as the summary ends, not at the deadline", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1"));
  said("Started the tests.");
  await watch(ended());
  await time.pass(10 * SECONDS);
  // A lead's compact_session under way as its command ends.
  state.active.add("ses_tests");
  await watch(exited("sh_1"));
  await time.pass(15 * SECONDS);
  assert.deepEqual(finished(), []);
  state.active.delete("ses_tests");
  state.messages.ses_tests.unshift({ id: "msg_sum", type: "compaction", status: "completed", reason: "manual", time: { created: at() } });
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /Started the tests/);
});

test("a finish waiting on its command, with a summary that failed meanwhile: its lead hears both", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1"));
  said("Started the tests.");
  await watch(ended());
  await time.pass(10 * SECONDS);
  state.messages.ses_tests.unshift({ id: "msg_sum", type: "compaction", status: "failed", reason: "manual", error: { message: "The provider refused." }, time: { created: at() } });
  await watch(ended());
  await time.pass(5 * SECONDS);
  const told = () => state.prompts.filter(each => each.to === "ses_pixel").map(each => each.text).join("\n\n");
  assert.match(told(), /\[Session not summarized\][^\n]*: The provider refused\./);
  assert.deepEqual(finished(), [], "its command still runs");
  await watch(exited("sh_1"));
  await time.pass(11 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /Started the tests/);
});

test("a command's end waking its agent: one word, with what it said at the end", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1"));
  said("Started the tests.");
  await watch(ended());
  await watch(exited("sh_1"));
  ownWord();
  state.active.add("ses_tests");
  await watch(started());
  await time.pass(11 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.deepEqual(finished(), [], "its own turn is under way");
  said("All 120 tests pass.");
  state.active.delete("ses_tests");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1, "told once");
  assert.match(finished()[0], /All 120 tests pass/);
  assert.equal(state.prompts.length, 1);
});

test("a subagent sent off in the background holds its session's finish and counts as at work; a review's part doesn't", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  state.active.add("ses_helper").add("ses_part");
  said("Sent a helper off.");
  await watch(ended());
  await time.pass(10 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.deepEqual(finished(), []);
  assert.equal((await route("GET", "kuvo/work/background")).body.sessions.ses_tests.subagents, 1, "the helper, and not the review's part");
  state.active.delete("ses_helper");
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_helper" } });
  assert.equal((await route("GET", "kuvo/work/background")).body.sessions.ses_tests, undefined);
  await time.pass(11 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1, "told once its helper's done, the review's part aside");
  assert.match(finished()[0], /Sent a helper off/);
});

test("a subagent's own subagent counts for the session at the top, found as the box starts, its own session's turn over", async () => {
  state.sessions.ses_digger = { id: "ses_digger", parentID: "ses_helper", title: "Digger", location: { directory: tidepool }, time: { created: 1, updated: Date.now() } };
  state.active.add("ses_digger");
  await watcher(clock()).caughtUp;
  await watcher(clock()).caughtUp;
  const { body } = await route("GET", "kuvo/work/background");
  assert.deepEqual(Object.keys(body.sessions), ["ses_tests"]);
  assert.equal(body.sessions.ses_tests.subagents, 1);
});

test("once only a review's part works under a session, it isn't held for it", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  state.active.add("ses_part");
  said("Done.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.equal((await route("GET", "kuvo/work/background")).body.sessions.ses_tests, undefined);
});

test("told it finished, a turn nobody asked for is told only if it has something new to say; a turn someone asked for always is", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Tests pass. Report written.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  // A timer of its own, again and again, with nothing to say: no turn on the lead's side.
  for (const words of ["Nothing new.", "", "Still nothing new."]) {
    wokenUp();
    said(words);
    await watch(ended());
    await time.pass(5 * SECONDS);
  }
  assert.equal(finished().length, 1, "repeats aren't told");
  // The same long report over: nor that.
  const report = long("The report as it stands.");
  ownWord();
  said(report);
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2, "new, and of substance");
  ownWord();
  said(report);
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2, "the same again isn't");
  // Someone writes to it: its answer goes, however short.
  asked("[Message from Pixel · ses_pixel] (…)\n\nDid you push?");
  said("No.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 3);
  assert.match(finished()[2], /\nNo\.$/);
});

test("stopping a session someone started ends what it left running and its wake-ups, and nothing comes of it after", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1"));
  state.active.add("ses_helper");
  said("Started the tests.");
  await watch(ended());
  // Its timers, on this box.
  const wakes = path.join(home, "wakes", "ses_tests");
  fs.mkdirSync(path.join(wakes, "wakes"), { recursive: true });
  fs.mkdirSync(path.join(wakes, "watches", "abc"), { recursive: true });
  fs.writeFileSync(path.join(wakes, "session"), "ses_tests");
  const wakeFile = path.join(wakes, "wakes", `${Math.floor(Date.now() / 1000) + 3600}-abc`);
  fs.writeFileSync(wakeFile, "Look again.");
  await link.stopWork(source, "ses_tests");
  assert.deepEqual(state.removedShells, ["sh_1"], "its command stopped (a job with no process known: the engine's own stop)");
  assert.ok(state.interrupted.includes("ses_helper"), "its subagent stopped");
  assert.equal(fs.existsSync(wakeFile), false, "its wake-up gone");
  assert.equal(fs.existsSync(path.join(wakes, "watches")), false, "and its watches");
  state.active.delete("ses_helper");
  await watch(exited("sh_1"));
  // The engine wakes its agent for the command's end all the same: it stops there, and says nothing.
  state.active.add("ses_tests");
  await watch(started());
  ownWord();
  await watch(delivered());
  assert.ok(state.interrupted.includes("ses_tests"), "the turn it began on its own stops");
  said("The tests ended.");
  await watch(ended());
  await time.pass(3_600 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.deepEqual(finished(), [], "nothing told, at once or at the limit");
  assert.deepEqual(await atWork(), []);
  // Written to again, it's as any other.
  state.active.add("ses_tests");
  const before = state.interrupted.length;
  await watch(started());
  asked("[Message from Pixel · ses_pixel] (…)\n\nCarry on.");
  await watch(delivered());
  assert.equal(state.interrupted.length, before, "not stopped: someone asked");
  state.active.delete("ses_tests");
  said("Carried on, all done.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /Carried on/);
});

test("a stop just after a finish was gathered: what's gathered of it isn't sent", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Done.");
  await watch(ended());
  link.noteStopped("ses_tests");
  await time.pass(5 * SECONDS);
  assert.deepEqual(finished(), []);
});

test("an archived session tells nothing and begins nothing on its own", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Report.");
  state.sessions.ses_tests.metadata["kuvo.archived"] = true;
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.deepEqual(finished(), []);
  state.active.add("ses_tests");
  await watch(started());
  assert.deepEqual(state.interrupted, [], "nothing's known of what began it yet");
  ownWord();
  await watch(delivered());
  assert.deepEqual(state.interrupted, ["ses_tests"]);
});

test("a command that never ends: the lead hears at the limit, as finished, saying what still runs, then what it says after that; it stops counting as at work later", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1", "npm run dev", time.at));
  said("The dev server is up.");
  await watch(ended());
  await time.pass(link.FINISH_HOLD_LIMIT - 60 * SECONDS);
  assert.deepEqual(finished(), [], "not yet");
  await time.pass(61 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1, "at the limit it's told");
  assert.match(finished()[0], /^\[Session finished\] "Tests"/, "a dev server doesn't keep its lead waiting for good");
  assert.match(finished()[0], /Still running in the background: the command `npm run dev`/);
  assert.deepEqual(stillWorking(), [], "never told 'still working'");
  assert.deepEqual(await atWork(), ["ses_tests"], "it does still run");
  assert.equal(link.AT_WORK_LIMIT > link.FINISH_HOLD_LIMIT, true);
  // Long after, it's gone quiet: it doesn't show at work for ever.
  fs.writeFileSync(path.join(home, "run", "work", "background.json"), JSON.stringify({ engine: { folders: [tidepool], sessions: { ses_tests: { commands: [{ id: "sh_1", command: "npm run dev", started: Date.now() - link.AT_WORK_LIMIT - 1 }], subagents: [], tasks: [] } } } }));
  assert.deepEqual(await atWork(), []);
});

test("told at the limit, what it says when the command does end is told, however short", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1", "npm test", time.at));
  said("Started.");
  await watch(ended());
  await time.pass(link.FINISH_HOLD_LIMIT + 1);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /^\[Session finished\] "Tests"/);
  assert.match(finished()[0], /Still running in the background/);
  await watch(exited("sh_1"));
  ownWord();
  said("All pass.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2);
  assert.match(finished()[1], /^\[Session finished\] "Tests"/, "really finished now");
  assert.match(finished()[1], /All pass\./);
  assert.doesNotMatch(finished()[1], /Still running/);
  assert.deepEqual(stillWorking(), []);
});

test("the engine gone with its commands: a new connection finds none, and the lead is told once", async () => {
  const time = clock();
  const first = watcher(time);
  await first.caughtUp;
  asked();
  await first(startJob("sh_1"));
  said("Started the tests.");
  await first(ended());
  await time.pass(10 * SECONDS);
  first.gone();
  assert.deepEqual(await atWork(), [], "what it can't hear isn't said to run");
  // It came back without them: nothing says they ended, as they went with it.
  state.shells.clear();
  const next = clock(time.at);
  const second = watcher(next);
  await second.caughtUp;
  await next.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /Started the tests/);
});

test("the box restarting: a command still running holds its finish still, with what it knew; one that ended meanwhile is told as it starts", async () => {
  const time = clock();
  const first = watcher(time);
  await first.caughtUp;
  asked();
  await first(startJob("sh_1"));
  said("Started the tests.");
  await first(ended());
  await time.pass(5 * SECONDS);
  // The link restarts; the engine runs on with the command.
  const next = clock(time.at);
  const second = watcher(next);
  await second.caughtUp;
  await next.pass(5 * SECONDS);
  assert.deepEqual(finished(), [], "held still");
  assert.deepEqual(await atWork(), ["ses_tests"], "and counts, though the box was down when it could have heard");
  // And again, the command ending while it was down.
  const last = clock(next.at);
  endJob("sh_1");
  const third = watcher(last);
  await third.caughtUp;
  await last.pass(5 * SECONDS);
  assert.equal(finished().length, 1, "told once, as it starts");
  const again = clock(last.at);
  await watcher(again).caughtUp;
  await again.pass(5 * SECONDS);
  assert.equal(finished().length, 1, "not twice");
});

test("a command started while the box was down still counts, for a session that was at work this past hour", async () => {
  await watcher(clock()).caughtUp;
  startJob("sh_9");
  await watcher(clock()).caughtUp;
  assert.deepEqual(await atWork(), ["ses_tests"]);
});

test("only a folder at work is asked for its commands (asking starts that folder's tools)", async () => {
  state.sessions.ses_old = work("ses_old", "Old", { location: { directory: path.join(home, "work", "old") }, time: { created: 1, updated: 1 } });
  await watcher(clock()).caughtUp;
  state.folderAsks.length = 0;
  await watcher(clock()).caughtUp;
  assert.ok(state.folderAsks.includes(tidepool), "one at work this past hour is");
  assert.ok(!state.folderAsks.includes(path.join(home, "work", "old")));
});

test("a bot's work counts a session waiting on its command as at work, and its bot's clients hear of each change", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  const changes = path.join(home, "run", "work", "changes.json");
  await watch(startJob("sh_1"));
  said("Started the tests.");
  await watch(ended());
  const report = (await route("GET", `kuvo/work?bot=${bot}`)).body;
  assert.equal(report.sessions.find(each => each.session === "ses_tests").state, "working");
  assert.equal(report.today.working, 1);
  const marked = JSON.parse(fs.readFileSync(changes, "utf8"))[bot];
  await watch(exited("sh_1"));
  assert.ok(JSON.parse(fs.readFileSync(changes, "utf8"))[bot] > marked, "a client reads its work again");
  assert.equal((await route("GET", `kuvo/work?bot=${bot}`)).body.today.working, 0);
});

test("your own conversation with a command running counts as at work too; every client reads it from the box", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  state.messages.ses_mine = [];
  await watch(startJob("sh_2", "make", Date.now(), "ses_mine", otherFolder));
  const { body } = await route("GET", "kuvo/work/background");
  assert.deepEqual(Object.keys(body.sessions), ["ses_mine"]);
  assert.equal(body.sessions.ses_mine.commands, 1);
  assert.equal(body.sessions.ses_mine.subagents, 0);
  await watch(exited("sh_2", otherFolder));
  assert.deepEqual((await route("GET", "kuvo/work/background")).body.sessions, {});
});

test("a place that can't say what it left running still tells: a turn's end is its finish, once", async () => {
  const time = clock();
  // (As the coding agents' lanes with nothing to report: its answer has no background at all.)
  const watch = link.workWatcher(source, () => [source], { schedule: time.schedule, now: time.now, from: "bridge" });
  await watch.caughtUp;
  asked();
  said("Done.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  wokenUp();
  said("Done.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
});

test("the same failure again in a turn nobody asked for is told once; a different one is told", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  const failed = message => (idle("ses_tests"), { type: "session.execution.failed", data: { sessionID: "ses_tests", error: { type: "provider", message } } });
  asked();
  await watch(failed("Over its limit."));
  await time.pass(5 * SECONDS);
  wokenUp();
  await watch(failed("Over its limit."));
  await time.pass(5 * SECONDS);
  const told = () => state.prompts.flatMap(each => each.text.split("\n\n").filter(line => line.startsWith("[Session failed]")));
  assert.equal(told().length, 1);
  wokenUp();
  await watch(failed("Its key was refused."));
  await time.pass(5 * SECONDS);
  assert.equal(told().length, 2);
});

test("clients show a bot seeing a session finish once it's told, not at each turn's end", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  const marks = async () => (await route("GET", "kuvo/work/oversight")).body.marks.filter(mark => mark.kind === "finished").length;
  asked();
  await watch(startJob("sh_1"));
  said("Started.");
  await watch(ended());
  assert.equal(await marks(), 0, "not while its command runs");
  await watch(exited("sh_1"));
  await time.pass(11 * SECONDS);
  assert.equal(await marks(), 1);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  // Its own timer, with nothing to say, right after a finish told as its command ended.
  wokenUp();
  said("Nothing new.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(await marks(), 1, "not again for that");
  assert.equal(finished().length, 1, "nor told");
});

test("a word of the box's or its agent's landing in a turn, or after its reply, loses neither what it said nor who asked", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Looking into it.");
  notice();
  said("All 120 tests pass.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /All 120 tests pass/);
  // After its reply (a coding agent's "used more tools"): the reply is what it said.
  asked("[Message from Pixel · ses_pixel] (…)\n\nAnything else?");
  said("Nothing else.");
  notice("Used 3 more tools.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2, "someone asked, and a word after the reply doesn't change that");
  assert.match(finished()[1], /Nothing else\./);
  // A command's end written in a turn someone asked for: still theirs, however short the answer.
  asked("[Message from Pixel · ses_pixel] (…)\n\nDid you push?");
  said("Checking.");
  ownWord();
  said("No.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 3);
  assert.match(finished()[2], /\nNo\.$/);
});

test("what's written to a stopped session decides, once it's in its conversation: what it left running ending stops there, anything else goes on", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Started.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  // Stopped, then a goal given to it: the engine's order, the turn first and what began it after.
  link.noteStopped("ses_tests");
  state.active.add("ses_tests");
  await watch(started());
  assert.deepEqual(state.interrupted, [], "nothing's known yet of what began it");
  notice("Keep going until the goal is met.");
  await watch(delivered());
  assert.deepEqual(state.interrupted, [], "you set it going");
  assert.equal(link.readStopped().ses_tests, undefined, "so it's no longer stopped");
  said(long("Working towards the goal."));
  state.active.delete("ses_tests");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2, "and it's told");
  // Stopped, then a wake-up you added fires: goes on too.
  link.noteStopped("ses_tests");
  await watch(started());
  wokenUp();
  await watch(delivered());
  assert.deepEqual(state.interrupted, []);
  assert.equal(link.readStopped().ses_tests, undefined);
  // Stopped, then what it left running ends: stops there, and stays stopped.
  said("Looked.");
  await watch(ended());
  link.noteStopped("ses_tests");
  await watch(started());
  ownWord();
  await watch(delivered());
  assert.deepEqual(state.interrupted, ["ses_tests"]);
  assert.notEqual(link.readStopped().ses_tests, undefined);
});

test("a question isn't held up by what ran before it was asked; a turn on its own still is", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked("Start the dev server.");
  await watch(startJob("sh_dev", "npm run dev"));
  said("The dev server is up.");
  await watch(ended());
  await time.pass(10 * SECONDS);
  assert.deepEqual(finished(), [], "it's what it was asked to start: held");
  asked("[Message from Pixel · ses_pixel] (…)\n\nWhich port?");
  said("Port 3000.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1, "told at once, the server still up");
  assert.match(finished()[0], /^\[Session finished\] "Tests"/, "its answer is done; a server it ran before is no work of the question's");
  assert.match(finished()[0], /Port 3000/);
  assert.match(finished()[0], /Still running in the background: the command `npm run dev`/);
  // Its own timer's turn, with something to say: waits for what runs.
  wokenUp();
  said(long("The server logged something new."));
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  await watch(exited("sh_dev"));
  await time.pass(11 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2);
  assert.match(finished()[1], /The server logged something new/);
});

test("Stop All stops a session that's only waiting on its own timer; nothing fires from it after", async () => {
  const wakes = path.join(home, "wakes", "ses_tests", "wakes");
  fs.mkdirSync(wakes, { recursive: true });
  const wake = path.join(wakes, `${Math.floor(Date.now() / 1000) + 3600}-abc`);
  fs.writeFileSync(wake, "Look again.");
  const { status } = await route("POST", `kuvo/bots/${bot}/stop-all`);
  assert.equal(status, 200);
  assert.equal(fs.existsSync(wake), false, "its wake-up gone");
  assert.notEqual(link.readStopped().ses_tests, undefined);
});

test("a session deleted while its finish waits: nothing's told, and nothing waits for it any more", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  const waiting = () => Object.keys(JSON.parse(fs.readFileSync(path.join(home, "run", "work", "told.json"), "utf8")).waiting ?? {});
  asked();
  await watch(startJob("sh_1"));
  said("Started.");
  await watch(ended());
  assert.deepEqual(waiting(), ["ses_tests"]);
  delete state.sessions.ses_tests;
  await watch(exited("sh_1"));
  await time.pass(11 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.deepEqual(finished(), []);
  assert.deepEqual(waiting(), []);
});

test("one deleted while the box was down: found as it starts again, and let go of", async () => {
  const time = clock();
  const first = watcher(time);
  await first.caughtUp;
  const waiting = () => Object.keys(JSON.parse(fs.readFileSync(path.join(home, "run", "work", "told.json"), "utf8")).waiting ?? {});
  asked();
  await first(startJob("sh_1"));
  said("Started.");
  await first(ended());
  assert.deepEqual(waiting(), ["ses_tests"]);
  first.gone();
  delete state.sessions.ses_tests;
  endJob("sh_1");
  const next = clock(time.at);
  await watcher(next).caughtUp;
  assert.deepEqual(waiting(), []);
  assert.deepEqual(finished(), []);
});

test("not reachable at its limit: looked at again, so a command that never ends is still told", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1", "npm run dev", time.at));
  said("The dev server is up.");
  await watch(ended());
  state.unreachable = true;
  await time.pass(link.FINISH_HOLD_LIMIT + 1 * SECONDS);
  assert.deepEqual(finished(), []);
  state.unreachable = false;
  await time.pass(61 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /^\[Session finished\] "Tests"/);
  assert.match(finished()[0], /Still running in the background/);
});

test("told at the limit, a command that ends with nothing new said tells the lead nothing more, and its bot still sees it finish", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  const marks = async () => (await route("GET", "kuvo/work/oversight")).body.marks.filter(mark => mark.kind === "finished").length;
  asked();
  await watch(startJob("sh_1", "npm test", time.at));
  said("Started.");
  await watch(ended());
  await time.pass(link.FINISH_HOLD_LIMIT + 1);
  await time.pass(5 * SECONDS);
  assert.match(finished()[0], /^\[Session finished\]/);
  assert.equal(await marks(), 0, "its command runs, so not shown finishing yet");
  // Its command ends; the agent is woken and has nothing to add.
  await watch(exited("sh_1"));
  ownWord();
  await watch(ended());
  await time.pass(30 * SECONDS);
  assert.equal(finished().length, 1, "nothing finished that it hadn't said");
  assert.equal(await marks(), 1, "its bot sees it finish, once");
});

test("a session running past the at-work limit: its bot's clients hear it no longer counts", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  await watch(startJob("sh_1", "npm run dev", time.at));
  const changes = path.join(home, "run", "work", "changes.json");
  const marked = JSON.parse(fs.readFileSync(changes, "utf8"))[bot];
  await new Promise(resolve => setImmediate(resolve));
  await time.pass(link.AT_WORK_LIMIT + 1 * SECONDS);
  assert.ok(JSON.parse(fs.readFileSync(changes, "utf8"))[bot] > marked, "a client reads its work again");
});

test("a look under way as the engine goes says nothing of it after", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  let release;
  const until = new Promise(resolve => { release = resolve; });
  const reached = new Promise(asked => { state.hold = { asked, until }; });
  const looking = watch(startJob("sh_1"));
  await reached;
  watch.gone();
  release();
  await looking;
  assert.deepEqual((await route("GET", "kuvo/work/background")).body.sessions, {}, "what it can't hear isn't said to run");
});

test("a bot's session nobody's told of: the bot sees it finish once what it left running ends, not at its turn's end", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  state.sessions.ses_tests.metadata.kuvo.wake = [];
  const marks = async () => (await route("GET", "kuvo/work/oversight")).body.marks.filter(mark => mark.kind === "finished").length;
  asked();
  await watch(startJob("sh_1"));
  said("Started.");
  await watch(ended());
  assert.equal(await marks(), 0);
  await watch(exited("sh_1"));
  assert.equal(await marks(), 1);
  assert.deepEqual(finished(), []);
});

test("a long turn is read whole: who asked is known past its many steps", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked("Start the dev server.");
  await watch(startJob("sh_dev", "npm run dev"));
  said("Up.");
  await watch(ended());
  // A question, a turn of many steps, with what ran from before still up: told at once.
  asked("[Message from Pixel · ses_pixel] (…)\n\nFix the login.");
  for (let step = 0; step < 120; step++) said("");
  said("Fixed it.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /Fixed it/);
  // Told: its own timer, as long, with little to say.
  wokenUp();
  for (let step = 0; step < 120; step++) said("");
  said("Nothing new.");
  await watch(exited("sh_dev"));
  await watch(ended());
  await time.pass(11 * SECONDS);
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
});

test("the box's own word to a session: what comes of it is told, however short (it may be the result), and it doesn't undo a stop", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Started a helper session.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  // A session it started finished, and the box told it: what it concludes is what its lead waits for.
  boxWord();
  said("All tests pass.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2);
  assert.match(finished()[1], /All tests pass/);
  // Stopped: the same word doesn't set it going.
  link.noteStopped("ses_tests");
  state.active.add("ses_tests");
  await watch(started());
  boxWord();
  await watch(delivered());
  assert.deepEqual(state.interrupted, ["ses_tests"]);
  assert.notEqual(link.readStopped().ses_tests, undefined);
});

test("its agent carrying on by itself after a stop stops there too", async () => {
  const time = clock();
  const watch = link.workWatcher(source, () => [source], { schedule: time.schedule, now: time.now, from: "bridge" });
  await watch.caughtUp;
  asked();
  said("Started.");
  await watch(ended());
  link.noteStopped("ses_tests");
  await watch(started());
  state.messages.ses_tests.unshift({ id: `msg_${state.counter + 1}`, type: "synthetic", text: "A task it had going finished.", metadata: { source: "agent" }, time: { created: at() } });
  await watch(delivered());
  assert.deepEqual(state.interrupted, ["ses_tests"]);
  assert.notEqual(link.readStopped().ses_tests, undefined);
});

test("Stop All leaves nothing waiting for Resume where no turn ran; one that ran holds what waits, as Stop does", async () => {
  fs.mkdirSync(path.join(home, "wakes", "ses_tests", "wakes"), { recursive: true });
  fs.writeFileSync(path.join(home, "wakes", "ses_tests", "wakes", `${Math.floor(Date.now() / 1000) + 3600}-abc`), "Look again.");
  // Its bot's own conversation: only a dev server left running.
  startJob("sh_dev", "npm run dev", at(), "ses_pixel", tidepool);
  await watcher(clock()).caughtUp;
  assert.equal((await route("POST", `kuvo/bots/${bot}/stop-all`)).status, 200);
  assert.equal(link.queueOf("ses_tests").paused, false, "an idle session's next message just goes");
  assert.equal(link.queueOf("ses_pixel").paused, false);
  assert.ok(!state.interrupted.includes("ses_pixel"));
  state.sessions.ses_second = work("ses_second", "Second");
  state.active.add("ses_second");
  assert.equal((await route("POST", `kuvo/bots/${bot}/stop-all`)).status, 200);
  assert.equal(link.queueOf("ses_second").paused, true);
});

test("Resume on a stopped session sets it going: what waited on the box isn't interrupted, and what comes of it is told", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Started.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  link.noteStopped("ses_tests");
  assert.equal((await route("POST", "kuvo/sessions/ses_tests/queue/resume")).status, 200);
  assert.equal(link.readStopped().ses_tests, undefined);
  state.active.add("ses_tests");
  await watch(started());
  boxWord();
  await watch(delivered());
  assert.deepEqual(state.interrupted, []);
  said("All done.");
  state.active.delete("ses_tests");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2);
});

test("what you approved or answered is someone asking: it sets a stopped session going, and an archived one isn't interrupted for it", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Waiting.");
  await watch(ended());
  link.noteStopped("ses_tests");
  await watch(started());
  state.messages.ses_tests.unshift({ id: `msg_${state.counter + 1}`, type: "user", text: "[The user approved what Auto's reviewer held back] Go on.", metadata: { kuvo: { note: { from: "Auto", line: "Approved" } } }, time: { created: at() } });
  await watch(delivered());
  assert.deepEqual(state.interrupted, []);
  assert.equal(link.readStopped().ses_tests, undefined);
  said("Done.");
  await watch(ended());
  state.sessions.ses_tests.metadata["kuvo.archived"] = true;
  await watch(started());
  boxWord();
  await watch(delivered());
  assert.deepEqual(state.interrupted, [], "an archived one is stopped only for what it did on its own");
});

test("on Autopilot: a question that goes ahead isn't told up, what it ends with is, once; a choice you change sets it going and is told", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  state.sessions.ses_tests.metadata.kuvo.autopilot = true;
  const prompted = () => state.prompts.filter(each => each.to === "ses_pixel").map(each => each.text);
  const form = {
    id: "frm_1",
    sessionID: "ses_tests",
    title: "House blend",
    metadata: { kind: "question" },
    fields: [{ key: "roast", type: "string", title: "Which roast?", required: true, options: [{ value: "r0", label: "Light" }, { value: "r1", label: "Warm (Recommended)", description: "Suits the pastries" }] }],
  };
  asked();
  state.active.add("ses_tests");
  await watch(started());
  await watch(delivered());
  state.forms = [form];
  await watch({ type: "form.created", data: { form } });
  await time.pass(5 * SECONDS);
  assert.deepEqual(state.answered, ["frm_1"], "the box went ahead on what it marked");
  assert.deepEqual(prompted(), [], "and its starter isn't woken for that");
  said("Went with the warm roast. Left undone: paying.");
  state.active.delete("ses_tests");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 1);
  assert.match(finished()[0], /Left undone: paying/);
  // You change its call: the box writes to it. That's you, not it: told however short, even if stopped.
  link.noteStopped("ses_tests");
  await watch(started());
  state.messages.ses_tests.unshift({ id: `msg_${state.counter + 1}`, type: "user", text: '[Decision changed] For "Which roast?" the user picked "Light", not "Warm" as you decided.', metadata: { kuvo: { note: { from: "Autopilot", line: "You picked Light" } } }, time: { created: at() } });
  await watch(delivered());
  assert.deepEqual(state.interrupted, []);
  assert.equal(link.readStopped().ses_tests, undefined);
  said("Light it is.");
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2);
  assert.match(finished()[1], /Light it is/);
});

// #549: on a box under heavy load, one finish woke its lead five times. Its session's turn ended
// while its reviewers ran (held), their results began a turn of its own, and as that ended the
// engine took longer than the box waits to read its messages. Meanwhile any other session's work
// ending looked again at every finish still held, so the same finish was looked at more than once
// at a time; and one told while its reply couldn't be read noted no reply, so the next took it
// for news.
// (Its turn ends while its reviewer runs; the reviewer's result begins a turn of its own, which
// writes the report and is about to end.)
async function reviewedThenReported(watch, time) {
  asked();
  state.active.add("ses_helper");
  said("Sent reviewers off.");
  await watch(ended());
  await time.pass(15 * SECONDS);
  assert.deepEqual(finished(), [], "held while its reviewer runs");
  state.active.delete("ses_helper");
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_helper" } });
  state.messages.ses_tests.unshift({ id: `msg_${state.counter + 1}`, type: "synthetic", text: "<subagent state=\"completed\">All checked.</subagent>", metadata: { source: "subagent", childID: "ses_helper" }, time: { created: at() } });
  state.active.add("ses_tests");
  await watch(started());
  await time.pass(11 * SECONDS);
  said(long("The import file is written and checked."));
  state.active.delete("ses_tests");
}
test("a finish looked at again while the engine is slow to read it wakes its lead once; new work after it, again", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  await reviewedThenReported(watch, time);
  // The engine slow: the box reads its messages as its turn ends, and its reply in time out.
  const reads = holdReads();
  const ending = watch(ended());
  (await reads.next()).pass();
  const slow = await reads.next();
  reads.stop();
  // Meanwhile another session's command ends: a finish still held is looked at again.
  await watch(exited("sh_elsewhere", otherFolder));
  const lookingAgain = time.pass(11 * SECONDS);
  slow.fail();
  await ending;
  await lookingAgain;
  await time.pass(5 * SECONDS);
  await time.pass(60 * SECONDS);
  assert.equal(finished().length, 1, "its lead woken once");
  assert.match(finished()[0], /The import file is written/);
  // Told something new, it finishes again: told again.
  asked("Also check #444.");
  said(long("#444 appears nowhere."));
  await watch(ended());
  await time.pass(5 * SECONDS);
  assert.equal(finished().length, 2);
  assert.match(finished()[1], /#444 appears nowhere/);
});

test("a finish heard twice while the engine can't read it at all wakes its lead once", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  await reviewedThenReported(watch, time);
  const reads = holdReads();
  const ending = watch(ended());
  (await reads.next()).pass();
  const slow = await reads.next();
  // Looked at again meanwhile, and none of its reads answered in time.
  await watch(exited("sh_elsewhere", otherFolder));
  const lookingAgain = time.pass(11 * SECONDS);
  reads.failAll();
  slow.fail();
  await ending;
  await lookingAgain;
  await time.pass(5 * SECONDS);
  await time.pass(60 * SECONDS);
  reads.stop();
  assert.equal(finished().length, 1, "its lead woken once");
});

test("a finish whose delivery took but whose answer was lost is sent again under its own id: its lead hears it once", async () => {
  const time = clock();
  const watch = watcher(time);
  await watch.caughtUp;
  asked();
  said("Tests pass.");
  state.lostAnswers = 1;
  await watch(ended());
  await time.pass(5 * SECONDS);
  await time.pass(10 * SECONDS);
  await time.pass(20 * SECONDS);
  assert.equal(finished().length, 1, "once, though the box sent it again");
  assert.equal(state.lostAnswers, 0);
  // What came meanwhile isn't lost to that: it goes on its own.
  state.sessions.ses_docs = work("ses_docs", "Docs");
  state.messages.ses_docs = [];
  asked("Write the docs.", "ses_docs");
  said("Docs written.", "ses_docs");
  asked("Run them again.");
  said("Tests pass again.");
  state.lostAnswers = 1;
  await watch(ended());
  await time.pass(5 * SECONDS);
  await watch(ended("ses_docs"));
  await time.pass(10 * SECONDS);
  await time.pass(20 * SECONDS);
  await time.pass(40 * SECONDS);
  assert.deepEqual(finished().map(line => /^\[Session finished\] "([^"]+)"/.exec(line)[1]), ["Tests", "Tests", "Docs"]);
  assert.match(finished()[1], /Tests pass again/);
});
