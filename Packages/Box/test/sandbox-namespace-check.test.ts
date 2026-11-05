import "./safety"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ownNamespaceLater } from "../src/link/fence/landlock"

// On Linux the box checks each minute whether commands can have a namespace of their own (allowed
// since, or no longer). However long that takes on a busy machine, the box goes on answering:
// clients, the engine's plugin and its own tools reach it through the same process.

test("the box answers while it checks whether commands can have a namespace of their own", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-ns-check-")))
  const server = http.createServer((_, response) => response.end("here"))
  try {
    // An unshare that takes as long as it's let: done once the test says so.
    const go = join(root, "go")
    expect(Bun.spawnSync(["mkfifo", go]).exitCode).toBe(0)
    const unshare = join(root, "unshare")
    writeFileSync(unshare, `#!/bin/sh\nread _ <${JSON.stringify(go)}\n`, { mode: 0o755 })
    mkdirSync(join(root, "ns"))
    await new Promise<void>(listening => server.listen(0, "127.0.0.1", listening))
    const port = (server.address() as { port: number }).port

    let done = false
    const checking = ownNamespaceLater(join(root, "ns"), unshare).finally(() => { done = true })
    const answered = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text())
    expect({ answered, checkStillGoing: !done }).toEqual({ answered: "here", checkStillGoing: true })
    // (Let it finish: it found a namespace.)
    writeFileSync(go, "\n")
    expect(await checking).toBe(unshare)
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
