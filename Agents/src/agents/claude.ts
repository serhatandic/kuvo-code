// Claude Code, with the Claude Agent SDK, as T3 Code runs it: your own `claude`, signed in with
// your own plan or key (`claude auth login`), one long-lived Claude Code per session fed message
// by message, its replies streamed into the session as the engine's own would be.

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { providerID, type AgentAccount } from "../accounts"
import type { Agent, AgentContext, Account, OwnTurn, RunInput, RunResult, SignInAttempt, SignInOptions, SubagentRun, Thread, TurnHooks, PromptFile } from "../agent"
import type { Limit } from "../auto"
import { accountName, ContextWindows, failure, model } from "../agent"
import { fileDiff, fromPatch } from "../diff"
import { install, maintenance, update, type MaintenanceDefinition } from "../maintenance"
import { emit } from "../events"
import { run, which } from "../proc"
import { Queue } from "../queue"
import { commandSignIn } from "../signin"
import { newID } from "../ids"
import { kuvoTools } from "../kuvotools"
import { skillsFolder, skillsFor, turnedOff, upward } from "../skills"
import { onMachine, ownFoldersScript } from "../machine"
import { addShell, endShell } from "../shells"
import { pictureData, pictureFile, withPictures } from "../pictures"
import type { Turn } from "../turn"
import type { FileDiff, FormField, Model, ModelRef, Session, TokenUsage } from "../wire"

const SDK = [{ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.303" }]
const places = [join(homedir(), ".local/bin"), join(homedir(), ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin"]
/** Kept of a tool's output: enough to read, not a whole file's worth. */
const outputLimit = 30_000

interface Status {
  loggedIn?: boolean
  authMethod?: string
  email?: string
  subscriptionType?: string
  apiProvider?: string
}

export class ClaudeAgent implements Agent {
  id = "claude"
  readonly providerID: string
  get name() {
    return accountName("Claude Code", this.instance)
  }
  /** Anthropic's installer, as its docs give it. */
  install = "curl -fsSL https://claude.ai/install.sh | bash"
  private status?: { at: number; status: Status }
  /**
   * When Claude last turned its sign-in away in a run ("OAuth access token has been revoked"):
   * `claude auth status` still says signed in then. Until Claude Code writes its settings again
   * (as signing in does), the account says it needs a sign-in.
   */
  authFailedAt?: number
  private modelList?: { at: number; models: Model[] }
  private loadingModels?: Promise<void>
  /** Counts updates of Claude Code: a session's Claude Code started before the last one starts again. */
  program = 0

  constructor(
    readonly context: AgentContext,
    readonly instance: AgentAccount = { id: "default" },
  ) {
    this.providerID = providerID("claude", instance.id)
  }

  executable(): string | undefined {
    return which("claude", places)
  }

  /** Its own installer puts it in `~/.local/share/claude` (or `~/.claude/local`): `claude update`. */
  private get definition(): MaintenanceDefinition | undefined {
    const executable = this.executable()
    if (!executable) return undefined
    return {
      name: "Claude Code",
      executable,
      npmPackage: "@anthropic-ai/claude-code",
      nativeUpdate: { args: ["update"], isNative: (path) => /\/\.local\/share\/claude\/|\/\.claude\/local\//.test(path), distTag: updateChannel },
    }
  }

  async maintenance(fresh = false) {
    const definition = this.definition
    return definition ? maintenance(definition, fresh) : {}
  }

  async update() {
    const definition = this.definition
    if (!definition) return { updated: false, message: "Claude Code isn't installed." }
    return update(definition, this.context.temporary)
  }

  /** Its program, with Anthropic's installer. */
  async installProgram() {
    return install("Claude Code", this.install, this.context.temporary, () => this.executable())
  }

  /** Its models asked of the new Claude Code (the old ones listed meanwhile); sessions start it at their next message. */
  programUpdated() {
    this.program++
    if (this.modelList) this.modelList.at = 0
  }

  methods() {
    return [
      { type: "oauth" as const, id: "claudeai", label: "Sign in with your Claude plan" },
      { type: "oauth" as const, id: "console", label: "Sign in with Anthropic Console" },
    ]
  }

  private async readStatus(fresh: boolean): Promise<Status> {
    if (!fresh && this.status && Date.now() - this.status.at < 30_000) return this.status.status
    const executable = this.executable()
    if (!executable) return {}
    const result = await run(executable, ["auth", "status", "--json"], { timeout: 20_000, env: this.env() })
    let status: Status = {}
    try {
      status = JSON.parse(result.stdout)
    } catch {}
    this.status = { at: Date.now(), status }
    return status
  }

  async account(fresh = false): Promise<Account> {
    if (!this.executable()) {
      return { installed: false, signedIn: false, message: "Install Claude Code, then sign in here." }
    }
    const status = await this.readStatus(fresh)
    if (!status.loggedIn) return { installed: true, signedIn: false, message: "Sign in to Claude Code with your Claude plan or an Anthropic Console account." }
    // (The run that was turned away writes them too as it ends: a minute's grace for that.)
    if (this.authFailedAt && this.settingsWritten() <= this.authFailedAt + 60_000) {
      return { installed: true, signedIn: false, ended: true, message: "Claude ended this sign-in. Sign in again." }
    }
    const plan = status.subscriptionType ? `${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)} plan` : undefined
    const who = status.email ?? (status.apiProvider && status.apiProvider !== "firstParty" ? status.apiProvider : undefined)
    return { installed: true, signedIn: true, label: [who, plan].filter(Boolean).join(" · ") || "Claude Code" }
  }

  /** Paid per token (an API key), rather than by a plan. */
  usesKey() {
    const method = this.status?.status.authMethod ?? ""
    return method !== "" && method !== "claude.ai"
  }

  /** When Claude Code last wrote its settings (signing in does). */
  private settingsWritten(): number {
    const folder = this.instance.home ?? homedir()
    try {
      return statSync(join(folder, ".claude.json")).mtimeMs
    } catch {
      return 0
    }
  }

  /** Its page can end on a code to paste back, wherever it's opened. */
  readonly signsInRemotely = true

  async signIn(methodID: string, options: SignInOptions = {}): Promise<SignInAttempt> {
    const executable = this.executable()
    if (!executable) throw new Error(`Install Claude Code first: ${this.install}`)
    return commandSignIn({
      command: executable,
      args: ["auth", "login", methodID === "console" ? "--console" : "--claudeai"],
      env: this.env(),
      home: this.context.home,
      temporary: this.context.temporary,
      instructions: "Finish signing in on Claude's page. Claude Code keeps the sign-in, as when you run claude auth login.",
      // Claude Code's word: a sign-in Claude ended still reads as signed in there, so signing in
      // again counts once the command says it worked (another Claude Code writing its settings
      // meanwhile isn't it).
      signedIn: async () => Boolean((await this.readStatus(true)).loggedIn),
      codePrompt: /Paste code here if prompted >\s*/g,
      onComplete: () => (this.authFailedAt = undefined),
      // On another device: the page it prints, which ends on a code to paste here.
      printedPage: options.remote,
    })
  }

  async sdk(): Promise<typeof import("@anthropic-ai/claude-agent-sdk")> {
    // Without its own copy of Claude Code: it runs yours.
    await this.context.deps.ensure(this.id, SDK, { optional: false })
    return this.context.deps.load(this.id, SDK[0].name)
  }

  /** Where Claude Code reads skills itself: its settings folder's, and a project's `.claude/skills`. */
  ownSkillFolders(directory: string): string[] {
    const settings = this.instance.home ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    return [join(settings, "skills"), ...upward(directory).map((folder) => join(folder, ".claude", "skills"))]
  }

  /** Claude Code's environment: an added account's own folder (Claude Code keeps its sign-in in the Keychain, named after it). */
  env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_TMPDIR: join(this.context.temporary, "claude") }
    if (this.instance.home) env.CLAUDE_CONFIG_DIR = this.instance.home
    // On a machine, its commands get the machine's own folders back (it keeps its own in Kuvo
    // Code's folder).
    const own = onMachine ? ownFoldersScript(this.context.home) : undefined
    if (own) env.CLAUDE_ENV_FILE = own
    return env
  }

  /** An added account signs out as it goes (its Keychain item with it). */
  async removeAccount() {
    const executable = this.executable()
    if (executable && this.instance.home) await run(executable, ["auth", "logout"], { timeout: 20_000, env: this.env() }).catch(() => {})
  }

  async models(): Promise<Model[]> {
    if (this.modelList && Date.now() - this.modelList.at < 30 * 60_000) return this.modelList.models
    // Claude Code says which models your account has once it starts: asked in the background, the
    // first time with Claude Code's usual ones meanwhile.
    this.loadingModels ??= this.loadModels().finally(() => (this.loadingModels = undefined))
    return this.modelList?.models ?? fallbackModels(this.providerID)
  }

  private async loadModels() {
    const sdk = await this.sdk()
    const abort = new AbortController()
    const idle = (async function* () {
      await new Promise((resolve) => abort.signal.addEventListener("abort", resolve))
    })()
    const q = sdk.query({
      prompt: idle as AsyncIterable<any>,
      options: {
        pathToClaudeCodeExecutable: this.executable(),
        cwd: this.context.temporary,
        persistSession: false,
        abortController: abort,
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settings: { disableAllHooks: true } as any,
        env: this.env(),
        stderr: () => {},
      },
    })
    try {
      const init: any = await Promise.race([q.initializationResult(), Bun.sleep(30_000).then(() => undefined)])
      const list = (init?.models ?? []) as ClaudeModelInfo[]
      if (list.length) {
        this.listModels(list)
        // How much each holds, which its descriptions don't say (it depends on your plan): asked
        // one by one, then listed again.
        if (await this.askWindows(q, list)) this.listModels(list)
      }
    } finally {
      abort.abort()
    }
  }

  /** How much each model holds, as Claude Code said: by its value. */
  private windows = new ContextWindows()

  private listModels(list: ClaudeModelInfo[]) {
    this.modelList = {
      at: Date.now(),
      models: list.map((info, index) =>
        model(this.providerID, info.value, modelName(info), {
          family: family(modelName(info)),
          variants: info.supportedEffortLevels,
          images: true,
          context: this.windows.get(info.value) ?? (/1M/i.test(info.description ?? "") ? 1_000_000 : 200_000),
          // Listed in Claude Code's order: the first is its default.
          released: Date.now() - index,
        }),
      ),
    }
    emit("model.updated", {})
  }

  /** Each model's window, as Claude Code's /context says it, once a model (its aliases share it); true when one changed. An older Claude Code that doesn't say leaves them as they were. */
  private async askWindows(q: any, list: ClaudeModelInfo[]): Promise<boolean> {
    const said = new Map<string, number>()
    let changed = false
    for (const info of list) {
      const key = info.resolvedModel ?? info.value
      let window = said.get(key)
      if (window === undefined) {
        try {
          await withTimeout(q.setModel(info.value), 5_000)
          window = (await withTimeout(q.getContextUsage({ detail: "summary" }), 5_000) as any)?.maxTokens
        } catch {
          return changed
        }
        if (typeof window !== "number" || window <= 0) return changed
        said.set(key, window)
      }
      if (this.windows.note(info.value, window)) changed = true
    }
    return changed
  }

  forgetModels() {
    this.modelList = undefined
  }

  thread(session: Session, state: Record<string, unknown>): Thread {
    return new ClaudeThread(this, session, state)
  }

  /** One answer from Claude Code on your plan: no tools, no hooks, nothing saved to its history. */
  async generate(prompt: string, model?: ModelRef): Promise<string> {
    const sdk = await this.sdk()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 120_000)
    const q = sdk.query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: this.executable(),
        cwd: this.context.temporary,
        // (A quick one of its own, when none is given.)
        model: !model ? "haiku" : model.id === "default" ? undefined : model.id,
        persistSession: false,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settings: { disableAllHooks: true } as any,
        abortController: abort,
        env: this.env(),
        stderr: () => {},
      },
    })
    try {
      for await (const message of q as AsyncIterable<any>) {
        if (message.type !== "result") continue
        if (message.subtype === "success" && !message.is_error && typeof message.result === "string") return message.result.trim()
        throw new Error(typeof message.result === "string" && message.result.trim() ? message.result.trim() : "Claude Code couldn't answer.")
      }
      throw new Error("Claude Code stopped before it answered.")
    } finally {
      clearTimeout(timer)
      try {
        ;(q as any).close?.()
      } catch {}
    }
  }
}

