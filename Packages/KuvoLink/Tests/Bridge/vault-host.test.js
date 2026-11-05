// This Mac's vault (PROTOCOL.md, "Vault"): its values in the Keychain, through its app's host
// interface (`vault/get`, `vault/set`, `vault/delete`), never in the box's own folder; it needs no
// unlock key. Here a stand-in for the app keeps them in memory. (A machine's: vault.test.js.)
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/vault-host.test.js`.
import "./test-safety.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { script, standInHost } from "./bot-keys-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvh-"));
const home = path.join(root, "box");
const PASSWORD = "host-password-not-a-key";
const host = await standInHost(PASSWORD);
// With the vault's two secrets, as the app starts its box (AppModel.boxEnvironment).
host.vaultSecret = crypto.randomBytes(32).toString("hex");
const env = { ...process.env, HOME: root, KUVO_HOME: home, KUVO_HOST_URL: host.url, KUVO_HOST_PASSWORD: PASSWORD, KUVO_HOST_VAULT_SECRET: host.vaultSecret, KUVO_VAULT_FILE_KEY: crypto.randomBytes(32).toString("base64url"), KUVO_VAULT_AGENTS: "1" };
for (const name of ["KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX"]) delete env[name];
removeAtEnd(root);

const SECRET = "mac-secret-sauce-42";
let engine;
let box;
// Each sign-in the engine runs, its own call (the box fills once for each).
let calls = 0;

before(async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.mkdirSync(path.join(home, "bots", "bot_ship"), { recursive: true });
  fs.writeFileSync(path.join(home, "bots", "bot_ship", "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_ship", name: "Ship" }));
  fs.writeFileSync(path.join(home, "bots", "bot_ship", "session"), "ses_ship");
  // (And another, whose grant a test takes away.)
  fs.mkdirSync(path.join(home, "bots", "bot_scout"), { recursive: true });
  fs.writeFileSync(path.join(home, "bots", "bot_scout", "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout", name: "Scout" }));
  fs.writeFileSync(path.join(home, "bots", "bot_scout", "session"), "ses_scout");
  engine = http.createServer((request, response) => {
    // Its browser_sign_in, running as the fill comes (the box answers a fill only for one: vault/who.ts).
    if (request.url.startsWith("/api/session/ses_ship/message")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [{ type: "assistant", content: [{ type: "tool", id: `call_${++calls}`, name: "kuvo-browser_browser_sign_in", state: { status: "running", input: {} } }] }] }));
    }
    const found = request.url.startsWith("/api/session/ses_ship");
    response.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(found ? { data: { id: "ses_ship", title: "Ship", location: { directory: path.join(home, "bots", "bot_ship") } } } : {}));
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "engine-pw" }));
  box = await startBox();
});

// This Mac's box, as the app starts it.
async function startBox() {
  const child = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  const url = await new Promise(resolve => child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]).url); }));
  // `app`: this Mac's own app asking (`x-kuvo-from: app`); without it, something else on this Mac.
  const route = async (method, path, body, app = true) => {
    const response = await fetch(`${url}/${path}`, { method, headers: { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json", ...(app ? { "x-kuvo-from": "app" } : {}) }, body: body && method !== "GET" ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  return { route, stop: () => { child.stdin.end(); return new Promise(resolve => child.once("exit", resolve)); } };
}
atEnd(async () => { await box?.stop(); engine?.closeAllConnections(); engine?.close(); });

let item;

test("an item added on this Mac keeps its values in the Keychain, through its app, and nothing of them in the box's folder", async () => {
  const state = (await box.route("GET", "kuvo/vault")).value.state;
  assert.deepEqual({ made: state.made, locked: state.locked, store: state.store }, { made: true, locked: false, store: "keychain" });
  const added = await box.route("POST", "kuvo/vault/items", { kind: "login", name: "Shop admin", sites: ["https://admin.shop.example/login"], username: "ops", values: { password: SECRET } });
  assert.equal(added.status, 200);
  item = added.value.item;
  assert.equal(added.value.key, undefined, "this Mac's vault has no key to give");
  assert.deepEqual(item.sites, ["admin.shop.example"]);
  assert.deepEqual(host.vault.get(item.id), { password: SECRET });
  const folder = fs.readdirSync(path.join(home, "box", "vault"));
  assert.ok(!folder.includes("values") && !folder.includes("key.json"), folder.join(", "));
  for (const name of folder) assert.ok(!fs.readFileSync(path.join(home, "box", "vault", name), "utf8").includes(SECRET));
  assert.ok(!host.asked.some(each => JSON.stringify(each).includes(SECRET)), "the stand-in's log of calls leaves values out, as the app's would");
  assert.equal((await box.route("POST", "kuvo/vault/key", {})).status, 409);
});

test("its values come back from the Keychain for a client, and for a bot's fill on the item's site", async () => {
  assert.equal((await box.route("GET", `kuvo/vault/items/${item.id}/values`)).value.values.password, SECRET);
  assert.equal((await box.route("POST", "kuvo/vault/grants", { item: item.id, who: { bot: "bot_ship" }, how: "own" })).status, 200);
  // Only for the app's own browser: anything else on this Mac is turned away.
  assert.equal((await box.route("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://admin.shop.example", purpose: "sign-in" }, false)).status, 403);
  const filled = await box.route("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://admin.shop.example", purpose: "sign-in" });
  assert.equal(filled.status, 200);
  assert.equal(filled.value.values.password, SECRET);
});

test("something else on this Mac, without the app's word, can't list or read it", async () => {
  assert.equal((await box.route("GET", "kuvo/vault", undefined, false)).status, 403);
  assert.equal((await box.route("GET", `kuvo/vault/items/${item.id}/values`, undefined, false)).status, 403);
});

test("a host.json rewritten by something on this Mac sends nothing of the vault elsewhere: the app proves itself with a secret no file holds", async () => {
  // Something that read and rewrote the box's folder: its own server, with a password of its own,
  // which it can prove itself with, as the app would.
  const password = "rewritten-password";
  const heard = [];
  const fake = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    heard.push(request.url);
    const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const at = `127.0.0.1:${fake.address().port}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/hello" ? { proof: crypto.createHmac("sha256", password).update(`kuvo-host-hello\0${given.nonce}\0${at}`).digest("hex"), vaultProof: "not-the-vaults" } : { values: {} }));
  });
  await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve));
  const file = path.join(home, "run", "host.json");
  fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${fake.address().port}`, password }));
  try {
    const shown = await box.route("GET", `kuvo/vault/items/${item.id}/values`);
    assert.notEqual(shown.status, 200);
    assert.ok(!heard.some(url => url.startsWith("/vault/")), `nothing of the vault went there: ${heard.join(", ")}`);
  } finally {
    fs.rmSync(file, { force: true });
    fake.closeAllConnections();
    await new Promise(resolve => fake.close(resolve));
  }
  assert.equal((await box.route("GET", `kuvo/vault/items/${item.id}/values`)).value.values.password, SECRET, "from the app again");
});

test("an older copy of the vault's files put back while the box was stopped counts for nothing: the app keeps their newest generations", async () => {
  const grants = path.join(home, "box", "vault", "grants.json");
  await box.route("POST", "kuvo/vault/grants", { item: item.id, who: { bot: "bot_scout" }, how: "own" });
  const before = fs.readFileSync(grants, "utf8");
  // Taken away, then the copy from before put back while the box is stopped.
  await box.route("POST", "kuvo/vault/grants", { item: item.id, who: { bot: "bot_scout" }, how: null });
  await box.stop();
  fs.writeFileSync(grants, before);
  box = await startBox();
  // It reads the app's generations before it answers: the copy put back is seen for what it is.
  const state = (await box.route("GET", "kuvo/vault")).value;
  assert.equal(state.state.tampered, true);
  assert.ok(!state.grants.some(grant => grant.who.bot === "bot_scout"), "the grant taken away stays away");
  await box.route("POST", "kuvo/vault/grants", { item: item.id, who: { bot: "bot_ship" }, how: "own" });
});

test("an app from before the generations were has its files' own taken once; a Keychain that can't be read keeps agents waiting, and says why", async () => {
  // As an older app left it: the files signed, no generations kept.
  await box.stop();
  host.generations = {};
  host.adopt = true;
  box = await startBox();
  const adopted = (await box.route("GET", "kuvo/vault")).value;
  assert.notEqual(adopted.state.tampered, true, "its files as they are, this once");
  assert.ok(adopted.items.length > 0);
  assert.ok(host.generations.items > 0, "and kept from now on");
  // Its Keychain locked as the box starts: agents wait, told why.
  await box.stop();
  host.unreadable = true;
  box = await startBox();
  try {
    const filled = await box.route("POST", "kuvo/vault/fill", { session: "ses_ship", origin: "https://admin.shop.example", purpose: "sign-in" });
    assert.equal(filled.status, 403);
    assert.match(filled.value.message, /Keychain can't be read/);
  } finally {
    host.unreadable = false;
  }
});

test("with the app not answering, what needs the Keychain says so; removing an item takes its values from the Keychain", async () => {
  host.down = true;
  const stalled = await box.route("GET", `kuvo/vault/items/${item.id}/values`);
  assert.equal(stalled.status, 503);
  assert.ok(stalled.value.message);
  assert.equal((await box.route("GET", "kuvo/vault")).value.items.length, 1, "the list is the box's own");
  host.down = false;
  assert.equal((await box.route("DELETE", `kuvo/vault/items/${item.id}`)).status, 200);
  assert.equal(host.vault.has(item.id), false);
  assert.deepEqual((await box.route("GET", "kuvo/vault")).value.items, []);
});
