// What some providers need from the engine, on the real engine (`compatibility.ts`): the box keeps it
// in a settings file of its own beside yours in the engine's settings folder, which the engine reads
// again as it changes, so it applies to the engine running now, with no restart.
//
// - With no account of any kind, a box's first message works on the engine's default model, even
//   on a box an older Kuvo Code left Copilot's settings on: its box unlearns them, and the engine
//   drops Copilot as it runs. (Naming GitHub Copilot in those settings with no Copilot account made
//   Copilot's newest model the engine's default, and every first message failed: "missing required
//   Authorization header".)
// - A Copilot account signed in to: its Claude models work at once, without restarting the engine
//   (Copilot refuses the field the engine adds to their requests otherwise: "Extra inputs are not
//   permitted"); a model Copilot gives the account later works once you refresh its models, in a
//   conversation that was going on; and signed out, Copilot's gone from the engine at once.
//
// The real box code and a real engine, in folders of the test's own: GitHub Copilot is a stand-in
// for its API that answers as it does (the account's models, and messages, refusing that field),
// and a first message goes to a free model. Skipped unless OPENCODE_TEST_BINARY names the engine.
//
// Run with `OPENCODE_TEST_BINARY=<opencode> node --test box/bridge-tests/compatibility-live.test.js`.
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