/** A model as Claude Code lists it. */
interface ClaudeModelInfo {
  value: string
  /** The model an alias ("default", "opus") stands for now. */
  resolvedModel?: string
  displayName: string
  description?: string
  supportedEffortLevels?: string[]
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([promise, Bun.sleep(milliseconds).then(() => Promise.reject(new Error("Claude Code didn't answer in time.")))])
}

function modelName(info: { value: string; displayName: string; description?: string }): string {
  // "Default (recommended)" says less than what it is: "Opus 4.8 with 1M context · Most capable…".
  const what = info.description?.split(" · ")[0]?.trim()
  if (what && /^(opus|sonnet|haiku|fable|claude)/i.test(what)) return what
  return info.displayName
}

/** Its family, for its maker's mark and so each shows in the short list: "claude-opus". */
function family(name: string): string {
  return "claude-" + (name.split(/\s+/)[0] ?? "").toLowerCase()
}

/** The channel `claude update` follows (`autoUpdatesChannel` in your settings), as npm names it. */
function updateChannel(): string {
  try {
    const folder = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    const settings = JSON.parse(readFileSync(join(folder, "settings.json"), "utf8"))
    return settings?.autoUpdatesChannel === "stable" ? "stable" : "latest"
  } catch {
    return "latest"
  }
}

function fallbackModels(providerID: string): Model[] {
  return [
    model(providerID, "default", "Claude Code's default", { family: "claude-default", images: true, variants: ["low", "medium", "high", "xhigh", "max"], released: 3 }),
    model(providerID, "sonnet", "Sonnet", { family: "claude-sonnet", images: true, variants: ["low", "medium", "high", "max"], released: 2 }),
    model(providerID, "haiku", "Haiku", { family: "claude-haiku", images: true, released: 1 }),
  ]
}

// MARK: A session

/** Where Claude's messages are told: the turn's own, or a subagent's session. */
interface Lane {
  turn: Turn
  /** Steps (Claude's messages) already told as they streamed. */
  streamed: Set<string>
  /** The streamed message's tool calls, by their block's index. */
  blockTools: Map<number, string>
  /** Each tool call's Claude name and input, for its result. */
  calls: Map<string, { name: string; input: Record<string, any> }>
  usage?: TokenUsage
  stopReason?: string
}

interface Active extends Lane {
  hooks: TurnHooks
  resolve: (result: RunResult) => void
  /** Its subagents (Task and Agent calls), each told in a session of its own, by their call. */
  subagents: Map<string, Lane & { run: SubagentRun; background: boolean }>
  /** Why the turn will fail, if Claude Code says before its result. */
  problem?: string
  /** A usage limit it reached (Auto goes on with the next model). */
  limit?: Limit
  /** On Auto: a limit ends the turn rather than being waited out. */
  auto?: boolean
  /** You pressed Stop. */
  stopping?: boolean
  /**
   * Messages sent to it this turn, not taken yet: Claude Code's id for each, and the session's
   * (none for the one that started the turn).
   */
  steered: Map<string, string>
  /** Claude Code ended its turn before taking one of those: it goes on with them, and this waits. */
  goingOn?: ReturnType<typeof setTimeout>
}

/** How long a turn kept open for a message sent after its result waits for Claude Code to take it. */
const goingOnLimit = 60_000

class ClaudeThread implements Thread {
  /** Its subagents' sessions, by the call that started each: one at work after its turn goes on there. */
  private subagentSessions = new Map<string, { sessionID: string; title: string }>()
  private query?: any
  private input?: Queue<any>
  private active?: Active
  /** The last turn's hooks: its rules still hold for a subagent at work after it. */
  private lastHooks?: TurnHooks
  /** Notes given once (a warning, a retry, something it sent this bridge doesn't know). */
  private noticed = new Set<string>()
  onOwnTurn?: (note: OwnTurn) => boolean
  /**
   * A turn Claude Code began on its own between ours (a command it left running ended, and it
   * carries on): what it said so far, until a turn here takes it; or turned away.
   */
  private own?: { frames: any[]; turnedAway: boolean; taken?: Promise<void>; take?: () => void }
  /** Subagents it sent off in the background, at work after the turn that started them: by their call. */
  private backgroundLanes = new Map<string, Lane & { run: SubagentRun; background: boolean }>()
  /** Its background tasks (commands, subagents), by its id: commands are in the bar. */
  private tasks = new Map<string, { type: string; description: string; toolUseID?: string; shell?: string; outputFile?: string; last?: { output: string; total: number } }>()
  /** Its live background tasks, as it last listed them. */
  private liveTasks = new Set<string>()
  /** Commands it ran, by their call: what a background one runs. */
  private commands = new Map<string, string>()
  /** The last of its tasks to end: what began a turn it starts on its own. */
  private lastEnded?: { type: string; description: string; command?: string; status: string; summary?: string }
  private opened?: { model: string; effort?: string; plan: boolean; append: string; program: number; tools?: string; skills?: string }

