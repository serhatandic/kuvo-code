// The first import of every box test (test/safety.test.ts holds each to that), so `bun test` from any
// folder runs as it does from here: Bun reads a bunfig.toml, so test/preload.ts, only from the folder
// it starts in. Kept from the real Kuvo Code's folders (test-safety.js), with the home the link works
// its folders out from, once, as it loads (`K` in src/link/home.ts). It takes the run's own home, and
// never your own, which some tests name in HOME before they load the link.

import "../../KuvoLink/Tests/Bridge/test-safety.js"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

process.env.KUVO_HOME ??= join(process.env.HOME!, ".kuvo-code")
mkdirSync(process.env.KUVO_HOME, { recursive: true })
