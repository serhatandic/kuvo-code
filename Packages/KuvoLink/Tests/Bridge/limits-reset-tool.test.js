// An agent uses one of your plans' rate-limit resets (use_limit_reset, PROTOCOL.md "Plan limits",
// "Resets"): every use asks you first, on the permission card in its conversation (Allow, Always
// Allow for this account, Don't), and goes through the coding agents' bridge once you allow it;
// Always Allow is kept with the account, and from then on that account's resets are used without
// asking. Nothing is used without one of the two. Each call by a process of its own, as a
// machine's tools ask it (`kuvo-link.js box route`). The real box script on a folder of the test's
// own; the engine and the coding agents' bridge are stand-ins, the bridge counting what it spends.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/limits-reset-tool.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { runningAs } from "./running-as.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-limits-reset-tool-")));
removeAtEnd(home);
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const serve = handle => {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      handle(request, new URL(request.url, "http://x"), body ? JSON.parse(body) : undefined, reply);
    });
  });
  return server;
};

// The engine: Mira's conversation.
const mira = { id: "ses_mira", title: "Mira", location: { directory: home }, permissions: [], time: { created: 1, updated: 5 } };
const engine = serve((request, url, _body, reply) => {
  if (url.pathname === "/api/session" && request.method === "GET") return reply({ data: url.searchParams.get("parentID") && url.searchParams.get("parentID") !== "null" ? [] : [mira] });
  if (url.pathname === "/api/session/active") return reply({ data: {} });
  if (url.pathname === "/api/session/ses_mira" && request.method === "GET") return reply({ data: mira });
  reply({ message: "Not here." }, 404);
});

// The coding agents' bridge: the accounts' rows, and their resets as its routes answer them.
const ROW = "codex#0123456789abcdef";
let left, always, spent, alwaysSet, asked;
const row = () => ({
  id: ROW, provider: "codex-cli", service: "codex", agent: "codex", account: "default", plan: "Plus",
  windows: [{ id: "primary", used: spent ? 0 : 0.97, minutes: 300, resetsAt: Date.now() + 3_600_000, read: Date.now(), source: "usage" }],
  extras: [{ id: "resets", name: "Rate Limit Resets", kind: "resets", count: left, usable: left > 0, ...(always ? { agents: true } : {}), on: { key: "", name: "", here: true } }],
  boxes: [{ key: "", name: "", provider: "codex-cli", agent: "codex", account: "default", here: true }],
});
const claude = { id: "claude#fedcba9876543210", provider: "claude-code", service: "claude", agent: "claude", account: "default", windows: [], boxes: [] };
const bridge = serve((request, url, body, reply) => {
  if (url.pathname === "/api/kuvo/limits" && request.method === "GET") return reply({ data: { accounts: [], services: ["codex"], rows: [row(), claude] } });
  if (url.pathname === "/api/kuvo/limits/reset" && request.method === "POST") {
    if (body.row !== ROW) return reply({ message: "This account has no resets." }, 409);
    if (body.confirm === undefined) {
      asked++;
      return reply({ data: { confirm: `rsc_${asked}`, row: ROW, service: "codex", count: left, on: { key: "", name: "", here: true }, always, expires: Date.now() + 600_000 } });
    }
    spent++;
    left--;
    return reply({ data: { outcome: "reset", row: row() } });
  }
  if (url.pathname === "/api/kuvo/limits/reset/always" && request.method === "PUT") {
    alwaysSet.push(body);
    always = body.always;
    return reply({ data: {} });
  }
  reply({ message: "Not here." }, 404);
});
for (const server of [engine, bridge]) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
}

beforeEach(() => {
  left = 2; always = false; spent = 0; alwaysSet = []; asked = 0;
  for (const each of ["box", "run"]) fs.rmSync(path.join(home, each), { recursive: true, force: true });
  write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));
});

// The box's answer to one request, as a machine's tool asks it: a process of its own.
function route(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries({ ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home }).filter(([, value]) => value !== undefined));
    const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
}
const tool = async args => (await route("POST", "kuvo/agent-tools", { name: "use_limit_reset", arguments: args, session: "ses_mira" })).body;
// What's asked of you now, once there's something (a client follows them; this looks again).
async function asks() {
  for (;;) {
    const { body } = await route("GET", "kuvo/work/asks");
    if (body.asks.length) return body.asks;
  }
}
const bridgeRuns = async t => {
  write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridge.address().port, password: "b", pid: await runningAs("kuvo-agents", t) }));
  t.after(() => fs.rmSync(path.join(home, "run", "bridge.json"), { force: true }));
};

test("using a reset asks the user on the card first: the account, how many it has; allowed, one is used, and the agent hears the account's limits after", async t => {
  await bridgeRuns(t);
  const using = tool({ account: "Codex" });
  const [ask] = await asks();
  assert.equal(ask.action, "resetLimits");
  assert.equal(ask.name, "Mira");
  assert.equal(ask.session, "ses_mira");
  assert.equal(ask.project, "Codex");
  assert.equal(ask.folder, null);
  assert.deepEqual(ask.reset, { row: ROW, account: "Codex", service: "codex", count: 2 });
  // Asked, nothing's used.
  assert.equal(spent, 0);

  const answered = await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow" });
  assert.equal(answered.status, 200);
  const said = await using;
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /^Used one of Codex's rate-limit resets: its limits started over\./);
  assert.match(said.text, /5-hour window: 0% used/);
  assert.match(said.text, /rate-limit resets: 1 available/);
  assert.equal(spent, 1);
  assert.deepEqual(alwaysSet, [], "this once only");
  assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, []);

  // Asked again: the card again.
  const again = tool({ account: ROW });
  const [next] = await asks();
  assert.equal(next.reset.count, 1);
  await route("POST", `kuvo/work/asks/${next.id}`, { answer: "allow" });
  assert.equal((await again).isError, false);
  assert.equal(spent, 2);
});

test("Don't: nothing is used, and the agent hears the user said no", async t => {
  await bridgeRuns(t);
  const using = tool({ account: "codex" });
  const [ask] = await asks();
  await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "deny" });
  const said = await using;
  assert.equal(said.isError, true);
  assert.match(said.text, /The user said no to using one of Codex's resets/);
  assert.equal(spent, 0);
});

test("Always Allow for this account is kept with the account, and its next reset is used without asking; nothing else is", async t => {
  await bridgeRuns(t);
  const using = tool({ account: "Codex" });
  const [ask] = await asks();
  await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "always" });
  assert.equal((await using).isError, false);
  assert.deepEqual(alwaysSet, [{ row: ROW, always: true }]);
  assert.equal(spent, 1);

  // The next: no card, used at once.
  const said = await tool({ account: "Codex" });
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /^Used one of Codex's rate-limit resets/);
  assert.equal(spent, 2);
  assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, []);
});

test("an account without resets, one that isn't there, or no account named: refused, nothing asked or used", async t => {
  await bridgeRuns(t);
  const none = await tool({ account: "Claude Code" });
  assert.equal(none.isError, true);
  assert.match(none.text, /No account of the user's is called Claude Code\. Those with resets:\n- Codex: account "codex#0123456789abcdef"/);
  assert.equal((await tool({ account: "Nope" })).isError, true);
  assert.match((await tool({})).text, /Say which account/);
  assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, []);
  assert.equal(spent, 0);
});

test("without the coding agents' bridge running, nothing can be used, and it says so", async () => {
  const said = await tool({ account: "Codex" });
  assert.equal(said.isError, true);
  assert.match(said.text, /The coding agents aren't running/);
});
