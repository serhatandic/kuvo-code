// Codex, as T3 Code runs it: your own `codex`, signed in with ChatGPT or an API key (what
// `codex login` keeps), driven through its app-server (JSON-RPC over stdio). One app-server
// serves every Codex session, each one of its threads; while the box's sandbox is on, each session
// has one of its own, run whole in it.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { providerID, type AgentAccount } from "../accounts"
import type { Agent, AgentContext, Account, ConversationFiles, ConversationPlace, MessageInput, RunInput, RunResult, SignInAttempt, SignInOptions, SubagentMessages, SubagentRun, Thread, TurnHooks, PromptFile } from "../agent"
import type { Limit } from "../auto"
import { accountName, ContextWindows, failure, KnownAccount, model, signOutWith } from "../agent"
import { fileDiff, fromPatch } from "../diff"
import { emit } from "../events"
import { allowedFolders, fenceAgent, fenceAttachments, fenceCopy, fenceKey, fenceRules, seatBot, fullAccessMark } from "../fence"
import { kuvoTools, toolServerName } from "../kuvotools"
import { dropRelayed, relayedServers, relayedTools, relayPort } from "../toolrelay"
import { computerServers } from "../servers"
import { pictureData, pictureFile, withPictures } from "../pictures"
import { elicitationField } from "../forms"
import { newID } from "../ids"
import { onMachine, ownFoldersConfig } from "../machine"
import { install, maintenance, update, type MaintenanceDefinition } from "../maintenance"
import { which } from "../proc"
import { chatGPTIdentity, LimitsProblem, type LimitReading, type LimitsSource, type LimitWindow } from "../limits"
import { RPC, RPCError } from "../rpc"
import { CodexCitations, plainCitations, type Said } from "./codex-citations"
import { engineSkills, skillsFolder, skillsFor, skillsRoot, turnedOff, upward, within } from "../skills"
import { codexSubagents, subagentsFor, subagentsRoot } from "../subagents"
import { instructionsNote, toldOf } from "../told"
import type { Turn } from "../turn"
import type { FileDiff, FormField, Model, ModelRef, OAuthStatus, Session } from "../wire"

const places = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), join(homedir(), ".codex/bin")]
const outputLimit = 30_000
/**
 * While the box's sandbox is on, Codex runs whole in it, with its commands and all it starts (its
 * own sandbox off: one can't be made inside another). Besides the session's folder it writes its
 * home's state (on a Mac; on Linux, a machine's Codex home is Kuvo Code's own, and written whole):
 * its sign-in, its databases and these folders (its conversations, logs, caches). Nothing else
 * there: what your Codex reads as it starts or as you work with it, and runs or takes as its
 * instructions (its settings, hooks and rules; its plugins, their repository in `.tmp`, its helpers
 * in `tmp`, the scripts it sources in `shell_snapshots`; its models' instructions; the ChatGPT
 * app's state and socket). (Its memories' database it opens as it starts, so it writes that too.)
 * Its sign-in it saves whole (from 0.167): a new file beside it (`.auth-` and six letters), then
 * renamed onto `auth.json`. A name like that it never reads, and the sandbox goes by the name a
 * file is renamed to, so one can't become its settings.
 */
const STATE_IN_HOME = [
  "sessions", "archived_sessions", "log", "logs", "cache", "sqlite", "thread-writer-locks", "generated_images",
  "auth.json*", ".auth-*", "installation_id", "version.json", "history.jsonl", ".personality_migration", ".sandbox_migration", "*.lock",
  "state_*.sqlite*", "logs_*.sqlite*", "goals_*.sqlite*", "queue_*.sqlite*", "thread_history_*.sqlite*", "memories_*.sqlite*",
]
/** What it never writes in its state either: settings put there. */
const KEPT_IN_HOME = ["*.toml", ".env", "hooks.json", "rules"]

/**
 * Codex's plugins that drive your computer (ChatGPT's Computer Use), off for every thread here
 * even where your Codex settings turn them on: they click around your Mac with no card to allow it.
 * (Written without quotes: `-c` takes a key's dots as its path. Harmless where they aren't.)
 */
const noComputerUse = ["unified-computer-use@openai-bundled", "computer-use@openai-bundled"]

/** The app-server outside the box's sandbox, while it's off: your account's, and every session's (`CodexAgent.slots`). */
const SHARED = ""
/** Your account's app-server while the box's sandbox is on, run whole in it, in Codex's home. */
const ACCOUNT = "account"

/** An app-server, as it runs now. */
interface Slot {
  server?: RPC
  starting?: Promise<RPC>
  /** Its app-server while it's starting, before it's `server`. */
  opening?: RPC
  /** The one still running the old Codex, or with the box's sandbox as it was. */
  outdated?: RPC
  /** The box's sandbox as it started with it (`fenceKey`). */
  fence?: string
  lastUse: number
}

/** A Codex thread's ID, and its rollout's name in `sessions` (`<year>/<month>/<day>/rollout-<when>-<id>.jsonl`). */
const CODEX_THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLLOUT = /^(?:\d{4}\/\d{2}\/\d{2}\/)?rollout-[0-9A-Za-z:.-]+\.jsonl$/

