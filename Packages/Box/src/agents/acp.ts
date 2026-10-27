// Agents that speak ACP, the Agent Client Protocol (Grok's CLI, Antigravity), as T3 Code drives
// them: one agent process per session, `initialize`, a session it can load again later, a prompt
// per turn, and what it does told in `session/update`s. Each agent says how it starts, signs in,
// picks a model, and anything of its own.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { OwnTurn, RunInput, RunResult, Thread, TurnHooks, SubagentRun, SubagentTask } from "./agent"
import { failure } from "./agent"
import { resetsIn, type Limit } from "./auto"
import { fileDiff } from "./diff"
import { newID } from "./ids"
import { RPC, RPCError } from "./rpc"
import { isKuvoTool, kuvoToolName, kuvoTools, loadKuvoTools, toolServerName } from "./kuvotools"
import { pictureData, withPictures } from "./pictures"
import { elicitationField } from "./forms"
import type { Turn } from "./turn"
import type { Decision, FormField, Session, TokenUsage } from "./wire"

const outputLimit = 30_000
/** An agent's words for a usage limit (not any error that mentions a quota). */
const limitWords = /RESOURCE_EXHAUSTED|usage limit (?:reached|exceeded)|quota exceeded|exceeded your (?:current )?quota|rate limit exceeded|too many requests/i

export interface AcpFlavor {
  /** The command that starts the agent, for this session's approval mode (and its skills folder, from `skills`). */
  command(options: { approvesAll: boolean; plan: boolean; skills?: string }): Promise<{
    argv: string[]
    env?: Record<string, string | undefined>
    cleanEnv?: boolean
    cwd?: string
    onExit?: () => void
    /** A file the agent writes when it wants you to sign in (its "browser" writes the page down): it can't go on. */
    signInFile?: string
  }>
  /**
   * Settings › Skills' skills for a session, made ready for the agent as it starts: a folder of
   * them (see skills.ts), or what stands for them (a different one starts it again).
   */
  skills?(directory: string, hooks: TurnHooks): Promise<string | undefined>
  /** Whether the agent may read and write files through the bridge (it asks first itself). */
  fileSystem: boolean
  /** `_meta` sent with `initialize`. */
  initializeMeta?: Record<string, unknown>
  /** The way to sign in, when it asks (`authenticate`). */
  authMethod(advertised: { id: string }[]): string | undefined
  /** Sign in before the first session, rather than when it asks. */
  authenticatesFirst?: boolean
  /** Prefer `session/resume` over `session/load` (which replays the conversation). */
  resumes?: boolean
  /** Selects the model the session is to use, and its effort (`variant`) where the agent has one. */
  selectModel(rpc: RPC, sessionID: string, modelID: string, setup: any, variant?: string): Promise<void>
  /**
   * Sets the mode the turn needs (Antigravity's yolo, default…), if the agent has one. Throws when
   * it can't, and the one it's in would do more without asking than the turn may.
   */
  selectMode?(rpc: RPC, sessionID: string, options: { approvesAll: boolean; plan: boolean }, setup: any): Promise<void>
  /** A line the agent writes that isn't ACP (a sign-in link): false to drop it. */
  filter?(line: string): boolean
  /** A line that means the agent can't go on (it wants a sign-in): why, in words. */
  fatalLine?(line: string): string | undefined
  /** Its whole answer is its plan's limit, which it says in a reply and ends as done (Antigravity). */
  limitReply?(text: string): boolean
  /**
   * A line saying its sign-in is gone (it asks for a new one). Partway through a run, its access
   * ran out and it didn't renew it: started again, it renews it from the sign-in it keeps, once
   * per turn. One that asks as it starts has lost it: `signInEnded`.
   */
  asksSignIn?(line: string): boolean
  signInEnded?(): void
  /** Requests of the agent's own (`x.ai/ask_user_question`…). */
  request?(method: string, params: any, context: AcpContext): Promise<unknown> | undefined
  /** Notifications of the agent's own; true when one ended the prompt. */
  notification?(method: string, params: any, context: AcpContext): void
  /** `_meta` for a prompt. */
  promptMeta?(): Record<string, unknown> | undefined
  /** Restart the agent after a stop (it can't stop a turn and go on). */
  restartAfterInterrupt?: boolean
  /** What a usage limit holds back: the whole account (the default), or the model. */
  limitScope?: "provider" | "model"
  /**
   * Follows what the agent writes down itself but doesn't tell (Antigravity's subagents and their
   * steps), for the turn under way; stopped, after a last look, as the turn ends.
   */
  follow?(sessionId: string, turn: Turn, hooks: TurnHooks): { stop(): void } | undefined
  /** A tool call that isn't worth a row (Antigravity's start of subagents, which `follow` shows). */
  hides?(call: any): boolean
  /** Files a finished tool call made that it doesn't hand back (Antigravity's generated images). */
  madeFiles?(call: any, sessionId: string, since: number): { type: "file"; uri: string; mime: string; name?: string }[]
  /** Changes when the agent's program was updated: a process started before starts again. */
  program?(): number
  /** How much the model holds, as the agent said (a usage update's size). */
  noteContext?(model: string, size: number): void
}

export interface AcpContext {
  turn?: Turn
  hooks?: TurnHooks
  /** Ends the prompt under way, as its response would. */
  endPrompt(stopReason: string, error?: string, promptID?: string): void
  /** Ends a turn the agent began on its own (Grok's prompt after a task of its own completed). */
  endOwn(): void
}

interface Active {
  turn: Turn
  hooks: TurnHooks
  resolve: (result: RunResult) => void
  /** The agent process it runs on. */
  rpc: RPC
  /** Its to-do list's tool call, kept up to date until the turn ends. */
  plan?: { id: string; todos: unknown[] }
  /** Tool calls as the agent last told them, merged update by update. */
  tools: Map<string, any>
  toolsSinceText: boolean
  ended: boolean
  /** The app's instructions this message carries: kept as sent once the agent took it. */
  instructed?: { value: string }
  /** The agent said something about this prompt. */
  heard?: boolean
  /** What it said since its last tool: how its answer ends. */
  said?: string
  /** What the turn runs with, to start the agent again partway (its sign-in renewed). */
  input?: RunInput
  renewed?: boolean
  /** The process it was renewed from: what was asked of it isn't the turn's end. */
  replaced?: RPC
  /** The prompt came back answered (not turned away). */
  answered?: boolean
  /** How much of its context the conversation fills, as the agent last said (usage_update). */
  used?: number
  /** What follows the agent's own record of the turn, when it keeps one. */
  follower?: { stop(): void }
  /** A turn the agent began on its own, taken here: it ends when it says, or goes quiet. */
  own?: boolean
  quiet?: ReturnType<typeof setTimeout>
  compacted?: boolean
  /**
   * Files the agent had Kuvo Code read for it (Antigravity's file viewer), by path, not yet matched
   * to the tool call that read them: the agent says its reads are done only as the turn ends.
   */
  served: Map<string, { text?: string; error?: string }[]>
  /** When it began (ms). */
  started: number
  /** What Kuvo Code last refused it on its own (your settings, not you), since it was last told. */
  refused?: string
  /** Its calls Kuvo Code said no to: failed with this, unless it says how they ended. */
  declined?: Map<string, string>
  /** The prompt under way (each "carry on" is a new one): what an older one says isn't its end. */
  prompt: number
  promptID?: string
  /** How many times it was told to carry on after a refusal this turn. */
  carriedOn?: number
  /** Sessions of its subagents (updates for another session of the agent's), by that session. */
  children: Map<string, { run: SubagentRun; row: string; toolsSinceText: boolean; tools: Map<string, any> } | { prompt: string }>
}

