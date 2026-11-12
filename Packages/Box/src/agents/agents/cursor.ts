// Cursor, with Cursor's own agent SDK (`@cursor/sdk`), as T3 Code runs it: signed in with your
// Cursor account in the browser (the SDK makes an API key for Kuvo Code) or with a Cursor API key.
// The SDK is downloaded the first time it's needed; its sign-in and its agents' conversations stay
// in the bridge's folder.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { providerID, type AgentAccount } from "../accounts"
import type { Agent, AgentContext, Account, RunInput, RunResult, SignInAttempt, SubagentRun, Thread, TurnHooks } from "../agent"
import { accountName, failure, KnownAccount, model, TookTooLong } from "../agent"
import type { Limit } from "../auto"
import { fileDiff, fromPatch } from "../diff"
import { allowedFolders, fenceAgent, fenceAttachments, fenceCopy, fenceKey, fenceRules, seatBot, fullAccessMark } from "../fence"
import { kuvoTools } from "../kuvotools"
import { pictureData, pictureFile, withPictures } from "../pictures"
import { skillsFolder, skillsFor, turnedOff, upward } from "../skills"
import { cursorSubagents, subagentsFor } from "../subagents"
import { dropRelayed, relayedServers, relayedTools, relayPort, serversKey } from "../toolrelay"
import { computerServers } from "../servers"
import type { Turn } from "../turn"
import type { Model, OAuthStatus, Session } from "../wire"
import { CursorWorker, cursorWorker } from "./cursor-worker"
import { privateFolder } from "../../shared/files"

/** A file's bytes as base64, or nothing when it can't be read. */
function readable(path: string): string | undefined {
  try {
    return readFileSync(path).toString("base64")
  } catch {
    return undefined
  }
}

// T3 Code's tested version; newer ones resolve differently under Bun.
/** What Cursor calls a model's effort setting, by model. */
const effortParameters = ["effort", "reasoning", "reasoning_effort"]

const SDK = [{ name: "@cursor/sdk", version: "1.0.35" }]
const outputLimit = 30_000
/** How long a session's Cursor, run whole in the sandbox, stays started once it's done (its conversation picked up again after). */
const workerIdle = 15 * 60_000

export class CursorAgent implements Agent {
  id = "cursor"
  readonly providerID: string
  get name() {
    return accountName("Cursor", this.instance)
  }
  private modelList?: { at: number; key: string; models: Model[] }
  private primed = false

  constructor(
    readonly context: AgentContext,
    readonly instance: AgentAccount = { id: "default" },
  ) {
    this.providerID = providerID("cursor", instance.id)
  }

  /** Where Cursor reads skills itself: its own, Claude Code's, Codex's, Grok's and `.agents`, yours and a project's. */
  ownSkillFolders(directory: string): string[] {
    return [homedir(), ...upward(directory)].flatMap((folder) => [".cursor", ".claude", ".codex", ".grok", ".agents"].map((name) => join(folder, name, "skills")))
  }

  /** This account's folder: its sign-in and its agents' conversations. */
  get folder() {
    return this.instance.home ?? join(this.context.home, "cursor")
  }

  /** Where the SDK's sign-in is kept: a file only you can read, in the bridge's folder. */
  private get authFile() {
    return join(this.folder, "auth.json")
  }

  methods() {
    return [
      { type: "oauth" as const, id: "browser", label: "Sign in with Cursor" },
      { type: "key" as const, label: "Use a Cursor API key" },
    ]
  }

  /** Where its SDK is installed (the first time, downloaded). */
  runtime(): Promise<string> {
    return this.context.deps.ensure(this.id, SDK)
  }

  async sdk(): Promise<any> {
    const folder = await this.runtime()
    // The SDK finds its sandbox helper (and ripgrep) in a node_modules beside the script that runs
    // it; the bridge's isn't there, so without this it decides Cursor's sandbox isn't supported.
    process.argv[1] = join(folder, "package.json")
    // What it keeps (notes for each project, sandbox policies), in the bridge's folder rather than
    // `~/.cursor` and `~/Library`.
    process.env.CURSOR_DATA_DIR ??= join(this.context.home, "cursor", "data")
    process.env.CURSOR_SANDBOX_POLICY_DIR ??= join(this.context.home, "cursor", "sandbox-policies")
    process.env.CUA_APP_SUPPORT_DIR ??= join(this.context.home, "cursor", "computer-use")
    return this.context.deps.load(this.id, SDK[0].name)
  }

  private async store(sdk: any) {
    // (Its sign-in, which the SDK writes: in a folder only you can open.)
    privateFolder(this.folder)
    return new sdk.FileCredentialStore(this.authFile)
  }

  /** The key to run with: CURSOR_API_KEY's, or the one your sign-in made, while it lasts. */
  async apiKey(sdk?: any): Promise<string | undefined> {
    // CURSOR_API_KEY is your own account's; an added one has only its sign-in.
    const fromEnvironment = this.instance.home ? undefined : process.env.CURSOR_API_KEY?.trim()
    if (fromEnvironment) return fromEnvironment
    if (!existsSync(this.authFile)) return undefined
    const loaded = await (await this.store(sdk ?? (await this.sdk()))).load()
    if (!loaded?.apiKey) return undefined
    if (loaded.apiKeyExpiresAtMs && loaded.apiKeyExpiresAtMs < Date.now()) return undefined
    return loaded.apiKey
  }

