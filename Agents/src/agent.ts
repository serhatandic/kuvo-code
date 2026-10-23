// What each outside agent (Claude Code, Codex, Cursor, Grok, Antigravity) gives the bridge: its
// sign-in, its models, and a conversation that runs turns and reports them on a `Turn`.

import type { AgentAccount } from "./accounts"
import type { Limit } from "./auto"
import type { InstallResult, Maintenance, UpdateResult } from "./maintenance"
import type { Deps } from "./deps"
import type { Turn, Outcome } from "./turn"
import type { Decision, FormAnswer, FormField, IntegrationMethod, Model, ModelRef, OAuthStatus, Session, StructuredError } from "./wire"

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
  /** The agent settled it itself (it timed out there): it's taken back, refused. */
  signal?: AbortSignal
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
}

export interface SubagentRun {
  sessionID: string
  turn: Turn
  end(outcome: Outcome, error?: StructuredError): void
  /** What it asks you, as its own (one in the background asks after its turn too). */
  permission(ask: PermissionAsk): Promise<Decision>
  /** Set by its agent: stops it (Stop in its session, or in the conversation that started it once that turn is over). */
  stop?: () => Promise<void>
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
  steer?(input: { id: string; text: string; files: PromptFile[] }): Promise<boolean>
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
}

export interface Agent {
  /** The bridge's own name for it: `claude`, `codex`, `cursor`, `grok`, `antigravity`. */
  id: string
  /** Its models' provider in the app, and its account's ID: `claude-code`, `codex-cli`, … */
  providerID: string
  name: string
  /** The command that installs its program, when it's yours to install. */
  install?: string
  methods(): IntegrationMethod[]
  account(fresh?: boolean): Promise<Account>
  signIn?(methodID: string, options?: SignInOptions): Promise<SignInAttempt>
  /** Whether its sign-in can finish on another device (`SignInOptions.remote`). */
  signsInRemotely?: boolean
  signInWithKey?(key: string): Promise<void>
  signOut?(): Promise<void>
  models(): Promise<Model[]>
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
export function model(providerID: string, id: string, name: string, options: { variants?: string[]; images?: boolean; context?: number; released?: number; family?: string } = {}): Model {
  return {
    id,
    providerID,
    name,
    family: options.family,
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
