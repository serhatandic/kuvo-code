// Settings › Integrations on a machine, from a phone or a Mac with the Mac closed: from the catalog
// the Mac leaves there, its keys in files only you can read (`box/keys`, a bot's own in
// `box/bot-keys`), all on the machine itself. The scenarios are in integrations-scenarios.js.
import { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { integrationScenarios } from "./integrations-scenarios.js";

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