/** Thread `id`'s rollout in `home`: in `sessions` by day, or `archived_sessions`. */
export function rolloutOf(home: string, id: string): string | undefined {
  const named = (name: string) => name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`)
  const list = (folder: string) => {
    try {
      return readdirSync(folder)
    } catch {
      return []
    }
  }
  // A thread's file is under the day it started, which its id says (a UUIDv7's first 48 bits are
  // when it was made), as this computer's clock gave it.
  const sessions = join(home, "sessions")
  const made = /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id) ? parseInt(id.replace(/-/g, "").slice(0, 12), 16) : NaN
  if (Number.isFinite(made))
    for (const off of [0, -1, 1]) {
      const day = new Date(made + off * 86_400_000)
      const folder = join(sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"))
      const found = list(folder).find(named)
      if (found) return join(folder, found)
    }
  const archived = list(join(home, "archived_sessions")).find(named)
  if (archived) return join(home, "archived_sessions", archived)
  // (Else every day, newest first.)
  for (const year of list(sessions).sort().reverse())
    for (const month of list(join(sessions, year)).sort().reverse())
      for (const day of list(join(sessions, year, month)).sort().reverse()) {
        const found = list(join(sessions, year, month, day)).find(named)
        if (found) return join(sessions, year, month, day, found)
      }
}

export class CodexAgent implements Agent {
  id = "codex"
  compacts = true
  readonly providerID: string
  get name() {
    return accountName("Codex", this.instance)
  }
  /** OpenAI's installer, as its docs give it (it needs no Node). */
  install = "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
  /**
   * Its app-servers: while the box's sandbox is off, one for all (`SHARED`); while it's on, your
   * account's (`ACCOUNT`: its sign-in, its models, one-off answers) and each session's own, run
   * whole in it (`fenceAgent`), with that session's folder, wake-ups and Kuvo Code tools. A
   * session's turn never goes to another's, nor to your account's.
   */
  private slots = new Map<string, Slot>()
  /** The app-servers run whole in the box's sandbox. */
  private fencedServers = new WeakSet<RPC>()
  /** Its app-servers started outside the box's sandbox, from their start until they stop. */
  private unfencedServers = new Set<RPC>()
  private threads = new Map<string, CodexThread>()
  /** One-off answers under way (`generate`), by their thread: what each is told. */
  private oneOffs = new Map<string, { rpc: RPC; notify: (method: string, params: any) => void; fail: (error: Error) => void }>()
  private logins = new Map<string, (status: OAuthStatus) => void>()
  private modelList?: { at: number; models: Model[] }
  /**
   * Each session's folder of Settings › Skills' skills. Codex takes extra skills for its whole
   * app-server, not a thread, so it has all of them (they differ only by a project's own).
   */
  private skillRoots = new Map<string, string>()
  /** The skills folders each app-server was told. */
  private rootsSet = new WeakMap<RPC, string>()
  /** Your plan's usage windows as Codex last said, by limit ("codex" is the plan's; others, a model's). */
  rateLimits = new Map<string, any>()

  /**
   * Its plan's limits, as Codex reads them from ChatGPT with its own sign-in (`account/rateLimits/read`
   * on your account's app-server), every ten minutes; what a turn hears between (`account/rateLimits/updated`).
   */
  readonly limits: LimitsSource = {
    every: 10 * 60_000,
    read: () => this.readLimits(),
    identity: () => this.chatGPTAccount(),
  }

  /** Who its ChatGPT sign-in is, as its token in its home says (never sent anywhere); none in the Keychain. */
  private chatGPTAccount(): string | undefined {
    try {
      const tokens = JSON.parse(readFileSync(join(this.home, "auth.json"), "utf8"))?.tokens
      return chatGPTIdentity(tokens?.access_token, tokens?.account_id)
    } catch {
      return undefined
    }
  }

  /** Its limits were read since the box started, and with which sign-in (`chatGPTAccount`). */
  private limitsRead?: { as: string | undefined }
  /** Who each app-server is signed in as: it reads its sign-in as it starts, and keeps it. */
  private signedInAs = new WeakMap<RPC, string | undefined>()

  /**
   * Read once as the box starts (its app-server then stops when it's idle, as any), then only through
   * one already running for its sessions, never marked as used: a read never keeps one running, nor
   * starts one again for an account nobody uses. Between, what its turns hear keeps them current.
   */
  private async readLimits(): Promise<LimitReading | null> {
    if (!this.executable()) throw new LimitsProblem("none", "Codex isn't installed here.")
    // Only through a Codex signed in as its home is now: one started before you signed in to
    // another account still reads the one before, whose limits aren't this one's.
    const now = this.chatGPTAccount()
    const current = (server: RPC | undefined): server is RPC => !!server && !server.isClosed && this.signedInAs.get(server) === now
    const running = [...this.slots.values()].map((slot) => slot.server).find(current)
    // (Signed in to another account since it was read: read once more, as at the box's start.)
    if (this.limitsRead && this.limitsRead.as === now && !running) return null
    let rpc: RPC
    let account: any
    try {
      rpc = running ?? (await this.rpc())
      if (!current(rpc)) return null
      account = (await rpc.request("account/read", {}, 20_000))?.account
    } catch (caught) {
      throw new LimitsProblem("failed", `Codex couldn't say: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
    // It answered: not started again for this, whatever it said.
    this.limitsRead = { as: now }
    // Signed out, or an API key: no plan to read.
    if (account?.type !== "chatgpt") throw new LimitsProblem("none", account ? "An API key has no plan limits." : "Not signed in to Codex here.")
    let result: any
    try {
      result = await rpc.request("account/rateLimits/read", {}, 30_000)
    } catch (caught) {
      const words = caught instanceof Error ? caught.message : String(caught)
      if (/\b429\b|too many/i.test(words)) throw new LimitsProblem("rate-limited", "ChatGPT is turning away reads of the plan's limits for now.")
      if (/\b401\b|unauthori[sz]ed|sign in again|expired/i.test(words)) throw new LimitsProblem("expired", "ChatGPT turned its sign-in away: sign in to Codex again here.")
      throw new LimitsProblem("failed", `Codex couldn't read the plan's limits: ${words}`)
    }
    const snapshots: any[] = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : result?.rateLimits ? [result.rateLimits] : []
    const windows = snapshots.flatMap((snapshot) => codexWindows(snapshot))
    const type = account.planType ?? snapshots.find((snapshot) => snapshot?.planType)?.planType
    return { windows, ...(typeof type === "string" && type !== "unknown" ? { plan: codexPlan(type) } : {}) }
  }

  /** Its own sign-in on a machine: Kuvo Code's, in its folder there, so signed out here. */
  signOut?: () => Promise<void>

  constructor(
    readonly context: AgentContext,
    readonly instance: AgentAccount = { id: "default" },
  ) {
    this.providerID = providerID("codex", instance.id)
    if (instance.id === "default" && instance.home) {
      this.signOut = async () => {
        await signOutWith("Codex", this.executable(), ["logout"], { ...process.env, CODEX_HOME: instance.home })
        // Its app-servers read the sign-in as they start: the next one, signed out.
        this.shutdown()
        this.known.reset()
        this.modelList = undefined
      }
    }
  }

  executable(): string | undefined {
    return which("codex", places)
  }

  /** Its own installer puts it in `~/.codex`: `codex update`. */
  private get definition(): MaintenanceDefinition | undefined {
    const executable = this.executable()
    if (!executable) return undefined
    return { name: "Codex", executable, npmPackage: "@openai/codex", nativeUpdate: { args: ["update"], isNative: (path) => path.includes("/.codex/") } }
  }

  async maintenance(fresh = false) {
    const definition = this.definition
    return definition ? maintenance(definition, fresh) : {}
  }

  async update() {
    const definition = this.definition
    if (!definition) return { updated: false, message: "Codex isn't installed." }
    return update(definition, this.context.temporary)
  }

  /** Its program, with OpenAI's installer. */
  async installProgram() {
    return install("Codex", this.install, this.context.temporary, () => this.executable())
  }

  private slot(key: string): Slot {
    let slot = this.slots.get(key)
    if (!slot) this.slots.set(key, (slot = { lastUse: 0 }))
    return slot
  }

  /** Whether one of its app-servers runs outside the box's sandbox (one still starting too). */
  outside(): boolean {
    return [...this.unfencedServers].some((server) => !server.isClosed)
  }

  /** Whether `rpc` runs whole in the box's sandbox. */

  isFenced(rpc: RPC): boolean {
    return this.fencedServers.has(rpc)
  }

  /**
   * The new Codex lists the models and runs the sessions once its app-servers start again: now,
   * or once no turn or sign-in is using the old ones (a session goes on with its thread there).
   */
  programUpdated() {
    this.modelList = undefined
    this.known.stale()
    for (const [key, slot] of this.slots) {
      slot.outdated = slot.server
      // One starting now may be the old program's too.
      void slot.starting?.then((rpc) => {
        slot.outdated ??= rpc
        this.restartIfQuiet(key)
      }, () => {})
      this.restartIfQuiet(key)
    }
  }

  /** Whether something but `starting`'s turn (not on it yet) uses `server`: a turn, a sign-in, a one-off answer. */
  private busy(key: string, server: RPC, starting?: CodexThread): boolean {
    if ((key === SHARED || key === ACCOUNT) && (this.logins.size || [...this.oneOffs.values()].some((oneOff) => oneOff.rpc === server))) return true
    return [...this.threads.values()].some((thread) => thread !== starting && thread.server === server && (thread.isRunning || thread.keepsWorking))
  }

  /** Stops its app-servers started outside the box's sandbox that no turn is on now (you said to restart them): what used them starts again in it. Whether one is still at work. */
  restartOutside(): boolean {
    let waiting = false
    for (const [key, slot] of this.slots) {
      const server = slot.server
      if (!server || server.isClosed || !this.unfencedServers.has(server)) continue
      if (this.busy(key, server)) {
        waiting = true
        continue
      }
      this.stop(key)
    }
    return waiting
  }

  /** Restarts an old app-server when nothing but `starting`'s turn uses it. */
  private restartIfQuiet(key: string, starting?: CodexThread) {
    const slot = this.slots.get(key)
    const server = slot?.outdated
    if (!slot || !server) return
    if (server.isClosed || slot.server !== server) {
      slot.outdated = undefined
      return
    }
    if (this.busy(key, server, starting)) return
    slot.outdated = undefined
    this.stop(key)
    // What the old one listed meanwhile, asked anew.
    if (key !== SHARED && key !== ACCOUNT) return
    this.modelList = undefined
    emit("model.updated", {})
  }

  methods() {
    return [
      { type: "oauth" as const, id: "chatgpt", label: "Sign in with ChatGPT" },
      { type: "key" as const, label: "Use an OpenAI API key" },
    ]
  }

  private idleCheck?: ReturnType<typeof setInterval>

  /**
   * The app-server for `thread` (or your account's), started the first time it's needed and again
   * after it stops. A thread's own asks go to the one it's in; a turn `starting` goes to the one
   * for it now (the box's sandbox turned on or off since: another).
   */
  async rpc(thread?: CodexThread, starting = false): Promise<RPC> {
    if (thread && !starting && thread.server && !thread.server.isClosed) return thread.server
    const key = !fenceRules() ? SHARED : thread ? thread.session.id : ACCOUNT
    const slot = this.slot(key)
    slot.lastUse = Date.now()
    // The box's sandbox changed (its rules, the folders you let this session's commands write in):
    // Codex starts again with it once it's quiet.
    const fence = key === SHARED ? "" : key === ACCOUNT ? fenceKey() : fenceKey() + JSON.stringify(allowedFolders(thread!.session.location.directory)) + fullAccessMark(thread!.session.id)
    if (slot.server && !slot.server.isClosed && slot.fence !== fence) slot.outdated ??= slot.server
    // A turn starting while agents it spawned still work in the Codex its thread is in: there, as
    // long as that's as safe (one outside the box's sandbox, now that it's on, isn't); it starts
    // again once they're done.
    if (thread && starting && thread.server && !thread.server.isClosed && thread.keepsWorking && (this.isFenced(thread.server) || !fenceRules())) return thread.server
    // Stopped when nothing has used it for a while: a session's, or your account's with no session
    // in it. (One at work stays in use.)
    this.idleCheck ??= setInterval(() => {
      for (const [each, slot] of this.slots) {
        this.restartIfQuiet(each)
        const server = slot.server
        if (!server) continue
        if (this.busy(each, server) || (each === SHARED && [...this.threads.values()].some((thread) => thread.server === server))) {
          slot.lastUse = Date.now()
          continue
        }
        if (Date.now() - slot.lastUse >= 15 * 60_000) this.stop(each)
      }
    }, 60_000)
    this.restartIfQuiet(key, starting ? thread : undefined)
    if (slot.server && !slot.server.isClosed) return slot.server
    slot.starting ??= this.start(key, slot, fence, thread).finally(() => (slot.starting = undefined))
    return slot.starting
  }

  /**
   * Its own places, as it runs whole in the box's sandbox: its home (an added account's, and your
   * Codex's, which it links to), and the skills and subagents it's given (only read).
   */
  private fenced(directory: string, sessionID?: string, bot?: string) {
    const skills = skillsRoot()
    if (skills) mkdirSync(skills, { recursive: true, mode: 0o700 })
    // And the files of your subagents' instructions (only read).
    const subagents = subagentsRoot()
    if (subagents) mkdirSync(subagents, { recursive: true, mode: 0o700 })
    const homes = [this.home, ...(this.instance.home && !onMachine ? [this.yourCodex] : [])]
    // The files you attach in the session, copied where only the box writes (`fenceCopy`).
    const attached = sessionID ? fenceAttachments(directory) : undefined
    return fenceAgent(this.executable()!, directory, {
      homes,
      state: STATE_IN_HOME,
      kept: KEPT_IN_HOME,
      read: [...(skills ? [skills] : []), ...(subagents ? [subagents] : []), ...(attached ? [attached] : [])],
      port: relayPort(),
      session: sessionID,
      bot,
    })
  }

  private async start(key: string, slot: Slot, fenceNow: string, thread?: CodexThread): Promise<RPC> {
    const executable = this.executable()
    if (!executable) throw new Error(`Install Codex first: ${this.install}`)
    // An added account's own CODEX_HOME, with your Codex settings in it: only its sign-in is its
    // own. (On a machine, nothing of the machine's own Codex.)
    if (this.instance.home && !onMachine) shadowHome(this.instance.home, this.yourCodex)
    // While the box's sandbox is on, Codex runs whole in it: a session's in its folder, your
    // account's in its home.
    const directory = key === ACCOUNT ? this.accountFolder() : (thread?.session.location.directory ?? this.home)
    const fence = key === SHARED ? undefined : this.fenced(directory, key === ACCOUNT ? undefined : key, seatBot(thread?.session))
    if (key !== SHARED && !fence) throw new Error("Codex runs in the sandbox here, and it isn't ready: restart Kuvo Code.")
    const args = ["app-server", ...noComputerUse.flatMap((plugin) => ["-c", `plugins.${plugin}.enabled=false`])]
    const env = { ...(this.instance.home ? { CODEX_HOME: this.instance.home } : {}), ...(thread ? { OPENCODE_SESSION_ID: thread.session.id } : {}), ...fence?.env }
    const rpc = new RPC(fence ? [fence.command, ...args] : [executable, ...args], { cwd: fence ? directory : this.context.temporary, env })
    this.signedInAs.set(rpc, this.chatGPTAccount())
    slot.fence = fenceNow
    if (fence) this.fencedServers.add(rpc)
    else this.unfencedServers.add(rpc)
    rpc.onNotification = (method, params) => this.notification(method, params, rpc)
    rpc.onRequest = (method, params, id) => this.request(rpc, method, params, id)
    slot.opening = rpc
    rpc.onExit = () => {
      fence?.ended()
      this.unfencedServers.delete(rpc)
      // A title or commit text it was writing won't come.
      for (const oneOff of this.oneOffs.values()) if (oneOff.rpc === rpc) oneOff.fail(new Error("Codex stopped."))
      // Stopped on purpose: the threads were told then (they may be on a newer one by now).
      if (slot.server !== rpc) return
      slot.server = undefined
      for (const each of this.threads.values()) each.serverStopped(rpc)
    }
    try {
      await rpc.request("initialize", { clientInfo: { name: "kuvo-code", title: "Kuvo Code", version: "1" }, capabilities: { experimentalApi: true, optOutNotificationMethods: ["turn/diff/updated"] } }, 30_000)
    } catch (error) {
      // One that won't start isn't left running: the next ask starts another.
      rpc.kill()
      throw error
    } finally {
      if (slot.opening === rpc) slot.opening = undefined
    }
    // Its session closed meanwhile: not left running.
    if (this.slots.get(key) !== slot) {
      rpc.kill()
      throw new Error("Codex stopped.")
    }
    rpc.notify("initialized")
    slot.server = rpc
    return rpc
  }

  /** Stops an app-server: its threads are loaded again, in a new one, as they're next used. */
  private stop(key: string) {
    const slot = this.slots.get(key)
    // One still starting too (its start then fails).
    slot?.opening?.kill()
    const server = slot?.server
    if (!slot || !server) return
    slot.server = undefined
    server.kill()
    for (const thread of this.threads.values()) thread.serverStopped(server)
    // Its Kuvo Code tools' program too (started again with it).
    if (key !== SHARED && key !== ACCOUNT) dropRelayed(key, this)
  }


  private notification(method: string, params: any, from?: RPC) {
    if (method === "account/login/completed") {
      const done = this.logins.get(params?.loginId)
      if (done) {
        this.logins.delete(params.loginId)
        done(params.success ? { status: "complete" } : { status: "failed", message: params.error ?? "Signing in didn't work." })
      }
      this.known.reset()
      return
    }
    if (method === "account/updated") {
      this.known.reset()
      return
    }
    if (method === "account/rateLimits/updated") {
      const snapshot = params?.rateLimits
      if (snapshot) this.rateLimits.set(snapshot.limitId ?? "codex", snapshot)
      // Where the plan stands, for its limits (limits.ts): its sign-in's, as it is now.
      if (snapshot && from && this.signedInAs.get(from) === this.chatGPTAccount()) for (const window of codexWindows(snapshot)) this.limits.heard?.(window)
      return
    }
    // An agent a session's Codex spawned: its thread says which it came from as it starts.
    if (method === "thread/started") {
      const thread = params?.thread
      const parent = thread?.source?.subAgent?.thread_spawn?.parent_thread_id
      const owner = parent ? this.threadFor(parent) : undefined
      if (owner && thread?.id) {
        // Whether it takes messages from you (multi-agent v1's do; v2's only from their parent),
        // or that it didn't say (an older Codex).
        this.directInput.set(thread.id, typeof thread.canAcceptDirectInput === "boolean" ? thread.canAcceptDirectInput : null)
        this.spawned.set(thread.id, owner)
        owner.spawnStarted(thread.id)
      }
      return
    }
    // Codex settled an ask itself: its card goes.
    if (method === "serverRequest/resolved") {
      this.asked.get(String(params?.requestId))?.abort()
      return
    }
    const threadID = params?.threadId
    // For whoever's at work (a warning, Codex's settings): each session with a turn under way hears it.
    if (!threadID && ["warning", "deprecationNotice", "configWarning", "mcpServer/startupStatus/updated"].includes(method)) {
      for (const thread of new Set(this.threads.values())) thread.notification(method, params)
      return
    }
    const oneOff = threadID ? this.oneOffs.get(threadID) : undefined
    if (oneOff) return oneOff.notify(method, params)
    if (!threadID) return
    const thread = this.threadFor(threadID)
    if (thread) return thread.notification(method, params, from)
    // Kept a moment, for a spawned agent's thread its spawn hasn't named yet.
    const now = Date.now()
    for (const [id, kept] of this.early) if (now - kept.at > 30_000) this.early.delete(id)
    const kept = this.early.get(threadID) ?? { at: now, events: [] }
    if (kept.events.length < 500) kept.events.push([method, params])
    this.early.set(threadID, kept)
  }

  /** Asks under way, by Codex's request: one it settles itself (`serverRequest/resolved`) is taken back. */
  private asked = new Map<string, AbortController>()

  private async request(rpc: RPC, method: string, params: any, id?: number | string): Promise<unknown> {
    const thread = params?.threadId ? this.threadFor(params.threadId) : params?.conversationId ? this.threadFor(params.conversationId) : undefined
    // A tool of the app's: it gives Codex none.
    if (method === "item/tool/call") return { success: false, contentItems: [{ type: "inputText", text: "Kuvo Code has no such tool." }] }
    if (!thread) {
      if (method === "mcpServer/elicitation/request") return { action: "decline" }
      throw new RPCError(-32601, `No session for ${method}.`)
    }
    const controller = new AbortController()
    const key = String(id ?? newID("call"))
    this.asked.set(key, controller)
    try {
      return await thread.request(method, params, controller.signal, this.isFenced(rpc))
    } finally {
      this.asked.delete(key)
    }
  }

  private threadFor(nativeID: string): CodexThread | undefined {
    for (const thread of this.threads.values()) if (thread.nativeID === nativeID) return thread
    return this.spawned.get(nativeID)
  }

  /** How much each model holds, as Codex said in a turn. */
  private windows = new ContextWindows()

  noteContext(model: string, window: unknown) {
    if (!this.windows.note(model, window)) return
    this.modelList = undefined
    emit("model.updated", {})
  }

  /** Threads of agents a session's Codex spawned: their events and approvals go to that session. */
  private spawned = new Map<string, CodexThread>()
  /** Whether each spawned agent's thread takes your messages, as it said when it started (null: it didn't say). */
  readonly directInput = new Map<string, boolean | null>()

  adopt(threadID: string, thread: CodexThread) {
    this.spawned.set(threadID, thread)
    // What its thread said before it was known (it began at once): told now, in order.
    const early = this.early.get(threadID)
    this.early.delete(threadID)
    for (const [method, params] of early?.events ?? []) thread.notification(method, params)
  }

  /** What threads not known yet said, for a little while (a spawned agent's first words can come before its spawn is). */
  private early = new Map<string, { at: number; events: [string, any][] }>()

  /** Its sign-in as Codex last said, for 30 seconds (one it couldn't say, starting or busy, isn't a sign-out). */
  private known = new KnownAccount(30_000)

  async account(fresh = false): Promise<Account> {
    if (!this.executable()) return { installed: false, signedIn: false, message: "Install Codex, then sign in here." }
    return this.known.read(fresh, async () => {
      const rpc = await this.rpc()
      const result: any = await rpc.request("account/read", {}, 20_000)
      if (!result || typeof result !== "object") throw new Error("Codex couldn't say whether it's signed in.")
      const info = result.account
      let account: Account
      if (!info) {
        account = { installed: true, signedIn: false, message: "Sign in to Codex with ChatGPT or an OpenAI API key." }
      } else if (info.type === "chatgpt") {
        const plan = info.planType ? `ChatGPT ${String(info.planType).charAt(0).toUpperCase()}${String(info.planType).slice(1)}` : "ChatGPT"
        account = { installed: true, signedIn: true, label: [info.email, plan].filter(Boolean).join(" · ") }
      } else {
        account = { installed: true, signedIn: true, label: info.type === "apiKey" ? "OpenAI API key" : String(info.type) }
      }
      return account
    })
  }

  /** ChatGPT's device code works wherever its page is opened. */
  readonly signsInRemotely = true

  async signIn(_methodID = "chatgpt", options: SignInOptions = {}): Promise<SignInAttempt> {
    const rpc = await this.rpc()
    // On another device: a code to enter on ChatGPT's page, as `codex login --device-auth` has it.
    if (options.remote) {
      const device: any = await rpc.request("account/login/start", { type: "chatgptDeviceCode" }, 30_000)
      let status: OAuthStatus = { status: "pending" }
      this.logins.set(device.loginId, (done) => (status = done))
      return {
        url: device.verificationUrl,
        userCode: device.userCode,
        instructions: `Open ChatGPT's page, sign in, and enter the code ${device.userCode}. Codex keeps the sign-in, as when you run codex login.`,
        mode: "auto",
        status: () => status,
        cancel: () => {
          this.logins.delete(device.loginId)
          void rpc.request("account/login/cancel", { loginId: device.loginId }).catch(() => {})
        },
      }
    }
    const result: any = await rpc.request("account/login/start", { type: "chatgpt" }, 30_000)
    let status: OAuthStatus = { status: "pending" }
    this.logins.set(result.loginId, (done) => (status = done))
    return {
      url: result.authUrl,
      instructions: "Finish signing in with ChatGPT in your browser. Codex keeps the sign-in, as when you run codex login.",
      mode: "auto",
      status: () => status,
      cancel: () => {
        this.logins.delete(result.loginId)
        void rpc.request("account/login/cancel", { loginId: result.loginId }).catch(() => {})
      },
    }
  }

  async signInWithKey(key: string) {
    const rpc = await this.rpc()
    await rpc.request("account/login/start", { type: "apiKey", apiKey: key }, 30_000)
    this.known.reset()
  }

  async models(): Promise<Model[]> {
    if (this.modelList && Date.now() - this.modelList.at < 30 * 60_000) return this.modelList.models
    try {
      return await this.listModels()
    } catch (error) {
      // Codex couldn't list them just now (busy, or starting): the ones it listed last.
      if (this.modelList) return this.modelList.models
      throw error
    }
  }

  private async listModels(): Promise<Model[]> {
    const rpc = await this.rpc()
    const models: Model[] = []
    let cursor: string | undefined
    let order = 1000
    do {
      const page: any = await rpc.request("model/list", cursor ? { cursor } : {}, 30_000)
      for (const info of page?.data ?? []) {
        if (info.hidden) continue
        models.push(
          model(this.providerID, info.model ?? info.id, info.displayName ?? info.model, {
            variants: (info.supportedReasoningEfforts ?? []).map((effort: any) => effort.reasoningEffort),
            images: (info.inputModalities ?? []).includes("image"),
            context: this.windows.get(info.model ?? info.id) ?? 400_000,
            // Listed in Codex's order: its default first.
            released: info.isDefault ? 2000 : order--,
          }),
        )
      }
      cursor = page?.nextCursor ?? undefined
    } while (cursor)
    // Not kept from the old Codex's app-server: asked again of the new one.
    if (rpc !== this.slots.get(SHARED)?.outdated && rpc !== this.slots.get(ACCOUNT)?.outdated) this.modelList = { at: Date.now(), models }
    return models
  }

  forgetModels() {
    this.modelList = undefined
  }

  shutdown() {
    for (const key of [...this.slots.keys()]) this.stop(key)
  }

  /** One answer from Codex on your plan, in a thread kept nowhere, that can only read. */
  async generate(prompt: string, model?: ModelRef): Promise<string> {
    const rpc = await this.rpc()
    // (Its own default model, when none is given; thinking little either way.)
    // (Run whole in the box's sandbox, in Codex's home: Kuvo Code's folders are hidden there.)
    const cwd = this.isFenced(rpc) ? this.accountFolder() : this.context.temporary
    const started: any = await rpc.request("thread/start", { ephemeral: true, cwd, ...(model && model.id !== "default" ? { model: model.id } : {}), approvalPolicy: codexApprovals.never, sandbox: "read-only" }, 60_000)
    const threadId: string = started.thread.id
    let text = ""
    let turnId: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        if (turnId) void rpc.request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => {})
        reject(new Error("Codex took too long to answer."))
      }, 120_000)
      this.oneOffs.set(threadId, {
        rpc,
        notify: (method, params) => {
          if (method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") text = plainCitations(params.item.text)
          if (method !== "turn/completed") return
          if (params?.turn?.status === "completed") resolve(text.trim())
          else reject(new Error(params?.turn?.error?.message ?? "Codex couldn't answer."))
        },
        fail: reject,
      })
    })
    // (Settled before it's awaited, it isn't an unhandled failure.)
    done.catch(() => {})
    try {
      const turn: any = await rpc.request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], effort: model?.variant ?? "low" }, 60_000)
      turnId = turn?.turn?.id
      return await done
    } finally {
      clearTimeout(timer)
      this.oneOffs.delete(threadId)
      void rpc.request("thread/unsubscribe", { threadId }).catch(() => {})
    }
  }

  thread(session: Session, state: Record<string, unknown>): Thread {
    const thread = new CodexThread(this, session, state)
    this.threads.set(session.id, thread)
    return thread
  }

  /** Where Codex reads skills itself: its home's, `~/.agents/skills`, and a project's `.agents/skills`. */
  ownSkillFolders(directory: string): string[] {
    return [join(this.home, "skills"), join(homedir(), ".agents", "skills"), ...upward(directory).map((folder) => join(folder, ".agents", "skills"))]
  }

  /** Its home (CODEX_HOME): an added account's own, or yours. */
  get home(): string {
    return this.instance.home ?? process.env.CODEX_HOME ?? this.yourCodex
  }

  /** Its conversation for a move: the thread's rollout, which Codex finds by its ID in any home's
   * `sessions` (tested: `thread/resume` of one copied to another home, from another folder, goes on
   * with what came before). What it remembers across threads is its home's, and stays. */
  conversationFiles(state: Record<string, unknown>): ConversationFiles | null {
    const id = state.codexThread
    if (typeof id !== "string") return null
    if (!CODEX_THREAD.test(id)) return { items: [], missing: true }
    const file = rolloutOf(this.home, id)
    if (!file) return { items: [], missing: true }
    const day = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(basename(file))
    return { items: [{ path: file, name: day ? join(day[1]!, day[2]!, day[3]!, basename(file)) : basename(file) }] }
  }

  /** Where a thread's rollout that came goes here: its home's `sessions`, by its day, as Codex keeps them. */
  conversationPlace(): ConversationPlace {
    const sessions = join(this.home, "sessions")
    return { item: (name) => (ROLLOUT.test(name) ? join(sessions, name) : null) }
  }

  conversationRoots() {
    return [join(this.home, "sessions"), join(this.home, "archived_sessions")]
  }

  /**
   * Where your account's Codex works while it runs whole in the box's sandbox (one-off answers,
   * signing in), which its commands may write: a folder of its state, never its whole home.
   */
  private accountFolder(): string {
    const folder = join(this.home, "sessions")
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    return folder
  }

  /** Your own Codex's folder, which an added account's links to (on this Mac). */
  get yourCodex(): string {
    return join(homedir(), ".codex")
  }

  /** A session's skills folder, for its app-server (told again when that started again). */
  async useSkills(sessionID: string, folder: string | undefined, rpc: RPC) {
    if (folder) this.skillRoots.set(sessionID, join(folder, "skills"))
    else this.skillRoots.delete(sessionID)
    const roots = [...new Set(this.skillRoots.values())].sort()
    const key = JSON.stringify(roots)
    if (this.rootsSet.get(rpc) === key) return
    await rpc.request("skills/extraRoots/set", { extraRoots: roots }, 30_000).then(
      () => this.rootsSet.set(rpc, key),
      () => {},
    )
  }

  /** Your own settings' list of skills turned on or off (`[[skills.config]]`), which a thread's own replaces. */
  ownSkillSettings(): unknown[] {
    try {
      const settings: any = Bun.TOML.parse(readFileSync(join(this.home, "config.toml"), "utf8"))
      return Array.isArray(settings?.skills?.config) ? settings.skills.config : []
    } catch {
      return []
    }
  }

  forget(sessionID: string) {
    const thread = this.threads.get(sessionID)
    this.threads.delete(sessionID)
    this.skillRoots.delete(sessionID)
    // The agents it spawned go with it, and its own app-server.
    for (const [spawn, owner] of this.spawned) if (owner === thread) this.spawned.delete(spawn)
    this.stop(sessionID)
    this.slots.delete(sessionID)
    dropRelayed(sessionID, this)
  }
}

