// Settings › Integrations on a machine, from a phone or a Mac with the Mac closed: from the catalog
// the Mac leaves there, its keys in files only you can read (`box/keys`, a bot's own in
// `box/bot-keys`), all on the machine itself. The scenarios are in integrations-scenarios.js.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boxRoute } from "./bot-keys-scenarios.js";
import { integrationScenarios, standInEngine } from "./integrations-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-integrations-")));
process.env.KUVO_HOME = home;
// A home of its own beside the box's folder, never above it (as one under a TMPDIR inside your
// home would be), so the box names its paths whole wherever the tests run.
const user = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-user-"));
process.env.HOME = user;
delete process.env.KUVO_INTEGRATIONS;
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
removeAtEnd(home);
removeAtEnd(user);

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

// A machine's box is in its user's home (`~/.kuvo-code`), and its settings name its keys from
// there, as `~/…`, the same on macOS and Linux, whatever the home is called.
test("a box in your home names its keys from your home, as ~/", async () => {
  const yours = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-home-")));
  removeAtEnd(yours);
  const box = path.join(yours, ".kuvo-code");
  fs.mkdirSync(path.join(box, "bin"), { recursive: true });
  fs.mkdirSync(path.join(box, "box"), { recursive: true });
  fs.writeFileSync(path.join(box, "box", "opencode.json"), "{}");
  fs.writeFileSync(path.join(box, "bin", "integrations.json"), JSON.stringify({ integrations: [
    { id: "todoist", title: "Todoist", summary: "Tasks", kind: "Code and Work", symbol: "checklist", site: "https://todoist.com", how: "Open source · your key", way: "package",
      keys: [{ name: "API_KEY", label: "API token", prompt: "From Todoist" }], variables: { API_KEY: "KUVO_KEY_TODOIST_API_KEY" },
      settings: { type: "local", command: ["kuvo-npx", "@doist/todoist-mcp@1.0.0"], environment: { API_KEY: "{file:/Users/someone/Library/Kuvo keys/KUVO_KEY_TODOIST_API_KEY}" }, codemode: false } },
  ] }));
  const saved = await boxRoute({ method: "POST", path: "kuvo/integrations/todoist", body: { keys: { API_KEY: "tok" } } }, { ...process.env, HOME: yours, KUVO_HOME: box });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const settings = JSON.parse(fs.readFileSync(path.join(box, "box", "opencode.json"), "utf8"));
  assert.equal(settings.mcp.servers.todoist.environment.API_KEY, "{file:~/.kuvo-code/box/keys/KUVO_KEY_TODOIST_API_KEY}");
  assert.equal(fs.readFileSync(path.join(box, "box", "keys", "KUVO_KEY_TODOIST_API_KEY"), "utf8"), "tok");
});

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
