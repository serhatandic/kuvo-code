// A test file's clean-up (at-end.js): whatever happens in it, the file's process ends, so the
// suite does; what it started is stopped and its folder removed; and what it left open is named
// and fails it. Each case runs at-end-fixture.js on its own, as `node --test` runs a file.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/at-end.test.js`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("at-end-fixture.js", import.meta.url));

// The fixture's run, once it has ended: its exit code, what it reported, and whether its process
// and folder are still there.
async function run(how) {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kae-"));
  const folder = path.join(outside, "file");
  fs.mkdirSync(path.join(folder, "run"), { recursive: true });
  const env = { ...process.env, AT_END_FIXTURE: how, AT_END_FOLDER: folder, AT_END_STRAY: path.join(outside, "stray") };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fixture], { env, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stdout.setEncoding("utf8").on("data", chunk => (said += chunk));
  child.stderr.setEncoding("utf8").on("data", chunk => (said += chunk));
  const code = await new Promise(resolve => child.once("close", resolve));
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(folder, "run", "pid"), "utf8")); } catch {}
  const running = (() => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  })();
  // (One the file didn't start itself, connected to it.)
  let stray = null;
  try { stray = Number(fs.readFileSync(env.AT_END_STRAY, "utf8")); } catch {}
  if (stray) try { process.kill(stray, "SIGKILL"); } catch {}
  const kept = fs.existsSync(folder);
  fs.rmSync(outside, { recursive: true, force: true });
  return { code, said, running, kept };
}

test("a file that stops what it started passes, its folder removed", { timeout: 60_000 }, async () => {
  const { code, said, running, kept } = await run("clean");
  assert.equal(code, 0, said);
  assert.doesNotMatch(said, /Still open/);
  assert.equal(running, false);
  assert.equal(kept, false);
});

test("a step that fails still lets the others run: the file ends, its process stopped and its folder removed, and says what failed", { timeout: 60_000 }, async () => {
  const { code, said, running, kept } = await run("a step fails");
  assert.notEqual(code, 0);
  assert.match(said, /a step that fails/);
  assert.doesNotMatch(said, /Still open/, "the steps after it stopped the process and the server");
  assert.equal(running, false);
  assert.equal(kept, false);
});

test("a file that leaves a process and a server running ends all the same, and fails naming them", { timeout: 60_000 }, async () => {
  const { code, said, running, kept } = await run("left");
  assert.notEqual(code, 0);
  assert.match(said, /Still open once the file's tests were done/);
  assert.match(said, /a process never stopped \(.*run\/pid/);
  assert.match(said, /a server listening \(port \d+\)/);
  assert.equal(running, false, "the process it left is stopped");
  assert.equal(kept, false);
});

test("a connection to a socket server it closed, held by a process it didn't start itself, fails the file, named, and the file ends", { timeout: 60_000 }, async () => {
  const { code, said, running, kept } = await run("held");
  assert.notEqual(code, 0);
  assert.match(said, /a connection to one of its socket servers \(a local socket\), whose other end still runs/);
  assert.doesNotMatch(said, /a server listening|a process never stopped/);
  assert.equal(running, false);
  assert.equal(kept, false);
});

test("a process it stopped whose own process still holds their pipes doesn't keep the file waiting: it passes, its folder removed", { timeout: 60_000 }, async () => {
  const { code, said, running, kept } = await run("a process of its own");
  assert.equal(code, 0, said);
  assert.doesNotMatch(said, /Still open/);
  assert.equal(running, false);
  assert.equal(kept, false);
});

test("anything else left open (a folder watched) fails the file, named, and is closed, so the file ends", { timeout: 60_000 }, async () => {
  const { code, said, running, kept } = await run("watching");
  assert.notEqual(code, 0);
  assert.match(said, /Still open once the file's tests were done.*a FSWatcher/);
  assert.doesNotMatch(said, /a server listening|a process never stopped/);
  assert.equal(running, false);
  assert.equal(kept, false);
});
