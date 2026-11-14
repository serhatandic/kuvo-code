// Move to Computer with a coding agent (PROTOCOL.md, `kuvo/moves`): a bot or chat that talks with
// Claude Code goes with the conversation Claude Code keeps, and comes back the same. This Mac's box
// is `serve`'s link, here; the machine is `kuvo-link.js run`, a process of its own; each has the real
// agents bridge (`kuvo-agents.js`, on Bun), with Claude Code's folder of its own. Only the relay and
// the engines are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/moves-lanes.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";
import { standInClaude } from "./claude-stand-in.js";
import { relayStandIn } from "./relay-stand-in.js";

const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const bridgeScript = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-agents.js", import.meta.url));
const bun = testBun();
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-move-lanes-")));
removeAtEnd(support);

// Each computer's folders.
const box = name => {
  const root = path.join(support, name);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  return { root, home, agents: path.join(root, "agents"), claude: path.join(root, "claude"), bots: name === "mac" ? path.join(root, "bots") : path.join(home, "bots"), wakes: name === "mac" ? path.join(root, "wakes") : path.join(home, "wakes"), chats: name === "mac" ? path.join(root, "Chats") : path.join(home, "chats") };
};
const mac = box("mac"), lab = box("lab");

let signal;
function eventually(found) {
  return new Promise((resolve, reject) => {
    const look = async () => {
      const value = await found();
      if (!value) return;
      clearInterval(timer);
      resolve(value);
    };
    const timer = setInterval(() => look().catch(() => {}), 25);
    signal?.addEventListener("abort", () => {
      clearInterval(timer);
      reject(new Error(`it never got there: ${found}`));
    }, { once: true });
  });
}

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
};
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const slug = directory => directory.replace(/[^a-zA-Z0-9]/g, "-");
const conversation = crypto.randomUUID.bind(crypto);

