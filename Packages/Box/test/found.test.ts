import "./safety"
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Target } from "../src/shared/records";
import { found, useFound } from "../src/link/areas/found";
import { opencodeAuthFile } from "../src/link/home";

// The first launch's "Bring your subscriptions": what a computer already has, as its box lists it,
// and a key of it brought over. The engine and the agents bridge are stand-ins that answer their
// HTTP routes as the real ones do; opencode's auth.json is a real file in a folder of the test's own.

let root = "";
const servers: http.Server[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-box-found-"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  rmSync(root, { recursive: true, force: true });
});

/** A local server answering `GET api/integration` with `list`, and keeping what's posted. As the
 * engine does, it lists `early` (what it has before its plugins are set up, 2.2.7 on) until its
 * providers are asked for, which wait for them. */
async function serve(list: unknown[], posted: unknown[] = [], early?: unknown[]): Promise<Target> {
  let setUp = !early
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from("opencode:secret").toString("base64")}`) {
      response.writeHead(401).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url === "/api/provider") {
        setUp = true;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ location: "global", data: [] }));
      } else if (request.method === "GET" && request.url?.startsWith("/api/integration")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ location: "global", data: setUp ? list : early }));
      } else if (request.method === "POST" && request.url === "/api/credential") {
        posted.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      } else {
        response.writeHead(404).end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, password: "secret" }
}

/** opencode's auth.json in the test's own home, wherever the run's own data folder is
 * (`XDG_DATA_HOME`): the test never reads or writes one outside its folder. */
function ownAuthFile() {
  const file = opencodeAuthFile(root, {});
  mkdirSync(join(root, ".local", "share", "opencode"), { recursive: true });
  return file;
}

function opencode(entries: Record<string, unknown>) {
  const file = ownAuthFile();
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

/** An agent as the agents bridge lists it (src/agents/server.ts): its own sign-in (`accountLabel`
 * names an account you added, empty for this one), who it's signed in as in `account`, and a
 * connection only while it's signed in. */
const agent = (id: string, name: string, installed: boolean, account?: string) => ({
  id,
  name,
  metadata: { source: "agent", agent: id, accountID: "default", accountLabel: "", installed, ...(account ? { account } : {}) },
  methods: [],
  connections: account ? [{ type: "agent", label: account, method: "oauth", status: { status: "connected", message: `Signed in as ${account}` } }] : [],
});
/** A sign-in the engine keeps, as it lists one: a working one carries no status. */
const credential = { type: "credential", id: "c1", label: "API key", method: "key" };

test("a Mac with agents and an opencode of its own: each is offered for what it needs", async () => {
  const bridge = await serve([
    agent("claude-code", "Claude Code", true, "you@example.com · Max plan"),
    agent("grok-cli", "Grok", true),
    agent("codex-cli", "Codex", false),
  ]);
  const engine = await serve([
    { id: "anthropic", name: "Anthropic", methods: [], connections: [] },
    { id: "openrouter", name: "OpenRouter", methods: [], connections: [credential] },
    { id: "github-copilot", name: "GitHub Copilot", methods: [], connections: [] },
    { id: "openai", name: "OpenAI", methods: [], connections: [{ type: "env", name: "OPENAI_API_KEY" }] },
    { id: "gitlab", name: "GitLab Duo", methods: [], connections: [{ type: "credential", id: "c4", label: "GitLab", method: "oauth" }] },
  ]);
  const authFile = opencode({
    anthropic: { type: "api", key: "sk-ant-1" },
    openrouter: { type: "api", key: "sk-or-1" },
    "github-copilot": { type: "oauth", refresh: "gho_1", access: "x", expires: 1 },
  });

  const what = await found({ engine, bridge, authFile });

  // Signed in: ready, with who it is. Installed but signed out: no label. Not installed: says so.
  expect(what.agents).toEqual([
    { id: "claude-code", name: "Claude Code", installed: true, signedIn: true, label: "you@example.com · Max plan" },
    { id: "grok-cli", name: "Grok", installed: true, signedIn: false },
    { id: "codex-cli", name: "Codex", installed: false, signedIn: false },
  ]);
  // Keys can come over; a sign-in that renews itself is offered as a sign-in; one the engine already
  // has needs nothing. Named as the engine names them.
  expect(what.opencode).toEqual([
    { id: "opencode:anthropic", integrationID: "anthropic", name: "Anthropic", kind: "key", connected: false },
    { id: "opencode:github-copilot", integrationID: "github-copilot", name: "GitHub Copilot", kind: "signIn", connected: false },
    { id: "opencode:openrouter", integrationID: "openrouter", name: "OpenRouter", kind: "key", connected: true },
  ]);
  expect(what.shell).toEqual([{ integrationID: "openai", name: "OpenAI", variable: "OPENAI_API_KEY" }]);
  // Signed in to through the engine already (a key, a plan): a key in the shell isn't a sign-in.
  expect(what.connected).toEqual(["openrouter", "gitlab"]);
  // No key leaves the box.
  expect(JSON.stringify(what)).not.toContain("sk-");
});

test("a plan whose sign-in has expired or failed isn't ready: only a working sign-in counts", async () => {
  // The engine marks a sign-in that stopped working (`needs_auth`); a working one has no status.
  const expired = (id: string) => ({ type: "credential", id, label: "GitHub", method: "oauth", status: { status: "needs_auth", message: "Sign in again" } });
  const engine = await serve([
    { id: "github-copilot", name: "GitHub Copilot", methods: [], connections: [expired("c2")] },
    { id: "gitlab", name: "GitLab Duo", methods: [], connections: [{ ...expired("c3"), status: { status: "expired", message: "Expired" } }] },
    { id: "openrouter", name: "OpenRouter", methods: [], connections: [credential] },
    // One that has stopped working next to one that works: the provider is still ready.
    { id: "anthropic", name: "Anthropic", methods: [], connections: [expired("c0"), credential] },
  ]);
  const what = await found({ engine, bridge: null, authFile: join(root, "none.json") });
  expect(what.connected).toEqual(["openrouter", "anthropic"]);
});

test("opencode's own sign-ins and keys are connected only when the engine's is working, not by a key in the shell", async () => {
  const expired = { type: "credential", id: "c2", label: "GitHub", method: "oauth", status: { status: "needs_auth", message: "Sign in again" } };
  const engine = await serve([
    { id: "github-copilot", name: "GitHub Copilot", methods: [], connections: [expired] },
    { id: "opencode", name: "OpenCode", methods: [], connections: [{ type: "env", name: "OPENCODE_API_KEY" }] },
    { id: "openrouter", name: "OpenRouter", methods: [], connections: [credential] },
  ]);
  const authFile = opencode({
    "github-copilot": { type: "oauth", refresh: "gho_1", access: "x", expires: 1 },
    opencode: { type: "api", key: "sk-zen-1" },
    openrouter: { type: "api", key: "sk-or-1" },
  });
  const what = await found({ engine, bridge: null, authFile });
  expect(what.opencode.map(item => [item.integrationID, item.connected])).toEqual([["github-copilot", false], ["opencode", false], ["openrouter", true]]);
});

test("a fresh computer: nothing to bring over, and nothing fails", async () => {
  // (The engine lists the providers it knows, none signed in.)
  const engine = await serve([{ id: "anthropic", name: "Anthropic", methods: [], connections: [] }]);
  const what = await found({ engine, bridge: await serve([]), authFile: join(root, "none.json") });
  expect(what).toEqual({ agents: [], opencode: [], shell: [], connected: [], unread: [] });
});

test("an engine that just started, listing what it has before its plugins are set up, is read once they are, and one that lists nothing yet is unread", async () => {
  const authFile = opencode({ "github-copilot": { type: "oauth", refresh: "gho_1", access: "x", expires: 1 } });
  const bridge = await serve([]);
  // (Copilot signed in, which a plugin of the engine's says.)
  const copilot = { id: "github-copilot", name: "GitHub Copilot", methods: [], connections: [{ type: "credential", id: "c1", label: "GitHub", method: "oauth" }] };
  const engine = await serve([copilot], [], [{ ...copilot, connections: [] }]);
  const what = await found({ engine, bridge, authFile });
  expect(what.unread).toEqual([]);
  expect(what.connected).toEqual(["github-copilot"]);
  // Nothing listed yet: not taken for nothing signed in.
  expect((await found({ engine: await serve([]), bridge, authFile })).unread).toEqual(["engine"]);
});

test("an engine or agents bridge that isn't running or doesn't answer is said to be unread, not taken for nothing signed in", async () => {
  const authFile = opencode({ openrouter: { type: "api", key: "sk-or-1" } });
  // Not running (restarting, stopped): nothing to ask.
  expect((await found({ engine: null, bridge: null, authFile })).unread).toEqual(["engine", "agents"]);
  // Running but answering with an error.
  const broken = http.createServer((_, response) => response.writeHead(500).end());
  servers.push(broken);
  await new Promise<void>((done) => broken.listen(0, "127.0.0.1", done));
  const failing = { port: (broken.address() as AddressInfo).port, password: "secret" };
  const bridge = await serve([agent("claude-code", "Claude Code", true, "you@example.com")]);
  const what = await found({ engine: failing, bridge, authFile });
  expect(what.unread).toEqual(["engine"]);
  expect(what.agents.map(each => each.id)).toEqual(["claude-code"]);
  // Both answering: everything was read.
  const engine = await serve([{ id: "openrouter", name: "OpenRouter", methods: [], connections: [credential] }]);
  expect((await found({ engine, bridge, authFile })).unread).toEqual([]);
});

test("with the engine and the agents not running yet, opencode's keys are still listed", async () => {
  const what = await found({ engine: null, bridge: null, authFile: opencode({ zai: { type: "api", key: "k-1" } }) });
  expect(what.agents).toEqual([]);
  expect(what.opencode).toEqual([{ id: "opencode:zai", integrationID: "zai", name: "zai", kind: "key", connected: false }]);
});

test("a well-known server's sign-in, named by its address, isn't offered", async () => {
  const authFile = opencode({ "https://ai.example.com": { type: "wellknown", key: "EXAMPLE_TOKEN", token: "t-1" }, zai: { type: "api", key: "k-1" } });
  expect((await found({ engine: null, bridge: null, authFile })).opencode.map(each => each.integrationID)).toEqual(["zai"]);
});

test("opencode's sign-ins are found in your own data folder, also on a machine whose box points it elsewhere", () => {
  expect(opencodeAuthFile("/home/ada", {})).toBe("/home/ada/.local/share/opencode/auth.json");
  expect(opencodeAuthFile("/home/ada", { XDG_DATA_HOME: "/data/ada" })).toBe("/data/ada/opencode/auth.json");
  // A machine's launch keeps yours aside (none set: the usual place) and points the box's into ~/.kuvo-code.
  expect(opencodeAuthFile("/home/ada", { XDG_DATA_HOME: "/home/ada/.kuvo-code/data", KUVO_OWN_XDG_DATA_HOME: "" })).toBe("/home/ada/.local/share/opencode/auth.json");
  expect(opencodeAuthFile("/home/ada", { XDG_DATA_HOME: "/home/ada/.kuvo-code/data", KUVO_OWN_XDG_DATA_HOME: "/data/ada" })).toBe("/data/ada/opencode/auth.json");
});

test("a damaged auth.json is nothing found, not an error", async () => {
  const file = ownAuthFile();
  writeFileSync(file, "{ not json");
  expect((await found({ engine: null, bridge: null, authFile: file })).opencode).toEqual([]);
});

test("Use brings an opencode key into the engine as the active one", async () => {
  const posted: unknown[] = [];
  const engine = await serve([], posted);
  const authFile = opencode({ anthropic: { type: "api", key: "sk-ant-1", metadata: { org: "o" } } });

  expect(await useFound("opencode:anthropic", { engine, authFile })).toEqual({ status: 200 });
  expect(posted).toEqual([{ integrationID: "anthropic", label: "API key", value: { type: "key", key: "sk-ant-1", metadata: { org: "o" } }, activate: true }]);
});

test("Use twice (a second tap, or the phone too) brings the key over once", async () => {
  const posted: unknown[] = [];
  const authFile = opencode({ anthropic: { type: "api", key: "sk-ant-1" } });
  expect(await useFound("opencode:anthropic", { engine: await serve([], posted), authFile })).toEqual({ status: 200 });
  const broughtOver = await serve([{ id: "anthropic", name: "Anthropic", methods: [], connections: [credential] }], posted);
  expect(await useFound("opencode:anthropic", { engine: broughtOver, authFile })).toEqual({ status: 200 });
  expect(posted.length).toBe(1);
});

test("a sign-in can't be copied over, and a key that's gone says so", async () => {
  const posted: unknown[] = [];
  const engine = await serve([], posted);
  const authFile = opencode({ "github-copilot": { type: "oauth", refresh: "r", access: "a", expires: 1 } });

  const signIn = await useFound("opencode:github-copilot", { engine, authFile });
  expect(signIn).toMatchObject({ status: 409 });
  const gone = await useFound("opencode:anthropic", { engine, authFile });
  expect(gone).toMatchObject({ status: 404 });
  expect(posted).toEqual([]);
});

test("the engine not running: Use says so", async () => {
  const authFile = opencode({ anthropic: { type: "api", key: "sk-ant-1" } });
  expect(await useFound("opencode:anthropic", { engine: null, authFile })).toMatchObject({ status: 503 });
});

