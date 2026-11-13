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
import { basename, dirname, join } from "node:path"
import { Accounts, parseProvider } from "./accounts"
import { record as recordArtifacts } from "./artifacts/record"
import type { Source } from "./artifacts/recorder"
import { ArtifactStore } from "./artifacts/store"
import { Auto } from "./auto"
import { Deps } from "./deps"
import { EngineAgent, EngineLink } from "./engine"
import { subscribe } from "./events"
import { Goals, type GoalPlaces } from "./goals"
import { SideQuestions } from "./btw"
import { Handoffs } from "./handoff"
import { Reviews } from "./reviews"
import { VoiceWords } from "./voice"
import { setToolProgram } from "./kuvotools"
import { dropCarriedSignIns, dropOwnPrograms, machineHome, onMachine, takeOwnFolders } from "./machine"
import { Snapshots } from "./snapshots"
import { Roster } from "./roster"
import { cancelSignIns, handler, signInsWaiting } from "./server"
import { updatesUnderWay } from "./updates"
import { launchLets, Renewal } from "./renewal"
import { keeperEngine } from "../shared/engines"
import { writeSecret } from "../shared/files"
import { leftSignIns } from "./signin"
import { commandLineOf } from "../shared/platform"
import { isRealBridgeFolder } from "../shared/account"
import { updateUnderWay } from "../shared/updating"
import { spawn } from "node:child_process"
import { bundleBuild } from "../shared/bundle"
import type { RenewalRecord } from "../shared/records"
import { Sessions } from "./sessions"
import { noteAgentsInside, untilSandboxDecided } from "./fence"
import { useSavedLoginPath } from "./proc"
import { setSkillSource } from "./skills"
import { setServerSource } from "./servers"
import { setSubagentSource } from "./subagents"
import { Carrying } from "./carry"
import { Store } from "./store"
import { server as requester } from "./groups/api"
import { SeatServer } from "./groups/peer"
import { LinkDirectory, PeerPost, type PeerParts } from "./groups/post"
import { GroupRunner } from "./groups/runner"
import { GroupStore } from "./groups/store"
import { queueFiles } from "../shared/queues"
import { HangWatch, isEngine } from "../shared/hang"
import { notesBeside } from "./notes"
import { agentAccounts, BOX_ONLY_SERVICES, Limits } from "./limits"
import { LimitsPeers } from "./limits-peers"
import { PricingStore } from "./usage/pricing"
import { antigravitySources, claudeSources, codexSources, cursorSources, engineCodexSource, engineHostedSources, grokSources, Usage, USAGE_SERVICES, UsageSettings } from "./usage/usage"
import { antigravityTransport } from "./usage/antigravity-plan"
import { cursorEndpoints } from "./usage/cursor-api"
import { UsagePeers } from "./usage/usage-peers"
import { ENGINE_SERVICES, EngineAccounts } from "./engine-limits"

const version = "1"
// The build it runs, as its bundle names it (none from its sources): read as it starts, so a newer
// one put in its place is told from it (renewal.ts).
const script = Bun.main
const build = bundleBuild(script)
// `selftest`: it loads and runs on this engine, and says which build it is (a bridge about to make
// way for it asks first, renewal.ts).
if (process.argv.slice(2).includes("selftest")) {
  console.log(`ok ${build}`)
  process.exit(0)
}
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
  // COMPAT(0.7 agents-runtime): sign-ins an older Mac carried over (`.from-mac`). Goes 3 months after 0.8.0.
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
// A test's: how long it waits for a quiet moment before it holds new turns for a newer bridge.
const renewHoldAfter = Number(process.env.KUVO_TEST_RENEW_HOLD) || undefined
// And how long nothing must run before it goes, and how long it must have run.
const renewSettle = process.env.KUVO_TEST_RENEW_SETTLE ? Number(process.env.KUVO_TEST_RENEW_SETTLE) : undefined
const renewUptime = process.env.KUVO_TEST_RENEW_UPTIME ? Number(process.env.KUVO_TEST_RENEW_UPTIME) : undefined
for (const name of ["KUVO_TEST_RENEW_HOLD", "KUVO_TEST_RENEW_SETTLE", "KUVO_TEST_RENEW_UPTIME"]) delete process.env[name]
// Temporary files of its own and the agents' (Claude Code's task output): the app gives it a
// folder in its own temporary folder.
const temporary = process.env.TMPDIR?.replace(/\/$/, "") || join(home, "tmp")
mkdirSync(temporary, { recursive: true })
// What an agent left unpacked when the bridge last stopped without cleaning up (Antigravity's
// agent unpacks itself, about 1 GB, for each run), and half-finished downloads.
rmSync(join(temporary, "antigravity"), { recursive: true, force: true })
// And the page of a sign-in one was in the middle of.
leftSignIns(temporary)
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
  // COMPAT(0.7 agents-runtime): the programs an older bridge installed in `agents/runtime`. Goes 3 months after 0.8.0.
  // The agents' programs are the machine's own now, found on its login shell's PATH (which a
  // command over SSH doesn't get), not copies of Kuvo Code's.
  dropOwnPrograms(join(home, "runtime"))
  useSavedLoginPath()
}
// COMPAT(0.7 agents-runtime): `cache/install`. Goes 3 months after 0.8.0.
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
setServerSource(link)
setSubagentSource(link, home)
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
// Tells the box's link, as it changes, whether every agent's process here runs in its sandbox
// (none started before it came on still runs): only then do agents use the vault.
// And restarts those you said to (`kuvo/sandbox/restart`): each between turns now, the rest as
// their turns end, looked at again with the note.
let restarting = false
const noteInside = () => {
  if (restarting) restarting = [sessions.restartOutside(), ...roster.all().map((agent) => agent.restartOutside?.() ?? false)].some(Boolean)
  noteAgentsInside(!sessions.outside() && !roster.all().some((agent) => agent.outside?.()))
}
const restartOutside = () => {
  restarting = true
  noteInside()
}
noteInside()
setInterval(noteInside, 5_000).unref?.()

