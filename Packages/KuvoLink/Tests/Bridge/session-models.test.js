// What a session's model button shows and whether its model can run (PROTOCOL.md, "A session's
// model"), as the box decides it for every client: the model it runs on, whether it can, and what's
// missing if not (a sign-in, a key, its agent installed, or the model gone from its provider's
// list). The real box code; the engine and the coding agents' bridge are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/session-models.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runningAs } from "./running-as.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-session-models-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// A stand-in on a free port, answering `routes[url]` (or 404), its `data` as their APIs give it;
// the folders it was asked about, as the engine reads them (`x-opencode-directory`), kept.
const folders = [];
async function standIn(routes) {
  const server = http.createServer((request, response) => {
    if (request.headers["x-opencode-directory"]) folders.push(decodeURIComponent(request.headers["x-opencode-directory"]));
    const value = typeof routes === "function" ? routes(request.url) : routes[request.url];
    response.writeHead(value === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(value === undefined ? { message: "No such thing." } : { data: value }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, password: "p" };
}

const session = (id, model) => ({ id, title: id, location: { directory: home }, time: { created: 1, updated: 1 }, ...(model ? { model } : {}) });
const model = (providerID, id, name, extra = {}) => ({ id, providerID, name, enabled: true, status: "active", cost: [{ input: 1, output: 2 }], ...extra });

// The engine: Anthropic signed in, GitHub Copilot signed out (it signs in on a page), xAI and OpenAI
// offering only a key (their plans go through Grok and Codex), DeepSeek a key, OpenCode Zen's free
// models with no account.
const engineSessions = {
  ses_fine: session("ses_fine", { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }),
  ses_signedOut: session("ses_signedOut", { providerID: "github-copilot", id: "gpt-5.5" }),
  ses_xai: session("ses_xai", { providerID: "xai", id: "grok-4.7" }),
  ses_deepseek: session("ses_deepseek", { providerID: "deepseek", id: "deepseek-chat" }),
  ses_gone: session("ses_gone", { providerID: "anthropic", id: "claude-3-opus" }),
  ses_free: session("ses_free", { providerID: "opencode", id: "big-pickle" }),
  ses_none: session("ses_none"),
  ses_projects: session("ses_projects", { providerID: "my-own", id: "local-7b" }),
  ses_chatgpt: session("ses_chatgpt", { providerID: "openai", id: "gpt-5.5" }),
  ses_local: session("ses_local", { providerID: "lmstudio", id: "qwen-3" }),
  ses_ollama: session("ses_ollama", { providerID: "ollama", id: "llama-4" }),
};
const engine = await standIn(url => {
  const one = url.match(/^\/api\/session\/([^/?]+)$/);
  if (one) return engineSessions[decodeURIComponent(one[1])];
  return {
    "/api/provider": [{ id: "anthropic" }],
    "/api/model": [
      model("anthropic", "claude-opus-5-5", "Claude Opus 5.5"),
      model("anthropic", "claude-sonnet-5", "Claude Sonnet 5", { status: "deprecated" }),
      model("github-copilot", "gpt-5.5", "GPT-5.5"),
      model("xai", "grok-4.7", "Grok 4.7"),
      model("openai", "gpt-5.5", "GPT-5.5"),
      model("deepseek", "deepseek-chat", "DeepSeek Chat"),
      model("opencode", "big-pickle", "Big Pickle", { cost: [{ input: 0, output: 0 }] }),
      model("lmstudio", "qwen-3", "Qwen 3"),
      model("ollama", "llama-4", "Llama 4"),
    ],
    "/api/integration": [
      { id: "anthropic", name: "Anthropic", methods: [{ type: "key" }], connections: [{ type: "credential", method: "key" }] },
      { id: "github-copilot", name: "GitHub Copilot", methods: [{ type: "oauth", id: "device", label: "GitHub" }], connections: [] },
      { id: "xai", name: "xAI", methods: [{ type: "oauth", id: "device", label: "SuperGrok" }, { type: "key" }], connections: [] },
      { id: "openai", name: "OpenAI", methods: [{ type: "oauth", id: "chatgpt-browser", label: "ChatGPT Pro/Plus" }, { type: "key" }, { type: "env", names: ["OPENAI_API_KEY"] }], connections: [] },
      { id: "deepseek", name: "DeepSeek", methods: [{ type: "key" }, { type: "env", names: ["DEEPSEEK_API_KEY"] }], connections: [] },
      { id: "opencode", name: "OpenCode Zen", methods: [{ type: "key" }], connections: [] },
      { id: "ollama", name: "Ollama", methods: [], connections: [] },
    ],
    "/api/model/default": { providerID: "anthropic", id: "claude-opus-5-5" },
  }[url];
});

// The coding agents' bridge: Claude Code signed in (its `default` stands for Opus), an account of
// Claude Code's you added and signed out of, Codex signed in with its models still to be listed,
// Cursor not installed, and two Custom Auto lists, one of them emptied.
const bridgeSessions = {
  ses_agentFine: session("ses_agentFine", { providerID: "claude-code", id: "default" }),
  ses_agentGone: session("ses_agentGone", { providerID: "claude-code", id: "claude-opus-4-1" }),
  ses_agentOut: session("ses_agentOut", { providerID: "claude-code@work", id: "claude-opus-5-5" }),
  ses_agentRemoved: session("ses_agentRemoved", { providerID: "claude-code@old", id: "claude-opus-5-5" }),
  ses_codex: session("ses_codex", { providerID: "codex-cli", id: "gpt-5.5" }),
  ses_cursor: session("ses_cursor", { providerID: "cursor", id: "composer-2" }),
  ses_auto: session("ses_auto", { providerID: "auto", id: "auto" }),
  ses_autoEmpty: session("ses_autoEmpty", { providerID: "auto", id: "list_empty" }),
  ses_autoGone: session("ses_autoGone", { providerID: "auto", id: "list_deleted" }),
  ses_agentOnEngine: session("ses_agentOnEngine", { providerID: "xai", id: "grok-4.7" }),
  ses_starting: session("ses_starting", { providerID: "claude-code@new", id: "opusplan" }),
  ses_codexHidden: session("ses_codexHidden", { providerID: "codex-cli@work", id: "gpt-5.1-codex-mini" }),
  ses_codexAbsent: session("ses_codexAbsent", { providerID: "codex-cli@work", id: "gpt-4.1" }),
};
const agent = (id, name, { installed = true, signedIn = true, label } = {}) => ({
  id, name, metadata: { source: "agent", installed, ...(label ? { accountLabel: label } : {}) }, methods: [{ type: "oauth", id: "browser", label: "Sign in" }],
  connections: signedIn ? [{ type: "agent", method: "oauth", status: { status: "connected" } }] : [],
});
const bridge = await standIn(url => {
  const one = url.match(/^\/api\/session\/([^/?]+)$/);
  if (one) return bridgeSessions[decodeURIComponent(one[1])];
  return {
    "/api/integration": [
      agent("claude-code", "Claude Code"),
      agent("claude-code@work", "Claude Code · Work", { signedIn: false, label: "Work" }),
      agent("codex-cli", "Codex"),
      agent("cursor", "Cursor", { installed: false, signedIn: false }),
      agent("claude-code@new", "Claude Code · New", { label: "New" }),
      agent("codex-cli@work", "Codex · Work", { label: "Work" }),
    ],
    // (As the bridge lists them for the box: those an agent keeps out of its picker too.)
    "/api/model?hidden=1": [
      model("codex-cli@work", "gpt-5.5", "GPT-5.5"),
      model("codex-cli@work", "gpt-5.1-codex-mini", "GPT-5.1 Codex Mini", { hidden: true }),
      model("claude-code", "claude-opus-5-5", "Opus 5.5", { aliases: ["default"] }),
      model("claude-code", "claude-sonnet-5", "Sonnet 5"),
      // Claude Code's usual ones, until it says which this account has.
      model("claude-code@new", "opus", "Opus", { aliases: ["default"], provisional: true }),
      model("claude-code@new", "sonnet", "Sonnet", { provisional: true }),
    ],
    "/api/kuvo/auto": { entries: [], lists: [
      { id: "auto", name: "Custom Auto", entries: [{ providerID: "claude-code", modelID: "claude-opus-5-5" }] },
      { id: "list_empty", name: "Bugfixes", entries: [] },
    ], limits: [] },
  }[url];
});
const agents = await runningAs("kuvo-agents", { after: atEnd });
const handle = link.engineHandler(() => ({ pid: process.pid, ...engine, version: "2.0.32" }), { name: "Studio" }, () => ({ pid: agents, ...bridge }));

async function answer(method, route) {
  const parts = [];
  for await (const part of handle({ method, path: route, headers: {}, body: Buffer.from("") }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}
const states = async (...ids) => {
  const { status, json } = await answer("GET", `kuvo/sessions/models?sessions=${ids.join(",")}`);
  assert.equal(status, 200);
  return json.sessions;
};

test("a model that runs: the model and its name, and nothing missing", async () => {
  const shown = await states("ses_fine", "ses_free");
  assert.deepEqual(shown.ses_fine, { model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }, name: "Claude Opus 5.5", runs: true });
  // OpenCode Zen's free models need no account.
  assert.deepEqual(shown.ses_free, { model: { providerID: "opencode", id: "big-pickle" }, name: "Big Pickle", runs: true });
});

test("a model whose account is signed out: a sign-in, and to which account", async () => {
  assert.deepEqual((await states("ses_signedOut")).ses_signedOut, {
    model: { providerID: "github-copilot", id: "gpt-5.5" }, name: "GPT-5.5", runs: false,
    missing: "signIn", account: { id: "github-copilot", name: "GitHub Copilot" },
  });
});

test("a model whose provider takes only a key: a key, and where a plan's models are for a plan that goes through its coding agent", async () => {
  const shown = await states("ses_xai", "ses_deepseek");
  // The engine's xAI lists SuperGrok's sign-in, which Accounts doesn't offer: the plan is Grok's.
  assert.deepEqual(shown.ses_xai, {
    model: { providerID: "xai", id: "grok-4.7" }, name: "Grok 4.7", runs: false,
    missing: "key", account: { id: "xai", name: "xAI" }, plan: { name: "SuperGrok", agent: "Grok", provider: "grok-cli" },
  });
  assert.deepEqual(shown.ses_deepseek, {
    model: { providerID: "deepseek", id: "deepseek-chat" }, name: "DeepSeek Chat", runs: false,
    missing: "key", account: { id: "deepseek", name: "DeepSeek" },
  });
  // OpenAI's ChatGPT sign-in is Codex's: the engine's OpenAI takes a key.
  assert.deepEqual((await states("ses_chatgpt")).ses_chatgpt, {
    model: { providerID: "openai", id: "gpt-5.5" }, name: "GPT-5.5", runs: false,
    missing: "key", account: { id: "openai", name: "OpenAI" }, plan: { name: "ChatGPT", agent: "Codex", provider: "codex-cli" },
  });
});

test("a provider with nothing to sign in to runs what it lists: a local one, or one with no way to sign in", async () => {
  const shown = await states("ses_local", "ses_ollama");
  assert.deepEqual(shown.ses_local, { model: { providerID: "lmstudio", id: "qwen-3" }, name: "Qwen 3", runs: true });
  assert.deepEqual(shown.ses_ollama, { model: { providerID: "ollama", id: "llama-4" }, name: "Llama 4", runs: true });
});

test("a model gone from its provider's list, its account signed in: gone, choose another", async () => {
  assert.deepEqual((await states("ses_gone")).ses_gone, {
    model: { providerID: "anthropic", id: "claude-3-opus" }, runs: false, missing: "gone", account: { id: "anthropic", name: "Anthropic" },
  });
});

test("a coding agent's model: by the name its agent lists, gone once its agent no longer lists it, and its account's sign-in or its program", async () => {
  const shown = await states("ses_agentFine", "ses_agentGone", "ses_agentOut", "ses_agentRemoved", "ses_cursor", "ses_agentOnEngine");
  // Claude Code's `default`, as the model it stands for now.
  assert.deepEqual(shown.ses_agentFine, { model: { providerID: "claude-code", id: "default" }, name: "Opus 5.5", runs: true });
  // Dropped from Claude Code's list while it's signed in (#338's leftover): gone, not sent to fail.
  assert.deepEqual(shown.ses_agentGone, { model: { providerID: "claude-code", id: "claude-opus-4-1" }, runs: false, missing: "gone", account: { id: "claude-code", name: "Claude Code" } });
  assert.deepEqual(shown.ses_agentOut, { model: { providerID: "claude-code@work", id: "claude-opus-5-5" }, runs: false, missing: "signIn", account: { id: "claude-code@work", name: "Claude Code · Work", label: "Work" } });
  // An account you removed: its models went with it.
  assert.deepEqual(shown.ses_agentRemoved, { model: { providerID: "claude-code@old", id: "claude-opus-5-5" }, runs: false, missing: "gone" });
  assert.deepEqual(shown.ses_cursor, { model: { providerID: "cursor", id: "composer-2" }, runs: false, missing: "install", account: { id: "cursor", name: "Cursor" } });
  // A conversation with the coding agents on the engine's model: the engine's account says.
  assert.equal(shown.ses_agentOnEngine.missing, "key");
});

test("a model Codex keeps out of its picker still runs; one absent from its list is gone", async () => {
  const shown = await states("ses_codexHidden", "ses_codexAbsent");
  assert.deepEqual(shown.ses_codexHidden, { model: { providerID: "codex-cli@work", id: "gpt-5.1-codex-mini" }, name: "GPT-5.1 Codex Mini", runs: true });
  assert.deepEqual(shown.ses_codexAbsent, {
    model: { providerID: "codex-cli@work", id: "gpt-4.1" }, runs: false, missing: "gone", account: { id: "codex-cli@work", name: "Codex · Work", label: "Work" },
  });
});

test("Custom Auto runs while its list has models, and is gone once it's emptied", async () => {
  const shown = await states("ses_auto", "ses_autoEmpty", "ses_autoGone");
  assert.deepEqual(shown.ses_auto, { model: { providerID: "auto", id: "auto" }, name: "Custom Auto", runs: true });
  assert.deepEqual(shown.ses_autoEmpty, { model: { providerID: "auto", id: "list_empty" }, name: "Bugfixes", runs: false, missing: "gone" });
  // A list deleted runs on the first, as the bridge runs it.
  assert.deepEqual(shown.ses_autoGone, { model: { providerID: "auto", id: "list_deleted" }, name: "Custom Auto", runs: true });
});

test("what the box can't say yet is left out: a coding agent's models still being listed, a provider only a project knows, a session it doesn't have", async () => {
  // Claude Code listing only its usual ones as it starts: one not among them isn't gone yet.
  const shown = await states("ses_codex", "ses_projects", "ses_nowhere", "ses_starting", "ses_fine");
  assert.deepEqual(Object.keys(shown), ["ses_fine"]);
});

test("the engine's lists are read in the session's folder, where a project's own settings may add to them", async () => {
  folders.length = 0;
  await states("ses_none");
  assert.ok(folders.length > 0 && folders.every(folder => folder === home), `asked about ${folders}`);
});

test("with the engine down, the coding agents' sessions are still said; the engine's models aren't guessed", async () => {
  const down = link.engineHandler(() => ({ pid: process.pid, port: 1, password: "p", version: "2.0.32" }), { name: "Studio" }, () => ({ pid: agents, ...bridge }));
  const parts = [];
  for await (const part of down({ method: "GET", path: "kuvo/sessions/models?sessions=ses_agentFine,ses_agentOnEngine", headers: {}, body: Buffer.from("") }, {}, undefined)) parts.push(part);
  assert.equal(parts[0].head.status, 200);
  const shown = JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString()).sessions;
  assert.deepEqual(Object.keys(shown), ["ses_agentFine"]);
});

test("a session with no model of its own runs on the engine's default", async () => {
  assert.deepEqual((await states("ses_none")).ses_none, { model: { providerID: "anthropic", id: "claude-opus-5-5" }, name: "Claude Opus 5.5", runs: true });
});

test("none named is refused, and it's only read", async () => {
  assert.equal((await answer("GET", "kuvo/sessions/models")).status, 400);
  assert.equal((await answer("POST", "kuvo/sessions/models?sessions=ses_fine")).status, 405);
});
