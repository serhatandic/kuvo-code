import "./safety"
import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setBoxKey } from "../src/link/areas/box-keys"
import { BOX_KEYS } from "../src/link/home"

// A key you save on a box is a file only you can read, in a folder only you can open, however that
// folder came to be; one that can't be saved leaves nothing half-written beside it.

const mode = (where: string) => statSync(where).mode & 0o777

test("a key saved on a box: only you can read it, its folder only you can open, and a failed save leaves nothing", () => {
  // A folder others could read (made by hand, restored from a backup, or by a box before this).
  rmSync(BOX_KEYS, { recursive: true, force: true })
  mkdirSync(BOX_KEYS, { recursive: true })
  chmodSync(BOX_KEYS, 0o755)
  const umask = process.umask(0o022)
  try {
    expect(setBoxKey("KUVO_KEY_TEST_TOKEN", "not-a-real-token")).toEqual({ status: 200 })
    expect(mode(join(BOX_KEYS, "KUVO_KEY_TEST_TOKEN"))).toBe(0o600)
    expect(mode(BOX_KEYS)).toBe(0o700)

    // One that can't be put in place (a folder where it goes): an error, and no copy of it left.
    mkdirSync(join(BOX_KEYS, "KUVO_KEY_TEST_STUCK", "inside"), { recursive: true })
    writeFileSync(join(BOX_KEYS, "KUVO_KEY_TEST_STUCK", "inside", "file"), "")
    expect(() => setBoxKey("KUVO_KEY_TEST_STUCK", "not-a-real-token")).toThrow()
    expect(readdirSync(BOX_KEYS).sort()).toEqual(["KUVO_KEY_TEST_STUCK", "KUVO_KEY_TEST_TOKEN"])
  } finally {
    process.umask(umask)
    rmSync(BOX_KEYS, { recursive: true, force: true })
  }
})
