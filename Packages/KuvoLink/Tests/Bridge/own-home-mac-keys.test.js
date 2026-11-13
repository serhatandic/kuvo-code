// A Mac's box in a home of its own does with its keys what its app did before the move (#333 piece
// 6a, PROTOCOL.md "This Mac's box: its keys, for its app"): its keys are its helper's then, which the
// app never reads. It signs this Mac's proofs to your machines' vaults, and gives the app the keys an
// earlier Kuvo Code kept for a machine's bot, then takes them away once the machine has them; only for
// Kuvo Code on this Mac, never a phone or a command anyone could run (`box route`). Its keys come from
// its host (a stand-in keeps them in memory, as the helper keeps them in the Keychain), and are never
// made by the box. Its catalog is the release's Mac one.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { boxRoute, script, served } from "./bot-keys-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-home-keys-")));
const home = path.join(root, "home");
const box = path.join(home, ".kuvo-code");
fs.mkdirSync(path.join(box, "box"), { recursive: true });
fs.writeFileSync(path.join(box, "box", "kind"), "mac\n");
// The release's two catalogs: the Mac's own is the one read.
fs.mkdirSync(path.join(box, "bin"), { recursive: true });
fs.writeFileSync(path.join(box, "bin", "integrations.json"), JSON.stringify({ integrations: [{ id: "linear", title: "Linear", way: "official", settings: { type: "remote", url: "https://mcp.linear.app/mcp" } }] }));
fs.writeFileSync(path.join(box, "bin", "integrations-mac.json"), JSON.stringify({ integrations: [
  { id: "linear", title: "Linear", way: "official", settings: { type: "remote", url: "https://mcp.linear.app/mcp" } },
  { id: "calendar", title: "Calendar", way: "package", macOnly: true, settings: { type: "local", command: ["kuvo-npx", "calendar-mcp"] } },
] }));

// This Mac's keys as its helper keeps them (raw 32 bytes each, base64url).
const identity = { key: crypto.randomBytes(32).toString("base64url"), secret: crypto.randomBytes(32).toString("base64url"), sign: crypto.randomBytes(32).toString("base64url") };
const PASSWORD = "host-password-not-a-key";
const host = { keys: new Map(), identity: { ...identity }, asked: [] };
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const answer = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (request.url === "/hello") {
    const { nonce } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return answer(200, { proof: crypto.createHmac("sha256", PASSWORD).update(`kuvo-host-hello\0${nonce}\0${host.url.replace("http://", "")}`).digest("hex") });
  }
  if (request.headers.authorization !== `Bearer ${PASSWORD}`) return answer(401, {});
  const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  host.asked.push(request.url);
  switch (request.url) {
    // Locked: what the helper says while your Keychain can't give them.
    case "/link/identity": return host.identity ? answer(200, host.identity) : answer(503, { message: "The Keychain is locked." });
    case "/keys/names": return answer(200, { names: [...host.keys.keys()].filter(name => name.startsWith(given.prefix ?? "") && name.endsWith(given.suffix ?? "")) });
    case "/keys/get": return host.keys.has(given.name) ? answer(200, { value: host.keys.get(given.name) }) : answer(404, {});
    case "/keys/delete": host.keys.delete(given.name); return answer(200, {});
    default: return answer(404, {});
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
atEnd(() => { server.closeAllConnections(); server.close(); });
host.url = `http://127.0.0.1:${server.address().port}`;

Object.assign(process.env, { HOME: home, KUVO_HOME: box, KUVO_KEYS_ON_HOST: "1", KUVO_HOST_URL: host.url, KUVO_HOST_PASSWORD: PASSWORD });
const link = await import(script);
removeAtEnd(root);
const handle = link.engineHandler(() => null, { name: "this Mac" }, () => null);

/** A route on this box: as Kuvo Code on this Mac asks (`app`), over `box route` (`mac`, as anything
 * on this Mac can), or from a phone. */
async function ask(method, route, body, from = "app") {
  const request = { method, path: route, headers: { "content-type": "application/json" }, body: Buffer.from(body ? JSON.stringify(body) : ""),
    ...(from === "app" ? { fromApp: true } : from === "mac" ? { fromMac: true } : {}) };
  const phone = from === "phone" ? { key: crypto.randomBytes(32) } : undefined;
  let status = 0, text = "";
  for await (const piece of handle(request, phone)) {
    if (piece.head) status = piece.head.status;
    if (piece.body) text += piece.body.toString("utf8");
  }
  return { status, value: text ? JSON.parse(text) : {} };
}

const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const publicOf = (prefix, seed) => crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(seed, "base64url")]), format: "der", type: "pkcs8" }));
const raw = key => key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const signedBy = (seed, text, proof) => crypto.verify(null, Buffer.from(text), publicOf(ED_PKCS8, seed), Buffer.from(proof, "base64url"));

