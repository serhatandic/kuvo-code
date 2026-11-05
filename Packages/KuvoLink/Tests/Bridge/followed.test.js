// What a box's `…/events` routes follow (its projects, worktrees, personalities…): a change another
// process makes is told as the system's watch says, and one the watch missed as it started (it
// starts a moment after it's asked for) is told all the same, at once, not half a minute later.
// The watch is a stand-in that never tells anything: the system's, in its first moment.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/followed.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-followed-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

test("a change made as following starts, which the watch never told, is told all the same, at once", { timeout: 10_000 }, async () => {
  let value = 1;
  const stop = new AbortController();
  // Up, and quiet: what the system's is in the moment after it's asked for.
  const missed = () => ({ whole: true, close() {} });
  const lines = link.followed(() => ({ value }), new Set(), stop.signal, { folders: [home], watch: missed });
  try {
    assert.deepEqual(JSON.parse((await lines.next()).value.body), { value: 1 });
    // Changed by another process just then: the watch says nothing.
    value = 2;
    assert.deepEqual(JSON.parse((await lines.next()).value.body), { value: 2 });
  } finally {
    stop.abort();
    await lines.return();
  }
});
