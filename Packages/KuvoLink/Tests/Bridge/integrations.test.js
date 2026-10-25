// Settings › Integrations on a machine, from a phone or a Mac with the Mac closed: from the catalog
// the Mac leaves there, its keys in files only you can read (`box/keys`, a bot's own in
// `box/bot-keys`), all on the machine itself. The scenarios are in integrations-scenarios.js.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boxRoute } from "./bot-keys-scenarios.js";
import { integrationScenarios, standInEngine } from "./integrations-scenarios.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-integrations-")));
process.env.KUVO_HOME = home;
delete process.env.KUVO_INTEGRATIONS;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const keyFile = name => path.join(home, "box", name.includes("__") ? "bot-keys" : "keys", name);

integrationScenarios({ link, home, mac: false, store: {
  settingsFile: path.join(home, "box", "opencode.json"),
  named: path.join(home, "box", "keys"),
  data: path.join(home, "integrations"),
  kept: name => { try { return fs.readFileSync(keyFile(name), "utf8"); } catch { return null; } },
  keep: (name, value) => {
    fs.mkdirSync(path.dirname(keyFile(name)), { recursive: true });
    fs.writeFileSync(keyFile(name), value);
  },
} });

// A Mac's Save on a machine goes over SSH (`box route`), a command that ends with its answer: its
// server still connects again a moment later, in every folder the machine's engine has open.
test("new keys from a Mac over SSH: its server connects again a moment later, everywhere", async () => {
  const { engine, asked } = await standInEngine(() => [], ["/work/app"]);
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(engine));
  const connected = new Promise(resolve => {
    asked.onAsked = () => { if (asked.includes("POST /api/experimental/mcp/todoist/connect in /work/app")) resolve(); };
  });
  const saved = await boxRoute({ method: "POST", path: "kuvo/integrations/todoist", body: { keys: { API_KEY: "tok_ssh" } } }, { ...process.env, KUVO_HOME: home });
  assert.equal(saved.status, 200);
  assert.ok(!asked.some(each => each.includes("/connect")), "not before the engine has read them");
  await connected;
  assert.ok(asked.includes("POST /api/experimental/mcp/todoist/connect"), `its own copy too: ${asked}`);
  fs.rmSync(path.join(home, "run", "engine.json"));
});
