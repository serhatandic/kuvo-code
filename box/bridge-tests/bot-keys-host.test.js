// A bot's keys of its own on this Mac's box, which keeps no keys itself: it asks its app, through
// the host interface (`KUVO_HOST_URL`, `KUVO_HOST_PASSWORD`; PROTOCOL.md, "Host interface"), which
// keeps them in the Keychain and in the files the engine reads (`KUVO_KEYS`). Here a stand-in
// for the app keeps them in memory. The scenarios in bot-keys-scenarios.js, then what's this Mac's
// own: only `KUVO_KEY_…` names asked for, a key or the password never in its output, and the app
// not answering said plainly.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { botKeyScenarios, fixtures, own, script, served, standInHost } from "./bot-keys-scenarios.js";
import { removeAtEnd } from "./at-end.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-bot-keys-host-"));
process.env.HOME = root;
const home = path.join(root, "box");
process.env.KUVO_HOME = home;
const PASSWORD = "host-password-not-a-key";
const host = await standInHost(PASSWORD);
// The app's temporary folder, where the engine reads each key from a file the app writes.
const keyFiles = path.join(root, "app-temp", "integration-keys");
const hostEnv = { KUVO_HOST_URL: host.url, KUVO_HOST_PASSWORD: PASSWORD, KUVO_KEYS: keyFiles };
Object.assign(process.env, hostEnv);
const link = await import(script);
removeAtEnd(root);

test("the box takes its app's password out of its environment, so nothing it runs has it", () => {
  assert.equal(process.env.KUVO_HOST_PASSWORD, undefined);
});

botKeyScenarios({ link, home, store: {
  env: { ...process.env, ...hostEnv },
  folder: keyFiles,
  kept: name => host.keys.get(name) ?? null,
  keep: (name, value) => host.keys.set(name, value),
  botNames: () => [...host.keys.keys()].filter(name => name.includes("__")).sort(),
} });

test("it asks its app only for keys named KUVO_KEY_…, always with its password, and keeps no key in files of its own", () => {
  const calls = new Set(host.asked.map(each => each.call));
  for (const call of ["/keys/names", "/keys/get", "/keys/set", "/keys/delete"]) assert.ok(calls.has(call), `it used ${call}`);
  for (const each of host.asked) {
    if ("name" in each) assert.match(each.name, /^KUVO_KEY_[A-Z0-9_]+$/);
    if ("prefix" in each) assert.match(each.prefix, /^KUVO_KEY_[A-Z0-9_]*$/);
    if ("suffix" in each) assert.match(each.suffix, /^[A-Z0-9_]+$/);
  }
  assert.ok(!host.asked.some(each => JSON.stringify(each).includes("HOME")), "the integration whose key isn't named so: never asked for");
  assert.equal(host.turnedAway, 0);
  assert.equal(fs.existsSync(path.join(home, "box", "bot-keys")), false);
  assert.equal(fs.existsSync(path.join(home, "box", "keys")), false);
  assert.equal(fs.existsSync(keyFiles), false, "the app writes the engine's files, not the box");
});

test("started, it asks its app as it starts; a key's value and the password are never in its output; its app failing is said plainly", async () => {
  host.keys.clear();
  host.asked.length = 0;
  const asked = new Promise(resolve => { host.onNames = resolve; });
  const box = await served({ ...process.env, ...hostEnv });
  await asked;
  host.onNames = null;
  assert.deepEqual(host.asked[0], { call: "/keys/names" }, "its refresh, as it starts");

  const secret = "tok_secret_value_1234";
  assert.equal((await box.route("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: secret } })).status, 200);
  assert.equal(host.keys.get(own), secret);
  assert.deepEqual((await box.route("GET", "kuvo/bots/bot_scout/keys/todoist")).value, { keys: { API_KEY: secret } });

  host.down = true;
  const down = await box.route("GET", "kuvo/bots/bot_scout/keys");
  assert.deepEqual(down, { status: 503, value: { message: "This Mac's keys couldn't be reached (500). The Keychain is locked." } });
  assert.equal((await box.route("POST", "kuvo/bots/keys/refresh")).status, 503);
  host.down = false;
  assert.equal((await box.route("DELETE", "kuvo/bots/bot_scout/keys/todoist")).status, 200);
  assert.equal(host.keys.has(own), false);

  const output = await box.stop();
  assert.ok(!output.includes(secret), "no key's value in what it printed");
  assert.ok(!output.includes(PASSWORD), "nor its app's password");
});

test("it starts while its app isn't answering yet, and says so", async () => {
  // Nothing listens on port 1.
  const box = await served({ ...process.env, ...hostEnv, KUVO_HOST_URL: "http://127.0.0.1:1" });
  assert.deepEqual(await box.route("GET", "kuvo/bots/bot_scout/keys"), { status: 503, value: { message: "Kuvo Code isn't answering for this Mac's keys. Try again in a moment." } });
  await box.stop();
});

test("a key saved while the box refreshes waits for it, so neither undoes the other", async () => {
  const { settings } = fixtures(home);
  host.keys.delete(own);
  await link.refreshBotsKeys();
  // The refresh, held with the names it read before the save.
  let release;
  host.hold = new Promise(resolve => { release = resolve; });
  const asking = new Promise(resolve => { host.held = resolve; });
  const refreshing = link.refreshBotsKeys();
  await asking;
  host.held = null;
  const from = host.asked.length;
  const saving = link.answerBotKeys("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: "tk_during" } }, null, undefined, () => {});
  host.asked.push({ call: "released" });
  release();
  await refreshing;
  assert.equal((await saving).status, 200);
  assert.equal(host.asked[from].call, "released", `the save asked nothing while the refresh was under way: ${JSON.stringify(host.asked.slice(from))}`);
  assert.ok(settings().mcp?.servers?.todoist, "its server is named, after both");
  host.keys.delete(own);
  await link.refreshBotsKeys();
});

test("this Mac's box without its app refuses its keys rather than keep them in files", async () => {
  const box = await served({ ...process.env, KUVO_KEYS_ON_HOST: "1", KUVO_HOST_URL: "", KUVO_HOST_PASSWORD: "" });
  assert.equal((await box.route("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: "tk_nowhere" } })).status, 503);
  await box.stop();
  assert.equal(fs.existsSync(path.join(home, "box", "bot-keys")), false, "no key file of its own");
});