  constructor(
    private readonly agent: ClaudeAgent,
    private readonly session: Session,
    private readonly state: Record<string, unknown>,
  ) {}

  async run(input: RunInput, turn: Turn, hooks: TurnHooks): Promise<RunResult> {
    if (input.adopt) return this.adopt(input, turn, hooks)
    // One it began on its own and nobody took: what's left of it goes into this turn.
    const own = this.own
    this.own = undefined
    own?.take?.()
    const sdk = await this.agent.sdk()
    // Stopped while its SDK was coming.
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    const modelID = input.model.id
    const effort = input.model.variant
    const append = hooks.instructions()
    // What the app adds to its instructions changed (a worktree, the project's folders), or Claude
    // Code was updated: it starts again, going on with the same conversation.
    const tools = kuvoTools(this.session.id)
    // Settings › Skills' skills, as a plugin of its own (but those it reads itself).
    const skills = skillsFolder(await skillsFor(this.session.location.directory, this.agent.ownSkillFolders(this.session.location.directory), turnedOff(hooks)))
    if (this.query && (this.opened?.append !== append || this.opened?.program !== this.agent.program || this.opened?.tools !== tools?.key || this.opened?.skills !== skills)) this.close()
    if (!this.query) {
      this.open(sdk, modelID, effort, input.plan, append, hooks, skills)
      // Kuvo Code's own tools, as the engine's models have them: told over its pipe, not on its
      // command line (where any process could read their key).
      if (tools) {
        const entry = tools.kind === "http" ? { type: "http" as const, url: tools.url, headers: tools.headers, timeout: tools.timeout } : { type: "stdio" as const, command: tools.command, args: tools.args, env: tools.env, timeout: tools.timeout }
        await this.query?.setMcpServers({ [tools.name]: entry }).catch(() => {})
      }
    } else {
      // The same Claude Code goes on, told what changed.
      if (this.opened?.model !== modelID) await this.query.setModel(modelID === "default" ? undefined : modelID).catch(() => {})
      if (this.opened?.effort !== effort) await this.query.applyFlagSettings({ effortLevel: effort ?? null }).catch(() => {})
      if (this.opened?.plan !== input.plan) await this.query.setPermissionMode(input.plan ? "plan" : "default").catch(() => {})
      this.opened = { model: modelID, effort, plan: input.plan, append, program: this.agent.program, tools: tools?.key, skills }
    }
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    return new Promise<RunResult>((resolve) => {
      this.lastHooks = hooks
      const message = userMessage(input)
      // The turn ends with the result that answers it (one of its own before, like a command's
      // end it took up, doesn't end it).
      this.active = this.turnFor(turn, hooks, resolve, input.auto, new Map([[message.uuid, ""]]))
      this.input!.push(message)
    })
  }

  /** A turn here; as it ends, its subagents in the background are kept, to go on in their sessions. */
  private turnFor(turn: Turn, hooks: TurnHooks, resolve: (result: RunResult) => void, auto: boolean | undefined, steered: Map<string, string>): Active {
    const active: Active = { turn, hooks, resolve, streamed: new Set(), blockTools: new Map(), calls: new Map(), subagents: new Map(), auto, steered }
    active.resolve = (result) => {
      // (A turn stopped or failed stops them: the session ends them with it.)
      if (result.outcome === "succeeded") for (const [callID, lane] of active.subagents) if (lane.background && !lane.turn.isEnded) this.backgroundLanes.set(callID, lane)
      resolve(result)
    }
    return active
  }

  /** A turn it began on its own: taken here, with what it said so far. */
  private adopt(input: RunInput, turn: Turn, hooks: TurnHooks): Promise<RunResult> {
    const own = this.own
    this.own = undefined
    own?.take?.()
    // Gone meanwhile (closed, or the turn already over and turned away): nothing to take.
    if (!this.query || !own || own.turnedAway) return Promise.resolve({ outcome: "succeeded" })
    return new Promise<RunResult>((resolve) => {
      this.lastHooks = hooks
      this.active = this.turnFor(turn, hooks, resolve, input.auto, new Map())
      let at = 0
      for (; at < own.frames.length && this.active; at++) this.handle(own.frames[at])
      // What it said after that turn's end: another of its own, waiting to be taken as this one
      // ends here (its tools wait for that too).
      for (const frame of own.frames.slice(at)) this.handle(frame)
    })
  }

  /**
   * Something it said with no turn here: the start of one it began on its own (its main
   * conversation, not a subagent's) asks the session to take it, and what follows waits for that.
   */
  private ownFrame(message: any) {
    const known = this.own
    if (known) {
      if (!known.turnedAway) known.frames.push(message)
      else if (message.type === "result") this.own = undefined
      return
    }
    const begins = !message.parent_tool_use_id && (message.type === "stream_event" || message.type === "assistant")
    if (!begins) return
    let take!: () => void
    const taken = new Promise<void>((resolve) => (take = resolve))
    const own: NonNullable<ClaudeThread["own"]> = { frames: [message], turnedAway: false, taken, take }
    this.own = own
    // Taken now (what's here is told to the turn at once) or once nothing else runs; or turned away.
    if (!(this.onOwnTurn?.(this.ownNote()) ?? false)) this.turnAway()
  }

  /** A turn it began on its own that isn't taken: it stops (nothing would show what it does). */
  turnAway() {
    const own = this.own
    if (!own || own.turnedAway) return
    own.take?.()
    // Over already: nothing to stop, and what it says next begins another.
    if (own.frames.some((frame) => frame.type === "result" && !frame.parent_tool_use_id)) {
      this.own = undefined
      return
    }
    own.turnedAway = true
    void this.query?.interrupt().catch(() => {})
  }

  /** What began a turn it started on its own, as the conversation says it. */
  private ownNote(): OwnTurn {
    const ended = this.lastEnded
    this.lastEnded = undefined
    if (ended?.type === "local_bash") {
      const exit = /exit code (\d+)/i.exec(ended.summary ?? "")?.[1]
      const metadata: Record<string, unknown> = { source: "shell", state: ended.status === "completed" ? "completed" : "error" }
      if (exit !== undefined) metadata.exit = Number(exit)
      if (ended.status === "stopped") metadata.signal = "SIGTERM"
      return { text: `A command left running in the background ${ended.status === "completed" ? "finished" : ended.status}.`, description: ended.command ?? ended.description, metadata }
    }
    if (ended) return { text: `A task it had going ${ended.status === "completed" ? "finished" : ended.status}.`, description: `${ended.status === "completed" ? "Finished" : "Ended"}: ${ended.description}` }
    return { text: "Claude Code carried on by itself." }
  }

  /** Its background tasks: commands go in the bar while they run; what ends last is noted. */
  private noteTask(message: any) {
    switch (message.subtype) {
      case "task_started": {
        const known = this.tasks.get(message.task_id)
        this.tasks.set(message.task_id, { ...known, type: message.task_type ?? known?.type ?? "", description: message.description ?? known?.description ?? "", toolUseID: message.tool_use_id ?? known?.toolUseID })
        if (message.is_backgrounded && !message.ambient) this.shellFor(message.task_id)
        return
      }
      case "task_updated":
        if (message.patch?.is_backgrounded) this.shellFor(message.task_id)
        return
      case "task_notification": {
        const task = this.tasks.get(message.task_id)
        if (task && typeof message.output_file === "string") task.outputFile = message.output_file
        const command = task?.toolUseID ? this.commands.get(task.toolUseID) : undefined
        this.lastEnded = { type: task?.type ?? "", description: task?.description ?? String(message.summary ?? ""), command, status: String(message.status ?? "completed"), summary: message.summary }
        if (task?.shell) endShell(task.shell, message.status === "completed" ? 0 : undefined)
        // A subagent in the background done: its session's work ends.
        const callID = typeof message.tool_use_id === "string" ? message.tool_use_id : task?.toolUseID
        const lane = callID ? (this.keptLane(callID) ?? this.active?.subagents.get(callID)) : undefined
        if (callID && lane?.background) {
          const status = String(message.status ?? "completed")
          if (status === "completed") lane.run.end("succeeded")
          else if (status === "failed") lane.run.end("failed", { type: "agent", message: String(message.summary ?? "The subagent failed.") })
          else lane.run.end("interrupted")
          this.backgroundLanes.delete(callID)
          this.active?.subagents.delete(callID)
        }
        return
      }
      case "background_tasks_changed": {
        const tasks = (Array.isArray(message.tasks) ? message.tasks : []).filter((task: any) => !task?.ambient)
        this.liveTasks = new Set(tasks.map((task: any) => String(task.task_id)))
        for (const task of tasks) {
          const known = this.tasks.get(task.task_id)
          this.tasks.set(task.task_id, { ...known, type: task.task_type ?? known?.type ?? "", description: task.description ?? known?.description ?? "" })
          this.shellFor(task.task_id)
        }
        for (const [id, task] of this.tasks) if (task.shell && !this.liveTasks.has(id)) endShell(task.shell)
        return
      }
    }
  }

