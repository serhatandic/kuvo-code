// What each outside agent (Claude Code, Codex, Cursor, Grok, Antigravity) gives the bridge: its
// sign-in, its models, and a conversation that runs turns and reports them on a `Turn`.

import type { AgentAccount } from "./accounts"
import type { Limit } from "./auto"
import type { LimitsSource } from "./limits"
import type { InstallResult, Maintenance, UpdateResult } from "./maintenance"
import type { Deps } from "./deps"
import type { Turn, Outcome } from "./turn"
import type { Decision, FormAnswer, FormField, IntegrationMethod, Model, ModelRef, OAuthStatus, PermissionRule, Session, StructuredError } from "./wire"
import { run } from "./proc"

/** What every agent gets from the bridge: its folders and the SDK installer. */
export interface AgentContext {
  home: string
  temporary: string
  deps: Deps
}

export interface Account {
  /** The agent's program (or package) is there to run. */
  installed: boolean
  signedIn: boolean
  /** Who's signed in, as the agent says: "you@example.com", "Max plan". */
  label?: string
  /** What's missing, in words: how to install it, or that it needs a sign-in. */
  message?: string
  /** It was signed in, and its maker ended the sign-in (it's to be signed in again). */
  ended?: boolean
  /** Its sign-in couldn't be checked just now (the check failed or took too long): as it last said. */
  unchecked?: boolean
}

/** An agent didn't answer in time (a computer too busy to run it, say): no answer, rather than a wrong one. */
export class TookTooLong extends Error {}

/**
 * An agent's sign-in as it last said. A check that fails or takes too long (a computer too busy to
 * answer in time) isn't a sign-out: the account stays as it was, `unchecked`, and is asked again
 * next time. Only the agent's own word, that you're signed out, is one. Never answered yet, one
 * that took too long is taken as signed in (a run on it says so if it isn't, where a model taken
 * away mid-goal can't be put back), and one that failed throws why.
 */
/**
 * Signs an agent's program out with its own command (`claude auth logout`), in its environment: an
 * agent's own sign-in on a machine, which is Kuvo Code's, in its folder there (`AgentAccount.home`),
 * not yours in your home. Says why when it couldn't.
 */
export async function signOutWith(name: string, executable: string | undefined, args: string[], env: Record<string, string | undefined>) {
  if (!executable) throw new Error(`${name} isn't installed here any more.`)
  const ran = await run(executable, args, { timeout: 20_000, env })
  if (ran.code === 0 && !ran.timedOut) return
  const why = (ran.stderr || ran.stdout).trim() || (ran.timedOut ? "It took too long." : `It stopped with ${ran.code}.`)
  throw new Error(`${name} couldn't sign out: ${why}`)
}

export class KnownAccount {
  private known?: { at: number; account: Account }
  private checking?: Promise<{ account: Account } | { error: unknown }>
  /** The last check's failure: not tried again for a while unless asked anew (it'd only make each list wait as long). */
  private failure?: { at: number; error: unknown }
  /** Counts resets: a check begun before one isn't kept. */
  private generation = 0

  /** `keep`: how long an answer stands before the agent is asked again (unless asked anew). */
  constructor(private readonly keep = 0) {}

  /** `check`: the agent's answer; throws when it gave none (`TookTooLong`, or why it failed). One check at a time: a busy computer isn't given more. */
  async read(fresh: boolean, check: () => Promise<Account>): Promise<Account> {
    if (!fresh && this.known && !this.failure && Date.now() - this.known.at < this.keep) return this.known.account
    if (fresh || !this.failure || Date.now() - this.failure.at >= 30_000) {
      const generation = this.generation
      if (!this.checking) {
        const checking: Promise<{ account: Account } | { error: unknown }> = check()
          .then(
            (account) => ({ account }),
            (error: unknown) => ({ error }),
          )
          .finally(() => {
            if (this.checking === checking) this.checking = undefined
          })
        this.checking = checking
      }
      const result = await this.checking
      if (generation !== this.generation) return this.read(fresh, check)
      if ("account" in result) {
        this.failure = undefined
        this.known = { at: Date.now(), account: result.account }
        return result.account
      }
      this.failure = { at: Date.now(), error: result.error }
    }
    if (this.known) return { ...this.known.account, unchecked: true }
    if (this.failure?.error instanceof TookTooLong) return { installed: true, signedIn: true, unchecked: true }
    throw this.failure?.error
  }

  /** Asked again next time (its program changed), with what it last said kept until it answers. */
  stale() {
    if (this.known) this.known.at = 0
  }