// MARK: A session

/** An agent a session's Codex spawned, as its conversation keeps it (across restarts too). */
interface KnownSpawn {
  call: string
  title: string
  sessionID: string
  /** Whether its thread takes your messages, as it said (null: it didn't say; unset: not yet). */
  direct?: boolean | null
}

/** How many spawned agents a conversation remembers, newest kept. */
const knownSpawns = 100

/** How you can write to a spawned agent, from what its thread said. */
function spawnMessages(direct: boolean | null | undefined): SubagentMessages {
  if (direct === true) return { via: "direct" }
  if (direct === false) return { via: "none", note: "Codex agents of this kind take messages only from the agent that started them." }
  if (direct === null) return { via: "none", note: "This Codex doesn't say whether its agents take messages: write to the conversation that started it." }
  return { via: "none", note: "Codex hasn't said yet whether this agent takes messages." }
}

/** Where Codex's items are told: the turn's own, or a spawned agent's session. */
interface Lane {
  turn: Turn
  /** Items whose words came as deltas (their completion doesn't add them again). */
  streamed: Set<string>
  /** File changes, by item, for their approval and their result. */
  changes: Map<string, { path: string; kind: string; diff: string; movedTo?: string }[]>
  /** A command's output so far, by item. */
  output: Map<string, string>
  /** A tool ran since the last words: the next words start a new step. */
  toolsSinceText: boolean
  /** Reasoning items whose summary came as deltas (their raw text then isn't shown too), and those whose raw text did. */
  summarized?: Set<string>
  reasoned?: Set<string>
  /** Its to-do list's tool call, kept up to date until the turn ends. */
  plan?: { id: string; todos: { content: string; status: string }[] }
  /** Notices it has given this turn (a reconnect's is given once). */
  noticed?: Set<string>
  /** Its directives in each message's words, as they come. */
  citations?: Map<string, CodexCitations>
}

function citationsOf(lane: Lane, item: string): CodexCitations {
  let citations = lane.citations?.get(item)
  if (!citations) (lane.citations ??= new Map()).set(item, (citations = new CodexCitations()))
  return citations
}

/** An agent Codex spawned: its thread's work, told in a session of its own. */
interface SubagentLane extends Lane {
  run: SubagentRun
  /** Its thread, and the turn it's on there (to stop it), in the Codex it runs in. */
  threadID: string
  turnID?: string
  server?: RPC
  /** The spawn call that started it. */
  call: string
  title: string
  ended: boolean
}

/**
 * What Codex's models are told of asking you. They list request_user_input outside Plan too, where it
 * refuses them ("unavailable in Default mode"), and a model that reached for it said it couldn't ask.
 */
export const ASKING_WORDS = "Outside Plan mode, ask the user with request_user_input_async: request_user_input refuses there, which doesn't mean you can't ask. It returns at once, and the answer comes as a new user message, which also ends a sleep you're in."

/** What Codex asks you with its request_user_input_async. */
type AskedQuestion = { title: string; options?: string[] | null }
/** A question's card as it waits: a message you send meanwhile stops it, and is the answer. */
/** `typed`: what you sent meanwhile, which answers this card (null: it answered another of those open, and covers this one). */
type AskedCard = { abort: AbortController; typed?: MessageInput | null }
/** An answer in the turn under way that Codex may yet sleep past: one it's `heard` and worked on from isn't what it's sleeping on. */
type Answered = { text: string; files?: PromptFile[]; heard?: boolean }
/** How often the commands it left running in background terminals are listed again while any runs. */
export const codexTiming = { terminals: 30_000 }

/** What it does that's more than asking and thinking. */
const WORK_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "imageView", "collabAgentToolCall"])
/** Trying again to reach a sleep that turned it down: after this long, then twice that, up to the last. */
const STEER_AGAIN = 1_000
const STEER_AGAIN_LAST = 64_000
/** Its box turning down this many with no work in between: no further turn is started for it. */
const TURNED_DOWN_TURNS = 2
/** And this many: its turn is stopped, as asking is all it's doing (a few at the start of a task isn't that). */
const TURNED_DOWN_IN_TURN = 5
/** What Codex hears of a question. */
type Answer = { text: string; files: PromptFile[]; declined?: boolean }

interface Active extends Lane {
  hooks: TurnHooks
  /** The agents it spawned, by their thread. */
  subagents: Map<string, SubagentLane>
  /** Spawn calls under way whose thread isn't known yet, oldest first. */
  spawning: string[]
  resolve: (result: RunResult) => void
  turnID?: string
  /** On Auto: a limit ends the turn rather than being waited out. */
  auto?: boolean
  /** A usage limit it reached (Auto goes on with the next model). */
  limit?: Limit
  /** You pressed Stop. */
  stopping?: boolean
  /** It kept asking, and its box kept turning it down: stopped there, which is its turn's end. */
  stoppedAsking?: boolean
  /** Auto stopped it at a limit, to go on with the next model. */
  stoppedForLimit?: boolean
  model: string
  problem?: string
  /** It's the summary you asked for: no reply, and no note saying it summarized. */
  compacting?: boolean
  /** In Plan: it looks and plans, and changes nothing. */
  planning?: boolean
}

class CodexThread implements Thread {
  nativeID?: string
  private loaded = false
  /** The app's added instructions the thread was loaded with. */
  private instructions?: string | null
  private active?: Active
  /** From a message's start until its turn ends: its app-server isn't to stop meanwhile. */
  private inTurn = false
  /** The thread it had was gone: a new one took its place. */
  private startedOver = false
  /** Its questions' cards (its request_user_input_async), up until they're answered: a message you send meanwhile answers them instead. */
  private waiting = new Set<AskedCard>()
  /** Each question on its way to an answer that Codex hears, from its card going up. */
  private asking = new Set<Promise<void>>()
  /** Answers no turn could take as they came (its turn had ended): the next turn starts with them. */
  private answers: Answer[] = []
  /** Answers gone into the turn under way, for the first sleep that starts after them. */
  private answered: Answered[] = []
  /** Answers a sleep took from `answered` as it started, while it's told them again: one Codex takes meanwhile, as it was first sent, is heard. */
  private retelling = new Set<Answered>()
  /** The sleep it's in, which what goes in now ends. */
  private sleep?: AbortController
  /** How many of its questions its box turned down with words, this message. */
  private turnedDown = 0
  /** Where Kuvo Code's tools were when it was loaded. */
  private toolsKey?: string
  /** The computer's servers it was loaded with (their names). */
  private serversKey?: string
  private skillsKey?: string
  private subagentsKey?: string
  /** The agents it spawned, by their thread: their sessions, across turns, kept with the conversation. */
  private get spawnedSessions(): Record<string, KnownSpawn> {
    const known = this.state.codexSubagents
    if (known && typeof known === "object") return known as Record<string, KnownSpawn>
    return (this.state.codexSubagents = {}) as Record<string, KnownSpawn>
  }

  private rememberSpawn(threadID: string, entry: Partial<KnownSpawn>) {
    const known = this.spawnedSessions
    const before = known[threadID]
    if (!before && !entry.sessionID) return
    if (before && Object.entries(entry).every(([key, value]) => (before as any)[key] === value)) return
    known[threadID] = { ...before, ...entry } as KnownSpawn
    const threads = Object.keys(known)
    for (const old of threads.slice(0, Math.max(0, threads.length - knownSpawns))) delete known[old]
    this.active?.hooks.saveState()
  }

  /** How you can write to an agent it spawned: as its thread said (here, or before it was kept). */
  private messagesFor(threadID: string): SubagentMessages {
    return spawnMessages(this.agent.directInput.has(threadID) ? this.agent.directInput.get(threadID) : this.spawnedSessions[threadID]?.direct)
  }
  /** Agents it spawned still at work after the turn that spawned them ended, by their thread. */
  private backgroundLanes = new Map<string, SubagentLane>()
  /** Agents you wrote to once they were done, by their thread: their next turn's run, when no turn here has it. */
  private resuming = new Map<string, () => SubagentRun>()

  constructor(
    private readonly agent: CodexAgent,
    readonly session: Session,
    private readonly state: Record<string, unknown>,
  ) {
    this.nativeID = state.codexThread as string | undefined
    // The agents it spawned before (this conversation's Codex closed a while, or the bridge
    // started again): what their threads say comes here now.
    for (const threadID of Object.keys(this.spawnedSessions)) this.agent.adopt(threadID, this)
  }

  /** The app-server its thread is in, as its last turn started. */
  server?: RPC

  get sandboxed() {
    return Boolean(this.server && !this.server.isClosed && this.agent.isFenced(this.server))
  }

  /** The session's folder, when `rpc` runs whole in the box's sandbox (attachments are copied for it). */
  private fencedIn(rpc: RPC): string | undefined {
    return this.agent.isFenced(rpc) ? this.session.location.directory : undefined
  }

  /** An app-server stopped: the agents it left at work there are over; if it's its thread's, it must be loaded again, and a turn under way is over. */
  serverStopped(server: RPC) {
    for (const [threadID, lane] of this.backgroundLanes) {
      if ((lane.server ?? this.server) !== server) continue
      this.endSubagent(lane, "interrupted")
      this.backgroundLanes.delete(threadID)
    }
    if (this.server !== server) return
    this.loaded = false
    const active = this.active
    if (!active) return
    this.active = undefined
    active.resolve(active.hooks.signal.aborted ? { outcome: "interrupted" } : { outcome: "failed", error: failure(active.problem ?? "Codex stopped.") })
  }