// An engine with no conversations: nothing here runs on it.
async function emptyEngine() {
  const server = http.createServer((request, response) => {
    const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    if (request.url === "/api/session/active") return send(200, {});
    if (request.url === "/api/model") return send(200, []);
    if (request.url.startsWith("/api/session/")) return send(404, null);
    return send(200, []);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, password: "pw" };
}

// A real agents bridge, signed in as far as where it keeps conversations goes. Its sessions are read
// as it starts; `seed` writes them before.
const running = new Map();
async function startBridge(which) {
  // (A Mac without a token of its own keeps a Console sign-in's folder; this one has its CLAUDE_CONFIG_DIR.)
  write(path.join(which.agents, "claude", "tokens", "default.json"), { token: "stand-in" });
  // Claude Code there, signed in (a move checks that first), listing its models, never a turn. Its
  // `default` is Opus on the Mac and Sonnet on the machine (as on two accounts of different plans).
  const claudeBin = standInClaude({ root: which.root, agents: which.agents, stands: which === mac ? "opus" : "sonnet" });
  const child = spawn(bun, [bridgeScript], {
    env: {
      PATH: `${claudeBin}:${process.env.PATH}`, HOME: which.root, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      KUVO_AGENTS_HOME: which.agents, OPENCODE_PASSWORD: "pw", CLAUDE_CONFIG_DIR: which.claude,
      KUVO_GROUPS: path.join(which.root, "groups"), KUVO_BOTS: which.bots, KUVO_TRASH: path.join(which.home, "trash"), KUVO_ARTIFACTS: path.join(which.root, "artifacts"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", chunk => {
      out += chunk;
      const line = out.split("\n").find(each => each.startsWith("{"));
      if (line) resolve(Number(new URL(JSON.parse(line).url).port));
    });
    child.once("exit", status => reject(new Error(`the agents bridge stopped (${status})`)));
  });
  child.removeAllListeners("exit");
  running.set(which, child);
  write(path.join(which.home, "run", "bridge.json"), { port, password: "pw", pid: child.pid });
  return port;
}
atEnd(async () => {
  for (const child of running.values()) {
    const gone = new Promise(resolve => child.once("exit", resolve));
    child.stdin.end();
    child.kill("SIGTERM");
    await gone;
  }
});

const asks = (which, method, route, given) => {
  const { port } = JSON.parse(fs.readFileSync(path.join(which.home, "run", "bridge.json"), "utf8"));
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}`, ...(given ? { "content-type": "application/json" } : {}) },
    body: given ? JSON.stringify(given) : undefined,
  }).then(async response => ({ status: response.status, json: await response.json().catch(() => null) }));
};
const sessionThere = async (which, id) => (await asks(which, "GET", `/api/session/${id}`)).status === 200;
const agentState = (which, id) => {
  try { return JSON.parse(fs.readFileSync(path.join(which.agents, "sessions", id, "agent.json"), "utf8")); } catch { return null; }
};
const messagesOf = (which, id) => JSON.parse(fs.readFileSync(path.join(which.agents, "sessions", id, "messages.json"), "utf8"));

const messages = (id, text) => [{ id: `msg_${id}`, sessionID: id, type: "user", text, time: { created: 1 } }, { id: `msg_${id}x`, type: "idle", outcome: "succeeded", time: { created: 2 } }];

// A session on `which`'s bridge, as a Claude Code conversation that ran there: written as the bridge
// keeps it, so it must be called before the bridge starts, or the bridge told to read it again.
function seedSession(which, id, directory, claudeID, { metadata, seen = `msg_${id}`, provider = "claude-code" } = {}) {
  const folder = path.join(which.agents, "sessions", id);
  write(path.join(folder, "session.json"), {
    id, projectID: "prj_x", model: { id: "default", providerID: provider }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, title: id, location: { directory }, ...(metadata ? { metadata } : {}),
  });
  write(path.join(folder, "messages.json"), messages(id, "Remember the deploy."));
  write(path.join(folder, "agent.json"), { threads: { [provider]: { state: { claudeSession: claudeID, claudeStarted: true }, seen } } });
}

// What Claude Code keeps of that conversation in its folder.
function seedClaude(which, directory, claudeID, { lines = ['{"type":"user"}\n'], memory = { "MEMORY.md": "Deploys on Fridays.\n", "notes/deploy.md": "On Fridays.\n" }, beside = true } = {}) {
  const folder = path.join(which.claude, "projects", slug(directory));
  const file = path.join(folder, `${claudeID}.jsonl`);
  write(file, lines.join(""));
  if (beside) write(path.join(folder, claudeID, "tool-results", "one.txt"), "a long output\n");
  for (const [name, text] of Object.entries(memory ?? {})) write(path.join(folder, "memory", name), text);
  return { folder, file };
}

function seedBot(which, bot, session) {
  const folder = path.join(which.bots, bot);
  write(path.join(folder, "bot.json"), { kuvo: 1, id: bot, name: bot, model: { id: "default", providerID: "claude-code" } });
  write(path.join(folder, "session"), `${session}\n`);
  write(path.join(folder, "via"), "bridge\n");
  write(path.join(folder, "MEMORY.md"), "Its own memory file.\n");
  fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
  return path.join(folder, "workspace");
}

// Those seeded before the boxes start.
const adaClaude = conversation();
const adaWork = seedBot(mac, "bot_ada", "ses_ada");
seedSession(mac, "ses_ada", adaWork, adaClaude, { metadata: { kuvo: { bot: "bot_ada" } } });
seedSession(mac, "ses_adasub", adaWork, conversation(), {});
{
  const said = path.join(mac.agents, "sessions", "ses_adasub", "session.json");
  write(said, { ...JSON.parse(fs.readFileSync(said, "utf8")), parentID: "ses_ada" });
}
const ada = seedClaude(mac, adaWork, adaClaude, { lines: ['{"type":"user","cwd":"/old/place"}\n', '{"type":"assistant"}\n'] });

const chatClaude = conversation();
seedSession(mac, "ses_chat", mac.chats, chatClaude);
const chat = seedClaude(mac, mac.chats, chatClaude, { memory: { "MEMORY.md": "From the Mac.\n", "only-mac.md": "Mine.\n" } });
fs.mkdirSync(mac.chats, { recursive: true });

// A chat whose ID a conversation on the machine has too (as a buggy or copied box might send), that
// one paused there with its queue.
seedSession(mac, "ses_twin", mac.chats, conversation());
seedSession(lab, "ses_twin", lab.chats, conversation());
write(path.join(lab.home, "run", "queues.json"), { ses_twin: { paused: true, held: [] } });

// A chat the machine's Chats has memory of its own for.
seedClaude(lab, lab.chats, conversation(), { memory: { "MEMORY.md": "From the machine.\n" }, beside: false });

const bigClaude = conversation();
const bigWork = seedBot(mac, "bot_big", "ses_big");
seedSession(mac, "ses_big", bigWork, bigClaude, { metadata: { kuvo: { bot: "bot_big" } } });
// More than 100 MB that hardly packs (random, in lines), as a long conversation with pictures does.
const BIG = 110 * 1_000_000;
const big = seedClaude(mac, bigWork, bigClaude, { lines: [], memory: Object.fromEntries(Array.from({ length: 150 }, (_, at) => [`topic-${at}.md`, `Topic ${at}\n`])) });
{
  const handle = fs.openSync(big.file, "w");
  for (let written = 0; written < BIG;) {
    const line = `${crypto.randomBytes(750).toString("base64")}\n`;
    fs.writeSync(handle, line);
    written += line.length;
  }
  fs.closeSync(handle);
}

// A bot on a second Claude Code account the Mac has (signed in with a token of its own); the
// machine has only its own.
write(path.join(mac.agents, "accounts.json"), [{ kind: "claude", id: "work", label: "Work" }]);
write(path.join(mac.agents, "claude", "tokens", "work.json"), { token: "stand-in" });
const workClaude = conversation();
const workWork = seedBot(mac, "bot_work", "ses_work");
write(path.join(mac.bots, "bot_work", "bot.json"), { kuvo: 1, id: "bot_work", name: "bot_work", model: { id: "default", providerID: "claude-code@work" } });
seedSession(mac, "ses_work", workWork, workClaude, { metadata: { kuvo: { bot: "bot_work" } }, provider: "claude-code@work" });
const work = seedClaude({ claude: path.join(mac.agents, "claude", "accounts", "work") }, workWork, workClaude);

// A bot whose folder has a link in it to a file in it (a tool's, as npm makes them), which goes as
// it is, and one with a link out of its folder, which no computer takes.
const linkClaude = conversation();
const linkWork = seedBot(mac, "bot_link", "ses_link");
// Its own model isn't its conversation's (you changed one of them): it keeps its own as it moves.
write(path.join(mac.bots, "bot_link", "bot.json"), { kuvo: 1, id: "bot_link", name: "bot_link", model: { id: "sonnet", providerID: "claude-code" } });
seedSession(mac, "ses_link", linkWork, linkClaude, { metadata: { kuvo: { bot: "bot_link" } } });
seedClaude(mac, linkWork, linkClaude);
fs.mkdirSync(path.join(linkWork, "tools", "bin"), { recursive: true });
write(path.join(linkWork, "tools", "cli.js"), "console.log(1)\n");
fs.symlinkSync("../cli.js", path.join(linkWork, "tools", "bin", "cli"));
const outClaude = conversation();
const outWork = seedBot(mac, "bot_out", "ses_out");
seedSession(mac, "ses_out", outWork, outClaude, { metadata: { kuvo: { bot: "bot_out" } } });
seedClaude(mac, outWork, outClaude);
fs.mkdirSync(path.join(outWork, "tools", "bin"), { recursive: true });
write(path.join(mac.bots, "shared.js"), "console.log(2)\n");
fs.symlinkSync("../../../../shared.js", path.join(outWork, "tools", "bin", "cli"));

const dropClaude = conversation();
const dropWork = seedBot(mac, "bot_drop", "ses_drop");
seedSession(mac, "ses_drop", dropWork, dropClaude, { metadata: { kuvo: { bot: "bot_drop" } } });
const dropped = seedClaude(mac, dropWork, dropClaude, { lines: [] });
{
  const handle = fs.openSync(dropped.file, "w");
  for (let written = 0; written < 8_000_000;) written += fs.writeSync(handle, `${crypto.randomBytes(750).toString("base64")}\n`);
  fs.closeSync(handle);
}

const app = { keys: null };
const appHost = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (request.url === "/hello") {
    const proof = crypto.createHmac("sha256", "host-password").update(`kuvo-host-hello\u0000${given.nonce}\u0000127.0.0.1:${appHost.address().port}`).digest("hex");
    return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof }));
  }
  if (request.headers.authorization !== "Bearer host-password") return response.writeHead(401).end();
  if (request.url === "/link/identity") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(app.keys));
  if (request.url === "/link/route") return response.writeHead(404, { "content-type": "application/json", "x-kuvo-answer": "1" }).end("{}");
  if (request.url === "/keys/names") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ names: [] }));
  response.writeHead(404).end();
});
await new Promise(resolve => appHost.listen(0, "127.0.0.1", resolve));
atEnd(() => { appHost.closeAllConnections(); appHost.close(); });

Object.assign(process.env, {
  KUVO_HOME: mac.home, KUVO_BOTS: mac.bots, KUVO_WAKES: mac.wakes, KUVO_BOX: "mac",
  KUVO_CHATS: mac.chats,
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"), KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`, KUVO_HOST_PASSWORD: "host-password",
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const relay = await relayStandIn(link, { changed: () => {} });
const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const macAddress = link.publicOf(macKey).toString("base64url");
app.keys = { key: macKey.toString("base64url"), secret: macSecret.toString("base64url"), sign: link.newSigningSeed() };
link.macLink.hold = link.macNoticeHold();
const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, link.macLink.hold);
async function ask(method, p, given) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: given ? Buffer.from(JSON.stringify(given)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json };
}
const machineEnv = () => ({ PATH: process.env.PATH, HOME: lab.root, KUVO_HOME: lab.home, ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) });
async function askMachine(method, p, given) {
  const child = spawn(process.execPath, [script, "box", "route"], { env: machineEnv(), stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end(JSON.stringify({ method, path: p, ...(given ? { body: given } : {}) }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  return { status: answer.status, json: JSON.parse(answer.body) };
}

let machine = null;
before(async () => {
  assert.ok(bun, NO_BUN);
  const engines = [await emptyEngine(), await emptyEngine()];
  write(path.join(mac.home, "run", "engine.json"), engines[0]);
  write(path.join(lab.home, "run", "engine.json"), engines[1]);
  await startBridge(mac);
  await startBridge(lab);
  assert.notEqual((await ask("PUT", "kuvo/link/config", { phones: false, machines: true, relay: relay.url, name: "Studio Mac", app: "0.9.0" })).json?.state, "failed");
  const setup = await ask("GET", "kuvo/link/setup");
  assert.equal(setup.status, 200);
  const result = spawnSync(process.execPath, [script, "setup"], {
    input: JSON.stringify({ relay: relay.url, name: "lab", mac: macAddress, macSign: setup.json.macSign, docs: setup.json.docs, id: "lab" }),
    env: machineEnv(), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  machine = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [{ key: machine.key, sign: machine.sign, address: machine.address, name: "lab", id: "lab" }], moved: [] })).status, 200);
  link.runMacLink();
  link.runMacPeers();
  await new Promise(resolve => {
    const look = setInterval(() => {
      if (!relay.has(link.addressOf(macSecret)) || !relay.has(Buffer.from(machine.address, "base64url"))) return;
      clearInterval(look);
      resolve();
    }, 20);
  });
});
atEnd(async () => {
  link.stopMacPeers();
  link.stopMacLink();
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(lab.home, "run", "link.pid"), "utf8")); } catch {}
  if (pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let tries = 0; tries < 100; tries++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await relay.close();
});

