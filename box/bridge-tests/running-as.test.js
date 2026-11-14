// A stand-in for one of the box's programs (running-as.js) ends with the test file that started it,
// also when that file is killed (a run stopped, or timed out), so none is left running.
//
// Run with `node --test box/bridge-tests/running-as.test.js`.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const runningAs = new URL("running-as.js", import.meta.url).href;

test("a stand-in ends when the test file that started it is killed", async () => {
  // A test file that starts a stand-in, says its pid, and waits to be killed. The stand-in shares
  // its stderr, so that pipe closes once both have ended.
  const file = spawn(process.execPath, ["--input-type=module", "-e", `
    const { runningAs } = await import(${JSON.stringify(runningAs)});
    const pid = await runningAs("kuvo-test-stand-in", { after() {} });
    process.stdout.write(String(pid));
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => file.stderr.on("close", resolve).resume());
  const pid = await new Promise((resolve, reject) => {
    file.stdout.once("data", chunk => resolve(Number(String(chunk))));
    file.once("exit", code => reject(new Error(`the test file ended before its stand-in was ready (${code})`)));
  });
  try {
    file.kill("SIGKILL");
    // (Bounded, only so a stand-in that's left fails the test and is stopped below.)
    let bound;
    const ended = await Promise.race([closed.then(() => true), new Promise(resolve => { bound = setTimeout(resolve, 10_000, false); })]);
    clearTimeout(bound);
    assert.equal(ended, true, "the stand-in outlived its test file");
  } finally {
    file.kill("SIGKILL");
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
});