// The group chats that live on this computer, run here: on a machine, in its Kuvo Code folder; on
// the Mac, where the app says (KUVO_GROUPS, with its bots in KUVO_BOTS and its trash in
// KUVO_TRASH). One that fails to start leaves the rest of the bridge as it is.
let self: ReturnType<typeof requester> | undefined
// The record of what agents made, told of each chat's part given to a bot (set once it starts, below).
let partGiven: ((prompt: string, chat: string) => void) | undefined
let groups: { runner: GroupRunner; store: GroupStore; peers: PeerParts } | undefined
const groupFolders = onMachine
  ? { root: join(machineHome!, "groups"), bots: process.env.KUVO_BOTS ?? join(machineHome!, "bots"), trash: join(machineHome!, "trash") }
  : process.env.KUVO_GROUPS && process.env.KUVO_BOTS && process.env.KUVO_TRASH
    ? { root: process.env.KUVO_GROUPS, bots: process.env.KUVO_BOTS, trash: process.env.KUVO_TRASH }
    : undefined
const groupMemoryKey = process.env.KUVO_GROUPS_MEMORY_KEY || undefined
// What this bridge tells your other computers (its group chats' mail, its plan limits), through the
// box's link, and who they are, as the link says.
const post = new PeerPost(groupFolders ? join(groupFolders.root, "peer-outbox.json") : undefined)
const directory = new LinkDirectory(post)
const peers: PeerParts = { post, directory }
// The record of what agents made here: on a machine, in its Kuvo Code folder; on the Mac, where
// the app says (its box's own folder). Its bots' folders, where their memory is.
const artifactsFolder = onMachine ? join(machineHome!, "artifacts") : process.env.KUVO_ARTIFACTS || undefined
const botsFolder = groupFolders?.bots ?? (onMachine ? join(machineHome!, "bots") : process.env.KUVO_BOTS || undefined)
// Who there is to name with "&" in a chat: the agents the box's link lists (on the Mac, where the app says).
const agentsFile = onMachine ? join(machineHome!, "run", "agents.json") : process.env.KUVO_AGENTS_FILE || undefined
// The box's queues, where a chat's part for a conversation you stopped waits (on the Mac, the box's run folder the app says).
const runFolder = onMachine ? join(machineHome!, "run") : process.env.KUVO_RUN || undefined
// Sessions' turns held with the box's link, in its run folder.
notesBeside(runFolder)
// Nor do the agents get these.
for (const name of ["KUVO_GROUPS", "KUVO_TRASH", "KUVO_GROUPS_MEMORY_KEY", "KUVO_AGENTS_FILE", "KUVO_ARTIFACTS", "KUVO_RUN", ...(onMachine ? [] : ["KUVO_BOTS"])]) delete process.env[name]
if (groupFolders) {
  try {
    const store = new GroupStore(groupFolders.root, groupFolders.bots, agentsFile)
    // Its bots in chats on your other computers, and theirs in chats here, through the box's link.
    const runner = new GroupRunner({
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
      peers: directory,
      given: (prompt, part) => partGiven?.(prompt, part.chat),
      queues: runFolder ? queueFiles(runFolder) : undefined,
    })
    const server = new SeatServer(runner.seats, post, { store, remembered: (from, memory) => runner.remembered(from, memory) })
    peers.server = server
    peers.runner = runner
    groups = { store, runner, peers }
  } catch (error) {
    console.error("group chats:", error)
  }
}