test("it signs this Mac's proof for a machine's vault key with the Mac's own keys, as the app did", async () => {
  const before = Date.now();
  const { status, value } = await ask("POST", "kuvo/box/proof", { machine: "mini.local" });
  assert.equal(status, 200);
  assert.equal(value.mac, raw(publicOf(X_PKCS8, identity.key)), "this Mac's public link key, as its machines know it");
  assert.ok(value.at >= before && value.at <= Date.now());
  assert.match(value.nonce, /^[A-Za-z0-9_-]{24}$/);
  assert.ok(signedBy(identity.sign, `kuvo-vault-key\0mini.local\0${value.at}\0${value.nonce}`, value.proof), "signed with its signing key");
  // A nonce of its own each time: a machine takes each once.
  assert.notEqual((await ask("POST", "kuvo/box/proof", { machine: "mini.local" })).value.nonce, value.nonce);
});

test("a proof for one request covers that request alone: its method, path and body's hash", async () => {
  const hash = crypto.createHash("sha256").update('{"paused":true}').digest("hex");
  const { status, value } = await ask("POST", "kuvo/box/proof", { machine: "mini.local", method: "post", path: "kuvo/vault/pause", hash });
  assert.equal(status, 200);
  assert.ok(signedBy(identity.sign, `kuvo-vault-request\0mini.local\0${value.at}\0${value.nonce}\0POST\0kuvo/vault/pause\0${hash}`, value.proof));
  assert.ok(!signedBy(identity.sign, `kuvo-vault-key\0mini.local\0${value.at}\0${value.nonce}`, value.proof), "not a proof for its vault's key");
  for (const asked of [{ machine: "mini.local", method: "POST", path: "kuvo/vault/pause" }, { machine: "mini.local", method: "POST", path: "kuvo/vault/pause", hash: "not-a-hash" },
    { machine: "" }, { machine: "a\0b" }, {}]) {
    assert.equal((await ask("POST", "kuvo/box/proof", asked)).status, 400, JSON.stringify(asked));
  }
});

test("a machine this Mac set up takes the proofs its box signs: its vault's key, then a request with that request's proof alone", async () => {
  // The machine's box, in a process of its own (as the app reaches it over SSH), its link naming this
  // Mac as the one that set it up: its link key and its signing key's public half.
  const mac = raw(publicOf(X_PKCS8, identity.key));
  const machine = path.join(root, "mini", ".kuvo-code");
  fs.mkdirSync(path.join(machine, "run"), { recursive: true });
  fs.writeFileSync(path.join(machine, "run", "link.json"), JSON.stringify({ id: "mini.local", macs: [mac], mac, macSigns: { [mac]: raw(publicOf(ED_PKCS8, identity.sign)) } }));
  const env = { PATH: process.env.PATH, HOME: path.dirname(machine), KUVO_HOME: machine, TMPDIR: process.env.TMPDIR ?? os.tmpdir() };
  // Its server running, which holds its vault (a request over SSH is passed to it).
  const machineServer = await served(env);
  atEnd(() => machineServer.stop());
  const forKey = (await ask("POST", "kuvo/box/proof", { machine: "mini.local" })).value;
  const given = await boxRoute({ method: "POST", path: "kuvo/vault/key", body: forKey }, env);
  assert.equal(given.status, 200, JSON.stringify(given.value));
  assert.match(given.value.key, /^[A-Za-z0-9_-]{20,}$/, "its vault's key, given to the Mac that set it up");
  assert.equal((await boxRoute({ method: "POST", path: "kuvo/vault/key", body: forKey }, env)).status, 403, "each proof once");

  // A request with its own proof, never the key: covered by its body as sent.
  const bodyText = JSON.stringify({ paused: true });
  const hash = crypto.createHash("sha256").update(bodyText).digest("hex");
  const forRequest = (await ask("POST", "kuvo/box/proof", { machine: "mini.local", method: "POST", path: "kuvo/vault/pause", hash })).value;
  const header = Buffer.from(JSON.stringify(forRequest)).toString("base64url");
  const paused = await boxRoute({ method: "POST", path: "kuvo/vault/pause", bodyText, headers: { "x-kuvo-vault-proof": header } }, env);
  assert.equal(paused.status, 200, JSON.stringify(paused.value));
  assert.equal(paused.value.paused, true);
  // The same proof for another body: refused.
  const other = await boxRoute({ method: "POST", path: "kuvo/vault/pause", bodyText: JSON.stringify({ paused: false }), headers: { "x-kuvo-vault-proof": header } }, env);
  assert.equal(other.status, 403);
  await machineServer.stop();
});

