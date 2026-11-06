// A conversation on Autopilot, on the real engine with a real model: what it asks marking a choice
// goes ahead on it, keeping the call under the step that asked; changed, its agent hears and goes
// that way; what's left unmarked waits for you and you're told; and off, even a marked one waits.
// The real box script and a real engine on a free model, in folders of the test's own. Skipped
// unless OPENCODE_TEST_BINARY names the engine.
//
// Run with `OPENCODE_TEST_BINARY=<opencode> node --test Packages/KuvoLink/Tests/Bridge/autopilot-live.test.js`,
// with `KUVO_TEST_MODEL=<id>` for another of OpenCode's free models than the engine's default.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const binary = process.env.OPENCODE_TEST_BINARY;

test("Autopilot on a real engine: a marked question goes ahead and can be changed; an unmarked one waits and tells you; off, a marked one waits too", { skip: !binary && "OPENCODE_TEST_BINARY isn't set" }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-autopilot-live-")));
  removeAtEnd(home);
  for (const folder of ["tmp", "work", "xdg/config", "xdg/data", "xdg/state", "xdg/cache", "bin", "run"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  process.env.KUVO_HOME = home;
  const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
  const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
  const waitFor = async (wanted, what) => {
    const end = Date.now() + 240_000;
    for (;;) {
      const found = await wanted();
      if (found) return found;
      assert.ok(Date.now() < end, `Waited too long for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };

  // The engine, as the box starts it, with no accounts: its default model is a free one.
  const workspace = path.join(home, "work");
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: `${home}/tmp/`, XDG_CONFIG_HOME: `${home}/xdg/config`, XDG_DATA_HOME: `${home}/xdg/data`,
    XDG_STATE_HOME: `${home}/xdg/state`, XDG_CACHE_HOME: `${home}/xdg/cache`, OPENCODE_PASSWORD: "pw",
    OPENCODE_CONFIG_CONTENT: link.engineConfigContent(undefined),
  };
  const child = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  atEnd(() => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); }));
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const target = { port, password: "pw" };
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(workspace) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const engineUp = await waitFor(async () => (await api("GET", "api/model/default").catch(() => ({ status: 0 }))).status === 200, "the engine to start");
  assert.ok(engineUp);
  const model = process.env.KUVO_TEST_MODEL ? { model: { providerID: "opencode", id: process.env.KUVO_TEST_MODEL } } : {};
  const session = (await api("POST", "api/session", { title: "Menu page", location: { directory: workspace }, ...model })).json.data.id;
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port, password: "pw", version: "0.0.0" }));
  fs.copyFileSync(new URL("../../Sources/KuvoLink/Resources/bot-words.json", import.meta.url), path.join(home, "bin", "bot-words.json"));

  // A client's request, as the box answers one: a process of its own.
  const route = (method, pathname, body) => new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: `${home}/tmp` }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    process_.stdout.on("data", chunk => { out += chunk; });
    process_.on("error", reject);
    process_.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    process_.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
  const calls = async () => (await route("GET", `kuvo/sessions/${session}/autopilot`)).body.decided ?? [];
  const page = async () => (await api("GET", `api/session/${session}/message?limit=50`)).json?.data ?? [];
  const forms = async () => (await api("GET", `api/session/${session}/form`)).json?.data ?? [];

  // Its turn on what it's sent over, with what it said: the model's limit fails here, by name.
  const turnAfter = async (id, what) => waitFor(async () => {
    const messages = await page();
    const ended = messages.findIndex(each => each.type === "idle");
    const asked = messages.findIndex(each => each.id === id);
    if (ended < 0 || asked < 0 || ended > asked) return null;
    assert.notEqual(messages[ended].outcome, "failed", `Its turn failed: ${messages[ended].error?.message}`);
    return messages.slice(0, asked);
  }, what);
  const send = (id, text) => api("POST", `api/session/${session}/prompt`, { id, delivery: "steer", text });

  // The box's watch over the engine's events, as it runs: what it tells your phones.
  const told = [];
  const stop = new AbortController();
  atEnd(() => stop.abort());
  link.watchEvents(() => target, notice => { told.push(notice); return true; }, stop.signal, () => {}, { work: "engine" });
  const toldOf = form => waitFor(async () => told.some(each => each.data?.request === form), `your phone to be told of ${form}`);

  // On Autopilot, from a client.
  const on = await route("PUT", `kuvo/sessions/${session}/autopilot`, { autopilot: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.autopilot, true);

  // A question it marks goes ahead at once, with nobody answering: kept as the step's call.
  await send("msg_autopilotlive00001", "Use your question tool now to ask me one question, \"Which roast for the house blend?\", with the choices Light, Warm and Dark. You recommend Warm: it suits the pastries. When you have your answer, reply with only the name of the roast you're going with.");
  const [call] = await waitFor(async () => { const made = await calls(); return made.length ? made : null; }, "the question to go ahead");
  assert.equal(call.choice, "Warm");
  assert.match(call.text, /roast/i);
  assert.deepEqual([...call.options].sort(), ["Dark", "Light", "Warm"], "in whatever order the model lists them");
  assert.ok(call.call, "it names the step that asked");
  const said = await turnAfter("msg_autopilotlive00001", "its turn to end");
  assert.ok(JSON.stringify(await page()).includes(call.call), "that step is in the conversation");
  assert.match(JSON.stringify(said), /Warm/, "its agent had its answer");
  assert.deepEqual(told.filter(each => each.data?.request === call.id), [], "nobody is told of what went ahead");

  // Changed: its agent hears, and goes that way.
  const changed = await route("POST", `kuvo/sessions/${session}/autopilot`, { decided: call.id, choice: "Dark" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.decided[0].yours.choice, "Dark");
  await waitFor(async () => {
    const messages = await page();
    const heard = messages.findIndex(each => JSON.stringify(each).includes("[Decision changed]"));
    const ended = messages.findIndex(each => each.type === "idle");
    return heard >= 0 && ended >= 0 && ended < heard && /Dark/.test(JSON.stringify(messages.slice(0, heard)));
  }, "its agent to go with your choice");

  // What only you can do, asked with no mark: it waits, and you're told.
  await send("msg_autopilotlive00002", "Use your question tool now to ask me one question, \"Pay $29 for the domain?\", with the choices \"I paid\" and \"Skip\", no choice marked. Write nothing else.");
  const [paying] = await waitFor(async () => { const asked = await forms(); return asked.length ? asked : null; }, "the question that waits");
  await toldOf(paying.id);
  assert.equal((await calls()).length, 1, "it made no call on it");
  assert.equal((await forms()).length, 1);
  const paid = await api("POST", `api/session/${session}/form/${paying.id}/reply`, { answer: { [paying.fields[0].key]: "Skip" } });
  assert.ok(paid.status < 300, JSON.stringify(paid.json));
  await turnAfter("msg_autopilotlive00002", "its turn to end");

  // Off: a marked question waits like any other. (Only its label says so: what Autopilot told it
  // is gone, so this says it itself.)
  assert.equal((await route("PUT", `kuvo/sessions/${session}/autopilot`, { autopilot: false })).body.autopilot, false);
  await send("msg_autopilotlive00003", "Use your question tool now to ask me one question, \"Which cup size?\", with the choices \"Small\" and \"Large (Recommended)\", labelled exactly so. Write nothing else.");
  const [cup] = await waitFor(async () => { const asked = await forms(); return asked.length ? asked : null; }, "the question off Autopilot");
  await toldOf(cup.id);
  assert.equal((await calls()).length, 1, "it made no call on it");
  assert.equal((await forms()).length, 1);
});
