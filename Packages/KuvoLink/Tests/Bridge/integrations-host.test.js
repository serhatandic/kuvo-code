// Settings › Integrations on this Mac's box, which keeps no keys itself: it asks its app, through
// the host interface (PROTOCOL.md, "Host interface"), which keeps them in the Keychain and in the
// files the engine reads (`KUVO_KEYS`), and tells it whether its browser is signed in to the sites
// the agent uses there. Here a stand-in for the app keeps them in memory. The scenarios in
// integrations-scenarios.js, then what's this Mac's own: nothing kept in the box's folder, its
// browser's sign-ins, and the app not answering said plainly, with nothing half removed.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { script, standInHost } from "./bot-keys-scenarios.js";
import { integrationScenarios } from "./integrations-scenarios.js";
import { removeAtEnd } from "./at-end.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-integrations-host-")));
const home = path.join(root, "box");
const PASSWORD = "host-password-not-a-key";
const host = await standInHost(PASSWORD);
// The app's folders: its engine's settings, the files the engine reads keys from, and what
// integrations' servers keep.
const engineConfig = path.join(root, "opencode", "config");
const keyFiles = path.join(root, "app-temp", "integration-keys");
const data = path.join(root, "integrations");
Object.assign(process.env, { KUVO_HOME: home, KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: engineConfig, KUVO_KEYS: keyFiles, KUVO_INTEGRATIONS: data, KUVO_KEYS_ON_HOST: "1", KUVO_HOST_URL: host.url, KUVO_HOST_PASSWORD: PASSWORD });
const link = await import(script);
removeAtEnd(root);

integrationScenarios({ link, home, mac: true, store: {
  settingsFile: path.join(engineConfig, "opencode", "opencode.json"),
  named: keyFiles,
  data,
  kept: name => host.keys.get(name) ?? null,
  keep: (name, value) => host.keys.set(name, value),
} });

test("no key is kept in the box's folder: every one went to its app", () => {
  assert.equal(fs.existsSync(path.join(home, "box", "keys")), false);
  assert.equal(fs.existsSync(path.join(home, "box", "bot-keys")), false);
  assert.equal(fs.existsSync(keyFiles), false, "the app writes the engine's files, not the box");
  for (const each of host.asked) if ("name" in each) assert.match(each.name, /^KUVO_KEY_[A-Z0-9_]+$/);
  assert.equal(host.turnedAway, 0);
});

test("whether this Mac's browser is signed in to a site the agent uses there, as its app says", async () => {
  host.sites = { linkedin: true };
  const listed = (await link.answerIntegrations("GET", "kuvo/integrations", undefined, null, undefined)).value.integrations;
  assert.equal(listed.find(each => each.id === "linkedin").siteSignedIn, true);
  host.sites = null;
  const unknown = (await link.answerIntegrations("GET", "kuvo/integrations", undefined, null, undefined)).value.integrations;
  assert.equal(unknown.find(each => each.id === "linkedin").siteSignedIn, undefined, "not said when its app can't tell");
});

