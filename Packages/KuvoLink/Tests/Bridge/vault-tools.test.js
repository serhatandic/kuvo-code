// The vault's tools as an agent on a machine has them (`kuvo-browser.js mcp`, the engine's MCP
// server there): listed in its box's own words, and carried out by its box (through `kuvo-link.js
// box route`, to the process that holds the vault). The real tool, the real box script and box, on
// a folder of the test's own; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/vault-tools.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sshAgentsOf } from "./bot-keys-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";
// (Each test fails at its own time limit when what it waits for never comes, rather than holding up the run.)
import { asked as askedAt, before, test } from "./vault-waits.js";

// (Short: the vault's socket is in it.)
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kvt-")));
// (Once the box and the tool have stopped: they write in its folder until they have.)
removeAtEnd(home);
removeAtEnd(sshAgentsOf(home));
atEnd(async () => {
  await Promise.all([box, mcp].map(child => child && child.exitCode === null && child.signalCode === null ? new Promise(done => { child.once("exit", done); child.kill(); }) : null));
});
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const tool = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));
const script = path.join(home, "bin", "kuvo-link.js");
write(script, fs.readFileSync(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url)));
const env = { ...process.env, KUVO_HOME: home, HOME: home, KUVO_VAULT_AGENTS: "1" };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX"]) delete env[name];

const TOKEN = "glpat-very-secret-token-0001";

// The engine: a bot's conversation, in its folder, and the tool call it's making now (the box
// answers a vault call only as one its conversation makes: vault/who.ts).
// Also its seat in a group chat, a conversation of its own the chat marks as the bot's; and a
// subagent whose parent the engine can't say just then. And a session the bot started for its work,
// in a project of yours, which the box marks as the bot's (`kuvo.by`).
const work = path.join(home, "work", "app");
const conversations = {
  ses_ship: { id: "ses_ship", title: "Ship", location: { directory: home } },
  ses_away: { id: "ses_away", title: "On Autopilot", location: { directory: home }, metadata: { kuvo: { autopilot: true } } },
  ses_seat: { id: "ses_seat", title: "Release chat", location: { directory: home }, metadata: { kuvo: { seat: { group: "grp_release", bot: "bot_ship" } } } },
  ses_sub: { id: "ses_sub", parentID: "ses_lost", title: "A subagent", location: { directory: home } },
  ses_work: { id: "ses_work", title: "Fix the release build", location: { directory: work }, metadata: { kuvo: { startedBy: "ses_ship", by: { bot: "bot_ship", name: "Ship" }, depth: 1 } } },
};
const calling = {};
let calls = 0;
const engine = http.createServer((request, response) => {
  const id = decodeURIComponent((request.url.match(/^\/api\/session\/([^/?]+)/) ?? [])[1] ?? "");
  if (/^\/api\/session\/[^/?]+\/message/.test(request.url) && conversations[id]) {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ data: [{ type: "assistant", content: calling[id] ?? [] }] }));
  }
  if (id === "ses_lost") {
    response.writeHead(500, { "content-type": "application/json" });
    return response.end(JSON.stringify({ message: "The engine is busy." }));
  }
  response.writeHead(conversations[id] ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(conversations[id] ? { data: conversations[id] } : { message: "No such session." }));
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p" }));
write(path.join(home, "bots", "bot_ship", "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_ship", name: "Ship" }));
write(path.join(home, "bots", "bot_ship", "session"), "ses_ship");

// The box's own process, which holds the vault, and a client of it (as this Mac's app reaches its own).
let box;
let client;
/** A request from something on this machine (the browser's fill), without a client's key. */
let local;
before(async () => {
  box = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  box.stdout.setEncoding("utf8");
  box.stderr.setEncoding("utf8");
  box.stderr.on("data", chunk => { err += chunk; });
  // (Its vault listens before it says where it is.)
  const url = await new Promise((resolve, reject) => {
    box.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]).url); });
    box.once("exit", code => reject(new Error(`serve exited ${code}: ${err}`)));
  });
  client = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers: { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json", "x-kuvo-from": "app" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  local = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers: { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  asksURL = `${url}/kuvo/vault/asks/events`;
});
let asksURL;

