import "./safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

// Where a box keeps what it has (#333): a Mac's box laid out in a home of its own, as a machine's
// is (`box/kind` says `mac`), names every place from that home and never reaches into the folder
// around it, which is your home folder there; the app's box in its own folder (today's) and a
// machine's keep what they kept. Each run as a box runs, in a process of its own.
const mac = process.platform === "darwin"
const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-own-home-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const LINK = join(import.meta.dir, "..", "src", "link")

interface Seen {
  places: Record<string, unknown> & {
    layout: string; kind: string; home: string; appFolder: string | null; settingsFile: string; engineConfig: string; engineData: string; chats: string
    attachments: string[]; keptFolders: string[]; phoneLink: string; appTemporary: string | null; sandboxCaches: Record<string, string>; keyFiles: string; sshAgents: string
  }
  kuvo: string[]
  readable: string[]
}

function asBox(home: string, env: Record<string, string>, kind?: string): Seen {
  const box = env.KUVO_HOME
  mkdirSync(home, { recursive: true })
  if (kind !== undefined) {
    mkdirSync(join(box, "box"), { recursive: true })
    writeFileSync(join(box, "box", "kind"), kind)
  }
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("KUVO_"))) as Record<string, string>
  const script = `import { fencePolicy } from ${JSON.stringify(join(LINK, "fence", "policy"))}; import { boxPlaces } from ${JSON.stringify(join(LINK, "places"))}; const policy = fencePolicy(); console.log(JSON.stringify({ places: boxPlaces(), kuvo: policy.kuvo, readable: policy.kuvoReadable }))`
  const ran = Bun.spawnSync([process.execPath, "-e", script], { cwd: home, env: { ...clean, HOME: home, TMPDIR: join(home, "tmp"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env } })
  expect(ran.exitCode, ran.stderr.toString()).toBe(0)
  return JSON.parse(ran.stdout.toString())
}

const inside = (file: string, folder: string) => file === folder || !relative(folder, file).startsWith("..")
/** Every place a box named, as paths. */
const pathsOf = (places: Seen["places"]): [string, string][] => Object.entries(places).flatMap(([name, value]) =>
  typeof value === "string" && value.startsWith("/") ? [[name, value]] : Array.isArray(value) ? value.map(each => [name, each] as [string, string])
    : value && typeof value === "object" ? Object.values(value).filter(each => typeof each === "string").map(each => [name, each as string] as [string, string]) : [])

test("a Mac's box in a home of its own names every place from it, never from the folder around it", () => {
  const home = join(root, "own")
  const K = join(home, ".kuvo-code")
  const seen = asBox(home, { KUVO_HOME: K }, "mac\n")
  const { places } = seen
  expect(places.layout).toBe("own")
  expect(places.kind).toBe("mac")
  expect(places.appFolder).toBeNull()
  // Its settings are the engine's own, in its `config` (as the app's engine's were), not a machine's `box`.
  expect(places.settingsFile).toBe(join(K, "config", "opencode", "opencode.json"))
  expect(places.engineData).toBe(join(K, "data", "opencode"))
  expect(places.chats).toBe(join(K, "chats"))
  expect(places.attachments).toEqual([join(K, "attachments")])
  expect(places.phoneLink).toBe(join(K, "phone-link.json"))
  expect(places.keyFiles).toBe(join(K, "box", "keys"))
  expect(places.appTemporary).toBeNull()
  expect(places.sandboxCaches.npm).toBe(join(K, "cache", "sandbox-npm"))
  // Everything in its home (its SSH agents' sockets aside, which may not fit a path that deep).
  const outside = pathsOf(places).filter(([name, file]) => name !== "sshAgents" && !inside(file, K))
  expect(outside).toEqual([])
  // The sandbox keeps commands from the box's own home, never from yours around it.
  expect(seen.kuvo).toContain(K)
  expect(seen.kuvo).not.toContain(home)
  expect(seen.readable).toEqual([join(K, "bin")])
})

