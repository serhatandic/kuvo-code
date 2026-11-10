// The browser on a machine (PROTOCOL.md, "The browser on a machine"): the box sets it up itself,
// with no Mac, from stand-ins for Google's Chrome for Testing and Rocky Linux's packages served here
// (browser-source-stand-in.js), into this run's own folder, never a machine's. It checks each
// download before it unpacks anything, takes only what the browser needs, and runs nothing.

import "./safety"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { crc32, makeRpm, makeXz, makeZip, served, startSource } from "../../KuvoLink/Tests/Bridge/browser-source-stand-in.js"
import { allowedSource, browserStatus, compareVersions, installBrowser, runtimeHere, startBrowserInstall } from "../src/link/browser/install"
import { scriptIs } from "../src/link/home"
import { cpioEntries, payload } from "../src/link/browser/rpm"
import { unxz } from "../src/link/browser/xz"
import { unzip } from "../src/link/browser/zip"

const K = process.env.KUVO_HOME!
const BROWSER = path.join(K, "browser")
const RUN = path.join(K, "run")
const fixtures = path.join(import.meta.dir, "fixtures", "browser")
const sha256 = (data: Uint8Array) => crypto.createHash("sha256").update(data).digest("hex")
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "kbr-"))
const kind = os.arch() === "arm64" ? "aarch64" : "x86_64"

describe("xz", () => {
  // Made by Python's lzma (liblzma): presets 0 to 9e, other literal and position settings, every
  // check it takes, chunks that don't compress, a stream of several chunks, and an empty one.
  const expected: Record<string, { sha256: string; size: number }> = JSON.parse(fs.readFileSync(path.join(fixtures, "xz.json"), "utf8"))
  for (const [name, { sha256: hash, size }] of Object.entries(expected)) {
    test(`decodes ${name}.xz as liblzma made it`, () => {
      const out = unxz(fs.readFileSync(path.join(fixtures, `${name}.xz`)))
      expect(out.length).toBe(size)
      expect(sha256(out)).toBe(hash)
    })
  }

  test("refuses one that's damaged or cut short, rather than giving back something else", () => {
    const whole = fs.readFileSync(path.join(fixtures, "text.xz"))
    for (const at of [20, 200, Math.floor(whole.length / 2), whole.length - 40]) {
      const damaged = Buffer.from(whole)
      damaged[at] ^= 0x55
      expect(() => unxz(damaged)).toThrow()
    }
    expect(() => unxz(whole.subarray(0, whole.length / 2))).toThrow()
    expect(() => unxz(Buffer.from("not xz at all, not even close"))).toThrow()
    // An LZMA chunk that would go on with the properties it had, after a dictionary reset.
    const header = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x00, 0, 0, 0, 0])
    header.writeUInt32LE(crc32(header.subarray(6, 8)), 8)
    const block = Buffer.from([0x02, 0x00, 0x21, 0x01, 0x16, 0, 0, 0, 0, 0, 0, 0])
    block.writeUInt32LE(crc32(block.subarray(0, 8)), 8)
    const chunks = Buffer.from([0x01, 0x00, 0x00, 0x41, 0xa0, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    expect(() => unxz(Buffer.concat([header, block, chunks, Buffer.alloc(16)]))).toThrow(/properties/)
    // Nor more than it may hold.
    expect(() => unxz(fs.readFileSync(path.join(fixtures, "large.xz")), 1_000_000)).toThrow()
  })

  test("reads a real package of Rocky Linux's: its files as cpio, the same as its own tools give", () => {
    const entries = cpioEntries(payload(fs.readFileSync(path.join(fixtures, "libXau-1.0.9-3.el8.x86_64.rpm"))))
    const library = entries.find(entry => entry.name === "./usr/lib64/libXau.so.6.0.0")!
    expect(library.data.length).toBe(16360)
    // (As bsdtar unpacks it.)
    expect(sha256(library.data)).toBe("e6d22245203e84096d1a5549e25d22ea111c2e03a85dc10597cee1d7276dc35d")
    const link = entries.find(entry => entry.name === "./usr/lib64/libXau.so.6")!
    expect(link.data.toString()).toBe("libXau.so.6.0.0")
    expect(entries.map(entry => entry.name)).toContain("./usr/share/doc/libXau/COPYING")
  })
})

