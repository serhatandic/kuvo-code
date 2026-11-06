// This Mac's box finds its app's host interface where the app says it answers now (`run/host.json`,
// PROTOCOL.md, "Host interface"), read again for each call: while the app isn't answering, its keys
// can't be reached and that's said; once the app's host interface is back, at another address, the
// box reaches it at once, without starting again.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { script, standInHost } from "./bot-keys-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-host-file-")));
const home = path.join(root, "box");
const engineConfig = path.join(root, "opencode", "config");
const keyFiles = path.join(root, "app-temp", "integration-keys");
Object.assign(process.env, { KUVO_HOME: home, KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: engineConfig, KUVO_KEYS: keyFiles, KUVO_INTEGRATIONS: path.join(root, "integrations"), KUVO_KEYS_ON_HOST: "1" });
delete process.env.KUVO_HOST_URL;
delete process.env.KUVO_HOST_PASSWORD;
const link = await import(script);
removeAtEnd(root);

const shared = "KUVO_KEY_TODOIST_API_KEY";
const catalogFile = path.join(root, "integrations.json");
fs.writeFileSync(catalogFile, JSON.stringify({ integrations: [
  { id: "todoist", title: "Todoist", summary: "Tasks", kind: "Code and Work", symbol: "checklist", site: "https://todoist.com", how: "Open source · your key", way: "package",
    keys: [{ name: "API_KEY", label: "API token", prompt: "From Todoist" }], variables: { API_KEY: shared },
    settings: { type: "local", command: ["kuvo-npx", "@doist/todoist-mcp@1.0.0"], environment: { API_KEY: `{file:~/.kuvo-code/box/keys/${shared}}` }, codemode: false } },
] }));
const hostFile = path.join(home, "run", "host.json");

/** The app saying where its host interface answers now, as it does each time it starts it. */
function hostAt(host, password) {
  fs.mkdirSync(path.dirname(hostFile), { recursive: true });
  fs.writeFileSync(hostFile, JSON.stringify({ url: host.url, password }), { mode: 0o600 });
}

const listed = async () => (await link.answerIntegrations("GET", "kuvo/integrations", undefined, null, undefined, catalogFile)).value.integrations[0];
const add = key => link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: key } }, null, undefined, catalogFile, () => {});

test("its app's host interface not answering, then back at another address: reached without the box starting again", async () => {
  // Not answering yet: whether it has the keys is unsaid, and none is taken.
  assert.equal((await listed()).keysSaved, undefined);
  const refused = await add("tok_early");
  assert.deepEqual(refused, { status: 503, value: { message: "Kuvo Code isn't answering for this Mac's keys. Try again in a moment." } });

  // The app's host interface started: the same box reaches it.
  const first = await standInHost("first-password");
  hostAt(first, "first-password");
  assert.equal((await listed()).keysSaved, false, "Add Key…");
  assert.equal((await add("tok_first")).status, 200);
  assert.equal(first.keys.get(shared), "tok_first", "in the app's Keychain");

  // It failed and the app started it again, elsewhere, with a new password: reached there.
  const second = await standInHost("second-password");
  second.keys.set(shared, "tok_first");
  hostAt(second, "second-password");
  assert.equal((await listed()).keysSaved, true);
  assert.equal(second.turnedAway, 0);

  // The app stopped it: unsaid again, rather than read from where it was.
  fs.rmSync(hostFile);
  assert.equal((await listed()).keysSaved, undefined);
  assert.equal(fs.existsSync(path.join(home, "box", "keys")), false, "never kept in the box's own folder");
});

test("a host.json left behind, its port taken by something else that says yes to anything: no key and no password reach it", async () => {
  const heard = [];
  const impostor = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    heard.push({ url: request.url, authorization: request.headers.authorization ?? null, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ names: [], value: "x", proof: "0".repeat(64) }));
  });
  await new Promise(resolve => impostor.listen(0, "127.0.0.1", resolve));
  atEnd(() => { impostor.closeAllConnections(); impostor.close(); });
  hostAt({ url: `http://127.0.0.1:${impostor.address().port}` }, "left-behind-password");

  assert.equal((await listed()).keysSaved, undefined, "not said: it isn't the app");
  const adding = await add("tok_SECRET");
  assert.deepEqual(adding, { status: 503, value: { message: "Kuvo Code isn't answering for this Mac's keys. Try again in a moment." } });
  assert.ok(heard.length > 0, "it was asked to prove it's the app");
  for (const each of heard) {
    assert.equal(each.url, "/hello", "nothing but the proof asked");
    assert.equal(each.authorization, null, "without the password");
    assert.ok(!each.body.includes("tok_SECRET") && !each.body.includes("left-behind-password"));
  }
  fs.rmSync(hostFile);
});

test("something at a left-behind port relaying the box's nonce to the app at its real port: its proof is for the wrong port, and no key or password reaches it", async () => {
  const app = await standInHost("real-password");
  const heard = [];
  const relay = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    heard.push({ url: request.url, authorization: request.headers.authorization ?? null, body });
    // What another user's process on this Mac could do: ask the app itself, and pass its answer on.
    const asked = await fetch(`${app.url}${request.url}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    response.writeHead(asked.status, { "content-type": "application/json" });
    response.end(await asked.text());
  });
  await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve));
  atEnd(() => { relay.closeAllConnections(); relay.close(); });
  // A host.json left behind with the app's password (the worst case), its port the relay's now.
  hostAt({ url: `http://127.0.0.1:${relay.address().port}` }, "real-password");

  assert.equal((await listed()).keysSaved, undefined, "not said: the proof was for the app's port");
  const adding = await add("tok_RELAYED");
  assert.deepEqual(adding, { status: 503, value: { message: "Kuvo Code isn't answering for this Mac's keys. Try again in a moment." } });
  assert.ok(app.hellos > 0, "the app was asked, through the relay");
  for (const each of heard) {
    assert.equal(each.url, "/hello", "nothing but the proof asked");
    assert.equal(each.authorization, null, "without the password");
    assert.ok(!each.body.includes("tok_RELAYED") && !each.body.includes("real-password"));
  }
  assert.equal(app.keys.size, 0, "no key reached the app that way either");

  // The app at its own port: proved, and Add Key… there.
  hostAt(app, "real-password");
  assert.equal((await listed()).keysSaved, false);
  fs.rmSync(hostFile);
});