  async account(fresh = false): Promise<Account> {
    if ((this.instance.home || !process.env.CURSOR_API_KEY) && !existsSync(this.authFile)) {
      return { installed: true, signedIn: false, message: "Sign in with your Cursor account. Kuvo Code downloads Cursor's agent the first time." }
    }
    return this.known.read(fresh, async () => {
      const sdk = await this.sdk()
      const apiKey = await this.apiKey(sdk)
      let account: Account
      if (!apiKey) {
        account = { installed: true, signedIn: false, message: "Your Cursor sign-in expired. Sign in again." }
      } else {
        try {
          const me: any = await withTimeout(sdk.Cursor.me({ apiKey }), 15_000)
          account = { installed: true, signedIn: true, label: me?.userEmail ?? (process.env.CURSOR_API_KEY ? "Cursor API key" : "Cursor account") }
        } catch (error: any) {
          // Only Cursor turning it down is a sign-out (not Cursor out of reach, or slow to answer).
          if (!(error instanceof sdk.AuthenticationError || error?.status === 401)) throw error
          account = { installed: true, signedIn: false, message: "Cursor turned the sign-in down. Sign in again." }
        }
      }
      return account
    })
  }

  /** Its sign-in as Cursor last said, for a minute (a check that fails isn't a sign-out). */
  private known = new KnownAccount(60_000)

  /** Cursor's page finishes by itself, wherever it's opened (its SDK waits on Cursor, not on this computer). */
  readonly signsInRemotely = true

  async signIn(): Promise<SignInAttempt> {
    if (!this.instance.home && process.env.CURSOR_API_KEY) throw new Error("CURSOR_API_KEY is set in your environment: Kuvo Code uses that key.")
    const sdk = await this.sdk()
    const pending = new sdk.InMemoryCredentialStore()
    const abort = new AbortController()
    let status: OAuthStatus = { status: "pending" }
    let resolveURL: (url: string) => void = () => {}
    const url = new Promise<string>((resolve) => (resolveURL = resolve))
    sdk.Cursor.auth
      .login({ openBrowser: false, store: pending, signal: abort.signal, apiKeyName: "Kuvo Code", onLoginUrl: (link: string) => resolveURL(link) })
      .then(async () => {
        const credentials = await pending.load()
        if (!credentials) throw new Error("Cursor didn't hand over the sign-in.")
        await (await this.store(sdk)).save(credentials)
        this.known.reset()
        this.modelList = undefined
        status = { status: "complete" }
      })
      .catch((error: unknown) => {
        if (status.status === "pending") status = { status: "failed", message: abort.signal.aborted ? "Cancelled." : failure(error).message }
      })
    const link = await Promise.race([url, Bun.sleep(30_000).then(() => "")])
    return {
      url: link,
      instructions: "Finish signing in to Cursor in your browser. Cursor makes an API key for Kuvo Code, kept on this Mac.",
      mode: "auto",
      status: () => status,
      cancel: () => abort.abort(),
    }
  }

  async signInWithKey(key: string) {
    const sdk = await this.sdk()
    await withTimeout(sdk.Cursor.me({ apiKey: key }), 15_000)
    await (await this.store(sdk)).save({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: key, createdAtMs: Date.now() })
    this.known.reset()
    this.modelList = undefined
  }

  async signOut() {
    rmSync(this.authFile, { force: true })
    this.known.reset()
    this.modelList = undefined
  }

  async models(): Promise<Model[]> {
    const sdk = await this.sdk()
    const apiKey = await this.apiKey(sdk)
    if (!apiKey) return []
    if (this.modelList && this.modelList.key === apiKey && Date.now() - this.modelList.at < 30 * 60_000) return this.modelList.models
    let list: any[]
    try {
      list = await withTimeout(sdk.Cursor.models.list({ apiKey }), 15_000)
    } catch (error) {
      // Cursor couldn't list them just now: the ones it listed last for this sign-in.
      if (this.modelList?.key === apiKey) return this.modelList.models
      throw error
    }
    const seen = new Set<string>()
    const models = list
      .filter((info) => info?.id && !seen.has(info.id) && seen.add(info.id))
      .map((info, index) => {
        // (Named "effort", "reasoning" or "reasoning_effort", by model: a turn sets it by its name.)
        const effort = (info.parameters ?? []).find((parameter: any) => effortParameters.includes(parameter.id))
        if (effort) this.efforts.set(info.id, effort.id)
        return model(this.providerID, info.id, info.id === "default" ? "Auto" : info.displayName ?? info.id, {
          variants: effort?.values?.map((value: any) => String(value.value)) ?? [],
          images: true,
          released: info.id === "default" ? 2000 : 1000 - index,
        })
      })
    this.modelList = { at: Date.now(), key: apiKey, models }
    return models
  }