test("the word in box/kind decides, whatever's around it: a recorded machine is a machine, an unknown word none", () => {
  const home = join(root, "words")
  const K = join(home, ".kuvo-code")
  expect(asBox(home, { KUVO_HOME: K }, " mac \n").places.kind).toBe("mac")
  const machine = asBox(home, { KUVO_HOME: K }, "machine\n").places
  expect(machine.kind).toBe("machine")
  expect(machine.settingsFile).toBe(join(K, "box", "opencode.json"))
  expect(asBox(home, { KUVO_HOME: K }, "windows\n").places.kind).toBe("machine")
})

test("the app's keeper starting its box in the app's folder wins over a kind recorded there (one a move back left)", () => {
  const home = join(root, "back")
  const S = join(home, "Library", "Application Support", "run.kuvo.code")
  for (const kind of ["mac\n", "machine\n"]) {
    const { places } = asBox(home, { KUVO_HOME: join(S, "box"), KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: join(S, "opencode", "config") }, kind)
    expect([places.layout, places.kind, places.appFolder, places.phoneLink]).toEqual(["app", "mac", S, join(S, "phone-link.json")])
  }
})

test("the app's box in its own folder keeps what it kept: beside it, where its app keeps them", () => {
  const home = join(root, "app")
  const S = join(home, "Library", "Application Support", "run.kuvo.code")
  const seen = asBox(home, { KUVO_HOME: join(S, "box"), KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: join(S, "opencode", "config"), KUVO_ENGINE_DATA: join(S, "opencode", "data", "opencode"), KUVO_BOTS: join(S, "bots"), KUVO_WAKES: join(S, "wakes"), KUVO_INTEGRATIONS: join(S, "integrations"), KUVO_MAC_ATTACHMENTS: join(S, "Attachments") })
  const { places } = seen
  expect(places.layout).toBe("app")
  expect(places.kind).toBe("mac")
  expect(places.appFolder).toBe(S)
  expect(places.settingsFile).toBe(join(S, "opencode", "config", "opencode", "opencode.json"))
  // Its chats beside it when the app doesn't name them, and the files you attach in the app's folder.
  expect(places.chats).toBe(join(S, "Chats"))
  expect(places.attachments).toEqual([join(S, "box", "attachments"), join(S, "Attachments")])
  expect(places.keptFolders).toContain(join(S, "Attachments"))
  expect(places.phoneLink).toBe(join(S, "phone-link.json"))
  // The app's folder is Kuvo Code's own to the sandbox, its `bin` readable.
  expect(seen.kuvo).toContain(S)
  expect(seen.readable).toEqual([join(S, "bin")])
  if (mac) expect(places.sshAgents).toStartWith("/private/tmp/kuvo-ssh-")
})

test("the app's box started in a home of its own is refused, rather than take your home for the app's folder", () => {
  const home = join(root, "misdirected")
  mkdirSync(home, { recursive: true })
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("KUVO_"))) as Record<string, string>
  const ran = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(join(LINK, "places"))})`], { cwd: home, env: { ...clean, HOME: home, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(home, ".kuvo-code"), KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: join(home, "config") } })
  expect(ran.exitCode).not.toBe(0)
  expect(ran.stderr.toString()).toContain("its folder around it is your home, not the app's")
})

test("a machine's box keeps what it kept", () => {
  const home = join(root, "machine")
  const K = join(home, ".kuvo-code")
  const seen = asBox(home, { KUVO_HOME: K })
  expect(seen.places.kind).toBe("machine")
  expect(seen.places.layout).toBe("own")
  expect(seen.places.settingsFile).toBe(join(K, "box", "opencode.json"))
  expect(seen.places.chats).toBe(join(K, "chats"))
  expect(seen.places.phoneLink).toBe(join(K, "phone-link.json"))
  expect(seen.kuvo).toContain(K)
  expect(seen.kuvo).not.toContain(home)
})
