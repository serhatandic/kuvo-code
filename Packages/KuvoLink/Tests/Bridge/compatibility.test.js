// What some providers need from the engine until opencode handles it, kept by each box for its own
// engine (PROTOCOL.md, "Settings per box"): GitHub Copilot's Claude models named in its settings so
// it leaves out the field they reject. Each box learns them from its own engine's models, and its
// engine starts with them (`engine-config`, which this Mac's app and a machine's start scripts run),
// so a machine restarted with no Mac there starts right too. The engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/compatibility.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-compatibility-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const link = await import(script);

// An engine whose models are `models`, and whose events can be followed.
async function engineWith(models) {
  const engine = { models, followers: [], awaiting: [] };
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
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  after(() => { server.closeAllConnections(); server.close(); });
  engine.source = { port: server.address().port, password: "pw" };
  return engine;
}

// What a box's engine starts with (`engine-config`, as this Mac's app and a machine's start scripts
// run it), with what it starts with now; in `folder`, this box's own unless another's is given.
async function engineConfig(content, folder = home) {
  const env = { ...process.env, KUVO_HOME: folder };
  if (content === undefined) delete env.OPENCODE_CONFIG_CONTENT;
  else env.OPENCODE_CONFIG_CONTENT = content;
  const child = spawn(process.execPath, [script, "engine-config"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  return JSON.parse(out);
}

const copilotModels = config => Object.keys(config.providers?.["github-copilot"]?.models ?? {}).sort();
const setting = { compatibility: { supportsThinkingBlockBinding: false } };

test("before its engine has listed any models, a box's engine starts with Copilot's Claude models as Kuvo Code knows them", async t => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-compatibility-fresh-"));
  t.after(() => fs.rmSync(fresh, { recursive: true, force: true }));
  const config = await engineConfig(undefined, fresh);
  assert.deepEqual(copilotModels(config), ["claude-fable-5.1", "claude-haiku-5.5", "claude-opus-5.5", "claude-sonnet-5.5"]);
  assert.deepEqual(config.providers["github-copilot"].models["claude-opus-5.5"], setting);
});

test("a box learns Copilot's Claude models from its own engine as it finds it, and its next start names those, on top of what it starts with", async t => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const engine = await engineWith([
    { providerID: "github-copilot", id: "claude-opus-5.6", family: "claude-opus" },
    { providerID: "github-copilot", id: "claude-sonnet-5.5", family: "claude-sonnet" },
    // One only these settings put in its list (it has no family): left out from now on.
    { providerID: "github-copilot", id: "claude-fable-5.1" },
    { providerID: "github-copilot", id: "gpt-5.5", family: "gpt" },
    { providerID: "anthropic", id: "claude-opus-5.6", family: "claude-opus" },
  ]);
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(engine.source));
  const stop = new AbortController();
  t.after(() => stop.abort());
  const learned = new Promise(resolve => link.watchBox({ signal: stop.signal, learned: resolve }));
  await learned;
  stop.abort();

  // The browser tools' servers, as a Mac's start gave them: kept, with the layer on top.
  const config = await engineConfig(JSON.stringify({ mcp: { browser: { type: "remote", url: "http://127.0.0.1:1/mcp" } } }));
  assert.deepEqual(copilotModels(config), ["claude-opus-5.6", "claude-sonnet-5.5"]);
  assert.deepEqual(config.providers["github-copilot"].models["claude-opus-5.6"], setting);
  assert.equal(config.mcp.browser.url, "http://127.0.0.1:1/mcp");
});

test("an engine with no Copilot account there leaves what the box learned as it was", async t => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "compatibility.json"), JSON.stringify({ providers: { "github-copilot": { models: { "claude-opus-5.6": setting, "claude-sonnet-5.5": setting } } } }));
  const engine = await engineWith([{ providerID: "anthropic", id: "claude-opus-5.6", family: "claude-opus" }]);
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(engine.source));
  const stop = new AbortController();
  t.after(() => stop.abort());
  await new Promise(resolve => link.watchBox({ signal: stop.signal, learned: resolve }));
  stop.abort();
  assert.deepEqual(copilotModels(await engineConfig("")), ["claude-opus-5.6", "claude-sonnet-5.5"]);
});
