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
import net from "node:net";
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
// (Signed for this machine, by its id on the Mac: a proof for another of the Mac's machines is no proof here.)
// Each with a nonce of its own, which the machine takes once.
const proof = (at = Date.now(), machine = "lokum", nonce = crypto.randomBytes(18).toString("base64url")) => ({ mac: macKey, at, nonce, proof: crypto.sign(null, Buffer.from(`kuvo-vault-key\0${machine}\0${at}\0${nonce}`), privateKey).toString("base64url") });

// The engine, as far as the vault asks it: who a session is, and its folder.
const project = path.join(root, "projects", "shop");
const sessions = {
  ses_ship: { id: "ses_ship", title: "Ship", location: { directory: path.join(home, "bots", "bot_ship", "workspace") } },
  ses_sub: { id: "ses_sub", parentID: "ses_ship", title: "A subagent", location: { directory: path.join(home, "bots", "bot_ship", "workspace") } },
  ses_scout: { id: "ses_scout", title: "Scout", location: { directory: path.join(home, "bots", "bot_scout", "workspace") } },
  ses_shop: { id: "ses_shop", title: "Fix checkout", location: { directory: project } },
};
let engine;
// The tool calls each session's engine says are running now: a vault call is answered only as one
// of them (vault/who.ts, isCalling). `tool` and `fillAs` say so before they call, as the engine would.
const calling = {};
const running = (session, name, input) => { calling[session] = [{ type: "tool", name: `kuvo-browser_${name}`, state: { status: "running", input } }]; };

before(async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, "run", "link.json"), JSON.stringify({ id: "lokum", macs: [macKey], mac: macKey, macSigns: { [macKey]: macSign } }));
  for (const [id, name, session] of [["bot_ship", "Ship", "ses_ship"], ["bot_scout", "Scout", "ses_scout"]]) {
    fs.mkdirSync(path.join(home, "bots", id, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(home, "bots", id, "bot.json"), JSON.stringify({ kuvo: 1, id, name }));
    fs.writeFileSync(path.join(home, "bots", id, "session"), session);
  }
  engine = http.createServer((request, response) => {
    const id = decodeURIComponent((request.url.match(/^\/api\/session\/([^/?]+)/) ?? [])[1] ?? "");
    if (/^\/api\/session\/[^/?]+\/message/.test(request.url)) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ type: "assistant", content: calling[id] ?? [] }] }));
    }
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
const tool = (session, name, args) => {
  running(session, name, args ?? {});
  return box.local("POST", "kuvo/vault/tools", { session, name, arguments: args });
};
// A browser's fill, while the session's browser_sign_in (or browser_fill) runs.
const fillAs = (body) => {
  running(body.session, body.purpose === "field" ? "browser_fill" : "browser_sign_in", {});
  return box.local("POST", "kuvo/vault/fill", body);
};