  forgetModels() {
    this.modelList = undefined
  }

  /** Each model's own name for its effort setting. */
  private efforts = new Map<string, string>()

  /** A model's effort setting, as a turn sets it. */
  async effort(model: { id: string; variant?: string }): Promise<{ id: string; params?: { id: string; value: string }[] }> {
    if (!model.variant) return { id: model.id }
    if (!this.efforts.has(model.id)) await this.models().catch(() => [])
    return { id: model.id, params: [{ id: this.efforts.get(model.id) ?? "effort", value: model.variant }] }
  }

  /** The SDK decides once whether sandboxing works, and the first agent without it would say no. */
  async prime(sdk: any, apiKey: string, cwd: string) {
    if (this.primed) return
    this.primed = true
    try {
      const platform = await sdk.createAgentPlatform({ workspaceRef: cwd })
      const release = await platform.prewarmLocalWorkspace({ apiKey, local: { cwd, settingSources: [], sandboxOptions: { enabled: true } } })
      await release?.()
    } catch {}
  }

  agentStore(sdk: any) {
    const root = join(this.folder, "agents")
    mkdirSync(root, { recursive: true })
    return new sdk.JsonlLocalAgentStore(root)
  }

  thread(session: Session, state: Record<string, unknown>): Thread {
    return new CursorThread(this, session, state)
  }
}

// MARK: A session

/** Where Cursor's updates are told: the turn's own, or a subagent's session (a task it started). */
interface Lane {
  turn: Turn
  toolsSinceText: boolean
  sawText: boolean
  lastShell?: string
  output: Map<string, string>
}

interface Active extends Lane {
  hooks: TurnHooks
  run?: any
  /** Its subagents (task calls), each told in a session of its own, by their call. */
  subagents: Map<string, Lane & { run: SubagentRun }>
  /** Tool calls it said it would make, and those it told: one its SDK leaves out is said. */
  listed: number
  told: number
  /** What its last turn sent and got back, as it said when the turn ended. */
  usage?: any
}

class CursorThread implements Thread {
  private agent?: any
  /** Whether it was started to run its tools without asking. */
  private startedApproving?: boolean
  private startedSkills?: string
  /** Kuvo Code's tools as it was started with them: other ones (the app started again) start it again. */
  private startedTools?: string
  /** The sandbox as it was started in (none: in the bridge): another one starts it again. */
  private startedFence?: string
  /** Its SDK in a process of its own, run whole in the box's sandbox while it's on. */
  private worker?: CursorWorker

  get sandboxed() {
    return Boolean(this.agent && this.startedFence && this.worker && !this.worker.isClosed)
  }
  // (Its SDK in the bridge's own process, which runs its tools.)
  get outside() {
    return Boolean(this.agent && !this.startedFence)
  }
  /** Stops the worker once it's been done a while. */
  private idle?: ReturnType<typeof setTimeout>
  private active?: Active

  constructor(
    private readonly owner: CursorAgent,
    private readonly session: Session,
    private readonly state: Record<string, unknown>,
  ) {}

  /** The conversation it had couldn't be picked up again: a new one took its place. */
  private startedOver = false

  async prepare(input: RunInput, hooks: TurnHooks) {
    clearTimeout(this.idle)
    const sdk = await this.owner.sdk()
    const apiKey = await this.owner.apiKey(sdk)
    if (!apiKey || hooks.signal.aborted) return undefined
    if (hooks.approvesAll(false) && !fenceRules()) await this.owner.prime(sdk, apiKey, this.session.location.directory)
    await this.ensureAgent(sdk, await this.options(sdk, input, hooks, apiKey, await this.owner.effort(input.model)), hooks)
    const fresh = this.startedOver
    this.startedOver = false
    return { fresh }
  }