test("its app not answering: said plainly, nothing added, and nothing removed", async () => {
  const settingsFile = path.join(engineConfig, "opencode", "opencode.json");
  assert.equal((await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_kept" } }, null, undefined, undefined, () => {})).status, 200);
  host.down = true;
  try {
    const listed = await link.answerIntegrations("GET", "kuvo/integrations", undefined, null, undefined);
    assert.equal(listed.status, 200, "listed all the same");
    assert.equal(listed.value.integrations.find(each => each.id === "todoist").keysSaved, undefined, "whether its keys are kept, unsaid");
    const adding = await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_new" } }, null, undefined, undefined, () => {});
    assert.deepEqual(adding, { status: 503, value: { message: "This Mac's keys couldn't be reached (500). The Keychain is locked." } });
    const removing = await link.answerIntegrations("DELETE", "kuvo/integrations/todoist", undefined, null, undefined);
    assert.equal(removing.status, 503);
    assert.match(removing.value.message, /^Todoist wasn't removed/);
    assert.ok(JSON.parse(fs.readFileSync(settingsFile, "utf8")).mcp.servers.todoist, "still in its settings");
  } finally {
    host.down = false;
  }
  assert.equal(host.keys.get("KUVO_KEY_TODOIST_API_KEY"), "tok_kept");
  assert.equal((await link.answerIntegrations("DELETE", "kuvo/integrations/todoist", undefined, null, undefined)).status, 200);
});

test("its app turned down once it's out of the settings: its key stays, and Remove again takes it", async () => {
  const settingsFile = path.join(engineConfig, "opencode", "opencode.json");
  assert.equal((await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_left" } }, null, undefined, undefined, () => {})).status, 200);
  host.failing = new Set(["/keys/delete"]);
  try {
    const removing = await link.answerIntegrations("DELETE", "kuvo/integrations/todoist", undefined, null, undefined);
    assert.equal(removing.status, 503);
    assert.match(removing.value.message, /^Todoist is removed, but its key is still kept/);
  } finally {
    host.failing = null;
  }
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).mcp?.servers?.todoist, undefined, "out of its settings");
  assert.equal(host.keys.get("KUVO_KEY_TODOIST_API_KEY"), "tok_left", "its key, left");
  assert.equal((await link.answerIntegrations("DELETE", "kuvo/integrations/todoist", undefined, null, undefined)).status, 200, "Remove again: its key goes");
  assert.equal(host.keys.has("KUVO_KEY_TODOIST_API_KEY"), false);
  assert.equal((await link.answerIntegrations("DELETE", "kuvo/integrations/todoist", undefined, null, undefined)).status, 404, "nothing of it left");
  const listed = (await link.answerIntegrations("GET", "kuvo/integrations", undefined, null, undefined)).value.integrations;
  assert.equal(listed.find(each => each.id === "todoist").keysSaved, false, "so Connect asks for a key again");
});

// Change Key on this Mac while the phone turns it off in MCP Servers: the Keychain may wait on a
// prompt, and what changed meanwhile stays changed.
test("new keys saved while another client turns it off leave it off", async () => {
  const settingsFile = path.join(engineConfig, "opencode", "opencode.json");
  const settings = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal((await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_a" } }, null, undefined, undefined, () => {})).status, 200);
  host.onSet = () => {
    host.onSet = null;
    const written = settings();
    written.mcp.servers.todoist.disabled = true;
    fs.writeFileSync(settingsFile, JSON.stringify(written));
  };
  try {
    assert.equal((await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_b" } }, null, undefined, undefined, () => {})).status, 200);
  } finally {
    host.onSet = null;
  }
  assert.equal(host.keys.get("KUVO_KEY_TODOIST_API_KEY"), "tok_b");
  assert.equal(settings().mcp.servers.todoist.disabled, true, "still off");
  assert.equal((await link.answerIntegrations("DELETE", "kuvo/integrations/todoist", undefined, null, undefined)).status, 200);
});

// Change Key on this Mac while the phone removes it: it stays removed, rather than coming back
// without the keys the removal takes away.
test("new keys saved while another client removes it don't bring it back", async () => {
  const settingsFile = path.join(engineConfig, "opencode", "opencode.json");
  const settings = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal((await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_a" } }, null, undefined, undefined, () => {})).status, 200);
  host.onSet = () => {
    host.onSet = null;
    const written = settings();
    delete written.mcp.servers.todoist;
    fs.writeFileSync(settingsFile, JSON.stringify(written));
  };
  let saving;
  try {
    saving = await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_b" } }, null, undefined, undefined, () => {});
  } finally {
    host.onSet = null;
  }
  assert.deepEqual(saving, { status: 409, value: { message: "Todoist was removed meanwhile." } });
  assert.equal(settings().mcp.servers.todoist, undefined, "still removed");
  // Its key, left by that: Remove takes it.
  assert.equal((await link.answerIntegrations("DELETE", "kuvo/integrations/todoist", undefined, null, undefined)).status, 200);
});

test("this Mac's box without its app refuses keys rather than keep them in files", async () => {
  const { served } = await import("./bot-keys-scenarios.js");
  const box = await served({ ...process.env, KUVO_HOST_PASSWORD: PASSWORD, KUVO_HOST_URL: "" });
  const refused = await box.route("PUT", "kuvo/keys/KUVO_KEY_TODOIST_API_KEY", { value: "tok_nowhere" });
  assert.deepEqual(refused, { status: 503, value: { message: "Kuvo Code isn't answering for this Mac's keys. Try again in a moment." } });
  assert.equal((await box.route("GET", "kuvo/keys")).status, 503);
  await box.stop();
  assert.equal(fs.existsSync(path.join(home, "box", "keys")), false, "no key file of its own");
});
