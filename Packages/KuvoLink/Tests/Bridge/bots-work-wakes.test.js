// A bot hears of its sessions without checking on them (PROTOCOL.md, "Work"): as one finishes, fails
// or asks for something, its box writes to the bot, close ones as one message, an ask to be read at
// its next step; a session that wasn't started to wake anyone stays quiet, and what a box had
// gathered as it stopped still goes. The real box code; only the engine is a stand-in, and the
// watcher's clock is the test's.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-work-wakes.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-wakes-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const tidepool = path.join(home, "work", "tidepool");
fs.mkdirSync(tidepool, { recursive: true });
const by = { bot: "bot_pixel00001", name: "Pixel" };
const sessions = {
  ses_pixel: { id: "ses_pixel", title: "Pixel", location: { directory: path.join(home, "bots", "bot_pixel00001", "workspace") }, time: { created: 1, updated: 1 } },
  ses_signin: { id: "ses_signin", title: "Sign-in", location: { directory: tidepool }, time: { created: Date.now() - 14 * 60_000, updated: 1 }, metadata: { kuvo: { startedBy: "ses_pixel", by, depth: 1, wake: ["finished", "asks"] } } },
  ses_haptics: { id: "ses_haptics", title: "Haptics", location: { directory: tidepool }, time: { created: 1, updated: 1 }, metadata: { kuvo: { startedBy: "ses_pixel", by, depth: 1, wake: ["finished", "asks"] } } },
  ses_tests: { id: "ses_tests", title: "Tests", location: { directory: tidepool }, time: { created: 1, updated: 1 }, metadata: { kuvo: { startedBy: "ses_signin", by, depth: 2 } } },
  ses_helper: { id: "ses_helper", parentID: "ses_haptics", title: "Helper", location: { directory: tidepool }, time: { created: 1, updated: 1 } },
};
let prompts = [];
let asking = {};
// A session's latest messages where a test says, newest first.
const conversations = {};
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    // The sessions at the top, what works now and what each asks: for catching up as a box starts.
    if (request.url.startsWith("/api/session?")) return reply({ data: Object.values(sessions).filter(each => !each.parentID) });
    if (request.url === "/api/session/active") return reply({ data: {} });
    if (/\/permission$/.test(request.url)) return reply({ data: asking[request.url.split("/")[3]] ?? [] });
    if (/\/form$/.test(request.url)) return reply({ data: [] });
    const one = request.url.match(/^\/api\/session\/([^/?]+)(\/[^?]*)?/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2]) return sessions[id] ? reply({ data: sessions[id] }) : reply({ message: "No such session." }, 404);
    if (one?.[2] === "/message" && conversations[decodeURIComponent(one[1])]) return reply({ data: conversations[decodeURIComponent(one[1])] });
    if (one?.[2] === "/message") return reply({ data: [{ id: "msg_9", type: "assistant", content: [{ type: "text", text: "Sign-in works, with tests. Reviewers found 2 problems; both fixed." }] }] });
    if (one?.[2] === "/prompt") {
      prompts.push({ to: id, ...JSON.parse(body) });
      return reply({});
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const source = { port: engine.address().port, password: "p" };

// The watcher's clock: what it would run later, run when the test says (and waited on).
function clock() {
  const later = [];
  return { schedule: run => { later.push(run); }, runAll: async () => { for (const run of later.splice(0)) await run(); } };
}
const wakesFile = path.join(home, "run", "work", "wakes.json");
const changesFile = path.join(home, "run", "work", "changes.json");

beforeEach(() => {
  prompts = [];
  asking = {};
  fs.rmSync(path.join(home, "run", "work"), { recursive: true, force: true });
});

test("a session finishing and another asking, close together, reach the bot as one message, read at its next step", async () => {
  const { schedule, runAll } = clock();
  const watch = link.workWatcher(source, () => [source], { schedule });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_signin" } });
  await watch({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_haptics", action: "shell", resources: ["npx expo install expo-haptics"] } });
  assert.equal(prompts.length, 0, "nothing goes until it's gathered");
  await runAll();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].to, "ses_pixel");
  assert.equal(prompts[0].delivery, "steer", "an ask waits for the bot's answer, so it's read at its next step");
  assert.match(prompts[0].text, /^\[Session finished\] "Sign-in" in tidepool \(address ses_signin\), after 14 min:\nSign-in works, with tests\. Reviewers found 2 problems; both fixed\./);
  assert.match(prompts[0].text, /\n\n\[Session asks\] "Haptics" in tidepool \(address ses_haptics\) asks to run a command: npx expo install expo-haptics \(ask per_1\)\. Answer with answer_ask/);
  assert.ok(JSON.parse(fs.readFileSync(changesFile, "utf8")).bot_pixel00001 > 0, "the bot's work changed, for clients to read again");
});

test("a finish alone waits for the bot's turn to end; a subagent's ask is its conversation's", async () => {
  const { schedule, runAll } = clock();
  const watch = link.workWatcher(source, () => [source], { schedule });
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_signin" } });
  await runAll();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].delivery, "queue");
  assert.match(prompts[0].text, /^\[Session failed\] "Sign-in" in tidepool \(address ses_signin\) stopped with an error\./);
  await watch({ type: "permission.asked", data: { id: "per_2", sessionID: "ses_helper", action: "edit", resources: ["App.tsx"] } });
  await runAll();
  assert.match(prompts[1].text, /^\[Session asks\] "Haptics" in tidepool \(address ses_haptics\) asks to edit files: App\.tsx \(ask per_2\)/);
});