/** How long a turn the agent began on its own goes with nothing from it before it's over. */
/** `signInGrace`: a process that asks for a sign-in sooner than this after it started has lost it. */
export const acpTiming = { ownQuiet: 20_000, signInGrace: 60_000 }

export class AcpThread implements Thread {
  private rpc?: RPC
  private sessionID?: string
  private setup: any
  private spawnedWith?: string
  private active?: Active
  private loading = false
  /** A process that was stopped mid-turn and can't go on: the next message starts another. */
  private stale?: RPC
  /** The conversation it had couldn't be picked up again: a new one took its place. */
  private startedOver = false
  onOwnTurn?: (note: OwnTurn) => boolean
  /** Updates of a turn the agent began on its own, until a turn here takes them; or turned away. */
  private own?: { updates: any[]; turnedAway: boolean; ended?: boolean; quiet?: ReturnType<typeof setTimeout>; started: number }

  constructor(
    private readonly flavor: AcpFlavor,
    private readonly session: Session,
    private readonly state: Record<string, unknown>,
    private readonly name: string,
  ) {}

  private async open(input: RunInput, hooks: TurnHooks) {
    const skills = await this.flavor.skills?.(this.session.location.directory, hooks)
    const mode = { approvesAll: hooks.approvesAll(), plan: input.plan, skills }
    // Kuvo Code's tools moving (the app started again) starts it again too, to reach them; so do
    // other skills.
    const key = JSON.stringify({ ...mode, program: this.flavor.program?.() ?? 0, tools: kuvoTools(this.session.id)?.key })
    if (this.rpc && !this.rpc.isClosed && this.spawnedWith === key && this.rpc !== this.stale) return this.rpc
    // Started again for another approval mode (the agent takes it as it starts), or an updated program.
    this.close()
    const launch = await this.flavor.command(mode)
    const flavor = this.flavor
    const startedAt = Date.now()
    let asksSignIn = false
    const rpc: RPC = new RPC(launch.argv, {
      cwd: launch.cwd ?? this.session.location.directory,
      // Its commands know their conversation, as the engine's do (kuvo-wake schedules for it).
      env: { ...launch.env, OPENCODE_SESSION_ID: this.session.id },
      cleanEnv: launch.cleanEnv,
      jsonrpc: true,
      firstID: 2 ** 30,
      filter: (line) => {
        if (!asksSignIn && flavor.asksSignIn?.(line)) {
          asksSignIn = true
          setTimeout(() => {
            rpc.stderr = `${this.name} needs you to sign in again: Settings › Accounts.`
            rpc.kill()
          })
          return false
        }
        const fatal = flavor.fatalLine?.(line)
        if (fatal) {
          // What's waiting on it fails with this, rather than what it last wrote.
          setTimeout(() => {
            rpc.stderr = fatal
            rpc.kill()
          })
          return false
        }
        return flavor.filter?.(line) ?? true
      },
    })
    rpc.onNotification = (method, params) => this.notification(method, params)
    rpc.onRequest = (method, params) => this.request(method, params)
    rpc.onExit = () => {
      launch.onExit?.()
      if (this.rpc === rpc) this.rpc = undefined
      // Asked for a new sign-in as it started: the one it keeps is gone.
      const young = Date.now() - startedAt < acpTiming.signInGrace
      if (asksSignIn && young) flavor.signInEnded?.()
      // The turn this process ran, not one a newer process runs.
      const active = this.active
      if (!active || active.ended || active.rpc !== rpc) return
      if (asksSignIn && !young && !active.renewed && active.input) {
        active.renewed = true
        active.replaced = rpc
        void this.renew(active, active.input)
        return
      }
      this.end(active, "failed", rpc.stderr.trim().split("\n").slice(-3).join("\n") || `${this.name} stopped.`)
    }
    this.rpc = rpc
    this.spawnedWith = key
    if (launch.signInFile) {
      const file = launch.signInFile
      const watch = setInterval(() => {
        if (rpc.isClosed) return clearInterval(watch)
        if (!existsSync(file)) return
        clearInterval(watch)
        // (Asking for a sign-in, as its line does.)
        asksSignIn = true
        rpc.stderr = `${this.name} needs you to sign in again: Settings › Accounts.`
        rpc.kill()
      }, 500)
    }
    try {
      const init: any = await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: this.flavor.fileSystem, writeTextFile: this.flavor.fileSystem }, terminal: false },
          clientInfo: { name: "kuvo-code", title: "Kuvo Code", version: "1" },
          ...(this.flavor.initializeMeta ? { _meta: this.flavor.initializeMeta } : {}),
        },
        120_000,
      )
      const advertised = (init?.authMethods ?? []) as { id: string }[]
      const authenticate = async () => {
        const methodId = this.flavor.authMethod(advertised)
        if (!methodId) throw new Error(`${this.name} isn't signed in. Sign in again in Settings › Accounts.`)
        await rpc.request("authenticate", { methodId }, 300_000)
      }
      if (this.flavor.authenticatesFirst) await authenticate()
      const cwd = this.session.location.directory
      const previous = this.state.acpSession as string | undefined
      const openSession = async () => {
        if (previous && this.flavor.resumes && init?.agentCapabilities?.sessionCapabilities?.resume) {
          this.loading = true
          try {
            this.setup = await rpc.request("session/resume", { sessionId: previous, cwd, mcpServers: this.mcpServers(init) }, 120_000)
            this.sessionID = previous
            return
          } catch {} finally {
            this.loading = false
          }
        }
        if (previous && init?.agentCapabilities?.loadSession) {
          // What it replays of the conversation is already here.
          this.loading = true
          try {
            this.setup = await rpc.request("session/load", { sessionId: previous, cwd, mcpServers: this.mcpServers(init) }, 120_000)
            this.sessionID = previous
            return
          } catch {} finally {
            this.loading = false
          }
        }
        this.setup = await rpc.request("session/new", { cwd, mcpServers: this.mcpServers(init) }, 120_000)
        this.sessionID = this.setup?.sessionId
        if (previous && previous !== this.sessionID) {
          // In place of one it had: the instructions go again, and what came before is handed over.
          this.startedOver = true
          delete this.state.acpInstructions
          delete this.state.acpInstructed
        }
        this.state.acpSession = this.sessionID
        hooks.saveState()
      }
      try {
        await openSession()
      } catch (error) {
        if (!(error instanceof RPCError && error.code === -32000)) throw error
        await authenticate()
        await openSession()
      }
    } catch (error) {
      // It couldn't get its session going: the next message starts it again.
      if (this.rpc === rpc) this.close()
      throw error
    }
    return rpc
  }

  /** Kuvo Code's own tools, for an agent that takes MCP servers over HTTP. */
  private mcpServers(init: any): unknown[] {
    const tools = kuvoTools(this.session.id)
    if (!tools || (tools.kind === "http" && !init?.agentCapabilities?.mcpCapabilities?.http)) return []
    // Their names and arguments, to know their calls when they come.
    void loadKuvoTools()
    if (tools.kind === "stdio") return [{ name: tools.name, command: tools.command, args: tools.args, env: Object.entries(tools.env).map(([name, value]) => ({ name, value })) }]
    return [{ type: "http", name: tools.name, url: tools.url, headers: Object.entries(tools.headers).map(([name, value]) => ({ name, value })) }]
  }

  /**
   * Its access ran out partway and it asked for a new sign-in: started again, it renews it from the
   * sign-in it keeps, takes up its conversation, and carries on with the turn.
   */
  private async renew(active: Active, input: RunInput) {
    try {
      const rpc = await this.open(input, active.hooks)
      active.rpc = rpc
      if (active.ended) return
      if (active.hooks.signal.aborted) return this.end(active, "interrupted")
      // Its conversation couldn't be taken up: told to carry on, it wouldn't know with what.
      if (this.startedOver) return this.end(active, "failed", `${this.name} started again and couldn't take up this conversation. Send your message again.`)
      const sessionId = this.sessionID!
      await this.flavor.selectModel(rpc, sessionId, input.model.id, this.setup, input.model.variant).catch(() => {})
      // A mode it can't be put in (asking first) stops the turn, rather than going on in another.
      await this.flavor.selectMode?.(rpc, sessionId, { approvesAll: active.hooks.approvesAll(), plan: input.plan }, this.setup)
      if (active.ended) return
      this.prompt(active, sessionId, [{ type: "text", text: "<system-reminder>Your connection was renewed partway through your work, and what was under way then was cut off. Carry on with the task from where you were.</system-reminder>" }])
    } catch (error) {
      this.end(active, "failed", failure(error).message)
    }
  }

  async prepare(input: RunInput, hooks: TurnHooks) {
    await this.open(input, hooks)
    const fresh = this.startedOver
    this.startedOver = false
    return { fresh }
  }

  async run(input: RunInput, turn: Turn, hooks: TurnHooks): Promise<RunResult> {
    if (input.adopt) return this.adopt(turn, hooks)
    this.own = undefined
    const rpc = await this.open(input, hooks)
    // Kuvo Code's tools' names, known before the agent calls one (a call is shown by its name from the start).
    await loadKuvoTools()
    // Stopped while the agent was starting.
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    const sessionId = this.sessionID!
    await this.flavor.selectModel(rpc, sessionId, input.model.id, this.setup, input.model.variant).catch(() => {})
    // A mode it can't be put in (asking first) stops the turn, rather than going on in another.
    try {
      await this.flavor.selectMode?.(rpc, sessionId, { approvesAll: hooks.approvesAll(), plan: input.plan }, this.setup)
    } catch (error) {
      return { outcome: "failed", error: failure(error) }
    }
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    const prompt: any[] = []
    const others: string[] = []
    for (const file of input.files) {
      const data = file.data ?? (file.mime.startsWith("image/") && file.path ? safeBase64(file.path) : undefined)
      if (file.mime.startsWith("image/") && data) prompt.push({ type: "image", data, mimeType: file.mime })
      else if (file.path) others.push(file.path)
    }
    let text = input.text
    const instructions = hooks.instructions()
    // The agent's own instructions can't be added to: they go with the first message, and again
    // when they change (a worktree, the project's other folders).
    const sent = typeof this.state.acpInstructions === "string" ? this.state.acpInstructions : this.state.acpInstructed ? undefined : ""
    let instructed: { value: string } | undefined
    if (instructions !== sent && (instructions || sent)) {
      if (instructions) text = `${sent ? "Your instructions from Kuvo Code changed. They're now:\n\n" : ""}${instructions}\n\n${text}`
      instructed = { value: instructions }
    }
    if (others.length) text += `\n\nAttached files:\n${others.map((path) => `- ${path}`).join("\n")}`
    prompt.unshift({ type: "text", text })
    return new Promise<RunResult>((resolve) => {
      const active: Active = { turn, hooks, resolve, rpc, tools: new Map(), toolsSinceText: false, ended: false, instructed, children: new Map(), served: new Map(), started: Date.now(), prompt: 0, input }
      this.active = active
      turn.startStep()
      active.follower = this.flavor.follow?.(sessionId, turn, hooks)
      this.prompt(active, sessionId, prompt)
    })
  }

  /** Sends a prompt of the turn's; its answer ends the turn, unless a newer one went meanwhile. */
  private prompt(active: Active, sessionId: string, prompt: any[]) {
    const number = ++active.prompt
    const meta = this.flavor.promptMeta?.()
    active.promptID = typeof meta?.promptId === "string" ? meta.promptId : undefined
    const sentOn = active.rpc
    active.rpc.request("session/prompt", { sessionId, prompt, ...(meta ? { _meta: meta } : {}) }).then(
      (result: any) => {
        if (number !== active.prompt) return
        active.answered = true
        if (result?.stopReason === "rate_limit") this.end(active, "failed", `You've reached your ${this.name} usage limit for now.`, this.limit())
        else this.end(active, result?.stopReason === "cancelled" ? "interrupted" : "succeeded")
      },
      (error) => {
        if (number !== active.prompt || active.replaced === sentOn) return
        const limited = (error instanceof RPCError && error.code === -32003) || limitWords.test(errorText(error))
        this.end(active, "failed", limited ? `You've reached your ${this.name} usage limit for now.` : errorText(error), limited ? this.limit(errorText(error)) : undefined)
      },
    )
  }

  /**
   * It stopped because Kuvo Code refused a tool by your settings (it takes any no as yours, and
   * stops for you): it's told why, and carries on, as the engine's models do. False when it
   * wasn't that (a no of yours, Stop), or it was told a few times already this turn.
   */
  private carryOn(active: Active): boolean {
    const refused = active.refused
    if (!refused || active.own || active.hooks.signal.aborted || !this.sessionID || (active.carriedOn ?? 0) >= 3) return false
    active.refused = undefined
    active.carriedOn = (active.carriedOn ?? 0) + 1
    this.prompt(active, this.sessionID, [{ type: "text", text: `<system-reminder>Kuvo Code didn't allow ${refused}: the user's settings (Settings › Permissions, the session's agent, or Plan mode) don't allow it here. The user didn't stop you. Carry on with the task without it, or say what you'd need.</system-reminder>` }])
    return true
  }

  private limit(message?: string): Limit {
    const resetsAt = resetsIn(message)
    return { scope: this.flavor.limitScope ?? "provider", message, ...(resetsAt ? { resetsAt } : {}) }
  }

  private end(active: Active, outcome: RunResult["outcome"], message?: string, limit?: Limit) {
    if (active.ended) return
    // Done, having run nothing, with an answer that only says its plan is at its limit: that limit.
    if (outcome === "succeeded" && !active.own && !active.tools.size && active.said && this.flavor.limitReply?.(active.said)) {
      outcome = "failed"
      limit = this.limit(active.said)
      message = `You've reached your ${this.name} usage limit for now.`
    }
    if (outcome === "interrupted" && this.carryOn(active)) return
    active.ended = true
    // The instructions went with a message it took (not one turned away before it said anything).
    if (active.instructed && (outcome !== "failed" || active.heard)) {
      this.state.acpInstructions = active.instructed.value
      delete this.state.acpInstructed
      active.hooks.saveState()
    }
    if (this.active === active) this.active = undefined
    clearTimeout(active.quiet)
    if (active.plan) active.turn.toolSucceeded(active.plan.id, "", { todos: active.plan.todos })
    active.follower?.stop()
    // Its subagents are done when it is.
    for (const child of active.children.values()) if ("run" in child) {
      active.turn.toolSucceeded(child.row, "", { sessionID: child.run.sessionID })
      child.run.end(outcome === "failed" ? "interrupted" : outcome)
    }
    // Calls it was told no to and never ended; reads it never said the file of.
    for (const [id, message] of active.declined ?? []) active.turn.toolFailed(id, message)
    this.settleReads(active, true)
    active.turn.endStep({ tokens: this.stepTokens(active) })
    if (active.hooks.signal.aborted) active.resolve({ outcome: "interrupted" })
    // It had the message when it said something about it, or answered the prompt itself.
    else if (limit) active.resolve({ outcome: "failed", error: { type: "limit", message: message ?? `You've reached your ${this.name} usage limit for now.` }, limit, taken: active.heard || active.answered })
    else active.resolve(outcome === "failed" ? { outcome, error: failure(message ?? `${this.name} stopped with an error.`), taken: active.heard || active.answered } : { outcome })
  }

  private context(): AcpContext {
    const active = this.active
    return {
      turn: active?.turn,
      hooks: active?.hooks,
      endPrompt: (stopReason, error, promptID) => {
        // (One an earlier prompt of the turn's said: not this one's end.)
        if (active && promptID && active.promptID && promptID !== active.promptID) return
        if (active && !active.own) this.end(active, error ? "failed" : stopReason === "cancelled" ? "interrupted" : "succeeded", error, stopReason === "rate_limit" ? this.limit(error) : undefined)
      },
      endOwn: () => {
        if (active?.own) this.end(active, "succeeded")
        // Over before it was taken: the turn that takes it ends with what it said.
        else if (this.own && !this.own.turnedAway) this.own.ended = true
        else if (this.own) this.own = undefined
      },
    }
  }

  /** A turn the agent began on its own: taken here, with what it said so far. */
  private adopt(turn: Turn, hooks: TurnHooks): Promise<RunResult> {
    const own = this.own
    this.own = undefined
    const rpc = this.rpc
    if (!own || own.turnedAway || !rpc) return Promise.resolve({ outcome: "succeeded" })
    return new Promise<RunResult>((resolve) => {
      const active: Active = { turn, hooks, resolve, rpc, tools: new Map(), toolsSinceText: false, ended: false, children: new Map(), served: new Map(), started: own.started, prompt: 0, own: true }
      this.active = active
      turn.startStep()
      if (this.sessionID) active.follower = this.flavor.follow?.(this.sessionID, turn, hooks)
      this.quietly(active)
      for (const update of own.updates) this.notification("session/update", update)
      if (own.ended && this.active === active) this.end(active, "succeeded")
    })
  }

  private noticed = new Set<string>()

  private noticeOnce(active: Active, key: string, text: string) {
    if (this.noticed.has(key)) return
    this.noticed.add(key)
    active.turn.notice(text)
  }

  /** An own turn with nothing more from the agent for a while: over. */
  private quietly(active: Active) {
    clearTimeout(active.quiet)
    active.quiet = setTimeout(() => {
      if (this.active === active) this.end(active, "succeeded")
    }, acpTiming.ownQuiet)
  }

  private notification(method: string, params: any) {
    if (method !== "session/update") {
      this.flavor.notification?.(method, params, this.context())
      return
    }
    const active = this.active
    // What a load replays is already in the conversation.
    if (this.loading || params?._meta?.isReplay) return
    const update = params?.update ?? {}
    const ours = !params?.sessionId || !this.sessionID || params.sessionId === this.sessionID
    // Nothing under way here: a turn the agent began on its own (Grok after a task of its own).
    if (!active) {
      if (ours && this.sessionID) this.ownUpdate(params, update)
      return
    }
    if (active.own) this.quietly(active)
    // Another session's: a subagent's (where the agent keeps it on this connection), in its session.
    if (!ours) return this.childUpdate(active, String(params.sessionId), update)
    active.heard = true
    const turn = active.turn
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        active.said = ((active.toolsSinceText ? "" : active.said) ?? "").concat(contentText(update.content)).slice(-2_000)
        this.words(active)
        this.content(active, turn, update.content, "text")
        return
      case "agent_thought_chunk":
        this.words(active)
        this.content(active, turn, update.content, "reasoning")
        return
      case "tool_call":
      case "tool_call_update":
        return this.tool(active, update)
      case "usage_update":
        if (typeof update.used === "number") active.used = update.used
        if (typeof update.size === "number") this.flavor.noteContext?.(turn.currentModel.id, update.size)
        // What it cost, when it says (in dollars).
        if (typeof update.cost?.amount === "number" && (update.cost.currency ?? "USD") === "USD") this.cost(turn, update.cost.amount)
        return
      case "current_mode_update":
        if (this.setup && update.currentModeId) this.setup.kuvoMode = update.currentModeId
        if (update.currentModeId) turn.notice(`${this.name} switched to its ${update.currentModeId} mode.`)
        return
      case "config_option_update":
        if (this.setup && Array.isArray(update.configOptions)) this.setup.configOptions = update.configOptions
        return
      case "notice":
        if (typeof update.message === "string" || typeof update.text === "string") turn.notice(String(update.message ?? update.text))
        return
      case "compaction_update":
      case "compaction_summary_chunk":
        if (!active.compacted) turn.notice(`${this.name} summarized the conversation to make room.`)
        active.compacted = true
        return
      case "user_message_chunk":
      case "available_commands_update":
      case "session_info_update":
        return
      case "plan": {
        // One to-do list a turn, brought up to date as the agent works through it.
        const todos = (update.entries ?? []).map((entry: any) => ({ content: entry.content, status: entry.status === "in_progress" ? "in_progress" : entry.status }))
        // Its own for each attempt: Auto may go on with another agent in the same turn.
        const id = active.plan?.id ?? newID("call")
        active.plan = { id, todos }
        if (!turn.hasTool(id)) turn.toolStart(id, "todowrite", { todos })
        else turn.toolCalled(id, { todos })
        return
      }
      default: {
        // A kind this bridge doesn't know (a newer agent's): its words shown, and logged.
        const words = contentText(update.content) || (typeof update.message === "string" ? update.message : "")
        if (words.trim()) turn.notice(words.trim())
        console.error(`${this.name} sent ${update.sessionUpdate}, which Kuvo Code doesn't know.`)
      }
    }
  }

  /** What the agent said, with pictures (one it made or sends) shown as such, and links as links. */
  private content(active: Active, turn: Turn, content: any, kind: "text" | "reasoning") {
    const picture = content?.type === "image" ? pictureData(content.data, content.mimeType) : content?.type === "resource" && content.resource?.blob ? pictureData(content.resource.blob, content.resource.mimeType) : undefined
    if (picture) {
      const id = newID("call")
      active.toolsSinceText = true
      turn.toolStart(id, "generate_image", {})
      turn.toolSucceeded(id, withPictures("", [picture]))
      return
    }
    const text = content?.type === "resource_link" ? `[${content.name ?? content.title ?? content.uri}](${content.uri})` : content?.type === "audio" ? "(a sound clip)" : contentText(content)
    if (kind === "text") turn.text(text)
    else turn.reasoning(text)
  }

  /** A subagent's session's update (the agent keeps its subagents as sessions of their own). */
  private childUpdate(active: Active, sessionId: string, update: any) {
    let child = active.children.get(sessionId)
    // Its task comes first, as its "user" message: kept for its session.
    if (!child || "prompt" in child) {
      if (update.sessionUpdate === "user_message_chunk") {
        active.children.set(sessionId, { prompt: ((child as { prompt: string } | undefined)?.prompt ?? "") + contentText(update.content) })
        return
      }
      const prompt = (child as { prompt: string } | undefined)?.prompt?.trim()
      const row = `acp-subagent:${sessionId}`
      active.toolsSinceText = true
      active.turn.toolStart(row, "subagent", { description: firstLine(prompt) || "A subagent's task", prompt })
      const run = active.hooks.subagent(row, { title: firstLine(prompt) || "A subagent's task", prompt })
      child = { run, row, toolsSinceText: false, tools: new Map() }
      active.children.set(sessionId, child)
    }
    const turn = child.run.turn
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        turn.text(contentText(update.content))
        return
      case "agent_thought_chunk":
        turn.reasoning(contentText(update.content))
        return
      case "tool_call":
      case "tool_call_update": {
        const id = update.toolCallId
        if (!id) return
        const merged = { ...(child.tools.get(id) ?? {}), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) }
        child.tools.set(id, merged)
        const kuvo = kuvoTool(merged)
        if (!turn.hasTool(id)) turn.toolStart(id, kuvo.name, kuvo.input)
        const { text, pictures } = toolOutput(merged)
        if (merged.status === "completed") turn.toolSucceeded(id, withPictures(text, pictures))
        else if (merged.status === "failed") turn.toolFailed(id, text || "The tool failed.")
        return
      }
    }
  }

  /** An update with no turn here: the start of one the agent began on its own asks the session to take it. */
  private ownUpdate(params: any, update: any) {
    const known = this.own
    if (known) {
      if (!known.turnedAway) known.updates.push(params)
      else this.forget(known)
      return
    }
    if (!["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(update.sessionUpdate)) return
    const own = { updates: [params], turnedAway: false, started: Date.now() }
    this.own = own
    if (!(this.onOwnTurn?.({ text: `${this.name} carried on by itself.` }) ?? false)) this.turnAway()
  }

  /** A turn it began on its own that isn't taken: it stops (nothing would show what it does). */
  turnAway() {
    const own = this.own
    if (!own || own.turnedAway) return
    own.turnedAway = true
    if (this.rpc && this.sessionID) this.rpc.notify("session/cancel", { sessionId: this.sessionID })
    this.forget(own)
  }

  /** One turned away is let go once the agent has been quiet a while: what it begins next is asked about again. */
  private forget(own: NonNullable<AcpThread["own"]>) {
    clearTimeout(own.quiet)
    own.quiet = setTimeout(() => {
      if (this.own === own) this.own = undefined
    }, acpTiming.ownQuiet)
    ;(own.quiet as any).unref?.()
  }

  /** Words after a tool begin a new step. */
  private words(active: Active) {
    if (!active.toolsSinceText) return
    active.toolsSinceText = false
    this.settleReads(active, false)
    active.turn.endStep({ tokens: this.stepTokens(active) })
    active.turn.startStep()
  }

  /**
   * Its reads are over by now (Antigravity says so only as the turn ends): one Kuvo Code read for
   * it shows what was read, one of a file that isn't there failed, the rest are done. One it
   * hasn't said the file of yet waits for it (`all`: not as the turn ends).
   */
  private settleReads(active: Active, all: boolean) {
    if (!this.flavor.fileSystem) return
    for (const [id, call] of active.tools) {
      if (!this.openRead(call) || call.settled) continue
      const path = this.readPath(call)
      if (!path && !all) continue
      const served = path && clientRead(call) ? active.served.get(path)?.shift() : undefined
      this.settleRead(active, id, served ?? (path && !existsSync(path) ? { error: "There's no such file." } : { text: "" }))
    }
  }

  /** The file a read is of, as a full path (in the session's folder, when it names it from there). */
  private readPath(call: any): string | undefined {
    const raw = call.rawInput ?? {}
    const path = call.locations?.[0]?.path ?? raw.absolute_path ?? raw.path ?? raw.file_path ?? raw.filePath
    return typeof path === "string" && path ? resolve(this.session.location.directory, path) : undefined
  }

  /** A step's tokens, as the context gauge reads them: what the conversation fills, as the agent said. */
  private stepTokens(active: Active): TokenUsage | undefined {
    return active.used === undefined ? undefined : { input: active.used, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  }

  /**
   * What the conversation has cost so far, as the agent says (ACP's cost is the session's whole,
   * said again as it grows): what's new since it last said is this turn's. (Less than before: a
   * conversation it started counting again.)
   */
  private cost(turn: Turn, total: number) {
    const kept = this.state.acpCost as { session?: string; amount?: number } | undefined
    const before = kept?.session === this.sessionID ? (kept?.amount ?? 0) : 0
    this.state.acpCost = { session: this.sessionID, amount: total }
    turn.addUsage(undefined, total >= before ? total - before : total)
  }

  private tool(active: Active, update: any) {
    const turn = active.turn
    const id = update.toolCallId
    if (!id) return
    const merged = { ...(active.tools.get(id) ?? {}), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) }
    active.tools.set(id, merged)
    if (this.flavor.hides?.(merged)) return
    // A read already shown with what Kuvo Code read for it: the agent's own "done" (empty) changes nothing.
    if (merged.settled) return
    const kuvo = kuvoTool(merged)
    if (!turn.hasTool(id)) {
      active.toolsSinceText = true
      turn.toolStart(id, kuvo.name, kuvo.input)
    } else {
      turn.toolRename(id, kuvo.name)
      // Its input, also when it comes only as the call ends.
      if ((merged.status !== "completed" && merged.status !== "failed") || update.rawInput !== undefined) turn.toolCalled(id, kuvo.input)
    }
    const { text: output, pictures } = toolOutput(merged)
    const files = (merged.content ?? [])
      .filter((part: any) => part?.type === "diff" && part.path)
      .map((part: any) => fileDiff(part.path, part.oldText ?? undefined, part.newText ?? ""))
    const metadata: Record<string, unknown> = {}
    if (files.length) metadata.files = files
    const exit = merged.rawOutput?.exit_code ?? merged.rawOutput?.exitCode
    if (typeof exit === "number") metadata.exit = exit
    if (output) metadata.output = output
    const made = merged.status === "completed" && this.sessionID ? (this.flavor.madeFiles?.(merged, this.sessionID, active.started) ?? []) : []
    if (merged.status === "completed") turn.toolSucceeded(id, withPictures(output, [...pictures, ...made]), metadata)
    else if (merged.status === "failed") turn.toolFailed(id, output || "The tool failed.", metadata)
    else if (merged.status === "cancelled") turn.toolFailed(id, output || active.declined?.get(id) || "Stopped.", metadata)
    else if (output) turn.toolProgress(id, metadata)
    // A file Kuvo Code read for it before it said which call read it.
    const path = this.openRead(merged) && clientRead(merged) ? this.readPath(merged) : undefined
    const served = path ? active.served.get(path)?.shift() : undefined
    if (served) this.settleRead(active, id, served)
  }

  private openRead(call: any): boolean {
    return call.kind === "read" && call.status !== "completed" && call.status !== "failed"
  }

  /** A read shown done, with what was read (or why it couldn't be). */
  private settleRead(active: Active, id: string, served: { text?: string; error?: string }) {
    const call = active.tools.get(id)
    if (call) call.settled = true
    if (served.error !== undefined) active.turn.toolFailed(id, served.error)
    else active.turn.toolSucceeded(id, served.text ?? "")
  }

  /** What Kuvo Code read for the agent: the read it was for shows it, now or once the agent names it. */
  private served(path: string, served: { text?: string; error?: string }) {
    const active = this.active
    if (!active) return
    const file = resolve(this.session.location.directory, path)
    for (const [id, call] of active.tools) {
      if (this.openRead(call) && !call.settled && clientRead(call) && this.readPath(call) === file) return this.settleRead(active, id, served)
    }
    active.served.set(file, [...(active.served.get(file) ?? []), served])
  }

  /** A file the agent reads through the bridge: as your rules say, asking you when they ask. */
  private async allowFile(active: Active | undefined, action: string, path: string) {
    // (Between turns, as before: nothing to ask in.)
    if (!active) return
    const ask = { action, resources: [path] }
    const said = active.hooks.check(ask)
    if (said === "deny") throw new RPCError(-32000, "Kuvo Code's settings don't allow this (Settings › Permissions, or this session's rules).")
    if (said === "ask" && (await active.hooks.permission(ask)) === "reject") throw new RPCError(-32000, "Declined.")
  }

  private async request(method: string, params: any): Promise<unknown> {
    const own = this.flavor.request?.(method, params, this.context())
    if (own) return own
    const active = this.active
    switch (method) {
      case "session/request_permission": {
        const options = (params?.options ?? []) as { optionId: string; name?: string; kind: string }[]
        if (!active) return { outcome: { outcome: "cancelled" } }
        const call = { ...(active.tools.get(params.toolCall?.toolCallId) ?? {}), ...(params.toolCall ?? {}) }
        // Antigravity asks its questions this way: the title is the question, the options its answers.
        if (String(call.toolCallId ?? "").startsWith("interaction_")) {
          const answer = await active.hooks.question({
            title: "Question",
            fields: [{ key: "answer", title: "Question", description: call.title ?? "", required: true, type: "string", options: options.map((option) => ({ value: option.optionId, label: option.name ?? option.optionId })) }],
          })
          const chosen = answer?.answer
          return chosen ? { outcome: { outcome: "selected", optionId: String(chosen) } } : { outcome: { outcome: "cancelled" } }
        }
        const kuvo = kuvoTool(call)
        const files = (call.content ?? []).filter((part: any) => part?.type === "diff" && part.path).map((part: any) => fileDiff(part.path, part.oldText ?? undefined, part.newText ?? ""))
        const action = permissionAction(call.kind, kuvo.name)
        const ask = {
          toolCallID: call.toolCallId,
          action,
          resources: resources(call),
          metadata: files.length ? { files } : undefined,
          message: call.title,
          unclassified: !classified.has(action) && !action.startsWith(toolServerName + "_"),
        }
        // Refused by your settings, not by you: the agent stops for any no, and is told to carry on.
        const automatic = active.hooks.check(ask) === "deny"
        const decision: Decision = await active.hooks.permission(ask)
        // Stopped meanwhile: told to cancel, it hears its ask was cancelled (as ACP has it), not
        // that you said no; the step shows stopped, not declined.
        if (active.hooks.signal.aborted) return { outcome: { outcome: "cancelled" } }
        if (decision === "reject") {
          // A no of yours stops it, as you meant (none of your settings' before it is told now).
          active.refused = automatic ? refusedWhat(ask.action, ask.resources) : undefined
          ;(active.declined ??= new Map()).set(call.toolCallId, "Declined.")
        }
        const pick = (kinds: string[]) => kinds.map((kind) => options.find((option) => option.kind === kind)).find(Boolean)
        // Always is kept here (the bridge answers the next ask from it), never as the agent's own,
        // which it would keep past your rules (Grok's for the project).
        const option = decision === "reject" ? pick(["reject_once", "reject_always"]) : pick(["allow_once", "allow_always"])
        return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } }
      }
      case "fs/read_text_file": {
        if (!this.flavor.fileSystem) break
        // It doesn't ask before reading: your rules for reading (and working outside the project) do.
        await this.allowFile(active, "read", resolve(this.session.location.directory, params.path))
        let content: string
        try {
          content = readFileSync(resolve(this.session.location.directory, params.path), "utf8")
        } catch (error) {
          this.served(params.path, { error: (error as any)?.code === "ENOENT" ? "There's no such file." : failure(error).message })
          throw error
        }
        if (params.line || params.limit) {
          const lines = content.split("\n")
          const start = Math.max(0, (params.line ?? 1) - 1)
          content = lines.slice(start, params.limit ? start + params.limit : undefined).join("\n")
        }
        this.served(params.path, { text: content })
        return { content }
      }
      case "fs/write_text_file": {
        if (!this.flavor.fileSystem) break
        const file = resolve(this.session.location.directory, params.path)
        // It asked before writing (as an edit): what your rules refuse still doesn't happen.
        if (active?.hooks.check({ action: "edit", resources: [file] }) === "deny") throw new RPCError(-32000, "Kuvo Code's settings don't allow this (Settings › Permissions, or this session's rules).")
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, params.content ?? "")
        return {}
      }
      case "elicitation/create": {
        // A form the agent (or a tool of its) asks you to fill in, or a page to open.
        if (!active) return { action: "decline" }
        if (params?.mode === "url" && params.url) {
          const answer = await active.hooks.question({ title: `${this.name} asks`, fields: [{ key: "open", title: params.message ?? "Open this page to go on.", type: "external", url: params.url }] })
          return { action: answer ? "accept" : "decline" }
        }
        const schema = params?.requestedSchema ?? {}
        const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
        const fields = Object.entries((schema.properties ?? {}) as Record<string, any>).map(([key, field]) => elicitationField(key, field, required.has(key)))
        if (fields[0] && params?.message) fields[0] = { ...fields[0], description: [params.message, fields[0].description].filter(Boolean).join("\n\n") }
        const answer = await active.hooks.question({ title: `${this.name} asks`, fields: fields.length ? fields : [{ key: "ok", title: params?.message ?? "Go on?", type: "boolean", required: true }] })
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
    // One this bridge doesn't answer: said, so its tool isn't silently refused.
    if (active && !method.startsWith("terminal/")) this.noticeOnce(active, method, `${this.name} asked Kuvo Code for something it can't do yet (${method}).`)
    throw new RPCError(-32601, `Method not found: ${method}`)
  }

  async interrupt() {
    const active = this.active
    const rpc = active?.rpc
    if (!active || !rpc || !this.sessionID) return
    // It can't go on after a stop: the next message starts it again.
    if (this.flavor.restartAfterInterrupt) this.stale = rpc
    rpc.notify("session/cancel", { sessionId: this.sessionID })
    for (let waited = 0; waited < 15_000 && !active.ended; waited += 100) await Bun.sleep(100)
    if (active.ended) return
    this.end(active, "interrupted")
    // Only this turn's process, if nothing newer runs on it.
    if (this.rpc === rpc && (!this.active || this.active.rpc !== rpc)) this.close()
  }

  close() {
    this.rpc?.kill()
    this.rpc = undefined
  }
}

