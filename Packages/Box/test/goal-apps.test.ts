import "./safety"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { deflateSync } from "node:zlib"
import { findOnLinux, linuxDataFolders, spotlightPick } from "../src/link/work/apps"

// The apps a goal's steps are done in, on a Linux box: found by their desktop entries' names (any
// language's), yours over the system's, their icons as PNGs from the hicolor theme, `pixmaps` or a
// path, never one that's SVG alone. Read through the XDG folders, so the same on any computer that
// runs the tests (a Mac's box finds its apps its own way: the bridge's bots-goals test).

// A PNG of `size` pixels, whole.
function png(size: number): Buffer {
  const crc = (bytes: Buffer) => {
    let c = ~0
    for (const byte of bytes) {
      c ^= byte
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (kind: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length)
    head.write(kind, 4, "latin1")
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])))
    return Buffer.concat([head, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc((size * 4 + 1) * size)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])
}
const write = (file: string, text: string | Buffer) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

test("a Linux box finds an app by its desktop entry's name, in any language, yours over the system's, with its icon as a PNG, and none whose icon is SVG alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "kuvo-goal-apps-"))
  try {
    const home = join(root, "home")
    const own = join(home, ".local", "share")
    const system = join(root, "system")
    const env = { XDG_DATA_DIRS: system }
    write(join(system, "applications", "org.example.Tidepool.desktop"), "[Desktop Entry]\nType=Application\nName=Tidepool\nName[tr]=Gelgit\nIcon=org.example.Tidepool\n")
    for (const size of [32, 96, 256]) write(join(system, "icons", "hicolor", `${size}x${size}`, "apps", "org.example.Tidepool.png"), png(size))
    write(join(system, "applications", "sketchpad.desktop"), "[Desktop Entry]\nType=Application\nName=Sketchpad\nIcon=sketchpad\n")
    write(join(system, "icons", "hicolor", "scalable", "apps", "sketchpad.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>")
    write(join(system, "applications", "old.desktop"), "[Desktop Entry]\nType=Application\nName=Old Thing\nIcon=old\nHidden=true\n")
    write(join(system, "pixmaps", "old.png"), png(48))
    // In a folder of its own (its id from both), its icon in pixmaps.
    write(join(system, "applications", "kde", "notes.desktop"), "[Desktop Entry]\nType=Application\nName=Notes\nIcon=notes\n")
    write(join(system, "pixmaps", "notes.png"), png(48))

    expect(findOnLinux("tidepool", env, home)).toEqual({ id: "org.example.Tidepool", name: "Tidepool", icon: join(system, "icons", "hicolor", "96x96", "apps", "org.example.Tidepool.png") })
    expect(findOnLinux("GELGIT", env, home)?.id).toBe("org.example.Tidepool")
    expect(findOnLinux("Sketchpad", env, home)).toBeNull()
    expect(findOnLinux("Old Thing", env, home)).toBeNull()
    expect(findOnLinux("Notes", env, home)).toMatchObject({ id: "kde-notes", icon: join(system, "pixmaps", "notes.png") })
    expect(findOnLinux("Writer", env, home)).toBeNull()

    // Your own entry for the same app, with its icon by path, goes first.
    write(join(own, "applications", "org.example.Tidepool.desktop"), `[Desktop Entry]\nType=Application\nName=Tidepool\nIcon=${join(home, "tidepool.png")}\n`)
    write(join(home, "tidepool.png"), png(64))
    expect(findOnLinux("Tidepool", env, home)?.icon).toBe(join(home, "tidepool.png"))

    // Flatpak's and snap's exported entries are read too, after yours and the system's.
    expect(linuxDataFolders(env, home)).toEqual([own, system, join(own, "flatpak", "exports", "share"), "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"])
    expect(linuxDataFolders({}, home).slice(0, 3)).toEqual([own, "/usr/local/share", "/usr/share"])
    // On a machine, the box's own data folder is Kuvo Code's: yours is the one its launch kept.
    const { K } = await import("../src/link/home")
    expect(linuxDataFolders({ XDG_DATA_HOME: join(K, "data"), KUVO_OWN_XDG_DATA_HOME: "/data/ada" }, home)[0]).toBe("/data/ada")
    expect(linuxDataFolders({ XDG_DATA_HOME: join(K, "data"), KUVO_OWN_XDG_DATA_HOME: "" }, home)[0]).toBe(own)
    expect(linuxDataFolders({ XDG_DATA_HOME: join(K, "data") }, home)[0]).toBe(own)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a Linux box takes no icon too big to copy whole: the theme's next size near 64 px instead, or none", () => {
  const root = mkdtempSync(join(tmpdir(), "kuvo-goal-apps-"))
  try {
    const home = join(root, "home")
    const system = join(root, "system")
    const env = { XDG_DATA_DIRS: system }
    // A PNG with a couple of megabytes after it: its header says it's a PNG all the same.
    const huge = (size: number) => Buffer.concat([png(size), Buffer.alloc(2 * 1024 * 1024)])
    write(join(system, "applications", "tidepool.desktop"), "[Desktop Entry]\nType=Application\nName=Tidepool\nIcon=tidepool\n")
    write(join(system, "icons", "hicolor", "64x64", "apps", "tidepool.png"), huge(64))
    write(join(system, "icons", "hicolor", "128x128", "apps", "tidepool.png"), png(128))
    expect(findOnLinux("Tidepool", env, home)?.icon).toBe(join(system, "icons", "hicolor", "128x128", "apps", "tidepool.png"))
    write(join(system, "applications", "big.desktop"), `[Desktop Entry]\nType=Application\nName=Big\nIcon=${join(root, "big.png")}\n`)
    write(join(root, "big.png"), huge(64))
    expect(findOnLinux("Big", env, home)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("on a Mac, an app Spotlight finds is taken only from the Applications folders and the system's own apps, never a build in a worktree, Downloads, Documents or iCloud Drive", () => {
  const home = "/Users/ada"
  const folders = ["/Applications", "/System/Applications", `${home}/Applications`, "/System/Library/CoreServices"]
  const said = (...apps: string[]) => apps.join("\n") + "\n"
  const elsewhere = [
    `${home}/Desktop/main/kuvo-ai/build/Kuvo Code.app`,
    `${home}/Downloads/Kuvo Code.app`,
    `${home}/Documents/Old/Kuvo Code.app`,
    `${home}/Library/Mobile Documents/com~apple~CloudDocs/Kuvo Code.app`,
    "/Applications.old/Kuvo Code.app",
  ]
  expect(spotlightPick(said(...elsewhere, "/Applications/Kuvo Code.app"), folders)).toBe("/Applications/Kuvo Code.app")
  expect(spotlightPick(said(...elsewhere), folders)).toBeNull()
  // Inside an app there still counts (Instruments, in Xcode), and so do yours and the system's.
  expect(spotlightPick(said("/Applications/Xcode.app/Contents/Applications/Instruments.app"), folders)).toBe("/Applications/Xcode.app/Contents/Applications/Instruments.app")
  expect(spotlightPick(said(`${home}/Applications/Tidepool.app`), folders)).toBe(`${home}/Applications/Tidepool.app`)
  expect(spotlightPick(said("/System/Library/CoreServices/Finder.app"), folders)).toBe("/System/Library/CoreServices/Finder.app")
  // Never a build's products, even in Applications.
  expect(spotlightPick(said("/Applications/Tools/DerivedData/Build/Products/Debug/Tidepool.app"), folders)).toBeNull()
})