test("a session started without wake stays quiet, but its bot's work still changes", async () => {
  const { schedule, runAll } = clock();
  const watch = link.workWatcher(source, () => [source], { schedule });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_tests" } });
  await runAll();
  assert.equal(prompts.length, 0);
  assert.ok(JSON.parse(fs.readFileSync(changesFile, "utf8")).bot_pixel00001 > 0);
});

test("a session of a bot's starting to work, or stopped, changes its bot's work, so clients don't go on saying none is at work; its bot is told nothing", async () => {
  // The bot's work changes as a session is made, before its task reaches it: read then, it isn't
  // at work yet, and the bar over the bot's composer said "none at work" while it worked.
  const { schedule, runAll } = clock();
  const watch = link.workWatcher(source, () => [source], { schedule });
  await watch({ type: "session.execution.started", data: { sessionID: "ses_signin" } });
  await runAll();
  const started = JSON.parse(fs.readFileSync(changesFile, "utf8")).bot_pixel00001;
  assert.ok(started > 0, "its bot's work changed as it started, for clients to read it at work");
  await watch({ type: "session.execution.interrupted", data: { sessionID: "ses_signin" } });
  await runAll();
  assert.ok(JSON.parse(fs.readFileSync(changesFile, "utf8")).bot_pixel00001 > started, "and again as it was stopped");
  assert.equal(prompts.length, 0, "a session starting or stopped isn't news for its bot, even one that wakes it as it finishes");
});

// Clients show the bot seeing one of its sessions finish (`kuvo/work/oversight`): one that finished
// well is marked, whether or not it wakes the bot; one that failed or was stopped isn't.
test("a bot's session that finishes is marked for clients to show the bot seeing it; one that fails or is stopped isn't", async () => {
  const watch = link.workWatcher(source, () => [source], { schedule: () => {} });
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_haptics" } });
  await watch({ type: "session.execution.interrupted", data: { sessionID: "ses_signin" } });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_tests" } });
  const marks = JSON.parse(fs.readFileSync(path.join(home, "run", "work", "oversight.json"), "utf8"));
  assert.deepEqual(marks.map(mark => [mark.bot, mark.session, mark.kind]), [["bot_pixel00001", "ses_tests", "finished"]]);
});