test("your Mac sets up a machine's vault over SSH, proving it's the Mac that set the machine up, and keeps its key", async () => {
  box = await start();
  assert.equal((await fromMac("POST", "kuvo/vault/key", proof(Date.now() - 10 * 60_000))).status, 403, "an old proof");
  assert.equal((await fromMac("POST", "kuvo/vault/key", { ...proof(), proof: crypto.randomBytes(64).toString("base64url") })).status, 403, "another key's signature");
  assert.equal((await fromMac("POST", "kuvo/vault/key", proof(Date.now(), "another-machine"))).status, 403, "a proof made for another machine");
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
  const signedIn = await fillAs({ session: "ses_sub", origin: "https://github.com", purpose: "sign-in" });
  assert.equal(signedIn.status, 200);
  assert.deepEqual(signedIn.value, { item: { id: items.GitHub.id, name: "GitHub" }, username: "ship-bot", values: { password: SECRET } });
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://gist.github.com", purpose: "sign-in" })).status, 200, "a site under its own");
  assert.equal((await fillAs({ session: "ses_ship", origin: "http://github.com", purpose: "sign-in" })).status, 400, "never over plain http");
  assert.equal((await fillAs({ session: "ses_scout", origin: "https://github.com", purpose: "sign-in" })).status, 404, "another bot: the browser asks you instead");
  const steered = await fillAs({ session: "ses_ship", origin: "https://github.com.evil.example", purpose: "sign-in", item: "GitHub" });
  assert.equal(steered.status, 403);
  assert.match(steered.value.message, /isn't one of its sites/);
  const state = (await fromMac("GET", "kuvo/vault", undefined, key)).value.state;
  assert.match(state.pausedBots.bot_ship, /github\.com\.evil\.example/);
  const paused = await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in" });
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
  // Given always: its project's to use on its own, so it isn't asked again.
  const grants = (await fromMac("GET", "kuvo/vault/grants", undefined, key)).value.grants;
  assert.ok(grants.some(grant => grant.item === items["GitHub token"].id && grant.who.project === project && grant.how === "own"));
  assert.equal((await tool("ses_shop", "vault_run", { command: "true", variables: { T: "GitHub token" }, why: "To open it." })).value.isError, false);
});

test("an item given once is used once without asking again; the next use asks", async () => {
  const asking = tool("ses_scout", "vault_ask", { need: "the App Store Connect key", why: "To upload a build." });
  let asks = [];
  for (let tries = 0; tries < 100 && !asks.length; tries++) asks = (await fromMac("GET", "kuvo/vault/asks", undefined, key)).value.asks;
  assert.equal((await fromMac("POST", `kuvo/vault/asks/${asks[0].id}`, { answer: "once", item: items["App Store Connect key"].id }, key)).status, 200);
  assert.match((await asking).value.text, /for this once/);
  assert.equal((await tool("ses_scout", "vault_run", { command: "true", variables: { K: "App Store Connect key" }, why: "Upload." })).value.isError, false, "its one use");
  const again = tool("ses_scout", "vault_run", { command: "true", variables: { K: "App Store Connect key" }, why: "Upload again." });
  let next = [];
  for (let tries = 0; tries < 100 && !next.length; tries++) next = (await fromMac("GET", "kuvo/vault/asks", undefined, key)).value.asks;
  assert.equal(next[0].kind, "use", "asked again");
  await fromMac("POST", `kuvo/vault/asks/${next[0].id}`, { answer: "no" }, key);
  assert.equal((await again).value.isError, true);
});

test("a value stays hidden whatever its item's name, and a key file's strings each hide on their own", async () => {
  const json = JSON.stringify({ type: "service_account", client_email: "ship@example.iam", private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n", client_secret: "GOCSPX-abcdefghijklmnop" });
  const added = await fromMac("POST", "kuvo/vault/items", { kind: "file", name: "Cost $& key", fileName: "service.json", values: { file: Buffer.from(json).toString("base64") } }, key);
  assert.equal(added.status, 200);
  await fromMac("POST", "kuvo/vault/grants", { item: added.value.item.id, who: { bot: "bot_ship" }, how: "own" }, key);
  const ran = await tool("ses_ship", "vault_run", { command: "grep -o '\"client_secret\": *\"[^\"]*\"' \"$F\" || sed -n 's/.*client_secret\":\"\\([^\"]*\\).*/\\1/p' \"$F\"; tr ',' '\\n' < \"$F\" | grep private_key", variables: { F: "Cost $& key" }, why: "To read its secret." });
  const output = ran.value.text;
  for (const secret of ["GOCSPX-abcdefghijklmnop", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"]) assert.ok(!output.includes(secret), output);
  assert.match(output, /\[vault: Cost \$& key\]/);
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
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in" })).status, 403);
  assert.equal((await fromMac("POST", "kuvo/vault/pause", { paused: false }, key)).value.paused, false);
});

test("only a call its conversation is making uses the vault: another command naming the session, or other arguments, gets nothing", async () => {
  const run = { command: "echo $T", variables: { T: "GitHub token" }, why: "To check the token." };
  calling.ses_ship = [];
  const forged = await box.local("POST", "kuvo/vault/tools", { session: "ses_ship", name: "vault_run", arguments: run });
  assert.equal(forged.value.isError, true);
  assert.match(forged.value.text, /isn't running/);
  assert.ok(!forged.value.text.includes(TOKEN));
  // Its conversation runs another command than the one asked for.
  running("ses_ship", "vault_run", { ...run, command: "true" });
  assert.match((await box.local("POST", "kuvo/vault/tools", { session: "ses_ship", name: "vault_run", arguments: run })).value.text, /isn't running/);
  // A fill with no sign-in running there.
  calling.ses_ship = [];
  assert.equal((await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://github.com", purpose: "sign-in" })).status, 403);
});

test("the vault's files changed outside Kuvo Code count for nothing: a grant written in, or a site added, gives nothing", async () => {
  const grants = path.join(home, "box", "vault", "grants.json");
  const itemsFile = path.join(home, "box", "vault", "items.json");
  const keptGrants = fs.readFileSync(grants, "utf8");
  const keptItems = fs.readFileSync(itemsFile, "utf8");
  try {
    // Scout, granted nothing, writes itself a grant.
    const changed = JSON.parse(keptGrants);
    changed.data.push({ item: items["GitHub token"].id, who: { bot: "bot_scout" }, how: "own", at: Date.now() });
    fs.writeFileSync(grants, JSON.stringify(changed));
    assert.match((await tool("ses_scout", "vault_items", {})).value.text, /You may use nothing/);
    assert.equal((await fromMac("GET", "kuvo/vault", undefined, key)).value.state.tampered, true, "the page says so");
    fs.writeFileSync(grants, keptGrants);
    // A site of an agent's choosing added to the GitHub sign-in.
    const items2 = JSON.parse(keptItems);
    for (const item of items2.data) if (item.name === "GitHub") item.sites.push("github.com.evil.example");
    fs.writeFileSync(itemsFile, JSON.stringify(items2));
    assert.notEqual((await fillAs({ session: "ses_ship", origin: "https://github.com.evil.example", purpose: "sign-in" })).status, 200);
  } finally {
    fs.writeFileSync(grants, keptGrants);
    fs.writeFileSync(itemsFile, keptItems);
  }
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in" })).status, 200, "as it was again");
});

test("a sign-in only for signing in is never handed to a command or another field, and a value too short to hide isn't kept", async () => {
  const added = await fromMac("POST", "kuvo/vault/items", { name: "Shop admin", kind: "login", sites: ["admin.shop.example"], username: "ship", signInOnly: true, values: { password: "shop-admin-pass-1" } }, key);
  assert.equal(added.status, 200, JSON.stringify(added.value));
  assert.equal(added.value.item.signInOnly, true);
  await fromMac("POST", "kuvo/vault/grants", { item: added.value.item.id, who: { bot: "bot_ship" }, how: "own" }, key);
  const ran = await tool("ses_ship", "vault_run", { command: "echo $P | rev", variables: { P: "Shop admin" }, why: "x" });
  assert.equal(ran.value.isError, true);
  assert.match(ran.value.text, /only for signing in/);
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://admin.shop.example", purpose: "field", item: "Shop admin" })).status, 403);
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://admin.shop.example", purpose: "sign-in", item: "Shop admin" })).value.values.password, "shop-admin-pass-1", "signing in, as it's for");
  const short = await fromMac("POST", "kuvo/vault/items", { name: "Short", kind: "key", values: { value: "abc" } }, key);
  assert.equal(short.status, 400);
  assert.match(short.value.message, /at least 4/);
});

test("a file's bytes stay hidden however a command prints them: whole, or wrapped as base64 and PEM wrap it", async () => {
  const bytes = crypto.randomBytes(150);
  const added = await fromMac("POST", "kuvo/vault/items", { name: "Signing cert", kind: "file", fileName: "cert.der", values: { file: bytes.toString("base64") } }, key);
  await fromMac("POST", "kuvo/vault/grants", { item: added.value.item.id, who: { bot: "bot_ship" }, how: "own" }, key);
  const ran = await tool("ses_ship", "vault_run", { command: 'node -e \'const b=require("fs").readFileSync(process.env.C).toString("base64");console.log(b);console.log(b.match(/.{1,76}/g).join("\\n"));console.log(b.match(/.{1,64}/g).join("\\n"))\'', variables: { C: "Signing cert" }, why: "x" });
  const base64 = bytes.toString("base64");
  for (const width of [76, 64]) for (const line of base64.match(new RegExp(`.{1,${width}}`, "g")).filter(each => each.length >= 8)) assert.ok(!ran.value.text.includes(line), `a ${width}-wide line shows: ${ran.value.text}`);
  assert.ok(!ran.value.text.includes(base64));
  assert.match(ran.value.text, /\[vault: Signing cert\]/);
});

test("the Mac's proof works once, and what answers on the vault's socket gets the Mac's key only by proving it holds it", async () => {
  const once = proof();
  assert.equal((await fromMac("POST", "kuvo/vault/key", once)).status, 200);
  assert.equal((await fromMac("POST", "kuvo/vault/key", once)).status, 403, "the same proof again");
  // Something else in the socket's place, which can't prove it holds the key.
  const socket = path.join(home, "run", "vault.sock");
  fs.renameSync(socket, socket + ".kept");
  const heard = [];
  const fake = net.createServer(connection => {
    connection.setEncoding("utf8");
    connection.on("data", chunk => {
      heard.push(chunk);
      if (heard.length === 1) connection.write(JSON.stringify({ nonce: "fake-nonce-0123456789", proof: "not-a-proof" }) + "\n");
    });
  });
  const umask = process.umask(0o177);
  await new Promise(resolve => fake.listen(socket, resolve));
  process.umask(umask);
  try {
    const asked = await fromMac("GET", "kuvo/vault", undefined, key);
    assert.equal(asked.status, 403);
    assert.ok(!heard.join("").includes(key), "its key never sent");
    assert.equal(heard.length, 1, "nothing but hello");
  } finally {
    await new Promise(resolve => fake.close(resolve));
    fs.rmSync(socket, { force: true });
    fs.renameSync(socket + ".kept", socket);
  }
  assert.equal((await fromMac("GET", "kuvo/vault", undefined, key)).status, 200, "the real one again");
});

test("a conversation that isn't a bot's is paused too when it's steered to another site, and a sign-in on a name without dots works", async () => {
  await fromMac("POST", "kuvo/vault/grants", { item: items.GitHub.id, who: { project: project }, how: "own" }, key);
  const steered = await fillAs({ session: "ses_shop", origin: "https://github.com.evil.example", purpose: "sign-in", item: "GitHub" });
  assert.equal(steered.status, 403);
  assert.match(steered.value.message, /conversation's use of the vault is paused/);
  assert.equal((await fromMac("GET", "kuvo/vault", undefined, key)).value.state.pausedBots.ses_shop !== undefined, true);
  assert.equal((await fillAs({ session: "ses_shop", origin: "https://github.com", purpose: "sign-in" })).status, 403, "paused");
  await fromMac("POST", "kuvo/vault/pause", { paused: false, bot: "ses_shop" }, key);
  assert.equal((await fillAs({ session: "ses_shop", origin: "https://github.com", purpose: "sign-in" })).status, 200, "let go on");
  const nas = await fromMac("POST", "kuvo/vault/items", { name: "NAS", kind: "login", sites: ["nas"], username: "admin", values: { password: "nas-password-1" } }, key);
  assert.equal(nas.status, 200, JSON.stringify(nas.value));
  assert.deepEqual(nas.value.item.sites, ["nas"]);
});

test("after the box starts again the vault is locked, until a client's key unlocks it", async () => {
  await box.stop();
  // A command's copy a box killed mid-command left behind.
  fs.mkdirSync(path.join(home, "run", "vault-run", "left"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "vault-run", "left", "AuthKey.p8"), P8);
  box = await start();
  const locked = await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in" });
  assert.equal(locked.status, 423);
  assert.match(locked.value.message, /locked/);
  assert.equal((await box.local("POST", "kuvo/vault/unlock", { key: crypto.randomBytes(32).toString("base64url") })).status, 403);
  // The Mac's next request carries its key, which unlocks it.
  assert.equal(fs.existsSync(path.join(home, "run", "vault-run")), false, "a copy left behind is gone");
  const listed = await fromMac("GET", "kuvo/vault", undefined, key);
  assert.equal(listed.value.state.locked, false);
  assert.equal(listed.value.items.length, 8);
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in" })).value.values.password, SECRET);
  await box.stop();
});

test("without the box's own process, a request says so plainly", async () => {
  const answer = await fromMac("GET", "kuvo/vault", undefined, key);
  assert.equal(answer.status, 503);
  assert.match(answer.value.message, /isn't open/);
});