  /** A command it left running, in the bar. */
  private shellFor(taskID: string) {
    const task = this.tasks.get(taskID)
    if (!task || task.shell || task.type !== "local_bash") return
    const command = (task.toolUseID ? this.commands.get(task.toolUseID) : undefined) ?? task.description
    task.shell = addShell(
      this.session.id,
      this.session.location.directory,
      command,
      () => this.taskOutput(taskID),
      async () => {
        const shell = this.tasks.get(taskID)?.shell
        const query = this.query
        // Claude Code is gone, and the command with it.
        if (!query?.stopTask) return void (shell && endShell(shell))
        await query.stopTask(taskID).catch(() => {
          if (shell && !this.liveTasks.has(taskID)) endShell(shell)
        })
      },
    )
  }

  /** The end of what a command printed: as Claude Code reads it, or from its file once it's gone. */
  private async taskOutput(taskID: string): Promise<{ output: string; total: number }> {
    const task = this.tasks.get(taskID)
    try {
      if (this.query?.getTaskOutput) {
        const read = await this.query.getTaskOutput(taskID)
        const last = { output: String(read?.output ?? ""), total: Number(read?.total_bytes ?? 0) }
        if (task) task.last = last
        return last
      }
    } catch {}
    if (task?.outputFile) {
      try {
        const bytes = readFileSync(task.outputFile)
        return { output: bytes.subarray(Math.max(0, bytes.length - 64_000)).toString("utf8"), total: bytes.length }
      } catch {}
    }
    return task?.last ?? { output: "", total: 0 }
  }

  /** Commands or subagents it left going: closing it would end them. */
  get keepsWorking(): boolean {
    return Boolean(this.query) && this.liveTasks.size > 0
  }

  private open(sdk: any, modelID: string, effort: string | undefined, plan: boolean, append: string, hooks: TurnHooks, skills?: string) {
    let id = this.state.claudeSession as string | undefined
    const resume = Boolean(id && this.state.claudeStarted)
    if (!id) {
      id = randomUUID()
      this.state.claudeSession = id
      hooks.saveState()
    }
    // A new conversation counts its cost from nothing.
    if (!resume) delete this.state.claudeCost
    this.input = new Queue()
    const tools = kuvoTools(this.session.id)
    this.opened = { model: modelID, effort, plan, append, program: this.agent.program, tools: tools?.key, skills }
    this.query = sdk.query({
      prompt: this.input,
      options: {
        pathToClaudeCodeExecutable: this.agent.executable(),
        cwd: this.session.location.directory,
        model: modelID === "default" ? undefined : modelID,
        effort,
        includePartialMessages: true,
        // Its subagents' words and thinking too, for their sessions (by default only their tools).
        forwardSubagentText: true,
        permissionMode: plan ? "plan" : "default",
        canUseTool: (name: string, input: Record<string, unknown>, options: any) => this.canUseTool(name, input, options),
        // Before any tool runs, even one Claude Code's own settings allow (yours, or a project's).
        hooks: { PreToolUse: [{ hooks: [async (hookInput: any) => this.preToolUse(hookInput)] }] },
        systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
        ...(skills ? { plugins: [{ type: "local" as const, path: skills, skipMcpDiscovery: true }] } : {}),
        ...(resume ? { resume: id } : { sessionId: id }),
        // Its commands know their conversation, as the engine's do (kuvo-wake schedules for it).
        env: { ...this.agent.env(), OPENCODE_SESSION_ID: this.session.id },
        stderr: () => {},
      },
    })
    void this.read(this.query)
  }

  private async read(query: any) {
    let ended: unknown
    try {
      for await (const message of query) this.handle(message)
    } catch (error) {
      ended = error
    }
    if (this.query === query) {
      this.query = undefined
      this.input = undefined
      // Claude Code stopped (or crashed): what it left running went with it.
      this.leftRunning()
    }
    // Ended under a turn of this Claude Code (not one started since on a new one).
    const active = this.active
    if (!active || this.query) return
    this.active = undefined
    clearTimeout(active.goingOn)
    const missed = this.unseen(active)
    const resolve = active.resolve
    active.resolve = (value) => resolve(missed ? { ...value, missed } : value)
    if (active.stopping || active.hooks.signal.aborted) active.resolve({ outcome: "interrupted" })
    else if (active.limit) active.resolve({ outcome: "failed", error: { type: "limit", message: active.problem ?? "You've reached a Claude usage limit." }, limit: active.limit })
    else active.resolve({ outcome: "failed", error: failure(active.problem ?? ended ?? "Claude Code stopped.") })
  }

  private handle(message: any) {
    if (message.type === "system" && message.subtype === "init") {
      if (!this.state.claudeStarted || this.state.claudeSession !== message.session_id) {
        this.state.claudeSession = message.session_id
        this.state.claudeStarted = true
        this.active?.hooks.saveState()
      }
      return
    }
    if (message.type === "system") this.noteTask(message)
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      for (const block of message.message?.content ?? []) if (block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") this.commands.set(block.id, block.input.command)
      if (this.commands.size > 200) for (const key of [...this.commands.keys()].slice(0, 100)) this.commands.delete(key)
    }
    const active = this.active
    if (!active) {
      // A subagent at work in the background, after its turn: told in its session.
      const background = message.parent_tool_use_id ? this.keptLane(message.parent_tool_use_id) : undefined
      if (background) return this.laneFrame(undefined, background, message)
      return this.ownFrame(message)
    }
    if (!message.parent_tool_use_id && Array.isArray(message.user_message_uuids)) for (const uuid of message.user_message_uuids) active.steered.delete(uuid)
    // Waiting for it to take a message it was sent after its result: it's still there while it
    // says something, and once it has taken them all, its next result ends the turn.
    if (active.goingOn) {
      clearTimeout(active.goingOn)
      active.goingOn = active.steered.size ? setTimeout(() => this.wentQuiet(active), goingOnLimit) : undefined
    }
    // A subagent's own work is told in its session, as the engine's subagents' is.
    const lane: Lane | undefined = message.parent_tool_use_id ? this.subagentLane(active, message.parent_tool_use_id) : active
    if (!lane) return
    this.laneFrame(active, lane, message)
  }