test("what a box had gathered as it stopped still reaches the bot", async () => {
  fs.mkdirSync(path.dirname(wakesFile), { recursive: true });
  fs.writeFileSync(wakesFile, JSON.stringify({ ses_pixel: { lines: ["[Session finished] \"Sign-in\" in tidepool (address ses_signin):\nDone."], asks: false, since: 1 } }));
  const { schedule, runAll } = clock();
  link.workWatcher(source, () => [source], { schedule });
  await runAll();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, "[Session finished] \"Sign-in\" in tidepool (address ses_signin):\nDone.");
  assert.deepEqual(prompts[0].metadata, { kuvo: { note: { from: "Its sessions", line: "“Sign-in” finished" } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(wakesFile, "utf8")), {});
});

test("a wake that can't reach the bot now (its engine starting again) is kept and goes later", async () => {
  const { schedule, runAll } = clock();
  let reachable = false;
  const watch = link.workWatcher(source, () => (reachable ? [source] : []), { schedule });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_signin" } });
  await runAll();
  assert.equal(prompts.length, 0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(wakesFile, "utf8"))).length, 1, "kept");
  reachable = true;
  await runAll();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /^\[Session finished\] "Sign-in"/);
});

test("a wake for a bot that runs with the coding agents is kept while their bridge isn't running, and goes once it is", async t => {
  // Scout's conversation is the bridge's (the engine doesn't know it); it started Docs, in the engine.
  sessions.ses_docs = { id: "ses_docs", title: "Docs", location: { directory: tidepool }, time: { created: 1, updated: 1 }, metadata: { kuvo: { startedBy: "ses_scout", by: { bot: "bot_scout00001", name: "Scout" }, depth: 1, wake: ["finished"] } } };
  t.after(() => { delete sessions.ses_docs; });
  const told = [];
  const bridge = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url === "/api/session/ses_scout") return reply({ data: { id: "ses_scout", title: "Scout" } });
      if (request.url === "/api/session/ses_scout/prompt") { told.push(JSON.parse(body)); return reply({}); }
      reply({ message: "No such session." }, 404);
    });
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  t.after(() => { bridge.closeAllConnections(); bridge.close(); });
  const atBridge = { port: bridge.address().port, password: "b" };
  let bridgeRuns = false;
  const { schedule, runAll } = clock();
  const watch = link.workWatcher(source, () => (bridgeRuns ? [source, atBridge] : [source]), { schedule, bridgeRuns: () => bridgeRuns });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_docs" } });
  await runAll();
  assert.deepEqual(told, []);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(wakesFile, "utf8"))), ["ses_scout"], "kept, not taken for a conversation that's gone");
  bridgeRuns = true;
  await runAll();
  assert.equal(told.length, 1);
  assert.match(told[0].text, /^\[Session finished\] "Docs"/);
});

test("what a conversation hears of its sessions waits while it's archived, as its wake-ups do, and reaches it once it's brought back", async t => {
  sessions.ses_pixel.metadata = { "kuvo.archived": true };
  t.after(() => { delete sessions.ses_pixel.metadata; });
  const { schedule, runAll } = clock();
  const watch = link.workWatcher(source, () => [source], { schedule });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_signin" } });
  await runAll();
  assert.deepEqual(prompts, [], "no turn out of sight");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(wakesFile, "utf8"))), ["ses_pixel"], "kept");
  delete sessions.ses_pixel.metadata;
  await runAll();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /^\[Session finished\] "Sign-in"/);
});

test("what a conversation the user stopped hears of its sessions waits there with its queue, shown as from its sessions, rather than starting it", async t => {
  const queues = path.join(home, "run", "queues.json");
  fs.writeFileSync(queues, JSON.stringify({ ses_pixel: { paused: true, held: [] } }));
  t.after(() => {
    fs.rmSync(queues, { force: true });
    fs.rmSync(path.join(home, "run", "waiting"), { recursive: true, force: true });
  });
  const { schedule, runAll } = clock();
  const watch = link.workWatcher(source, () => [source], { schedule });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_signin" } });
  await runAll();
  assert.deepEqual(prompts, [], "the engine would run everything waiting with it");
  const [waiting] = link.queueOf("ses_pixel").waiting;
  assert.equal(waiting.from, "Its sessions");
  // Shown as the line a conversation shows for it, not what its agent is told.
  assert.equal(waiting.text, "“Sign-in” finished");
  assert.ok(!fs.existsSync(wakesFile) || !JSON.parse(fs.readFileSync(wakesFile, "utf8")).ses_pixel, "it waits with the queue now, not to be sent again");
});