  private async options(sdk: any, input: RunInput, hooks: TurnHooks, apiKey: string, selection: { id: string }) {
    const approvesAll = hooks.approvesAll(false)
    const mode = input.plan ? "plan" : "agent"
    const cwd = this.session.location.directory
    // Settings › Skills' skills, in a folder of the workspace's (`.cursor/skills` in it), but those
    // it reads itself.
    const skills = skillsFolder(await skillsFor(cwd, this.owner.ownSkillFolders(cwd), turnedOff(hooks)))
    // Run whole in the box's sandbox (the worker's), its commands are kept in by it rather than by
    // Cursor's own.
    const fenced = Boolean(fenceRules())
    // Kuvo Code's own tools (the panel's browser, show_in_panel, messages to other agents), as the
    // other agents have them: what they do goes to this conversation (through the relay, in the sandbox).
    const tools = fenced ? relayedTools(this.session.id, this) : kuvoTools(this.session.id)
    // And the computer's MCP servers (yours, the integrations', a bot's with its own keys), through
    // the relay, which keeps their keys.
    // (Those set right since the relay stood in for them, at new addresses, which start it again.)
    const computer = await computerServers(cwd)
    await serversKey(this.session.id, computer)
    const servers = relayedServers(this.session.id, this, cwd, computer)
    const mcpServers: Record<string, unknown> = Object.fromEntries(servers.map((each) => [each.name, { type: "http", url: each.url, headers: each.headers }]))
    if (tools) mcpServers[tools.name] = tools.kind === "http" ? { type: "http", url: tools.url, headers: tools.headers } : { type: "stdio", command: tools.command, args: tools.args, env: tools.env }
    // Your subagents (Settings › Agents), on a model of Cursor's when theirs is one.
    const agents = cursorSubagents(await subagentsFor(cwd))
    return {
      model: selection,
      name: `Kuvo Code: ${this.session.title ?? "session"}`,
      mode,
      apiKey,
      // (On a machine, the commands Cursor runs get the bridge's own folders (XDG_… in Kuvo
      // Code's), not the machine's, unlike every other agent's: its SDK runs them in this process
      // with its environment, and takes none for a local agent. Giving the whole bridge the
      // machine's folders would give them to every agent's own process too, so `gh` and git's own
      // settings stay out of reach of Cursor's commands there.)
      local: {
        cwd,
        ...(skills ? { dirs: [skills] } : {}),
        autoReview: !approvesAll,
        settingSources: ["project", "user", "team", "mdm", "plugins"],
        sandboxOptions: { enabled: !approvesAll && !fenced },
        enableAgentRetries: true,
        store: this.owner.agentStore(fenced ? CursorWorker : sdk),
      },
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(Object.keys(agents).length ? { agents } : {}),
    }
  }

  /** Cursor's agent for this session: the one it had, or a new one (said by `startedOver`). */
  private async ensureAgent(sdk: any, options: any, hooks: TurnHooks) {
    const approvesAll = hooks.approvesAll(false)
    // Its sandbox, review, folders and Kuvo Code's tools are set as it starts: another approval
    // mode, other skills or other tools (Kuvo Code's, or another set of the computer's servers),
    // or other subagents, start it again.
    const skills = options.local?.dirs?.[0] as string | undefined
    const tools = JSON.stringify([kuvoTools(this.session.id)?.key, Object.entries(options.mcpServers ?? {}).map(([name, server]: [string, any]) => [name, server?.url ?? ""]).sort(), options.agents ?? {}])
    // In the sandbox: its rules and the folders Also Allowed gives the project, as it starts.
    const fence = fenceRules() ? fenceKey() + JSON.stringify(allowedFolders(this.session.location.directory)) + fullAccessMark(this.session.id) : ""
    // (And the worker it runs in, as it starts again, or once it has stopped.)
    if (this.startedApproving !== approvesAll || this.startedSkills !== skills || this.startedTools !== tools || this.startedFence !== fence || this.worker?.isClosed) this.stop()
    if (this.agent) return
    this.startedApproving = approvesAll
    this.startedSkills = skills
    this.startedTools = tools
    this.startedFence = fence
    // Its agents: the SDK's own in the bridge, or the worker's in the sandbox.
    if (fence && !this.worker) this.worker = await this.startWorker(options)
    const agents = fence ? this.worker! : sdk
    const id = this.state.cursorAgent as string | undefined
    // (The worker says one that's gone; it stopping isn't that.)
    this.agent = id ? await (fence ? agents.Agent.resume(id, options) : agents.Agent.resume(id, options).catch(() => undefined)) : undefined
    if (!this.agent && id) {
      // In place of one it had: the instructions go again, and what came before is handed over.
      this.startedOver = true
      delete this.state.cursorInstructions
      delete this.state.cursorInstructed
    }
    this.agent ??= await agents.Agent.create(options)
    if (this.state.cursorAgent !== this.agent.agentId) {
      this.state.cursorAgent = this.agent.agentId
      hooks.saveState()
    }
  }

