// Every box test runs with a home of its own, never this computer's ~/.kuvo-code: the link works its
// folders out once, as its modules load (`K` in src/link/home.ts), and one test file's import loads
// them for the whole run. So the run's home is set here, before any test file loads, and taken away
// when the run ends. (A test that sets KUVO_HOME itself and imports the link afterwards still gets
// this one: the link's modules were loaded already.) Before even that, the run is kept from the real
// Kuvo Code's folders, whatever the shell it's in hands down: test-safety.js.

import "../../KuvoLink/Tests/Bridge/test-safety.js"
import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "kuvo-box-tests-"))
process.env.KUVO_HOME = home
// (Once, when the last test file is done: a preload's hook is the whole run's.)
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  // (And test-safety.js's folder, which holds it: Bun's runner ends without a word to its preloads.)
  process.emit("kuvo-test-folders-removed" as any)
})