  private policy(hooks: TurnHooks, plan: boolean, rpc: RPC) {
    // Run whole in the box's sandbox: its commands are in it however they run, Codex's own sandbox
    // off (it can't be made inside), and it asks as it does outside it. A command you allow runs
    // in the box's sandbox all the same: one that needs more is `sandbox_ask`'s, which only you
    // answer. Plan asks before all but a look.
    if (this.agent.isFenced(rpc)) {
      const sandboxPolicy = { type: "dangerFullAccess" }
      if (plan) return { approvalPolicy: codexApprovals.askFirst, sandboxPolicy }
      return { approvalPolicy: hooks.approvesAll() ? codexApprovals.approveAll : codexApprovals.askFirst, sandboxPolicy }
    }
    if (plan) return { approvalPolicy: codexApprovals.askFirst, sandboxPolicy: { type: "readOnly", networkAccess: true } }
    // The box's sandbox just turned on, while this Codex was still at work: its own sandbox until
    // it starts again in the box's, whatever the mode.
    if (fenceRules()) return { approvalPolicy: hooks.approvesAll() ? codexApprovals.approveAll : codexApprovals.askFirst, sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: true } }
    // Approve All: what Codex's own rules ask about (rm -f) is asked too, and your rules let it
    // through without a card; with "never", Codex refuses it itself.
    if (hooks.approvesAll()) return { approvalPolicy: codexApprovals.approveAll, sandboxPolicy: { type: "dangerFullAccess" } }
    // Ask First: it asks before any command but a look and before every edit ("untrusted"), and
    // what it runs can write in the project and where Kuvo Code keeps wake-ups (kuvo-wake, whose
    // scheduling your rules allow), as the engine's commands can.
    const writableRoots = [process.env.KUVO_WAKES, process.env.KUVO_BOTS].filter((root): root is string => Boolean(root))
    return { approvalPolicy: codexApprovals.askFirst, sandboxPolicy: { type: "workspaceWrite", writableRoots, networkAccess: true } }
  }

  private async ensureThread(input: RunInput, hooks: TurnHooks) {
    // A turn starting: on the new Codex, when it was updated, or another (the box's sandbox
    // turned on or off), where its thread is loaded again.
    const rpc = await this.agent.rpc(this, true)
    if (rpc !== this.server) {
      // Let go of where it was, unless agents it spawned still work there.
      const left = this.server
      if (left && !left.isClosed && this.nativeID && this.loaded && !this.keepsWorking) void left.request("thread/unsubscribe", { threadId: this.nativeID }).catch(() => {})
      this.server = rpc
      this.loaded = false
    }
    const fenced = this.agent.isFenced(rpc)
    const instructions = [hooks.instructions(), ASKING_WORDS].filter(Boolean).join("\n\n")
    // Loaded again with what the app adds to its instructions, when that changed. (In the box's
    // sandbox, through the bridge's relay: the sandbox hides where they are.)
    const tools = fenced ? relayedTools(this.session.id, this.agent) : kuvoTools(this.session.id)
    // Settings › Skills' skills, as extra ones (but those it reads itself), and those of its own
    // you turned off, off for this thread.
    const directory = this.session.location.directory
    const own = this.agent.ownSkillFolders(directory)
    const off = turnedOff(hooks)
    const skills = skillsFolder(await skillsFor(directory, own, off))
    await this.agent.useSkills(this.session.id, skills, rpc)
    const turnedOffHere = (await engineSkills(directory)).filter((skill) => within(skill.folder, own) && off(skill.name)).map((skill) => ({ path: join(skill.folder, "SKILL.md"), enabled: false }))
    const skillsKey = JSON.stringify([skills, turnedOffHere])
    // The computer's MCP servers (yours, the integrations', a bot's with its own keys), through the
    // relay, which keeps their keys.
    const computer = await computerServers(directory)
    const servers = relayedServers(this.session.id, this.agent, directory, computer)
    // Your subagents (Settings › Agents), as its roles, and the model its subagents use.
    const subagents = codexSubagents(await subagentsFor(directory))
    // Loaded again when Kuvo Code's tools moved (the app started again), to reach them, or the
    // skills, the servers or the subagents changed.
    if (this.nativeID && this.loaded && instructions === this.instructions && tools?.key === this.toolsKey && skillsKey === this.skillsKey && computer.key === this.serversKey && subagents.key === this.subagentsKey) return rpc
    this.toolsKey = tools?.key
    this.serversKey = computer.key
    this.skillsKey = skillsKey
    this.subagentsKey = subagents.key
    this.instructions = instructions
    // Kuvo Code's own tools, as the engine's models have them (a setting for this thread alone).
    const timeout = tools ? { tool_timeout_sec: Math.ceil(tools.timeout / 1000) } : {}
    const server = tools?.kind === "http" ? { url: tools.url, http_headers: tools.headers, ...timeout } : tools?.kind === "stdio" ? { command: tools.command, args: tools.args, env: tools.env, ...timeout } : undefined
    // Its commands know their conversation, as the engine's do (kuvo-wake schedules for it).
    // (On a machine, the machine's own folders too: Codex keeps its own in Kuvo Code's folder.)
    // In the box's sandbox, the launcher kept Kuvo Code's passwords out of Codex, and gave it the
    // conversation's wake-up folder.
    const config = {
      "shell_environment_policy.set.OPENCODE_SESSION_ID": this.session.id,
      ...(onMachine ? ownFoldersConfig() : {}),
      ...(tools && server ? { [`mcp_servers.${tools.name}`]: server } : {}),
      // (A command's server can take a while to start the first time, fetching its package.)
      ...Object.fromEntries(servers.map((each) => [`mcp_servers.${each.name}`, { url: each.url, http_headers: each.headers, tool_timeout_sec: Math.ceil(each.timeout / 1000), startup_timeout_sec: 120 }])),
      ...(turnedOffHere.length ? { "skills.config": [...this.agent.ownSkillSettings(), ...turnedOffHere] } : {}),
      ...subagents.config,
    }
    const common = { cwd: this.session.location.directory, model: input.model.id, developerInstructions: instructions, config }
    const withoutSubagents = Object.fromEntries(Object.entries(config).filter(([key]) => !(key in subagents.config)))
    if (this.nativeID) {
      try {
        await rpc.request("thread/resume", { threadId: this.nativeID, excludeTurns: true, ...common }, 60_000)
        this.loaded = true
        return rpc
      } catch (error) {
        if (error instanceof RPCError && /archived|unarchive/i.test(error.message)) {
          await rpc.request("thread/unarchive", { threadId: this.nativeID }).catch(() => {})
          await rpc.request("thread/resume", { threadId: this.nativeID, excludeTurns: true, ...common }, 60_000)
          this.loaded = true
          return rpc
        }
        // Your subagents turned away (a Codex older than its roles' settings): the same thread
        // without them, rather than a new one.
        if (Object.keys(subagents.config).length && error instanceof RPCError) {
          const without = await rpc.request("thread/resume", { threadId: this.nativeID, excludeTurns: true, ...common, config: withoutSubagents }, 60_000).then(() => true, () => false)
          if (without) {
            console.error(`Codex turned your subagents away, so this conversation goes on without them: ${error.message}`)
            this.loaded = true
            return rpc
          }
        }
        // Gone (deleted, or another Codex's): a new thread, without what came before.
      }
    }
    let started: any
    try {
      started = await rpc.request("thread/start", common, 60_000)
    } catch (error) {
      if (!Object.keys(subagents.config).length || !(error instanceof RPCError)) throw error
      console.error(`Codex turned your subagents away, so this conversation starts without them: ${error.message}`)
      started = await rpc.request("thread/start", { ...common, config: withoutSubagents }, 60_000)
    }
    if (this.nativeID && this.nativeID !== started.thread.id) this.startedOver = true
    this.nativeID = started.thread.id
    this.state.codexThread = this.nativeID
    // A new thread has the instructions it's given now.
    this.state.codexTold = instructions
    hooks.saveState()
    this.loaded = true
    return rpc
  }

  get isRunning(): boolean {
    return this.inTurn
  }

  /** Agents it spawned are still at work after the turn, or commands it left running: it's kept open for them. */
  get keepsWorking(): boolean {
    // (One the session ended, with the turn that started it, isn't.)
    for (const [threadID, lane] of this.backgroundLanes) if (lane.ended || lane.run.turn.isEnded) this.backgroundLanes.delete(threadID)
    return this.backgroundLanes.size > 0 || this.liveTerminals.length > 0
  }

  /**
   * Commands it left running in background terminals, as its app-server last listed them, with
   * when each was first seen. They go with that app-server, which closing it would stop: Codex
   * doesn't say when one ends (nor is it told: it looks at them itself), so they're listed again
   * every while, until none is left.
   */
  private terminals: { id: string; command: string; since: number }[] = []
  private terminalsRead?: ReturnType<typeof setTimeout>
  /** Lists that failed in a row. */
  private listFailures = 0

  private get liveTerminals() {
    return this.server && !this.server.isClosed ? this.terminals : []
  }

  get backgroundTasks() {
    return this.liveTerminals.map((terminal) => ({ id: terminal.id, since: terminal.since }))
  }

  async stopBackgroundTasks() {
    const server = this.server
    if (!this.liveTerminals.length || !server || !this.nativeID) return
    await server.request("thread/backgroundTerminals/clean", { threadId: this.nativeID }, 30_000).catch(() => {})
    await this.readTerminals()
  }

  /** Lists its background terminals again; while any runs, again in a while. */
  private async readTerminals() {
    clearTimeout(this.terminalsRead)
    const server = this.server
    const threadID = this.nativeID
    // (Those it listed before, while it can't say now: a list that failed isn't an empty one.)
    let listed: { id: string; command: string }[] | undefined = []
    if (server && !server.isClosed && threadID) {
      try {
        listed = []
        const seen = new Set<string>()
        let cursor: string | undefined
        do {
          const answer: any = await server.request("thread/backgroundTerminals/list", { threadId: threadID, ...(cursor ? { cursor } : {}) }, 30_000)
          for (const terminal of Array.isArray(answer?.data) ? answer.data : []) if (typeof terminal?.processId === "string") listed.push({ id: terminal.processId, command: String(terminal.command ?? "") })
          cursor = typeof answer?.nextCursor === "string" && answer.nextCursor && !seen.has(answer.nextCursor) ? answer.nextCursor : undefined
          if (cursor) seen.add(cursor)
        } while (cursor && seen.size < 20)
        this.listFailures = 0
      } catch {
        // (Given up on after a few in a row: one that never answers can't keep it open for ever.)
        listed = server.isClosed || ++this.listFailures >= 5 ? [] : undefined
      }
    }
    // (Its app-server since replaced, or a turn under way, which reads them again as it ends.)
    if (server !== this.server || this.inTurn) return
    if (!listed) {
      if (this.terminals.length) this.terminalsRead = setTimeout(() => void this.readTerminals(), codexTiming.terminals)
      return
    }
    const before = this.terminals
    this.terminals = listed.map((terminal) => ({ ...terminal, since: before.find((known) => known.id === terminal.id)?.since ?? Date.now() }))
    if (before.length !== this.terminals.length || this.terminals.some((terminal) => !before.some((known) => known.id === terminal.id))) emit("session.background.updated", { sessionID: this.session.id }, this.session.location.directory)
    if (this.terminals.length) this.terminalsRead = setTimeout(() => void this.readTerminals(), codexTiming.terminals)
  }

  /** Your message, into the turn under way (Codex's turn/steer). */
  async steer(input: MessageInput): Promise<boolean> {
    // Codex's question waits for your answer: this is it (a note of the app's isn't), for all it has open.
    const [first] = this.waiting
    if (first && !input.synthetic) {
      for (const card of this.waiting) {
        card.typed = card === first ? input : null
        card.abort.abort()
      }
      return true
    }
    const active = this.active
    if (!active?.turnID || !this.nativeID) return false
    return this.steerIn(active, input)
  }

  /**
   * Your message for an agent it spawned, on its own thread: into its turn at its next step while
   * it works (turn/steer), or a turn of its own once it's done (turn/start). Only while the Codex
   * that runs it does, and it hasn't let it go.
   */
  subagentMessages(sessionID: string) {
    const threadID = Object.entries(this.spawnedSessions).find(([, known]) => known.sessionID === sessionID)?.[0]
    if (!threadID || this.messagesFor(threadID).via !== "direct") return undefined
    return async (input: MessageInput, resume: () => SubagentRun): Promise<boolean> => {
      let rpc: RPC
      try {
        rpc = await this.agent.rpc(this)
      } catch {
        return false
      }
      const lane = this.active?.subagents.get(threadID) ?? this.backgroundLanes.get(threadID)
      // At work: into its turn, in the Codex it runs in.
      if (lane && !lane.ended && lane.server && !lane.server.isClosed) rpc = lane.server
      const items = codexInput(input, this.fencedIn(rpc))
      if (lane && !lane.ended) {
        try {
          await rpc.request("turn/steer", { threadId: threadID, input: items, ...(lane.turnID ? { expectedTurnId: lane.turnID } : {}) }, 30_000)
          return true
        } catch {
          // Its turn ended just then: a new one takes it (Codex turns that away while one runs).
        }
      }
      // Its next turn, with none of this conversation's under way, is a run of its own.
      this.resuming.set(threadID, resume)
      const start = () => rpc.request("turn/start", { threadId: threadID, input: items }, 30_000)
      try {
        await start()
        return true
      } catch {
        // Not loaded in this Codex (it started again since): loaded, then started.
        try {
          await rpc.request("thread/resume", { threadId: threadID, excludeTurns: true }, 60_000)
          await start()
          return true
        } catch {
          this.resuming.delete(threadID)
          return false
        }
      }
    }
  }

  async prepare(input: RunInput, hooks: TurnHooks) {
    this.inTurn = true
    try {
      await this.ensureThread(input, hooks)
    } finally {
      this.inTurn = false
    }
    const fresh = this.startedOver
    this.startedOver = false
    return { fresh }
  }

  async run(input: RunInput, turn: Turn, hooks: TurnHooks): Promise<RunResult> {
    this.inTurn = true
    this.turnedDown = 0
    try {
      let result = await this.runTurn(input, turn, hooks)
      // Its questions outlive the turn that asked them: one still open is waited for here, and an
      // answer no turn took starts one, so Codex goes on with it.
      while (result.outcome === "succeeded" && !hooks.signal.aborted) {
        this.wokeUp()
        while (this.asking.size) await Promise.all(this.asking)
        const said = this.answers
        this.answers = []
        if (!said.length || hooks.signal.aborted) break
        result = await this.runTurn({ ...input, text: said.map((answer) => answer.text).join("\n\n"), files: said.flatMap((answer) => answer.files), adopt: false }, turn, hooks)
      }
      return hooks.signal.aborted && result.outcome === "succeeded" ? { outcome: "interrupted" } : result
    } finally {
      this.wokeUp()
      for (const card of this.waiting) card.abort.abort()
      while (this.asking.size) await Promise.all(this.asking)
      this.answers = []
      this.inTurn = false
      // What it left running, now the turn's over.
      void this.readTerminals()
    }
  }

  /**
   * A question Codex asked (its request_user_input_async), put to you as it's asked. Its tool returns
   * at once and the turn goes on, reasoning, working or sleeping until "any reply arrives
   * asynchronously as a new user message", so what it does next says nothing of whether it still
   * wants the answer: the answer goes into its turn, or starts the next one if that's over.
   */
  private ask(questions: AskedQuestion[], hooks: TurnHooks) {
    this.keep(this.answer(questions, hooks).then((answer) => this.deliver(answer)))
  }

  /** Something on its way to Codex, that its turn's end waits for. */
  private keep(work: Promise<void>) {
    const job: Promise<void> = work.catch(() => {}).finally(() => this.asking.delete(job))
    this.asking.add(job)
  }

  /** What you answered Codex's question with (the card, or a message you sent meanwhile); nothing (dismissed), or null (a message answering another that's open covers it). */
  private async answer(questions: AskedQuestion[], hooks: TurnHooks): Promise<Answer | undefined | null> {
    const card: AskedCard = { abort: new AbortController() }
    this.waiting.add(card)
    try {
      const fields: FormField[] = questions.map((question, index) => ({
        key: `q${index}`,
        title: "Question",
        description: question.title,
        required: true,
        type: "string",
        options: (question.options ?? []).map((option) => ({ value: option, label: option })),
        custom: true,
      }))
      let declined: string | undefined
      const answer = await hooks.question({ title: questions.length === 1 ? "Question" : "Questions", fields, signal: card.abort.signal, declined: (words) => { declined = words } })
      if (card.typed !== undefined) return card.typed && { text: card.typed.text, files: card.typed.files }
      // Turned down by its box with words: it hears them and carries on.
      if (!answer && declined) return { text: declined, files: [], declined: true }
      if (!answer) return undefined
      const said = (index: number) => {
        const value = answer[`q${index}`]
        return Array.isArray(value) ? value.join(", ") : String(value ?? "")
      }
      return { text: questions.length === 1 ? said(0) : questions.map((question, index) => `${question.title}\n${said(index)}`).join("\n\n"), files: [] }
    } finally {
      this.waiting.delete(card)
    }
  }

  /** What Codex hears of a question settled: into the turn under way, which ends a sleep it's in, or kept for the next turn. */
  private async deliver(answer: Answer | undefined | null) {
    if (answer === null) return
    const active = this.active
    // Dismissed: a turn at work hears so rather than wait on it; one that's over just ends.
    if (!answer && (!active || active.stopping || active.hooks.signal.aborted)) return
    // (Turned down by its box and asking again and again, with no work in between: no more of it, rather than run up its tokens with nobody there.)
    if (answer?.declined && ++this.turnedDown > (active ? TURNED_DOWN_IN_TURN : TURNED_DOWN_TURNS)) {
      if (active) {
        active.stoppedAsking = true
        this.answers = []
        await this.stopTurn(active)
      }
      return
    }
    await this.steerAnswer(active, answer)
  }

  private async steerAnswer(active: Active | undefined, answer: Answer | undefined) {
    const text = answer?.text ?? "The user dismissed this question without answering it. Don't wait for an answer."
    const files = answer?.files ?? []
    if (active?.turnID && this.nativeID) {
      // (Noted first: a sleep can start before Codex says it took this. One under way, this ends.)
      const noted: Answered | undefined = this.sleep ? undefined : { text, files }
      if (noted) this.answered.push(noted)
      if (await this.steerIn(active, { text, files })) return
      // (Turned down with a sleep starting: telling it again as that started is seeing to it.)
      if (noted && !this.answered.includes(noted)) return
      this.answered = this.answered.filter((each) => each !== noted)
      // Into the sleep it's in, and then into one that started while that was tried: as a sleep
      // starts it's told only what's kept by then, so kept below at once once there's no sleep left.
      for (let tried: AbortController | undefined; this.sleep && this.sleep !== tried && this.active === active; ) {
        tried = this.sleep
        if (await this.steerIntoSleep(active, { text, files })) return
      }
    }
    if (answer) this.answers.push(answer)
  }

  /** `input` into `active`'s turn. Whether Codex took it: what it takes it hears and acts on, even with its final message said and its turn ending just then. */
  private async steerIn(active: Active, input: { text: string; files: PromptFile[] }): Promise<boolean> {
    try {
      const rpc = await this.agent.rpc(this)
      await rpc.request("turn/steer", { threadId: this.nativeID, input: codexInput(input, this.fencedIn(rpc)), expectedTurnId: active.turnID }, 30_000)
      return true
    } catch {
      return false
    }
  }

  /** Turned down while it sleeps: nothing else would reach it, as it says nothing that could set off another try, so tried again for a while. */
  private async steerIntoSleep(active: Active, input: { text: string; files: PromptFile[] }): Promise<boolean> {
    for (let wait = STEER_AGAIN; wait <= STEER_AGAIN_LAST; wait *= 2) {
      const sleep = this.sleep
      if (!sleep || active.stopping || active.hooks.signal.aborted) return false
      await new Promise<void>((resolve) => {
        const done = AbortSignal.any([sleep.signal, active.hooks.signal])
        const timer = setTimeout(resolve, wait)
        done.addEventListener("abort", () => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (this.sleep !== sleep || active.stopping || active.hooks.signal.aborted) return false
      if (await this.steerIn(active, input)) return true
    }
    return false
  }

  /** Its sleep is over (or its turn, whichever way). */
  private wokeUp() {
    this.sleep?.abort()
    this.sleep = undefined
  }

  private async runTurn(input: RunInput, turn: Turn, hooks: TurnHooks): Promise<RunResult> {
    const rpc = await this.ensureThread(input, hooks)
    // Stopped while Codex was starting.
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    // A thread it goes on with keeps the developer instructions it started with: what changed in
    // them since is said ahead of the message, once. (Not as it compacts: nothing goes in then.)
    const instructions = this.instructions ?? ""
    const note = input.compact ? undefined : instructionsNote(toldOf(this.state, "codexTold"), instructions)
    const items: any[] = [{ type: "text", text: note ? `${note}\n\n${input.text}` : input.text, text_elements: [] }]
    const others: string[] = []
    // In the box's sandbox, attachments are copied where it reads them: Kuvo Code's folder is hidden.
    const fencedIn = this.fencedIn(rpc)
    for (const attached of input.files) {
      const file = fencedIn && attached.path ? { ...attached, path: fenceCopy(fencedIn, attached.path) } : attached
      if (file.mime.startsWith("image/")) {
        if (file.path) items.push({ type: "localImage", path: file.path })
        else if (file.data) items.push({ type: "image", url: `data:${file.mime};base64,${file.data}` })
      } else if (file.path) {
        others.push(file.path)
      }
    }
    if (others.length) items[0].text += `\n\nAttached files:\n${others.map((path) => `- ${path}`).join("\n")}`
    const effort = input.model.variant
    const params: Record<string, unknown> = {
      threadId: this.nativeID,
      input: items,
      cwd: this.session.location.directory,
      model: input.model.id,
      summary: "detailed",
      approvalsReviewer: "user",
      ...this.policy(hooks, input.plan, rpc),
      ...(effort ? { effort } : {}),
      collaborationMode: { mode: input.plan ? "plan" : "default", settings: { model: input.model.id, reasoning_effort: effort ?? null, developer_instructions: null } },
    }
    return new Promise<RunResult>((resolve) => {
      this.answered = []
      this.wokeUp()
      const active: Active = { turn, hooks, resolve, streamed: new Set(), changes: new Map(), output: new Map(), toolsSinceText: false, subagents: new Map(), spawning: [], auto: input.auto, model: input.model.id, planning: input.plan }
      // As it ends, the agents it spawned that are still at work go on in their sessions (a turn
      // stopped or failed stops them: the session ends them with it).
      active.resolve = (result) => {
        for (const [threadID, lane] of active.subagents) {
          if (lane.ended) continue
          if (result.outcome === "succeeded") {
            this.backgroundLanes.set(threadID, lane)
          } else {
            // Codex doesn't stop them itself (through the Codex that ran them: one that stopped
            // took them with it).
            void this.interruptLane(threadID, lane, rpc)
            this.endSubagent(lane, "interrupted")
          }
        }
        // (Said once its turn took the message.)
        if (note && (result.outcome !== "failed" || active.turnID)) {
          this.state.codexTold = instructions
          hooks.saveState()
        }
        resolve(result)
      }
      this.active = active
      // (Asked to summarize, it says nothing: no step, and only its own thread to name. Sent while
      // a turn runs it stops that turn, so the session waits for the turn to end first.)
      if (input.compact) active.compacting = true
      else turn.startStep()
      const asked = input.compact ? rpc.request("thread/compact/start", { threadId: this.nativeID }, 60_000) : rpc.request("turn/start", params, 60_000)
      asked.then(
        (result: any) => {
          if (result?.turn?.id) active.turnID ??= result.turn.id
        },
        (error) => {
          if (this.active !== active) return
          this.active = undefined
          resolve({ outcome: "failed", error: failure(error) })
        },
      )
    })
  }

  /** What an item says of the answers in its turn. */
  private answersOnItem(active: Active, method: string, item: any) {
    if (item?.type === "sleep" && method === "item/completed") this.wokeUp()
    if (method !== "item/started") return
    const stopped = active.stopping || active.hooks.signal.aborted
    if (item?.type === "sleep") {
      this.sleep = new AbortController()
      // One that starts after its answer went in isn't cut short by it, as one under way is, and the
      // model may be sleeping on that question: told again once, which ends the sleep. (Past that,
      // it's a sleep of its own.)
      const said = this.answered
      this.answered = []
      if (said.length && !stopped) {
        const words = { text: `Your question has its answer, so there's nothing to wait for on it:\n\n${said.map((each) => each.text).join("\n\n")}`, files: [] }
        for (const each of said) this.retelling.add(each)
        this.keep(this.steerIn(active, words).then(async (took) => {
          if (took) return
          // Into this sleep, and then into one that started while that was tried (as in steerAnswer).
          for (let tried: AbortController | undefined; this.sleep && this.sleep !== tried && this.active === active; ) {
            tried = this.sleep
            if (await this.steerIntoSleep(active, words)) return
          }
          // None left to tell, in the same breath: what it heard waits for the next sleep, and what
          // it never took (turned down as this sleep started) goes in as it goes on, or starts its
          // next turn, rather than wait on a sleep that may never come.
          this.answered.push(...said.filter((each) => each.heard))
          this.answers.push(...said.filter((each) => !each.heard).map((each) => ({ text: each.text, files: each.files ?? [] })))
        }).finally(() => {
          for (const each of said) this.retelling.delete(each)
        }))
      }
    } else if (item?.type === "userMessage") {
      // (Its words first: what it attached, Codex may be told of after them. One being told again
      // as a sleep started counts too: Codex may take it as it was first sent meanwhile.)
      const text: unknown = (item.content ?? []).find((part: any) => part?.type === "text")?.text
      const heard = typeof text === "string" ? [...this.answered, ...this.retelling].find((each) => !each.heard && text.startsWith(each.text)) : undefined
      if (heard) heard.heard = true
    } else if (WORK_ITEMS.has(item?.type)) {
      this.turnedDown = 0
      // (Reasoning doesn't let it go: it's what comes before the sleep that needs ending.)
      this.answered = this.answered.filter((each) => !each.heard)
    }
    // One its turn turned down a moment ago (as it compacted, say) goes in as it goes on.
    if (this.answers.length && !stopped) {
      const waiting = this.answers
      this.answers = []
      for (const answer of waiting) this.keep(this.steerAnswer(active, answer))
    }
  }

  /** What Codex says (`from`: the app-server that said it). */
  notification(method: string, params: any, from?: RPC) {
    const active = this.active
    // An agent it spawned: told in its session (one still at work after the turn too).
    if (params?.threadId && this.nativeID && params.threadId !== this.nativeID) return this.subagentNotification(active, params.threadId, method, params, from)
    // Codex let go of the thread: the next turn loads it again.
    if (method === "thread/closed") {
      this.loaded = false
      return
    }
    if (!active) return
    const turn = active.turn
    // Another turn's (one stopped before, ending late).
    const turnID = params?.turnId ?? params?.turn?.id
    if (active.turnID && turnID && turnID !== active.turnID) return
    // A question for you, its words shown as they are: asked now, whatever it does next.
    if (method === "item/completed" && params?.item?.type === "agentMessage" && Array.isArray(params.item.questions)) {
      const questions: AskedQuestion[] = params.item.questions.filter((question: any) => typeof question?.title === "string" && question.title)
      if (questions.length) {
        // (What it heard before asking this isn't what a sleep from here on is about.)
        this.answered = this.answered.filter((each) => !each.heard)
        this.ask(questions, active.hooks)
      }
    }
    if (method === "item/started" || method === "item/completed") this.answersOnItem(active, method, params?.item)
    switch (method) {
      case "turn/started":
        active.turnID ??= params.turn?.id
        return
      case "thread/tokenUsage/updated": {
        // How much its model holds, as Codex says: the models list it.
        this.agent.noteContext(active.model, params.tokenUsage?.modelContextWindow)
        this.laneNotification(active, method, params)
        return
      }
      case "error": {
        const limit = this.limitOf(params.error, active.model)
        if (limit && params.willRetry) {
          // On Auto, the next model goes on rather than waiting for Codex to try again; otherwise
          // Codex's retry may well go through.
          if (active.auto) {
            active.limit = { ...limit, brief: limit.brief ?? params.error?.codexErrorInfo === "rateLimitExceeded" }
            active.problem = params.error?.message || "Codex is rate limited for now."
            active.stoppedForLimit = true
            void this.stopTurn(active)
          }
          return
        }
        if (limit) {
          active.limit = limit
          active.problem = params.error?.message || "You've reached your Codex usage limit for now."
          return
        }
        if (!params.willRetry) active.problem = params.error?.additionalDetails || params.error?.message
        // Trying again (a dropped connection, an overloaded server): said once, so it isn't a silent stall.
        else this.noticeOnce(active, "retry", `Codex hit a problem and is trying again: ${params.error?.message ?? "the connection dropped"}.`)
        return
      }
      case "turn/completed": {
        this.active = undefined
        if (active.plan) turn.toolSucceeded(active.plan.id, "", { todos: active.plan.todos })
        turn.endStep()
        const status = params.turn?.status
        // A limit only when the turn didn't go through: one it got past on a retry doesn't count.
        const limit = status === "failed" ? (active.limit ?? this.limitOf(params.turn?.error, active.model)) : status === "interrupted" && active.stoppedForLimit ? active.limit : undefined
        if (limit && !active.stopping && !active.hooks.signal.aborted) {
          active.resolve({ outcome: "failed", error: { type: "limit", message: active.problem ?? params.turn?.error?.message ?? "You've reached your Codex usage limit for now." }, limit, taken: true })
        } else if (active.stoppedAsking && !active.hooks.signal.aborted) active.resolve({ outcome: "succeeded" })
        else if (active.hooks.signal.aborted || status === "interrupted") active.resolve({ outcome: "interrupted" })
        else if (status === "failed") active.resolve({ outcome: "failed", error: failure(params.turn?.error?.message ?? active.problem ?? "Codex stopped with an error."), taken: true })
        else active.resolve({ outcome: "succeeded" })
        return
      }
      default:
        this.laneNotification(active, method, params)
    }
  }

  /**
   * What a thread says that's the same for the turn's own and a spawned agent's: words, thinking,
   * steps, its to-do list, and what Codex says for you to read (warnings, hooks, a model switched).
   */
  private laneNotification(lane: Lane, method: string, params: any) {
    const turn = lane.turn
    switch (method) {
      case "item/agentMessage/delta":
        this.words(lane)
        lane.streamed.add(params.itemId)
        this.say(lane, citationsOf(lane, params.itemId).read(params.delta ?? ""))
        return
      case "item/reasoning/summaryTextDelta":
        this.words(lane)
        ;(lane.summarized ??= new Set()).add(params.itemId)
        turn.reasoning(params.delta ?? "")
        return
      case "item/reasoning/summaryPartAdded":
        if ((params.summaryIndex ?? 0) > 0) turn.reasoning("\n\n")
        return
      case "item/reasoning/textDelta":
        // Its own thinking, for a model that sends no summary of it.
        if (lane.summarized?.has(params.itemId)) return
        this.words(lane)
        ;(lane.reasoned ??= new Set()).add(params.itemId)
        turn.reasoning(params.delta ?? "")
        return
      case "item/plan/delta":
        this.words(lane)
        lane.streamed.add(params.itemId)
        turn.text(params.delta ?? "")
        return
      case "item/commandExecution/outputDelta": {
        const output = ((lane.output.get(params.itemId) ?? "") + (params.delta ?? "")).slice(-outputLimit)
        lane.output.set(params.itemId, output)
        turn.toolProgress(params.itemId, { output })
        return
      }
      case "item/commandExecution/terminalInteraction": {
        // What it typed into the command while it ran.
        const output = ((lane.output.get(params.itemId) ?? "") + `\n> ${params.stdin ?? ""}\n`).slice(-outputLimit)
        lane.output.set(params.itemId, output)
        turn.toolProgress(params.itemId, { output })
        return
      }
      case "item/fileChange/patchUpdated": {
        const changes = codexChanges(params.changes)
        lane.changes.set(params.itemId, changes)
        turn.toolProgress(params.itemId, { files: changes.map(changeDiff) })
        return
      }
      case "item/mcpToolCall/progress":
        if (typeof params.message === "string") turn.toolProgress(params.itemId, { output: params.message })
        return
      case "item/started":
        return this.itemStarted(lane, params.item)
      case "item/completed":
        return this.itemCompleted(lane, params.item)
      case "turn/plan/updated": {
        // Its to-do list, one a turn, brought up to date as it works through it.
        const todos = ((params.plan ?? []) as { step: string; status: string }[]).map((entry) => ({ content: entry.step, status: entry.status === "inProgress" ? "in_progress" : entry.status }))
        const id = lane.plan?.id ?? newID("call")
        lane.plan = { id, todos }
        if (!turn.hasTool(id)) turn.toolStart(id, "todowrite", { todos })
        else turn.toolCalled(id, { todos })
        return
      }
      case "thread/tokenUsage/updated": {
        // Told as a model call ends (after the commands it ran): its step ends with what it used,
        // and what comes next is the next call's step, as the engine's steps are. (One with
        // nothing read or written, Codex's estimate after it compacted, isn't a call.)
        const last = params.tokenUsage?.last
        if (!last?.inputTokens && !last?.outputTokens) return
        lane.toolsSinceText = false
        turn.endStep({
          tokens: {
            input: Math.max(0, (last.inputTokens ?? 0) - (last.cachedInputTokens ?? 0)),
            output: Math.max(0, (last.outputTokens ?? 0) - (last.reasoningOutputTokens ?? 0)),
            reasoning: last.reasoningOutputTokens ?? 0,
            cache: { read: last.cachedInputTokens ?? 0, write: last.cacheWriteInputTokens ?? 0 },
          },
        })
        return
      }
      case "hook/started":
      case "hook/completed": {
        // A hook of yours ran (Codex's settings): a step, with what it said.
        const run = params.run ?? {}
        const id = `hook:${run.id ?? newID("call")}`
        if (!turn.hasTool(id)) {
          lane.toolsSinceText = true
          turn.toolStart(id, "hook", { description: `${run.eventName ?? "hook"} hook`, source: run.sourcePath })
        }
        if (method === "hook/started") return
        const said = ((run.entries ?? []) as { kind?: string; text?: string }[]).map((entry) => (entry.kind && entry.kind !== "context" ? `${entry.kind}: ${entry.text ?? ""}` : (entry.text ?? ""))).filter(Boolean).join("\n")
        if (run.status === "failed" || run.status === "blocked") turn.toolFailed(id, said || (run.statusMessage ?? `The hook ${run.status}.`))
        else turn.toolSucceeded(id, said || (run.statusMessage ?? ""))
        return
      }
      case "model/rerouted":
        turn.notice(`${params.toModel ?? "Another model"} answered instead of ${params.fromModel ?? "the one you picked"}${params.reason === "highRiskCyberActivity" ? " (Codex moves security-sensitive work to it)" : ""}.`)
        return
      case "model/verification":
        if (Array.isArray(params.verifications) && params.verifications.length) turn.notice(`Codex asks for verification to go on: ${params.verifications.join(", ")}.`)
        return
      case "model/safetyBuffering/updated":
        if (params.showBufferingUi) this.noticeOnce(lane, "buffering", `Codex is checking ${params.model ?? "this model"}'s answer before showing it${params.fasterModel ? `; ${params.fasterModel} would be faster` : ""}.`)
        return
      case "modelProvider/authRecoveryStarted":
      case "modelProvider/authRecoveryCompleted":
      case "warning":
      case "guardianWarning":
        if (typeof params.message === "string" && params.message.trim()) turn.notice(params.message.trim())
        return
      case "deprecationNotice":
      case "configWarning":
        if (params.summary) turn.notice([params.summary, params.details, params.path].filter(Boolean).join(" — "))
        return
      case "mcpServer/startupStatus/updated":
        // Kuvo Code's own tools, there or not: the agent works without them when they don't start.
        if (params.name === toolServerName && params.status === "failed") turn.notice(`Kuvo Code's tools didn't start for Codex${params.error ? `: ${params.error}` : ""}.`)
        return
    }
  }

  /** A notice for this turn, once. */
  private noticeOnce(lane: Lane, key: string, text: string) {
    if (lane.noticed?.has(key)) return
    ;(lane.noticed ??= new Set()).add(key)
    lane.turn.notice(text)
  }

  /** A thread this session's Codex spawned started: the oldest spawn call under way is its. */
  spawnStarted(threadID: string) {
    const active = this.active
    const call = active?.spawning[0]
    if (active && call && !active.subagents.has(threadID)) this.linkSubagent(active, call, threadID)
    // Linked before its thread said whether it takes your messages: its session hears now.
    if (this.spawnedSessions[threadID]) this.rememberSpawn(threadID, { direct: this.agent.directInput.get(threadID) })
    const lane = active?.subagents.get(threadID) ?? this.backgroundLanes.get(threadID)
    lane?.run.messages(this.messagesFor(threadID))
  }

  /** What a spawned agent's thread says, in its session. */
  private subagentNotification(active: Active | undefined, threadID: string, method: string, params: any, from?: RPC) {
    let lane = active?.subagents.get(threadID)
    const kept = this.backgroundLanes.get(threadID)
    if (!lane && kept) {
      lane = kept
      // A turn under way has it now.
      if (active) {
        this.backgroundLanes.delete(threadID)
        active.subagents.set(threadID, kept)
      }
    }
    // You wrote to it once it was done: its next turn is yours.
    const resume = method === "turn/started" ? this.resuming.get(threadID) : undefined
    if (resume) this.resuming.delete(threadID)
    if (!active && !lane && !resume) return
    if (!lane) {
      // One spawned in an earlier turn, given more to do (a turn starts on its thread): its
      // session goes on. Anything else from it (closed, its usage) isn't news.
      if (method !== "turn/started") return
      const before = this.spawnedSessions[threadID]
      if (!before) return
      lane = this.resumedLane(active, threadID, before.call, before.title, before.sessionID, resume, from)
      if (!lane) return
    }
    if (lane.ended) {
      // Given more to do: its session goes on (in a turn of this session's, or one of its own
      // when you wrote to it; otherwise, between turns, it's told when the next one begins).
      if (method !== "turn/started") return
      const next = this.resumedLane(active, threadID, lane.call, lane.title, lane.run.sessionID, resume, from)
      if (!next) return
      lane = next
    }
    const turnID = params?.turn?.id ?? params?.turnId
    if (typeof turnID === "string" && method !== "turn/completed") lane.turnID = turnID
    switch (method) {
      case "error":
        if (!params.willRetry && params.error?.message) lane.turn.notice(params.error.message)
        return
      case "turn/completed": {
        const status = params.turn?.status
        if (lane.plan) lane.turn.toolSucceeded(lane.plan.id, "", { todos: lane.plan.todos })
        this.endSubagent(lane, status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "succeeded", params.turn?.error?.message)
        this.backgroundLanes.delete(threadID)
        return
      }
      default:
        this.laneNotification(lane, method, params)
    }
  }

  /**
   * An agent spawned (Codex 0.16x says so with a `subAgentActivity` "started", the task itself
   * kept encrypted): a row for it, and a session its thread is told in.
   */
  private spawned(main: Active, item: any) {
    const threadID = item.agentThreadId
    if (typeof threadID !== "string" || main.subagents.has(threadID)) return
    const title = agentTitle(item.agentPath) || "A spawned agent's task"
    main.toolsSinceText = true
    if (!main.turn.hasTool(item.id)) main.turn.toolStart(item.id, "subagent", { description: title, background: true })
    const lane = this.linkSubagent(main, item.id, threadID)
    main.turn.toolSucceeded(item.id, "Started.", { sessionID: lane.run.sessionID })
  }

  /** A spawned agent's session, for its spawn call and thread. */
  private linkSubagent(active: Active, call: string, threadID: string, prompt?: string): SubagentLane {
    const known = active.subagents.get(threadID)
    if (known) return known
    active.spawning = active.spawning.filter((waiting) => waiting !== call)
    const input = (active.turn.toolInput(call) ?? {}) as Record<string, any>
    const title = String(input.description ?? "") || "A spawned agent's task"
    // It works on its own, past the turn that spawned it.
    const run = active.hooks.subagent(call, { title, prompt: prompt ?? input.prompt, background: true, messages: this.messagesFor(threadID) })
    run.stop = () => this.stopSubagent(threadID)
    const lane: SubagentLane = { turn: run.turn, streamed: new Set(), changes: new Map(), output: new Map(), toolsSinceText: false, run, threadID, call, title, ended: false, server: this.server }
    active.subagents.set(threadID, lane)
    this.rememberSpawn(threadID, { call, title, sessionID: run.sessionID, ...(this.agent.directInput.has(threadID) ? { direct: this.agent.directInput.get(threadID) } : {}) })
    // Its approvals come to this session's.
    this.agent.adopt(threadID, this)
    return lane
  }

  /**
   * A spawned agent at work again, in its session: under the turn under way, or, with none, as a
   * run of its own you started by writing to it (`resume`). None when neither has it.
   */
  private resumedLane(active: Active | undefined, threadID: string, call: string, title: string, sessionID: string, resume?: () => SubagentRun, from?: RPC): SubagentLane | undefined {
    if (active) return this.continueSubagent(active, threadID, call, title, sessionID, from)
    if (!resume) return undefined
    const run = resume()
    run.stop = () => this.stopSubagent(threadID)
    const lane: SubagentLane = { turn: run.turn, streamed: new Set(), changes: new Map(), output: new Map(), toolsSinceText: false, run, threadID, call, title, ended: false, server: from ?? this.server }
    this.backgroundLanes.set(threadID, lane)
    return lane
  }

  /** (In the Codex it's heard from, `from`: one its agents still work in may not be the turn's.) */
  private continueSubagent(active: Active, threadID: string, call: string, title: string, sessionID: string, from?: RPC): SubagentLane {
    const run = active.hooks.subagent(call, { title, sessionID, background: true, messages: this.messagesFor(threadID) })
    run.stop = () => this.stopSubagent(threadID)
    const next: SubagentLane = { turn: run.turn, streamed: new Set(), changes: new Map(), output: new Map(), toolsSinceText: false, run, threadID, call, title, ended: false, server: from ?? this.server }
    active.subagents.set(threadID, next)
    return next
  }

  /** A spawned agent stopped from Kuvo Code: its turn on its thread is interrupted (it then says so). */
  private async stopSubagent(threadID: string) {
    const lane = this.active?.subagents.get(threadID) ?? this.backgroundLanes.get(threadID)
    if (lane && !lane.ended) await this.interruptLane(threadID, lane, lane.server ?? this.server)
  }

  /** Interrupts a spawned agent's turn, through `rpc`, the Codex its thread is in (none running: nothing to stop). */
  private async interruptLane(threadID: string, lane: SubagentLane, rpc: RPC | undefined) {
    if (!lane.turnID || !rpc || rpc.isClosed) return
    await rpc.request("turn/interrupt", { threadId: threadID, turnId: lane.turnID }, 10_000).catch(() => {})
  }

  private endSubagent(lane: SubagentLane, outcome: "succeeded" | "failed" | "interrupted", message?: string) {
    if (lane.ended) return
    lane.ended = true
    lane.turn.endStep()
    lane.run.end(outcome, outcome === "failed" ? { type: "agent", message: message ?? "The agent stopped with an error." } : undefined)
  }

  /** Words after a tool begin a new step, as a model's next answer does. */
  private words(lane: Lane) {
    if (!lane.toolsSinceText) return
    lane.toolsSinceText = false
    lane.turn.endStep()
    lane.turn.startStep()
  }

  /** Its words, with a file it cites as what it made shown in the conversation, as show_file shows one. */
  private say(lane: Lane, said: Said[]) {
    for (const each of said) {
      if ("text" in each) {
        lane.turn.text(each.text)
        continue
      }
      // Part of its message, not a step of its own: the words after it go on in the same step.
      const id = `cited-${newID("call")}`
      lane.turn.toolStart(id, `${toolServerName}_show_file`, { path: each.made })
      lane.turn.toolSucceeded(id, "Shown in the conversation.")
    }
  }

  private itemStarted(lane: Lane, item: any) {
    const active = lane
    const turn = lane.turn
    switch (item?.type) {
      case "contextCompaction":
        // It summarizes the conversation by itself (it's filling up), until the item completes.
        // (One you asked for shows as that.)
        if (this.active?.turn !== turn || !this.active.compacting) turn.compacting()
        return
      case "sleep":
        // It waits a while on purpose.
        active.toolsSinceText = true
        turn.toolStart(item.id, "sleep", { seconds: Math.round((item.durationMs ?? 0) / 1000) })
        return
      case "collabAgentToolCall": {
        // Waiting for the agents it spawned.
        if (item.tool === "wait") {
          active.toolsSinceText = true
          turn.toolStart(item.id, "wait", { description: "Waiting for its subagents" })
          return
        }
        // Writing to one, or resuming or closing one: a step too.
        if (item.tool !== "spawnAgent") {
          active.toolsSinceText = true
          turn.toolStart(item.id, "agent_" + String(item.tool ?? "action"), { description: collabWords(item.tool), prompt: item.prompt ?? undefined, agents: item.receiverThreadIds })
          return
        }
        // Another agent spawned for part of the work: a subagent, at work beside this one.
        if (item.tool !== "spawnAgent" || !this.active || lane !== this.active) return
        const main = this.active
        lane.toolsSinceText = true
        const prompt = typeof item.prompt === "string" ? item.prompt : ""
        turn.toolStart(item.id, "subagent", { description: firstLine(prompt) || "A spawned agent's task", prompt, background: true })
        main.spawning.push(item.id)
        const thread = item.receiverThreadIds?.[0]
        if (thread) this.linkSubagent(main, item.id, thread, prompt)
        return
      }
      case "subAgentActivity": {
        const main = this.active
        if (main && lane === main && item.kind === "started") return this.spawned(main, item)
        const spawned = main && lane === main ? main.subagents.get(item.agentThreadId) : undefined
        if (spawned && (item.kind === "completed" || item.kind === "interrupted")) this.endSubagent(spawned, item.kind === "completed" ? "succeeded" : "interrupted")
        return
      }
      case "commandExecution":
        active.toolsSinceText = true
        turn.toolStart(item.id, "shell", { command: unwrapShell(item.command ?? ""), cwd: item.cwd })
        return
      case "fileChange": {
        active.toolsSinceText = true
        const changes = codexChanges(item.changes)
        active.changes.set(item.id, changes)
        turn.toolStart(item.id, "patch", { files: changes.flatMap((change) => [change.path, ...(change.movedTo ? [change.movedTo] : [])]) })
        return
      }
      case "functionCallOutput":
        // A tool of Codex's own that has no item of its own: what it came back with.
        active.toolsSinceText = true
        turn.toolStart(item.id, [item.namespace, item.name].filter(Boolean).join(".") || "tool", {})
        return
      case "mcpToolCall":
        active.toolsSinceText = true
        turn.toolStart(item.id, `${item.server}_${item.tool}`, item.arguments ?? {})
        return
      case "dynamicToolCall":
        active.toolsSinceText = true
        turn.toolStart(item.id, item.tool, item.arguments ?? {})
        return
      case "webSearch":
        active.toolsSinceText = true
        turn.toolStart(item.id, "websearch", { query: item.query ?? item.action?.query ?? "" })
        return
      case "imageGeneration":
        active.toolsSinceText = true
        turn.toolStart(item.id, "generate_image", { prompt: item.revisedPrompt ?? "" })
        return
      case "imageView":
        active.toolsSinceText = true
        turn.toolStart(item.id, "read", { path: item.path })
        return
      default:
        // One this bridge doesn't know (a newer Codex's): shown as a step, not lost.
        if (!codexItems.has(item?.type) && typeof item?.id === "string") {
          active.toolsSinceText = true
          turn.toolStart(item.id, String(item.type ?? "tool"), unknownInput(item))
        }
    }
  }

  private itemCompleted(lane: Lane, item: any) {
    const active = lane
    const turn = lane.turn
    // A step whose start wasn't told (it came whole): started now, so its end isn't lost.
    if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "functionCallOutput"].includes(item?.type) && typeof item.id === "string" && !turn.hasTool(item.id)) this.itemStarted(lane, item)
    switch (item?.type) {
      case "sleep":
        if (turn.hasTool(item.id)) turn.toolSucceeded(item.id, `Waited ${Math.round((item.durationMs ?? 0) / 1000)} seconds.`)
        return
      case "collabAgentToolCall": {
        if (item.tool === "wait") {
          // What each agent it waited for said.
          const states = Object.values((item.agentsStates ?? {}) as Record<string, { status?: string; message?: string | null }>)
            .map((state) => [state.status, state.message].filter(Boolean).join(": "))
            .filter(Boolean)
            .join("\n")
          if (turn.hasTool(item.id)) item.status === "failed" ? turn.toolFailed(item.id, states || "It stopped waiting.") : turn.toolSucceeded(item.id, states || "Done waiting.")
          return
        }
        if (item.tool !== "spawnAgent") {
          if (!turn.hasTool(item.id)) turn.toolStart(item.id, "agent_" + String(item.tool ?? "action"), { description: collabWords(item.tool) })
          item.status === "failed" ? turn.toolFailed(item.id, "It didn't go through.") : turn.toolSucceeded(item.id, "")
          return
        }
        if (item.tool !== "spawnAgent" || !this.active || lane !== this.active) return
        const main = this.active
        const thread = item.receiverThreadIds?.[0]
        const spawned = thread ? this.linkSubagent(main, item.id, thread, typeof item.prompt === "string" ? item.prompt : undefined) : undefined
        if (item.status === "failed" || !spawned) turn.toolFailed(item.id, "The agent couldn't be started.")
        else turn.toolSucceeded(item.id, "Started.", { sessionID: spawned.run.sessionID })
        return
      }
      case "subAgentActivity": {
        const main = this.active
        if (main && lane === main && item.kind === "started") return this.spawned(main, item)
        const spawned = main && lane === main ? main.subagents.get(item.agentThreadId) : undefined
        if (spawned && (item.kind === "completed" || item.kind === "interrupted")) this.endSubagent(spawned, item.kind === "completed" ? "succeeded" : "interrupted")
        return
      }
      case "agentMessage": {
        const citations = citationsOf(active, item.id)
        if (!active.streamed.has(item.id) && item.text) {
          this.words(active)
          this.say(active, citations.read(item.text))
        }
        this.say(active, citations.end())
        active.citations?.delete(item.id)
        // Questions it leaves for you, and what it remembered and where from.
        const questions = ((item.questions ?? []) as { title?: string; options?: string[] | null }[]).map((question) => `- ${question.title ?? ""}${question.options?.length ? ` (${question.options.join(" / ")})` : ""}`)
        if (questions.length) turn.text(`\n\n${questions.join("\n")}`)
        const cited = ((item.memoryCitation?.entries ?? []) as { path?: string; lineStart?: number; lineEnd?: number; note?: string }[]).map((entry) => `${entry.path}:${entry.lineStart}-${entry.lineEnd}${entry.note ? ` (${entry.note})` : ""}`)
        if (cited.length) turn.text(`\n\nFrom memory: ${cited.join("; ")}`)
        turn.endBlock()
        return
      }
      case "reasoning": {
        // Thinking that wasn't told as it came: told now.
        if (!active.summarized?.has(item.id) && !active.reasoned?.has(item.id)) {
          const said = [...(item.summary ?? []), ...(item.summary?.length ? [] : (item.content ?? []))].filter((part: unknown) => typeof part === "string" && part.trim()).join("\n\n")
          if (said) {
            this.words(active)
            turn.reasoning(said)
          }
        }
        turn.endBlock()
        return
      }
      case "plan":
        // Plan mode's proposal: the plan, in words (unless it came as it was written).
        if (item.text && !active.streamed.has(item.id)) {
          this.words(active)
          turn.text(item.text)
        }
        turn.endBlock()
        return
      case "commandExecution": {
        const output = (item.aggregatedOutput ?? active.output.get(item.id) ?? "").slice(-outputLimit)
        if (item.status === "declined") turn.toolFailed(item.id, "Declined.")
        else if (item.status === "failed" && item.exitCode == null) turn.toolFailed(item.id, output || "The command failed.")
        else turn.toolSucceeded(item.id, output, { output, exit: item.exitCode ?? 0 })
        return
      }
      case "fileChange": {
        const changes = codexChanges(item.changes)
        const files: FileDiff[] = changes.map(changeDiff)
        const said = changes.map((change) => (change.movedTo ? `${change.path} → ${change.movedTo}` : change.path)).join("\n")
        if (item.status === "declined") turn.toolFailed(item.id, "Declined.", { files })
        else if (item.status === "failed") turn.toolFailed(item.id, "The change couldn't be made.", { files })
        else turn.toolSucceeded(item.id, said, { files })
        return
      }
      case "mcpToolCall": {
        const content = item.result?.content ?? []
        const parts = mcpParts(content)
        const text = parts.text || (item.result?.structuredContent !== undefined && item.result?.structuredContent !== null ? JSON.stringify(item.result.structuredContent, null, 2) : "")
        if (item.error || item.status === "failed") turn.toolFailed(item.id, item.error?.message || text || "The tool failed.")
        else turn.toolSucceeded(item.id, withPictures(text.slice(0, outputLimit), parts.pictures))
        return
      }
      case "dynamicToolCall": {
        const items = (item.contentItems ?? []) as { type?: string; text?: string; imageUrl?: string }[]
        const text = items.map((part) => part?.text ?? "").filter(Boolean).join("\n")
        const pictures = items.map((part) => (part?.type === "inputImage" ? pictureUrl(part.imageUrl) : undefined))
        if (item.success === false) turn.toolFailed(item.id, text || "The tool failed.")
        else turn.toolSucceeded(item.id, withPictures(text.slice(0, outputLimit), pictures))
        return
      }
      case "webSearch": {
        // What it searched for or opened, and what came back.
        const action = item.action ?? {}
        const lines = [action.url ? `Opened ${action.url}` : "", action.pattern ? `Looked for "${action.pattern}"` : "", ...((action.queries ?? []) as string[]).map((query) => `Searched for "${query}"`)]
        for (const result of (item.results ?? []) as any[]) lines.push([result?.title, result?.url].filter(Boolean).join(" — "))
        turn.toolSucceeded(item.id, lines.filter(Boolean).join("\n").slice(0, outputLimit))
        return
      }
      case "imageGeneration": {
        if (!turn.hasTool(item.id)) turn.toolStart(item.id, "generate_image", { prompt: item.revisedPrompt ?? "" })
        const failure = item.failure
        if (item.status === "failed" || failure) {
          const resets = typeof failure?.resetsAt === "number" ? ` It resets ${new Date(failure.resetsAt * 1000).toLocaleString()}.` : ""
          turn.toolFailed(item.id, failure?.type === "usageLimitExceeded" ? `You've reached your limit for making images.${resets}` : "The image couldn't be made.")
        } else turn.toolSucceeded(item.id, withPictures("", [pictureFile(item.savedPath) ?? pictureData(item.result, "image/png")]))
        return
      }
      case "functionCallOutput": {
        const output = item.output
        if (typeof output === "string") turn.toolSucceeded(item.id, output.slice(0, outputLimit))
        else {
          const parts = (Array.isArray(output) ? output : []) as { type?: string; text?: string; image_url?: string }[]
          const text = parts.map((part) => part?.text ?? "").filter(Boolean).join("\n")
          turn.toolSucceeded(item.id, withPictures(text.slice(0, outputLimit), parts.map((part) => pictureUrl(part?.image_url))))
        }
        return
      }
      case "imageView":
        if (!turn.hasTool(item.id)) turn.toolStart(item.id, "read", { path: item.path })
        turn.toolSucceeded(item.id, withPictures("", [pictureFile(item.path)]))
        return
      case "contextCompaction":
        // Summarized. (One you asked for shows as that.)
        if (this.active?.turn !== turn || !this.active.compacting) turn.compacted(true)
        return
      case "enteredReviewMode":
        turn.notice(`Reviewing${typeof item.review === "string" && item.review ? `: ${item.review}` : ""}`)
        return
      case "exitedReviewMode":
        if (typeof item.review === "string" && item.review.trim()) {
          this.words(active)
          turn.text(item.review)
          turn.endBlock()
        }
        return
      default:
        // One this bridge doesn't know: its step ends, with what it says.
        if (!codexItems.has(item?.type) && typeof item?.id === "string") {
          if (!turn.hasTool(item.id)) turn.toolStart(item.id, String(item.type ?? "tool"), unknownInput(item))
          const said = unknownOutput(item)
          if (item.status === "failed" || item.success === false) turn.toolFailed(item.id, said || "It failed.")
          else turn.toolSucceeded(item.id, said)
        }
    }
  }

  /** What Codex asks (`fenced`: the app-server asking runs in the box's sandbox). */
  async request(method: string, params: any, signal?: AbortSignal, fenced = false): Promise<unknown> {
    const active = this.active
    // An agent it spawned asks as its own: its asks go on with it, after the turn that spawned it too.
    const lane = params?.threadId && params.threadId !== this.nativeID ? (active?.subagents.get(params.threadId) ?? this.backgroundLanes.get(params.threadId)) : undefined
    if (!active && !lane) {
      if (method === "item/tool/requestUserInput") return { answers: {} }
      if (method === "mcpServer/elicitation/request") return { action: "decline" }
      return method.endsWith("Approval") || method.endsWith("/requestApproval") ? (method.startsWith("item/") ? { decision: "decline" } : { decision: "denied" }) : {}
    }
    const hooks = {
      permission: (ask: Parameters<TurnHooks["permission"]>[0]) => (lane ? lane.run.permission({ ...ask, signal, sandboxed: fenced }) : active!.hooks.permission({ ...ask, signal, sandboxed: fenced })),
      question: (ask: Parameters<TurnHooks["question"]>[0]) => (active ? active.hooks.question({ ...ask, signal }) : Promise.resolve(null)),
    }
    // Always is kept here (the session asks the bridge again, which answers from it), never as
    // Codex's own for its session: that would let what comes after through without your rules.
    switch (method) {
      case "item/commandExecution/requestApproval": {
        // A command, or a connection to a site it wants (its sandbox keeps it off the network).
        const host = params.networkApprovalContext?.host
        const command = unwrapShell(params.command ?? "")
        const decision = host && !command ? await hooks.permission({ toolCallID: params.itemId, action: "webfetch", resources: [host], message: params.reason ?? `Codex wants to reach ${host}.` }) : await hooks.permission({ toolCallID: params.itemId, action: "shell", resources: [command || "*"], message: params.reason ?? undefined })
        return { decision: decision === "reject" ? "decline" : "accept" }
      }
      case "item/fileChange/requestApproval": {
        // A spawned agent's change: its session has it.
        const changes = (lane ?? active!).changes.get(params.itemId) ?? []
        const files = changes.map(changeDiff)
        const decision = await hooks.permission({
          toolCallID: params.itemId,
          action: "edit",
          // (A rename's new name too: it's written there.)
          resources: changes.length ? changes.flatMap((change) => [change.path, ...(change.movedTo ? [change.movedTo] : [])]) : [params.grantRoot ?? "*"],
          metadata: files.length ? { files } : undefined,
          message: params.reason ?? undefined,
        })
        return { decision: decision === "reject" ? "decline" : "accept" }
      }
      case "item/permissions/requestApproval": {
        const paths = [...(params.permissions?.fileSystem?.read ?? []), ...(params.permissions?.fileSystem?.write ?? [])]
        const network = params.permissions?.network?.enabled
        const decision = await hooks.permission({ toolCallID: params.itemId, action: paths.length || !network ? "external_directory" : "webfetch", resources: paths.length ? paths : network ? ["the network"] : ["*"], message: params.reason ?? undefined })
        return decision === "reject" ? { permissions: {}, scope: "turn" } : { permissions: params.permissions, scope: "turn" }
      }
      case "execCommandApproval": {
        const command = Array.isArray(params.command) ? params.command.join(" ") : String(params.command ?? "")
        const decision = await hooks.permission({ toolCallID: params.callId, action: "shell", resources: [command], message: params.reason ?? undefined })
        return { decision: decision === "reject" ? "denied" : "approved" }
      }
      case "applyPatchApproval": {
        // (Each file, and a rename's new name: it's written there.)
        const paths = Object.entries((params.fileChanges ?? {}) as Record<string, any>).flatMap(([file, change]) => [file, ...[change?.move_path, change?.update?.move_path].filter((each): each is string => typeof each === "string")])
        const decision = await hooks.permission({ toolCallID: params.callId, action: "edit", resources: paths.length ? paths : ["*"], message: params.reason ?? undefined })
        return { decision: decision === "reject" ? "denied" : "approved" }
      }
      case "item/tool/requestUserInput": {
        const questions = (params.questions ?? []) as { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; isOther?: boolean; isSecret?: boolean }[]
        const fields: FormField[] = questions.map((question) => ({
          key: question.id,
          title: question.header ?? "Question",
          description: question.question,
          required: true,
          type: "string",
          options: question.options?.map((option) => ({ value: option.label, label: option.label, description: option.description })),
          custom: question.isOther ?? !question.options?.length,
          // A secret (a password, a key): hidden as it's typed.
          ...(question.isSecret ? { format: "password" } : {}),
        }))
        let declined: string | undefined
        const answer = await hooks.question({ title: questions.length === 1 ? questions[0].header ?? "Question" : "Questions", fields, toolCallID: params.itemId, declined: (words) => { declined = words } })
        const answers: Record<string, { answers: string[] }> = {}
        for (const question of questions) {
          // (Turned down by its box with words: that's what it hears, never as a secret.)
          const value = answer?.[question.id] ?? (question.isSecret ? undefined : declined)
          answers[question.id] = { answers: value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : [String(value)] }
        }
        return { answers }
      }
      case "mcpServer/elicitation/request": {
        // Codex asking before an MCP tool runs: your permissions answer it, as any agent's tool
        // (Approve All, or Kuvo Code's own tools: no card; another server's under Ask First asks).
        // In Plan, another server's tool, which may change things, is still asked about below.
        if (params._meta?.codex_approval_kind === "mcp_tool_call" && (!active?.planning || params.serverName === toolServerName)) {
          const server = String(params.serverName ?? "mcp")
          const tool = String(params._meta.tool_name ?? /tool "([^"]+)"/.exec(String(params.message ?? ""))?.[1] ?? "tool")
          const decision = await hooks.permission({ action: `${server}_${tool}`, resources: ["*"], message: params.message ?? undefined, unclassified: server !== toolServerName })
          return decision === "reject" ? { action: "decline", content: null } : { action: "accept", content: null }
        }
        // An MCP server asks you something (a form), or to open a page (a sign-in).
        const title = `${params.serverName ?? "A tool"} asks`
        const metadata = { kind: "mcp-elicitation", server: String(params.serverName ?? "A tool") }
        if (params.mode === "url") {
          const answer = await hooks.question({ title, metadata, fields: [{ key: "open", title: params.message ?? "Open this page to go on.", type: "external", url: params.url }] })
          return { action: answer ? "accept" : "decline" }
        }
        const schema = params.requestedSchema ?? {}
        const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
        const fields: FormField[] = Object.entries((schema.properties ?? {}) as Record<string, any>).map(([key, field]) => elicitationField(key, field, required.has(key)))
        // Its message goes with the form's first field; a form with no fields is a yes or no.
        if (fields[0] && params.message) fields[0] = { ...fields[0], description: [params.message, fields[0].description].filter(Boolean).join("\n\n") }
        const answer = await hooks.question({ title, metadata, fields: fields.length ? fields : [{ key: "ok", title: params.message ?? "Go on?", type: "boolean", required: true }] })
        if (!answer) return { action: "decline" }
        const content: Record<string, unknown> = {}
        for (const [key, field] of Object.entries((schema.properties ?? {}) as Record<string, any>)) {
          const value = answer[key]
          if (value === undefined || value === null || value === "") continue
          content[key] = field?.type === "number" || field?.type === "integer" ? Number(value) : field?.type === "boolean" ? value === true || value === "true" : value
        }
        return { action: "accept", content }
      }
    }
    throw new RPCError(-32601, `Method not found: ${method}`)
  }

  /** A usage or rate limit in Codex's error: the plan's, or one model's (its own limit). */
  private limitOf(error: any, model: string): Limit | undefined {
    const info = error?.codexErrorInfo
    if (info !== "usageLimitExceeded" && info !== "rateLimitExceeded") return undefined
    const reached = (snapshot: any) =>
      Boolean(snapshot?.rateLimitReachedType) || [snapshot?.primary, snapshot?.secondary].some((window) => (window?.usedPercent ?? 0) >= 100)
    const resets = (snapshot: any) => {
      const times = [snapshot?.primary, snapshot?.secondary].filter((window) => (window?.usedPercent ?? 0) >= 100 && window?.resetsAt).map((window) => window.resetsAt * 1000)
      return times.length ? Math.max(...times) : undefined
    }
    // A model with a limit of its own, at it: only that model waits.
    for (const [id, snapshot] of this.agent.rateLimits) {
      if (id === "codex" || !reached(snapshot)) continue
      const slug: string | undefined = snapshot.normalModelSlug
      if (slug && (model === slug || model.startsWith(`${slug}-`))) return { scope: "model", resetsAt: resets(snapshot), message: error?.message }
    }
    const plan = this.agent.rateLimits.get("codex")
    if (info === "rateLimitExceeded" && !reached(plan)) return { scope: "model", brief: true, message: error?.message }
    return { scope: "provider", resetsAt: resets(plan), message: error?.message }
  }

  private async stopTurn(active: Active) {
    const rpc = await this.agent.rpc(this).catch(() => undefined)
    if (rpc && active.turnID && this.nativeID) await rpc.request("turn/interrupt", { threadId: this.nativeID, turnId: active.turnID }, 10_000).catch(() => {})
  }

  async interrupt() {
    const active = this.active
    if (!active || !this.nativeID) return
    active.stopping = true
    const rpc = await this.agent.rpc(this).catch(() => undefined)
    for (let waited = 0; waited < 10_000 && !active.turnID && this.active === active; waited += 100) await Bun.sleep(100)
    if (rpc && active.turnID) await rpc.request("turn/interrupt", { threadId: this.nativeID, turnId: active.turnID }, 10_000).catch(() => {})
    for (let waited = 0; waited < 10_000 && this.active === active; waited += 100) await Bun.sleep(100)
    if (this.active === active) {
      this.active = undefined
      active.resolve({ outcome: "interrupted" })
    }
  }

  close() {
    for (const lane of this.backgroundLanes.values()) this.endSubagent(lane, "interrupted")
    this.backgroundLanes.clear()
    clearTimeout(this.terminalsRead)
    if (this.terminals.length) emit("session.background.updated", { sessionID: this.session.id }, this.session.location.directory)
    this.terminals = []
    // Let go of in the app-server it's in (one of its own stops with it).
    const server = this.server
    if (this.nativeID && this.loaded && server && !server.isClosed && !this.agent.isFenced(server)) void server.request("thread/unsubscribe", { threadId: this.nativeID }).catch(() => {})
    this.agent.forget(this.session.id)
  }
}