  /** Signed in or out here: the next ask is the agent's word, not the last answer. */
  reset() {
    this.generation++
    this.checking = undefined
    this.known = undefined
    this.failure = undefined
  }
}

export interface SignInAttempt {
  url: string
  instructions: string
  mode: "auto" | "code"
  /** For `auto`: the page may end on a code to paste instead (when it couldn't come back by itself). */
  acceptsCode?: boolean
  status(): OAuthStatus
  /** For `code`, or `auto` with `acceptsCode`: the code the sign-in page gave you. */
  complete?(code: string): Promise<void>
  cancel(): void
  /** A device code's: the code to enter on its page (shown beside it, to copy). */
  userCode?: string
}

/** How a sign-in is asked for. `remote`: its page is opened on another device (a phone), so it
 * can't come back to this computer's `localhost`: it ends on a code to paste, or a device code. */
export interface SignInOptions {
  remote?: boolean
}

export interface PromptFile {
  /** A file on this Mac, when it's one. */
  path?: string
  uri: string
  mime: string
  name?: string
  /** Its contents, base64, when it came inline (a pasted picture). */
  data?: string
}

export interface RunInput {
  text: string
  files: PromptFile[]
  model: ModelRef
  /** Plan mode: look and propose, change nothing. */
  plan: boolean
  /** On Auto: a usage limit ends the run (the next model in your list goes on) rather than waiting. */
  auto?: boolean
  /** A turn the agent began on its own (a command it left running ended): nothing to send, it's under way. */
  adopt?: boolean
  /** No message: the agent summarizes its conversation, as you asked (`Agent.compacts`). Says nothing in it. */
  compact?: boolean
}