// Goals conversations work toward, the engine's and the coding agents' here alike, kept in the
// bridge's folder and run with no client there.
const places: GoalPlaces = {
  engine: {
    api: link,
    listen: (session, told) => link.listen(session, { event: (event) => told.event(event.type, event.data), reconnected: told.reconnected }),
  },
  bridge: {
    api: { request: (...args) => (self ? self.request(...args) : Promise.reject(new Error("The bridge isn't listening yet."))) },
    listen: (session, told) => subscribe((event) => event.data?.sessionID === session && told.event(event.type, event.data)),
  },
  isBridge: (session) => {
    try {
      sessions.get(session)
      return true
    } catch {
      return false
    }
  },
}
const goals = new Goals(join(home, "goals.json"), places)
// Goals paused at a limit, looked at once a minute too: a timer can come late after the computer
// slept.
setInterval(() => goals.resumeDue(), 60_000).unref?.()
// Its other keywords, for the same conversations: side questions, handoffs and reviews.
const sideQuestions = new SideQuestions(join(home, "side-questions.json"), places)
const handoffs = new Handoffs(places)
const reviews = new Reviews(join(home, "reviews.json"), places)
// The project's words for voice input to listen for, in the same conversations.
const voice = new VoiceWords(places)
// Your plans' limits for each account here, read on their makers' schedules and kept between runs.
// The engine's sign-ins too (Settings › Accounts), as the engine lists them with their secrets.
const engineAccounts = new EngineAccounts(() => link.request("GET", "/api/credential"))
const limits = new Limits(() => [...agentAccounts(roster.all()), ...engineAccounts.accounts()], join(home, "limits.json"), Date.now, () => engineAccounts.refresh(), () => engineAccounts.answered)
// (And Antigravity's, which only boxes read: covered here signed in or not.)
limits.alsoServices = [...ENGINE_SERVICES, ...BOX_ONLY_SERVICES]
// Shared with your other computers' boxes: each account read once across them, and listed on each.
peers.limits = new LimitsPeers(limits, post, directory, join(home, "limits-peers.json"))
// What each account used, by the quarter hour, from its agent's logs here, priced; shared the same
// way. Prices come from the web only to a real box's bridge: never in a test, however it started
// this (the Mac app's tests start it through the app; test-safety.js also says
// KUVO_TEST_PRICE_FEEDS=off).
const noPriceFeeds = process.env.KUVO_TEST_PRICE_FEEDS === "off" || !isRealBridgeFolder(home)
delete process.env.KUVO_TEST_PRICE_FEEDS
const usageFolder = join(home, "usage")
const usageSettings = new UsageSettings(join(usageFolder, "settings.json"))
const claudeUsage = claudeSources(usageFolder)
const codexUsage = codexSources(usageFolder, () => usageSettings.codexFallback)
// The engine's own databases: in Kuvo Code's folder on a machine (`data/opencode`), in the app's
// on a Mac (KUVO_ENGINE_DB_FOLDER, which its keeper gives the bridge).
const engineData = process.env.KUVO_ENGINE_DB_FOLDER || (onMachine && machineHome ? process.env.KUVO_ENGINE_DATA || join(machineHome, "data", "opencode") : undefined)
// (Until the engine has listed its sign-ins, as the bridge starts: as this box kept it before.)
const engineCodexUsage = engineCodexSource(
  engineData,
  () => (engineAccounts.answered ? engineAccounts.accounts().some((account) => account.provider === "openai") : undefined),
  () => usage.has("openai"),
)
const antigravityUsage = antigravitySources(usageFolder)
const grokUsage = grokSources(usageFolder)
const engineHostedUsage = engineHostedSources(engineData)
// Cursor's plan and its usage history, asked of Cursor with Kuvo Code's own Cursor sign-in: only
// from a real box's bridge, never a test's, whatever sign-in its folder holds.
cursorEndpoints.live = !noPriceFeeds
antigravityTransport.live = !noPriceFeeds
const cursorUsage = cursorSources(usageFolder, (provider, identity) => limits.held(provider) || (identity !== undefined && !!usage.peers?.readsWhole("cursor", identity)))
const usage = new Usage(() => [...claudeUsage(roster.all()), ...codexUsage(roster.all()), ...grokUsage(roster.all()), ...engineCodexUsage(), ...engineHostedUsage(), ...cursorUsage(roster.all()), ...antigravityUsage(roster.all())], new PricingStore(join(usageFolder, "pricing"), noPriceFeeds ? null : undefined), (provider) => limits.identity(provider), join(usageFolder, "usage.json"))
usage.settings = usageSettings
// The engine's sign-ins known (a box's first ChatGPT use shows at once, not a round later).
engineAccounts.onAnswered = () => void usage.tick()
// (OpenCode's hosted spend only where this box knows its engine's folder: else a client reads it as before.)
if (!engineData) usage.services = USAGE_SERVICES.filter((service) => service !== "opencode")
peers.usage = new UsagePeers(usage, post, directory, join(usageFolder, "peers.json"))

