import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appears } from "./vault-waits.js";

// macOS can coalesce or lose filesystem notifications. A socket already present
// must still be found, even when its arrival wasn't delivered to the watcher.
test("a vault wait finds an arrival even without a filesystem notification", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vault-wait-"));
  const watch = fs.watch;
  let timer;
  try {
    fs.watch = () => ({ close() {} });
    const file = path.join(folder, "ready");
    const waiting = appears(folder, () => fs.existsSync(file) && file);
    fs.writeFileSync(file, "ready");
    assert.equal(await Promise.race([waiting, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("arrival was never found")), 2000);
    })]), file);
  } finally {
    clearTimeout(timer);
    fs.watch = watch;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