/** What began a turn an agent started on its own, as the conversation says it. */
export interface OwnTurn {
  text: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface PermissionAsk {
  /** The tool call it's for, when the agent says. */
  toolCallID?: string
  /** The engine's name for the kind of access: `edit`, `shell`, `webfetch`, `read`, … */
  action: string
  /** What it's for: paths, a command, a web address. */
  resources: string[]
  /** What "Always allow" would allow. */
  save?: string[]
  metadata?: Record<string, unknown>
  /** The agent's own words for it, when it has them. */
  message?: string
  /**
   * What a subagent of yours that asks may do (Settings › Agents › What It May Do), in place of
   * the session's agent's: the session's own rules still go over them, as the engine has it.
   */
  agentRules?: PermissionRule[]
  /** The agent settled it itself (it timed out there): it's taken back, refused. */
  signal?: AbortSignal
  /**
   * Whether the process that asks runs in the box's sandbox, where the agent can tell its
   * processes apart (Codex's helpers may run on an app-server started before it was on); else the
   * thread's own `sandboxed` says.
   */
  sandboxed?: boolean
  /**
   * Asked by the engine, which already weighed your rules and its own (reading `.env` asks even
   * with Approve All): only a rule of yours or an earlier "Always" answers it without you.
   */
  weighed?: boolean
  /**
   * The agent asked about something Kuvo Code couldn't tell the kind of (an MCP tool it names its
   * own way): under Ask First, you're asked, whatever your rules say of the name it got.
   */
  unclassified?: boolean
}

export interface QuestionAsk {
  title: string
  fields: FormField[]
  toolCallID?: string
  /** Told what its agent should hear, where its box turns the question down with words. */
  declined?: (words: string) => void
  /** What it is, where it isn't the agent's own question (an MCP server's form, say): clients and
   * Autopilot go by `kind`, and a form that isn't a question never goes ahead on its own. */
  metadata?: Record<string, unknown>
  /** The agent settled it itself (it timed out there): it's taken back, unanswered. */
  signal?: AbortSignal
}

export interface TurnHooks {
  /** Asks you (or answers from your rules and earlier "Always" answers). */
  permission(ask: PermissionAsk): Promise<Decision>
  /** Asks you a question; null when you dismissed it. */
  question(ask: QuestionAsk): Promise<FormAnswer | null>
  /**
   * What the app adds to the agent's instructions (a worktree's, the project's other folders), and
   * an agent of yours' own (left out with false, for the engine, which runs it itself).
   */
  instructions(withAgent?: boolean): string
  /**
   * What your Blocks and rules say of an action, without asking you: refused, or to ask first.
   * `ownPlan`: the agent keeps plan mode itself (Claude Code writes its plan to a file).
   */
  check(ask: PermissionAsk, ownPlan?: boolean): "deny" | "ask" | undefined
  /** The agent's own state for this session, kept with it (its conversation's ID). */
  state: Record<string, unknown>
  saveState(): void
  /**
   * Approve All: the agent runs its tools without asking (your rules that deny still hold). For
   * an agent that can't ask anyway (`canAsk` false), Blocks not known yet don't change it.
   */
  approvesAll(canAsk?: boolean): boolean
  signal: AbortSignal
  /**
   * A subagent the agent handed a task to, with its tool call: a session of its own under this
   * one, which its work is told in, as the engine's subagents are. It ends with `end`, or with
   * the turn.
   */
  subagent(toolCallID: string, task: SubagentTask): SubagentRun
}

export interface SubagentTask {
  /** What it was asked to do, in a few words. */
  title: string
  /** What it was told, whole. */
  prompt?: string
  /** The kind of agent it is, when the agent names one ("Explore"). */
  agent?: string
  /** Its session from before, when the agent gives the same subagent more to do. */
  sessionID?: string
  /** Sent off to work in the background: its session goes on after the turn that started it. */
  background?: boolean
  /** How you can write to it (by default you can't: "<agent> can't take messages for its subagents."). */
  messages?: SubagentMessages
}

/**
 * How you can write to a subagent, as its session tells the apps (`kuvo.messages`): to it
 * (`direct`), through the agent that started it, which passes it on (`parent`), or not at all
 * (`none`, with why).
 */
export type SubagentMessages = { via: "direct" } | { via: "parent" } | { via: "none"; note: string }

/** A message of yours, as it goes to an agent. */
export interface MessageInput {
  /** The session's id for it. */
  id: string
  text: string
  files: PromptFile[]
  /** A note of the app's (a message relayed from another conversation, say), not words you wrote. */
  synthetic?: boolean
}

export interface SubagentRun {
  sessionID: string
  turn: Turn
  end(outcome: Outcome, error?: StructuredError): void
  /** What it asks you, as its own (one in the background asks after its turn too). */
  permission(ask: PermissionAsk): Promise<Decision>
  /** Its agent moved it to the background after it started: it goes on past the turn that started it. */
  inBackground(): void
  /** Set by its agent: stops it (Stop in its session, or in the conversation that started it once that turn is over). */
  stop?: () => Promise<void>
  /** How you can write to it, as its agent learns it (a Codex agent's thread says as it starts). */
  messages(route: SubagentMessages): void
}

export interface RunResult {
  outcome: Outcome
  /** A failed run's agent had your message all the same (it took it, then failed). */
  taken?: boolean
  /** Messages you sent partway that it never got to: it's handed them with the next one. */
  missed?: string[]
  error?: StructuredError
  /** It stopped at a usage or rate limit (Auto goes on with the next model in your list). */
  limit?: Limit
}

/** Something an agent left running in the background: a command, or a subagent or other task. */
export interface LostWork {
  kind: "command" | "task"
  /** The command it runs, or what the task is for. */
  what: string
  /** The end of what it printed, when that's known; or the file it went to, for the agent to read. */
  output?: string
  outputFile?: string
}

/**
 * The note that tells an agent its background work ended unfinished with its process (`why`, a
 * sentence on how), so it won't hear of it again: what each was, and the end of what it printed.
 */
export function lostWorkNote(why: string, lost: LostWork[]): string {
  const lines = lost.flatMap((work) => {
    const head = work.kind === "command" ? `- The command \`${work.what.split("\n")[0]}\`` : `- ${work.what.split("\n")[0]}`
    if (work.output) return [head, "  It had printed, at the end:", ...work.output.split("\n").map((line) => `  ${line}`)]
    return work.outputFile ? [head, `  What it printed is in ${work.outputFile}`] : [head]
  })
  return [`${why} What you left running in the background stopped with it, unfinished, and won't report back:`, ...lines, "Run again what you still need."].join("\n")
}

export interface Thread {
  /**
   * Gets its conversation ready before the message is made: `fresh` when the one it had couldn't
   * be picked up again, so it starts over and is handed all that came before.
   */
  prepare?(input: RunInput, hooks: TurnHooks): Promise<{ fresh: boolean } | undefined>
  run(input: RunInput, turn: Turn, hooks: TurnHooks): Promise<RunResult>
  /**
   * Adds a message of yours (`id`, the session's) to the turn under way, at its next step; false
   * when it can't. One it takes, the turn answers before it ends (or names it in `missed`).
   */
  steer?(input: MessageInput): Promise<boolean>
  /**
   * A subagent of this conversation's (its session) you write to yourself (`direct`): what sends
   * your message to it, at its next step while it works, or starting it again once it's done
   * (`resume` gives its run then, when no turn here is under way to have it). None when it doesn't
   * know that subagent (any more). The sender is false when it couldn't send.
   */
  subagentMessages?(sessionID: string): ((input: MessageInput, resume: () => SubagentRun) => Promise<boolean>) | undefined
  /**
   * A subagent of this conversation's (its session) you write to through the agent (`parent`):
   * the note that asks the agent to pass your message on, as it is (into the turn under way,
   * `running`, which then carries on; or a turn of its own, which ends there). None when it
   * doesn't know that subagent.
   */
  relayNote?(sessionID: string, text: string, running: boolean): string | undefined
  /** Whether it passed a message on to that subagent since it was last asked (its turn is over). */
  passedOn?(sessionID: string): boolean
  /** Stops the turn under way; `run` then ends with `interrupted`. */
  interrupt(): Promise<void>
  close(): void
  /**
   * Set by the session: the agent began a turn of its own between turns (a command it left
   * running ended, and it carries on). True when a turn here takes it (`run` with `adopt`, or
   * `turnAway` when it can't after all).
   */
  onOwnTurn?: (note: OwnTurn) => boolean
  /** A turn it began on its own that the session took but now won't (an undo came first, or Stop): it stops. */
  turnAway?(): void
  /** It has work going that closing it would end (commands left running): it's kept open. */
  readonly keepsWorking?: boolean
  /** What else it keeps going in the background, besides commands and subagents: each with when it started. */
  readonly backgroundTasks?: { id: string; since: number }[]
  /** Those tasks ended. */
  stopBackgroundTasks?(): Promise<void>
  /**
   * What it has going in the background that wakes it as it ends (Claude Code's and Grok's
   * commands and subagents): what closing it now would end unfinished, without a word to it.
   */
  readonly wakingWork?: LostWork[]
  /**
   * Set by the session: its agent's process ended by itself between turns (killed, or crashed; not
   * closed here) while it had that work going, which ended with it and so will never wake it.
   */
  onWorkLost?: (lost: LostWork[]) => void
  /** Its commands run in the box's sandbox now: the agent's whole program runs in it. */
  readonly sandboxed?: boolean
  /** A process of its that runs commands was started outside the box's sandbox, and still runs. */
  readonly outside?: boolean
}

/** A conversation's own files where its agent keeps them, for a move (carry.ts). */
export interface ConversationFiles {
  /** Each file or folder of it, and its name wherever the agent keeps it. */
  items: { path: string; name: string }[]
  /** The folder of what it remembers, kept apart from the conversation. */
  memory?: string
  /** That's shared with others in the same folder: it's copied, and stays. */
  memoryShared?: boolean
  /** It has started on this conversation, and its files aren't there: its agent can't go on with it anywhere. */
  missing?: boolean
}

/** Where a conversation's own files go on this computer, for a move (carry.ts). */
export interface ConversationPlace {
  /** Where an item of that name goes; null for one the agent doesn't keep. */
  item(name: string): string | null
  memory?: string
  /** That memory is shared with others (a folder's): what's there stays, and what's different goes beside it. */
  memoryMerges?: boolean
}

export interface Agent {
  /** The bridge's own name for it: `claude`, `codex`, `cursor`, `grok`, `antigravity`. */
  id: string
  /** Its models' provider in the app, and its account's ID: `claude-code`, `codex-cli`, … */
  providerID: string
  name: string
  /** It summarizes its conversation when asked (`RunInput.compact`); others only do by themselves. */
  compacts?: boolean
  /** The command that installs its program, when it's yours to install. */
  install?: string
  methods(): IntegrationMethod[]
  account(fresh?: boolean): Promise<Account>
  signIn?(methodID: string, options?: SignInOptions): Promise<SignInAttempt>
  /** Whether its sign-in can finish on another device (`SignInOptions.remote`). */
  signsInRemotely?: boolean
  signInWithKey?(key: string): Promise<void>
  signOut?(): Promise<void>
  /** A process of its that runs turns was started outside the box's sandbox, and still runs (one its threads don't own). */
  outside?(): boolean
  /** Stops those (`outside`) that nothing is at work in now, to start again in the sandbox (you said to restart them); whether one is still at work. */
  restartOutside?(): boolean
  models(): Promise<Model[]>
  /**
   * The model an alias of its own (Claude Code's `default`) stands for on this computer and
   * account, as the agent itself listed it: undefined when `id` isn't an alias, or the agent hasn't
   * said (never a guess). A move carries that, since the alias may stand for another model there.
   */
  concreteModel?(id: string): Promise<string | undefined>
  /**
   * Known to be signed out of, for an agent whose models run somewhere that drops a request it
   * can't send without a word (the engine): said first, rather than sent. Unknown is not.
   */
  signedOut?(): Promise<boolean>
  /** Forgets the models it listed: the account changed. */
  forgetModels?(): void
  /** The account it runs as: the agent's own sign-in, or one you added (with a folder of its own). */
  instance: AgentAccount
  /** An added account is being removed: sign out where the agent keeps it outside its folder. */
  removeAccount?(): Promise<void>
  /** Stops what it keeps running (an app-server): its account is gone. */
  shutdown?(): void
  /** Its plan's limits, read from its sign-in (limits.ts); none for an agent whose limits aren't read here. */
  readonly limits?: LimitsSource
  /** The version of its program you have, the newest, and how it's updated (an agent you install). */
  maintenance?(fresh?: boolean): Promise<Maintenance>
  /** Updates its program through the installer that owns it. */
  update?(): Promise<UpdateResult>
  /** Installs its program with its own installer (`install`), where it's yours to install. */
  installProgram?(): Promise<InstallResult>
  /**
   * Its program was updated (told to each account with it): the new one lists the models, and
   * runs sessions from their next message, without the app starting again.
   */
  programUpdated?(): void
  thread(session: Session, state: Record<string, unknown>): Thread
  /**
   * One answer to a prompt outside any conversation (a session's title, a commit message), on a
   * model of its own (a quick one, when none is given): no tools, and kept nowhere. None for an
   * agent that can't answer one so.
   */
  generate?(prompt: string, model?: ModelRef): Promise<string>
  /** A session here was deleted: its conversation where the agent keeps it goes too. */
  forgetConversation?(state: Record<string, unknown>): Promise<void>
  /**
   * A conversation's own files, for a move: null when it hasn't started on it. None of this for an
   * agent whose conversations can't be picked up on another computer: its next run there starts
   * over, handed what came before.
   */
  conversationFiles?(state: Record<string, unknown>, session: Session): ConversationFiles | null
  /** Where those go here, for `session` as it is here. */
  conversationPlace?(state: Record<string, unknown>, session: Session): ConversationPlace
  /** The folders it keeps conversations in, for clearing what a moved one left. */
  conversationRoots?(): string[]
  /**
   * A file of the agent's own, which it keeps for itself and reads or writes on its own (Claude
   * Code's memory, plans, and long outputs it saved): never "outside the project".
   */
  ownsPath?(path: string, session?: Session): boolean
}

/**
 * How much each model holds, as its agent says (its model list doesn't): the window its models
 * list, so the context ring counts against the model's real room.
 */
export class ContextWindows {
  private sizes = new Map<string, number>()

