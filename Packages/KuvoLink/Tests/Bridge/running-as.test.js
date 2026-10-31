// A stand-in for one of the box's programs (running-as.js) ends with the test file that started it,
// also when that file is killed (a run stopped, or timed out), so none is left running.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/running-as.test.js`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const runningAs = new URL("running-as.js", import.meta.url).href;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a stand-in ends when the test file that started it is killed", async () => {
  // A test file that starts a stand-in, says its pid, and waits to be killed.
  const file = spawn(process.execPath, ["--input-type=module", "-e", `
    const { runningAs } = await import(${JSON.stringify(runningAs)});
    const pid = await runningAs("kuvo-test-stand-in", { after() {} });
    process.stdout.write(String(pid));
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const pid = await new Promise((resolve, reject) => {
    file.stdout.once("data", chunk => resolve(Number(String(chunk))));
    file.once("exit", code => reject(new Error(`the test file ended before its stand-in was ready (${code})`)));
  });
  try {
    assert.ok(alive(pid));
    file.kill("SIGKILL");
    // (Bounded: a stand-in that's left is stopped below, and fails the test.)
    for (let waited = 0; alive(pid) && waited < 10_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(pid), false, "the stand-in outlived its test file");
  } finally {
    file.kill("SIGKILL");
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
});