const bare = which => ({ moves: [], away: [] });

test("a Claude Code bot moves with its conversation and memory, and comes back the same", { timeout: 120_000 }, async t => {
  signal = t.signal;
  const places = await ask("GET", "kuvo/moves/places?kind=bot&id=bot_ada");
  assert.equal(places.status, 200);
  assert.equal(places.json.places[0].ok, true, JSON.stringify(places.json));
  const before = hash(ada.file);

  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: "bot_ada", to: machine.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));

  // There: the session on its bridge, in the bot's folder there, as the same Claude Code conversation.
  const work = path.join(lab.bots, "bot_ada", "workspace");
  const there = await asks(lab, "GET", "/api/session/ses_ada");
  assert.equal(there.status, 200);
  assert.equal(there.json.data.location.directory, work);
  assert.deepEqual(agentState(lab, "ses_ada").threads["claude-code"].state, { claudeSession: adaClaude, claudeStarted: true });
  assert.equal(agentState(lab, "ses_ada").threads["claude-code"].seen, "msg_ses_ada");
  assert.ok(await sessionThere(lab, "ses_adasub"), "its subagent's session came too");
  assert.deepEqual(messagesOf(lab, "ses_ada"), messages("ses_ada", "Remember the deploy."));
  // Claude Code's own files, where it looks for them there, word for word.
  const placed = path.join(lab.claude, "projects", slug(work));
  assert.equal(hash(path.join(placed, `${adaClaude}.jsonl`)), before);
  assert.equal(fs.readFileSync(path.join(placed, adaClaude, "tool-results", "one.txt"), "utf8"), "a long output\n");
  // Its memory in the bot's own folder, which is where it runs from here on.
  assert.equal(fs.readFileSync(path.join(lab.bots, "bot_ada", "memory", "notes", "deploy.md"), "utf8"), "On Fridays.\n");
  assert.equal(fs.readFileSync(path.join(lab.bots, "bot_ada", "MEMORY.md"), "utf8"), "Its own memory file.\n");
  // It knows where it is now.
  assert.match(agentState(lab, "ses_ada").kuvoInstructions["kuvo.moved"], new RegExp(`Paths in your conversation under ${mac.bots}/bot_ada are under ${lab.bots}/bot_ada now`));
  // And not on two computers: its session is gone from here (nothing here can run it), and its folder.
  assert.equal(await sessionThere(mac, "ses_ada"), false);
  assert.equal(fs.existsSync(path.join(mac.bots, "bot_ada")), false);
  // And this box says so, with where they went, for a client that still has a row of them from here
  // (the Mac app open through the move): it leaves those out, and finds them on the machine.
  const { moved: movedAway, ...rest } = (await ask("GET", "kuvo/moves")).json;
  assert.deepEqual(rest, bare());
  assert.deepEqual(movedAway.map(each => [each.session, each.key]).sort(), [["ses_ada", machine.key], ["ses_adasub", machine.key]]);
  assert.deepEqual((await askMachine("GET", "kuvo/moves")).json, bare());
  // On Claude Code's default, which is Opus here and Sonnet there: it goes on there on Opus, as it
  // ran here, and so does the bot's own model (#306).
  assert.deepEqual(there.json.data.model, { id: "opus", providerID: "claude-code" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lab.bots, "bot_ada", "bot.json"), "utf8")).model, { id: "opus", providerID: "claude-code" });

  // Something new there, then back.
  fs.appendFileSync(path.join(placed, `${adaClaude}.jsonl`), '{"type":"user","cwd":"the machine"}\n');
  write(path.join(lab.bots, "bot_ada", "memory", "learned-there.md"), "Learned on the machine.\n");
  const after = hash(path.join(placed, `${adaClaude}.jsonl`));
  const back = await askMachine("POST", "kuvo/moves", { kind: "bot", id: "bot_ada", to: macAddress });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  await eventually(() => sessionThere(mac, "ses_ada"));
  assert.equal(hash(ada.file), after, "the original here takes what happened there");
  assert.equal(fs.readFileSync(path.join(mac.bots, "bot_ada", "memory", "learned-there.md"), "utf8"), "Learned on the machine.\n");
  assert.deepEqual(agentState(mac, "ses_ada").threads["claude-code"].state, { claudeSession: adaClaude, claudeStarted: true });
  assert.equal(await sessionThere(lab, "ses_ada"), false, "and nothing's left running there");
  // Back here, it lives here again: this box no longer says it moved away.
  await eventually(async () => !(await ask("GET", "kuvo/moves")).json.moved?.some(each => each.session === "ses_ada"));
  assert.ok((await askMachine("GET", "kuvo/moves")).json.moved?.some(each => each.session === "ses_ada" && each.key === macAddress), "the machine says it went back");
  assert.equal((await asks(lab, "GET", "/api/session/active")).json.data.ses_ada, undefined);
});

