// The route scenarios both boxes answer alike, run against a machine's box (contract-runner.js):
// its folder of its own, with the files a Mac leaves on a machine.
//
// Run with `node --test box/bridge-tests/contract.test.js`.
import "./test-safety.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeAtEnd } from "./at-end.js";

// The box's folder (KUVO_HOME, read once as the bridge loads), and a folder for what a scenario
// makes outside it (repositories, files an agent made), both the test's own.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-contract-")));
process.env.KUVO_HOME = path.join(root, "box");
// A home of its own beside the box's folder, never above it (as one under a TMPDIR inside your
// home would be), so the box names its paths whole wherever the tests run.
process.env.HOME = path.join(root, "home");
fs.mkdirSync(process.env.HOME);
// git without your settings, the bridge's own too (it reads them as it loads).
Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Tests", GIT_AUTHOR_EMAIL: "tests@example.com", GIT_COMMITTER_NAME: "Tests", GIT_COMMITTER_EMAIL: "tests@example.com" });
removeAtEnd(root);
const { contract } = await import("./contract-runner.js");

contract({ box: "machine", root });
