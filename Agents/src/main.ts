// Kuvo Code's agents bridge: sessions with the coding agents you already have (Claude Code, Codex,
// Cursor, Grok, Antigravity), signed in as you, served to the app in the engine's own API.
//
// Started like the engine: it prints `{"url": …}` once it's listening, answers only with the
// password in OPENCODE_PASSWORD, and stops when its stdin closes (so it can't outlive the app).
// It keeps what it has in KUVO_AGENTS_HOME.
//
// On one of your machines (KUVO_AGENTS_REMOTE, see machine.ts) the engine's launch starts it beside
// the engine, with the same settings: it listens on KUVO_AGENTS_PORT with the password in
// KUVO_AGENTS_PASSWORD, reaches the engine on KUVO_ENGINE_PORT with OPENCODE_PASSWORD, and lives
// as long as the engine (KUVO_ENGINE_PID) does, the Mac connected or not.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Accounts, parseProvider } from "./accounts"
import { Auto } from "./auto"
import { Deps } from "./deps"
import { EngineAgent, EngineLink } from "./engine"
import { setToolProgram } from "./kuvotools"
import { dropCarriedSignIns, dropOwnPrograms, machineHome, onMachine, takeOwnFolders } from "./machine"
import { Snapshots } from "./snapshots"
import { Roster } from "./roster"
import { cancelSignIns, handler } from "./server"
import { Sessions } from "./sessions"
import { refreshLoginPath } from "./proc"
import { setSkillSource } from "./skills"
import { Store } from "./store"
import { server as requester } from "./groups/api"
import { GroupRunner } from "./groups/runner"
import { GroupStore } from "./groups/store"