test("what a conversation archived for over a week would have heard of its sessions goes, rather than waiting for ever", async t => {
  sessions.ses_pixel.metadata = { "kuvo.archived": true };
  t.after(() => { delete sessions.ses_pixel.metadata; });
  fs.mkdirSync(path.dirname(wakesFile), { recursive: true });
  fs.writeFileSync(wakesFile, JSON.stringify({ ses_pixel: { lines: ["[Session finished] \"Sign-in\": done."], asks: false, since: Date.now() - 8 * 86_400_000 } }));
  const { schedule, runAll } = clock();
  link.workWatcher(source, () => [source], { schedule });
  await runAll();
  assert.deepEqual(JSON.parse(fs.readFileSync(wakesFile, "utf8")), {});
  delete sessions.ses_pixel.metadata;
  await runAll();
  assert.deepEqual(prompts, []);
});

test("what happened while the box was down reaches the bot as it starts again, once", async () => {
  const toldFile = path.join(home, "run", "work", "told.json");
  // It last heard of anything a while ago; since, Sign-in finished and Haptics asked something.
  fs.mkdirSync(path.dirname(toldFile), { recursive: true });
  fs.writeFileSync(toldFile, JSON.stringify({ since: 5, sessions: { ses_signin: { reply: "msg_old" } } }));
  sessions.ses_signin.time.updated = 10;
  sessions.ses_haptics.time.updated = 10;
  sessions.ses_tests.time.updated = 10;
  asking = { ses_haptics: [{ id: "per_9", action: "shell", resources: ["npm test"] }] };
  try {
    const first = clock();
    const watch = link.workWatcher(source, () => [source], { schedule: first.schedule });
    await watch.caughtUp;
    await first.runAll();
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].to, "ses_pixel");
    assert.match(prompts[0].text, /\[Session finished\] "Sign-in"/);
    assert.match(prompts[0].text, /\[Session asks\] "Haptics" in tidepool \(address ses_haptics\) asks to run a command: npm test \(ask per_9\)/);
    assert.doesNotMatch(prompts[0].text, /Tests/, "a session started without wake stays quiet");
    // Started again: nothing new to tell.
    const again = clock();
    await link.workWatcher(source, () => [source], { schedule: again.schedule }).caughtUp;
    await again.runAll();
    assert.equal(prompts.length, 1);
  } finally {
    for (const each of Object.values(sessions)) each.time.updated = 1;
  }
});

test("a session told of while the box runs isn't told again as it starts, however many others it has told of since", async () => {
  const toldFile = path.join(home, "run", "work", "told.json");
  fs.mkdirSync(path.dirname(toldFile), { recursive: true });
  // A bot that has run a lot: Sign-in was first told of long ago, and hundreds have been since.
  const many = Object.fromEntries(Array.from({ length: 399 }, (_, index) => [`ses_done${index}`, { reply: "msg_1" }]));
  fs.writeFileSync(toldFile, JSON.stringify({ since: 5, sessions: { ses_signin: { reply: "msg_old" }, ...many } }));
  try {
    const first = clock();
    const watch = link.workWatcher(source, () => [source], { schedule: first.schedule });
    await watch.caughtUp;
    await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_signin" } });
    await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_haptics" } });
    await first.runAll();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].text, /"Sign-in"[\s\S]*"Haptics"/);
    // Renamed while the box was down, with no new reply: nothing to tell.
    sessions.ses_signin.time.updated = Date.now() + 86_400_000;
    const again = clock();
    await link.workWatcher(source, () => [source], { schedule: again.schedule }).caughtUp;
    await again.runAll();
    assert.equal(prompts.length, 1, "told once");
  } finally {
    for (const each of Object.values(sessions)) each.time.updated = 1;
  }
});

