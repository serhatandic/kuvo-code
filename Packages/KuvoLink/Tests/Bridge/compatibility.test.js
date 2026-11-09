// What some providers need from the engine until opencode handles it, kept by each box for its own
// engine (PROTOCOL.md, "Settings per box"): GitHub Copilot's Claude models named in its settings so
// it leaves out the field they reject, only while it has a Copilot account (named there with none,
// Copilot becomes the engine's default model, which fails every message). Each box learns them from
// its own engine, as it finds it and at once as an account is added, removed or signed in to again,
// and keeps them in a settings file of its own beside yours in the engine's settings folder, which
// the engine reads again as it changes: they apply to the engine running now, without a restart,
// and to its next start (a machine's start scripts bring an older box's along, `engine-config`).
// The engine is a stand-in, answering as the real one does; `compatibility-live.test.js` runs the
// real one.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/compatibility.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-compatibility-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const link = await import(script);

// Where a machine's engine reads its settings (XDG_CONFIG_HOME is `config` in its box's folder), and
// the file of the box's own there.
const layerFile = (folder = home) => path.join(folder, "config", "opencode", "opencode.jsonc");

// An engine whose models are `models`, with a Copilot account there or not (`copilot`; `null`: its
// accounts can't be read, as one just started for a moment), and whose events can be followed.
async function engineWith(models, { copilot = true } = {}) {
  const engine = { models, copilot, followers: [], awaiting: [] };
  // An event for whoever follows it.
  engine.say = (type = "session.updated") => { for (const follower of engine.followers) follower.write(`data: ${JSON.stringify({ type, data: {} })}\n\n`); };
  engine.nextFollower = () => new Promise(resolve => engine.awaiting.push(resolve));
  const server = http.createServer((request, response) => {
    if (request.url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      engine.followers.push(response);
      for (const resolve of engine.awaiting.splice(0)) resolve();
      return;
    }
    // As the engine answers it: its models under `data`.
    if (request.url === "/api/model") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: engine.models }));
    // Its accounts with Copilot: none, or one signed in to (`null`: it can't say).
    if (request.url === "/api/integration/github-copilot" && engine.copilot !== null) {
      const connections = engine.copilot ? [{ id: "cred_copilot", label: "GitHub Copilot", method: "device" }] : [];
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "github-copilot", name: "GitHub Copilot", connections } }));
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  engine.source = { port: server.address().port, password: "pw" };
  return engine;
}

// What a box's engine starts with (`engine-config`, as this Mac's app and a machine's start scripts
// run it), with what it starts with now; in `folder`, this box's own unless another's is given. A
// machine's start names the engine's settings folder (XDG_CONFIG_HOME); this Mac's app doesn't.
async function engineConfig(content, folder = home, { machine = true } = {}) {
  const env = { ...process.env, KUVO_HOME: folder };
  delete env.XDG_CONFIG_HOME;
  if (machine) env.XDG_CONFIG_HOME = path.join(folder, "config");
  if (content === undefined) delete env.OPENCODE_CONFIG_CONTENT;
  else env.OPENCODE_CONFIG_CONTENT = content;
  const child = spawn(process.execPath, [script, "engine-config"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  return JSON.parse(out);
}

// The settings the engine reads from the box's file, as it reads JSONC; none without the file.
function engineReads(folder = home) {
  let text;
  try { text = fs.readFileSync(layerFile(folder), "utf8"); } catch { return {}; }
  return JSON.parse(text.split("\n").filter(line => !line.startsWith("//")).join("\n"));
}

const copilotModels = config => Object.keys(config.providers?.["github-copilot"]?.models ?? {}).sort();
const setting = { compatibility: { supportsThinkingBlockBinding: false } };
const learnedBefore = models => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "compatibility.json"), JSON.stringify({ providers: { "github-copilot": { models: Object.fromEntries(models.map(model => [model, setting])) } } }));
};