  /** What Claude Code said, in a lane: the turn's own, or a subagent's (between turns, `active` is none). */
  private laneFrame(active: Active | undefined, lane: Lane, message: any) {
    const turn = lane.turn
    switch (message.type) {
      case "stream_event":
        return this.stream(lane, message.event)
      case "assistant": {
        const content = message.message?.content ?? []
        const id = message.message?.id
        const error = message.error ?? message.message?.error
        if (error === "authentication_failed") {
          this.agent.authFailedAt = Date.now()
          if (active) active.problem = "Claude Code isn't signed in. Sign in again in Settings › Accounts."
        } else if (typeof error === "string" && active && lane === active) active.problem ??= apiErrorWords(error)
        for (const block of content) {
          if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
            const name = block.type === "mcp_tool_use" ? `mcp__${block.server_name ?? "mcp"}__${block.name}` : block.name
            lane.calls.set(block.id, { name, input: block.input ?? {} })
            const tool = kuvoTool(name, block.input ?? {})
            if (!turn.hasTool(block.id)) turn.toolStart(block.id, tool.name)
            turn.toolCalled(block.id, tool.input)
            // A subagent of the turn's own: its session, from now.
            if (active && lane === active && tool.name === "subagent") this.subagentLane(active, block.id)
          } else if (typeof block.type === "string" && block.type.endsWith("_tool_result")) {
            // What a tool the API ran itself (a web search, code it ran) came back with.
            this.serverResult(turn, block)
          } else if (!id || !lane.streamed.has(id)) {
            // Not streamed (it came whole): told now.
            if (block.type === "text" && block.text) turn.text(block.text)
            else if (block.type === "thinking" && block.thinking) turn.reasoning(block.thinking)
            else if (block.type === "redacted_thinking") turn.reasoning("(The model kept this thinking to itself.)")
            else if (block.type === "compaction") this.noticeLater(lane, "Claude summarized the conversation to make room.")
          }
        }
        if (id && !lane.streamed.has(id)) turn.endBlock()
        return
      }
      case "user": {
        const content = Array.isArray(message.message?.content) ? message.message.content : []
        const results = content.filter((block: any) => block.type === "tool_result")
        for (const block of results) this.result(active, lane, block, results.length === 1 ? message.tool_use_result : undefined)
        return
      }
      case "rate_limit_event": {
        if (!active || lane !== active) return
        const info = message.rate_limit_info ?? {}
        // Close to a limit: said once, so the stop doesn't come out of nowhere.
        if (info.status === "allowed_warning") {
          const used = typeof info.utilization === "number" ? ` (${Math.round(info.utilization * 100)}% used)` : ""
          this.noticeOnce(`warn:${info.rateLimitType}:${info.surpassedThreshold ?? ""}`, turn, `You're close to ${limitWords(info.rateLimitType).replace(/^You've reached /, "").replace(/\.$/, "")}${used}.`)
          return
        }
        // Over the plan's limit, unless extra usage you pay for carries on.
        if (info.status !== "rejected" || info.overageInUse || info.isUsingOverage) return
        const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : undefined
        const oneModel = info.rateLimitType === "seven_day_opus" || info.rateLimitType === "seven_day_sonnet"
        active.limit = { scope: oneModel ? "model" : "provider", resetsAt, message: limitWords(info.rateLimitType) }
        active.problem = limitWords(info.rateLimitType)
        if (active.auto) void this.query?.interrupt().catch(() => {})
        return
      }
      case "system":
        // Waiting out a rate limit to try again: on Auto, the next model goes on instead.
        if (active && lane === active && message.subtype === "api_retry" && (message.error === "rate_limit" || message.error === "billing_error") && active.auto) {
          active.limit ??= message.error === "billing_error" ? { scope: "provider" } : { scope: "model", brief: true }
          active.problem ??= "Claude's API is rate limiting this model."
          void this.query?.interrupt().catch(() => {})
          return
        }
        return this.systemFrame(active, lane, message)
      case "conversation_reset":
        delete this.state.claudeCost
        turn.notice("Claude Code started its conversation over.")
        return
      case "auth_status":
        if (message.error && active) active.problem = String(message.error)
        else if (Array.isArray(message.output) && message.output.length) turn.notice(message.output.join("\n"))
        return
      case "result":
        if (!active || lane !== active) return
        return this.finish(active, message)
      default:
        if (!claudeMessages.has(message.type)) this.unknownFrame(turn, String(message.type), message)
    }
  }

  /** What Claude Code says about itself (compacting, retrying, your hooks, notes for you). */
  private systemFrame(active: Active | undefined, lane: Lane, message: any) {
    const turn = lane.turn
    switch (message.subtype) {
      case "task_progress":
        // A subagent's or command's progress, on its row.
        if (typeof message.tool_use_id === "string" && (message.summary || message.description)) turn.toolProgress(message.tool_use_id, { summary: message.summary ?? message.description, lastTool: message.last_tool_name })
        return
      case "compact_boundary":
        this.noticeLater(lane, "Claude Code summarized the conversation to make room.")
        return
      case "status":
        if (message.compact_result === "failed") turn.notice(`Claude Code couldn't summarize the conversation${message.compact_error ? `: ${message.compact_error}` : ""}.`)
        return
      case "api_retry":
        // The API is busy or a request failed: it tries again (said once a step).
        this.noticeOnce(`retry:${lane.turn.currentModel.id}`, turn, `Claude's API ${message.error === "overloaded" || message.error_status === 529 ? "is overloaded" : "had a problem"}: trying again${message.max_retries ? ` (${message.attempt}/${message.max_retries})` : ""}.`)
        return
      case "local_command_output":
        // What a command you typed for Claude Code itself printed (/cost, /usage).
        if (typeof message.content === "string" && message.content.trim()) {
          turn.text(message.content)
          turn.endBlock()
        }
        return
      case "informational":
        if (message.level !== "info" && typeof message.content === "string") turn.notice(message.content)
        return
      case "notification":
        if (message.priority !== "low" && typeof message.text === "string") turn.notice(message.text)
        return
      case "model_refusal_fallback":
      case "model_refusal_no_fallback":
        if (typeof message.content === "string") turn.notice(message.content)
        return
      case "plugin_install":
        if (message.status === "failed") turn.notice(`A Claude Code plugin didn't install${message.name ? ` (${message.name})` : ""}${message.error ? `: ${message.error}` : ""}.`)
        return
      case "hook_response":
        if (message.outcome === "error" || message.exit_code) turn.notice(`Your ${message.hook_name ?? message.hook_event ?? ""} hook failed${message.stderr ? `: ${String(message.stderr).trim()}` : ""}.`)
        return
      case "memory_recall": {
        const id = newID("call")
        turn.toolStart(id, "memory", { description: "Recalled from memory" })
        const paths = Array.isArray(message.paths) ? message.paths.join("\n") : ""
        turn.toolSucceeded(id, paths || (typeof message.content === "string" ? message.content : ""))
        return
      }
    }
    if (!claudeSystem.has(message.subtype)) this.unknownFrame(turn, `system:${message.subtype}`, message)
  }

  /** A note now, or after the words being written (a notice ends the step under way). */
  private noticeLater(lane: Lane, text: string) {
    lane.turn.notice(text)
  }

  /** A note, once per kind for this Claude Code. */
  private noticeOnce(key: string, turn: Turn, text: string) {
    if (this.noticed.has(key)) return
    this.noticed.add(key)
    turn.notice(text)
  }

  /** Something Claude Code sent that this bridge doesn't know (a newer one's): its words shown, and logged. */
  private unknownFrame(turn: Turn, key: string, message: any) {
    const words = ["content", "text", "message", "summary"].map((field) => message?.[field]).find((value) => typeof value === "string" && value.trim())
    if (words) this.noticeOnce(`unknown:${key}:${words}`, turn, words)
    if (!this.noticed.has(`log:${key}`)) {
      this.noticed.add(`log:${key}`)
      console.error(`Claude Code sent ${key}, which Kuvo Code doesn't know: ${JSON.stringify(message).slice(0, 300)}`)
    }
  }

  /** A server tool's result block (web search, web fetch, code execution, an MCP call the API made). */
  private serverResult(turn: Turn, block: any) {
    const id = block.tool_use_id
    if (typeof id !== "string") return
    if (!turn.hasTool(id)) turn.toolStart(id, block.type.replace(/_tool_result$/, ""), {})
    const content = block.content
    const failed = (content && typeof content === "object" && !Array.isArray(content) && String(content.type ?? "").endsWith("_error")) || block.is_error
    const lines: string[] = []
    for (const part of Array.isArray(content) ? content : [content]) {
      if (!part) continue
      if (part.type === "web_search_result") lines.push([part.title, part.url].filter(Boolean).join(" — "))
      else if (typeof part.text === "string") lines.push(part.text)
      else if (typeof part.stdout === "string" || typeof part.stderr === "string") lines.push([part.stdout, part.stderr].filter(Boolean).join("\n"))
      else if (part.type === "web_fetch_result") lines.push(part.url ?? "")
      else if (typeof part.error_code === "string") lines.push(part.error_code)
    }
    const text = lines.filter(Boolean).join("\n").slice(0, outputLimit)
    if (failed) turn.toolFailed(id, text || "The tool failed.")
    else turn.toolSucceeded(id, text)
  }

  /** The session a subagent's work is told in, for its call: made the first time. */
  private subagentLane(active: Active, callID: string): Lane | undefined {
    const known = active.subagents.get(callID)
    if (known) return known
    // One at work in the background since an earlier turn: this turn has it now.
    const kept = this.keptLane(callID)
    if (kept) {
      this.backgroundLanes.delete(callID)
      active.subagents.set(callID, kept)
      return kept
    }
    // Its call, the turn's own or a subagent's (a subagent of a subagent: its session too).
    const call = active.calls.get(callID) ?? [...active.subagents.values()].map((lane) => lane.calls.get(callID)).find(Boolean)
    const before = this.subagentSessions.get(callID)
    let run: SubagentRun
    let background = false
    if (call) {
      const input = call.input
      if (kuvoTool(call.name, input).name !== "subagent") return undefined
      background = input.run_in_background === true
      run = active.hooks.subagent(callID, { title: String(input.description ?? ""), prompt: typeof input.prompt === "string" ? input.prompt : undefined, agent: input.subagent_type, background })
      run.stop = () => this.stopSubagent(callID)
      this.subagentSessions.set(callID, { sessionID: run.sessionID, title: String(input.description ?? "") })
    } else if (before) {
      // One sent off in the background in an earlier turn, still at work: its session goes on.
      run = active.hooks.subagent(callID, { title: before.title, sessionID: before.sessionID, background: true })
      run.stop = () => this.stopSubagent(callID)
      background = true
    } else {
      return undefined
    }
    const lane = { turn: run.turn, streamed: new Set<string>(), blockTools: new Map<number, string>(), calls: new Map<string, { name: string; input: Record<string, any> }>(), run, background }
    active.subagents.set(callID, lane)
    return lane
  }

  private stream(lane: Lane, event: any) {
    const turn = lane.turn
    switch (event?.type) {
      case "message_start": {
        lane.streamed.add(event.message?.id)
        lane.blockTools.clear()
        const usage = event.message?.usage ?? {}
        lane.usage = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          reasoning: 0,
          cache: { read: usage.cache_read_input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0 },
        }
        lane.stopReason = undefined
        turn.startStep()
        return
      }
      case "content_block_start": {
        const block = event.content_block
        if (block?.type === "tool_use" || block?.type === "server_tool_use" || block?.type === "mcp_tool_use") {
          lane.blockTools.set(event.index, block.id)
          turn.toolStart(block.id, kuvoTool(block.type === "mcp_tool_use" ? `mcp__${block.server_name ?? "mcp"}__${block.name}` : block.name, {}).name)
        } else if (block?.type === "redacted_thinking") turn.reasoning("(The model kept this thinking to itself.)")
        else if (typeof block?.type === "string" && block.type.endsWith("_tool_result")) this.serverResult(turn, block)
        return
      }
      case "content_block_delta": {
        const delta = event.delta
        if (delta?.type === "text_delta") turn.text(delta.text)
        else if (delta?.type === "thinking_delta") turn.reasoning(delta.thinking)
        else if (delta?.type === "input_json_delta") {
          const id = lane.blockTools.get(event.index)
          if (id) turn.toolInputDelta(id, delta.partial_json ?? "")
        }
        return
      }
      case "content_block_stop":
        turn.endBlock()
        return
      case "message_delta":
        if (lane.usage && event.usage?.output_tokens !== undefined) lane.usage.output = event.usage.output_tokens
        lane.stopReason = event.delta?.stop_reason ?? lane.stopReason
        return
      case "message_stop":
        turn.endStep({ tokens: lane.usage, finish: lane.stopReason === "tool_use" ? "tool-calls" : lane.stopReason ?? "stop" })
        return
    }
  }

  private result(active: Active | undefined, lane: Lane, block: any, structured: any) {
    const turn = lane.turn
    const id = block.tool_use_id
    const call = lane.calls.get(id)
    let text = toolText(block.content)
    if (text.length > outputLimit) text = text.slice(0, outputLimit) + "\n…"
    // Pictures it brought back (a Read of an image, a screenshot), and a PDF it read.
    const pictures = toolPictures(block.content, call?.input)
    // A subagent's task came back: its session's work is done (one sent off in the background
    // goes on, and ends with the turn).
    const subagent = active && lane === active ? active.subagents.get(id) : undefined
    if (active && subagent && !subagent.background) {
      subagent.run.end(block.is_error ? "failed" : "succeeded", block.is_error ? { type: "agent", message: text || "The subagent failed." } : undefined)
      active.subagents.delete(id)
    }
    if (block.is_error) {
      turn.toolFailed(id, text || "The tool failed.")
      return
    }
    const metadata: Record<string, unknown> = {}
    const files = call ? diffs(call.name, call.input, structured) : []
    if (files.length) metadata.files = files
    if (call?.name === "Bash" && structured) {
      // A command that printed a picture: the picture, not its data as words.
      if (structured.isImage && typeof structured.stdout === "string") pictures.push(pictureUrl(structured.stdout.trim()))
      else {
        const output = [structured.stdout, structured.stderr].filter((part: string) => part).join("\n")
        if (output) text = output.length > outputLimit ? output.slice(0, outputLimit) + "\n…" : output
      }
      // What its words said besides (it was stopped, it timed out, where the rest went).
      const notes = [structured.interrupted ? "It was stopped." : "", structured.returnCodeInterpretation ?? "", structured.persistedOutputPath ? `The rest of what it printed is in ${structured.persistedOutputPath}.` : ""].filter(Boolean)
      if (notes.length) text = [text, ...notes].filter(Boolean).join("\n")
    }
    turn.toolSucceeded(id, withPictures(text, pictures), Object.keys(metadata).length ? metadata : undefined)
  }

  private finish(active: Active, result: any) {
    this.addCost(active, result)
    // Which messages it took this turn (Claude Code says, from 2.1.2xx on).
    const says = Array.isArray(result.user_message_uuids)
    for (const uuid of says ? result.user_message_uuids : []) active.steered.delete(uuid)
    const succeeded = result.subtype === "success" && !result.is_error
    const goesOn = !active.stopping && !active.hooks.signal.aborted
    // One you sent partway came after its last step: Claude Code takes it next, as a turn of its
    // own, so this one goes on with it (and ends with its result).
    if (succeeded && goesOn && says && active.steered.size) {
      clearTimeout(active.goingOn)
      active.goingOn = setTimeout(() => this.wentQuiet(active), goingOnLimit)
      return
    }
    clearTimeout(active.goingOn)
    this.active = undefined
    // Ending with one it never took (you stopped it, it failed): it would run that unseen, so
    // this Claude Code goes (the next message opens it again) and the message is handed over then.
    const missed = says ? this.unseen(active) : undefined
    const resolve = active.resolve
    active.resolve = (value) => resolve(missed ? { ...value, missed } : value)
    // A turn that went through went through, whatever was said of limits on the way.
    if (succeeded && goesOn) {
      active.resolve({ outcome: "succeeded" })
      return
    }
    // Its words for a limit, when it stopped: "Claude AI usage limit reached|<when it resets>".
    const text = !succeeded && typeof result.result === "string" ? result.result : ""
    const reached = /usage limit reached\|?(\d+)?/i.exec(text)
    if (!succeeded && !active.limit && (reached || result.api_error_status === 429)) {
      const resetsAt = reached?.[1] ? Number(reached[1]) * 1000 : undefined
      active.limit = { scope: "provider", resetsAt }
      active.problem ??= "You've reached your Claude usage limit for now."
    }
    if (active.limit && !active.stopping) {
      active.resolve({ outcome: "failed", error: { type: "limit", message: active.problem ?? "You've reached a Claude usage limit." }, limit: active.limit, taken: true })
      return
    }
    if (active.stopping || active.hooks.signal.aborted) {
      active.resolve({ outcome: "interrupted" })
      return
    }
    const message =
      active.problem ??
      (typeof result.result === "string" && result.result.trim() ? result.result.trim() : undefined) ??
      (Array.isArray(result.errors) && result.errors.length ? result.errors.join("\n") : undefined) ??
      reason(result)
    active.resolve({ outcome: "failed", error: { type: "agent", message }, taken: true })
  }

  /**
   * What the turn cost, with an API key: Claude Code says what its whole query has cost so far
   * (from where a resumed conversation's transcript left it), so it's the difference.
   */
  private addCost(active: Active, result: any) {
    const total = typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined
    if (total === undefined) return
    const before = typeof this.state.claudeCost === "number" ? this.state.claudeCost : 0
    // Smaller than before: it started counting again (a new conversation, /clear).
    const spent = total >= before ? total - before : total
    this.state.claudeCost = total
    active.hooks.saveState()
    if (spent > 0 && this.agent.usesKey()) active.turn.addUsage(undefined, spent)
  }

  /**
   * Your Blocks refuse a tool; what your rules ask first about is asked (canUseTool then asks
   * you). Between turns (a subagent still at work), the last turn's rules hold, and what would
   * be asked is refused: there's no one to ask. Plan mode is Claude Code's own (it writes its
   * plan to a file, and refuses other edits through canUseTool).
   */
  private async preToolUse(input: any): Promise<any> {
    if (input?.hook_event_name !== "PreToolUse") return {}
    // What a command runs, before it does (one left running is named by it in the bar).
    if (input.tool_name === "Bash" && typeof input.tool_use_id === "string" && typeof input.tool_input?.command === "string") this.commands.set(input.tool_use_id, input.tool_input.command)
    await this.ownTaken()
    const hooks = this.active?.hooks ?? this.lastHooks
    if (!hooks) return {}
    const ask = permissionAsk(String(input.tool_name ?? ""), input.tool_input ?? {})
    let verdict = hooks.check(ask, true)
    // In plan mode its edits are its own to weigh: its plan, to its file, goes; any other edit it
    // asks about, and that's refused. Asking first would refuse its plan too.
    if (verdict === "ask" && ask.action === "edit" && this.opened?.plan) verdict = undefined
    // No one to ask between turns, but for a subagent in the background (it asks as its own).
    if (verdict === "ask" && !this.active && !this.backgroundLane(input.agent_id)) verdict = "deny"
    if (verdict === "deny") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Kuvo Code's settings don't allow this (Settings › Permissions, or this session's rules)." } }
    }
    if (verdict === "ask") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }
    return {}
  }

  /** A turn it began on its own, being taken here: its tools wait for that. */
  private async ownTaken() {
    // (Taken, or the next one it began after it is waiting: through to that.)
    while (!this.active && this.own && !this.own.turnedAway) await this.own.taken
  }

  private async canUseTool(name: string, input: Record<string, any>, options: any): Promise<any> {
    await this.ownTaken()
    const active = this.active
    const toolUseID = options?.toolUseID
    // A subagent in the background asks as its own (its ask outlives the turn that started it).
    const background = this.backgroundLane(options?.agentID)
    if (!active && !background) return { behavior: "deny", message: "There's no turn under way for this.", toolUseID }
    if (!active) {
      if (name === "AskUserQuestion" || name === "ExitPlanMode") return { behavior: "deny", message: "Ask in the conversation that started you.", toolUseID }
      return this.decide(name, input, options, (ask) => background!.run.permission(ask))
    }
    const hooks = active.hooks
    if (name === "AskUserQuestion") {
      const questions = (input.questions ?? []) as { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[]
      const fields: FormField[] = questions.map((question, index) => ({
        key: `q${index}`,
        title: question.header ?? `Question ${index + 1}`,
        description: question.question,
        required: true,
        type: question.multiSelect ? "multiselect" : "string",
        options: (question.options ?? []).map((option) => ({ value: option.label, label: option.label, description: option.description })),
        custom: true,
      }))
      const answer = await hooks.question({ title: questions.length === 1 ? questions[0].header ?? "Question" : "Questions", fields, toolCallID: toolUseID })
      if (!answer) return { behavior: "deny", message: "The user dismissed the question.", toolUseID }
      const answers: Record<string, string> = {}
      questions.forEach((question, index) => {
        const value = answer[`q${index}`]
        answers[question.question] = Array.isArray(value) ? value.join(", ") : String(value ?? "")
      })
      return { behavior: "allow", updatedInput: { ...input, answers }, toolUseID }
    }
    // In Plan mode, the plan shows in the conversation, and building starts when you switch to
    // Build and say so. In Build, a plan mode it went into on its own (its EnterPlanMode, for a big
    // task) it leaves when its plan is done, and carries on.
    if (name === "ExitPlanMode" && this.opened?.plan) {
      return {
        behavior: "deny",
        message: "The plan is shown to the user. Stop here and wait: they'll switch out of plan mode and ask you to build it when they're ready.",
        toolUseID,
      }
    }
    if (name === "ExitPlanMode") return { behavior: "allow", updatedInput: input, toolUseID }
    return this.decide(name, input, options, background ? (ask) => background.run.permission(ask) : hooks.permission)
  }

  /** A subagent stopped from Kuvo Code: its task, as Claude Code's own Stop does (it then says it stopped). */
  private async stopSubagent(callID: string) {
    for (const [taskID, task] of this.tasks) if (task.toolUseID === callID) await this.query?.stopTask?.(taskID).catch(() => {})
  }

  /** A subagent kept at work in the background, unless the session ended it since (with a turn that failed). */
  private keptLane(callID: string) {
    const lane = this.backgroundLanes.get(callID)
    if (!lane?.run.turn.isEnded) return lane
    this.backgroundLanes.delete(callID)
    return undefined
  }

  /** A subagent at work in the background, by Claude Code's id for it (its task's). */
  private backgroundLane(agentID: unknown) {
    const callID = typeof agentID === "string" ? this.tasks.get(agentID)?.toolUseID : undefined
    const lane = callID ? (this.keptLane(callID) ?? this.active?.subagents.get(callID)) : undefined
    return lane?.background ? lane : undefined
  }

  /** A tool asked about: allowed, or not, as you answer (or your rules do). */
  private async decide(name: string, input: Record<string, any>, options: any, permission: TurnHooks["permission"]): Promise<any> {
    const toolUseID = options?.toolUseID
    const ask = permissionAsk(name, input)
    const decision = await permission({ toolCallID: toolUseID, ...ask, message: options?.title ?? options?.description })
    if (decision === "reject") return { behavior: "deny", message: "The user declined this.", toolUseID }
    const result: any = { behavior: "allow", updatedInput: input, toolUseID }
    if (decision === "always" && Array.isArray(options?.suggestions)) {
      result.updatedPermissions = options.suggestions.map((suggestion: any) => ({ ...suggestion, destination: "session" }))
    }
    return result
  }

  /**
   * Your message, into the turn under way: Claude Code takes it at its next step (priority
   * "next"), or after its last one, and the turn goes on until it has.
   */
  async steer(input: { id: string; text: string; files: PromptFile[] }): Promise<boolean> {
    const active = this.active
    if (!active || !this.input || active.stopping) return false
    const message = { ...userMessage(input), priority: "next" }
    active.steered.set(message.uuid, input.id)
    this.input.push(message)
    return true
  }

  /** A turn kept open for a message it took late, with nothing more from Claude Code: it ends. */
  private wentQuiet(active: Active) {
    if (this.active !== active) return
    clearTimeout(active.goingOn)
    this.active = undefined
    active.resolve({ outcome: "succeeded", missed: this.unseen(active) })
  }

  /**
   * Messages sent this turn that it never took: this Claude Code goes (it would run them with no
   * turn here), and those of yours are named, to hand over next time.
   */
  private unseen(active: Active): string[] | undefined {
    if (!active.steered.size) return undefined
    const yours = [...active.steered.values()].filter(Boolean)
    this.close()
    return yours.length ? yours : undefined
  }

  async interrupt() {
    const query = this.query
    const active = this.active
    if (!query || !active) return
    active.stopping = true
    await query.interrupt().catch(() => {})
    // Claude Code ends the turn with a result; one that doesn't is stopped (this turn's Claude
    // Code, not one a later message started).
    for (let waited = 0; waited < 5_000 && this.active === active; waited += 100) await Bun.sleep(100)
    if (this.active === active && this.query === query) {
      this.active = undefined
      clearTimeout(active.goingOn)
      const missed = this.unseen(active)
      this.close()
      active.resolve({ outcome: "interrupted", missed })
    }
  }

  close() {
    this.input?.close()
    try {
      this.query?.close?.()
    } catch {}
    this.query = undefined
    this.input = undefined
    this.leftRunning()
  }

  /** What it left running ends with it. */
  private leftRunning() {
    for (const task of this.tasks.values()) if (task.shell) endShell(task.shell)
    for (const lane of this.backgroundLanes.values()) lane.run.end("interrupted")
    this.backgroundLanes.clear()
    this.liveTasks.clear()
    this.own?.take?.()
    this.own = undefined
  }
}