// MARK: Tools, as the app knows them

function kuvoTool(call: any): { name: string; input: Record<string, unknown> } {
  const raw = call.rawInput ?? {}
  const path = call.locations?.[0]?.path ?? raw.path ?? raw.file_path ?? raw.filePath
  const command = Array.isArray(raw.command) ? raw.command.join(" ") : raw.command ?? raw.CommandLine ?? raw.command_line ?? raw.commandLine
  // Grok looking through the tools it has for one that does something (its SearchTool): the
  // app's tool search, by what it looked for, not a tool named after its words, nor a search of
  // the files, whatever kind it gives it.
  if (raw.variant === "SearchTool") return { name: "tool_search", input: { query: raw.query } }
  switch (call.kind) {
    case "execute":
      return { name: "shell", input: { command: command ?? backticked(call.title) ?? call.title, description: raw.description } }
    case "read":
      return { name: "read", input: { ...raw, path, description: call.title } }
    case "edit":
    case "delete":
    case "move":
      return { name: "edit", input: { ...raw, path, description: call.title } }
    case "search":
      return { name: "grep", input: { ...raw, pattern: raw.pattern ?? raw.query ?? call.title, path, description: call.title } }
    case "fetch":
      return { name: raw.url ? "webfetch" : "websearch", input: { url: raw.url, query: raw.query ?? call.title } }
    case "think":
      return { name: "think", input: {} }
  }
  // One of Kuvo Code's, named with its server ("kuvo-browser/show_widget", "mcp__kuvo-browser__…",
  // "Tool: kuvo-browser.show_widget", or server and tool in its input): the app's name for it.
  // Its own arguments, where the agent wraps them in its call (Grok: {variant: "UseTool",
  // tool_name, tool_input}), or the input as it is.
  const server = raw.server ?? raw.server_name ?? raw.serverName
  const tool = raw.tool ?? raw.tool_name ?? raw.toolName
  const wrapped = raw.arguments ?? raw.args ?? raw.input ?? raw.tool_input ?? raw.toolInput
  const args = typeof wrapped === "object" && wrapped && !Array.isArray(wrapped) ? wrapped : raw
  if (server === toolServerName && typeof tool === "string" && /^[a-z0-9_]+$/i.test(tool) && isKuvoTool(tool) !== false) {
    return { name: `${toolServerName}_${tool}`, input: args }
  }
  const named = (text: unknown) => new RegExp(`(?:^|[\\s:])(?:mcp__)?${toolServerName}(?:/|__|\\.|:|_)([a-z0-9_]+)\\s*$`, "i").exec(String(text ?? "").trim())?.[1]
  const prefixed = named(call.title) ?? named(tool)
  if (prefixed && isKuvoTool(prefixed.toLowerCase()) !== false) return { name: `${toolServerName}_${prefixed.toLowerCase()}`, input: args }
  // Antigravity names a tool only in its title ("Running show_widget"): one of Kuvo Code's goes by
  // the app's name for it, so it shows as it does for the engine's models (a widget, drawn).
  const titled = /^(?:running\s+|tool:\s*|calling\s+)?([a-z0-9_.-]+)$/i.exec(String(call.title ?? "").trim())?.[1]
  const own = titled && typeof raw === "object" && raw ? kuvoToolName(titled, raw) : undefined
  if (own) return { name: own, input: raw }
  return { name: (titled ?? call.title ?? "tool").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "") || "tool", input: raw }
}

