// COMPAT(0.7 files): `run/mac-installing`. Goes 3 months after 0.8.0.
// A Mac's note that it puts its files in place on a machine counts for an hour. A connect cut off
// before it marked the box (Disconnect, Remove, the network) leaves it behind, and sends nothing
// more to take it back: the box takes it away itself once it no longer counts.
// Run with `node --test Packages/KuvoLink/Tests/Bridge/mac-installing.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-installing-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

test("a Mac's note left by a connect cut off goes once it no longer counts; one under way stays", () => {
  const note = path.join(home, "run", "mac-installing");
  fs.mkdirSync(path.dirname(note), { recursive: true });
  const now = Date.now();

  fs.writeFileSync(note, "");
  fs.utimesSync(note, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
  link.checkDrift(now);
  assert.ok(fs.existsSync(note), "a Mac connecting ten minutes ago may still be putting its files there");

  fs.utimesSync(note, new Date(now - 61 * 60_000), new Date(now - 61 * 60_000));
  link.checkDrift(now);
  assert.ok(!fs.existsSync(note), "an hour on, it's taken away");
});
