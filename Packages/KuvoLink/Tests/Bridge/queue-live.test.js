// Stop really holds, on the real engine: a message queued behind a run you stop stays in the
// engine's inbox, what reaches the conversation meanwhile waits on the box (the engine would run
// it, and everything held with it), and Resume sends them in turn. The real box code and a real
// engine on a free model, in folders of the test's own; skipped unless OPENCODE_TEST_BINARY names
// the engine (KUVO_TEST_FREE_MODEL picks the model, `big-pickle` if not).
//
// Run with `OPENCODE_TEST_BINARY=<opencode> node --test Packages/KuvoLink/Tests/Bridge/queue-live.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const binary = process.env.OPENCODE_TEST_BINARY;
const model = process.env.KUVO_TEST_FREE_MODEL ?? "big-pickle";

test("Stop holds on the real engine: what arrives while stopped waits on the box, and Resume sends what Stop held, then what arrived, a run at a time", { skip: !binary && "OPENCODE_TEST_BINARY isn't set", timeout: 600_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-queue-live-")));
  removeAtEnd(root);
  for (const folder of ["home", "tmp", "work", "box/run", "xdg/config", "xdg/data", "xdg/state", "xdg/cache"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: `${root}/home`, TMPDIR: `${root}/tmp/`, XDG_CONFIG_HOME: `${root}/xdg/config`, XDG_DATA_HOME: `${root}/xdg/data`, XDG_STATE_HOME: `${root}/xdg/state`, XDG_CACHE_HOME: `${root}/xdg/cache`, OPENCODE_PASSWORD: "pw" };
  const engine = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: `${root}/work`, stdio: ["pipe", "pipe", "pipe"] });
  atEnd(() => { engine.stdin.end(); engine.kill(); });
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    engine.stdout.on("data", look);
    engine.stderr.on("data", look);
    engine.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const target = { port, password: "pw", pid: engine.pid };
  process.env.KUVO_HOME = `${root}/box`;
  fs.writeFileSync(`${root}/box/run/engine.json`, JSON.stringify(target));
  const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json" };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const handle = link.engineHandler(() => target, { name: "lab" }, () => { throw new Error("none"); });
  const ask = async (method, route, body) => {
    let text = "";
    for await (const part of handle({ method, path: route, headers: {}, body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)), fromApp: true }, {}, undefined)) if (part.body) text += part.body.toString();
    return JSON.parse(text);
  };

  // The box watching the engine's events, as it does, on real time; each event heard, kept.
  const heard = [];
  let waiters = [];
  const hear = link.queueWatcher(target, { schedule: (run, ms) => setTimeout(run, ms), cancel: timer => clearTimeout(timer) });
  const events = new AbortController();
  atEnd(() => events.abort());
  const stream = await fetch(`http://127.0.0.1:${port}/api/event`, { headers: { ...auth, accept: "text/event-stream" }, signal: events.signal });
  (async () => {
    let buffer = "";
    for await (const chunk of stream.body) {
      buffer += Buffer.from(chunk).toString();
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const data = buffer.slice(0, end).split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
        buffer = buffer.slice(end + 2);
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        heard.push(event);
        hear(event);
        for (const wake of waiters.splice(0)) wake();
      }
    }
  })().catch(() => {});
  const until = async (wanted, what) => {
    const end = Date.now() + 240_000;
    while (!(await wanted())) {
      assert.ok(Date.now() < end, `Waited too long for ${what}`);
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 1000); });
    }
  };
  const runs = (type, session) => heard.filter(event => event.type === type && event.data?.sessionID === session).length;

  const session = (await api("POST", "api/session", { location: { directory: `${root}/work` }, model: { providerID: "opencode", id: model } })).data.id;
  // The conversation's messages, the first first, each as the engine gives it.
  const userTexts = async () => ((await api("GET", `api/session/${session}/message`)).data ?? [])
    .sort((one, other) => (one.time?.created ?? 0) - (other.time?.created ?? 0))
    .map(message => JSON.stringify(message));

  // A long run, a message queued behind it, then Stop.
  await api("POST", `api/session/${session}/prompt`, { id: link.messageID(), text: "Write the numbers from 1 to 300, one per line, in words. Nothing else.", delivery: "steer" });
  await until(() => runs("session.execution.started", session) >= 1, "the run to start");
  const queued = link.messageID();
  await api("POST", `api/session/${session}/prompt`, { id: queued, text: "After that, say QUEUED-ONE and nothing else.", delivery: "queue" });
  const stopped = await ask("POST", `kuvo/sessions/${session}/stop`);
  assert.equal(stopped.paused, true);
  const idle = async () => !Object.keys((await api("GET", "api/session/active")).data ?? {}).includes(session);
  await until(idle, "the stopped run to end");
  const before = (await userTexts()).length;

  // What arrives now (a message sent after this run; letters, wake-ups and work news take the
  // same way on the box) waits on the box: the engine is never handed it.
  const arrived = await ask("POST", `kuvo/sessions/${session}/queue/add`, { id: link.messageID(), text: "Then say ARRIVED-TWO and nothing else." });
  assert.equal(arrived.waits, true);
  assert.deepEqual((await api("GET", `api/session/${session}/inbox`)).data.map(item => item.id), [queued], "the engine holds only what Stop held");
  assert.ok(await idle(), "nothing runs");
  assert.equal((await userTexts()).length, before, "nothing new reached the conversation");

  // Resume: what Stop held runs; once it ends, what arrived goes, as its own run.
  const started = runs("session.execution.started", session);
  await ask("POST", `kuvo/sessions/${session}/queue/resume`);
  await until(async () => (await userTexts()).some(text => text.includes("QUEUED-ONE")), "what Stop held to go");
  await until(() => runs("session.execution.started", session) >= started + 2, "what arrived to go after it");
  const texts = await userTexts();
  const one = texts.findIndex(text => text.includes("QUEUED-ONE"));
  const two = texts.findIndex(text => text.includes("ARRIVED-TWO"));
  assert.ok(one >= 0 && two > one, "what Stop held first, then what arrived");
  assert.equal(link.queueOf(session).waiting, undefined, "nothing left waiting on the box");
});
