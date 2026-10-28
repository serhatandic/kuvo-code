// A machine's vault (PROTOCOL.md, "Vault"): kept encrypted with its key only in the box's memory,
// set up and used by your Mac over SSH (`box route`) with a key only your clients keep, locked again
// after a restart until a client unlocks it, and used by agents only as their grants say, without
// ever seeing a value. (This Mac's vault, in its Keychain: vault-host.test.js.)
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/vault.test.js`.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { script } from "./bot-keys-scenarios.js";

// (A short folder: the vault's socket lives in it, and a socket's path can't be long.)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kv-"));
const home = path.join(root, ".kuvo-code");
const env = { ...process.env, HOME: root, KUVO_HOME: home };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX"]) delete env[name];
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SECRET = "hunter2-correct-horse";
const TOKEN = "ghp_0123456789abcdefABCDEF";
const P8 = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgabcdefghijklmnopqrstuv\n-----END PRIVATE KEY-----\n";

// The Mac that set this machine up: its link key and signing key, as link.json lists them.
const macKey = crypto.randomBytes(32).toString("base64url");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const macSign = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
const proof = (at = Date.now()) => ({ mac: macKey, at, proof: crypto.sign(null, Buffer.from(`kuvo-vault-key\0${at}`), privateKey).toString("base64url") });

// The engine, as far as the vault asks it: who a session is, and its folder.
const project = path.join(root, "projects", "shop");
const sessions = {
  ses_ship: { id: "ses_ship", title: "Ship", location: { directory: path.join(home, "bots", "bot_ship", "workspace") } },
  ses_sub: { id: "ses_sub", parentID: "ses_ship", title: "A subagent", location: { directory: path.join(home, "bots", "bot_ship", "workspace") } },
  ses_scout: { id: "ses_scout", title: "Scout", location: { directory: path.join(home, "bots", "bot_scout", "workspace") } },
  ses_shop: { id: "ses_shop", title: "Fix checkout", location: { directory: project } },
};
let engine;

before(async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, "run", "link.json"), JSON.stringify({ macs: [macKey], mac: macKey, macSigns: { [macKey]: macSign } }));
  for (const [id, name, session] of [["bot_ship", "Ship", "ses_ship"], ["bot_scout", "Scout", "ses_scout"]]) {
    fs.mkdirSync(path.join(home, "bots", id, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(home, "bots", id, "bot.json"), JSON.stringify({ kuvo: 1, id, name }));
    fs.writeFileSync(path.join(home, "bots", id, "session"), session);
  }
  engine = http.createServer((request, response) => {
    const id = decodeURIComponent((request.url.match(/^\/api\/session\/([^/?]+)/) ?? [])[1] ?? "");
    response.writeHead(sessions[id] ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(sessions[id] ? { data: sessions[id] } : { message: "No such session." }));
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "engine-pw" }));
});
after(() => { engine?.closeAllConnections(); engine?.close(); });

// The box's long-running process, which holds the vault.
async function start() {
  const child = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { err += chunk; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const url = await new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]).url);
    });
    exited.then(code => reject(new Error(`serve exited ${code}: ${err}`)));
  });
  // Its socket, once it listens.
  for (let tries = 0; tries < 100 && !fs.existsSync(path.join(home, "run", "vault.sock")); tries++) await new Promise(done => setTimeout(done, 20));
  // A request from something on this machine: an agent's command, which has the box's files but no client's key.
  const local = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers: { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json" }, body: body && method !== "GET" ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  const stop = async () => { child.stdin.end(); child.kill("SIGTERM"); await exited; return out + err; };
  return { local, stop };
}

// The Mac over SSH: `box route`, a process of its own on the machine, with the vault's key when it has one.
async function fromMac(method, route, body, key) {
  const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ method, path: route, body, headers: key ? { "x-kuvo-vault-key": key } : {} }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  return { status: answer.status, value: JSON.parse(answer.body || "{}") };
}

// Everything the vault keeps on disk, as one text.
const onDisk = () => {
  const all = [];
  const walk = folder => { for (const name of fs.readdirSync(folder)) { const file = path.join(folder, name); if (fs.statSync(file).isDirectory()) walk(file); else all.push(fs.readFileSync(file, "utf8")); } };
  walk(path.join(home, "box", "vault"));
  return all.join("\n");
};

let box;
let key;
const items = {};
const tool = (session, name, args) => box.local("POST", "kuvo/vault/tools", { session, name, arguments: args });

test("your Mac sets up a machine's vault over SSH, proving it's the Mac that set the machine up, and keeps its key", async () => {
  box = await start();
  assert.equal((await fromMac("POST", "kuvo/vault/key", proof(Date.now() - 10 * 60_000))).status, 403, "an old proof");
  assert.equal((await fromMac("POST", "kuvo/vault/key", { ...proof(), proof: crypto.randomBytes(64).toString("base64url") })).status, 403, "another key's signature");
  const made = await fromMac("POST", "kuvo/vault/key", proof());
  assert.equal(made.status, 200);
  key = made.value.key;
  assert.equal(Buffer.from(key, "base64url").length, 32);
  // Asked again (another Mac's session, the phone): the same key.
  assert.equal((await fromMac("POST", "kuvo/vault/key", proof())).value.key, key);
  for (const [name, given] of [
    ["GitHub", { kind: "login", sites: ["github.com"], username: "ship-bot", values: { password: SECRET } }],
    ["GitHub token", { kind: "key", sites: ["api.github.com"], values: { token: TOKEN } }],
    ["App Store Connect key", { kind: "file", fileName: "AuthKey_ABC123.p8", values: { file: Buffer.from(P8).toString("base64") } }],
    ["App Review contact", { kind: "note", readable: true, values: { text: "Alex Doe, +1 555 0100" } }],
  ]) {
    const added = await fromMac("POST", "kuvo/vault/items", { name, ...given }, key);
    assert.equal(added.status, 200, JSON.stringify(added.value));
    items[name] = added.value.item;
  }
  assert.deepEqual(items.GitHub.fields, ["password"]);
  assert.equal(items.GitHub.username, "ship-bot");
  const listed = await fromMac("GET", "kuvo/vault", undefined, key);
  assert.deepEqual(listed.value.items.map(item => item.name), ["GitHub", "GitHub token", "App Store Connect key", "App Review contact"]);
  assert.deepEqual({ made: listed.value.state.made, locked: listed.value.state.locked, store: listed.value.state.store }, { made: true, locked: false, store: "encrypted" });
  assert.equal((await fromMac("GET", `kuvo/vault/items/${items.GitHub.id}/values`, undefined, key)).value.values.password, SECRET);
});

test("nothing on the machine shows a value: not its files, not the box's answers to anything without a client's key", async () => {
  const disk = onDisk();
  for (const value of [SECRET, TOKEN, "MIGTAgEAMBMGByqGSM49", key]) assert.ok(!disk.includes(value), `${value.slice(0, 8)}… isn't on disk`);
  for (const [method, route] of [["GET", "kuvo/vault"], ["GET", `kuvo/vault/items/${items.GitHub.id}/values`], ["GET", "kuvo/vault/activity"], ["POST", "kuvo/vault/key"], ["POST", "kuvo/vault/grants"], ["POST", "kuvo/vault/pause"]]) {
    assert.equal((await box.local(method, route, {})).status, 403, `${method} ${route} from an agent's command`);
    assert.equal((await fromMac(method, route, {})).status, 403, `${method} ${route} over box route without the key`);
    assert.equal((await fromMac(method, route, {}, crypto.randomBytes(32).toString("base64url"))).status, 403, `${method} ${route} with a wrong key`);
  }
  assert.equal((await box.local("POST", "kuvo/vault/items", { kind: "note", name: "Planted", values: { text: "x" } })).status, 403);
});

