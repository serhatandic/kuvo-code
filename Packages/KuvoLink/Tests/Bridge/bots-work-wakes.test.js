// A bot hears of its sessions without checking on them (PROTOCOL.md, "Work"): as one finishes, fails
// or asks for something, its box writes to the bot, close ones as one message, an ask to be read at
// its next step; a session that wasn't started to wake anyone stays quiet, and what a box had
// gathered as it stopped still goes. The real box code; only the engine is a stand-in, and the
// watcher's clock is the test's.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-work-wakes.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-wakes-")));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
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
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const one = request.url.match(/^\/api\/session\/([^/?]+)(\/[^?]*)?/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2]) return sessions[id] ? reply({ data: sessions[id] }) : reply({ message: "No such session." }, 404);
    if (one?.[2] === "/message") return reply({ data: [{ id: "msg_9", type: "assistant", content: [{ type: "text", text: "Sign-in works, with tests. Reviewers found 2 problems; both fixed." }] }] });
    if (one?.[2] === "/prompt") {
      prompts.push({ to: id, ...JSON.parse(body) });
      return reply({});
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
after(() => { engine.closeAllConnections(); engine.close(); });
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

test("what a box had gathered as it stopped still reaches the bot", async () => {
  fs.mkdirSync(path.dirname(wakesFile), { recursive: true });
  fs.writeFileSync(wakesFile, JSON.stringify({ ses_pixel: { lines: ["[Session finished] \"Sign-in\" in tidepool (address ses_signin):\nDone."], asks: false, since: 1 } }));
  const { schedule, runAll } = clock();
  link.workWatcher(source, () => [source], { schedule });
  await runAll();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, "[Session finished] \"Sign-in\" in tidepool (address ses_signin):\nDone.");
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
