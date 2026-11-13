// One integration that turns down its sign-in (Notion's, taken back) never ends a turn on the real
// engine: its tools leave the conversation (it needs signing in, as Settings › Integrations then
// says), and a call to it that's turned down partway is the tool's error, which the model reads
// and goes on from. (The coding agents reach integrations through the bridge's relay, which stands
// in for one that can't be reached: Packages/Box/test/agents.)
//
// The real engine, in folders of the test's own: the model is a stand-in that calls the
// integration's tool once it has it, then answers, and the integration a stand-in MCP server that
// answers 401. Skipped unless OPENCODE_TEST_BINARY names the engine.
//
// Run with `OPENCODE_TEST_BINARY=<opencode> node --test Packages/KuvoLink/Tests/Bridge/mcp-refused-live.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const binary = process.env.OPENCODE_TEST_BINARY;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-mcp-refused-live-")));
removeAtEnd(root);

const listen = async server => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
};
const bodyOf = request => new Promise(resolve => { let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => resolve(body)); });

const waitFor = async (wanted, what) => {
  const end = Date.now() + 120_000;
  for (;;) {
    const found = await wanted().catch(() => null);
    if (found) return found;
    assert.ok(Date.now() < end, `Waited too long for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
};

/** Notion's server, as a stand-in: `refusing` "start" turns down every request, "calls" only its tool's. */
async function notionStandIn() {
  const notion = { refusing: "start", asked: [] };
  const port = await listen(http.createServer(async (request, response) => {
    const message = JSON.parse(await bodyOf(request) || "null");
    notion.asked.push(message?.method ?? request.method);
    if (request.method !== "POST") return response.writeHead(405).end();
    if (notion.refusing === "start" || (notion.refusing === "calls" && message?.method === "tools/call")) {
      return response.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"', "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_token" }));
    }
    if (message?.id === undefined) return response.writeHead(202).end();
    const reply = result => response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "notion-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notion", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: [{ name: "search", description: "Search pages", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] });
    reply({ content: [{ type: "text", text: "Found it." }] });
  }));
  notion.url = `http://127.0.0.1:${port}/mcp`;
  return notion;
}

/** A model, as a stand-in (OpenAI's chat completions): it calls Notion's tool when it has it, then
 * answers with what the tool said. `tools` keeps the tools each request offered. */
async function modelStandIn() {
  const model = { tools: [] };
  const port = await listen(http.createServer(async (request, response) => {
    const asked = JSON.parse(await bodyOf(request) || "{}");
    const offered = (asked.tools ?? []).map(each => each.function?.name);
    model.tools.push(offered);
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } : {}) })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const result = (asked.messages ?? []).filter(each => each.role === "tool").at(-1);
    const notion = offered.find(name => name?.startsWith("notion_"));
    if (!result && notion) return response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: notion, arguments: '{"query":"plans"}' } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    response.end(chunk({ role: "assistant", content: `Answered; the tool said: ${typeof result?.content === "string" ? result.content.slice(0, 400) : "nothing"}` }) + chunk({}, "stop") + "data: [DONE]\n\n");
  }));
  model.url = `http://127.0.0.1:${port}/v1`;
  return model;
}

/** The engine, with Notion added as Integrations adds it, and the stand-in model. */
async function startEngine(notion, model) {
  for (const folder of ["home", "tmp", "work", "config/opencode", "xdg/data", "xdg/state", "xdg/cache"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(`${root}/config/opencode/opencode.json`, JSON.stringify({
    provider: { lab: { name: "Lab", npm: "@ai-sdk/openai-compatible", options: { baseURL: model.url, apiKey: "none" }, models: { m: { name: "M", tool_call: true } } } },
    model: "lab/m",
    mcp: { servers: { notion: { type: "remote", url: notion.url, codemode: false } } },
  }));
  const env = {
    PATH: process.env.PATH, HOME: `${root}/home`, TMPDIR: `${root}/tmp/`, XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/xdg/data`,
    XDG_STATE_HOME: `${root}/xdg/state`, XDG_CACHE_HOME: `${root}/xdg/cache`, OPENCODE_PASSWORD: "pw",
  };
  const work = `${root}/work`;
  const child = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  atEnd(() => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); }));
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const headers = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(work) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  await waitFor(async () => (await api("GET", "api/model/default")).status === 200, "the engine to start");
  const status = async () => (await api("GET", "api/mcp")).json?.data?.find(each => each.name === "notion")?.status?.status;
  // A message in a new conversation, and how its turn ended: the tool's call, and what was said.
  const say = async text => {
    const session = (await api("POST", "api/session", { location: { directory: work } })).json.data;
    await api("POST", `api/session/${session.id}/model`, { model: { providerID: "lab", id: "m" } });
    await api("POST", `api/session/${session.id}/prompt`, { text, delivery: "steer" });
    const messages = await waitFor(async () => {
      const page = (await api("GET", `api/session/${session.id}/message?limit=200`)).json?.data ?? [];
      return page[0]?.type === "idle" && page;
    }, "the turn to end");
    const content = messages.filter(message => message.type === "assistant").flatMap(message => message.content);
    return { idle: messages[0], failed: messages.find(message => message.type === "assistant" && message.error), call: content.find(part => part.type === "tool"), text: content.filter(part => part.type === "text").map(part => part.text).join("") };
  };
  return { api, status, say };
}

test("Notion turning down its sign-in never ends a turn on the engine: from the start its tools are left out and it needs signing in; partway, its call is the tool's error and the model goes on", { skip: !binary && "OPENCODE_TEST_BINARY isn't set", timeout: 300_000 }, async () => {
  const notion = await notionStandIn();
  const model = await modelStandIn();
  const engine = await startEngine(notion, model);

  // Turned down from the start: it needs signing in, and the turn goes on without its tools.
  assert.equal(await waitFor(async () => { const now = await engine.status(); return now !== "pending" && now; }, "Notion to connect or not"), "needs_auth");
  let turn = await engine.say("Look up our plans in Notion.");
  assert.equal(turn.failed, undefined, `The turn failed: ${turn.failed?.error?.message}`);
  assert.equal(turn.idle.outcome, "succeeded");
  assert.ok(!model.tools.flat().some(name => name?.startsWith("notion_")), "Notion's tools were offered while it needs signing in");

  // Signed in (the engine keeps the sign-in), it connects, then turns down a call partway: the
  // tool's error, and the turn goes on.
  notion.refusing = "calls";
  const integrationID = (await engine.api("GET", "api/mcp")).json.data.find(each => each.name === "notion").integrationID;
  const signedIn = await engine.api("POST", "api/credential", { integrationID, value: { type: "oauth", methodID: "oauth", refresh: "refresh-1", access: "access-1", expires: Date.now() + 3_600_000 } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.json));
  await engine.api("POST", "api/experimental/mcp/notion/connect", {});
  await waitFor(async () => (await engine.status()) === "connected", "Notion to connect");
  // (Its tools reach new conversations a moment after it connects: until then the model has none to call.)
  turn = await waitFor(async () => {
    const said = await engine.say("Look up our plans in Notion again.");
    assert.equal(said.failed, undefined, `The turn failed: ${said.failed?.error?.message}`);
    assert.equal(said.idle.outcome, "succeeded");
    return said.call && said;
  }, "the model to have Notion's tools");
  assert.ok(notion.asked.includes("tools/call"), `Notion's tool was never called: ${notion.asked.join(" ")}`);
  assert.equal(turn.call.state?.status, "error");
  assert.match(turn.call.state.error.message, /notion/);
  assert.match(turn.text, /^Answered; the tool said: .*notion/);
});