test("only Kuvo Code on this Mac gets one: never a phone, nor a command anyone on this Mac could run", async () => {
  for (const from of ["mac", "phone"]) {
    const { status, value } = await ask("POST", "kuvo/box/proof", { machine: "mini.local" }, from);
    assert.equal(status, 403, from);
    assert.equal(value.proof, undefined);
  }
  assert.equal((await ask("GET", "kuvo/box/proof")).status, 405);
});

test("while its Keychain can't give the keys, it says so and signs nothing: it never makes keys of its own", async () => {
  host.identity = null;
  try {
    const { status, value } = await ask("POST", "kuvo/box/proof", { machine: "mini.local" });
    assert.equal(status, 503);
    assert.match(value.message, /Keychain/);
  } finally {
    host.identity = { ...identity };
  }
  assert.equal(fs.existsSync(path.join(box, "run", "link.json")) && JSON.parse(fs.readFileSync(path.join(box, "run", "link.json"), "utf8")).sign !== undefined, false, "no key written anywhere");
});

test("the keys an earlier Kuvo Code kept for a machine's bot: given to the app, and taken away once the machine has them", async () => {
  host.keys.set("KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT", "tok_scout");
  host.keys.set("KUVO_KEY_LINEAR_TOKEN__BOT_SCOUT", "lin_scout");
  host.keys.set("KUVO_KEY_TODOIST_API_KEY__BOT_HERALD", "tok_herald");
  host.keys.set("KUVO_KEY_TODOIST_API_KEY", "tok_shared");
  const { status, value } = await ask("GET", "kuvo/box/kept-keys?bot=bot_scout");
  assert.equal(status, 200);
  assert.deepEqual(value.keys, { KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT: "tok_scout", KUVO_KEY_LINEAR_TOKEN__BOT_SCOUT: "lin_scout" }, "that bot's own alone");

  // Only those it gave: another bot's, or a shared key, isn't taken away this way.
  for (const names of [["KUVO_KEY_TODOIST_API_KEY__BOT_HERALD"], ["KUVO_KEY_TODOIST_API_KEY"], "KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT"]) {
    assert.equal((await ask("DELETE", "kuvo/box/kept-keys?bot=bot_scout", { names })).status, 400);
  }
  assert.equal((await ask("DELETE", "kuvo/box/kept-keys?bot=bot_scout", { names: ["KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT"] })).status, 200);
  assert.deepEqual([...host.keys.keys()].sort(), ["KUVO_KEY_LINEAR_TOKEN__BOT_SCOUT", "KUVO_KEY_TODOIST_API_KEY", "KUVO_KEY_TODOIST_API_KEY__BOT_HERALD"]);
  assert.equal((await ask("GET", "kuvo/box/kept-keys?bot=bot_herald", undefined, "mac")).status, 403, "never over box route");
  assert.equal((await ask("GET", "kuvo/box/kept-keys?bot=bot_herald", undefined, "phone")).status, 403);
  assert.equal((await ask("GET", "kuvo/box/kept-keys")).status, 400);
});

test("a bot that's this box's own keeps its keys: they're its, at kuvo/bots/<id>/keys", async () => {
  const folder = path.join(box, "bots", "bot_local");
  fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_local", name: "Local", job: "", look: {}, project: null, created: 0, updated: 0 }));
  fs.writeFileSync(path.join(folder, "session"), "ses_local");
  host.keys.set("KUVO_KEY_TODOIST_API_KEY__BOT_LOCAL", "tok_local");
  assert.equal((await ask("GET", "kuvo/box/kept-keys?bot=bot_local")).status, 409);
  assert.equal((await ask("DELETE", "kuvo/box/kept-keys?bot=bot_local", { names: ["KUVO_KEY_TODOIST_API_KEY__BOT_LOCAL"] })).status, 409);
  assert.equal(host.keys.get("KUVO_KEY_TODOIST_API_KEY__BOT_LOCAL"), "tok_local");
});

test("its integrations are the Mac's own catalog, those that use the Mac's apps among them", () => {
  assert.equal(link.INTEGRATIONS_FILE, path.join(box, "bin", "integrations-mac.json"));
  assert.deepEqual(link.integrationCatalog().map(entry => entry.id), ["linear", "calendar"]);
});