test("an agent uses only what it's granted: vault_items lists it, without names of the rest", async () => {
  assert.match((await tool("ses_ship", "vault_items", {})).value.text, /You may use nothing in the vault yet\. The vault has 4 more items/);
  for (const [item, how] of [["GitHub", "own"], ["GitHub token", "own"], ["App Store Connect key", "ask"], ["App Review contact", "own"]]) {
    assert.equal((await fromMac("POST", "kuvo/vault/grants", { item: items[item].id, who: { bot: "bot_ship" }, how }, key)).status, 200);
  }
  const listed = (await tool("ses_sub", "vault_items", {})).value.text;
  assert.match(listed, /“GitHub”: a sign-in on github\.com, username ship-bot; yours to use/);
  assert.match(listed, /“App Store Connect key”: a file; the user is asked each time/);
  assert.match(listed, /It reads: Alex Doe, \+1 555 0100/, "a note you let bots read");
  const scout = (await tool("ses_scout", "vault_items", {})).value.text;
  assert.ok(!scout.includes("GitHub"), "another bot sees no names");
});

test("a bot signs in on its own site; on another site the fill is refused and the bot paused until you look", async () => {
  const signedIn = await box.local("POST", "kuvo/vault/fill", { session: "ses_sub", origin: "https://github.com", purpose: "sign-in" });
  assert.equal(signedIn.status, 200);
  assert.deepEqual(signedIn.value, { item: { id: items.GitHub.id, name: "GitHub" }, username: "ship-bot", values: { password: SECRET } });
  assert.equal((await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://gist.github.com", purpose: "sign-in" })).status, 200, "a site under its own");
  assert.equal((await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "http://github.com", purpose: "sign-in" })).status, 400, "never over plain http");
  assert.equal((await box.local("POST", "kuvo/vault/fill", { session: "ses_scout", origin: "https://github.com", purpose: "sign-in" })).status, 404, "another bot: the browser asks you instead");
  const steered = await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://github.com.evil.example", purpose: "sign-in", item: "GitHub" });
  assert.equal(steered.status, 403);
  assert.match(steered.value.message, /isn't one of its sites/);
  const state = (await fromMac("GET", "kuvo/vault", undefined, key)).value.state;
  assert.match(state.pausedBots.bot_ship, /github\.com\.evil\.example/);
  const paused = await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://github.com", purpose: "sign-in" });
  assert.equal(paused.status, 403);
  assert.match(paused.value.message, /paused this bot's use/);
  assert.equal((await fromMac("POST", "kuvo/vault/pause", { bot: "bot_ship", paused: false }, key)).value.pausedBots.bot_ship, undefined);
});

test("vault_run hands values to a command, never to the agent: its output comes back with them hidden", async () => {
  const ran = await tool("ses_ship", "vault_run", {
    command: "printf 'token=%s\\n' \"$TOKEN\"; printf '%s' \"$TOKEN\" | base64; printf '%s' \"$TOKEN\" | od -An -tx1 | tr -d ' \\n'",
    variables: { TOKEN: "GitHub token.token" },
    why: "To check the token works.",
  });
  assert.equal(ran.status, 200);
  assert.equal(ran.value.isError, false, ran.value.text);
  const output = ran.value.text;
  for (const form of [TOKEN, Buffer.from(TOKEN).toString("base64"), Buffer.from(TOKEN).toString("hex")]) assert.ok(!output.includes(form), output);
  assert.match(output, /token=\[vault: GitHub token\]/);
  const p8 = await new Promise(resolve => {
    const running = tool("ses_ship", "vault_run", { command: "cat \"$ASC_KEY\"; ls -l \"$ASC_KEY\" | cut -c1-10", variables: { ASC_KEY: "App Store Connect key" }, why: "To upload the build." });
    // Its grant asks you each time: you allow it once from your Mac.
    const answer = async () => {
      const asks = (await fromMac("GET", "kuvo/vault/asks", undefined, key)).value.asks;
      if (!asks.length) return setTimeout(answer, 20);
      assert.deepEqual({ kind: asks[0].kind, itemName: asks[0].itemName, botName: asks[0].botName, why: asks[0].why }, { kind: "use", itemName: "App Store Connect key", botName: "Ship", why: "To upload the build." });
      assert.equal((await fromMac("POST", `kuvo/vault/asks/${asks[0].id}`, { answer: "once" }, key)).status, 200);
    };
    answer();
    resolve(running);
  });
  assert.equal(p8.value.isError, false, p8.value.text);
  assert.ok(!p8.value.text.includes("MIGTAgEAMBMGByqGSM49"), p8.value.text);
  assert.match(p8.value.text, /\[vault: App Store Connect key\]/);
  assert.match(p8.value.text, /-rw-------/, "its copy only you can read");
  assert.deepEqual(fs.readdirSync(path.join(home, "run", "vault-run")), [], "and gone once it ended");
  // A bot without a grant: you're asked, and you say no.
  const refusing = tool("ses_scout", "vault_run", { command: "env", variables: { T: "GitHub token" }, why: "Curious." });
  let asks = [];
  for (let tries = 0; tries < 100 && !asks.length; tries++) asks = (await fromMac("GET", "kuvo/vault/asks", undefined, key)).value.asks;
  assert.equal(asks[0].botName, "Scout");
  assert.equal((await fromMac("POST", `kuvo/vault/asks/${asks[0].id}`, { answer: "no" }, key)).status, 200);
  const refused = (await refusing).value;
  assert.equal(refused.isError, true);
  assert.match(refused.text, /The user didn't let you use “GitHub token”/);
});

test("an agent that needs something asks you for it, and gets its name, never its value", async () => {
  const asking = tool("ses_shop", "vault_ask", { need: "a GitHub token", why: "To open the pull request.", site: "api.github.com" });
  let asks = [];
  for (let tries = 0; tries < 100 && !asks.length; tries++) asks = (await fromMac("GET", "kuvo/vault/asks", undefined, key)).value.asks;
  assert.deepEqual({ kind: asks[0].kind, need: asks[0].need, sessionName: asks[0].sessionName }, { kind: "item", need: "a GitHub token", sessionName: "Fix checkout" });
  assert.equal((await fromMac("POST", `kuvo/vault/asks/${asks[0].id}`, { answer: "always", item: items["GitHub token"].id }, key)).status, 200);
  const answer = (await asking).value.text;
  assert.match(answer, /The user gave you “GitHub token”/);
  assert.ok(!answer.includes(TOKEN));
});

test("every use, ask and answer is noted, without a value", async () => {
  const entries = (await fromMac("GET", "kuvo/vault/activity", undefined, key)).value.entries;
  const said = entries.map(entry => `${entry.what} ${entry.itemName ?? ""} ${entry.how ?? ""}`.trim());
  for (const expected of ["added GitHub", "used GitHub own", "refused GitHub wrong site", "asked App Store Connect key", "allowed App Store Connect key once", "used GitHub token own", "shown GitHub"]) {
    assert.ok(said.includes(expected), `${expected} in ${JSON.stringify(said)}`);
  }
  assert.ok(entries.some(entry => entry.what === "used" && entry.program === "cat" && entry.bot === "bot_ship" && entry.why === "To upload the build."));
  const text = JSON.stringify(entries);
  for (const value of [SECRET, TOKEN, "MIGTAgEAMBMGByqGSM49"]) assert.ok(!text.includes(value));
  assert.deepEqual((await fromMac("GET", `kuvo/vault/activity?item=${items.GitHub.id}&limit=2`, undefined, key)).value.entries.length, 2);
});

test("Pause stops every agent's use at once", async () => {
  assert.equal((await fromMac("POST", "kuvo/vault/pause", { paused: true }, key)).value.paused, true);
  assert.match((await tool("ses_ship", "vault_run", { command: "true", variables: { T: "GitHub token" }, why: "x" })).value.text, /paused the vault/);
  assert.equal((await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://github.com", purpose: "sign-in" })).status, 403);
  assert.equal((await fromMac("POST", "kuvo/vault/pause", { paused: false }, key)).value.paused, false);
});

test("after the box starts again the vault is locked, until a client's key unlocks it", async () => {
  await box.stop();
  box = await start();
  const locked = await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://github.com", purpose: "sign-in" });
  assert.equal(locked.status, 423);
  assert.match(locked.value.message, /locked/);
  assert.equal((await box.local("POST", "kuvo/vault/unlock", { key: crypto.randomBytes(32).toString("base64url") })).status, 403);
  // The Mac's next request carries its key, which unlocks it.
  const listed = await fromMac("GET", "kuvo/vault", undefined, key);
  assert.equal(listed.value.state.locked, false);
  assert.equal(listed.value.items.length, 4);
  assert.equal((await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://github.com", purpose: "sign-in" })).value.values.password, SECRET);
  await box.stop();
});

test("without the box's own process, a request says so plainly", async () => {
  const answer = await fromMac("GET", "kuvo/vault", undefined, key);
  assert.equal(answer.status, 503);
  assert.match(answer.value.message, /isn't open/);
});