  async run(input: RunInput, turn: Turn, hooks: TurnHooks): Promise<RunResult> {
    const sdk = await this.owner.sdk()
    const apiKey = await this.owner.apiKey(sdk)
    if (!apiKey) return { outcome: "failed", error: { type: "auth", message: "Sign in to Cursor in Settings › Accounts." } }
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    const cwd = this.session.location.directory
    const approvesAll = hooks.approvesAll(false)
    const selection = await this.owner.effort(input.model)
    const mode = input.plan ? "plan" : "agent"
    const options = await this.options(sdk, input, hooks, apiKey, selection)
    if (approvesAll && !fenceRules()) await this.owner.prime(sdk, apiKey, cwd)
    // Cursor's SDK can't stop to ask: said once, so Ask First isn't taken for what it does.
    if (!approvesAll && !input.plan && !this.state.cursorAskNoted) {
      turn.notice("Cursor can't stop to ask you before it acts here: it runs what its sandbox allows and declines the rest. Use Plan mode to have it propose changes first.")
      this.state.cursorAskNoted = true
      hooks.saveState()
    }
    await this.ensureAgent(sdk, options, hooks)
    // Pictures it sees; one it can't read here (gone since, say) goes by its path, as other files do.
    const images: { data: string; mimeType: string }[] = []
    const byPath: string[] = []
    for (const file of input.files) {
      const data = file.mime.startsWith("image/") ? (file.data ?? (file.path ? readable(file.path) : undefined)) : undefined
      if (data) images.push({ data, mimeType: file.mime })
      else if (file.path) byPath.push(file.path)
    }
    let text = input.text
    // (In the sandbox, which hides where they're kept: copies it reads.)
    const others = byPath.map((path) => (this.worker ? fenceCopy(cwd, path) : path))
    if (others.length) text += `\n\nAttached files:\n${others.map((path) => `- ${path}`).join("\n")}`
    // The app's added instructions go with the first message, and again when they change.
    const instructions = hooks.instructions()
    const sent = typeof this.state.cursorInstructions === "string" ? this.state.cursorInstructions : this.state.cursorInstructed ? undefined : ""
    let instructed: { value: string } | undefined
    if (instructions !== sent && (instructions || sent)) {
      if (instructions) text = `${sent ? "Your instructions from Kuvo Code changed. They're now:\n\n" : ""}${instructions}\n\n${text}`
      instructed = { value: instructions }
    }
    // Kept as sent once Cursor took the message (not one it turned away before doing anything).
    const instructionsTaken = () => {
      if (!instructed) return
      this.state.cursorInstructions = instructed.value
      delete this.state.cursorInstructed
      hooks.saveState()
      instructed = undefined
    }
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    const active: Active = { turn, hooks, toolsSinceText: false, sawText: false, output: new Map(), subagents: new Map(), listed: 0, told: 0 }
    this.active = active
    turn.startStep()
    // Updates are handled one after another, in the order they came.
    let chain = Promise.resolve()
    const onDelta = async ({ update }: { update: any }) => {
      chain = chain
        .then(() => this.update(active, active, update))
        .catch((error) => console.error(`Cursor sent an update Kuvo Code couldn't show: ${errorWords(error)}`))
    }
    try {
      const run = await this.agent.send(images.length ? { text, images } : text, { model: selection, mode, onDelta })
      active.run = run
      // Stopped while it was being sent.
      if (hooks.signal.aborted) await run.cancel().catch(() => {})
      const result = await run.wait()
      await chain
      if (result?.status !== "error" || active.sawText || active.output.size) instructionsTaken()
      if (!active.sawText && typeof result?.result === "string" && result.result.trim()) turn.text(result.result)
      // Its last turn's: the request that's in its context now, which the run's own count (all
      // its turns added up) isn't.
      const usage = active.usage ?? result?.usage
      // Tools its SDK didn't tell (it reports only the kinds it knows): said, so they aren't a mystery.
      if (active.listed > active.told) turn.notice(`Cursor used ${active.listed - active.told} more ${active.listed - active.told === 1 ? "tool" : "tools"} than it reports to Kuvo Code.`)
      // Subagents still at work when it was stopped (or failed) were stopped with it.
      const cut = hooks.signal.aborted || result?.status === "cancelled" || result?.status === "error"
      for (const lane of active.subagents.values()) lane.run.end(cut ? "interrupted" : "succeeded")
      turn.endStep({
        // (Its thinking is part of what it wrote, as Cursor counts it: told apart, counted once.)
        tokens: usage
          ? {
              input: usage.inputTokens ?? 0,
              output: Math.max(0, (usage.outputTokens ?? 0) - (usage.reasoningTokens ?? 0)),
              reasoning: usage.reasoningTokens ?? 0,
              cache: { read: usage.cacheReadTokens ?? 0, write: usage.cacheWriteTokens ?? 0 },
            }
          : undefined,
      })
      if (hooks.signal.aborted || result?.status === "cancelled") return { outcome: "interrupted" }
      if (result?.status === "error") {
        const message = errorWords(result.error) ?? "Cursor stopped with an error."
        const limit = limitOf(message, result.error)
        return limit ? { outcome: "failed", error: { type: "limit", message }, limit } : { outcome: "failed", error: failure(message) }
      }
      return { outcome: "succeeded" }
    } catch (error: any) {
      if (active.sawText || active.output.size) instructionsTaken()
      if (hooks.signal.aborted) return { outcome: "interrupted" }
      const message = errorWords(error) ?? "Cursor stopped with an error."
      const limit = limitOf(message, error)
      if (limit) return { outcome: "failed", error: { type: "limit", message }, limit }
      if (/Cannot use this model/i.test(message)) return { outcome: "failed", error: failure(`Cursor can't run ${input.model.id} with your account. Pick another of its models.`) }
      return { outcome: "failed", error: failure(error) }
    } finally {
      if (this.active === active) this.active = undefined
      clearTimeout(this.idle)
      if (this.worker) this.idle = setTimeout(() => this.active || this.stop(), workerIdle)
    }
  }

  /** Words after a tool begin a new step. */
  private words(lane: Lane) {
    lane.sawText = true
    if (!lane.toolsSinceText) return
    lane.toolsSinceText = false
    lane.turn.endStep()
    lane.turn.startStep()
  }