describe("zip", () => {
  test("unpacks files, folders and links inside it, with the permissions to run and no more", async () => {
    const root = temporary()
    const zip = path.join(root, "a.zip")
    fs.writeFileSync(zip, makeZip([
      { name: "chrome-x/" },
      { name: "chrome-x/chrome", data: "#!/bin/sh\n", mode: 0o4777, deflate: true },
      { name: "chrome-x/sub/data.bin", data: crypto.randomBytes(100_000), deflate: true },
      { name: "chrome-x/stored.txt", data: "as it is" },
      { name: "chrome-x/Versions/A/lib", data: "lib" },
      { name: "chrome-x/Versions/Current", link: "A" },
      { name: "chrome-x/lib", link: "Versions/Current/lib" },
    ]))
    const out = path.join(root, "out")
    fs.mkdirSync(out)
    await unzip(zip, out)
    expect(fs.readFileSync(path.join(out, "chrome-x/chrome"), "utf8")).toBe("#!/bin/sh\n")
    expect(fs.statSync(path.join(out, "chrome-x/chrome")).mode & 0o7777).toBe(0o755)
    expect(fs.statSync(path.join(out, "chrome-x/sub/data.bin")).size).toBe(100_000)
    expect(fs.readFileSync(path.join(out, "chrome-x/stored.txt"), "utf8")).toBe("as it is")
    expect(fs.readlinkSync(path.join(out, "chrome-x/Versions/Current"))).toBe("A")
    expect(fs.readFileSync(path.join(out, "chrome-x/lib"), "utf8")).toBe("lib")
  })

  const refused = async (entries: Parameters<typeof makeZip>[0]) => {
    const root = temporary()
    const outside = path.join(root, "outside")
    const zip = path.join(root, "a.zip")
    fs.writeFileSync(zip, makeZip(entries))
    const out = path.join(root, "out", "in")
    fs.mkdirSync(out, { recursive: true })
    let error: unknown = null
    try { await unzip(zip, out) } catch (caught) { error = caught }
    expect(error).not.toBeNull()
    expect(fs.existsSync(outside)).toBe(false)
    expect(fs.existsSync(path.join(root, "out", "outside"))).toBe(false)
  }

  test("never writes outside its folder, by name or through a link", async () => {
    await refused([{ name: "../outside", data: "x" }])
    await refused([{ name: "a/../../outside", data: "x" }])
    await refused([{ name: "/tmp/outside", data: "x" }])
    await refused([{ name: "a\\..\\..\\outside", data: "x" }])
    // A link that leads out, by its name or through another link.
    await refused([{ name: "up", link: "../outside" }])
    await refused([{ name: "abs", link: "/etc" }])
    await refused([{ name: "a/b/up", link: ".." }, { name: "esc", link: "a/b/up/../.." }])
    // A file whose folder is a link, and a name given twice.
    await refused([{ name: "l/x", data: "x" }, { name: "l", link: "." }])
    await refused([{ name: "same", data: "x" }, { name: "same", data: "y" }])
  })

  test("refuses a file that's larger than it says", async () => {
    await refused([{ name: "big", data: "x".repeat(1000), claimedSize: 10, deflate: true }])
  })
})