// The tool, as the engine starts it, and its calls, as the engine makes them.
const mcp = spawn(process.execPath, [tool, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
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
const running = (session, name, input) => { calling[session] = [{ type: "tool", id: `call_${++calls}`, name: `kuvo-browser_${name}`, state: { status: "running", input: input ?? {} } }]; };
const call = (name, args, session = "ses_ship") => {
  running(session, name, args);
  return ask("tools/call", { name, arguments: args, _meta: { "ai.opencode/sessionID": session } });
};
/** What the box asks you, once it asks something new (its asks as a client follows them). */
const asked = (seen = new Set()) => askedAt(asksURL, "box-pw", seen);
/** `asked`, or a failure if `running` ends first (it ran, or gave up, without asking). */
const askedBefore = (running, seen) => Promise.race([asked(seen), running.then(ran => assert.fail(`It didn't ask: ${ran.content?.[0]?.text ?? JSON.stringify(ran)}`))]);

test("an agent on a machine lists the vault's tools, in its box's words", async () => {
  const { tools } = await ask("tools/list", {});
  assert.deepEqual(tools.map(each => each.name).filter(name => name.startsWith("vault_")), ["vault_items", "vault_ask", "vault_run"]);
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

test("a session its bot started for its work is the bot's: it uses what the bot may, Always gives it to the bot, and the bot's pause holds it", async () => {
  const build = (await client("POST", "kuvo/vault/items", { kind: "key", name: "Build token", sites: [], values: { token: "build-secret-0006" } })).value.item;
  assert.equal((await client("POST", "kuvo/vault/grants", { item: build.id, who: { bot: "bot_ship" }, how: "own" })).status, 200);
  const using = call("vault_run", { command: "echo \"using $T\"", variables: { T: "Build token" }, why: "To build the release." }, "ses_work");
  const ran = await Promise.race([using, asked().then(([card]) => assert.fail(`It asked you, as ${card.botName ?? "no bot"}, for what its bot may use on its own.`))]);
  assert.equal(ran.isError, false, ran.content[0].text);
  assert.ok((await client("GET", "kuvo/vault/activity")).value.entries.some(entry => entry.what === "used" && entry.botName === "Ship" && entry.session === "ses_work"));
  // What it asks for is the bot's ask, and Always lets the bot use it, not everyone in the project.
  const signing = (await client("POST", "kuvo/vault/items", { kind: "key", name: "Signing key", sites: [], values: { token: "signing-secret-0007" } })).value.item;
  const asking = call("vault_run", { command: "echo signed", variables: { T: "Signing key" }, why: "To sign the build." }, "ses_work");
  const [card] = await askedBefore(asking);
  assert.equal(card.botName, "Ship");
  assert.equal((await client("POST", `kuvo/vault/asks/${card.id}`, { answer: "always" })).status, 200);
  assert.equal((await asking).isError, false);
  const given = (await client("GET", "kuvo/vault")).value.grants.filter(grant => grant.item === signing.id);
  assert.deepEqual(given.map(grant => grant.who), [{ bot: "bot_ship" }]);
  // Paused for the bot, it can't use the vault in its work either.
  assert.equal((await client("POST", "kuvo/vault/pause", { paused: true, bot: "bot_ship" })).status, 200);
  const held = await call("vault_run", { command: "echo again", variables: { T: "Build token" }, why: "Once more." }, "ses_work");
  assert.equal(held.isError, true);
  assert.match(held.content[0].text, /paused this bot's use of the vault/);
  assert.equal((await client("POST", "kuvo/vault/pause", { paused: false, bot: "bot_ship" })).status, 200);
});

test("a bot deleted (or gone from this computer) isn't shown as able to use what it could, nor as paused", async () => {
  write(path.join(home, "bots", "bot_temp", "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_temp", name: "Temp" }));
  write(path.join(home, "bots", "bot_temp", "session"), "ses_temp");
  const report = (await client("POST", "kuvo/vault/items", { kind: "key", name: "Report key", sites: [], values: { token: "report-secret-0008" } })).value.item;
  assert.equal((await client("POST", "kuvo/vault/grants", { item: report.id, who: { bot: "bot_temp" }, how: "own" })).status, 200);
  const whoFor = async () => (await client("GET", "kuvo/vault")).value.grants.filter(grant => grant.item === report.id).map(grant => grant.who);
  assert.deepEqual(await whoFor(), [{ bot: "bot_temp" }]);
  assert.equal((await client("POST", "kuvo/vault/pause", { paused: true, bot: "bot_temp" })).status, 200);
  fs.rmSync(path.join(home, "bots", "bot_temp"), { recursive: true, force: true });
  assert.deepEqual(await whoFor(), [], "no one may use it now");
  assert.deepEqual((await client("GET", "kuvo/vault/grants")).value.grants.filter(grant => grant.item === report.id), []);
  assert.equal((await client("GET", "kuvo/vault")).value.state.pausedBots.bot_temp, undefined, "nor shown paused");
});

test("its seat in a group chat asks you each time, whatever it may use on its own, and never for good", async () => {
  const deploy = (await client("POST", "kuvo/vault/items", { kind: "key", name: "Deploy key", sites: [], values: { token: "deploy-secret-0002" } })).value.item;
  assert.equal((await client("POST", "kuvo/vault/grants", { item: deploy.id, who: { everyone: true }, how: "own" })).status, 200);
  const release = (await client("POST", "kuvo/vault/items", { kind: "key", name: "Release token", sites: [], values: { token: "release-secret-0003" } })).value.item;
  assert.equal((await client("POST", "kuvo/vault/grants", { item: release.id, who: { bot: "bot_ship" }, how: "own" })).status, 200);
  const grants = (await client("GET", "kuvo/vault")).value.grants.length;
  const listed = (await call("vault_items", {}, "ses_seat")).content[0].text;
  assert.match(listed, /“Release token”: a key; the user is asked each time/);
  assert.match(listed, /“Deploy key”: a key; the user is asked each time/);
  const running = call("vault_run", { command: "echo \"using $T\"", variables: { T: "Deploy key" }, why: "To deploy." }, "ses_seat");
  const [card] = await askedBefore(running);
  assert.equal(card.kind, "use");
  assert.equal(card.botName, "Ship");
  assert.equal(card.session, "ses_seat");
  assert.equal(card.group, "grp_release");
  // An Always (from a client that doesn't know) is this once.
  assert.equal((await client("POST", `kuvo/vault/asks/${card.id}`, { answer: "always" })).status, 200);
  const ran = await running;
  assert.equal(ran.isError, false, ran.content[0].text);
  assert.match(ran.content[0].text, /using \[vault: Deploy key\]/);
  assert.equal((await client("GET", "kuvo/vault")).value.grants.length, grants);
  const again = call("vault_run", { command: "echo again", variables: { T: "Release token" }, why: "Once more." }, "ses_seat");
  const [next] = await askedBefore(again, new Set([card.id]));
  assert.equal(next.group, "grp_release");
  assert.equal((await client("POST", `kuvo/vault/asks/${next.id}`, { answer: "no" })).status, 200);
  assert.match((await again).content[0].text, /didn't let you use “Release token”/);
});

test("what its seat asks you for is given once, even given for good", async () => {
  const notes = (await client("POST", "kuvo/vault/items", { kind: "note", name: "Release notes key", values: { text: "notes-secret-0005" } })).value.item;
  const grants = (await client("GET", "kuvo/vault")).value.grants.length;
  const asking = call("vault_ask", { need: "The release notes key", why: "To publish them." }, "ses_seat");
  const [card] = await askedBefore(asking);
  assert.equal(card.kind, "item");
  assert.equal(card.group, "grp_release");
  assert.equal((await client("POST", `kuvo/vault/asks/${card.id}`, { answer: "always", item: notes.id })).status, 200);
  assert.equal((await asking).isError, false);
  assert.equal((await client("GET", "kuvo/vault")).value.grants.length, grants, "no grant: a seat's is once");
  // Its next use goes ahead, as given once; the one after asks again.
  const used = await call("vault_run", { command: "echo \"using $T\"", variables: { T: "Release notes key" }, why: "To publish them." }, "ses_seat");
  assert.equal(used.isError, false, used.content[0].text);
  const again = call("vault_run", { command: "echo again", variables: { T: "Release notes key" }, why: "Once more." }, "ses_seat");
  const [next] = await askedBefore(again, new Set([card.id]));
  assert.equal((await client("POST", `kuvo/vault/asks/${next.id}`, { answer: "no" })).status, 200);
  assert.match((await again).content[0].text, /didn't let you use “Release notes key”/);
});

test("its seat signs in with a sign-in it could use on its own only once you say so, in the chat", async () => {
  const login = (await client("POST", "kuvo/vault/items", { kind: "login", name: "Staging", sites: ["staging.example.com"], username: "ship", values: { password: "staging-pw-0004" } })).value.item;
  assert.equal((await client("POST", "kuvo/vault/grants", { item: login.id, who: { everyone: true }, how: "own" })).status, 200);
  running("ses_seat", "browser_sign_in");
  const filling = local("POST", "kuvo/vault/fill", { session: "ses_seat", origin: "https://staging.example.com", purpose: "sign-in" });
  const [card] = await Promise.race([asked(), filling.then(filled => assert.fail(`It didn't ask: ${filled.status} ${JSON.stringify(filled.value)}`))]);
  assert.equal(card.group, "grp_release");
  assert.equal(card.itemName, "Staging");
  assert.equal((await client("POST", `kuvo/vault/asks/${card.id}`, { answer: "once" })).status, 200);
  const filled = await filling;
  assert.equal(filled.status, 200, JSON.stringify(filled.value));
  assert.equal(filled.value.values.password, "staging-pw-0004");
});

test("on Autopilot a command needing an item it can't use on its own isn't a failed step: it runs nothing, asks nothing and says what's left", async () => {
  assert.equal((await client("POST", "kuvo/vault/items", { kind: "key", name: "Release key", sites: [], values: { token: "release-secret-0009" } })).status, 200);
  const ran = await call("vault_run", { command: "echo \"using $T\"", variables: { T: "Release key" }, why: "To upload." }, "ses_away");
  assert.equal(ran.isError, false, ran.content[0].text);
  assert.match(ran.content[0].text, /This is on Autopilot: nothing was put to the user/);
  assert.deepEqual((await client("GET", "kuvo/vault/asks")).value.asks ?? [], []);
  const activity = (await client("GET", "kuvo/vault/activity")).value.entries;
  assert.ok(activity.some(each => each.what === "refused" && each.itemName === "Release key" && each.how === "autopilot"), JSON.stringify(activity.slice(-3)));
});

test("a conversation whose root the engine can't say just then asks you, whatever everyone may use", async () => {
  // (“Deploy key”: everyone's to use on their own, from the test before.)
  const running = call("vault_run", { command: "echo \"using $T\"", variables: { T: "Deploy key" }, why: "To deploy." }, "ses_sub");
  const [card] = await askedBefore(running);
  assert.equal(card.itemName, "Deploy key");
  assert.equal(card.group, undefined);
  assert.equal((await client("POST", `kuvo/vault/asks/${card.id}`, { answer: "no" })).status, 200);
  assert.match((await running).content[0].text, /didn't let you use “Deploy key”/);
});