test("a session stopped while the box was down (Stop All, or cut short) isn't told to its bot as finished once it starts again", async () => {
  const toldFile = path.join(home, "run", "work", "told.json");
  fs.mkdirSync(path.dirname(toldFile), { recursive: true });
  fs.writeFileSync(toldFile, JSON.stringify({ since: 5, sessions: {} }));
  sessions.ses_signin.time.updated = 10;
  sessions.ses_signin.outcome = "interrupted";
  try {
    const first = clock();
    await link.workWatcher(source, () => [source], { schedule: first.schedule }).caughtUp;
    await first.runAll();
    assert.deepEqual(prompts, [], "you stopped it: the bot isn't woken to carry on");
    // Nor later, as the box starts again.
    const again = clock();
    await link.workWatcher(source, () => [source], { schedule: again.schedule }).caughtUp;
    await again.runAll();
    assert.deepEqual(prompts, []);
  } finally {
    delete sessions.ses_signin.outcome;
    for (const each of Object.values(sessions)) each.time.updated = 1;
  }
});

test("a turn that failed, then a summary, while the box was down: its bot hears the turn failed, though the engine's outcome says otherwise", async () => {
  const toldFile = path.join(home, "run", "work", "told.json");
  fs.mkdirSync(path.dirname(toldFile), { recursive: true });
  fs.writeFileSync(toldFile, JSON.stringify({ since: 5, sessions: {} }));
  sessions.ses_signin.time.updated = 10;
  sessions.ses_signin.outcome = "succeeded";
  conversations.ses_signin = [
    { id: "msg_i2", type: "idle", outcome: "succeeded" },
    { id: "msg_c", type: "compaction", status: "completed", reason: "manual" },
    { id: "msg_i1", type: "idle", outcome: "failed", error: { message: "It broke." } },
    { id: "msg_9", type: "assistant", content: [{ type: "text", text: "Starting on it." }] },
  ];
  try {
    const first = clock();
    await link.workWatcher(source, () => [source], { schedule: first.schedule }).caughtUp;
    await first.runAll();
    assert.equal(prompts.length, 1);
    // Why, too: the turn's own words, past the summary's end.
    assert.match(prompts[0].text, /\[Session failed\] "Sign-in".* stopped with an error: It broke\./);
    assert.doesNotMatch(prompts[0].text, /\[Session finished\]/);
  } finally {
    delete sessions.ses_signin.outcome;
    delete conversations.ses_signin;
    for (const each of Object.values(sessions)) each.time.updated = 1;
  }
});

test("a turn its bot was told failed, then a summary, then the box starts again: it isn't told again", async () => {
  const toldFile = path.join(home, "run", "work", "told.json");
  fs.mkdirSync(path.dirname(toldFile), { recursive: true });
  fs.writeFileSync(toldFile, JSON.stringify({ since: 5, sessions: { ses_signin: { reply: "msg_old", turn: "msg_i1", at: 8 } } }));
  sessions.ses_signin.time.updated = 10;
  sessions.ses_signin.outcome = "succeeded";
  conversations.ses_signin = [
    { id: "msg_i2", type: "idle", outcome: "succeeded", time: { created: 10 } },
    { id: "msg_c", type: "compaction", status: "completed", reason: "manual", time: { created: 9 } },
    { id: "msg_i1", type: "idle", outcome: "failed", error: { message: "It broke." }, time: { created: 7 } },
    { id: "msg_u", type: "user", text: "Go.", time: { created: 6 } },
    { id: "msg_i0", type: "idle", outcome: "succeeded", time: { created: 4 } },
    { id: "msg_old", type: "assistant", content: [{ type: "text", text: "Earlier." }], time: { created: 3 } },
  ];
  try {
    const first = clock();
    await link.workWatcher(source, () => [source], { schedule: first.schedule }).caughtUp;
    await first.runAll();
    assert.deepEqual(prompts, []);
  } finally {
    delete sessions.ses_signin.outcome;
    delete conversations.ses_signin;
    for (const each of Object.values(sessions)) each.time.updated = 1;
  }
});

