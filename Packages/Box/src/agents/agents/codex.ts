// Codex, as T3 Code runs it: your own `codex`, signed in with ChatGPT or an API key (what
// `codex login` keeps), driven through its app-server (JSON-RPC over stdio). One app-server
// serves every Codex session; each session is one of its threads.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { providerID, type AgentAccount } from "../accounts"
import type { Agent, AgentContext, Account, RunInput, RunResult, SignInAttempt, SignInOptions, SubagentRun, Thread, TurnHooks, PromptFile } from "../agent"
import type { Limit } from "../auto"
import { accountName, ContextWindows, failure, model } from "../agent"
import { fileDiff, fromPatch } from "../diff"
import { emit } from "../events"
import { kuvoTools, toolServerName } from "../kuvotools"
import { pictureData, pictureFile, withPictures } from "../pictures"
import { elicitationField } from "../forms"
import { newID } from "../ids"
import { onMachine, ownFoldersConfig } from "../machine"
import { install, maintenance, update, type MaintenanceDefinition } from "../maintenance"
import { which } from "../proc"
import { RPC, RPCError } from "../rpc"
import { engineSkills, skillsFolder, skillsFor, turnedOff, upward, within } from "../skills"
import type { Turn } from "../turn"
import type { FileDiff, FormField, Model, ModelRef, OAuthStatus, Session } from "../wire"

const places = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), join(homedir(), ".codex/bin")]
const outputLimit = 30_000

export class CodexAgent implements Agent {
  id = "codex"
  readonly providerID: string
  get name() {
    return accountName("Codex", this.instance)
  }
  /** OpenAI's installer, as its docs give it (it needs no Node). */
  install = "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
  private server?: RPC

  /** Its app-server while one runs (none is started for this). */
  get running(): RPC | undefined {
    return this.server && !this.server.isClosed ? this.server : undefined
  }
  private starting?: Promise<RPC>
  private threads = new Map<string, CodexThread>()
  /** One-off answers under way (`generate`), by their thread: what each is told. */
  private oneOffs = new Map<string, { rpc: RPC; notify: (method: string, params: any) => void; fail: (error: Error) => void }>()
  private logins = new Map<string, (status: OAuthStatus) => void>()
  private accountCache?: { at: number; account: Account }
  private modelList?: { at: number; models: Model[] }
  /**
   * Each session's folder of Settings › Skills' skills. Codex takes extra skills for its whole
   * app-server, not a thread, so it has all of them (they differ only by a project's own).
   */
  private skillRoots = new Map<string, string>()
  private rootsSet?: { rpc: RPC; key: string }
  /** Your plan's usage windows as Codex last said, by limit ("codex" is the plan's; others, a model's). */
  rateLimits = new Map<string, any>()

