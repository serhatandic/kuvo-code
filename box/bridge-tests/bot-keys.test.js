// A bot's keys of its own on a machine, kept there in files only you can read and changed there,
// from a phone with the Mac closed or from the Mac (through `box route`): the scenarios in
// bot-keys-scenarios.js, then what's a machine's own: its settings naming them as they always have,
// and its bots' settings refreshed as its box starts. (This Mac's app's keys: bot-keys-host.test.js.)
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { botKeyScenarios, own, script, served } from "./bot-keys-scenarios.js";
import { removeAtEnd } from "./at-end.js";

// The box at `~/.kuvo-code`, as on a machine, so its settings name keys as a machine's do.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-bot-keys-"));
process.env.HOME = root;
const home = path.join(root, ".kuvo-code");
process.env.KUVO_HOME = home;
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS"]) delete process.env[name];
const link = await import(script);
removeAtEnd(root);

const keyFile = name => path.join(home, "box", name.includes("__") ? "bot-keys" : "keys", name);
const { writeCatalog, bot, settings } = botKeyScenarios({ link, home, store: {
  env: process.env,
  folder: "~/.kuvo-code/box/bot-keys",
  files: true,
  kept: name => { try { return fs.readFileSync(keyFile(name), "utf8"); } catch { return null; } },
  keep: (name, value) => { fs.mkdirSync(path.dirname(keyFile(name)), { recursive: true }); fs.writeFileSync(keyFile(name), value); },
  botNames: () => { try { return fs.readdirSync(path.join(home, "box", "bot-keys")).sort(); } catch { return []; } },
} });

test("a machine's bot's settings name its keys exactly as before", async () => {
  // Bridge 0.9.44 wrote this, byte for byte, for the same catalog: a header, an argument and an
  // environment, and an integration with two keys.
  const machineCatalog = path.join(root, "machine-integrations.json");
  fs.writeFileSync(machineCatalog, JSON.stringify({ integrations: [
    { id: "github", title: "GitHub", way: "token", keys: [{ name: "TOKEN", label: "Token" }], variables: { TOKEN: "KUVO_KEY_GITHUB_TOKEN" },
      settings: { type: "remote", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer {file:~/.kuvo-code/box/keys/KUVO_KEY_GITHUB_TOKEN}" } } },
    { id: "jira", title: "Jira", way: "package", keys: [{ name: "URL", label: "Site" }, { name: "API_TOKEN", label: "Token" }], variables: { URL: "KUVO_KEY_JIRA_URL", API_TOKEN: "KUVO_KEY_JIRA_API_TOKEN" },
      settings: { type: "local", command: ["kuvo-npx", "jira-mcp@2.0.0", "--site", "{file:~/.kuvo-code/box/keys/KUVO_KEY_JIRA_URL}"], environment: { JIRA_URL: "{file:~/.kuvo-code/box/keys/KUVO_KEY_JIRA_URL}", JIRA_TOKEN: "{file:~/.kuvo-code/box/keys/KUVO_KEY_JIRA_API_TOKEN}" } } },
  ] }));
  bot("bot_ada", "Ada");
  const later = () => {};
  assert.equal((await link.answerBotKeys("PUT", "kuvo/bots/bot_ada/keys/github", { keys: { TOKEN: "t1" } }, null, machineCatalog, later)).status, 200);
  assert.equal((await link.answerBotKeys("PUT", "kuvo/bots/bot_ada/keys/jira", { keys: { URL: "u", API_TOKEN: "t2" } }, null, machineCatalog, later)).status, 200);
  assert.equal(fs.readFileSync(path.join(home, "bots", "bot_ada", "workspace", ".opencode", "opencode.json"), "utf8"),
    "{\n  \"mcp\": {\n    \"servers\": {\n      \"github\": {\n        \"type\": \"remote\",\n        \"url\": \"https://api.githubcopilot.com/mcp/\",\n        \"headers\": {\n          \"Authorization\": \"Bearer {file:~/.kuvo-code/box/bot-keys/KUVO_KEY_GITHUB_TOKEN__BOT_ADA}\"\n        }\n      },\n      \"jira\": {\n        \"type\": \"local\",\n        \"command\": [\n          \"kuvo-npx\",\n          \"jira-mcp@2.0.0\",\n          \"--site\",\n          \"{file:~/.kuvo-code/box/bot-keys/KUVO_KEY_JIRA_URL__BOT_ADA}\"\n        ],\n        \"environment\": {\n          \"JIRA_URL\": \"{file:~/.kuvo-code/box/bot-keys/KUVO_KEY_JIRA_URL__BOT_ADA}\",\n          \"JIRA_TOKEN\": \"{file:~/.kuvo-code/box/bot-keys/KUVO_KEY_JIRA_API_TOKEN__BOT_ADA}\"\n        }\n      }\n    }\n  }\n}\n");
});

test("its bots' settings are refreshed as its box starts", async () => {
  fs.mkdirSync(path.join(home, "box", "bot-keys"), { recursive: true });
  fs.writeFileSync(path.join(home, "box", "bot-keys", own), "tok_files");
  writeCatalog("1.2.0");
  const box = await served(process.env);
  // Its refresh is done before it answers anything.
  assert.equal((await box.route("GET", "kuvo/bots/bot_scout/keys")).status, 200);
  assert.deepEqual(settings().mcp.servers.todoist.command, ["kuvo-npx", "@doist/todoist-mcp@1.2.0"]);
  await box.stop();
});
