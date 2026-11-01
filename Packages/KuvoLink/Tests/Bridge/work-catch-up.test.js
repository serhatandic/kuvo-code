// A box starting again tells a bot what its sessions did while it was down (PROTOCOL.md, "Work"),
// from each place they run (the engine, and the coding agents' bridge, found when each is), and
// only once it could look: an engine too slow or not yet there to list them is looked at again,
// never taken for one with nothing to tell. The real box code; only the engine and the bridge are
// stand-ins, and the watcher's clock is the test's.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/work-catch-up.test.js`.
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
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const tidepool = path.join(home, "work", "tidepool");
fs.mkdirSync(tidepool, { recursive: true });
const by = { bot: "bot_pixel00001", name: "Pixel" };
const toldFile = path.join(home, "run", "work", "told.json");

// A stand-in for the engine or the coding agents' bridge: its sessions, each with its last reply;
// `listing` false answers its list as an engine still starting does.
function place(sessions) {
  const state = { listing: true, prompts: [] };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url.startsWith("/api/session?")) return state.listing ? reply({ data: Object.values(sessions) }) : reply({ message: "Starting." }, 503);
      if (request.url === "/api/session/active") return reply({ data: {} });
      if (/\/(permission|form)$/.test(request.url)) return reply({ data: [] });
      const one = request.url.match(/^\/api\/session\/([^/?]+)(\/[^?]*)?/);
      const id = one && decodeURIComponent(one[1]);
      if (one && !one[2]) return sessions[id] ? reply({ data: sessions[id] }) : reply({ message: "No such session." }, 404);
      if (one?.[2] === "/message" && sessions[id]) return reply({ data: [{ id: `msg_${id}`, type: "assistant", content: [{ type: "text", text: sessions[id].said ?? "Done." }] }] });
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

// The watcher's clock: what it would run later, run when the test says (and waited on).
function clock() {
  const later = [];
  return { schedule: run => { later.push(run); }, runAll: async () => { for (const run of later.splice(0)) await run(); } };
}

beforeEach(() => {
  engine.prompts.length = 0;
  engine.listing = true;
  bridge.listing = true;
  fs.rmSync(path.join(home, "run", "work"), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(toldFile), { recursive: true });
  fs.writeFileSync(toldFile, JSON.stringify({ since: 5, sessions: {} }));
});

test("what finished while the box was down still reaches the bot when its engine couldn't list it yet as the box started: looked at again, not taken for nothing", async () => {
  engine.listing = false;
  const { schedule, runAll } = clock();
  const watch = link.workWatcher(engine.target, () => [engine.target], { schedule });
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
  const watch = link.workWatcher(engine.target, () => [engine.target], { schedule: first.schedule });
  await watch.caughtUp;
  // Meanwhile another of Pixel's sessions finishes, heard as it happens.
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_docs" } });
  engine.listing = true;
  const again = clock();
  await link.workWatcher(engine.target, () => [engine.target], { schedule: again.schedule }).caughtUp;
  await again.runAll();
  assert.equal(engine.prompts.length, 1, "with what it heard meanwhile, as one message");
  assert.match(engine.prompts[0].text, /\[Session finished\] "Docs"/);
  assert.match(engine.prompts[0].text, /\[Session finished\] "Sign-in"/);
});

test("a coding agents' bridge found after the engine still tells what finished there while the box was down", async () => {
  const targets = () => [engine.target, bridge.target];
  const first = clock();
  await link.workWatcher(engine.target, targets, { schedule: first.schedule }).caughtUp;
  await first.runAll();
  assert.equal(engine.prompts.length, 1, "the engine's told");
  assert.match(engine.prompts[0].text, /^\[Session finished\] "Sign-in"/);
  // The bridge listens a moment later (it waits for the box's sandbox).
  const then = clock();
  await link.workWatcher(bridge.target, targets, { schedule: then.schedule, from: "bridge" }).caughtUp;
  await then.runAll();
  assert.equal(engine.prompts.length, 2, "the bridge's too");
  assert.equal(engine.prompts[1].to, "ses_pixel");
  assert.match(engine.prompts[1].text, /^\[Session finished\] "Port" in tidepool \(address ses_port\)[^\n]*:\nPorted to Swift 6\./);
  // And not again, from either, as the box starts the next time.
  const next = clock();
  await link.workWatcher(engine.target, targets, { schedule: next.schedule }).caughtUp;
  await link.workWatcher(bridge.target, targets, { schedule: next.schedule, from: "bridge" }).caughtUp;
  await next.runAll();
  assert.equal(engine.prompts.length, 2);
});
