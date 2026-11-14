// The browser's keeper and tools every box runs (box/dist/kuvo-browser.js) are what
// src/browser builds, as scripts/build-browser.sh --check says: a change made to the sources without
// building the file again, or to the file itself, fails here, wherever the box's suite runs (Linux
// too), not only in CI's.
import "./safety"
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("kuvo-browser.js is what src/browser builds (scripts/build-browser.sh --check)", () => {
  const script = fileURLToPath(new URL("../../scripts/build-browser.sh", import.meta.url));
  const ran = spawnSync("sh", [script, "--check"], { env: { ...process.env, BUN: process.execPath }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(ran.stderr.trim()).toBe("");
  expect(ran.status).toBe(0);
});