const version = "1"
const home = process.env.KUVO_AGENTS_HOME
const password = onMachine ? process.env.KUVO_AGENTS_PASSWORD : process.env.OPENCODE_PASSWORD
const enginePID = Number(process.env.KUVO_ENGINE_PID)
if (!home || !password || (onMachine && (!machineHome || !Number(process.env.KUVO_AGENTS_PORT) || !Number(process.env.KUVO_ENGINE_PORT) || !enginePID))) {
  console.error(onMachine ? "KUVO_AGENTS_HOME, KUVO_HOME, KUVO_AGENTS_PORT, KUVO_AGENTS_PASSWORD, KUVO_ENGINE_PORT and KUVO_ENGINE_PID are needed." : "KUVO_AGENTS_HOME and OPENCODE_PASSWORD are needed.")
  process.exit(2)
}
// On a machine: its engine, and Kuvo Code's tools as the engine has them.
const machineEngine = onMachine ? { url: `http://127.0.0.1:${process.env.KUVO_ENGINE_PORT}`, password: process.env.OPENCODE_PASSWORD } : undefined
const port = onMachine ? Number(process.env.KUVO_AGENTS_PORT) : 0
if (onMachine) {
  setToolProgram(process.env.OPENCODE_CONFIG_CONTENT)
  // The bridge and its agents keep their folders in Kuvo Code's (XDG_… there); the commands the
  // agents run get the machine's own back (machine.ts).
  takeOwnFolders()
  // Each machine signs its agents in on its own: none a Mac carried over before stays.
  if (home) dropCarriedSignIns(home)
  // Kuvo Code's commands (kuvo-wake) first, as for the engine, and where bots' and sessions'
  // wake-ups are kept.
  process.env.KUVO_BIN = join(machineHome!, "bin")
  process.env.KUVO_BOTS ??= join(machineHome!, "bots")
  process.env.KUVO_WAKES ??= join(machineHome!, "wakes")
  // Nor do they get what the engine starts with: its settings, with keys in them, nor these.
  for (const name of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CLIENT", "KUVO_AGENTS_PASSWORD", "KUVO_AGENTS_PORT", "KUVO_ENGINE_PORT", "KUVO_ENGINE_PID"]) delete process.env[name]
}
// Temporary files of its own and the agents' (Claude Code's task output): the app gives it a
// folder in its own temporary folder.
const temporary = process.env.TMPDIR?.replace(/\/$/, "") || join(home, "tmp")
mkdirSync(temporary, { recursive: true })
// What an agent left unpacked when the bridge last stopped without cleaning up (Antigravity's
// agent unpacks itself, about 1 GB, for each run), and half-finished downloads.
rmSync(join(temporary, "antigravity"), { recursive: true, force: true })
try {
  for (const name of readdirSync(join(home, "antigravity"))) if (name.startsWith(".install-")) rmSync(join(home, "antigravity", name), { recursive: true, force: true })
} catch {}

// The engine's binary runs this as Bun when told to: the agents it starts aren't told so.
delete process.env.BUN_BE_BUN
// A wake-up an agent's command schedules (kuvo-wake) comes back to this bridge's session.
process.env.KUVO_WAKE_VIA = "bridge"
// Nor do they get its password: every agent, and each command one runs, gets this environment,
// and an `env` there would print it, for the model to read and any process here to use.
delete process.env.OPENCODE_PASSWORD

// An SDK's promise nobody waits for, rejected (Cursor's when a shell fails to start), stops nothing.
process.on("unhandledRejection", (reason) => console.error("unhandled:", reason))
// Anything else: said, and it stops (on a machine, it's started again).
process.on("uncaughtException", (error) => {
  console.error("uncaught:", error)
  process.exit(1)
})

const deps = new Deps(join(home, "runtime"), join(home, "cache"))
if (onMachine) {
  // The agents' programs are the machine's own now, found on its login shell's PATH (which a
  // command over SSH doesn't get), not copies of Kuvo Code's.
  dropOwnPrograms(join(home, "runtime"))
  void refreshLoginPath()
}
// What an earlier bridge left of its downloads (it kept them on this Mac): nothing installs yet.
rmSync(join(home, "cache", "install"), { recursive: true, force: true })
const context = { home, temporary, deps }
const roster = new Roster(new Accounts(home), context)
const store = new Store(join(home, "sessions"))
const auto = new Auto(home)
// The engine's own models, run in sessions here (the app says where the engine is).
const link = new EngineLink()
if (machineEngine) link.configure(machineEngine.url, machineEngine.password)
// The skills Settings › Skills lists, for the agents too (the engine lists them).
setSkillSource(link, home)
const engineAgents = new Map<string, EngineAgent>()
function engineAgent(providerID: string): EngineAgent | undefined {
  if (!link.ready || parseProvider(providerID)) return undefined
  let agent = engineAgents.get(providerID)
  if (!agent) engineAgents.set(providerID, (agent = new EngineAgent(link, providerID)))
  return agent
}
const sessions = new Sessions(
  store,
  roster,
  auto,
  engineAgent,
  (directory) => link.policies(directory),
  (name, directory) => link.agent(name, directory),
  new Snapshots(join(home, "snapshots")),
  (directory) => link.titleModel(directory),
)

// The group chats that live on this computer, run here: on a machine, in its Kuvo Code folder; on
// the Mac, where the app says (KUVO_GROUPS, with its bots in KUVO_BOTS and its trash in
// KUVO_TRASH), once it does (until then the app runs its own). One that fails to start leaves the
// rest of the bridge as it is.
let self: ReturnType<typeof requester> | undefined
let groups: { runner: GroupRunner; store: GroupStore } | undefined
const groupFolders = onMachine
  ? { root: join(machineHome!, "groups"), bots: process.env.KUVO_BOTS ?? join(machineHome!, "bots"), trash: join(machineHome!, "trash") }
  : process.env.KUVO_GROUPS && process.env.KUVO_BOTS && process.env.KUVO_TRASH
    ? { root: process.env.KUVO_GROUPS, bots: process.env.KUVO_BOTS, trash: process.env.KUVO_TRASH }
    : undefined
const groupMemoryKey = process.env.KUVO_GROUPS_MEMORY_KEY || undefined
// Nor do the agents get these.
for (const name of ["KUVO_GROUPS", "KUVO_TRASH", "KUVO_GROUPS_MEMORY_KEY", ...(onMachine ? [] : ["KUVO_BOTS"])]) delete process.env[name]
if (groupFolders) {
  try {
    const store = new GroupStore(groupFolders.root, groupFolders.bots)
    groups = {
      store,
      runner: new GroupRunner({
        store,
        engine: link,
        bridge: () => self,
        trash: groupFolders.trash,
        listen: (session, listener) => link.listen(session, listener),
        place: onMachine ? "this machine" : undefined,
        memoryKey: groupMemoryKey,
        // A coding agent's own account, as Settings › Accounts shows it: one with a way to sign in, not signed in.
        agentAccount: async (provider) => {
          const agent = roster.find(provider)
          if (!agent) return undefined
          const account = await agent.account()
          return { name: agent.name, signedOut: !account.signedIn && agent.methods().length > 0 }
        },
      }),
    }
  } catch (error) {
    console.error("group chats:", error)
  }
}

let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: handler({ roster, sessions, auto, link, password, version, groups }),
  })
} catch (error: any) {
  console.error("couldn't listen:", error?.message ?? error)
  // On a machine, its port taken: the launch gives it another.
  process.exit(onMachine && /in use|EADDRINUSE/i.test(String(error?.code ?? error?.message ?? error)) ? 98 : 1)
}
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }))
self = requester(`http://127.0.0.1:${server.port}`, password)
// Once the engine's there (the app says where, a moment after this starts on the Mac): parts under
// way are followed again, and meetings held.
void link.whenReady().then(() => {
  try {
    groups?.runner.start()
  } catch (error) {
    console.error("group chats:", error)
  }
})
// On a machine, where it's reached, for kuvo-wake and Kuvo Code's tools there (as the engine's
// launch writes engine.json): only this user can read it, and it goes when the bridge does.
const record = onMachine ? join(machineHome!, "run", "bridge.json") : undefined
if (record) {
  writeFileSync(record + ".new", JSON.stringify({ pid: process.pid, port: server.port, password }), { mode: 0o600 })
  renameSync(record + ".new", record)
}

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  cancelSignIns()
  // (Unless a newer bridge has put its own there.)
  try {
    if (record && JSON.parse(readFileSync(record, "utf8")).pid === process.pid) rmSync(record, { force: true })
  } catch {}
  sessions.closeAll()
  store.flush()
  server.stop(true)
  process.exit(0)
}
if (onMachine) {
  // Its engine stopped (or another started in its place, which starts its own bridge).
  setInterval(() => {
    try {
      process.kill(enginePID, 0)
    } catch {
      stop()
    }
  }, 5_000)
} else {
  process.stdin.on("end", stop)
  process.stdin.on("close", stop)
  process.stdin.resume()
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
