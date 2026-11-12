// Every box test runs with a home of its own, never this computer's ~/.kuvo-code (test/safety.ts, set
// here before any test file loads, and taken away when the run ends). A test that sets KUVO_HOME
// itself and imports the link afterwards still gets this one: the link's modules were loaded already.

import "./safety"
import { afterAll } from "bun:test"
import { reachedRealAgents } from "../../KuvoLink/Tests/Bridge/test-safety.js"

// (Once, when the last test file is done: a preload's hook is the whole run's. Bun's runner ends
// without telling anything else.)
afterAll(() => void process.emit("kuvo-test-folders-removed" as any))

// A run that reached your real coding agents (test-safety.js refused it) fails, however its tests
// took the refusal.
afterAll(() => {
  const reached = reachedRealAgents()
  if (reached.length) throw new Error(`This run reached your real coding agents ${reached.length} time(s). The first: ${reached[0]}`)
})
