// This Mac's box bringing its integrations up to date as it starts (the scenarios on a machine are
// in Packages/Box/test/integrations-upgrade.test.ts): a key that goes is its app's to take away,
// which takes a moment another client can change something in, and which can fail.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { script, served, standInHost } from "./bot-keys-scenarios.js";
import { removeAtEnd } from "./at-end.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-upgrade-host-")));
const home = path.join(root, "box");
const PASSWORD = "host-password-not-a-key";
const host = await standInHost(PASSWORD);
const engineConfig = path.join(root, "opencode", "config");
const keyFiles = path.join(root, "app-temp", "integration-keys");
Object.assign(process.env, { KUVO_HOME: home, KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: engineConfig, KUVO_KEYS: keyFiles, KUVO_INTEGRATIONS: path.join(root, "integrations"), KUVO_KEYS_ON_HOST: "1", KUVO_HOST_URL: host.url, KUVO_HOST_PASSWORD: PASSWORD });
const link = await import(script);
removeAtEnd(root);

const FIGMA = "KUVO_KEY_FIGMA_FIGMA_API_KEY";
const TODOIST = "KUVO_KEY_TODOIST_TODOIST_API_KEY";
const settingsFile = path.join(engineConfig, "opencode", "opencode.json");
const servers = () => JSON.parse(fs.readFileSync(settingsFile, "utf8")).mcp.servers;

// As `MachineBox.integrationsJSON(forMac: true)` writes it, shortened.
const figmaNow = { type: "remote", url: "https://mcp.figma.com/mcp", codemode: false };
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.writeFileSync(path.join(home, "bin", "integrations.json"), JSON.stringify({ integrations: [
  { id: "figma", title: "Figma", way: "official", settings: figmaNow },
  { id: "todoist", title: "Todoist", way: "package", variables: { TODOIST_API_KEY: TODOIST },
    settings: { type: "local", command: ["kuvo-npx", "@doist/todoist-mcp@13.7.1"], environment: { KUVO_NPX_APART: "1", TODOIST_API_KEY: `{file:${keyFiles}/${TODOIST}}` }, codemode: false } },
] }));

const older = () => ({
  figma: { type: "local", command: ["kuvo-npx", "figma-developer-mcp@0.6.0"], environment: { FIGMA_API_KEY: `{file:${keyFiles}/${FIGMA}}` } },
  todoist: { type: "local", command: ["kuvo-npx", "@doist/todoist-mcp@1.0.0"], environment: { TODOIST_API_KEY: `{env:${TODOIST}}` } },
  mine: { type: "remote", url: "https://mine.example" },
});
const todoistNow = { type: "local", command: ["kuvo-npx", "@doist/todoist-mcp@13.7.1"], environment: { KUVO_NPX_APART: "1", TODOIST_API_KEY: `{file:${keyFiles}/${TODOIST}}` }, codemode: false };

function start() {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ mcp: { servers: older() } }));
  host.keys.clear();
  host.keys.set(FIGMA, "figma-token");
  host.keys.set(TODOIST, "todoist-token");
}

test("its app takes away the key of a package its maker's server replaced, and a change made meanwhile stays", async () => {
  start();
  host.onDelete = () => {
    host.onDelete = null;
    // A phone's, while the box waits for its app.
    assert.equal(link.changeSettings([{ path: ["mcp", "servers", "from-a-phone"], value: { type: "remote", url: "https://phone.example", codemode: false } }]).status, 200);
  };
  await link.upgradeIntegrations();
  assert.deepEqual(servers(), {
    figma: figmaNow,
    todoist: todoistNow,
    mine: { type: "remote", url: "https://mine.example", codemode: false },
    "from-a-phone": { type: "remote", url: "https://phone.example", codemode: false },
  });
  assert.equal(host.keys.has(FIGMA), false);
  assert.equal(host.keys.get(TODOIST), "todoist-token", "only the key nothing names any more");
  assert.equal(fs.existsSync(path.join(home, "box", "keys")), false, "no key kept in the box's folder");
});

test("its app not answering: that one waits, still naming its key, the rest go on, and the next start takes it", async () => {
  start();
  host.down = true;
  try {
    await link.upgradeIntegrations();
  } finally {
    host.down = false;
  }
  assert.deepEqual(servers(), { figma: older().figma, todoist: todoistNow, mine: { type: "remote", url: "https://mine.example", codemode: false } });
  assert.equal(host.keys.get(FIGMA), "figma-token");

  await link.upgradeIntegrations();
  assert.deepEqual(servers().figma, figmaNow);
  assert.equal(host.keys.has(FIGMA), false);
});

test("this Mac's box starting, as its app or keeper starts it: its settings come up to date with no client asking", { timeout: 60_000 }, async () => {
  start();
  let poke = () => {};
  const watcher = fs.watch(path.dirname(settingsFile), () => poke());
  // (Its password, which the box took out of this process's environment as it loaded here.)
  const box = await served({ ...process.env, KUVO_HOST_PASSWORD: PASSWORD, KUVO_TEST_NO_PEERS: "1" });
  try {
    while (servers().figma.url === undefined) await new Promise(resolve => { poke = resolve; });
    assert.deepEqual(servers(), { figma: figmaNow, todoist: todoistNow, mine: { type: "remote", url: "https://mine.example", codemode: false } });
    assert.equal(host.keys.has(FIGMA), false);
  } finally {
    watcher.close();
    await box.stop();
  }
});
