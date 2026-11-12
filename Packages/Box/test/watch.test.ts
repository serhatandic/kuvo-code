// A folder's watch (src/shared/watch.ts), whatever the system doesn't tell it. On macOS a process's
// watches share one FSEvents stream, made anew as any of them starts or stops, which never tells
// what changed before it ran: so a change as a watch starts, or as another starts or stops, is
// lost about one time in ten. Each round here makes that moment, many times over, and the watch
// still finds the change, by looking again. (On Linux nothing is lost, and the same holds.)
import "./safety"
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { WATCH_LOOKS_AGAIN, watchFolder } from "../src/shared/watch"

const root = fs.mkdtempSync(path.join(os.tmpdir().length > 60 ? "/tmp" : os.tmpdir(), "kv-watch-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** A watch of `folder` that says when the file it's waiting for is there (`waitFor`), looked at
 * each time it says its folder changed or looks again. */
function waiting(folder: string) {
  let wanted = ""
  let found = () => {}
  const look = () => {
    if (!wanted || !fs.existsSync(wanted)) return
    wanted = ""
    found()
  }
  const watcher = watchFolder(folder, look)
  return {
    waitFor: (file: string) => new Promise<void>(resolve => {
      wanted = file
      found = resolve
      look()
    }),
    close: () => watcher.close(),
  }
}

test("a watch looks again a moment after it starts, and after any other starts or stops", async () => {
  const folder = fs.mkdtempSync(path.join(root, "q-"))
  let looks = 0
  let looked = () => {}
  const watcher = watchFolder(folder, () => {}, { missed: () => { looks++; looked() } })
  try {
    // (Nothing changes in its folder: each look is one it makes itself.)
    while (looks < WATCH_LOOKS_AGAIN.length) await new Promise<void>(resolve => { looked = resolve })
    const before = looks
    const another = new Promise<void>(resolve => { looked = resolve })
    watchFolder(fs.mkdtempSync(path.join(root, "o-")), () => {}).close()
    await another
    expect(looks).toBeGreaterThan(before)
  } finally {
    watcher.close()
  }
}, 10_000)

test("a change made as a watch starts is found, though its stream never told it", async () => {
  for (let round = 0; round < 100; round++) {
    const folder = fs.mkdtempSync(path.join(root, "s-"))
    const watch = waiting(folder)
    const file = path.join(folder, "made")
    const seen = watch.waitFor(file)
    fs.writeFileSync(file, "")
    try {
      await seen
    } finally {
      watch.close()
    }
  }
}, 30_000)

test("a change made as another watch starts or stops is found, though the stream never told it", async () => {
  const folder = fs.mkdtempSync(path.join(root, "c-"))
  const other = fs.mkdtempSync(path.join(root, "x-"))
  const watch = waiting(folder)
  try {
    for (let round = 0; round < 100; round++) {
      const file = path.join(folder, `f${round}`)
      const seen = watch.waitFor(file)
      fs.writeFileSync(file, "")
      watchFolder(other, () => {}).close()
      await seen
    }
  } finally {
    watch.close()
  }
}, 30_000)