  get(model: string): number | undefined {
    return this.sizes.get(model)
  }

  /** What the agent said `model` holds; true when that's news (its models are listed again). */
  note(model: string, size: unknown): boolean {
    if (typeof size !== "number" || !(size > 0) || this.sizes.get(model) === size) return false
    this.sizes.set(model, size)
    return true
  }
}

/** A model as the app lists it, from the little an agent says about one. */
export function model(providerID: string, id: string, name: string, options: { variants?: string[]; images?: boolean; context?: number; released?: number; family?: string; aliases?: string[]; provisional?: boolean } = {}): Model {
  return {
    id,
    providerID,
    name,
    family: options.family,
    ...(options.aliases?.length ? { aliases: options.aliases } : {}),
    ...(options.provisional ? { provisional: true as const } : {}),
    capabilities: { tools: true, input: options.images ? ["text", "image"] : ["text"], output: ["text"] },
    variants: (options.variants ?? []).map((id) => ({ id })),
    time: { released: options.released ?? 0 },
    // Paid for by your plan with the agent's maker, not per token here.
    cost: [{ input: 0, output: 0 }],
    status: "active",
    enabled: true,
    limit: { context: options.context ?? 200_000, output: 32_000 },
  }
}

/** An agent's name, with its account's when it isn't the agent's own sign-in: "Claude Code · Work". */
export function accountName(name: string, account: { id: string; label?: string }): string {
  if (account.id === "default") return name
  return `${name} · ${account.label ?? "Another account"}`
}

export function failure(error: unknown, type = "agent"): StructuredError {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
  return { type, message: message || "The agent stopped with an error." }
}