test("a Claude Code chat moves, and what the other computer's chats remember stays beside what came", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const before = hash(chat.file);
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_chat", to: machine.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const placed = path.join(lab.claude, "projects", slug(lab.chats));
  assert.equal(hash(path.join(placed, `${chatClaude}.jsonl`)), before);
  const there = (await asks(lab, "GET", "/api/session/ses_chat")).json.data;
  assert.equal(there.location.directory, lab.chats);
  assert.equal(there.metadata?.kuvo?.chat, lab.chats, "a chat there from the first, marked by the box it came to");
  assert.equal(there.time.updated, 1, "as old as it was: marked as it's placed, not written to again");
  assert.equal(fs.readFileSync(path.join(placed, "memory", "MEMORY.md"), "utf8"), "From the machine.\n", "never over what's there");
  assert.equal(fs.readFileSync(path.join(placed, "memory", "only-mac.md"), "utf8"), "Mine.\n");
  const beside = fs.readdirSync(path.join(placed, "memory")).find(name => /^moved-.*-MEMORY\.md$/.test(name));
  assert.equal(fs.readFileSync(path.join(placed, "memory", beside), "utf8"), "From the Mac.\n");
  assert.equal(await sessionThere(mac, "ses_chat"), false);
});

test("a chat whose conversation is there already doesn't go, and the one there is left as it was", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_twin", to: machine.key });
  assert.equal(moved.status, 409, JSON.stringify(moved.json));
  assert.match(moved.json.message, /is on lab already/);
  assert.equal(await sessionThere(mac, "ses_twin"), true, "it stays here");
  assert.equal((await asks(lab, "GET", "/api/session/ses_twin")).json.data.location.directory, lab.chats);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lab.home, "run", "queues.json"), "utf8")).ses_twin, { paused: true, held: [] }, "its queue there is as it was");
});