/**
 * Codex's items this bridge shows, or leaves out on purpose (your own message, a hook's prompt to
 * the model). Any other is shown as a step of its own, so a newer Codex's isn't lost.
 */
export const codexItems = new Set([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "functionCallOutput",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
])

/** Codex's file changes, as the bridge keeps them (a rename says where it went). */
function codexChanges(raw: unknown): { path: string; kind: string; diff: string; movedTo?: string }[] {
  return ((Array.isArray(raw) ? raw : []) as any[]).map((change) => ({ path: change.path, kind: change.kind?.type ?? "update", diff: change.diff ?? "", movedTo: change.kind?.move_path ?? undefined }))
}

/** A change as the app draws it: Codex gives a new or deleted file's whole text, and an edit's unified diff. */
function changeDiff(change: { path: string; kind: string; diff: string; movedTo?: string }): FileDiff {
  if (change.kind === "add") return fileDiff(change.path, undefined, change.diff)
  if (change.kind === "delete") return fileDiff(change.path, change.diff, undefined)
  return fromPatch(change.movedTo ?? change.path, change.diff, "modified")
}

/** An MCP tool's result, as words and pictures (resources and links named, audio said). */
export function mcpParts(content: unknown): { text: string; pictures: ReturnType<typeof pictureData>[] } {
  const lines: string[] = []
  const pictures: ReturnType<typeof pictureData>[] = []
  for (const part of (Array.isArray(content) ? content : []) as any[]) {
    switch (part?.type) {
      case "text":
        if (part.text) lines.push(part.text)
        break
      case "image":
        pictures.push(pictureData(part.data, part.mimeType))
        break
      case "resource":
        if (typeof part.resource?.text === "string") lines.push(part.resource.text)
        else if (part.resource?.uri) lines.push(`Resource: ${part.resource.uri}`)
        if (typeof part.resource?.blob === "string") pictures.push(pictureData(part.resource.blob, part.resource.mimeType))
        break
      case "resource_link":
        lines.push(`${part.name ?? part.title ?? "Link"}: ${part.uri ?? ""}`)
        break
      case "audio":
        lines.push("(It sent a sound clip.)")
        break
      default:
        if (part) lines.push(typeof part.text === "string" ? part.text : JSON.stringify(part))
    }
  }
  return { text: lines.join("\n"), pictures }
}