/**
 * What Claude Code sends, by kind: each is shown, used, or left out on purpose (tool_progress's
 * elapsed time, a summary of tools already shown, suggestions it isn't asked for). A test checks
 * the SDK's own list against these; any other kind is shown when it has words, and logged.
 */
export const claudeMessages = new Set(["assistant", "user", "stream_event", "result", "system", "rate_limit_event", "auth_status", "conversation_reset", "tool_progress", "tool_use_summary", "prompt_suggestion"])

/** Its `system` messages' kinds: shown (compacting, retries, notes, hooks' failures, memory), used (tasks, init) or bookkeeping. */
export const claudeSystem = new Set([
  "init", "compact_boundary", "status", "api_retry", "control_request_progress", "model_refusal_fallback", "model_refusal_no_fallback",
  "local_command_output", "hook_started", "hook_progress", "hook_response", "plugin_install", "task_notification", "task_started",
  "task_updated", "task_progress", "background_tasks_changed", "thinking_tokens", "session_state_changed", "worker_shutting_down",
  "commands_changed", "notification", "files_persisted", "memory_recall", "elicitation_complete", "permission_denied", "mirror_error",
  "informational",
  // Newer Claude Codes' summaries of what it already showed.
  "task_summary", "post_turn_summary",
])

// MARK: Tools, as the app knows them