  /** One of Cursor's updates, in its lane: the turn's own, or a subagent's (`tool-call-delta`). */
  private async update(active: Active, lane: Lane, update: any) {
    const turn = lane.turn
    switch (update?.type) {
      case "text-delta":
        this.words(lane)
        turn.text(update.text ?? "")
        return
      case "thinking-delta":
        this.words(lane)
        turn.reasoning(update.text ?? "")
        return
      case "thinking-completed":
      case "step-completed":
        turn.endBlock()
        return
      case "tool-call-started":
      case "partial-tool-call":
      case "tool-call-completed": {
        const call = update.toolCall ?? {}
        const id = update.callId
        if (!id) return
        const kuvo = kuvoTool(call)
        if (!turn.hasTool(id)) {
          lane.toolsSinceText = true
          if (lane === active) active.told++
          turn.toolStart(id, kuvo.name, kuvo.input)
          if (call.type === "shell") lane.lastShell = id
          // A subagent: a session of its own, which its updates are told in.
          if (call.type === "task" && lane === active) this.subagentLane(active, id, call)
        } else {
          turn.toolCalled(id, kuvo.input)
        }
        if (update.type !== "tool-call-completed") return
        const result = call.result ?? {}
        const value = result.value ?? {}
        const failed = result.status === "error" || (call.type === "mcp" && value.isError)
        const { output, metadata } = toolResult(call, value, lane.output.get(id))
        const subagent = lane === active ? active.subagents.get(id) : undefined
        if (subagent) {
          subagent.run.end(failed ? "failed" : "succeeded", failed ? { type: "agent", message: errorWords(result.error) ?? "The subagent failed." } : undefined)
          active.subagents.delete(id)
        }
        if (failed) turn.toolFailed(id, (typeof output === "string" ? output : "") || errorWords(result.error) || "The tool failed.", metadata)
        else turn.toolSucceeded(id, output, subagent ? { ...metadata, sessionID: subagent.run.sessionID } : metadata)
        return
      }
      case "tool-call-delta": {
        // What a subagent does: in its session.
        const subagent = active.subagents.get(update.callId) ?? (update.callId ? this.subagentLane(active, update.callId, {}) : undefined)
        if (subagent && update.taskUpdate) await this.update(active, subagent, update.taskUpdate)
        return
      }
      case "shell-output-delta": {
        const id = lane.lastShell
        if (!id) return
        const chunk = shellChunk(update.event)
        if (!chunk) return
        const output = ((lane.output.get(id) ?? "") + chunk).slice(-outputLimit)
        lane.output.set(id, output)
        turn.toolProgress(id, { output })
        return
      }
      // Summarizing by itself, as the conversation fills up. (Cursor's SDK 1.0.35 keeps these
      // from its onDelta, so none come yet.)
      case "summary-started":
        turn.compacting()
        return
      case "summary-completed":
        turn.compacted(true)
        return
      case "turn-ended":
        if (lane === active && update.usage) active.usage = update.usage
        return
      case "tool-requests-listed":
        if (lane === active && typeof update.callCount === "number") active.listed += update.callCount
        return
      default:
        if (!cursorUpdates.has(update?.type)) console.error(`Cursor sent ${update?.type}, which Kuvo Code doesn't know.`)
    }
  }

  /** A subagent's session, for its task call: made the first time. */
  private subagentLane(active: Active, id: string, call: any): Lane & { run: SubagentRun } {
    const known = active.subagents.get(id)
    if (known) return known
    const args = call.args ?? {}
    const run = active.hooks.subagent(id, { title: String(args.description ?? "A subagent's task"), prompt: typeof args.prompt === "string" ? args.prompt : undefined, agent: args.subagentType?.kind })
    const lane = { turn: run.turn, toolsSinceText: false, sawText: false, output: new Map<string, string>(), run }
    active.subagents.set(id, lane)
    return lane
  }

  async interrupt() {
    const active = this.active
    if (!active?.run) return
    // Not from inside an update: the SDK would stop the bridge.
    await Bun.sleep(10)
    await active.run.cancel().catch(() => {})
    for (let waited = 0; waited < 10_000 && this.active === active; waited += 100) await Bun.sleep(100)
  }

