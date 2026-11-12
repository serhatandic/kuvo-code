// A box's integrations brought up to date by the box, with no client there: from the catalogs it has
// (a Mac's, or the ones its own update brought). Kuvo Code on a Mac used to do this itself, so a box
// may find settings it left, and each client's change around the box's has to stay. The catalog is the
// one the Mac's own code writes (Vectors/routes/box, scripts/route-vectors.sh), and what's written here
// as a Mac is what its `EngineConfig` sent: each server's whole value at its path.
import "./safety"
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import crypto from "node:crypto"
import { changeSettings, SERVERS } from "../src/link/areas/config"
import { upgradeIntegrations } from "../src/link/areas/integrations"
import { addressOf, newKey, publicOf } from "../src/link/crypto/keys"
import { BOT_KEYS, BOTS, BOX_KEYS, RUN, shownRoot } from "../src/link/home"
import { keyWork } from "../src/link/keys"
import { watchFolder } from "../src/shared/watch"
// @ts-expect-error (The bridge tests' stand-in, in plain JavaScript.)
import { relayStandIn } from "../../KuvoLink/Tests/Bridge/relay-stand-in.js"

const here = import.meta.dir
const catalogFile = join(here, "../../KuvoLink/Vectors/routes/box/integrations.json")
const main = join(here, "../src/link/main.ts")
const catalog: { id: string; settings: Record<string, unknown> }[] = JSON.parse(readFileSync(catalogFile, "utf8")).integrations
const pinned = (id: string) => catalog.find(each => each.id === id)!.settings
// A box's folder as its settings name it: a machine's, or this run's as the link loaded with it,
// whichever test file that was.
const MACHINE = "~/.kuvo-code"
const named = (key: string, root: string) => `{file:${root}/box/keys/${key}}`

// Those that start real processes, however busy the computer.
const SPAWNS = 60_000

const TODOIST = "KUVO_KEY_TODOIST_TODOIST_API_KEY"
const FIGMA = "KUVO_KEY_FIGMA_FIGMA_API_KEY"
const GITHUB = "KUVO_KEY_GITHUB_TOKEN"

/** Settings as a machine has them when an older Kuvo Code last connected. */
const oldServers = (root = shownRoot) => ({
  // An older pin, no word on Code Mode, not run apart, its key named in the environment, turned off.
  todoist: { type: "local", command: ["kuvo-npx", "@doist/todoist-mcp@1.0.0"], environment: { TODOIST_API_KEY: `{env:${TODOIST}}` }, disabled: true },
  // A scoped package's older pin, without the option it's started with now; you turned Code Mode on.
  "microsoft-365": { type: "local", command: ["kuvo-npx", "@softeria/ms-365-mcp-server@0.100.0"], environment: { MS365_MCP_USE_KEYTAR: "0" }, codemode: true },
  // Its maker runs its own server now: its package and key go.
  figma: { type: "local", command: ["kuvo-npx", "figma-developer-mcp@0.6.0", "--stdio"], environment: { FIGMA_API_KEY: named(FIGMA, root) } },
  // A key named where an older Mac's start kept it.
  github: { type: "remote", url: "https://api.githubcopilot.com/mcp/", oauth: false, headers: { Authorization: `Bearer {file:${root}/keys/${GITHUB}}` } },
  // Another package under an integration's name, which is yours: only its tools plain tools.
  caldav: { type: "local", command: ["kuvo-npx", "my-own-caldav@2.0.0"], environment: {} },
  // Your own servers: tools plain unless you said; Kuvo Code's own left alone.
  mine: { type: "local", command: ["npx", "mine"] },
  "mine-with-code-mode": { type: "remote", url: "https://mine.example", codemode: true },
  "kuvo-browser": { type: "local", command: ["kuvo-browser"] },
  // Up to date already.
  notion: pinned("notion"),
})