describe("its sources", () => {
  test("only Google's Chrome for Testing and Rocky Linux's packages, over HTTPS, as written", () => {
    for (const url of [
      "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.79/linux64/chrome-linux64.zip",
      "https://dl.rockylinux.org/pub/rocky/8/BaseOS/x86_64/os/Packages/z/zlib-1.2.11-26.el8.x86_64.rpm",
      "https://dl.rockylinux.org/vault/rocky/8.10/BaseOS/x86_64/os/Packages/z/zlib-1.2.11-26.el8.x86_64.rpm",
    ]) expect(allowedSource(url)).toBe(true)
    for (const url of [
      "http://storage.googleapis.com/chrome-for-testing-public/x.zip",
      "https://storage.googleapis.com/other-bucket/x.zip",
      "https://storage.googleapis.com/chrome-for-testing-public/../other/x.zip",
      "https://storage.googleapis.com.example.com/chrome-for-testing-public/x.zip",
      "https://user@storage.googleapis.com/chrome-for-testing-public/x.zip",
      "https://storage.googleapis.com:8443/chrome-for-testing-public/x.zip",
      "https://storage.googleapis.com/chrome-for-testing-public/x.zip?x=1",
      "https://dl.rockylinux.org/pub/rocky/9/BaseOS/x.rpm",
      "https://example.com/chrome-for-testing-public/x.zip",
    ]) expect(allowedSource(url)).toBe(false)
  })

  test("the pinned builds are those, for each system and processor", () => {
    for (const platform of ["linux", "darwin"] as const) {
      for (const arch of ["x64", "arm64"]) {
        const here = runtimeHere(platform, arch)
        if (!("runtime" in here)) throw new Error("no build")
        const download = here.runtime.chromium[here.kind]
        expect(allowedSource(download.url)).toBe(true)
        expect(download.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(download.url).toContain(platform === "darwin" ? "/mac-" : "/linux")
        expect(here.mac).toBe(platform === "darwin")
        if (platform === "linux") expect(here.runtime.packages?.[here.kind]?.length).toBeGreaterThan(10)
      }
    }
    expect("unsupported" in runtimeHere("win32", "x64")).toBe(true)
    expect("unsupported" in runtimeHere("linux", "riscv64")).toBe(true)
    expect(compareVersions("155.0.8059.79", "154.0.9999.1")).toBe(1)
    expect(compareVersions("155.0.8059.79", "155.0.8059.79")).toBe(0)
  })
})

// A machine's browser as the stand-ins serve it: Chrome (a script that notes if it's ever run),
// and on Linux two packages with a library, its other name, a font, a license and what it doesn't
// need.
const chrome = (version: string, mac = false) => {
  const top = mac ? "chrome-mac-arm64" : "chrome-linux64"
  const ran = path.join(K, "chrome-ran")
  const entries: Parameters<typeof makeZip>[0] = mac
    ? [
        { name: `${top}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, data: `#!/bin/sh\ntouch ${ran}\n`, mode: 0o755, deflate: true },
        { name: `${top}/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/${version}/F`, data: "framework", deflate: true },
        { name: `${top}/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/Current`, link: version },
      ]
    : [
        { name: `${top}/chrome`, data: `#!/bin/sh\ntouch ${ran}\n# ${version}\n`, mode: 0o755, deflate: true },
        { name: `${top}/libEGL.so`, data: "egl", mode: 0o755 },
        { name: `${top}/LICENSE`, data: "chrome's license" },
      ]
  return makeZip(entries)
}
const packages = () => [
  { name: "libfoo", rpm: makeRpm([
    { name: "./usr/lib64/libfoo.so.1.0", data: "foo", mode: 0o755 },
    { name: "./usr/lib64/libfoo.so.1", link: "libfoo.so.1.0" },
    { name: "./usr/lib64/libbad.so", link: "../../etc/passwd" },
    { name: "./usr/share/licenses/libfoo/COPYING", data: "foo's license" },
    { name: "./usr/share/doc/libfoo/README", data: "not needed" },
    { name: "./usr/bin/foo", data: "not needed", mode: 0o755 },
  ]) },
  { name: "foo-fonts", rpm: makeRpm([
    { name: "./usr/share/fonts/foo/Foo-Regular.ttf", data: "font" },
    { name: "./usr/share/fonts/foo/fonts.dir", data: "not needed" },
  ]) },
]
const systems = (version = "155.0.0.1", given: { mac?: boolean } = {}) => {
  const zip = chrome(version, given.mac)
  return given.mac
    ? { darwin: { version, x86_64: zip, aarch64: zip } }
    : { linux: { version, x86_64: zip, aarch64: zip, packages: { [kind]: packages() } } }
}

let source: Awaited<ReturnType<typeof startSource>> | null = null
async function serve(made: ReturnType<typeof systems>, answer?: (address: string) => { status: number; body?: string | Buffer; slow?: number } | null) {
  await source?.close()
  const { pins, files } = served(made)
  source = await startSource(files, answer)
  const pinsFile = path.join(K, "pins.json")
  fs.writeFileSync(pinsFile, JSON.stringify(pins))
  process.env.KUVO_BROWSER_SOURCE = source.url
  process.env.KUVO_BROWSER_PINS = pinsFile
  process.env.KUVO_BROWSER_SYSTEM = "darwin" in made ? "darwin" : "linux"
  return source
}

const current = () => fs.realpathSync(path.join(BROWSER, "current"))
const leftovers = () => fs.readdirSync(BROWSER).filter(name => name.startsWith(".box-staging") || name.startsWith(".current-"))

describe("setting it up", () => {
  beforeEach(() => {
    fs.rmSync(BROWSER, { recursive: true, force: true })
    fs.rmSync(path.join(RUN, "browser-install.json"), { force: true })
    fs.rmSync(path.join(K, "chrome-ran"), { force: true })
  })
  afterAll(async () => {
    await source?.close()
    delete process.env.KUVO_BROWSER_SOURCE
    delete process.env.KUVO_BROWSER_PINS
    delete process.env.KUVO_BROWSER_SYSTEM
  })

  test("a test's folder without stand-ins downloads nothing", async () => {
    delete process.env.KUVO_BROWSER_SOURCE
    expect(await installBrowser({ now: true })).toBe("off")
    expect(fs.existsSync(BROWSER)).toBe(false)
    expect(browserStatus().state).toBe("missing")
  })

  test("a fresh Linux machine gets the browser, whole and checked, by itself", async () => {
    const asked = (await serve(systems())).asked
    expect(browserStatus().state).toBe("missing")
    expect(await installBrowser()).toBe("installed")
    const build = current()
    expect(path.dirname(build)).toBe(fs.realpathSync(BROWSER))
    expect(fs.readFileSync(path.join(build, "chrome"), "utf8")).toContain("155.0.0.1")
    expect(fs.statSync(path.join(build, "chrome")).mode & 0o111).toBeTruthy()
    expect(fs.readFileSync(path.join(build, "chromium-version"), "utf8").trim()).toBe("155.0.0.1")
    expect(fs.readFileSync(path.join(build, "libEGL.so"), "utf8")).toBe("egl")
    // What the browser needs of the packages, and nothing else.
    expect(fs.readFileSync(path.join(build, "lib", "libfoo.so.1.0"), "utf8")).toBe("foo")
    expect(fs.readlinkSync(path.join(build, "lib", "libfoo.so.1"))).toBe("libfoo.so.1.0")
    expect(fs.readdirSync(path.join(build, "lib")).sort()).toEqual(["libfoo.so.1", "libfoo.so.1.0"])
    expect(fs.readdirSync(path.join(build, "fonts"))).toEqual(["Foo-Regular.ttf"])
    expect(fs.readFileSync(path.join(build, "licenses", "libfoo", "COPYING"), "utf8")).toBe("foo's license")
    expect(fs.existsSync(path.join(build, "usr"))).toBe(false)
    // Only what's pinned was asked for, and nothing it downloaded ran.
    expect(asked.every(address => allowedSource(address))).toBe(true)
    expect(asked.length).toBe(3)
    expect(fs.existsSync(path.join(K, "chrome-ran"))).toBe(false)
    expect(leftovers()).toEqual([])
    expect(fs.existsSync(path.join(RUN, ".browser-installing"))).toBe(false)
    expect(browserStatus()).toMatchObject({ state: "ready", chromium: "155.0.0.1", installed: "155.0.0.1" })
    // Again: nothing to do, nothing asked.
    expect(await installBrowser()).toBe("ready")
    expect(asked.length).toBe(3)
  })

  test("a Mac used as a machine gets Chrome for Testing as it comes, with its launcher", async () => {
    await serve(systems("155.0.0.2", { mac: true }))
    expect(await installBrowser()).toBe("installed")
    const build = current()
    expect(fs.readFileSync(path.join(build, "chrome"), "utf8")).toContain("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
    expect(fs.readlinkSync(path.join(build, "Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/Current"))).toBe("155.0.0.2")
    expect(path.basename(build)).toContain("-mac-")
    expect(fs.existsSync(path.join(K, "chrome-ran"))).toBe(false)
  })

  test("a download that isn't what's pinned is never unpacked, and it says so", async () => {
    const made = systems()
    const tampered = chrome("155.0.0.1")
    tampered[tampered.length - 30] ^= 1
    await serve(made, address => (address.endsWith(".zip") ? { status: 200, body: tampered } : null))
    expect(await installBrowser()).toBe("failed")
    const status = browserStatus()
    expect(status.state).toBe("failed")
    expect(status.message).toContain("checksum")
    expect(status.retryAt).toBeGreaterThan(Date.now())
    expect(fs.existsSync(path.join(BROWSER, "current"))).toBe(false)
    expect(fs.readdirSync(BROWSER)).toEqual([])
    expect(fs.existsSync(path.join(K, "chrome-ran"))).toBe(false)
  })

  test("a package that's tampered with is refused too, and one larger than pinned is cut off", async () => {
    await serve(systems(), address => (address.endsWith(".rpm") && address.includes("libfoo") ? { status: 200, body: "x".repeat(100_000) } : null))
    expect(await installBrowser()).toBe("failed")
    expect(browserStatus().message).toMatch(/larger than it should be|checksum/)
    expect(fs.readdirSync(BROWSER)).toEqual([])
  })

  test("a package Rocky Linux moved to its vault comes from there", async () => {
    const made = systems()
    const { files } = served(made)
    const moved = new Map([...files].map(([address, data]) => [address.includes("libfoo") ? address.replace("/pub/rocky/8/", "/vault/rocky/8.10/") : address, data]))
    await source?.close()
    await serve(made)
    await source!.close()
    source = await startSource(moved)
    process.env.KUVO_BROWSER_SOURCE = source.url
    expect(await installBrowser()).toBe("installed")
    expect(source.asked.some(address => address.includes("/vault/rocky/8.10/") && address.includes("libfoo"))).toBe(true)
  })

  test("with no network it says so, waits before trying again by itself, and tries at once when asked", async () => {
    await serve(systems())
    // Nothing listens there any more.
    await source!.close()
    source = null
    expect(await installBrowser()).toBe("failed")
    const status = browserStatus()
    expect(status.message).toMatch(/Couldn't reach storage\.googleapis\.com/)
    expect(status.message).toMatch(/tries again in a minute/)
    expect(status.retryAt! - Date.now()).toBeGreaterThan(30_000)
    expect(await installBrowser()).toBe("waiting")
    expect(fs.readdirSync(BROWSER)).toEqual([])
    // Back, and asked now.
    await serve(systems())
    expect(await installBrowser({ now: true })).toBe("installed")
    expect(browserStatus().state).toBe("ready")
  })

  test("a newer pin replaces an older build, which goes unless a browser still runs from it", async () => {
    await serve(systems("154.0.0.1"))
    expect(await installBrowser()).toBe("installed")
    const older = current()
    // A browser running from the older build: it stays, for now.
    const running = spawn("/bin/sh", ["-c", `exec tail -f ${JSON.stringify(path.join(older, "chromium-version"))}`], { stdio: "ignore" })
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      await serve(systems("155.0.0.1"))
      expect(browserStatus()).toMatchObject({ state: "ready", installed: "154.0.0.1", chromium: "155.0.0.1" })
      expect(await installBrowser()).toBe("installed")
      expect(current()).not.toBe(older)
      expect(fs.existsSync(older)).toBe(true)
    } finally {
      running.kill("SIGKILL")
      await new Promise(resolve => running.once("exit", resolve))
    }
    // Once nothing runs from it, the next setup clears it.
    await serve(systems("155.0.0.3"))
    expect(await installBrowser()).toBe("installed")
    expect(fs.existsSync(older)).toBe(false)
    expect(fs.readdirSync(BROWSER).filter(name => name !== "current")).toEqual([path.basename(current())])
  })

  test("a build that doesn't start is set up again when asked to repair it", async () => {
    await serve(systems())
    expect(await installBrowser()).toBe("installed")
    fs.rmSync(path.join(current(), "lib", "libfoo.so.1.0"))
    expect(await installBrowser()).toBe("ready")
    expect(await installBrowser({ repair: true })).toBe("installed")
    expect(fs.existsSync(path.join(current(), "lib", "libfoo.so.1.0"))).toBe(true)
  })

  test("a build that doesn't start is set up again at most once in a while", async () => {
    await serve(systems())
    expect(await installBrowser()).toBe("installed")
    expect(await installBrowser({ repair: true })).toBe("installed")
    const asked = source!.asked.length
    // Again at once: the same reason, which setting it up again didn't fix (a library the machine
    // itself lacks), never has it download the browser over and over.
    expect(await installBrowser({ repair: true })).toBe("ready")
    expect(source!.asked.length).toBe(asked)
    // Unless you ask for it now.
    expect(await installBrowser({ repair: true, now: true })).toBe("installed")
  })

  test("a repair that fails waits as any failure does, and doesn't count as done", async () => {
    await serve(systems())
    expect(await installBrowser()).toBe("installed")
    const working = current()
    await source!.close()
    source = null
    expect(await installBrowser({ repair: true })).toBe("failed")
    // The build there stays in use meanwhile, and the next repair waits out the failure.
    expect(current()).toBe(working)
    expect(browserStatus().state).toBe("ready")
    expect(await installBrowser({ repair: true })).toBe("ready")
    // Once it may try again (or now), it does: it isn't held back six hours for a repair that never happened.
    await serve(systems())
    const record = JSON.parse(fs.readFileSync(path.join(RUN, "browser-install.json"), "utf8"))
    fs.writeFileSync(path.join(RUN, "browser-install.json"), JSON.stringify({ ...record, retryAt: Date.now() - 1 }))
    expect(await installBrowser({ repair: true })).toBe("installed")
    expect(fs.readFileSync(path.join(RUN, "browser.next"), "utf8").trim()).toBe("0")
  })

  test("the keeper is told when it may try again by itself, and never for what only an update fixes", async () => {
    await serve(systems())
    await source!.close()
    source = null
    expect(await installBrowser()).toBe("failed")
    const next = Number(fs.readFileSync(path.join(RUN, "browser.next"), "utf8"))
    expect(next * 1000 - Date.now()).toBeGreaterThan(30_000)
    await serve(systems(), address => (address.includes("libfoo") ? { status: 404 } : null))
    expect(await installBrowser({ now: true })).toBe("failed")
    expect(Number(fs.readFileSync(path.join(RUN, "browser.next"), "utf8"))).toBeGreaterThan(9_000_000_000)
  })

  test("a setup asked for says so at once, before its process has started", async () => {
    await serve(systems())
    const stub = path.join(K, "stub-link.js")
    fs.writeFileSync(stub, "")
    scriptIs(stub)
    try {
      const before = Date.now()
      expect(startBrowserInstall().state).toBe("checking")
      expect(browserStatus().state).toBe("checking")
      // Never twice: the one asked for already is starting.
      const record = () => JSON.parse(fs.readFileSync(path.join(RUN, "browser-install.json"), "utf8"))
      const at = record().at
      expect(at).toBeGreaterThanOrEqual(before)
      expect(startBrowserInstall().state).toBe("checking")
      expect(record().at).toBe(at)
    } finally {
      scriptIs("")
    }
  })

  test("status says ready while the pinned build is in use, whatever failed before it", async () => {
    await serve(systems())
    expect(await installBrowser()).toBe("installed")
    fs.writeFileSync(path.join(RUN, "browser-install.json"), JSON.stringify({ state: "failed", message: "old", retryAt: Date.now() + 60_000, failures: 1 }))
    expect(browserStatus().state).toBe("ready")
  })

  test("a lock left by a setup that went is taken over, and one at work is left alone", async () => {
    await serve(systems())
    // Left by a process that's gone.
    fs.mkdirSync(path.join(RUN, ".browser-installing"), { recursive: true })
    fs.writeFileSync(path.join(RUN, ".browser-installing", "pid"), "999999")
    expect(await installBrowser()).toBe("installed")
    expect(fs.existsSync(path.join(RUN, ".browser-installing"))).toBe(false)
    expect(fs.readdirSync(RUN).filter(name => name.startsWith(".browser-installing"))).toEqual([])
    // A setup at work (by its process): another is busy, and its staging stays.
    fs.mkdirSync(path.join(RUN, ".browser-installing"))
    const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", "kuvo-link"], { stdio: "ignore" })
    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      fs.writeFileSync(path.join(RUN, ".browser-installing", "pid"), String(worker.pid))
      const staging = path.join(BROWSER, `.box-staging-${worker.pid}-test`)
      fs.mkdirSync(staging)
      await serve(systems("156.0.0.1"))
      expect(await installBrowser({ now: true })).toBe("busy")
      expect(fs.existsSync(staging)).toBe(true)
    } finally {
      worker.kill("SIGKILL")
      await new Promise(resolve => worker.once("exit", resolve))
      fs.rmSync(path.join(RUN, ".browser-installing"), { recursive: true, force: true })
    }
  })

  test("a failure stops every download still going, and what it says stays said", async () => {
    const made = systems()
    const fonts = (made as { linux: { packages: Record<string, { name: string; rpm: Buffer }[]> } }).linux.packages[kind][1].rpm
    // One package Rocky Linux doesn't have anywhere; another still coming as that's found.
    await serve(made, address => (address.includes("libfoo") ? { status: 404 } : address.includes("foo-fonts") ? { status: 200, body: fonts, slow: 3_000 } : null))
    const began = Date.now()
    expect(await installBrowser()).toBe("failed")
    // (The slow one was cut off, not waited for.)
    expect(Date.now() - began).toBeLessThan(2_500)
    await new Promise(resolve => setTimeout(resolve, 3_500))
    const status = browserStatus()
    expect(status.state).toBe("failed")
    expect(status.message).toContain("no longer has libfoo")
    // Only an update fixes it: it doesn't try again by itself, nor when a tool asks.
    expect(status.retryAt).toBeNull()
    expect(await installBrowser()).toBe("waiting")
    expect(startBrowserInstall().state).toBe("failed")
    expect(fs.readdirSync(BROWSER)).toEqual([])
  })

  test("a link that leads out of the build once it's put together is refused", async () => {
    // (`../chromium` is inside the zip as it's unpacked, and the folder it was unpacked in, outside
    // the build, once its files are moved up into it.)
    const zip = makeZip([
      { name: "chrome-linux64/chrome", data: "#!/bin/sh\n", mode: 0o755 },
      { name: "chromium/" },
      { name: "chrome-linux64/data", link: "../chromium" },
    ])
    await serve({ linux: { version: "155.0.0.1", x86_64: zip, aarch64: zip, packages: { [kind]: packages() } } })
    expect(await installBrowser()).toBe("failed")
    expect(browserStatus().message).toContain("leads outside")
    expect(fs.existsSync(path.join(BROWSER, "current"))).toBe(false)
  })

  test("the browser's data stays whatever is set up", async () => {
    fs.mkdirSync(path.join(BROWSER, "profile", "Default"), { recursive: true })
    fs.writeFileSync(path.join(BROWSER, "profile", "Default", "Cookies"), "kept")
    await serve(systems())
    expect(await installBrowser()).toBe("installed")
    await serve(systems("156.0.0.1"))
    expect(await installBrowser()).toBe("installed")
    expect(fs.readFileSync(path.join(BROWSER, "profile", "Default", "Cookies"), "utf8")).toBe("kept")
  })
})

test("the stand-in's xz is xz", () => {
  const data = crypto.randomBytes(150_000)
  expect(unxz(makeXz(data)).equals(data)).toBe(true)
})