  /**
   * Cursor's agent run whole in the box's sandbox: its SDK in a process of its own (the engine's
   * Bun) through the launcher, in the session's folder, with its folders (written only where it
   * keeps its conversations, and a folder of its own for its notes, sandbox policies and computer
   * use's), its SDK, the session's skills and attached files to read, and the relay's port for Kuvo
   * Code's tools. Your sign-in stays with the bridge, which hands the agent the key it runs with, and
   * what Cursor keeps run in the bridge (with the sandbox off) out of its reach.
   */
  private async startWorker(options: any): Promise<CursorWorker> {
    const runtime = await this.owner.runtime()
    const directory = this.session.location.directory
    const attached = fenceAttachments(directory)
    const conversations = options.local.store.root as string
    const own = join(this.owner.context.home, "cursor", "in-sandbox")
    for (const folder of [conversations, own]) mkdirSync(folder, { recursive: true, mode: 0o700 })
    const fence = fenceAgent(process.execPath, directory, {
      homes: [conversations, own],
      state: ["*"],
      kept: [],
      read: [runtime, dirname(process.execPath), ...(options.local?.dirs ?? []), ...(attached ? [attached] : [])],
      port: relayPort(),
      session: this.session.id,
      bot: seatBot(this.session),
    })
    if (!fence) throw new Error("Cursor runs in the sandbox here, and it isn't ready: restart Kuvo Code.")
    return new CursorWorker([fence.command, "--config=/dev/null", "--no-env-file", cursorWorker(runtime)], {
      cwd: directory,
      env: {
        ...fence.env,
        // (The engine's runtime, run as Bun.)
        KUVO_FENCE_BUN: "1",
        OPENCODE_SESSION_ID: this.session.id,
        CURSOR_DATA_DIR: join(own, "data"),
        CURSOR_SANDBOX_POLICY_DIR: join(own, "sandbox-policies"),
        CUA_APP_SUPPORT_DIR: join(own, "computer-use"),
      },
      ended: fence.ended,
    })
  }

  /** Its agent stopped, and the worker it ran in (its key to Kuvo Code's tools kept for the next). */
  private stop() {
    clearTimeout(this.idle)
    try {
      this.agent?.close?.()
    } catch {}
    this.agent = undefined
    this.worker?.stop()
    this.worker = undefined
  }

  close() {
    this.stop()
    dropRelayed(this.session.id, this)
  }
}

/** A usage or rate limit in Cursor's error: your plan's. */
function limitOf(message: string, error: any): Limit | undefined {
  const code = String(error?.code ?? error?.name ?? "")
  if (/resource_exhausted|RateLimit/i.test(code) || /resource.?exhausted|usage limit (?:reached|exceeded)|quota exceeded|rate limit exceeded|too many requests/i.test(message)) return { scope: "provider", message }
  return undefined
}

function kuvoTool(call: any): { name: string; input: Record<string, unknown> } {
  const args = call.args ?? {}
  switch (call.type) {
    case "shell":
      return { name: "shell", input: { command: args.command } }
    case "edit":
    case "delete":
      return { name: "edit", input: { path: args.path } }
    case "write":
      return { name: "write", input: { path: args.path, content: args.fileText } }
    case "read":
      return { name: "read", input: { path: args.path } }
    case "glob":
      return { name: "glob", input: { pattern: args.globPattern, path: args.targetDirectory } }
    case "grep":
      return { name: "grep", input: { pattern: args.pattern, path: args.path } }
    case "semSearch":
      return { name: "grep", input: { pattern: args.query } }
    case "ls":
      return { name: "glob", input: { pattern: "*", path: args.path } }
    case "mcp":
      return { name: `${args.providerIdentifier}_${args.toolName}`, input: args.args ?? {} }
    case "updateTodos":
      // Its statuses as the app's ("inProgress" is "in_progress").
      return { name: "todowrite", input: { todos: (args.todos ?? []).map((todo: any) => ({ ...todo, status: todo?.status === "inProgress" ? "in_progress" : todo?.status })) } }
    case "generateImage":
      return { name: "generate_image", input: { prompt: args.prompt ?? args.description } }
    case "readLints":
      return { name: "lints", input: { paths: args.paths } }
    case "recordScreen":
      return { name: "record_screen", input: args }
    case "task":
      return { name: "subagent", input: { description: args.description, prompt: args.prompt, agent: args.subagentType?.kind } }
    case "createPlan":
      return { name: "plan", input: { plan: args.plan } }
  }
  // One its SDK passes through as it came (`{case, value}`).
  return { name: String(call.type ?? call.case ?? "tool"), input: call.args ?? call.value?.args ?? {} }
}