/** The same, up to date, as a Mac makes them. */
const upToDate = (root = shownRoot) => ({
  todoist: { type: "local", command: pinned("todoist").command, environment: { TODOIST_API_KEY: named(TODOIST, root), KUVO_NPX_APART: "1" }, disabled: true, codemode: false },
  "microsoft-365": { type: "local", command: pinned("microsoft-365").command, environment: { MS365_MCP_USE_KEYTAR: "0", KUVO_NPX_APART: "1" }, codemode: true },
  figma: pinned("figma"),
  github: { type: "remote", url: "https://api.githubcopilot.com/mcp/", oauth: false, headers: { Authorization: `Bearer ${named(GITHUB, root)}` }, codemode: false },
  caldav: { type: "local", command: ["kuvo-npx", "my-own-caldav@2.0.0"], environment: {}, codemode: false },
  mine: { type: "local", command: ["npx", "mine"], codemode: false },
  "mine-with-code-mode": { type: "remote", url: "https://mine.example", codemode: true },
  "kuvo-browser": { type: "local", command: ["kuvo-browser"] },
  notion: pinned("notion"),
})

/** What a Mac sends as it brings those settings up to date, each change as it sends it. */
const macChanges = (only?: string[], root = shownRoot) => {
  const now = upToDate(root) as Record<string, unknown>
  const changes = ["todoist", "microsoft-365", "figma", "github", "caldav"].map(id => ({ path: [...SERVERS, id], value: now[id] }))
  changes.push({ path: [...SERVERS, "mine", "codemode"], value: false })
  return only ? changes.filter(change => only.includes(change.path[2])) : changes
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-integrations-upgrade-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let tests = 0
let file = ""
let lock = ""
const write = (servers: unknown, more: object = {}) => writeFileSync(file, JSON.stringify({ ...more, mcp: { servers } }))
const read = () => JSON.parse(readFileSync(file, "utf8"))
/** Which write of the file this is: a write puts a new file in its place. */
const written = () => statSync(file).ino
const keep = (key: string) => {
  mkdirSync(BOX_KEYS, { recursive: true })
  writeFileSync(join(BOX_KEYS, key), "tok")
}
const kept = (key: string) => existsSync(join(BOX_KEYS, key))
const upgrade = () => upgradeIntegrations(catalogFile, file, lock)

beforeEach(() => {
  const folder = join(root, String(++tests))
  mkdirSync(folder)
  file = join(folder, "opencode.json")
  lock = join(folder, ".config.lock")
  for (const key of [TODOIST, FIGMA, GITHUB]) keep(key)
})

test("no Mac connects: an older machine's settings come up to date, with what you set on them, and a second time changes nothing", async () => {
  write(oldServers(), { permissions: [{ action: "edit", resource: "*", effect: "ask" }], model: "mine/best" })
  await upgrade()
  const after = read()
  expect(after.mcp.servers).toEqual(upToDate())
  expect(after.permissions).toEqual([{ action: "edit", resource: "*", effect: "ask" }])
  expect(after.model).toBe("mine/best")
  expect(kept(FIGMA)).toBe(false)
  expect(kept(TODOIST)).toBe(true)
  expect(kept(GITHUB)).toBe(true)

  const was = written()
  await upgrade()
  expect(written()).toBe(was)
})

test("a Mac first: what it made stays as it is, with no write, and only what was added since is brought up to date", async () => {
  write(oldServers())
  expect(changeSettings(macChanges(), file, lock).status).toBe(200)
  rmSync(join(BOX_KEYS, FIGMA))
  expect(read().mcp.servers).toEqual(upToDate())

  const was = written()
  await upgrade()
  expect(written()).toBe(was)
  expect(read().mcp.servers).toEqual(upToDate())

  // Added from a phone after the Mac left.
  expect(changeSettings([{ path: [...SERVERS, "from-a-phone"], value: { type: "remote", url: "https://phone.example" } }], file, lock).status).toBe(200)
  await upgrade()
  expect(read().mcp.servers).toEqual({ ...upToDate(), "from-a-phone": { type: "remote", url: "https://phone.example", codemode: false } })
})

test("the box first: a Mac that read them before it writes the same, and one that reads them after has nothing to write", async () => {
  write(oldServers())
  await upgrade()
  expect(read().mcp.servers).toEqual(upToDate())

  // Read before the box's write, sent after it.
  expect(changeSettings(macChanges(), file, lock).status).toBe(200)
  expect(read().mcp.servers).toEqual(upToDate())

  const was = written()
  await upgrade()
  expect(written()).toBe(was)
})

test("both at once: a Mac's changes land as the box waits its turn and after its write, and a phone's among them stays", async () => {
  write(oldServers())
  let open = () => {}
  const gate = new Promise<void>(resolve => { open = resolve })
  const held = keyWork(() => gate)
  const upgrading = upgrade()
  // While the box waits its turn: part of the Mac's changes, and a phone's.
  expect(changeSettings(macChanges(["todoist", "mine"]), file, lock).status).toBe(200)
  expect(changeSettings([{ path: [...SERVERS, "notion", "disabled"], value: true }], file, lock).status).toBe(200)
  open()
  await held
  await upgrading
  // The rest of what the Mac read before: its connection went before it could send the others.
  expect(changeSettings(macChanges(["figma"]), file, lock).status).toBe(200)

  const notion = { ...pinned("notion"), disabled: true }
  expect(read().mcp.servers).toEqual({ ...upToDate(), notion })
  expect(kept(FIGMA)).toBe(false)
})

test("settings that can't be used are left alone, and a machine whose settings aren't its own yet gets none", async () => {
  writeFileSync(file, "{ // comments\n}")
  await upgrade()
  expect(readFileSync(file, "utf8")).toBe("{ // comments\n}")
  expect(kept(FIGMA)).toBe(true)

  rmSync(file)
  await upgrade()
  expect(existsSync(file)).toBe(false)
})

test("settings that can't be written after a key went: it says so, and the next start finishes", async () => {
  write(oldServers())
  const said = spyOn(console, "error").mockImplementation(() => {})
  chmodSync(dirname(file), 0o500)
  try {
    // (Its lock elsewhere: only the settings can't be written.)
    await upgradeIntegrations(catalogFile, file, join(root, `lock-${tests}`))
    expect(String(said.mock.calls[0]?.[0])).toContain("couldn't be brought up to date")
  } finally {
    chmodSync(dirname(file), 0o700)
    said.mockRestore()
  }
  expect(read().mcp.servers).toEqual(oldServers())
  expect(kept(FIGMA)).toBe(false)

  await upgrade()
  expect(read().mcp.servers).toEqual(upToDate())
})

test("with no catalog yet, integrations stay as they are but for their tools", async () => {
  const { todoist, figma } = oldServers()
  write({ todoist, figma })
  await upgradeIntegrations(join(root, "no-catalog.json"), file, lock)
  expect(read().mcp.servers).toEqual({ todoist: { ...todoist, codemode: false }, figma: { ...figma, codemode: false } })
  expect(kept(FIGMA)).toBe(true)
})

/** A machine's folder, with `servers` in its settings, a catalog and a key; no Mac, no bridge. */
function machineFolder(servers: unknown) {
  const machineRoot = realpathSync(mkdtempSync(join(root, "m-")))
  const home = join(machineRoot, ".kuvo-code")
  const settings = join(home, "box", "opencode.json")
  mkdirSync(join(home, "bin"), { recursive: true })
  mkdirSync(join(home, "run"), { recursive: true })
  mkdirSync(join(home, "box", "keys"), { recursive: true })
  writeFileSync(join(home, "bin", "integrations.json"), readFileSync(catalogFile))
  writeFileSync(settings, JSON.stringify({ mcp: { servers } }))
  writeFileSync(join(home, "box", "keys", FIGMA), "tok")
  // (On this test's runtime: the engine's Bun is one only with BUN_BE_BUN.)
  const env = { PATH: process.env.PATH!, HOME: machineRoot, KUVO_HOME: home, TMPDIR: tmpdir(), ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) }
  return { home, settings, env }
}

