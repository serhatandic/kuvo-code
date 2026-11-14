import "./safety"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ownNamespaceLater, UNFINISHED } from "../src/link/fence/landlock"

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

// A busy machine can keep that try from finishing: whether commands can have a namespace of their
// own isn't known then, which the box never takes for "they can't" (they'd lose theirs, and could
// reach your login's services).
test("a try for a namespace that doesn't finish in time is told apart from one that found none", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-ns-late-")))
  try {
    // An unshare that never finishes (a FIFO no one writes), and one that finds none.
    const hold = join(root, "hold")
    expect(Bun.spawnSync(["mkfifo", hold]).exitCode).toBe(0)
    const slow = join(root, "slow")
    writeFileSync(slow, `#!/bin/sh\nread _ <${JSON.stringify(hold)}\n`, { mode: 0o755 })
    const none = join(root, "none")
    writeFileSync(none, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    mkdirSync(join(root, "ns"))
    expect({ slow: await ownNamespaceLater(join(root, "ns"), slow, 200), none: await ownNamespaceLater(join(root, "ns"), none) }).toEqual({ slow: UNFINISHED, none: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
