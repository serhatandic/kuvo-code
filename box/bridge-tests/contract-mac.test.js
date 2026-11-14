// The route scenarios both boxes answer alike, run against this Mac's box (contract-runner.js), for
// the areas that have moved onto it: as the app starts it, with its own folder (KUVO_HOME) and the
// app's folders beside it for its bots and sessions' wake-ups, and the app's kit for its bots. What
// a scenario expects of a Mac (`mac`) is what this box answers, as the Mac's PhoneLink did.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/contract-mac.test.js`.
import "./test-safety.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeAtEnd } from "./at-end.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-contract-mac-")));
// As BoxProcess starts it, in the app's folder (`support` stands in for Application Support).
const support = path.join(root, "support");
Object.assign(process.env, {
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_WAKE_COMMAND: path.join(support, "bin", "kuvo-wake"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Tests", GIT_AUTHOR_EMAIL: "tests@example.com", GIT_COMMITTER_NAME: "Tests", GIT_COMMITTER_EMAIL: "tests@example.com",
});
removeAtEnd(root);
const { contract } = await import("./contract-runner.js");

// Scenarios of what this Mac's box answers (all but the app's own routes, PhoneLink.appRoutes).
contract({ box: "mac", root, files: ["bots.json"] });