/** A machine with `servers` in its settings and a phone paired, so it runs a bridge; `before` sets up
 * what else it starts with, and `alsoAtStart` goes along with its start. Answers with its settings once
 * it's on the relay (with `until`, once they're as it says). */
async function machineStarts(servers: unknown, { before = () => {}, alsoAtStart = async () => {}, until }: {
  before?: (home: string) => void
  alsoAtStart?: (env: Record<string, string>) => Promise<unknown>
  until?: (settings: any) => boolean
} = {}) {
  const { home, settings, env } = machineFolder(servers)
  before(home)

  let poke = () => {}
  const relay = await relayStandIn({ addressOf }, { changed: () => poke() })
  const secret = crypto.randomBytes(32)
  writeFileSync(join(home, "run", "link.json"), JSON.stringify({
    id: "lab", name: "lab", relay: relay.url, secret: secret.toString("base64url"), key: newKey().toString("base64url"),
    phones: [{ key: publicOf(newKey()).toString("base64url"), name: "iPhone", added: Math.floor(Date.now() / 1000), from: "pair", pairing: crypto.randomBytes(16).toString("base64url") }],
  }), { mode: 0o600 })
  const bridge = Bun.spawn([process.execPath, main, "run"], { env, stdio: ["ignore", "ignore", "pipe"] })
  try {
    const also = alsoAtStart(env)
    let ended = false
    void bridge.exited.then(() => { ended = true; poke() })
    while (!relay.has(addressOf(secret)) && !ended) await new Promise<void>(resolve => { poke = resolve })
    if (ended) throw new Error(`the bridge ended: ${await new Response(bridge.stderr).text()}`)
    await also
    const now = () => JSON.parse(readFileSync(settings, "utf8"))
    if (until) {
      // (Looked at again as it starts, too: what changed before it watched it never tells.)
      const watcher = watchFolder(join(home, "box"), () => poke())
      try {
        while (!until(now()) && !ended) await new Promise<void>(resolve => { poke = resolve })
      } finally {
        watcher.close()
      }
    }
    return { settings: now(), figmaKept: existsSync(join(home, "box", "keys", FIGMA)) }
  } finally {
    bridge.kill("SIGTERM")
    await bridge.exited
    relay.close()
  }
}