// What every conversation here makes, recorded as it's made: the engine's and this bridge's own.
// One that fails to start leaves the rest of the bridge as it is.
let artifacts: ArtifactStore | undefined
let noted: ((session: string, path: string, via: string) => Promise<boolean>) | undefined
if (artifactsFolder) {
  try {
    // With the files Codex's kept replies cited as what it made, read as the bridge started: shown.
    artifacts = new ArtifactStore(artifactsFolder, { bots: botsFolder, shown: sessions.cited })
    const { recorder } = recordArtifacts(artifacts, { bots: botsFolder })
    const engineSource: Source = {
      name: "engine",
      session: async (id) => {
        const found = await link.request<any>("GET", `/api/session/${encodeURIComponent(id)}`)
        return found?.data ?? found
      },
      agent: () => "engine",
    }
    const bridgeSource: Source = {
      name: "bridge",
      session: async (id) => {
        try {
          return sessions.get(id)
        } catch {
          return undefined
        }
      },
      agent: (id) => {
        try {
          const provider = sessions.get(id).model?.providerID
          return (provider && parseProvider(provider)?.kind) || "engine"
        } catch {
          return undefined
        }
      },
    }
    partGiven = (prompt, chat) => recorder.given(prompt, chat)
    noted = (session, path, via) => recorder.noted([engineSource, bridgeSource], session, path, via)
    link.watch((event) => void recorder.heard(engineSource, event))
    subscribe((event) => void recorder.heard(bridgeSource, event))
  } catch (error) {
    console.error("artifacts:", error)
  }
}

// Nothing starts a coding agent before it listens (an app's first ask, a group chat, a goal), and it
// listens once the box has set up its sandbox: on this Mac the app starts it before the box, so an
// agent started then would run outside the sandbox until it stops.
await untilSandboxDecided()
limits.start()
usage.start()
const carrying = new Carrying(sessions, store, (provider) => sessions.agent(provider), (kind) => roster.all().filter((agent) => parseProvider(agent.providerID)?.kind === kind))
let server: ReturnType<typeof Bun.serve>
/** Making way for a newer bridge in its place, on a machine (below). */
let renewal: Renewal | undefined
const answer = handler({ roster, sessions, auto, link, password, version, build, groups, peers, goals, sideQuestions, handoffs, places, reviews, voice, artifacts, noted, restartOutside, carrying, limits, usage })
/** Requests being answered now (but the event feed's, which stays open): a newer bridge waits for them. */
let answering = 0
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/api/event") return answer(request)
      answering++
      // One that can start something (a message, a change) starts a quiet moment's count again; one
      // that only reads doesn't: the link asks whether it answers every half minute, and a client
      // reads what it shows (counted while they're answered all the same).
      if (request.method !== "GET" && request.method !== "HEAD") renewal?.busied()
      return answer(request).finally(() => answering--)
    },
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
  // Sessions whose background work ended as the bridge last stopped hear so now, and what the
  // bridge before this one held for it goes.
  sessions.wakeLost()
  sessions.wakeHeld()
  goals.start()
  sideQuestions.start()
  reviews.resume()
  try {
    groups?.runner.start()
    groups?.peers.server?.start()
    // What bots are still to be told of their chats, now and each minute, as your other computers' bots become known.
    if (groups) {
      const runner = groups.runner
      // COMPAT(0.7 mac-group-chats): `pending-memory.json` from `GroupMigration`. Goes 3 months after 0.8.0.
      void runner.catchUpMemory().catch((error) => console.error("group memory:", error))
      setInterval(() => void runner.catchUpMemory().catch(() => {}), 60_000).unref?.()
    }
  } catch (error) {
    console.error("group chats:", error)
  }
})
// On a machine, where it's reached, for kuvo-wake and Kuvo Code's tools there (as the engine's
// launch writes engine.json): only this user can read it, and it goes when the bridge does. With the
// build it runs, and how it makes way for a newer one put in its place (renewal.ts), for the box to
// say (`kuvo/info`'s `pieces`).
const record = onMachine ? join(machineHome!, "run", "bridge.json") : undefined
const writeRecord = (renewal: RenewalRecord | null, first = false) => {
  if (!record) return
  try {
    writeSecret(record, JSON.stringify({ pid: process.pid, port: server.port, password, build, renewal }))
  } catch (error) {
    if (first) throw error
  }
}
writeRecord(null, true)

