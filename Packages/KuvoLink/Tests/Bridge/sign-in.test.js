// Signing in to an account (PROTOCOL.md, "Signing in"), as the box answers every client: the ways
// to sign in, in its order and words (`kuvo/sign-in/methods`), and how a started sign-in is going,
// with what to say once it didn't work (`kuvo/sign-in/status`), from the engine or, for a coding
// agent's account, the agents' bridge. The real box code; the engine and the bridge are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/sign-in.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runningAs } from "./running-as.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-sign-in-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// A stand-in on a free port: `routes(url)` gives its `data` as their APIs do, `{status, message}`
// for a refusal, or nothing (404). Every path asked, kept.
const asked = [];
async function standIn(routes) {
  const server = http.createServer((request, response) => {
    asked.push(request.url);
    const value = routes(request.url);
    const refusal = value?.refused;
    response.writeHead(value === undefined ? 404 : refusal ? refusal.status : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(value === undefined ? { message: "Not found." } : refusal ? { message: refusal.message } : { location: null, data: value }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, password: "p" };
}

// The engine: OpenAI (its plan goes through Codex, and it keeps two legacy ways), Bedrock (AWS
// credentials already on the computer, or a key), and sign-ins that ended each way.
const attempts = {
  att_pending: { status: "pending", message: "Downloading… 40%", url: "https://example.com/later" },
  att_done: { status: "complete" },
  att_denied: { status: "failed", message: "access_denied" },
  att_said: { status: "failed", message: "The page said no." },
  att_late: { status: "expired" },
};
const engine = await standIn(url => {
  if (url === "/api/integration") return [
    { id: "openai", name: "OpenAI", methods: [{ type: "key" }, { type: "env", names: ["OPENAI_API_KEY"] }, { type: "oauth", id: "chatgpt-browser", label: "Codex browser (legacy)" }, { type: "oauth", id: "chatgpt-token-sharing", label: "Sign in with ChatGPT" }], connections: [] },
    { id: "amazon-bedrock", name: "Amazon Bedrock", methods: [{ type: "key", label: "Bedrock API key" }, { type: "external", id: "aws", label: "AWS credentials on this computer", form: [{ key: "region", type: "text", label: "Region" }] }, { type: "env", names: ["AWS_PROFILE"] }], connections: [] },
    { id: "github-copilot", name: "GitHub Copilot", methods: [{ type: "oauth", id: "device", label: "Sign in with GitHub" }, { type: "command", id: "gh", label: "Use gh" }], connections: [] },
  ];
  const attempt = url.match(/^\/api\/integration\/github-copilot\/connect\/oauth\/([^/?]+)$/)?.[1];
  if (attempt === "att_broken") return { refused: { status: 500, message: "The engine fell over." } };
  if (attempt) return attempts[decodeURIComponent(attempt)];
  return undefined;
});
// The coding agents' bridge: Claude Code, signed in with its own command or a key.
const bridge = await standIn(url => {
  if (url === "/api/integration") return [{ id: "claude-code", name: "Claude Code", methods: [{ type: "key", label: "Anthropic API key" }, { type: "oauth", id: "subscription", label: "Claude Pro or Max" }], connections: [] }];
  if (url === "/api/integration/claude-code/connect/oauth/att_agent") return { status: "failed", message: "server_error", userCode: "AB12-CD34" };
  return undefined;
});
const agents = await runningAs("kuvo-agents", { after: atEnd });
const handlerOn = (bridgeRecord) => link.engineHandler(() => ({ pid: process.pid, ...engine, version: "2.0.32" }), { name: "Studio" }, bridgeRecord);
const handle = handlerOn(() => ({ pid: agents, ...bridge }));

async function answer(method, route, on = handle) {
  const parts = [];
  for await (const part of on({ method, path: route, headers: {}, body: Buffer.from("") }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}

test("an engine provider's ways in: an account's sign-in first, then a key, legacy ways last and marked; a plan another agent signs in to left out; its environment variables", async () => {
  // OpenAI's ChatGPT plan goes through Codex: only the key, and its variable.
  const openai = await answer("GET", "kuvo/sign-in/methods?integration=openai");
  assert.equal(openai.status, 200);
  assert.deepEqual(openai.json, { methods: [{ type: "key", label: "Use an API key" }], environment: ["OPENAI_API_KEY"] });

  const bedrock = await answer("GET", "kuvo/sign-in/methods?integration=amazon-bedrock");
  assert.deepEqual(bedrock.json, {
    methods: [
      { type: "external", id: "aws", label: "AWS credentials on this computer", form: [{ key: "region", type: "text", label: "Region" }] },
      { type: "key", label: "Bedrock API key" },
    ],
    environment: ["AWS_PROFILE"],
  });

  // A way no client can start (a command) isn't offered.
  const copilot = await answer("GET", "kuvo/sign-in/methods?integration=github-copilot");
  assert.deepEqual(copilot.json.methods, [{ type: "oauth", id: "device", label: "Sign in with GitHub" }]);
});

test("a coding agent's account: its ways from the agents' bridge", async () => {
  const claude = await answer("GET", "kuvo/sign-in/methods?integration=claude-code&agents=1");
  assert.equal(claude.status, 200);
  assert.deepEqual(claude.json, { methods: [{ type: "oauth", id: "subscription", label: "Claude Pro or Max" }, { type: "key", label: "Anthropic API key" }], environment: [] });
  // The engine doesn't have it.
  assert.equal((await answer("GET", "kuvo/sign-in/methods?integration=claude-code")).status, 404);
});

test("how a sign-in is going, as the engine says, with what to say once it ended without signing in", async () => {
  const status = async attempt => (await answer("GET", `kuvo/sign-in/status?integration=github-copilot&attempt=${attempt}`)).json;
  // Still going: as the engine says it, the page that came later too.
  assert.deepEqual(await status("att_pending"), { status: "pending", message: "Downloading… 40%", url: "https://example.com/later" });
  assert.deepEqual(await status("att_done"), { status: "complete" });
  // Turned down on its page: in words, the engine's own kept beside them.
  assert.deepEqual(await status("att_denied"), { status: "failed", message: "access_denied", failure: "The sign-in was turned down on its page. Try again to sign in." });
  assert.deepEqual(await status("att_said"), { status: "failed", message: "The page said no.", failure: "The page said no." });
  assert.deepEqual(await status("att_late"), { status: "expired", failure: "The sign-in timed out. Try again." });
  // A coding agent's, from the bridge, with what else it says.
  const agent = await answer("GET", "kuvo/sign-in/status?integration=claude-code&attempt=att_agent&agents=1");
  assert.deepEqual(agent.json, { status: "failed", message: "server_error", userCode: "AB12-CD34", failure: "The service couldn’t sign you in just now. Try again in a moment." });
});

test("a sign-in the engine doesn't know (it started over), or can't say: its status and words, for the client to count", async () => {
  const unknown = await answer("GET", "kuvo/sign-in/status?integration=github-copilot&attempt=att_gone");
  assert.equal(unknown.status, 404);
  const broken = await answer("GET", "kuvo/sign-in/status?integration=github-copilot&attempt=att_broken");
  assert.deepEqual(broken, { status: 500, json: { message: "The engine fell over." } });
});

test("asked of the coding agents while their bridge isn't running: why not", async () => {
  const down = handlerOn(() => null);
  const methods = await answer("GET", "kuvo/sign-in/methods?integration=claude-code&agents=1", down);
  assert.equal(methods.status, 503);
  assert.match(methods.json.message, /coding agents aren't running/);
  assert.equal((await answer("GET", "kuvo/sign-in/status?integration=claude-code&attempt=att_agent&agents=1", down)).status, 503);
});

test("asked without saying which, or to change something: refused", async () => {
  assert.equal((await answer("GET", "kuvo/sign-in/methods")).status, 400);
  assert.equal((await answer("GET", "kuvo/sign-in/status?integration=github-copilot")).status, 400);
  assert.equal((await answer("POST", "kuvo/sign-in/methods?integration=openai")).status, 405);
});

test("kuvo/info says the box answers them", async () => {
  const info = await answer("GET", "kuvo/info");
  assert.ok(info.json.features.includes("sign-in.methods"));
});