/** The kinds of access Kuvo Code knows an agent's ask by (and Kuvo Code's own tools, by name). */
const classified = new Set(["shell", "edit", "write", "patch", "webfetch", "websearch", "read", "grep", "glob", "list", "external_directory", "think"])

function permissionAction(kind: string | undefined, name: string): string {
  switch (kind) {
    case "execute":
      return "shell"
    case "edit":
    case "delete":
    case "move":
      return "edit"
    case "fetch":
      return "webfetch"
    case "read":
    case "search":
      return "read"
  }
  return name
}

function resources(call: any): string[] {
  const raw = call.rawInput ?? {}
  if (call.kind === "execute") {
    const command = Array.isArray(raw.command) ? raw.command.join(" ") : raw.command ?? backticked(call.title)
    return [command ?? call.title ?? "*"]
  }
  const paths = (call.locations ?? []).map((location: any) => location.path).filter(Boolean)
  if (paths.length) return paths
  return [raw.path ?? raw.url ?? raw.file_path ?? "*"]
}

/**
 * A read the agent has Kuvo Code do (Antigravity's client_view_file, not its own view_file), as
 * its title or input name it. One named only by what the model says it does could be either: it's
 * Kuvo Code's if Kuvo Code read that file for it.
 */
function clientRead(call: any): boolean {
  const named = `${call.title ?? ""} ${call.rawInput?.name ?? ""}`
  return /client_view_file/i.test(named) || !/view_file/i.test(named)
}