test("a bot on a second account goes to a computer without that account: it says which account it uses there, and runs on it with its conversation", { timeout: 120_000 }, async t => {
  signal = t.signal;
  const before = hash(work.file);
  // (Once the machine has said what it can do, as it does soon after it's paired: it's asked first then.)
  await eventually(() => {
    try { return JSON.parse(fs.readFileSync(path.join(mac.home, "run", "peer-agents.json"), "utf8"))[machine.key]?.features?.includes("moves.check"); } catch { return false; }
  });
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: "bot_work", to: machine.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.match(moved.json.note ?? "", /uses the Claude Code account signed in there/);
  // With the account that's there: its conversation where that account keeps them, the same.
  const placed = path.join(lab.claude, "projects", slug(path.join(lab.bots, "bot_work", "workspace")), `${workClaude}.jsonl`);
  assert.equal(hash(placed), before);
  const there = await asks(lab, "GET", "/api/session/ses_work");
  assert.equal(there.status, 200);
  assert.equal(there.json?.data?.model?.providerID ?? there.json?.model?.providerID, "claude-code");
  assert.equal(agentState(lab, "ses_work")?.threads?.["claude-code"]?.state?.claudeSession, workClaude, JSON.stringify(agentState(lab, "ses_work")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(lab.bots, "bot_work", "bot.json"), "utf8")).model.providerID, "claude-code");
  assert.equal(await sessionThere(mac, "ses_work"), false);
});