  constructor(
    readonly context: AgentContext,
    readonly instance: AgentAccount = { id: "default" },
  ) {
    this.providerID = providerID("codex", instance.id)
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

  /** The app-server still running the old Codex. */
  private outdated?: RPC

  /**
   * The new Codex lists the models and runs the sessions once its app-server starts again: now,
   * or once no turn or sign-in is using the old one (a session goes on with its thread there).
   */
  programUpdated() {
    this.modelList = undefined
    this.accountCache = undefined
    this.outdated = this.server
    // One starting now may be the old program's too.
    void this.starting?.then((rpc) => {
      this.outdated ??= rpc
      this.restartIfQuiet()
    }, () => {})
    this.restartIfQuiet()
  }

  /** Restarts the old app-server when no turn but `starting`'s (not on it yet) and no sign-in uses it. */
  private restartIfQuiet(starting?: CodexThread) {
    const server = this.outdated
    if (!server) return
    if (server.isClosed || this.server !== server) {
      this.outdated = undefined
      return
    }
    if (this.logins.size || this.oneOffs.size || [...this.threads.values()].some((thread) => thread !== starting && (thread.isRunning || thread.keepsWorking))) return
    this.outdated = undefined
    this.shutdown()
    // What the old one listed meanwhile, asked anew.
    this.modelList = undefined
    emit("model.updated", {})
  }

  methods() {
    return [
      { type: "oauth" as const, id: "chatgpt", label: "Sign in with ChatGPT" },
      { type: "key" as const, label: "Use an OpenAI API key" },
    ]
  }

  private lastUse = 0
  private idleCheck?: ReturnType<typeof setInterval>

  /** The app-server, started the first time it's needed and again after it stops. */
  async rpc(starting?: CodexThread): Promise<RPC> {
    this.lastUse = Date.now()
    // Stopped when nothing has used it for a while (no session, no sign-in).
    this.idleCheck ??= setInterval(() => {
      this.restartIfQuiet()
      if (!this.server || this.threads.size || this.logins.size || this.oneOffs.size || Date.now() - this.lastUse < 15 * 60_000) return
      this.shutdown()
    }, 60_000)
    this.restartIfQuiet(starting)
    if (this.server && !this.server.isClosed) return this.server
    this.starting ??= this.start().finally(() => (this.starting = undefined))
    return this.starting
  }

  private async start(): Promise<RPC> {
    const executable = this.executable()
    if (!executable) throw new Error(`Install Codex first: ${this.install}`)
    // An added account's own CODEX_HOME, with your Codex settings in it: only its sign-in is its
    // own. (On a machine, nothing of the machine's own Codex.)
    if (this.instance.home && !onMachine) shadowHome(this.instance.home)
    const rpc = new RPC([executable, "app-server"], { cwd: this.context.temporary, env: this.instance.home ? { CODEX_HOME: this.instance.home } : undefined })
    rpc.onNotification = (method, params) => this.notification(method, params)
    rpc.onRequest = (method, params, id) => this.request(method, params, id)
    rpc.onExit = () => {
      // A title or commit text it was writing won't come.
      for (const oneOff of this.oneOffs.values()) if (oneOff.rpc === rpc) oneOff.fail(new Error("Codex stopped."))
      // Stopped on purpose: the threads were told then (they may be on a newer one by now).
      if (this.server !== rpc) return
      this.server = undefined
      for (const thread of this.threads.values()) thread.serverStopped()
    }
    await rpc.request("initialize", { clientInfo: { name: "kuvo-code", title: "Kuvo Code", version: "1" }, capabilities: { experimentalApi: true, optOutNotificationMethods: ["turn/diff/updated"] } }, 30_000)
    rpc.notify("initialized")
    this.server = rpc
    return rpc
  }

  private notification(method: string, params: any) {
    if (method === "account/login/completed") {
      const done = this.logins.get(params?.loginId)
      if (done) {
        this.logins.delete(params.loginId)
        done(params.success ? { status: "complete" } : { status: "failed", message: params.error ?? "Signing in didn't work." })
      }
      this.accountCache = undefined
      return
    }
    if (method === "account/updated") {
      this.accountCache = undefined
      return
    }
    if (method === "account/rateLimits/updated") {
      const snapshot = params?.rateLimits
      if (snapshot) this.rateLimits.set(snapshot.limitId ?? "codex", snapshot)
      return
    }
    // An agent a session's Codex spawned: its thread says which it came from as it starts.
    if (method === "thread/started") {
      const thread = params?.thread
      const parent = thread?.source?.subAgent?.thread_spawn?.parent_thread_id
      const owner = parent ? this.threadFor(parent) : undefined
      if (owner && thread?.id) {
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
    if (thread) return thread.notification(method, params)
    // Kept a moment, for a spawned agent's thread its spawn hasn't named yet.
    const now = Date.now()
    for (const [id, kept] of this.early) if (now - kept.at > 30_000) this.early.delete(id)
    const kept = this.early.get(threadID) ?? { at: now, events: [] }
    if (kept.events.length < 500) kept.events.push([method, params])
    this.early.set(threadID, kept)
  }

  /** Asks under way, by Codex's request: one it settles itself (`serverRequest/resolved`) is taken back. */
  private asked = new Map<string, AbortController>()

  private async request(method: string, params: any, id?: number | string): Promise<unknown> {
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
      return await thread.request(method, params, controller.signal)
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

  adopt(threadID: string, thread: CodexThread) {
    this.spawned.set(threadID, thread)
    // What its thread said before it was known (it began at once): told now, in order.
    const early = this.early.get(threadID)
    this.early.delete(threadID)
    for (const [method, params] of early?.events ?? []) thread.notification(method, params)
  }

  /** What threads not known yet said, for a little while (a spawned agent's first words can come before its spawn is). */
  private early = new Map<string, { at: number; events: [string, any][] }>()

  async account(fresh = false): Promise<Account> {
    if (!this.executable()) return { installed: false, signedIn: false, message: "Install Codex, then sign in here." }
    if (!fresh && this.accountCache && Date.now() - this.accountCache.at < 30_000) return this.accountCache.account
    const rpc = await this.rpc()
    const result: any = await rpc.request("account/read", {}, 20_000)
    const info = result?.account
    let account: Account
    if (!info) {
      account = { installed: true, signedIn: false, message: "Sign in to Codex with ChatGPT or an OpenAI API key." }
    } else if (info.type === "chatgpt") {
      const plan = info.planType ? `ChatGPT ${String(info.planType).charAt(0).toUpperCase()}${String(info.planType).slice(1)}` : "ChatGPT"
      account = { installed: true, signedIn: true, label: [info.email, plan].filter(Boolean).join(" · ") }
    } else {
      account = { installed: true, signedIn: true, label: info.type === "apiKey" ? "OpenAI API key" : String(info.type) }
    }
    this.accountCache = { at: Date.now(), account }
    return account
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
    this.accountCache = undefined
  }

  async models(): Promise<Model[]> {
    if (this.modelList && Date.now() - this.modelList.at < 30 * 60_000) return this.modelList.models
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
    if (rpc !== this.outdated) this.modelList = { at: Date.now(), models }
    return models
  }

  forgetModels() {
    this.modelList = undefined
  }

  shutdown() {
    const server = this.server
    if (!server) return
    this.server = undefined
    server.kill()
    for (const thread of this.threads.values()) thread.serverStopped()
  }

  /** One answer from Codex on your plan, in a thread kept nowhere, that can only read. */
  async generate(prompt: string, model?: ModelRef): Promise<string> {
    const rpc = await this.rpc()
    // (Its own default model, when none is given; thinking little either way.)
    const started: any = await rpc.request("thread/start", { ephemeral: true, cwd: this.context.temporary, ...(model && model.id !== "default" ? { model: model.id } : {}), approvalPolicy: "never", sandbox: "read-only" }, 60_000)
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
          if (method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") text = params.item.text
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
    return this.instance.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")
  }

  /** A session's skills folder, for its app-server (told again when that started again). */
  async useSkills(sessionID: string, folder: string | undefined, rpc: RPC) {
    if (folder) this.skillRoots.set(sessionID, join(folder, "skills"))
    else this.skillRoots.delete(sessionID)
    const roots = [...new Set(this.skillRoots.values())].sort()
    const key = JSON.stringify(roots)
    if (this.rootsSet?.rpc === rpc && this.rootsSet.key === key) return
    await rpc.request("skills/extraRoots/set", { extraRoots: roots }, 30_000).then(
      () => (this.rootsSet = { rpc, key }),
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
    // The agents it spawned go with it.
    for (const [spawn, owner] of this.spawned) if (owner === thread) this.spawned.delete(spawn)
  }
}

// MARK: A session

/** Where Codex's items are told: the turn's own, or a spawned agent's session. */
interface Lane {
  turn: Turn
  /** Items whose words came as deltas (their completion doesn't add them again). */
  streamed: Set<string>
  /** File changes, by item, for their approval and their result. */
  changes: Map<string, { path: string; kind: string; diff: string }[]>
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
}

/** An agent Codex spawned: its thread's work, told in a session of its own. */
interface SubagentLane extends Lane {
  run: SubagentRun
  /** Its thread, and the turn it's on there (to stop it). */
  threadID: string
  turnID?: string
  /** The spawn call that started it. */
  call: string
  title: string
  ended: boolean
}

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
  /** Auto stopped it at a limit, to go on with the next model. */
  stoppedForLimit?: boolean
  model: string
  problem?: string
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
  /** Where Kuvo Code's tools were when it was loaded. */
  private toolsKey?: string
  private skillsKey?: string
  /** The agents it spawned, by their thread: their sessions, across turns. */
  private spawnedSessions = new Map<string, { call: string; title: string; sessionID: string }>()
  /** Agents it spawned still at work after the turn that spawned them ended, by their thread. */
  private backgroundLanes = new Map<string, SubagentLane>()

  constructor(
    private readonly agent: CodexAgent,
    private readonly session: Session,
    private readonly state: Record<string, unknown>,
  ) {
    this.nativeID = state.codexThread as string | undefined
  }

  /** The app-server stopped: a thread must be loaded again, and a turn under way is over, and the agents it left at work. */
  serverStopped() {
    this.loaded = false
    for (const lane of this.backgroundLanes.values()) this.endSubagent(lane, "interrupted")
    this.backgroundLanes.clear()
    const active = this.active
    if (!active) return
    this.active = undefined
    active.resolve(active.hooks.signal.aborted ? { outcome: "interrupted" } : { outcome: "failed", error: failure(active.problem ?? "Codex stopped.") })
  }

  private policy(hooks: TurnHooks, plan: boolean) {
    if (plan) return { approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: true } }
    if (hooks.approvesAll()) return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
    // Ask First: it asks before any command but a look and before every edit ("untrusted"), and
    // what it runs can write in the project and where Kuvo Code keeps wake-ups (kuvo-wake, whose
    // scheduling your rules allow), as the engine's commands can.
    const writableRoots = [process.env.KUVO_WAKES, process.env.KUVO_BOTS].filter((root): root is string => Boolean(root))
    return { approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", writableRoots, networkAccess: true } }
  }

  private async ensureThread(input: RunInput, hooks: TurnHooks) {
    // A turn starting: on the new Codex, when it was updated.
    const rpc = await this.agent.rpc(this)
    const instructions = hooks.instructions() || null
    // Loaded again with what the app adds to its instructions, when that changed.
    const tools = kuvoTools(this.session.id)
    // Settings › Skills' skills, as extra ones (but those it reads itself), and those of its own
    // you turned off, off for this thread.
    const directory = this.session.location.directory
    const own = this.agent.ownSkillFolders(directory)
    const off = turnedOff(hooks)
    const skills = skillsFolder(await skillsFor(directory, own, off))
    await this.agent.useSkills(this.session.id, skills, rpc)
    const turnedOffHere = (await engineSkills(directory)).filter((skill) => within(skill.folder, own) && off(skill.name)).map((skill) => ({ path: join(skill.folder, "SKILL.md"), enabled: false }))
    const skillsKey = JSON.stringify([skills, turnedOffHere])
    // Loaded again when Kuvo Code's tools moved (the app started again), to reach them, or the
    // skills changed.
    if (this.nativeID && this.loaded && instructions === this.instructions && tools?.key === this.toolsKey && skillsKey === this.skillsKey) return rpc
    this.toolsKey = tools?.key
    this.skillsKey = skillsKey
    this.instructions = instructions
    // Kuvo Code's own tools, as the engine's models have them (a setting for this thread alone).
    const timeout = tools ? { tool_timeout_sec: Math.ceil(tools.timeout / 1000) } : {}
    const server = tools?.kind === "http" ? { url: tools.url, http_headers: tools.headers, ...timeout } : tools?.kind === "stdio" ? { command: tools.command, args: tools.args, env: tools.env, ...timeout } : undefined
    // Its commands know their conversation, as the engine's do (kuvo-wake schedules for it).
    // (On a machine, the machine's own folders too: Codex keeps its own in Kuvo Code's folder.)
    const config = {
      "shell_environment_policy.set.OPENCODE_SESSION_ID": this.session.id,
      ...(onMachine ? ownFoldersConfig() : {}),
      ...(tools && server ? { [`mcp_servers.${tools.name}`]: server } : {}),
      ...(turnedOffHere.length ? { "skills.config": [...this.agent.ownSkillSettings(), ...turnedOffHere] } : {}),
    }
    const common = { cwd: this.session.location.directory, model: input.model.id, developerInstructions: instructions, config }
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
        // Gone (deleted, or another Codex's): a new thread, without what came before.
      }
    }
    const started: any = await rpc.request("thread/start", common, 60_000)
    if (this.nativeID && this.nativeID !== started.thread.id) this.startedOver = true
    this.nativeID = started.thread.id
    this.state.codexThread = this.nativeID
    hooks.saveState()
    this.loaded = true
    return rpc
  }

  get isRunning(): boolean {
    return this.inTurn
  }

  /** Agents it spawned are still at work after the turn: it's kept open for them. */
  get keepsWorking(): boolean {
    // (One the session ended, with the turn that started it, isn't.)
    for (const [threadID, lane] of this.backgroundLanes) if (lane.ended || lane.run.turn.isEnded) this.backgroundLanes.delete(threadID)
    return this.backgroundLanes.size > 0
  }

  /** Your message, into the turn under way (Codex's turn/steer). */
  async steer(input: { id: string; text: string; files: PromptFile[] }): Promise<boolean> {
    const active = this.active
    if (!active?.turnID || !this.nativeID) return false
    const items: any[] = [{ type: "text", text: input.text, text_elements: [] }]
    const others: string[] = []
    for (const file of input.files) {
      if (file.mime.startsWith("image/") && file.path) items.push({ type: "localImage", path: file.path })
      else if (file.mime.startsWith("image/") && file.data) items.push({ type: "image", url: `data:${file.mime};base64,${file.data}` })
      else if (file.path) others.push(file.path)
    }
    if (others.length) items[0].text += `\n\nAttached files:\n${others.map((path) => `- ${path}`).join("\n")}`
    try {
      const rpc = await this.agent.rpc()
      await rpc.request("turn/steer", { threadId: this.nativeID, input: items, expectedTurnId: active.turnID }, 30_000)
      return this.active === active
    } catch {
      return false
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
    try {
      return await this.runTurn(input, turn, hooks)
    } finally {
      this.inTurn = false
    }
  }

  private async runTurn(input: RunInput, turn: Turn, hooks: TurnHooks): Promise<RunResult> {
    const rpc = await this.ensureThread(input, hooks)
    // Stopped while Codex was starting.
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    const items: any[] = [{ type: "text", text: input.text, text_elements: [] }]
    const others: string[] = []
    for (const file of input.files) {
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
      ...this.policy(hooks, input.plan),
      ...(effort ? { effort } : {}),
      collaborationMode: { mode: input.plan ? "plan" : "default", settings: { model: input.model.id, reasoning_effort: effort ?? null, developer_instructions: null } },
    }
    return new Promise<RunResult>((resolve) => {
      const active: Active = { turn, hooks, resolve, streamed: new Set(), changes: new Map(), output: new Map(), toolsSinceText: false, subagents: new Map(), spawning: [], auto: input.auto, model: input.model.id }
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
        resolve(result)
      }
      this.active = active
      turn.startStep()
      rpc.request("turn/start", params, 60_000).then(
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

  notification(method: string, params: any) {
    const active = this.active
    // An agent it spawned: told in its session (one still at work after the turn too).
    if (params?.threadId && this.nativeID && params.threadId !== this.nativeID) return this.subagentNotification(active, params.threadId, method, params)
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
        } else if (active.hooks.signal.aborted || status === "interrupted") active.resolve({ outcome: "interrupted" })
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
        turn.text(params.delta ?? "")
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
  }

  /** What a spawned agent's thread says, in its session. */
  private subagentNotification(active: Active | undefined, threadID: string, method: string, params: any) {
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
    if (!active && !lane) return
    if (!lane) {
      // One spawned in an earlier turn, given more to do (a turn starts on its thread): its
      // session goes on. Anything else from it (closed, its usage) isn't news.
      if (!active || method !== "turn/started") return
      const before = this.spawnedSessions.get(threadID)
      if (!before) return
      const run = active.hooks.subagent(before.call, { title: before.title, sessionID: before.sessionID, background: true })
      run.stop = () => this.stopSubagent(threadID)
      lane = { turn: run.turn, streamed: new Set(), changes: new Map(), output: new Map(), toolsSinceText: false, run, threadID, call: before.call, title: before.title, ended: false }
      active.subagents.set(threadID, lane)
    }
    if (lane.ended) {
      // Given more to do: its session goes on (in a turn of this session's: between turns, it's
      // told when the next one begins).
      if (method !== "turn/started" || !active) return
      lane = this.continueSubagent(active, threadID, lane)
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
    const run = active.hooks.subagent(call, { title, prompt: prompt ?? input.prompt, background: true })
    run.stop = () => this.stopSubagent(threadID)
    const lane: SubagentLane = { turn: run.turn, streamed: new Set(), changes: new Map(), output: new Map(), toolsSinceText: false, run, threadID, call, title, ended: false }
    active.subagents.set(threadID, lane)
    this.spawnedSessions.set(threadID, { call, title, sessionID: run.sessionID })
    // Its approvals come to this session's.
    this.agent.adopt(threadID, this)
    return lane
  }

  private continueSubagent(active: Active, threadID: string, lane: SubagentLane): SubagentLane {
    const run = active.hooks.subagent(lane.call, { title: lane.title, sessionID: lane.run.sessionID, background: true })
    run.stop = () => this.stopSubagent(threadID)
    const next: SubagentLane = { turn: run.turn, streamed: new Set(), changes: new Map(), output: new Map(), toolsSinceText: false, run, threadID, call: lane.call, title: lane.title, ended: false }
    active.subagents.set(threadID, next)
    return next
  }

  /** A spawned agent stopped from Kuvo Code: its turn on its thread is interrupted (it then says so). */
  private async stopSubagent(threadID: string) {
    const lane = this.active?.subagents.get(threadID) ?? this.backgroundLanes.get(threadID)
    if (lane && !lane.ended) await this.interruptLane(threadID, lane, this.agent.running)
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

  private itemStarted(lane: Lane, item: any) {
    const active = lane
    const turn = lane.turn
    switch (item?.type) {
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
        turn.toolStart(item.id, "patch", { files: changes.map((change) => change.path) })
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
        if (!active.streamed.has(item.id) && item.text) {
          this.words(active)
          turn.text(item.text)
        }
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
        turn.notice("Codex summarized the conversation to make room.")
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

  async request(method: string, params: any, signal?: AbortSignal): Promise<unknown> {
    const active = this.active
    // An agent it spawned asks as its own: its asks go on with it, after the turn that spawned it too.
    const lane = params?.threadId && params.threadId !== this.nativeID ? (active?.subagents.get(params.threadId) ?? this.backgroundLanes.get(params.threadId)) : undefined
    if (!active && !lane) {
      if (method === "item/tool/requestUserInput") return { answers: {} }
      if (method === "mcpServer/elicitation/request") return { action: "decline" }
      return method.endsWith("Approval") || method.endsWith("/requestApproval") ? (method.startsWith("item/") ? { decision: "decline" } : { decision: "denied" }) : {}
    }
    const hooks = {
      permission: (ask: Parameters<TurnHooks["permission"]>[0]) => (lane ? lane.run.permission({ ...ask, signal }) : active!.hooks.permission({ ...ask, signal })),
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
          resources: changes.length ? changes.map((change) => change.path) : [params.grantRoot ?? "*"],
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
        const paths = Object.keys(params.fileChanges ?? {})
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
        const answer = await hooks.question({ title: questions.length === 1 ? questions[0].header ?? "Question" : "Questions", fields, toolCallID: params.itemId })
        const answers: Record<string, { answers: string[] }> = {}
        for (const question of questions) {
          const value = answer?.[question.id]
          answers[question.id] = { answers: value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : [String(value)] }
        }
        return { answers }
      }
      case "mcpServer/elicitation/request": {
        // An MCP server asks you something (a form), or to open a page (a sign-in).
        const title = `${params.serverName ?? "A tool"} asks`
        if (params.mode === "url") {
          const answer = await hooks.question({ title, fields: [{ key: "open", title: params.message ?? "Open this page to go on.", type: "external", url: params.url }] })
          return { action: answer ? "accept" : "decline" }
        }
        const schema = params.requestedSchema ?? {}
        const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
        const fields: FormField[] = Object.entries((schema.properties ?? {}) as Record<string, any>).map(([key, field]) => elicitationField(key, field, required.has(key)))
        // Its message goes with the form's first field; a form with no fields is a yes or no.
        if (fields[0] && params.message) fields[0] = { ...fields[0], description: [params.message, fields[0].description].filter(Boolean).join("\n\n") }
        const answer = await hooks.question({ title, fields: fields.length ? fields : [{ key: "ok", title: params.message ?? "Go on?", type: "boolean", required: true }] })
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
    const rpc = await this.agent.rpc().catch(() => undefined)
    if (rpc && active.turnID && this.nativeID) await rpc.request("turn/interrupt", { threadId: this.nativeID, turnId: active.turnID }, 10_000).catch(() => {})
  }

  async interrupt() {
    const active = this.active
    if (!active || !this.nativeID) return
    active.stopping = true
    const rpc = await this.agent.rpc().catch(() => undefined)
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
    this.agent.forget(this.session.id)
    if (this.nativeID && this.loaded) void this.agent.rpc().then((rpc) => rpc.request("thread/unsubscribe", { threadId: this.nativeID }).catch(() => {}), () => {})
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
    "thread/status/changed", "thread/readState/changed", "thread/archived", "thread/unarchived", "thread/deleted", "thread/reverted",
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
function shadowHome(home: string) {
  const own = join(homedir(), ".codex")
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