/** What was refused, in a few words for the agent. */
function refusedWhat(action: string, resources: string[]): string {
  const what = resources.filter((resource) => resource !== "*").join(", ")
  if (action === "shell") return what ? `running \`${what}\`` : "running that command"
  if (action === "edit") return what ? `editing ${what}` : "editing files"
  if (action === "webfetch") return what ? `opening ${what}` : "opening that page"
  if (action === "read") return what ? `reading ${what}` : "reading that"
  return what ? `${action} on ${what}` : `that (${action})`
}

function backticked(title: unknown): string | undefined {
  return typeof title === "string" ? title.match(/`([^`]+)`/)?.[1] : undefined
}

function contentText(content: any): string {
  if (!content) return ""
  if (typeof content === "string") return content
  if (content.type === "text") return content.text ?? ""
  if (content.type === "resource_link") return content.name ?? content.uri ?? ""
  if (content.type === "resource") return content.resource?.text ?? ""
  return ""
}

function toolOutput(call: any): { text: string; pictures: ReturnType<typeof pictureData>[] } {
  const parts: string[] = []
  const pictures: ReturnType<typeof pictureData>[] = []
  for (const part of call.content ?? []) {
    if (part?.type === "content") {
      const content = part.content
      if (content?.type === "image") pictures.push(pictureData(content.data, content.mimeType))
      else if (content?.type === "resource" && content.resource?.blob) pictures.push(pictureData(content.resource.blob, content.resource.mimeType))
      else if (content?.type === "resource_link") parts.push(`${content.name ?? content.title ?? "Link"}: ${content.uri ?? ""}`)
      else parts.push(contentText(content))
    } else if (part?.type === "terminal") continue
  }
  const raw = call.rawOutput
  if (!parts.length && raw) {
    // A command's output, its errors too.
    if (typeof raw === "string") parts.push(raw)
    else {
      for (const key of ["output_for_prompt", "combinedOutput", "combined_output", "output", "stdout", "content"]) {
        const value = raw[key]
        if (typeof value === "string" && value) {
          parts.push(value)
          break
        }
      }
      for (const key of ["stderr", "error", "message"]) if (typeof raw[key] === "string" && raw[key] && !parts.includes(raw[key])) parts.push(raw[key])
      if (!parts.length && typeof raw === "object" && Object.keys(raw).length) parts.push(JSON.stringify(raw, null, 2))
    }
  }
  const text = parts.filter(Boolean).join("\n")
  return { text: text.length > outputLimit ? text.slice(-outputLimit) : text, pictures }
}

/** A text's first line, short. */
function firstLine(text: string | undefined): string {
  const line = (text ?? "").split("\n").find((part) => part.trim())?.trim() ?? ""
  return line.length > 80 ? line.slice(0, 79) + "…" : line
}

function errorText(error: unknown): string {
  if (error instanceof RPCError) {
    const data = error.data as any
    return data?.message ?? error.message
  }
  return error instanceof Error ? error.message : String(error)
}

function safeBase64(path: string): string | undefined {
  try {
    return readFileSync(path).toString("base64")
  } catch {
    return undefined
  }
}

/** Fields for a question an agent asks (Grok's `ask_user_question`), and its answer back. */
export function questionFields(questions: { id?: string; question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[]): FormField[] {
  return questions.map((question, index) => ({
    key: question.id ?? `q${index}`,
    title: question.header ?? `Question ${index + 1}`,
    description: question.question,
    required: true,
    type: question.multiSelect ? "multiselect" : "string",
    options: (question.options ?? []).map((option) => ({ value: option.label, label: option.label, description: option.description })),
    custom: true,
  }))
}