// A newer bridge put in its place on a machine (a Mac that connected brought it): it makes way at
// the first quiet moment, never cutting a turn, and the machine's launch starts the new one, which
// starts what waited for it (renewal.ts). (This Mac's own bridge takes a new version with its app,
// whose keeper starts the box again once nothing runs.)
/** Whether its launch starts it again, as last worked out (`lets`, below). */
let launchSaid: { at: number; lets: boolean } | undefined
renewal =
  onMachine && build
    ? new Renewal({
        script,
        build,
        work: () => {
          const here = sessions.work()
          // (An agent's program updating is cut by nothing: an installer stopped halfway can leave it broken.)
          const turns = here.turns || answering > 0 || (groups?.runner.busy() ?? false) || updatesUnderWay()
          const other = here.other || goals.busy() || sideQuestions.busy() || reviews.busy() || handoffs.busy() || signInsWaiting()
          return { turns, other }
        },
        hold: (on) => sessions.hold(on),
        renew: () => {
          console.error("A newer bridge is in place: this one makes way for it.")
          stop()
        },
        told: (state) => writeRecord(state),
        paused: () => updateUnderWay(join(machineHome!, "run")),
        // Only on the engine its keeper starts: one a Mac brought with a newer engine it kept from
        // starting (sessions were at work) waits for that engine, which starts it.
        ready: () => {
          const kept = keeperEngine(machineHome!)
          return !kept || kept === basename(dirname(process.execPath))
        },
        // Only while the launch keeping it will start the new one (renewal.ts, `launchLets`).
        // (Its parent's command line and its launch's log, read once a minute at most.)
        lets: () => {
          const now = Date.now()
          if (launchSaid && now - launchSaid.at < 60_000) return launchSaid.lets
          const lets = launchLets(commandLineOf(process.ppid), () => {
            try {
              return readFileSync(join(machineHome!, "run", "agents.log"), "utf8")
            } catch {
              return undefined
            }
          })
          launchSaid = { at: now, lets }
          return lets
        },
        uptime: () => performance.now(),
        longEnough: renewUptime,
        // Only for a bundle that loads and runs on this engine.
        check: (newer) =>
          new Promise<boolean | undefined>((done) => {
            const env: Record<string, string> = { BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", PATH: process.env.PATH ?? "/usr/bin:/bin" }
            const checking = spawn(process.execPath, ["--config=/dev/null", "--no-env-file", script, "selftest"], { env, stdio: ["ignore", "pipe", "ignore"] })
            let said = ""
            checking.stdout.on("data", (chunk) => (said += chunk))
            let late = false
            const timer = setTimeout(() => ((late = true), checking.kill("SIGKILL")), 60_000)
            // (One that couldn't start, or ran out of time, says nothing of the bundle: asked again.)
            checking.on("error", () => (clearTimeout(timer), done(undefined)))
            checking.on("close", (code, signal) => {
              clearTimeout(timer)
              // (Ended by a signal, out of memory say, or out of time: nothing said of the bundle.)
              done(late || signal ? undefined : code === 0 && said.trim() === `ok ${newer}`)
            })
          }),
        holdAfter: renewHoldAfter,
        settle: renewSettle,
      })
    : undefined
renewal?.start()
// The moment a turn ends may be the quiet one: a quiet moment counts from it.
const renewing = renewal
if (renewing) subscribe((event) => {
  if (event.type !== "session.idle") return
  renewing.busied()
  renewing.look()
})

// This box's engine, ended should it hang (it's started again as after a crash), on a machine and on
// this Mac alike. This box's link watches this bridge in turn (link/main.ts).
if (runFolder) new HangWatch({ name: "engine", run: runFolder, record: join(runFolder, "engine.json"), isIt: isEngine }).start()

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  // Goals first: the turns cut short as it stops aren't theirs to read as yours.
  goals.stopAll()
  sideQuestions.stopAll()
  reviews.stopAll()
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