test("a machine's bridge starting, with no Mac: the running box does it, before it answers anyone", async () => {
  const { settings, figmaKept } = await machineStarts(oldServers(MACHINE))
  expect(settings.mcp.servers).toEqual(upToDate(MACHINE))
  expect(figmaKept).toBe(false)
}, SPAWNS)

test("a Mac's change over SSH as the bridge starts, each its own process: the same settings whichever gets there first", async () => {
  const phone = { path: [...SERVERS, "notion", "disabled"], value: true }
  const { settings } = await machineStarts(oldServers(MACHINE), { alsoAtStart: async env => {
    const change = Bun.spawn([process.execPath, main, "box", "change"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    change.stdin.write(JSON.stringify({ changes: [...macChanges(["todoist", "mine"], MACHINE), phone] }))
    await change.stdin.end()
    expect(JSON.parse(await new Response(change.stdout).text()).status).toBe(200)
    await change.exited
  } })
  expect(settings.mcp.servers).toEqual({ ...upToDate(MACHINE), notion: { ...pinned("notion"), disabled: true } })
}, SPAWNS)

test("while an update is on trial a key stays, as the version before may come back; only that waits, and the next start takes it", async () => {
  write(oldServers())
  const trial = join(RUN, "update-trial")
  mkdirSync(RUN, { recursive: true })
  writeFileSync(trial, "9.9.9")
  try {
    await upgrade()
  } finally {
    rmSync(trial)
  }
  expect(read().mcp.servers).toEqual({ ...upToDate(), figma: oldServers().figma })
  expect(kept(FIGMA)).toBe(true)

  await upgrade()
  expect(read().mcp.servers).toEqual(upToDate())
  expect(kept(FIGMA)).toBe(false)
})

test("an update on trial, its bridge welcomed by the relay: confirmed, and what waited for that is done", async () => {
  const { settings, figmaKept } = await machineStarts(oldServers(MACHINE), {
    before: home => {
      writeFileSync(join(home, "run", "update-trial"), "9.9.9")
      writeFileSync(join(home, "bin", "box-version"), "9.9.9")
      writeFileSync(join(home, "run", "update.json"), JSON.stringify({ trial: { from: "9.9.8", to: "9.9.9", healthy: true } }))
    },
    until: now => now.mcp.servers.figma.url !== undefined,
  })
  expect(settings.mcp.servers).toEqual(upToDate(MACHINE))
  expect(figmaKept).toBe(false)
}, SPAWNS)

test("a machine's engine about to start, with no bridge and no Mac: its settings are up to date before it reads them", async () => {
  const { settings, home, env } = machineFolder(oldServers(MACHINE))
  const start = Bun.spawn([process.execPath, main, "engine-config"], { env, stdout: "pipe", stderr: "pipe" })
  const printed = await new Response(start.stdout).text()
  expect(await start.exited).toBe(0)
  expect(JSON.parse(printed)).toBeObject()
  expect(JSON.parse(readFileSync(settings, "utf8")).mcp.servers).toEqual(upToDate(MACHINE))
  expect(existsSync(join(home, "box", "keys", FIGMA))).toBe(false)
}, SPAWNS)

test("that command while an update is on trial: everything but the key, which the version before may need", async () => {
  const { settings, home, env } = machineFolder(oldServers(MACHINE))
  writeFileSync(join(home, "run", "update-trial"), "9.9.9")
  const start = Bun.spawn([process.execPath, main, "engine-config"], { env, stdout: "pipe", stderr: "pipe" })
  expect(await start.exited).toBe(0)
  expect(JSON.parse(readFileSync(settings, "utf8")).mcp.servers).toEqual({ ...upToDate(MACHINE), figma: oldServers(MACHINE).figma })
  expect(existsSync(join(home, "box", "keys", FIGMA))).toBe(true)
}, SPAWNS)

test("that command with no settings file there, as this Mac's app runs it: it prints what it prints and makes none", async () => {
  const { settings, env } = machineFolder({})
  rmSync(settings)
  const start = Bun.spawn([process.execPath, main, "engine-config"], { env, stdout: "pipe", stderr: "pipe" })
  expect(JSON.parse(await new Response(start.stdout).text())).toBeObject()
  expect(await start.exited).toBe(0)
  expect(existsSync(settings)).toBe(false)
}, SPAWNS)

test("a Mac connecting to a machine with no bridge, having put its newer catalogs there: what it reads back is up to date", async () => {
  const { settings, env } = machineFolder(oldServers(MACHINE))
  const adopt = Bun.spawn([process.execPath, main, "box", "adopt"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const answer = JSON.parse(await new Response(adopt.stdout).text())
  expect(await adopt.exited).toBe(0)
  expect(answer.status).toBe("own")
  expect(answer.settings.mcp.servers).toEqual(upToDate(MACHINE))
  expect(JSON.parse(readFileSync(settings, "utf8")).mcp.servers).toEqual(upToDate(MACHINE))
}, SPAWNS)

const popularFile = join(here, "../../KuvoLink/Vectors/routes/box/mcp-catalog.json")
const popular: { id: string; settings: { command: string[]; environment: Record<string, string> } }[] = JSON.parse(readFileSync(popularFile, "utf8")).servers
const devTools = popular.find(each => each.id === "chrome-devtools")!.settings
const devToolsPin = devTools.command[1]
const devToolsAdded = (command: string[], environment?: Record<string, string>) => write({ "chrome-devtools": { type: "local", command, ...(environment ? { environment } : {}) } })
const onMac = () => upgradeIntegrations(catalogFile, file, lock, popularFile, true)
const devToolsNow = () => read().mcp.servers["chrome-devtools"]

test("Chrome DevTools as an older version added it, on a Mac: pinned, run apart, its own profile, no usage statistics", async () => {
  devToolsAdded(["npx", "-y", "chrome-devtools-mcp@latest"])
  await onMac()
  expect(devToolsNow()).toEqual({ type: "local", codemode: false, command: devTools.command, environment: devTools.environment })
})

test("Chrome DevTools' version, by number: 1.9.9 moves up, one newer than Kuvo Code's stays", async () => {
  devToolsAdded(["npx", "-y", "chrome-devtools-mcp@1.9.9"])
  await onMac()
  expect(devToolsNow().command[1]).toBe(devToolsPin)

  const newer = `chrome-devtools-mcp@${devToolsPin.split("@")[1]}9`
  devToolsAdded(["npx", "-y", newer])
  await onMac()
  expect(devToolsNow().command[1]).toBe(newer)
})

test("Chrome DevTools keeps your options and environment, and doing it again writes nothing", async () => {
  devToolsAdded(["npx", "-y", "chrome-devtools-mcp@latest", "--no-isolated", "--headless", "--usage-statistics=true"], { MY_VAR: "x", KUVO_NPX_APART: "1" })
  await onMac()
  const now = devToolsNow()
  expect(now.command).toEqual(["kuvo-npx", devToolsPin, "--no-isolated", "--headless", "--usage-statistics=true"])
  expect(now.environment).toEqual({ ...devTools.environment, MY_VAR: "x" })

  const was = written()
  await onMac()
  expect(written()).toBe(was)
})

test("another server named chrome-devtools is yours, and on a machine, where it isn't offered, one stays as it is", async () => {
  devToolsAdded(["node", "my-chrome-server.js"])
  await onMac()
  expect(devToolsNow().command).toEqual(["node", "my-chrome-server.js"])

  devToolsAdded(["npx", "-y", "chrome-devtools-mcp@latest"])
  await upgradeIntegrations(catalogFile, file, lock, popularFile, false)
  expect(devToolsNow()).toEqual({ type: "local", command: ["npx", "-y", "chrome-devtools-mcp@latest"], codemode: false })
})

test("a package its maker's server replaces stays off if you turned it off, with the Code Mode you chose", async () => {
  const { figma } = oldServers()
  write({ figma: { ...figma, disabled: true, codemode: true } })
  await upgrade()
  expect(read().mcp.servers.figma).toEqual({ ...pinned("figma"), disabled: true, codemode: true })
  expect(kept(FIGMA)).toBe(false)

  const was = written()
  await upgrade()
  expect(written()).toBe(was)
})

test("a bot's own key for a package its maker's server replaces goes with it, and its folder's copy of the server; its others stay", async () => {
  const folder = join(BOTS, "mira", "workspace", ".opencode")
  const own = `${FIGMA}__MIRA`, other = `${TODOIST}__MIRA`
  const botSettings = join(folder, "opencode.json")
  mkdirSync(folder, { recursive: true })
  mkdirSync(BOT_KEYS, { recursive: true })
  writeFileSync(join(BOT_KEYS, own), "bot-tok")
  writeFileSync(join(BOT_KEYS, other), "bot-tok")
  const todoistHers = { type: "local", environment: { TODOIST_API_KEY: `{file:${BOT_KEYS}/${other}}` } }
  writeFileSync(botSettings, JSON.stringify({ mcp: { servers: {
    figma: { type: "local", environment: { FIGMA_API_KEY: `{file:${BOT_KEYS}/${own}}` } },
    todoist: todoistHers,
  } } }))
  try {
    write(oldServers())
    await upgrade()
    expect(existsSync(join(BOT_KEYS, own))).toBe(false)
    expect(existsSync(join(BOT_KEYS, other))).toBe(true)
    expect(JSON.parse(readFileSync(botSettings, "utf8")).mcp.servers).toEqual({ todoist: todoistHers })
    expect(read().mcp.servers.figma).toEqual(pinned("figma"))
  } finally {
    rmSync(join(BOTS, "mira"), { recursive: true, force: true })
    rmSync(join(BOT_KEYS, other), { force: true })
  }
})