test("a link out of a bot's folder is found before anything goes: it says which, and the bot stays as it was", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const why = "bot_out’s folder has a link that wouldn’t work on another computer (workspace/tools/bin/cli), which can’t move to another computer. Remove it, then move bot_out.";
  const there = (await ask("GET", "kuvo/moves/places?kind=bot&id=bot_out")).json.places.find(place => place.key === machine.key);
  assert.equal(there.ok, false);
  assert.equal(there.why, why);
  assert.equal(there.note, "Has a link that can’t move");
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: "bot_out", to: machine.key });
  assert.equal(moved.status, 409);
  assert.equal(moved.json.message, why);
  assert.equal(await sessionThere(mac, "ses_out"), true);
  assert.ok(!fs.existsSync(path.join(mac.bots, "bot_out", "paused")), "never held");
  assert.ok(!fs.existsSync(path.join(lab.bots, "bot_out")));
});

test("a link within a bot's folder goes with it, still a link to the same file", { timeout: 120_000 }, async t => {
  signal = t.signal;
  const there = (await ask("GET", "kuvo/moves/places?kind=bot&id=bot_link")).json.places.find(place => place.key === machine.key);
  assert.equal(there.ok, true, JSON.stringify(there));
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: "bot_link", to: machine.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const cli = path.join(lab.bots, "bot_link", "workspace", "tools", "bin", "cli");
  assert.equal(fs.readlinkSync(cli), "../cli.js");
  assert.equal(fs.readFileSync(cli, "utf8"), "console.log(1)\n");
  assert.equal(await sessionThere(mac, "ses_link"), false);
  // Its conversation on the model Claude Code's default stood for here, the bot on its own.
  assert.deepEqual((await asks(lab, "GET", "/api/session/ses_link")).json.data.model, { id: "opus", providerID: "claude-code" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lab.bots, "bot_link", "bot.json"), "utf8")).model, { id: "sonnet", providerID: "claude-code" });
});