/** Claude Code's tool, by the engine's name for its kind, with its input as the app reads it. */
export function kuvoTool(name: string, input: Record<string, any>): { name: string; input: Record<string, unknown> } {
  switch (name) {
    case "Bash":
      return { name: "shell", input: { command: input.command, description: input.description } }
    case "Read":
      return { name: "read", input: { path: input.file_path, offset: input.offset, limit: input.limit } }
    case "Write":
      return { name: "write", input: { path: input.file_path, content: input.content } }
    case "Edit":
      return { name: "edit", input: { path: input.file_path, oldString: input.old_string, newString: input.new_string, replaceAll: input.replace_all } }
    case "MultiEdit":
      return { name: "edit", input: { path: input.file_path, edits: input.edits } }
    case "NotebookEdit":
      return { name: "edit", input: { path: input.notebook_path, newString: input.new_source } }
    case "Glob":
      return { name: "glob", input: { pattern: input.pattern, path: input.path } }
    case "Grep":
      return { name: "grep", input: { pattern: input.pattern, path: input.path, glob: input.glob } }
    case "WebFetch":
      return { name: "webfetch", input: { url: input.url, prompt: input.prompt } }
    case "WebSearch":
    case "web_search":
      return { name: "websearch", input: { query: input.query } }
    // Tools the API runs itself.
    case "web_fetch":
      return { name: "webfetch", input: { url: input.url } }
    case "code_execution":
    case "bash_code_execution":
      return { name: "shell", input: { command: input.command ?? input.code, description: "Ran on Anthropic's servers" } }
    case "Task":
    case "Agent":
      return { name: "subagent", input: { description: input.description, agent: input.subagent_type, prompt: input.prompt } }
    case "TodoWrite":
      return { name: "todowrite", input: { todos: input.todos } }
    case "AskUserQuestion":
      return { name: "question", input: { questions: input.questions } }
    case "Skill":
      return { name: "skill", input: { name: input.skill ?? input.command } }
    case "ExitPlanMode":
      return { name: "plan", input: { plan: input.plan } }
  }
  if (name.startsWith("mcp__")) {
    const [, server, ...rest] = name.split("__")
    return { name: `${server}_${rest.join("__")}`, input }
  }
  return { name: name.toLowerCase(), input }
}