const binary = process.env.OPENCODE_TEST_BINARY;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-compatibility-live-")));
removeAtEnd(root);
for (const folder of ["home", "tmp", "work", "box/run", "xdg/data", "xdg/state", "xdg/cache"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
// A machine's box: its engine's settings are in its folder (XDG_CONFIG_HOME, `config`).
const box = `${root}/box`;
process.env.KUVO_HOME = box;
const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const link = await import(script);
const work = `${root}/work`;

const waitFor = async (wanted, what) => {
  const end = Date.now() + 240_000;
  for (;;) {
    const found = await wanted().catch(() => null);
    if (found) return found;
    assert.ok(Date.now() < end, `Waited too long for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
};

// What a machine's start asks its box before it starts the engine (`engine-config`), as its start
// scripts run it.
async function engineConfig() {
  const env = { ...process.env, KUVO_HOME: box, XDG_CONFIG_HOME: `${box}/config` };
  delete env.OPENCODE_CONFIG_CONTENT;
  const child = spawn(process.execPath, [script, "engine-config"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  return out;
}

// The engine, started as a machine's box starts it, and noted where the box finds it.
async function startEngine() {
  const env = {
    PATH: process.env.PATH, HOME: `${root}/home`, TMPDIR: `${root}/tmp/`, XDG_CONFIG_HOME: `${box}/config`, XDG_DATA_HOME: `${root}/xdg/data`,
    XDG_STATE_HOME: `${root}/xdg/state`, XDG_CACHE_HOME: `${root}/xdg/cache`, OPENCODE_PASSWORD: "pw",
    OPENCODE_CONFIG_CONTENT: await engineConfig(),
  };
  const child = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  const stop = () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); });
  atEnd(stop);
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const target = { port, password: "pw", pid: child.pid };
  fs.writeFileSync(`${box}/run/engine.json`, JSON.stringify(target));
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(work) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  // It answers 503 while it boots.
  const chosen = await waitFor(async () => { const answer = await api("GET", "api/model/default"); return answer.status === 200 && answer.json.data; }, "the engine to start");
  // The models it lists now. (Its default is whichever model came out newest, and its catalog of
  // free ones refreshes a few seconds after it starts, so the default says nothing sure about
  // Copilot; a provider that counts as set up has its models listed.)
  const models = async () => {
    const answer = (await api("GET", "api/model")).json;
    return Array.isArray(answer) ? answer : answer?.data ?? [];
  };
  const providers = async () => new Set((await models()).map(model => model.providerID));
  // A message in `session`, and the conversation once its turn is over: how it ended, and any error.
  const say = async (session, text) => {
    const before = (await api("GET", `api/session/${session}/message?limit=200`)).json?.data?.length ?? 0;
    await api("POST", `api/session/${session}/prompt`, { text, delivery: "steer" });
    const page = await waitFor(async () => {
      const messages = (await api("GET", `api/session/${session}/message?limit=200`)).json?.data ?? [];
      return messages.length > before && messages[0]?.type === "idle" && messages.slice(0, messages.length - before);
    }, "the turn to end");
    return { idle: page[0], failed: page.find(message => message.type === "assistant" && message.error) };
  };
  return { target, api, chosen, models, providers, say, stop };
}

test("with no accounts, a box's engine answers a first message on its default model, even one an older Kuvo Code left Copilot's settings on: its box unlearns them as the engine runs", { skip: !binary && "OPENCODE_TEST_BINARY isn't set", timeout: 600_000 }, async () => {
  // A box an older Kuvo Code left Copilot's Claude models on, learned from what that layer itself
  // put in the engine's list: its engine lists Copilot's models and can make one its default, with no account to run it.
  const setting = { compatibility: { supportsThinkingBlockBinding: false } };
  fs.writeFileSync(`${box}/run/compatibility.json`, JSON.stringify({ providers: { "github-copilot": { models: { "claude-opus-5.5": setting, "claude-sonnet-5.5": setting } } } }));
  const engine = await startEngine();
  assert.ok((await engine.providers()).has("github-copilot"), "The engine no longer counts Copilot as set up when its settings name it: the layer may not need its account check");
  // The box learns from it (it may not say what accounts it has for a moment after it starts).
  await waitFor(async () => { await link.learnCompatibility(engine.target); return true; }, "the box to learn from its engine");
  // The engine drops Copilot as it runs: no restart.
  await waitFor(async () => !(await engine.providers()).has("github-copilot"), "the engine to drop Copilot's models");
  const chosen = (await engine.api("GET", "api/model/default")).json.data;
  assert.equal(chosen.providerID, "opencode", `The engine's default is ${chosen.providerID}/${chosen.id}, which has no account here`);
  const session = (await engine.api("POST", "api/session", { location: { directory: work } })).json.data;
  const { idle, failed } = await engine.say(session.id, "Say hi in three words.");
  assert.equal(failed, undefined, `The first message failed on ${failed?.model?.providerID}/${failed?.model?.id}: ${failed?.error?.message} (${failed?.error?.response?.body ?? ""})`);
  assert.equal(idle.outcome, "succeeded");
  await engine.stop();
});

// GitHub Copilot's API for one account, as it answers: the models the account has (`models`), and
// messages, refusing what Copilot refuses (`thinking.block_binding`); `asked` keeps what each
// message asked for. `hold()` keeps its answers back (a reply taking its time) until `release()`.
async function copilotStandIn(models) {
  const copilot = { models, asked: [], held: null, heldAsked: [] };
  copilot.hold = () => {
    let release;
    copilot.held = new Promise(resolve => { release = resolve; });
    copilot.release = () => { copilot.held = null; release(); };
  };
  // The next message held back, once it has come.
  copilot.nextHeld = () => new Promise(resolve => copilot.heldAsked.push(resolve));
  const listed = id => ({
    id, name: id, version: id, model_picker_enabled: true, supported_endpoints: ["/v1/messages"],
    capabilities: { family: id.replace(/-[\d.]+$/, ""), limits: { max_context_window_tokens: 200000, max_output_tokens: 32000, max_prompt_tokens: 168000 }, supports: { tool_calls: true, streaming: true, adaptive_thinking: true, reasoning_effort: ["low", "medium", "high"] } },
  });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", async () => {
      if (request.url === "/v1/messages" && copilot.held) {
        for (const resolve of copilot.heldAsked.splice(0)) resolve();
        await copilot.held;
      }
      if (request.url === "/models") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: copilot.models.map(listed) }));
      if (request.url !== "/v1/messages") return response.writeHead(404).end();
      const asked = JSON.parse(body);
      copilot.asked.push(asked);
      if (asked.thinking?.block_binding) {
        return response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thinking.adaptive.block_binding: Extra inputs are not permitted" } }));
      }
      const events = [
        ["message_start", { type: "message_start", message: { id: `msg_${copilot.asked.length}`, type: "message", role: "assistant", model: asked.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi from Copilot" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  copilot.url = `http://127.0.0.1:${server.address().port}`;
  return copilot;
}

test("a Copilot account signed in to: its Claude models work at once, with no restart; one it gets later works once you refresh its models; signed out, it's gone at once", { skip: !binary && "OPENCODE_TEST_BINARY isn't set", timeout: 600_000 }, async t => {
  fs.rmSync(`${box}/run/compatibility.json`, { force: true });
  const copilot = await copilotStandIn(["claude-opus-5.5", "gpt-6"]);
  // Your own settings, in the same folder as the box's file (as on a Mac): a provider of your own.
  fs.mkdirSync(`${box}/config/opencode`, { recursive: true });
  fs.writeFileSync(`${box}/config/opencode/opencode.json`, JSON.stringify({ provider: { lab: { name: "Lab", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "none" }, models: { "lab-one": { name: "Lab One" } } } } }));
  const engine = await startEngine();
  const yours = async () => (await engine.models()).some(model => model.providerID === "lab" && model.id === "lab-one");
  assert.ok(await yours(), "The engine doesn't read your own settings");
  // The box, watching its engine as it does.
  const stop = new AbortController();
  t.after(() => stop.abort());
  link.watchBox({ signal: stop.signal });

  // Signed in (from any of your devices): the engine keeps the account's sign-in, at Copilot's API.
  const added = await engine.api("POST", "api/credential", {
    integrationID: "github-copilot",
    value: { type: "oauth", methodID: "device", refresh: "gho_test", access: "gho_test", expires: 0, metadata: { apiEndpoint: copilot.url } },
  });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const compatible = id => async () => (await engine.models()).some(model => model.providerID === "github-copilot" && model.id === id && model.compatibility?.supportsThinkingBlockBinding === false);
  await waitFor(compatible("claude-opus-5.5"), "the engine to have what Copilot's Claude models need");
  // Yours still apply beside it.
  assert.ok(await yours(), "Your own settings went with the box's file beside them");

  // A conversation on it, with thinking on (the engine adds the field Copilot refuses to those).
  const session = (await engine.api("POST", "api/session", { location: { directory: work } })).json.data;
  await engine.api("POST", `api/session/${session.id}/model`, { model: { providerID: "github-copilot", id: "claude-opus-5.5", variant: "high" } });
  let turn = await engine.say(session.id, "Say hi.");
  assert.equal(turn.failed, undefined, `It failed: ${turn.failed?.error?.message} (${turn.failed?.error?.response?.body ?? ""})`);
  assert.equal(turn.idle.outcome, "succeeded");
  assert.ok(copilot.asked.some(asked => asked.model === "claude-opus-5.5" && asked.thinking?.type === "adaptive"), "The message didn't ask Copilot to think, so the field it refuses was never at stake");

  // Copilot gives the account another model; the engine doesn't know until its models are asked of again.
  copilot.models = ["claude-opus-5.5", "claude-sonnet-5.6", "gpt-6"];
  assert.ok(!(await engine.models()).some(model => model.id === "claude-sonnet-5.6"));
  const refresh = async () => {
    const parts = [];
    for await (const part of link.engineHandler(() => engine.target)({ method: "POST", path: "kuvo/accounts/github-copilot/refresh", headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
    return { status: parts[0].head.status, json: JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString()) };
  };
  const listsNew = async () => (await engine.models()).some(model => model.providerID === "github-copilot" && model.id === "claude-sonnet-5.6");
  const open = async () => ((await engine.api("GET", "api/debug/location")).json ?? []).map(each => each.directory);
  // Refreshed while a turn is under way in another project, this one quiet: the engine keeps
  // Copilot's list for all its folders while any is open, so nothing is closed, the turn isn't cut,
  // and it says when they come by themselves.
  const other = `${root}/other`;
  fs.mkdirSync(other, { recursive: true });
  const elsewhere = (await engine.api("POST", "api/session", { location: { directory: other } })).json.data;
  await engine.api("POST", `api/session/${elsewhere.id}/model`, { model: { providerID: "github-copilot", id: "claude-opus-5.5", variant: "high" } });
  copilot.hold();
  const asking = copilot.nextHeld();
  const running = engine.say(elsewhere.id, "Take your time.");
  await asking;
  const busy = await refresh();
  assert.equal(busy.status, 409, JSON.stringify(busy.json));
  assert.match(busy.json.message, /by themselves within twenty minutes/);
  assert.ok((await open()).includes(work), "A quiet folder was closed though that brings nothing while another stays open");
  // (What makes it so, on the engine: this folder closed and opened afresh, the other still open,
  // still has the list from before. An engine that reads it again then lets the box close folders
  // one at a time again.)
  await engine.api("DELETE", `api/debug/location?${new URLSearchParams({ "location[directory]": work })}`);
  assert.ok(!(await listsNew()), "The engine read Copilot's models afresh for a folder opened again while another stayed open");
  copilot.release();
  turn = await running;
  assert.equal(turn.idle.outcome, "succeeded", `The turn under way was cut: ${turn.failed?.error?.message}`);
  // Every project quiet: every folder is closed, and the engine reads the list afresh.
  const refreshed = await refresh();
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.deepEqual(refreshed.json.waiting, []);
  for (const soon = Date.now() + 15_000; !(await compatible("claude-sonnet-5.6")());) {
    assert.ok(Date.now() < soon, "The engine didn't list the new model, with what it needs, at once after a refresh that said it was done");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // In the conversation going on, on the same engine.
  await engine.api("POST", `api/session/${session.id}/model`, { model: { providerID: "github-copilot", id: "claude-sonnet-5.6", variant: "high" } });
  turn = await engine.say(session.id, "And again.");
  assert.equal(turn.failed, undefined, `It failed: ${turn.failed?.error?.message} (${turn.failed?.error?.response?.body ?? ""})`);
  assert.equal(turn.idle.outcome, "succeeded");
  assert.ok(copilot.asked.some(asked => asked.model === "claude-sonnet-5.6"));
  assert.ok(copilot.asked.every(asked => !asked.thinking?.block_binding));

  // Signed out: Copilot's gone from the engine at once, so none of its models is the default.
  await engine.api("DELETE", `api/credential/${added.json.data.id}`);
  await waitFor(async () => !(await engine.providers()).has("github-copilot"), "the engine to drop Copilot");
  assert.ok(await yours(), "Your own settings went with the box's file");
  stop.abort();
  await engine.stop();
});