test("a bot of more than 100 MB goes whole over the relay", { timeout: 600_000 }, async t => {
  signal = t.signal;
  const before = hash(big.file);
  const began = Date.now();
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: "bot_big", to: machine.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const placed = path.join(lab.claude, "projects", slug(path.join(lab.bots, "bot_big", "workspace")), `${bigClaude}.jsonl`);
  assert.equal(fs.statSync(placed).size, fs.statSync(big.file).size);
  assert.equal(hash(placed), before);
  assert.equal(fs.readdirSync(path.join(lab.bots, "bot_big", "memory")).length, 150);
  t.diagnostic(`${(BIG / 1e6).toFixed(0)} MB in ${((Date.now() - began) / 1000).toFixed(1)} s`);
});

test("the relay dropped as it's sent: it goes on from where it was, whole", { timeout: 300_000 }, async t => {
  signal = t.signal;
  const before = hash(dropped.file);
  const moving = ask("POST", "kuvo/moves", { kind: "bot", id: "bot_drop", to: machine.key });
  // Some of it on its way.
  await Promise.race([eventually(() => (fs.readdirSync(path.join(lab.home, "run", "moves")).find(name => /^mov_[A-Za-z0-9]+$/.test(name) && fs.existsSync(path.join(lab.home, "run", "moves", name, "got"))))), moving]);
  const began = Date.now();
  relay.drop();
  const moved = await moving;
  t.diagnostic(`went on and arrived ${((Date.now() - began) / 1000).toFixed(1)} s after the drop`);
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(hash(path.join(lab.claude, "projects", slug(path.join(lab.bots, "bot_drop", "workspace")), `${dropClaude}.jsonl`)), before);
  assert.equal(await sessionThere(mac, "ses_drop"), false);
});
