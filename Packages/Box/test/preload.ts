// Every box test runs with a home of its own, never this computer's ~/.kuvo-code: the link works its
// folders out once, as its modules load (`K` in src/link/home.ts), and one test file's import loads
// them for the whole run. So the run's home is set here, before any test file loads, and taken away
// when the run ends. (A test that sets KUVO_HOME itself and imports the link afterwards still gets
// this one: the link's modules were loaded already.)

import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "kuvo-box-tests-"))
process.env.KUVO_HOME = home
// (Once, when the last test file is done: a preload's hook is the whole run's.)
afterAll(() => rmSync(home, { recursive: true, force: true }))