function permissionAsk(name: string, input: Record<string, any>): { action: string; resources: string[]; save?: string[]; metadata?: Record<string, unknown> } {
  switch (name) {
    case "Bash":
      return { action: "shell", resources: [String(input.command ?? "")] }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = String(input.file_path ?? input.notebook_path ?? "")
      const preview = previewDiff(name, input)
      return { action: "edit", resources: [path], metadata: preview ? { files: [preview] } : undefined }
    }
    case "WebFetch":
      return { action: "webfetch", resources: [String(input.url ?? "")] }
    case "WebSearch":
      return { action: "websearch", resources: [String(input.query ?? "")] }
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
      return { action: "read", resources: [String(input.file_path ?? input.path ?? "*")] }
  }
  return { action: kuvoTool(name, input).name, resources: ["*"] }
}

/** What an edit would do to its file, for the permission card. */
function previewDiff(name: string, input: Record<string, any>): FileDiff | undefined {
  const path = String(input.file_path ?? "")
  if (!path) return undefined
  const before = existsSync(path) ? safeRead(path) : undefined
  if (name === "Write") return fileDiff(path, before, String(input.content ?? ""))
  if (before === undefined) return undefined
  let after = before
  const edits: { old_string: string; new_string: string; replace_all?: boolean }[] = name === "MultiEdit" ? input.edits ?? [] : [input as any]
  for (const edit of edits) {
    if (typeof edit.old_string !== "string") return undefined
    after = edit.replace_all ? after.split(edit.old_string).join(edit.new_string ?? "") : after.replace(edit.old_string, () => edit.new_string ?? "")
  }
  return fileDiff(path, before, after)
}

/** What an edit did, from Claude Code's own account of it. */
function diffs(name: string, input: Record<string, any>, structured: any): FileDiff[] {
  if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) return []
  const path = String(structured?.filePath ?? input.file_path ?? input.notebook_path ?? "")
  if (!path) return []
  if (name === "Write" && structured?.type === "create") return [fileDiff(path, undefined, String(structured.content ?? input.content ?? ""))]
  const hunks = structured?.structuredPatch as { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] | undefined
  if (Array.isArray(hunks) && hunks.length) {
    const patch = hunks.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n` + hunk.lines.join("\n") + "\n").join("")
    return [fromPatch(path, patch)]
  }
  if (typeof structured?.originalFile === "string" && existsSync(path)) return [fileDiff(path, structured.originalFile, safeRead(path) ?? "")]
  // A notebook's cell, as it was and is.
  if (name === "NotebookEdit" && (typeof structured?.old_source === "string" || typeof structured?.new_source === "string")) return [fileDiff(path, structured.old_source ?? "", structured.new_source ?? "")]
  return []
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function toolText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        switch (part?.type) {
          case "text":
            return part.text
          case "tool_reference":
            return `Loaded ${part.tool_name ?? "a tool"}`
          case "search_result":
            return [part.title, part.source].filter(Boolean).join(" — ")
          case "image":
          case "document":
            return ""
        }
        return typeof part?.text === "string" ? part.text : ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

/** The pictures (and a PDF) in a tool's result: as data, or the file it read. */
function toolPictures(content: unknown, input: Record<string, any> | undefined): (ReturnType<typeof pictureData> | ReturnType<typeof pictureFile>)[] {
  const pictures: (ReturnType<typeof pictureData> | ReturnType<typeof pictureFile>)[] = []
  for (const part of Array.isArray(content) ? (content as any[]) : []) {
    if (part?.type === "image") pictures.push(part.source?.type === "base64" ? pictureData(part.source.data, part.source.media_type) : pictureUrl(part.source?.url))
    if (part?.type === "document" && typeof input?.file_path === "string") pictures.push({ type: "file", uri: pathToFileURL(input.file_path).href, mime: "application/pdf", name: input.file_path.split("/").pop() })
  }
  return pictures
}

/** A picture by its address: data, or a file on this Mac. */
function pictureUrl(url: unknown): ReturnType<typeof pictureData> {
  if (typeof url !== "string") return undefined
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (data) return pictureData(data[2], data[1])
  return url.startsWith("file://") ? pictureFile(decodeURIComponent(new URL(url).pathname)) : undefined
}

/** An API error Claude Code reported in a reply, in words. */
function apiErrorWords(error: string): string {
  switch (error) {
    case "billing_error":
      return "Claude's API says there's a billing problem with this account."
    case "rate_limit":
      return "Claude's API is rate limiting this model."
    case "invalid_request":
      return "Claude's API turned the request away."
    case "server_error":
      return "Claude's API had a problem."
    case "max_output_tokens":
      return "The reply ran out of room."
  }
  return `Claude's API reported an error (${error}).`
}

/** What reaching a Claude plan limit means, in words. */
function limitWords(type: string | undefined): string {
  switch (type) {
    case "five_hour":
      return "You've reached your Claude usage limit for the next few hours."
    case "seven_day_opus":
      return "You've reached this week's Opus limit on your Claude plan."
    case "seven_day_sonnet":
      return "You've reached this week's Sonnet limit on your Claude plan."
    default:
      return "You've reached your Claude usage limit for now."
  }
}

function reason(result: any): string {
  switch (result.subtype) {
    case "error_max_turns":
      return "Claude Code stopped after too many steps."
    case "error_max_budget_usd":
      return "Claude Code reached its spending limit."
    default:
      return "Claude Code stopped with an error."
  }
}

function userMessage(input: Pick<RunInput, "text" | "files">): any {
  const content: any[] = []
  const others: string[] = []
  for (const file of input.files) {
    const isImage = /^image\/(png|jpeg|gif|webp)$/.test(file.mime)
    const data = file.data ?? (isImage && file.path ? safeBase64(file.path) : undefined)
    if (isImage && data) content.push({ type: "image", source: { type: "base64", media_type: file.mime, data } })
    else if (file.path) others.push(file.path)
  }
  let text = input.text
  if (others.length) text += `\n\nAttached files:\n${others.map((path) => `- ${path}`).join("\n")}`
  content.push({ type: "text", text })
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: randomUUID() }
}

function safeBase64(path: string): string | undefined {
  try {
    return readFileSync(path).toString("base64")
  } catch {
    return undefined
  }
}
