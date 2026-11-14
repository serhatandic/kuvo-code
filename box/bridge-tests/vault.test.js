// A machine's vault (PROTOCOL.md, "Vault"): kept encrypted with its key only in the box's memory,
// set up and used by your Mac over SSH (`box route`) with a key only your clients keep, locked again
// after a restart until a client unlocks it, and used by agents only as their grants say, without
// ever seeing a value. (This Mac's vault, in its Keychain: vault-host.test.js.)
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/vault.test.js`.
import { testsFolder } from "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { script, sshAgentsOf } from "./bot-keys-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";
// (Each test fails at its own time limit when what it waits for never comes, rather than holding up the run.)
import { appears, asked, before, test as vaultTest } from "./vault-waits.js";

// (A short folder: the vault's socket lives in it, and a socket's path can't be long. Not in the
// temporary folder: where the system's can't be used (an agent's shell may write only in Kuvo Code's
// own, 70 letters deep), the socket's path goes over the 103 a socket may have, and the vault never listens.)
const root = fs.realpathSync(testsFolder("kv"));
const home = path.join(root, ".kuvo-code");
// (Agents may use it: on a box whose commands are fenced. One that isn't is the last test.)
const env = { ...process.env, HOME: root, KUVO_HOME: home, KUVO_VAULT_AGENTS: "1" };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX"]) delete env[name];
removeAtEnd(root);

const SECRET = "hunter2-correct-horse";
const TOKEN = "ghp_0123456789abcdefABCDEF";
const P8 = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgabcdefghijklmnopqrstuv\n-----END PRIVATE KEY-----\n";

// The Mac that set this machine up: its link key and signing key, as link.json lists them.
const macKey = crypto.randomBytes(32).toString("base64url");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const macSign = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
// (Signed for this machine, by its id on the Mac: a proof for another of the Mac's machines is no proof here.)
// Each with a nonce of its own, which the machine takes once.
const proof = (at = Date.now(), machine = "devbox", nonce = crypto.randomBytes(18).toString("base64url")) => ({ mac: macKey, at, nonce, proof: crypto.sign(null, Buffer.from(`kuvo-vault-key\0${machine}\0${at}\0${nonce}`), privateKey).toString("base64url") });

// The engine, as far as the vault asks it: who a session is, and its folder.
const project = path.join(root, "projects", "shop");
const sessions = {
  ses_ship: { id: "ses_ship", title: "Ship", location: { directory: path.join(home, "bots", "bot_ship", "workspace") } },
  ses_sub: { id: "ses_sub", parentID: "ses_ship", title: "A subagent", location: { directory: path.join(home, "bots", "bot_ship", "workspace") } },
  ses_scout: { id: "ses_scout", title: "Scout", location: { directory: path.join(home, "bots", "bot_scout", "workspace") } },
  ses_shop: { id: "ses_shop", title: "Fix checkout", location: { directory: project } },
  ses_away: { id: "ses_away", title: "On Autopilot", location: { directory: project }, metadata: { kuvo: { autopilot: true } } },
};
let engine;
// The tool calls each session's engine says are running now: a vault call is answered only as one
// of them (vault/who.ts, isCalling). `tool` and `fillAs` say so before they call, as the engine would.
const calling = {};
let calls = 0;
const running = (session, name, input) => { calling[session] = [{ type: "tool", id: `call_${++calls}`, name: `kuvo-browser_${name}`, state: { status: "running", input } }]; };

before(async () => {
  // (0700, as the box makes it: in a home short enough for its SSH agents, it keeps them here only in a folder of yours alone, vault/ssh.ts.)
  fs.mkdirSync(path.join(home, "run"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, "run", "link.json"), JSON.stringify({ id: "devbox", macs: [macKey], mac: macKey, macSigns: { [macKey]: macSign } }));
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
atEnd(() => { engine?.closeAllConnections(); engine?.close(); });

// The box's long-running process, which holds the vault.
async function start(more = {}) {
  // (A box stopped before leaves its socket's file: only the new one's counts.)
  const run = path.join(more.KUVO_HOME ?? home, "run");
  // (0700, as the box makes it: it keeps a short home's SSH agents beside it only in a folder of yours alone.)
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(run, "vault.sock"), { force: true });
  const child = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw", ...more }, stdio: ["pipe", "pipe", "pipe"] });
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
  // Its vault listens before it says where it is (in its own home's run folder): what the Mac's
  // app asks it from then on finds it open.
  if (!fs.existsSync(path.join(run, "vault.sock"))) {
    child.kill("SIGTERM");
    await exited;
    assert.fail("the vault listens once the box says where it is");
  }
  // A request from something on this machine: an agent's command, which has the box's files but no client's key.
  const local = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers: { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json" }, body: body && method !== "GET" ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  let stopping;
  const stop = () => stopping ??= (async () => {
    try { await cleanItems(); } finally {
      child.stdin.end(); child.kill("SIGTERM"); await exited;
    }
    return out + err;
  })();
  atEnd(stop);
  // What the vault asks you, once it asks.
  const asks = () => asked(`${url}/kuvo/vault/asks/events`, "box-pw");
  return { local, stop, asks };
}

// The Mac over SSH: `box route`, a process of its own on the machine, with the vault's key when it has one.
async function fromMac(method, route, body, key) {
  const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ method, path: route, body, headers: key ? { "x-kuvo-vault-key": key } : {} }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  const value = JSON.parse(answer.body || "{}");
  if (method === "POST" && route === "kuvo/vault/items" && value.item?.id) temporaryItems.add(value.item.id);
  return { status: answer.status, value };
}

// The Mac over SSH as it reaches the vault now: each request with its proof for that request alone,
// its body as sent, never the vault's key.
async function fromMacProved(method, route, body, { proofFor = { method, route, body } } = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const at = Date.now();
  const nonce = crypto.randomBytes(18).toString("base64url");
  const signedText = proofFor.body === undefined ? "" : JSON.stringify(proofFor.body);
  const hash = crypto.createHash("sha256").update(signedText).digest("hex");
  const proof = crypto.sign(null, Buffer.from(`kuvo-vault-request\0devbox\0${at}\0${nonce}\0${proofFor.method}\0${proofFor.route}\0${hash}`), privateKey).toString("base64url");
  const header = Buffer.from(JSON.stringify({ mac: macKey, at, nonce, proof })).toString("base64url");
  const send = async () => {
    const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(JSON.stringify({ method, path: route, ...(body === undefined ? {} : { body, bodyText: text }), headers: { "x-kuvo-vault-proof": header } }));
    let out = "";
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) out += chunk;
    const answer = JSON.parse(out.trim().split("\n").at(-1));
    return { status: answer.status, value: JSON.parse(answer.body || "{}") };
  };
  return { first: await send(), again: send };
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
// The four setup items are shared fixtures. Every other item belongs to its test,
// including one whose next assertion or wait fails.
const temporaryItems = new Set();
let cleaning;
function cleanItems() {
  return cleaning ??= deleteItems().finally(() => { cleaning = undefined; });
}
async function deleteItems() {
  for (const id of temporaryItems) {
    if (!Object.values(items).some(item => item.id === id)) {
      const answer = await fromMac("DELETE", `kuvo/vault/items/${id}`, undefined, key);
      assert.ok([200, 404].includes(answer.status), JSON.stringify(answer));
    }
    temporaryItems.delete(id);
  }
}
let testSignal;
const test = (name, run) => vaultTest(name, async t => {
  testSignal = t.signal;
  t.after(cleanItems);
  return run(t);
});
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

test("whether a password is the one kept is told without giving it or noting it as shown, and only to a client", async () => {
  const same = values => fromMac("POST", `kuvo/vault/items/${items.GitHub.id}/same`, { values }, key);
  const shownBefore = (await fromMac("GET", "kuvo/vault/activity", undefined, key)).value.entries.filter(entry => entry.what === "shown").length;
  assert.deepEqual((await same({ password: SECRET })).value, { same: true });
  assert.deepEqual((await same({ password: "typed-anew" })).value, { same: false });
  assert.deepEqual((await same({ password: SECRET, otp: "123456" })).value, { same: false }, "a value it doesn't keep isn't the same");
  for (const values of [{}, { password: 1 }, null]) assert.equal((await same(values)).status, 400, JSON.stringify(values));
  assert.equal((await fromMac("GET", `kuvo/vault/items/${items.GitHub.id}/same`, undefined, key)).status, 405);
  assert.equal((await fromMac("POST", "kuvo/vault/items/item_none/same", { values: { password: SECRET } }, key)).status, 404);
  assert.equal((await fromMac("POST", `kuvo/vault/items/${items.GitHub.id}/same`, { values: { password: SECRET } })).status, 403, "without the key");
  assert.equal((await box.local("POST", `kuvo/vault/items/${items.GitHub.id}/same`, { values: { password: SECRET } })).status, 403, "from an agent's command");
  const shownAfter = (await fromMac("GET", "kuvo/vault/activity", undefined, key)).value.entries.filter(entry => entry.what === "shown").length;
  assert.equal(shownAfter, shownBefore, "nothing noted as shown");
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
  const running = tool("ses_ship", "vault_run", { command: "cat \"$ASC_KEY\"; ls -l \"$ASC_KEY\" | cut -c1-10", variables: { ASC_KEY: "App Store Connect key" }, why: "To upload the build." });
  // Its grant asks you each time: you allow it once from your Mac.
  const answering = (async () => {
    const asks = await box.asks();
    assert.deepEqual({ kind: asks[0].kind, itemName: asks[0].itemName, botName: asks[0].botName, why: asks[0].why }, { kind: "use", itemName: "App Store Connect key", botName: "Ship", why: "To upload the build." });
    assert.equal((await fromMac("POST", `kuvo/vault/asks/${asks[0].id}`, { answer: "once" }, key)).status, 200);
  })();
  const [p8] = await Promise.all([running, answering]);
  assert.equal(p8.value.isError, false, p8.value.text);
  assert.ok(!p8.value.text.includes("MIGTAgEAMBMGByqGSM49"), p8.value.text);
  assert.match(p8.value.text, /\[vault: App Store Connect key\]/);
  assert.match(p8.value.text, /-rw-------/, "its copy only you can read");
  assert.deepEqual(fs.readdirSync(path.join(home, "run", "vault-run")), [], "and gone once it ended");
  // A bot without a grant: you're asked, and you say no.
  const refusing = tool("ses_scout", "vault_run", { command: "env", variables: { T: "GitHub token" }, why: "Curious." });
  const asks = await box.asks();
  assert.equal(asks[0].botName, "Scout");
  assert.equal((await fromMac("POST", `kuvo/vault/asks/${asks[0].id}`, { answer: "no" }, key)).status, 200);
  const refused = (await refusing).value;
  assert.equal(refused.isError, true);
  assert.match(refused.text, /The user didn't let you use “GitHub token”/);
});

test("an agent that needs something asks you for it, and gets its name, never its value", async () => {
  const asking = tool("ses_shop", "vault_ask", { need: "a GitHub token", why: "To open the pull request.", site: "api.github.com" });
  const asks = await box.asks();
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
  const asks = await box.asks();
  assert.equal((await fromMac("POST", `kuvo/vault/asks/${asks[0].id}`, { answer: "once", item: items["App Store Connect key"].id }, key)).status, 200);
  assert.match((await asking).value.text, /for this once/);
  assert.equal((await tool("ses_scout", "vault_run", { command: "true", variables: { K: "App Store Connect key" }, why: "Upload." })).value.isError, false, "its one use");
  const again = tool("ses_scout", "vault_run", { command: "true", variables: { K: "App Store Connect key" }, why: "Upload again." });
  const next = await box.asks();
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

test("one fill for each call: what races the browser for it gets nothing more", async () => {
  running("ses_ship", "browser_sign_in", {});
  const first = await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://github.com", purpose: "sign-in" });
  assert.equal(first.status, 200);
  const again = await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://github.com", purpose: "sign-in" });
  assert.equal(again.status, 403);
  assert.ok(!JSON.stringify(again.value).includes(SECRET));
});

test("Pause isn't undone by deleting its file, nor a grant taken away given back by an older copy", async () => {
  const paused = path.join(home, "box", "vault", "paused.json");
  const grants = path.join(home, "box", "vault", "grants.json");
  const keptPaused = fs.readFileSync(paused, "utf8");
  fs.rmSync(paused);
  assert.match((await tool("ses_ship", "vault_run", { command: "true", variables: { T: "GitHub token" }, why: "x" })).value.text, /changed outside Kuvo Code/);
  fs.writeFileSync(paused, keptPaused);
  // Ship may use the token on its own; that's taken away; the copy from before is put back.
  const before = fs.readFileSync(grants, "utf8");
  await fromMac("POST", "kuvo/vault/grants", { item: items["GitHub token"].id, who: { bot: "bot_ship" }, how: null }, key);
  const now = fs.readFileSync(grants, "utf8");
  fs.writeFileSync(grants, before);
  try {
    const listed = await tool("ses_ship", "vault_items", {});
    assert.ok(!listed.value.text.includes("GitHub token"), listed.value.text);
  } finally {
    fs.writeFileSync(grants, now);
  }
  await fromMac("POST", "kuvo/vault/grants", { item: items["GitHub token"].id, who: { bot: "bot_ship" }, how: "own" }, key);
  assert.match((await tool("ses_ship", "vault_items", {})).value.text, /GitHub token/);
});

test("a value printed through echo and base64, or as hex, still shows as its item", async () => {
  const ran = await tool("ses_ship", "vault_run", { command: 'echo "$T" | base64; printf %s "$T" | od -An -tx1 | tr -d " \\n" | tr a-f A-F; echo', variables: { T: "GitHub token" }, why: "x" });
  assert.ok(!ran.value.text.includes(Buffer.from(TOKEN + "\n").toString("base64").replace(/=+$/, "")), ran.value.text);
  assert.ok(!ran.value.text.includes(Buffer.from(TOKEN).toString("hex").toUpperCase()), ran.value.text);
  assert.match(ran.value.text, /\[vault: GitHub token\]/);
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
  // (This test's own runtime, by its path: a login shell's PATH may have no node. The engine's Bun
  // is one only with BUN_BE_BUN, which Node leaves alone.)
  const ran = await tool("ses_ship", "vault_run", { command: `BUN_BE_BUN=1 "${process.execPath}" -e 'const b=require("fs").readFileSync(process.env.C).toString("base64");console.log(b);console.log(b.match(/.{1,76}/g).join("\\n"));console.log(b.match(/.{1,64}/g).join("\\n"))'`, variables: { C: "Signing cert" }, why: "x" });
  const base64 = bytes.toString("base64");
  for (const width of [76, 64]) for (const line of base64.match(new RegExp(`.{1,${width}}`, "g")).filter(each => each.length >= 8)) assert.ok(!ran.value.text.includes(line), `a ${width}-wide line shows: ${ran.value.text}`);
  assert.ok(!ran.value.text.includes(base64));
  assert.match(ran.value.text, /\[vault: Signing cert\]/);
});

test("the Mac's proof works once, and what answers on the vault's socket gets the Mac's key only by proving it holds it", async () => {
  const once = proof();
  assert.equal((await fromMac("POST", "kuvo/vault/key", once)).status, 200);
  assert.equal((await fromMac("POST", "kuvo/vault/key", once)).status, 403, "the same proof again");
  // Something else in the socket's place: a box whose `run/vault.sock` is a stand-in's, which
  // claims it's locked (to be sent the key), or passes what it's sent on to the real holder with
  // another request in its place (to have the Mac's proof read an item's values).
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(path.join(elsewhere, "run"), { recursive: true, mode: 0o700 });
  const socket = path.join(elsewhere, "run", "vault.sock");
  const real = path.join(home, "run", "vault.sock");
  const heard = [];
  let mode = "locked";
  const connections = new Set();
  const fake = net.createServer(connection => {
    connections.add(connection);
    connection.setEncoding("utf8");
    let given = "";
    let upstream = null;
    connection.on("data", chunk => {
      heard.push(chunk);
      given += chunk;
      if (mode === "locked") {
        if (given.includes("\n") && heard.length === 1) connection.write(JSON.stringify({ nonce: "fake-nonce-0123456789" }) + "\n");
        return;
      }
      // Relay: hello through, with the box's socket key (one that has it, as a process outside the
      // sandbox would); the request with a values read in its place.
      const lines = given.split("\n");
      if (!upstream && lines.length > 1) {
        upstream = net.createConnection(real);
        upstream.setEncoding("utf8");
        upstream.write(JSON.stringify({ ...JSON.parse(lines[0]), key: fs.readFileSync(path.join(home, "run", "socket.key"), "utf8").trim() }) + "\n");
        let back = "";
        upstream.on("data", answer => {
          back += answer;
          if (!connection.destroyed) connection.write(answer);
        });
        upstream.on("close", () => connection.destroy());
      }
      if (upstream && lines.length > 2 && !upstream.sent) {
        upstream.sent = true;
        const request = JSON.parse(lines[1]);
        request.method = "GET";
        request.path = `kuvo/vault/items/${items.GitHub.id}/values`;
        request.body = "";
        upstream.write(JSON.stringify(request) + "\n");
      }
    });
  });
  const umask = process.umask(0o177);
  await new Promise(resolve => fake.listen(socket, resolve));
  process.umask(umask);
  const viaFake = async (method, route, body) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: { ...env, KUVO_HOME: elsewhere }, stdio: ["pipe", "pipe", "ignore"] });
    child.stdin.end(JSON.stringify({ method, path: route, body, headers: { "x-kuvo-vault-key": key } }));
    let out = "";
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) out += chunk;
    const answer = JSON.parse(out.trim().split("\n").at(-1));
    return { status: answer.status, value: JSON.parse(answer.body || "{}") };
  };
  try {
    const locked = await viaFake("GET", "kuvo/vault");
    assert.equal(locked.status, 423, "a holder that can't prove it has the key isn't sent it, but to unlock");
    assert.ok(!heard.join("").includes(key), "its key never sent");
    mode = "relay";
    heard.length = 0;
    const swapped = await viaFake("GET", "kuvo/vault");
    assert.notEqual(swapped.status, 200, "the Mac's proof is for its own request, not one put in its place");
    assert.ok(!JSON.stringify(swapped.value).includes(SECRET));
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise(resolve => fake.close(resolve));
  }
  assert.equal((await fromMac("GET", "kuvo/vault", undefined, key)).status, 200, "the real one again");
});

test("the Mac reaches the vault with a proof for each request, never its key: one made for another request, or used again, gets nothing", async () => {
  const read = await fromMacProved("GET", "kuvo/vault");
  assert.equal(read.first.status, 200);
  assert.ok(read.first.value.items.length > 0);
  assert.equal((await read.again()).status, 403, "the same proof again");
  // A proof for a read, put on a change.
  const swapped = await fromMacProved("POST", "kuvo/vault/pause", { paused: true }, { proofFor: { method: "GET", route: "kuvo/vault" } });
  assert.equal(swapped.first.status, 403);
  // A proof for one body, sent with another.
  const changed = await fromMacProved("POST", "kuvo/vault/pause", { paused: true }, { proofFor: { method: "POST", route: "kuvo/vault/pause", body: { paused: false } } });
  assert.equal(changed.first.status, 403);
  assert.equal((await fromMacProved("GET", "kuvo/vault")).first.value.state.paused, false);
  // Its generations, which the Mac remembers to catch older copies put back.
  const generations = read.first.value.state.generations;
  assert.ok(generations.items > 0 && generations.grants > 0, JSON.stringify(generations));
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
  await fromMac("POST", "kuvo/vault/grants", { item: nas.value.item.id, who: { bot: "bot_ship" }, how: "own" }, key);
  calling.ses_ship = [];
  assert.equal((await box.local("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://nas", purpose: "sign-in", item: "NAS" })).status, 403, "only for its conversation's own call");
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://nas", purpose: "sign-in", item: "NAS" })).value.values.password, "nas-password-1");
  // A name without dots is only itself: not every site that ends with it.
  const dotless = await fromMac("POST", "kuvo/vault/items", { name: "Everything com", kind: "login", sites: ["com"], values: { password: "everything-1" } }, key);
  await fromMac("POST", "kuvo/vault/grants", { item: dotless.value.item.id, who: { bot: "bot_ship" }, how: "own" }, key);
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in", item: "Everything com" })).status, 403);
  await fromMac("POST", "kuvo/vault/pause", { paused: false, bot: "bot_ship" }, key);
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
  assert.equal(fs.existsSync(path.join(home, "run", "vault-run")), false, "a copy left behind is gone");
  // The Mac's requests carry its key, but only Unlock sends it to a holder that can't prove it has it.
  assert.equal((await fromMac("GET", "kuvo/vault", undefined, key)).status, 423);
  assert.equal((await fromMac("POST", "kuvo/vault/unlock", { key }, key)).status, 200);
  const listed = await fromMac("GET", "kuvo/vault", undefined, key);
  assert.equal(listed.value.state.locked, false);
  assert.equal(listed.value.state.agents, true);
  assert.equal(listed.value.items.length, 4);
  assert.equal((await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in" })).value.values.password, SECRET);
  await box.stop();
});

// The agent each conversation's commands get in the sandbox (vault/ssh.ts): the launcher notes the
// conversation, and hands its commands the agent's socket. Here, the notes as the launcher writes them.
const sshAgents = sshAgentsOf(home);
removeAtEnd(sshAgents);
function noteConversation(note, folder, where = home) {
  const notes = path.join(where, "run", "ssh-for");
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, `.${note}`), folder);
  fs.renameSync(path.join(notes, `.${note}`), path.join(notes, note));
}
// Its agent's socket, if it has one open now: yours alone from the moment it's there (a wait for
// an agent that never is fails).
const agentOf = note => {
  const socket = socketOf(note);
  try {
    return socket && (fs.statSync(socket).mode & 0o077) === 0 ? socket : null;
  } catch {
    return null;
  }
};
// Its agent's socket, open or not yet.
const socketOf = note => {
  const prefix = crypto.createHash("sha256").update(note).digest("hex").slice(0, 16);
  const found = fs.existsSync(sshAgents) && fs.readdirSync(sshAgents).find(name => name.startsWith(prefix) && name.endsWith(".sock"));
  return found ? path.join(sshAgents, found) : null;
};
async function sshAgentFor(note, folder) {
  noteConversation(note, folder);
  return appears(sshAgents, () => agentOf(note));
}
const folderNote = folder => `dir-${crypto.createHash("sha256").update(folder).digest("hex").slice(0, 32)}`;
// (Never blocking this process, whose stand-in engine the agent asks who a conversation is.)
const sshTool = (tool, args, socket) => {
  const pending = new Promise((resolve, reject) => {
    const child = spawn(tool, args, { signal: testSignal, env: { PATH: process.env.PATH, HOME: root, ...(socket ? { SSH_AUTH_SOCK: socket } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
  // Signing can run while the test waits for its ask. Observe cancellation now,
  // even if that wait aborts before the test reaches its await of this command.
  pending.catch(() => {});
  return pending;
};

test("an SSH key you keep for a project signs through its conversations' own agent, as git over SSH uses it, and another project's agent doesn't offer it (on Linux, only a key you keep for everyone)", async t => {
  // (A socket's path is at most 107 bytes on Linux: a machine's agents are in its own folder, which
  // fits, but this test's may be too deep in its temporary folder.)
  if (Buffer.byteLength(path.join(sshAgents, "x".repeat(33))) > (process.platform === "darwin" ? 103 : 107)) return t.skip("this test's folder is too deep for a socket's path: run it with a shorter TMPDIR");
  const awayMetadata = sessions.ses_away.metadata;
  t.after(() => {
    sessions.ses_away.metadata = awayMetadata;
    delete sessions.ses_scout.metadata;
  });
  box = await start();
  t.after(box.stop);
  let left = [];
  try {
    assert.equal((await fromMac("POST", "kuvo/vault/unlock", { key }, key)).status, 200);
    const file = path.join(root, "deploy");
    assert.equal((await sshTool("ssh-keygen", ["-q", "-N", "", "-t", "ed25519", "-C", "deploy", "-f", file])).status, 0);
    const added = await fromMac("POST", "kuvo/vault/items", { name: "Deploy key", kind: "key", values: { private_key: fs.readFileSync(file, "utf8") } }, key);
    assert.equal(added.status, 200, JSON.stringify(added.value));
    assert.equal(JSON.stringify(added.value).includes("PRIVATE KEY"), false, "the key itself never comes back");
    // Only in the vault now: ssh-keygen would sign with the file beside the public key.
    fs.rmSync(file);
    await fromMac("POST", "kuvo/vault/grants", { item: added.value.item.id, who: { project }, how: "own" }, key);
    const fingerprint = (await sshTool("ssh-keygen", ["-l", "-f", `${file}.pub`])).stdout.split(" ")[1];
    // On Linux any conversation's commands could reach another's agent (vault/ssh.ts): only what
    // you keep for everyone is offered there.
    const everyoneOnly = process.platform !== "darwin";
    if (everyoneOnly) {
      assert.equal((await sshTool("ssh-add", ["-l"], await sshAgentFor("ses_shop", project))).status, 1, "a project's key, on Linux");
      await fromMac("POST", "kuvo/vault/grants", { item: added.value.item.id, who: { everyone: true }, how: "own" }, key);
    }

    // A conversation in the project, and a command of yours in it with none.
    for (const [note, folder] of [["ses_shop", project], [folderNote(path.join(project, "web")), path.join(project, "web")]]) {
      const socket = await sshAgentFor(note, folder);
      assert.ok(socket, `an agent for ${note}`);
      const listed = await sshTool("ssh-add", ["-l"], socket);
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, new RegExp(fingerprint.replace(/[+/]/g, "\\$&")));
      fs.writeFileSync(path.join(root, "commit"), "a commit\n");
      const signed = await sshTool("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", `${file}.pub`, path.join(root, "commit")], socket);
      assert.equal(signed.status, 0, signed.stderr);
      fs.rmSync(path.join(root, "commit.sig"));
    }
    // Another project's conversation, a bot's, and one noted with another folder than its own (the
    // engine's word wins): their agents offer nothing.
    const elsewhere = path.join(root, "projects", "blog");
    fs.mkdirSync(elsewhere, { recursive: true });
    for (const [note, folder] of everyoneOnly ? [] : [[folderNote(elsewhere), elsewhere], ["ses_scout", path.join(home, "bots", "bot_scout", "workspace")], ["ses_ship", project]]) {
      const socket = await sshAgentFor(note, folder);
      assert.ok(socket, `an agent for ${note}`);
      assert.equal((await sshTool("ssh-add", ["-l"], socket)).status, 1, "no keys");
      assert.notEqual((await sshTool("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", `${file}.pub`, `${file}.pub`], socket)).status, 0);
    }
    // A note by folder that names another folder than its sum's opens nothing: once a note made
    // after it has its agent, the box has looked at it too (it reads all its notes each time).
    const wrong = folderNote(elsewhere).replace(/.$/, c => (c === "0" ? "1" : "0"));
    noteConversation(wrong, project);
    await sshAgentFor(folderNote(path.join(project, "api")), path.join(project, "api"));
    assert.equal(socketOf(wrong), null);
    // On Autopilot a key it may use only by asking signs nothing, at once, and you aren't asked.
    const askFirst = path.join(root, "ask-first");
    assert.equal((await sshTool("ssh-keygen", ["-q", "-N", "", "-t", "ed25519", "-C", "ask-first", "-f", askFirst])).status, 0);
    const kept = await fromMac("POST", "kuvo/vault/items", { name: "Ask-first key", kind: "key", values: { private_key: fs.readFileSync(askFirst, "utf8") } }, key);
    fs.rmSync(askFirst);
    await fromMac("POST", "kuvo/vault/grants", { item: kept.value.item.id, who: { everyone: true }, how: "ask" }, key);
    fs.writeFileSync(path.join(root, "commit"), "a commit\n");
    const undone = await sshTool("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", `${askFirst}.pub`, path.join(root, "commit")], await sshAgentFor("ses_away", project));
    assert.notEqual(undone.status, 0, "nothing signed");
    assert.deepEqual((await fromMac("GET", "kuvo/vault/asks", undefined, key)).value.asks ?? [], []);
    // Signing again and again is one thing left, in your vault's activity.
    assert.notEqual((await sshTool("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", `${askFirst}.pub`, path.join(root, "commit")], await sshAgentFor("ses_away", project))).status, 0);
    const noted = (await fromMac("GET", "kuvo/vault/activity", undefined, key)).value.entries.filter(each => each.how === "autopilot" && each.itemName === "Ask-first key");
    assert.equal(noted.length, 1);
    // Turned back to Interactive, it asks you again at once: being left undone wasn't your no.
    const metadata = sessions.ses_away.metadata;
    delete sessions.ses_away.metadata;
    const again = sshTool("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", `${askFirst}.pub`, path.join(root, "commit")], await sshAgentFor("ses_away", project));
    const [card] = await box.asks();
    assert.equal((await fromMac("POST", `kuvo/vault/asks/${card.id}`, { answer: "once" }, key)).status, 200);
    assert.equal((await again).status, 0);
    fs.rmSync(path.join(root, "commit.sig"));
    sessions.ses_away.metadata = metadata;
    // A command of yours in a bot's folder is yours: its bot on Autopilot doesn't leave it undone,
    // though that bot's own, started after it and watched the same way, is.
    const inScout = path.join(home, "bots", "bot_scout", "workspace");
    const sign = (file, socket) => sshTool("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", `${askFirst}.pub`, path.join(root, file)], socket);
    fs.writeFileSync(path.join(root, "commit-agent"), "a commit\n");
    const yours = sign("commit", await sshAgentFor(folderNote(inScout), inScout));
    const [mine] = await box.asks();
    const scoutsOwn = sign("commit-agent", await sshAgentFor("ses_scout", inScout));
    while ((await box.asks()).length < 2);
    sessions.ses_scout.metadata = { kuvo: { autopilot: true } };
    assert.notEqual((await scoutsOwn).status, 0, "its bot's is left undone");
    delete sessions.ses_scout.metadata;
    assert.equal((await fromMac("POST", `kuvo/vault/asks/${mine.id}`, { answer: "once" }, key)).status, 200, "it still waits for you");
    assert.equal((await yours).status, 0);
    fs.rmSync(path.join(root, "commit.sig"));
    fs.rmSync(path.join(root, "commit-agent"));
    assert.equal((await fromMac("DELETE", `kuvo/vault/items/${kept.value.item.id}`, undefined, key)).status, 200);
    // Paused, the conversation's agent offers nothing either.
    await fromMac("POST", "kuvo/vault/pause", { paused: true, bot: "ses_shop" }, key);
    assert.equal((await sshTool("ssh-add", ["-l"], await sshAgentFor("ses_shop", project))).status, 1, "paused");
    await fromMac("POST", "kuvo/vault/pause", { paused: false, bot: "ses_shop" }, key);
    // A key you remove is gone from every agent at once.
    const socket = await sshAgentFor("ses_shop", project);
    assert.equal((await sshTool("ssh-add", ["-l"], socket)).status, 0);
    assert.equal((await fromMac("DELETE", `kuvo/vault/items/${added.value.item.id}`, undefined, key)).status, 200);
    assert.equal((await sshTool("ssh-add", ["-l"], socket)).status, 1, "removed");
    left = fs.readdirSync(sshAgents);
  } finally {
    await box.stop();
  }
  // A box killed before it could close them leaves its sockets; the next one to hold the vault
  // clears them, and opens its own. A note of a conversation untouched for over a month goes.
  const old = path.join(home, "run", "ssh-for", folderNote(path.join(root, "projects", "gone")));
  fs.writeFileSync(old, path.join(root, "projects", "gone"));
  const monthAgo = new Date(Date.now() - 31 * 24 * 60 * 60_000);
  fs.utimesSync(old, monthAgo, monthAgo);
  box = await start();
  t.after(box.stop);
  try {
    // (Each made anew, none of the old ones left.)
    const now = await appears(sshAgents, () => {
      const names = fs.existsSync(sshAgents) ? fs.readdirSync(sshAgents) : [];
      return names.length === left.length && !names.some(name => left.includes(name)) && names;
    });
    assert.equal(now.length, left.length, "an agent for each conversation again");
    assert.deepEqual(now.filter(name => left.includes(name)), [], "none of the old ones");
    assert.equal(fs.existsSync(old), false, "a month-old note");
  } finally {
    await box.stop();
  }
});

test("a Mac whose home is short keeps its SSH agents in the home, where the tests look for them", async t => {
  // (GitHub's macOS runners' home is `/Users/runner`: 63-64 bytes to this file's agents' folder, under
  // the 68 from which the box keeps them in /private/tmp instead. This file looked in /private/tmp on
  // every Mac, so there it waited 60 s for an agent the box had opened in the home, #410.)
  if (process.platform !== "darwin") return t.skip("only a Mac moves an agent's folder out of a long home");
  const short = fs.mkdtempSync(`/tmp/kv-ssh-${process.pid}-`);
  removeAtEnd(short);
  const agents = path.join(short, "run", "ssh-agents");
  assert.equal(sshAgentsOf(short), agents, "the box's own folder, for a home this short");
  const other = await start({ KUVO_HOME: short });
  try {
    const folder = path.join(short, "project");
    fs.mkdirSync(folder);
    noteConversation(folderNote(folder), folder, short);
    const socket = await appears(agents, () => {
      const found = fs.existsSync(agents) && fs.readdirSync(agents).find(name => name.endsWith(".sock"));
      return found && (fs.statSync(path.join(agents, found)).mode & 0o077) === 0 ? path.join(agents, found) : null;
    });
    assert.ok(socket, "an agent in the folder the test looks in");
  } finally {
    await other.stop();
  }
});

test("the variable that opens the vault to agents opens it only in a test's own folder, never in a real box's, where a line in your shell's profile could set it", async () => {
  const real = path.join(root, "run.kuvo.code", "box");
  fs.mkdirSync(real, { recursive: true });
  // Named as it is, through a link to it, and (on a Mac's disk, where case doesn't count) in other letters.
  const link = path.join(root, "a-link");
  fs.symlinkSync(real, link);
  const homes = [real, link];
  if (process.platform === "darwin") homes.push(path.join(root, "RUN.Kuvo.Code", "box"));
  for (const home of homes) {
    const other = await start({ KUVO_HOME: home, KUVO_VAULT_AGENTS: "1" });
    try {
      assert.deepEqual((await other.local("GET", "kuvo/vault/tools")).value.tools, [], home);
    } finally {
      await other.stop();
    }
  }
});

test("without the box's own process, a request says so plainly", async () => {
  const answer = await fromMac("GET", "kuvo/vault", undefined, key);
  assert.equal(answer.status, 503);
  assert.match(answer.value.message, /isn't open/);
});

test("on a box whose agents' commands aren't fenced, agents get none of the vault's tools, but a sign-in you let them make on their own still fills, as before the vault", async () => {
  box = await start({ KUVO_VAULT_AGENTS: "" });
  try {
    assert.deepEqual((await box.local("GET", "kuvo/vault/tools")).value.tools, [], "no vault tools listed");
    const listed = await tool("ses_ship", "vault_items", {});
    assert.equal(listed.value.isError, true);
    assert.match(listed.value.text, /isn't open to agents/);
    assert.match(listed.value.text, /without an item/, "it says how to sign in instead, never to call the tool it just called");
    assert.doesNotMatch(listed.value.text, /GitHub|NAS/, "no item named");
    // The box started again, so its vault waits for a client's key, as after any start.
    assert.equal((await fromMac("POST", "kuvo/vault/unlock", { key }, key)).status, 200);
    // GitHub is Ship's to sign in to on its own: filled into the page, as Kuvo Code did before.
    const fill = await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in" });
    assert.equal(fill.status, 200);
    assert.equal(fill.value.values.password, SECRET);
    // An item named, or a field: the vault's own, so not yet. Its browser asks you instead.
    const named = await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "sign-in", item: "GitHub" });
    assert.equal(named.status, 404);
    assert.equal(named.value.values, undefined);
    const field = await fillAs({ session: "ses_ship", origin: "https://github.com", purpose: "field", item: "GitHub", field: "password" });
    assert.equal(field.status, 404);
    assert.equal(field.value.values, undefined);
    const state = await fromMac("GET", "kuvo/vault", undefined, key);
    assert.equal(state.value.state.agents, false, "your Vault page can say so");
    assert.equal(state.value.items.length, 4, "your items are all still there");
  } finally {
    await box.stop();
  }
});