function toolResult(call: any, value: any, streamed?: string): { output: string | ReturnType<typeof withPictures>; metadata?: Record<string, unknown> } {
  const args = call.args ?? {}
  switch (call.type) {
    case "grep":
      return { output: grepText(value).slice(0, outputLimit) }
    case "semSearch":
      return { output: String(value.results ?? "").slice(0, outputLimit) }
    case "ls":
      return { output: treeText(value.directoryTreeRoot).slice(0, outputLimit) }
    case "readLints":
      return {
        output: ((value.fileDiagnostics ?? []) as any[])
          .flatMap((file) => ((file.diagnostics ?? []) as any[]).map((diagnostic) => `${file.path}${diagnostic.range?.start?.line !== undefined ? `:${diagnostic.range.start.line + 1}` : ""}: ${diagnostic.severity ? `${diagnostic.severity}: ` : ""}${diagnostic.message ?? ""}`))
          .join("\n")
          .slice(0, outputLimit) || "No problems.",
      }
    case "task":
      return { output: String(value.resultSuffix ?? lastWords(value.conversationSteps) ?? "").slice(0, outputLimit) }
    case "generateImage":
      return { output: withPictures("", [pictureFile(value.filePath) ?? pictureData(value.imageData, "image/png")]) }
    case "recordScreen":
      return { output: value.path ? `Recorded the screen: ${value.path}` : "Recorded the screen." }
    case "delete":
      return { output: `Deleted ${args.path ?? "the file"}.`, metadata: args.path ? { files: [fileDiff(args.path, "", "")] } : undefined }
    case "shell": {
      const output = [value.stdout, value.stderr].filter((part: unknown) => typeof part === "string" && part).join("\n") || streamed || ""
      return { output: output.slice(-outputLimit), metadata: { output: output.slice(-outputLimit), exit: value.exitCode ?? 0 } }
    }
    case "edit":
      return { output: "", metadata: typeof value.diffString === "string" && value.diffString ? { files: [fromPatch(args.path, value.diffString)] } : undefined }
    case "read":
      return { output: String(value.content ?? "").slice(0, outputLimit) }
    case "glob":
      return { output: (value.files ?? []).join("\n").slice(0, outputLimit) }
    case "mcp":
      return {
        output: withPictures(
          (value.content ?? []).map((part: any) => part?.text?.text ?? "").filter(Boolean).join("\n").slice(0, outputLimit),
          (value.content ?? []).map((part: any) => (part?.image ? pictureData(part.image.data, part.image.mimeType ?? "image/png") : undefined)),
        ),
      }
    case "createPlan":
      return { output: String(args.plan ?? "") }
  }
  if (typeof value === "string") return { output: value.slice(0, outputLimit) }
  return { output: "" }
}

/** What a running command printed, from Cursor's `{case: "stdout" | "stderr" | "exit" | "start", value: {data}}`. */
export function shellChunk(event: any): string {
  if (!event) return ""
  const data = event.case === "stdout" || event.case === "stderr" ? event.value?.data : undefined
  return [data, event.text, event.output, event.data, event.stdout, event.stderr, event.chunk].find((part) => typeof part === "string") ?? ""
}

export { toolResult as cursorToolResult }

/** A grep's matches, as lines (a file and line each, or files, or counts). */
function grepText(value: any): string {
  const results = [...Object.values((value?.workspaceResults ?? {}) as Record<string, any>), value?.activeEditorResult].filter(Boolean)
  const lines: string[] = []
  for (const result of results) {
    const output = result.output ?? {}
    if (result.type === "files") lines.push(...(output.files ?? []).map(String))
    else if (result.type === "count") lines.push(...(output.counts ?? []).map((count: any) => `${count.file ?? count.path ?? ""}: ${count.count ?? count.matches ?? ""}`))
    else for (const match of output.matches ?? []) lines.push(typeof match === "string" ? match : [match.file ?? match.path, match.lineNumber ?? match.line, match.content ?? match.text].filter((part) => part !== undefined && part !== "").join(": "))
  }
  return lines.join("\n")
}

/** A folder listing, as an indented tree. */
function treeText(node: any, depth = 0): string {
  if (!node) return ""
  const indent = "  ".repeat(depth)
  const name = depth === 0 ? (node.absPath ?? "") : String(node.absPath ?? "").split("/").pop()
  const lines = [`${indent}${name}${depth ? "/" : ""}`]
  for (const child of node.childrenDirs ?? []) lines.push(treeText(child, depth + 1))
  for (const file of node.childrenFiles ?? []) lines.push(`${indent}  ${file.name ?? file.path ?? file}`)
  return lines.filter(Boolean).join("\n")
}

/** A subagent's last words, from its steps. */
function lastWords(steps: unknown): string | undefined {
  for (const step of [...((Array.isArray(steps) ? steps : []) as any[])].reverse()) {
    const text = step?.assistantMessage?.text ?? step?.text ?? (step?.type === "assistant" ? step?.content : undefined)
    if (typeof text === "string" && text.trim()) return text
  }
  return undefined
}

/** An error, in words (never "[object Object]"). */
function errorWords(error: any): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return error
  if (typeof error.message === "string" && error.message) return error.message
  if (typeof error.error === "string" && error.error) return error.error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Cursor's updates: shown or used (words, thinking, tools, a subagent's, command output,
 * summaries, its tool list) or left out on purpose (token counts, step starts, your own message
 * echoed). A test checks its SDK's list against this.
 */
export const cursorUpdates = new Set([
  "text-delta", "thinking-delta", "thinking-completed", "step-completed", "tool-call-started", "partial-tool-call", "tool-call-completed",
  "tool-call-delta", "shell-output-delta", "summary", "summary-started", "summary-completed", "turn-ended", "tool-requests-listed",
  "token-delta", "step-started", "user-message-appended",
])

/** Cursor's tools its SDK tells, each shown with what it did. */
export const cursorTools = new Set(["shell", "write", "delete", "glob", "grep", "read", "edit", "ls", "readLints", "mcp", "generateImage", "recordScreen", "semSearch", "createPlan", "updateTodos", "task"])

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([promise, Bun.sleep(milliseconds).then(() => Promise.reject(new TookTooLong("Cursor didn't answer in time.")))])
}