// The box watching `engine`, with a way to wait for its next look at the engine's models.
function watch(t, engine) {
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(engine.source));
  const stop = new AbortController();
  t.after(() => stop.abort());
  const waiting = [];
  const learned = () => new Promise(resolve => waiting.push(resolve));
  const first = learned();
  link.watchBox({ signal: stop.signal, learned: () => { for (const resolve of waiting.splice(0)) resolve(); } });
  return { first, learned, stop: () => stop.abort() };
}

const fresh = t => {
  fs.rmSync(path.join(home, "run"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "config"), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
};

test("before its engine has said whether there's a Copilot account, a box's engine has nothing of Copilot's in its settings", async t => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-compatibility-fresh-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const config = await engineConfig(undefined, other);
  assert.equal(config.providers?.["github-copilot"], undefined);
  assert.deepEqual(engineReads(other), {});
});

test("a box learns Copilot's Claude models from its own engine as it finds it, into its engine's settings folder beside yours, never in what the engine starts with", async t => {
  fresh(t);
  const engine = await engineWith([
    { providerID: "github-copilot", id: "claude-opus-5.6", family: "claude-opus" },
    { providerID: "github-copilot", id: "claude-sonnet-5.5", family: "claude-sonnet" },
    // One only these settings put in its list (it has no family): left out from now on.
    { providerID: "github-copilot", id: "claude-fable-5.1" },
    { providerID: "github-copilot", id: "gpt-5.5", family: "gpt" },
    { providerID: "anthropic", id: "claude-opus-5.6", family: "claude-opus" },
  ]);
  const box = watch(t, engine);
  await box.first;
  box.stop();
  assert.deepEqual(copilotModels(engineReads()), ["claude-opus-5.6", "claude-sonnet-5.5"]);
  assert.deepEqual(engineReads().providers["github-copilot"].models["claude-opus-5.6"], setting);
  // What it starts with: as given, with the sandbox's note, and nothing of Copilot's that would hold
  // an old list over the one it reads as it changes.
  const config = await engineConfig(JSON.stringify({ mcp: { browser: { type: "remote", url: "http://127.0.0.1:1/mcp" } } }));
  assert.equal(config.providers, undefined);
  assert.equal(config.mcp.browser.url, "http://127.0.0.1:1/mcp");
  assert.ok(config.instructions.some(each => each.endsWith(path.join("fence", "agents.md"))));
});

test("a Copilot account added while the engine has nothing else going on is learned at once, and one removed is unlearned at once, without waiting ten minutes", async t => {
  fresh(t);
  const engine = await engineWith([{ providerID: "opencode", id: "big-pickle", family: "big-pickle" }], { copilot: false });
  const box = watch(t, engine);
  await box.first;
  assert.deepEqual(engineReads(), {});
  // You sign in to Copilot (on any of your devices): the engine says so, and its models come a moment later.
  engine.copilot = true;
  let next = box.learned();
  engine.say("credential.updated");
  await next;
  // Not yet: its models haven't come.
  assert.deepEqual(engineReads(), {});
  engine.models = [...engine.models, { providerID: "github-copilot", id: "claude-opus-5.6", family: "claude-opus" }];
  next = box.learned();
  engine.say("model.updated");
  await next;
  assert.deepEqual(copilotModels(engineReads()), ["claude-opus-5.6"]);
  // Copilot gives the account another model, and you sign in to it again.
  engine.models = [...engine.models, { providerID: "github-copilot", id: "claude-sonnet-5.6", family: "claude-sonnet" }];
  next = box.learned();
  engine.say("credential.switched");
  await next;
  assert.deepEqual(copilotModels(engineReads()), ["claude-opus-5.6", "claude-sonnet-5.6"]);
  // Signed out: nothing of Copilot's names it any more, so it's no longer counted as set up.
  engine.copilot = false;
  next = box.learned();
  engine.say("credential.updated");
  await next;
  box.stop();
  assert.equal(fs.existsSync(layerFile()), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "run", "compatibility.json"), "utf8")).providers, undefined);
});