/** A picture by its address: data, or a file on this Mac (one on the web is a link, not shown here). */
function pictureUrl(url: unknown): ReturnType<typeof pictureData> {
  if (typeof url !== "string") return undefined
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (data) return pictureData(data[2], data[1])
  if (url.startsWith("file://")) {
    try {
      return pictureFile(decodeURIComponent(new URL(url).pathname))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** What a step with its subagents does, in words. */
function collabWords(tool: unknown): string {
  switch (tool) {
    case "sendInput":
      return "Wrote to a subagent"
    case "resumeAgent":
      return "Resumed a subagent"
    case "closeAgent":
      return "Closed a subagent"
  }
  return `Subagents: ${String(tool ?? "")}`
}

/**
 * Codex's notifications: those shown (or used), and those left out on purpose (its own
 * bookkeeping, or kinds for clients that start commands, realtime audio or file search, which
 * Kuvo Code doesn't). A test checks the installed Codex sends no other.
 */
export const codexNotifications = {
  shown: [
    "error", "thread/started", "thread/closed", "thread/tokenUsage/updated", "turn/started", "turn/completed", "turn/plan/updated",
    "hook/started", "hook/completed", "item/started", "item/completed", "item/agentMessage/delta", "item/plan/delta",
    "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
    "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction", "item/fileChange/patchUpdated", "item/mcpToolCall/progress",
    "serverRequest/resolved", "mcpServer/startupStatus/updated", "account/updated", "account/rateLimits/updated", "account/login/completed",
    "model/rerouted", "model/verification", "model/safetyBuffering/updated", "modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted",
    "warning", "guardianWarning", "deprecationNotice", "configWarning",
  ],
  ignored: [
    "thread/status/changed", "thread/readState/changed", "thread/section/changed", "thread/archived", "thread/unarchived", "thread/deleted", "thread/reverted",
    "thread/name/updated", "thread/settings/updated", "thread/goal/updated", "thread/goal/cleared", "thread/compacted", "turn/diff/updated",
    "turn/moderationMetadata", "item/fileChange/outputDelta", "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
    "skills/changed", "app/list/updated", "project/changed", "fs/changed", "mcpServer/oauthLogin/completed", "mcpServer/event/stream/notification",
    "account/gatewayOAuth/changed", "remoteControl/status/changed", "thread/attachment/updated", "thread/prediction/updated",
    "thread/queue/changed", "thread/project/updated", "thread/environment/connected", "thread/environment/disconnected",
    "autoApprovalReview/strictReviewRequired", "command/exec/outputDelta", "process/outputDelta", "process/exited",
    "externalAgentConfig/import/progress", "externalAgentConfig/import/completed", "fuzzyFileSearch/sessionUpdated", "fuzzyFileSearch/sessionCompleted",
    "thread/realtime/started", "thread/realtime/itemAdded", "thread/realtime/item/started", "thread/realtime/item/transcript/delta",
    "thread/realtime/item/completed", "thread/realtime/transcript/delta", "thread/realtime/transcript/done", "thread/realtime/outputAudio/delta",
    "thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed", "windows/worldWritableWarning", "windowsSandbox/setupCompleted",
  ],
}

/**
 * The approval policies the bridge starts Codex's threads and turns with: Approve All asks so your
 * rules can answer what Codex's own rules ask about, Ask First and Plan ask before all but a look,
 * and a one-off answer (`generate`) never asks. Each must be one the installed Codex still takes.
 */
export const codexApprovals = { approveAll: "on-request", askFirst: "untrusted", never: "never" } as const

/** Codex's requests of the app: each answered (the last three never come: Kuvo Code doesn't opt in to them). */
export const codexRequests = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput",
  "mcpServer/elicitation/request", "item/tool/call", "execCommandApproval", "applyPatchApproval",
  "account/chatgptAuthTokens/refresh", "attestation/generate",
])

/** An item this bridge doesn't know, as a step's input: what it says, without its type and id. */
function unknownInput(item: any): Record<string, unknown> {
  const { type: _type, id: _id, ...rest } = item ?? {}
  return rest
}

/** What an unknown item came back with, as words. */
function unknownOutput(item: any): string {
  for (const key of ["output", "result", "text", "aggregatedOutput", "message"]) {
    const value = item?.[key]
    if (typeof value === "string" && value.trim()) return value.slice(0, outputLimit)
    if (value && typeof value === "object") return JSON.stringify(value).slice(0, outputLimit)
  }
  return ""
}

/** A spawned agent's name from its path ("/root/wait_1" is "Wait 1"). */
export function agentTitle(path: unknown): string {
  const last = typeof path === "string" ? (path.split("/").filter(Boolean).pop() ?? "") : ""
  const words = last.replace(/[_-]+/g, " ").trim()
  return words ? words[0].toUpperCase() + words.slice(1) : ""
}

/**
 * An added account's Codex folder: your own Codex's settings, instructions, skills and history in
 * it as links (as T3 Code makes one), but its own sign-in and its own list of models.
 */
function shadowHome(home: string, own: string) {
  const kept = new Set(["auth.json", "models_cache.json"])
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const wanted = existsSync(own) ? readdirSync(own).filter((name) => !kept.has(name)) : []
  for (const name of wanted) {
    const link = join(home, name)
    const target = join(own, name)
    try {
      const stat = lstatSync(link, { throwIfNoEntry: false })
      if (stat?.isSymbolicLink() && readlinkSync(link) === target) continue
      // Something of its own there already (it made it before there was one of yours): kept.
      if (stat && !stat.isSymbolicLink()) continue
      if (stat) rmSync(link, { force: true })
      symlinkSync(target, link)
    } catch {}
  }
  // Links to what's gone from yours: gone too.
  for (const name of readdirSync(home)) {
    const link = join(home, name)
    try {
      if (lstatSync(link).isSymbolicLink() && !wanted.includes(name)) rmSync(link, { force: true })
    } catch {}
  }
}

/** The command as you'd type it: Codex runs each in your login shell (`/bin/zsh -lc "…"`). */
export function unwrapShell(command: string): string {
  const match = command.match(/^\/bin\/(?:zsh|bash|sh) -lc (["'])([\s\S]*)\1$/)
  if (!match) return command
  const inner = match[2]
  return match[1] === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner.replace(/'"'"'/g, "'")
}

/** The first line of a prompt, short enough for a title. */
function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > 80 ? line.slice(0, 79) + "…" : line
}

/**
 * Your message, as Codex takes it: its words, its pictures, and the paths of other files (for a
 * Codex in the box's sandbox, copies where it reads them, for the session's folder: `fencedIn`).
 */
function codexInput(input: { text: string; files: PromptFile[] }, fencedIn?: string): any[] {
  const items: any[] = [{ type: "text", text: input.text, text_elements: [] }]
  const others: string[] = []
  for (const attached of input.files) {
    const file = fencedIn && attached.path ? { ...attached, path: fenceCopy(fencedIn, attached.path) } : attached
    if (file.mime.startsWith("image/") && file.path) items.push({ type: "localImage", path: file.path })
    else if (file.mime.startsWith("image/") && file.data) items.push({ type: "image", url: `data:${file.mime};base64,${file.data}` })
    else if (file.path) others.push(file.path)
  }
  if (others.length) items[0].text += `\n\nAttached files:\n${others.map((path) => `- ${path}`).join("\n")}`
  return items
}

/** A Codex rate-limit snapshot's windows: the plan's (`primary`, `secondary`), or a model's own (`<limit>.primary`, with its name). */
export function codexWindows(snapshot: any): Omit<LimitWindow, "read" | "source">[] {
  if (!snapshot || typeof snapshot !== "object") return []
  const limit = typeof snapshot.limitId === "string" && snapshot.limitId ? snapshot.limitId : "codex"
  const model = limit === "codex" ? undefined : (snapshot.limitName ?? snapshot.normalModelSlug ?? limit)
  return (["primary", "secondary"] as const).flatMap((which) => {
    const window = snapshot[which]
    const used = Number(window?.usedPercent)
    if (!window || !Number.isFinite(used)) return []
    const minutes = Number(window.windowDurationMins)
    const resets = Number(window.resetsAt)
    return [{
      id: limit === "codex" ? which : `${limit}.${which}`,
      used: used / 100,
      ...(Number.isFinite(minutes) && minutes > 0 ? { minutes } : {}),
      ...(Number.isFinite(resets) && resets > 0 ? { resetsAt: resets * 1000 } : {}),
      ...(typeof model === "string" && model ? { model } : {}),
    }]
  })
}

/** "Plus", "Pro": a ChatGPT plan's name, from Codex's word for it. */
export function codexPlan(type: string): string {
  return type.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
}
