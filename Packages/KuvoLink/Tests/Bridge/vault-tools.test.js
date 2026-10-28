// The vault's tools as an agent on a machine has them (`kuvo-browser.js mcp`, the engine's MCP
// server there): listed in its box's own words, and carried out by its box (through `kuvo-link.js
// box route`, to the process that holds the vault). The real tool, the real box script and box, on
// a folder of the test's own; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/vault-tools.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// (Short: the vault's socket is in it.)
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kvt-")));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const tool = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));
const script = path.join(home, "bin", "kuvo-link.js");
write(script, fs.readFileSync(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url)));
const env = { ...process.env, KUVO_HOME: home, HOME: home };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX"]) delete env[name];

const TOKEN = "glpat-very-secret-token-0001";

// The engine: a bot's conversation, in its folder.
const engine = http.createServer((request, response) => {
  const found = request.url.match(/^\/api\/session\/(ses_ship)$/);
  response.writeHead(found ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(found ? { data: { id: "ses_ship", title: "Ship", location: { directory: home } } } : { message: "No such session." }));
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
after(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p" }));
write(path.join(home, "bots", "bot_ship", "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_ship", name: "Ship" }));
write(path.join(home, "bots", "bot_ship", "session"), "ses_ship");

// The box's own process, which holds the vault, and a client of it (as this Mac's app reaches its own).
let box;
let client;
before(async () => {
  box = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  box.stdout.setEncoding("utf8");
  const url = await new Promise(resolve => box.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]).url); }));
  for (let tries = 0; tries < 100 && !fs.existsSync(path.join(home, "run", "vault.sock")); tries++) await new Promise(done => setTimeout(done, 20));
  client = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers: { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json", "x-kuvo-from": "app" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
});
after(() => box?.kill());

// The tool, as the engine starts it, and its calls, as the engine makes them.
const mcp = spawn(process.execPath, [tool, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
after(() => mcp.kill());
const answers = new Map();
let buffer = "";
mcp.stdout.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    answers.get(message.id)?.(message.result);
  }
});
let next = 1;
function ask(method, params) {
  const id = next++;
  return new Promise(resolve => {
    answers.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = (name, args) => ask("tools/call", { name, arguments: args, _meta: { "ai.opencode/sessionID": "ses_ship" } });

test("an agent on a machine lists the vault's tools, in its box's words", async () => {
  const { tools } = await ask("tools/list", {});
  assert.deepEqual(tools.map(each => each.name), ["vault_items", "vault_ask", "vault_run"]);
  assert.ok(tools.every(each => each.description && each.inputSchema?.type === "object"));
});

test("its bot uses what it's granted, through its box, and never sees a value", async () => {
  const added = await client("POST", "kuvo/vault/items", { kind: "key", name: "GitLab token", sites: ["gitlab.com"], values: { token: TOKEN } });
  assert.equal(added.status, 200);
  const before = await call("vault_items", {});
  assert.match(before.content[0].text, /You may use nothing in the vault yet/);
  assert.equal((await client("POST", "kuvo/vault/grants", { item: added.value.item.id, who: { bot: "bot_ship" }, how: "own" })).status, 200);
  assert.match((await call("vault_items", {})).content[0].text, /“GitLab token”: a key on gitlab\.com; yours to use/);
  const ran = await call("vault_run", { command: "echo \"using $T\"", variables: { T: "GitLab token" }, why: "To list the merge requests." });
  assert.equal(ran.isError, false, ran.content[0].text);
  assert.match(ran.content[0].text, /using \[vault: GitLab token\]/);
  assert.ok(!JSON.stringify(ran).includes(TOKEN));
  const activity = (await client("GET", "kuvo/vault/activity")).value.entries;
  assert.ok(activity.some(entry => entry.what === "used" && entry.botName === "Ship" && entry.program === "echo"));
});