test("an engine with no Copilot account there: the box forgets Copilot's models, though the engine lists them while its settings name Copilot", async t => {
  fresh(t);
  learnedBefore(["claude-opus-5.6", "claude-sonnet-5.5"]);
  // As the real engine lists them then: every one of Copilot's, with its family, and no account.
  const engine = await engineWith([
    { providerID: "github-copilot", id: "gpt-6.1-terra", family: "gpt-terra" },
    { providerID: "github-copilot", id: "claude-opus-5.6", family: "claude-opus" },
    { providerID: "opencode", id: "big-pickle", family: "big-pickle" },
  ], { copilot: false });
  const box = watch(t, engine);
  await box.first;
  box.stop();
  assert.deepEqual(engineReads(), {});
});

test("an engine that can't say whether there's a Copilot account leaves what the box learned as it was, and the engine reads it", async t => {
  fresh(t);
  learnedBefore(["claude-opus-5.6"]);
  const engine = await engineWith([{ providerID: "github-copilot", id: "claude-opus-5.6", family: "claude-opus" }], { copilot: null });
  const box = watch(t, engine);
  await box.first;
  box.stop();
  assert.deepEqual(copilotModels(engineReads()), ["claude-opus-5.6"]);
});

test("a Copilot account whose models haven't come yet leaves what the box learned as it was", async t => {
  fresh(t);
  learnedBefore(["claude-opus-5.6"]);
  const engine = await engineWith([{ providerID: "opencode", id: "big-pickle", family: "big-pickle" }]);
  const box = watch(t, engine);
  await box.first;
  box.stop();
  assert.deepEqual(copilotModels(engineReads()), ["claude-opus-5.6"]);
});

test("an engine that can't say at first (just started) is asked again with its next event, not ten minutes later", async t => {
  fresh(t);
  // Learned by an older Kuvo Code from what the settings themselves put in the engine's list.
  learnedBefore(["claude-opus-5.6"]);
  const engine = await engineWith([{ providerID: "github-copilot", id: "claude-opus-5.6", family: "claude-opus" }], { copilot: null });
  const box = watch(t, engine);
  await box.first;
  assert.deepEqual(copilotModels(engineReads()), ["claude-opus-5.6"]);
  // It can say now: no account.
  engine.copilot = false;
  const next = box.learned();
  engine.say();
  await next;
  box.stop();
  assert.deepEqual(engineReads(), {});
});

test("what an older box learned reaches its machine's engine at its next start, even with nothing else of the box running; this Mac's app's own run of it leaves the box's folder alone", async t => {
  fresh(t);
  learnedBefore(["claude-opus-5.6"]);
  // This Mac's app asks without naming the engine's settings folder: its box, started first, keeps it there.
  await engineConfig("", home, { machine: false });
  assert.equal(fs.existsSync(layerFile()), false);
  // A machine's start names it.
  const config = await engineConfig("");
  assert.equal(config.providers, undefined);
  assert.deepEqual(copilotModels(engineReads()), ["claude-opus-5.6"]);
});

test("a settings file of your own where the box keeps its own is never changed", async t => {
  fresh(t);
  learnedBefore(["claude-opus-5.6"]);
  fs.mkdirSync(path.dirname(layerFile()), { recursive: true });
  fs.writeFileSync(layerFile(), '{ "model": "anthropic/claude-opus-5.6" }\n');
  await engineConfig("");
  const engine = await engineWith([{ providerID: "github-copilot", id: "claude-sonnet-5.6", family: "claude-sonnet" }]);
  const box = watch(t, engine);
  await box.first;
  box.stop();
  assert.equal(fs.readFileSync(layerFile(), "utf8"), '{ "model": "anthropic/claude-opus-5.6" }\n');
});