test("an answer given after its bot stopped waiting reaches it as the box starts, if the box stopped first", async () => {
  const asksFile = path.join(home, "run", "work", "asks.json");
  fs.mkdirSync(path.dirname(asksFile), { recursive: true });
  fs.writeFileSync(asksFile, JSON.stringify({ asks: [{ id: "wak_1", action: "makeProject", session: "ses_pixel", name: "Pixel", project: "Tidepool", folderName: "tidepool", folder: null, at: 1,
    given: { name: "Tidepool" }, late: true, answered: { answer: "allow", text: "Made Tidepool at ~/Developer/tidepool.", isError: false, at: Date.now() - 60 * 60_000 } }] }));
  const { schedule } = clock();
  await link.workWatcher(source, () => [source], { schedule }).caughtUp;
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].to, "ses_pixel");
  assert.equal(prompts[0].text, "[The user answered] Made Tidepool at ~/Developer/tidepool.");
  assert.deepEqual(prompts[0].metadata, { kuvo: { note: { from: "Your answer", line: "You answered: Made Tidepool at ~/Developer/tidepool." } } });
  // Told once.
  await link.workWatcher(source, () => [source], { schedule }).caughtUp;
  assert.equal(prompts.length, 1);
});

test("an answer given late that waited for the coding agents' bridge reaches its conversation once the bridge runs, with the box still running", async () => {
  const asksFile = path.join(home, "run", "work", "asks.json");
  fs.mkdirSync(path.dirname(asksFile), { recursive: true });
  fs.writeFileSync(asksFile, JSON.stringify({ asks: [{ id: "wak_3", action: "makeProject", session: "ses_later", name: "Pixel", project: "Tidepool", folderName: "tidepool", folder: null, at: 1,
    given: { name: "Tidepool" }, late: true, answered: { answer: "allow", text: "Made Tidepool at ~/Developer/tidepool.", isError: false, at: Date.now() - 60 * 60_000 } }] }));
  let bridge = false;
  const { schedule, runAll } = clock();
  await link.workWatcher(source, () => [source], { schedule, bridgeRuns: () => bridge }).caughtUp;
  assert.equal(prompts.length, 0);
  // The bridge starts, and its conversation is there now.
  bridge = true;
  sessions.ses_later = { id: "ses_later", title: "Pixel", location: { directory: tidepool }, time: { created: 1, updated: 1 } };
  try {
    await runAll();
    assert.deepEqual(prompts.map(each => [each.to, each.text]), [["ses_later", "[The user answered] Made Tidepool at ~/Developer/tidepool."]]);
  } finally {
    delete sessions.ses_later;
  }
});

test("an answer given late for a bot that runs with the coding agents waits while their bridge isn't running, rather than being taken as told", async () => {
  const asksFile = path.join(home, "run", "work", "asks.json");
  fs.mkdirSync(path.dirname(asksFile), { recursive: true });
  fs.writeFileSync(asksFile, JSON.stringify({ asks: [{ id: "wak_2", action: "makeProject", session: "ses_scout", name: "Scout", project: "Tidepool", folderName: "tidepool", folder: null, at: 1,
    given: { name: "Tidepool" }, late: true, answered: { answer: "allow", text: "Made Tidepool at ~/Developer/tidepool.", isError: false, at: Date.now() - 60 * 60_000 } }] }));
  const { schedule } = clock();
  await link.workWatcher(source, () => [source], { schedule, bridgeRuns: () => false }).caughtUp;
  assert.equal(JSON.parse(fs.readFileSync(asksFile, "utf8")).asks[0].toldLate, undefined, "still to tell");
  // The bridge runs, and has no such conversation either: gone, so it's done with.
  await link.workWatcher(source, () => [source], { schedule, bridgeRuns: () => true }).caughtUp;
  assert.deepEqual(JSON.parse(fs.readFileSync(asksFile, "utf8")).asks, []);
  assert.equal(prompts.length, 0);
});
