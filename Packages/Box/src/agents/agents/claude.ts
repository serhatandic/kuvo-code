// Claude Code, with the Claude Agent SDK, as T3 Code runs it: your own `claude`, signed in with
// your own plan or key (`claude auth login`), one long-lived Claude Code per session fed message
// by message, its replies streamed into the session as the engine's own would be.

import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { providerID, type AgentAccount } from "../accounts"
import type { Agent, AgentContext, Account, ConversationFiles, ConversationPlace, LostWork, MessageInput, OwnTurn, RunInput, RunResult, SignInAttempt, SignInOptions, SubagentMessages, SubagentRun, Thread, TurnHooks, PromptFile } from "../agent"
import type { Limit } from "../auto"
import { accountName, ContextWindows, failure, KnownAccount, lostWorkNote, model, signOutWith, TookTooLong } from "../agent"
import { fileDiff, fromPatch } from "../diff"
import { install, installedVersion, maintenance, update, type MaintenanceDefinition } from "../maintenance"
import { fingerprint, type LimitsSource } from "../limits"
import { CLAUDE_LIMITS_EVERY, claudeIdentity, credentialsIn, heardWindows, limitWarning, readClaudeLimits, type ClaudeSignIn } from "./claude-limits"
import { emit } from "../events"
import { run, which } from "../proc"
import { Queue } from "../queue"
import { commandSignIn } from "../signin"
import { newID } from "../ids"
import { kuvoTools } from "../kuvotools"
import { dropRelayed, relayedServers, relayedTools, relayPort, serversKey } from "../toolrelay"
import { computerServers } from "../servers"
import { skillsFolder, skillsFor, turnedOff, upward } from "../skills"
import { claudeSubagents, subagentRules, subagentsFor, type Subagents } from "../subagents"
import { onMachine, ownFoldersScript } from "../machine"
import { fenceAgent, fenceAttachments, fenceCopy, fenceKey, fenceOn, seatBot, fullAccessMark } from "../fence"
import { addShell, endShell } from "../shells"
import { instructionsNote, toldOf } from "../told"
import { pictureData, pictureFile, withPictures } from "../pictures"
import type { Turn } from "../turn"
import type { FileDiff, FormField, Model, ModelRef, PermissionRule, Session, TokenUsage } from "../wire"

const SDK = [{ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.303" }]
const places = [join(homedir(), ".local/bin"), join(homedir(), ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin"]
/** Kept of a tool's output: enough to read, not a whole file's worth. */
const outputLimit = 30_000

/**
 * What Claude Code writes at its settings folder's top as it runs whole in the box's sandbox: its
 * conversations, their files and notes, its caches and logs, and its sign-in (in a file on Linux;
 * on an added account's, its settings file too: `.claude.json`). Not its settings, hooks, skills,
 * agents, commands or plugins, which run outside the sandbox when you use it yourself, nor what
 * your own Claude Code runs or reads from there later: the shells its commands source
 * (`shell-snapshots`), a session's environment (`session-env`), an editor's lock (`ide`) and its
 * settings' backups. Without them it still runs its commands, with no shell snapshot of its own. (A
 * session's environment it finds made, or its hooks wouldn't start, and can't write in: `environment`.)
 */
const STATE_IN_HOME = [
  "projects", "sessions", "file-history", "todos", "tasks", "teams", "plans", "history.jsonl*",
  "statsig", "telemetry", "debug", "cache", "paste-cache", "image-cache", "state", "logs", "uploads",
  "stats-cache.json*", "mcp-needs-auth-cache.json*", ".credentials.json*", ".claude.json*", "*.lock",
]
/** A conversation's name in its settings folder, as Claude Code gives it. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONVERSATION_ITEM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl$|$|\/)/i

/** The folder's name under `projects`, as Claude Code makes it. (One too long for a name it cuts short
 * with a sum of its own: such a conversation is still found by its ID, and goes with no memory of its folder's.) */
const projectSlug = (directory: string) => directory.replace(/[^a-zA-Z0-9]/g, "-")

/** A bot's memory in its own folder, for the bot's own conversation in its `workspace`. */
function botMemory(session: Session): string | undefined {
  const bot = (session.metadata?.kuvo as { bot?: unknown } | undefined)?.bot
  const directory = session.location.directory
  if (typeof bot !== "string" || basename(directory) !== "workspace" || basename(dirname(directory)) !== bot) return undefined
  return join(dirname(directory), "memory")
}

/** What it never writes in its state either: settings put there. */
const KEPT_IN_HOME = ["settings*.json", "hooks", ".mcp.json"]

interface Status {
  loggedIn?: boolean
  authMethod?: string
  email?: string
  subscriptionType?: string
  apiProvider?: string
}

/** `claude setup-token`'s token on a line it has printed in full (its terminal is wide enough that
 * it's on one line; one that wrapped comes joined), with something after it: never one cut short. */
const PRINTED_TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{60,}(?=[^A-Za-z0-9_-])/
/** Any of Claude's tokens, never said back in a failure's words. */
const ANY_TOKEN = /sk-ant-[A-Za-z0-9_-]+/g
/** What's never said back of `claude setup-token`'s output: its token, and a line that's only a
 * long run of a token's characters (one cut over two lines, the rest of it). */
const PRINTED_SECRET = /sk-ant-[A-Za-z0-9_-]+|^[^\S\n]*[A-Za-z0-9_-]{32,}[^\S\n]*$/gm
/** A value after a name: quoted, or up to what ends it. */
const VALUE = `"[^"]*"|'[^']*'|[^\\s"',;]+`
/** A name that holds a secret (`max_tokens` holds a count). */
const SECRET_NAME = "[A-Za-z0-9_-]*(?:key|token(?!s)|secret|password|passwd)[A-Za-z0-9_-]*"
/** Words without Claude's tokens, or the other secrets an error line can hold: a URL's password (a
 * proxy's), a header's or a bearer token, a value named as a secret (`NAME=…`, `"name": …`, a clear
 * name with a colon, a command's flag). Not a plain sentence's words: "Invalid API key: …",
 * "Invalid token: …", "Bearer token expired". */
const withoutSecrets = (text: string) =>
  text
    .replace(ANY_TOKEN, "sk-ant-…")
    .replace(/:\/\/[^\s/]*@/g, "://…@")
    .replace(new RegExp(`\\b((?:proxy-)?authorization)(["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|(?:(?:bearer|basic|token)\\s+)?[^\\s"',;]+)`, "gi"), "$1$2…")
    .replace(/\bBearer\s+(?!tokens?\b)[A-Za-z0-9._~+/-]+=*/gi, "Bearer …")
    .replace(new RegExp(`\\b(${SECRET_NAME})(\\s*=\\s*)(?:${VALUE})`, "gi"), "$1$2…")
    .replace(new RegExp(`(["'])(${SECRET_NAME})\\1(\\s*:\\s*)(?:${VALUE})`, "gi"), "$1$2$1$3…")
    .replace(new RegExp(`\\b((?:[A-Za-z0-9_-]+[-_])?(?:api[-_]?key|token)|[A-Za-z0-9_-]*(?:password|passwd|secret))(?<!(?:^|[\\s(])token)(\\s*:\\s*)(?:${VALUE})`, "gi"), "$1$2…")
    .replace(new RegExp(`(--${SECRET_NAME})(\\s+|=)(?:${VALUE})`, "gi"), "$1$2…")
/** A failure, in words without secrets. */
const told = (error: unknown) => {
  const said = failure(error)
  return { ...said, message: withoutSecrets(said.message) }
}

/**
 * What one Claude Code run whole in the sandbox has said on its error output since its last message:
 * the end of it, in whole lines (the start of a line cut off could be the end of a token, which
 * nothing would know to take out).
 */
class Said {
  private text = ""
  /** The line coming in was cut: what's left of it goes too. */
  private cut = false
  /** All of it is here: a last line with no end is whole. */
  private finished = false

  add(chunk: string) {
    let text = this.text + chunk
    if (this.cut) {
      const end = text.indexOf("\n")
      this.cut = end < 0
      text = end < 0 ? "" : text.slice(end + 1)
    }
    if (text.length > 4000) {
      text = text.slice(-4000)
      const start = text.indexOf("\n")
      this.cut = start < 0
      text = start < 0 ? "" : text.slice(start + 1)
    }
    this.text = text
  }

  finish() {
    this.finished = true
  }

  /** It went on working: what it said before isn't why it stops later. */
  forget() {
    if (this.text && !this.text.endsWith("\n")) this.cut = true
    this.text = ""
  }

  /** Its last line that says something (not a stack frame, nor the runtime's name under a crash). */
  get last() {
    // (A line still coming could stop before what would show it's a secret.)
    const whole = this.finished ? this.text : this.text.slice(0, this.text.lastIndexOf("\n") + 1)
    const line = whole.split("\n").map((each) => each.trim()).filter((each) => each && !/^(at\s|Bun v\d|Node\.js v\d)/.test(each)).pop()
    return withoutSecrets(line ?? "").slice(0, 300)
  }
}

export class ClaudeAgent implements Agent {
  /**
   * On a Mac, Claude Code keeps its sign-in in the Keychain, which the box's sandbox can't write:
   * renewing it there would spend its single-use refresh token and keep the new one nowhere,
   * ending your own sign-in too. So Kuvo Code signs in once on its own (`claude setup-token`, a
   * long-lived token nothing renews), keeps it in its folder, and hands it to Claude Code as it
   * starts. On Linux, Claude Code's own sign-in is a file it renews itself, there in Kuvo Code's
   * folder, so it's used as it is.
   */
  /** How long a failure waits for the rest of what Claude Code said as it stopped. */
  static heardWithin = 1000
  static keychain = process.platform === "darwin"

  id = "claude"
  compacts = true
  readonly providerID: string
  get name() {
    return accountName("Claude Code", this.instance)
  }
  /** Anthropic's installer, as its docs give it. */
  install = "curl -fsSL https://claude.ai/install.sh | bash"
  private status?: { at: number; status: Status }
  /**
   * Claude turned its sign-in away in a run ("OAuth access token has been revoked"), though
   * `claude auth status` may still say signed in: with when its sign-in had last been written then
   * (undefined while that's read). Until it's written again (signing in, or renewed), the account
   * says it needs a sign-in; written again, `claude auth status` says.
   */
  turnedAway?: { written?: number }
  private modelList?: { at: number; models: Model[] }
  private loadingModels?: Promise<void>
  /** Told as Claude Code lists its models. */
  private listed: (() => void)[] = []
  /** Counts updates of Claude Code: a session's Claude Code started before the last one starts again. */
  program = 0

  /** Its own sign-in on a machine: Kuvo Code's, in its folder there, so signed out here. */
  signOut?: () => Promise<void>

  constructor(
    readonly context: AgentContext,
    readonly instance: AgentAccount = { id: "default" },
  ) {
    this.providerID = providerID("claude", instance.id)
    if (ClaudeAgent.keychain) {
      // Kuvo Code's own: yours, in Terminal, stays signed in.
      this.signOut = async () => {
        rmSync(this.tokenFile, { force: true })
        try {
          // An Anthropic Console sign-in, in Kuvo Code's own folder (an added account's: any of
          // its own), there or not known to be gone.
          if ((await this.readStatus(this.consoleEnv()).catch(() => undefined))?.loggedIn !== false) {
            await signOutWith("Claude Code", this.executable(), ["auth", "logout"], this.consoleEnv())
          }
        } finally {
          // Its token is gone either way.
          this.programUpdated()
          this.known.reset()
          this.modelList = undefined
        }
      }
    } else if (instance.id === "default" && instance.home) {
      this.signOut = async () => {
        await signOutWith("Claude Code", this.executable(), ["auth", "logout"], this.env())
        // A session's Claude Code holds the sign-in it started with: its next message starts one signed out.
        this.programUpdated()
        this.known.reset()
        this.modelList = undefined
      }
    }
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

  /** What `claude auth status` says; throws when it says nothing to go by (`TookTooLong`, or why not). */
  private async readStatus(env = this.env({ ownToken: false })): Promise<Status> {
    const executable = this.executable()
    if (!executable) throw new Error("Claude Code isn't installed.")
    const result = await run(executable, ["auth", "status", "--json"], { timeout: 20_000, env })
    if (result.timedOut) throw new TookTooLong("Claude Code took too long to say whether it's signed in.")
    let status: Status | undefined
    try {
      status = JSON.parse(result.stdout)
    } catch {}
    if (typeof status?.loggedIn !== "boolean") {
      const words = (result.stderr.trim() || result.stdout.trim()).split("\n").pop()?.trim().slice(0, 300)
      throw new Error(words ? `Claude Code couldn't say whether it's signed in: ${words}` : `Claude Code couldn't say whether it's signed in (it stopped with code ${result.code}).`)
    }
    this.status = { at: Date.now(), status }
    return status
  }

  /** Its sign-in as Claude Code last said, for 30 seconds (a check that fails isn't a sign-out). */
  private known = new KnownAccount(30_000)

  async account(fresh = false): Promise<Account> {
    if (!this.executable()) {
      return { installed: false, signedIn: false, message: "Install Claude Code, then sign in here." }
    }
    const account = await this.known.read(fresh, async () => {
      if (ClaudeAgent.keychain) {
        if (!this.token()) {
          // Signed in with an Anthropic Console account, in Kuvo Code's own folder (an added
          // account's, its own). Not a Claude plan an earlier version signed it in to there:
          // Claude Code would renew that one in the sandbox, which can't keep what it renews.
          const console = await this.readStatus(this.consoleEnv())
          if (console.loggedIn && console.authMethod !== "claude.ai") return { installed: true, signedIn: true, label: describe(console) || "Anthropic Console" }
          return { installed: true, signedIn: false, message: "Sign in to Claude Code with your Claude plan or an Anthropic Console account." }
        }
        // Who and which plan, from your own sign-in (Kuvo Code's can only ask Claude for answers),
        // read as it is: never renewed here. An added account's may be another one: not named.
        const status = this.instance.home ? undefined : await this.readStatus().catch(() => undefined)
        return { installed: true, signedIn: true, label: (status?.loggedIn && describe(status)) || "Claude plan" }
      }
      const status = await this.readStatus()
      if (!status.loggedIn) return { installed: true, signedIn: false, message: "Sign in to Claude Code with your Claude plan or an Anthropic Console account." }
      return { installed: true, signedIn: true, label: describe(status) || "Claude Code" }
    })
    // Claude turned the sign-in away in a run, though `claude auth status` may still say signed in.
    const turnedAway = this.turnedAway
    if (!turnedAway) return account
    if (turnedAway.written !== undefined && (await this.credentialsWritten()) > turnedAway.written) {
      // Written since (signed in, or marked dead by the run that was turned away): as it says now.
      if (this.turnedAway === turnedAway) this.turnedAway = undefined
      this.known.reset()
      return this.account()
    }
    return account.signedIn ? { installed: true, signedIn: false, ended: true, message: "Claude ended this sign-in. Sign in again." } : account
  }

  /** Paid per token (an API key), rather than by a plan. */
  usesKey() {
    if (ClaudeAgent.keychain && this.token()) return false
    const method = this.status?.status.authMethod ?? ""
    return method !== "" && method !== "claude.ai"
  }

  /**
   * Signed out of, as Claude Code says or as Claude turned it away: a message on it would only
   * fail, after Claude Code started and tried to renew it. Said first instead.
   */
  /** Claude turned its sign-in away: said at once, and to the apps, which show it needs one. */
  turnAway() {
    const turnedAway: { written?: number } = {}
    this.turnedAway = turnedAway
    void this.credentialsWritten().then((written) => (turnedAway.written = written), () => (turnedAway.written = 0))
    emit("integration.updated", { integrationID: this.providerID })
  }

  async signedOut() {
    const out = (account: Account) => account.installed && !account.signedIn
    // Asked anew before it's turned away: signed in a moment ago (in Terminal, say), it goes.
    return out(await this.account()) && out(await this.account(true))
  }

  /**
   * When its sign-in was last written: signing in, or renewing it (not its settings, which every
   * Claude Code writes as it runs). On a Mac, the Keychain's item (the account's own, by its date
   * only); and the file Claude Code keeps it in on Linux, or on a Mac when it can't write the
   * Keychain.
   */
  protected async credentialsWritten(): Promise<number> {
    if (ClaudeAgent.keychain) {
      try {
        return statSync(this.tokenFile).mtimeMs
      } catch {
        return 0
      }
    }
    const own = this.instance.home ?? process.env.CLAUDE_CONFIG_DIR
    let written = 0
    try {
      written = statSync(join(own ?? join(homedir(), ".claude"), ".credentials.json")).mtimeMs
    } catch {}
    // On a Mac, in the Keychain: an account with a folder of its own under a name of its own.
    if (process.platform === "darwin") written = Math.max(written, await keychainWritten(`Claude Code-credentials${own ? `-${createHash("sha256").update(own).digest("hex").slice(0, 8)}` : ""}`))
    return written
  }

  /** Its page can end on a code to paste back, wherever it's opened. */
  readonly signsInRemotely = true

  /** Kuvo Code's own sign-in on a Mac: in its folder, which the sandbox hides from what runs there. */
  /** On a Mac, the folder of an Anthropic Console sign-in: Kuvo Code's own, never your ~/.claude. */
  get consoleHome() {
    return this.instance.home ?? join(this.context.home, "claude", "console")
  }

  /** Claude Code's settings folder: an added account's, Kuvo Code's own for a Console sign-in on a
   * Mac, or yours. */
  get configHome() {
    if (this.instance.home) return this.instance.home
    if (ClaudeAgent.keychain && !this.token()) return this.consoleHome
    return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
  }

  /** Claude Code's env for an Anthropic Console sign-in on a Mac: in Kuvo Code's own folder, without
   * Kuvo Code's token (which would win), so yours in Terminal is never written. */
  consoleEnv() {
    return { ...this.env({ ownToken: false }), CLAUDE_CONFIG_DIR: this.consoleHome }
  }

  get tokenFile() {
    return join(this.context.home, "claude", "tokens", `${this.instance.id}.json`)
  }

  /**
   * Its plan's limits (claude-limits.ts), with Kuvo Code's own sign-in only: never yours in
   * Terminal. On Linux they're read from Anthropic, whose limit on reads is the computer's, so one
   * turned away holds every Claude account here (`bucket`); on a Mac its token can't read them, so
   * only what its turns hear tells them, and who it's for is as Anthropic told Claude Code running
   * with it.
   */
  readonly limits: LimitsSource = ClaudeAgent.keychain
    ? {
        every: CLAUDE_LIMITS_EVERY,
        // (Signed in to another account since, what its turns told goes: limits.ts, `switched`.)
        signIn: () => fingerprint(this.token()),
        identity: () => {
          const token = this.token()
          return token ? claudeIdentity(this.configHome, token) : undefined
        },
      }
    : {
        every: CLAUDE_LIMITS_EVERY,
        bucket: "anthropic",
        read: async (now) => {
          const signIn = this.limitsSignIn()
          return readClaudeLimits(signIn, signIn ? await this.programVersion() : undefined, now)
        },
        signIn: () => fingerprint(this.limitsSignIn()?.token),
        identity: () => (this.instance.home ? claudeIdentity(this.instance.home) : undefined),
      }

  /**
   * The sign-in its limits are read with: on a Mac Kuvo Code's own token; on Linux Claude Code's own
   * file in Kuvo Code's folder for it (`instance.home`), never one in your home.
   */
  limitsSignIn(): ClaudeSignIn | undefined {
    if (ClaudeAgent.keychain) {
      const token = this.token()
      return token ? { token } : undefined
    }
    return this.instance.home ? credentialsIn(this.instance.home) : undefined
  }

  private version?: { at: number; value?: string }

  /** Claude Code's version here, asked at most hourly. */
  protected async programVersion(): Promise<string | undefined> {
    if (this.version && Date.now() - this.version.at < 3_600_000) return this.version.value
    const executable = this.executable()
    const value = executable ? await installedVersion(executable).catch(() => undefined) : undefined
    this.version = { at: Date.now(), value }
    return value
  }

  /** Kuvo Code's own token, on a Mac, while it has one. */
  token(): string | undefined {
    try {
      const token = JSON.parse(readFileSync(this.tokenFile, "utf8"))?.token
      return typeof token === "string" && token ? token : undefined
    } catch {
      return undefined
    }
  }

  async signIn(methodID: string, options: SignInOptions = {}): Promise<SignInAttempt> {
    const executable = this.executable()
    if (!executable) throw new Error(`Install Claude Code first: ${this.install}`)
    if (ClaudeAgent.keychain && methodID !== "console") {
      const started = Date.now()
      let handedOver = false
      const keep = (token: string) => {
        mkdirSync(dirname(this.tokenFile), { recursive: true, mode: 0o700 })
        // Whole or not at all, for a session starting meanwhile.
        const writing = `${this.tokenFile}.${process.pid}.tmp`
        writeFileSync(writing, JSON.stringify({ token, made: started }), { mode: 0o600 })
        renameSync(writing, this.tokenFile)
        handedOver = true
      }
      return commandSignIn({
        command: executable,
        args: ["setup-token"],
        env: this.env({ ownToken: false }),
        home: this.context.home,
        temporary: this.context.temporary,
        instructions: "Finish signing in on Claude's page. This sign-in is Kuvo Code's own: Claude Code in Terminal stays signed in as it is.",
        signedIn: async () => handedOver,
        // It prints its page, and takes the code from it, only in a terminal.
        terminal: true,
        codePrompt: /Paste code here if prompted\s*>\s*/g,
        refusedCode: /wasn.t accepted|invalid code/i,
        // It asks for Enter to start over, with a new page: so does the app.
        refusedEnds: "Claude didn't take that code. Start again for a new one.",
        onLine: (line) => {
          const token = handedOver ? undefined : PRINTED_TOKEN.exec(line)?.[0]
          if (token) keep(token)
        },
        secret: PRINTED_SECRET,
        onComplete: () => {
          this.turnedAway = undefined
          this.known.reset()
          this.modelList = undefined
          // A session's Claude Code started without it: its next message starts one with it.
          this.programUpdated()
        },
        printedPage: options.remote,
      })
    }
    if (ClaudeAgent.keychain) mkdirSync(this.consoleHome, { recursive: true, mode: 0o700 })
    const env = ClaudeAgent.keychain ? this.consoleEnv() : this.env()
    return commandSignIn({
      command: executable,
      args: ["auth", "login", methodID === "console" ? "--console" : "--claudeai"],
      env,
      home: this.context.home,
      temporary: this.context.temporary,
      instructions: "Finish signing in on Claude's page. Claude Code keeps the sign-in, as when you run claude auth login.",
      // Claude Code's word: a sign-in Claude ended still reads as signed in there, so signing in
      // again counts once the command says it worked (another Claude Code writing its settings
      // meanwhile isn't it).
      signedIn: async () => (await this.readStatus(env)).loggedIn === true,
      codePrompt: /Paste code here if prompted >\s*/g,
      onComplete: () => {
        // In place of Kuvo Code's own Claude plan sign-in, on a Mac.
        if (ClaudeAgent.keychain) {
          rmSync(this.tokenFile, { force: true })
          this.modelList = undefined
          this.programUpdated()
        }
        this.turnedAway = undefined
        this.known.reset()
      },
      // On another device: the page it prints, which ends on a code to paste here.
      printedPage: options.remote,
    })
  }

  async sdk(): Promise<typeof import("@anthropic-ai/claude-agent-sdk")> {
    // Without its own copy of Claude Code: it runs yours.
    await this.context.deps.ensure(this.id, SDK, { optional: false })
    return this.context.deps.load(this.id, SDK[0].name)
  }

  /**
   * Its own files: in its settings folder, its plans, each project's memory (which it reads and
   * writes on its own) and what it saved of a long output, which it's told to read back
   * (`projects/<project>/<session>/tool-results`); and its background commands' output, in /tmp's
   * `claude-<uid>` when it has no temporary folder of its own (in the sandbox); and a bot's memory
   * in its folder, for the bot's own conversation.
   */
  ownsPath(path: string, session?: Session): boolean {
    const file = resolve(path)
    const memory = session && botMemory(session)
    if (memory && file.startsWith(memory + "/")) return true
    const settings = this.configHome
    if (file.startsWith(settings + "/") && /^(plans\/[^/]+\.md|projects\/[^/]+\/memory\/.+|projects\/[^/]+\/[^/]+\/tool-results\/.+)$/.test(file.slice(settings.length + 1))) return true
    const uid = process.getuid?.()
    return uid !== undefined && ["/tmp", "/private/tmp"].some((tmp) => file.startsWith(`${tmp}/claude-${uid}/`) && /^[^/]+\/[^/]+\/tasks\/[^/]+$/.test(file.slice(`${tmp}/claude-${uid}/`.length)))
  }

  /** Where its conversations in a folder are kept, in its settings folder. */
  private projectFolder(directory: string, home = this.configHome) {
    return join(home, "projects", projectSlug(directory))
  }

  /** The settings folders a conversation of its may be in: the one it runs with now first. */
  private homesItMayUse() {
    return [...new Set([this.configHome, ...(this.instance.home ? [] : [this.consoleHome, process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")])])]
  }

  /** Its conversation for a move: `<id>.jsonl`, the folder beside it (subagents, what it saved of long
   * outputs), and what it remembers, unless that's in the bot's own folder and goes with it. Claude
   * Code finds a conversation by its ID, whichever folder's it's in. */
  conversationFiles(state: Record<string, unknown>, session: Session): ConversationFiles | null {
    const id = state.claudeSession
    if (typeof id !== "string" || !state.claudeStarted) return null
    if (!CONVERSATION_ID.test(id)) return { items: [], missing: true }
    let folder: string | undefined
    for (const home of this.homesItMayUse()) {
      const named = this.projectFolder(session.location.directory, home)
      if (existsSync(join(named, `${id}.jsonl`))) {
        folder = named
        break
      }
    }
    if (!folder) {
      for (const home of this.homesItMayUse()) {
        const projects = join(home, "projects")
        const found = (() => {
          try {
            return readdirSync(projects).find((name) => existsSync(join(projects, name, `${id}.jsonl`)))
          } catch {
            return undefined
          }
        })()
        if (found) {
          folder = join(projects, found)
          break
        }
      }
    }
    if (!folder) return { items: [], missing: true }
    const beside = join(folder, id)
    const ownMemory = botMemory(session)
    const memory = ownMemory && existsSync(ownMemory) ? undefined : join(this.homesItMayUse().find((home) => folder.startsWith(home + "/")) ?? this.configHome, "projects", projectSlug(session.location.directory), "memory")
    return {
      items: [{ path: join(folder, `${id}.jsonl`), name: `${id}.jsonl` }, ...(existsSync(beside) ? [{ path: beside, name: id }] : [])],
      ...(memory && existsSync(memory) ? { memory, ...(ownMemory ? {} : { memoryShared: true }) } : {}),
    }
  }

  /** Where a conversation that came goes here: a bot's memory in its own folder (which goes wherever
   * it goes), a chat's with the others' in the chats folder, which all of them share. */
  conversationPlace(_state: Record<string, unknown>, session: Session): ConversationPlace {
    const folder = this.projectFolder(session.location.directory)
    const own = botMemory(session)
    return {
      item: (name) => (CONVERSATION_ITEM.test(name) ? join(folder, name) : null),
      memory: own ?? join(folder, "memory"),
      memoryMerges: !own,
    }
  }

  conversationRoots() {
    return this.homesItMayUse().map((home) => join(home, "projects"))
  }

  /** Where Claude Code reads skills itself: its settings folder's, and a project's `.claude/skills`. */
  ownSkillFolders(directory: string): string[] {
    const settings = this.configHome
    return [join(settings, "skills"), ...upward(directory).map((folder) => join(folder, ".claude", "skills"))]
  }

  /**
   * Claude Code's environment: an added account's own folder, and on a Mac Kuvo Code's own sign-in
   * (not when asking about yours).
   */
  env({ ownToken = true }: { ownToken?: boolean } = {}): Record<string, string | undefined> {
    // Not one the box was started with (the runner would merge it back if only deleted).
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_TMPDIR: join(this.context.temporary, "claude"), CLAUDE_CODE_OAUTH_TOKEN: undefined }
    if (this.instance.home) env.CLAUDE_CONFIG_DIR = this.instance.home
    const token = ownToken && ClaudeAgent.keychain ? this.token() : undefined
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
    // Without one, an Anthropic Console sign-in of Kuvo Code's own: Claude Code names its Keychain
    // item after its folder, so yours in Terminal is never written.
    else if (ownToken && ClaudeAgent.keychain) env.CLAUDE_CONFIG_DIR = this.consoleHome
    // On a machine, its commands get the machine's own folders back (it keeps its own in Kuvo
    // Code's folder).
    const own = onMachine ? ownFoldersScript(this.context.home) : undefined
    if (own) env.CLAUDE_ENV_FILE = own
    // Nor does it update itself there: with Kuvo Code's folders it would put the new version in
    // them (where your ~/.local/bin/claude would then point). Update does, with your own.
    if (onMachine) env.DISABLE_AUTOUPDATER = "1"
    return env
  }

  /** An added account signs out as it goes (its Keychain item with it, and Kuvo Code's own sign-in). */
  async removeAccount() {
    rmSync(this.tokenFile, { force: true })
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

  async concreteModel(id: string): Promise<string | undefined> {
    // Its only alias of its own: a model's own id (`opus`, `claude-opus-5-5`) stands for itself.
    if (id !== "default") return undefined
    // Only as Claude Code listed them here (its usual ones meanwhile are a guess): asked first, if it
    // hasn't said yet, until it lists them (not how much each holds, asked after), or gives up.
    if (!this.modelList) {
      void this.models()
      const loading = this.loadingModels
      await new Promise<void>((resolve) => {
        const told = () => {
          this.listed = this.listed.filter((each) => each !== told)
          resolve()
        }
        this.listed.push(told)
        if (loading) loading.then(told, told)
        else told()
      })
    }
    const models = this.modelList?.models ?? []
    if (models.some((model) => model.id === id)) return undefined
    return models.find((model) => model.aliases?.includes(id))?.id
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
    // Claude Code's `default` is whichever model it recommends now, listed beside that model under
    // its own name: to a person a second row of the same model. It isn't offered; the model it
    // stands for, on this account, is known by it too (a session, a star or a list that names it).
    const standing = list.find((info) => info.value === "default")
    const stands = standing && list.find((info) => info !== standing && stoodFor(standing, info))
    this.modelList = {
      at: Date.now(),
      models: list.flatMap((info, index) => {
        if (info === standing && stands) return []
        // (Where nothing else lists it, it's the model it stands for, under that model's id.)
        const alone = info === standing && standing.resolvedModel ? standing.resolvedModel : undefined
        // Where Claude Code listed its default (the first: that is what a new session starts on).
        const place = info === stands ? list.indexOf(standing!) : index
        const name = info === standing ? aloneName(info) : modelName(info)
        return [
          model(this.providerID, alone ?? info.value, name, {
            family: family(name),
            variants: info.supportedEffortLevels,
            images: true,
            context: this.windows.get(info.value) ?? (/1M/i.test(info.description ?? "") ? 1_000_000 : 200_000),
            released: Date.now() - place,
            ...(info === stands || alone ? { aliases: ["default"] } : {}),
          }),
        ]
      }),
    }
    for (const told of [...this.listed]) told()
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
  return what && /^(opus|sonnet|haiku|fable|claude)/i.test(what) ? what : info.displayName
}

/** What Claude Code's `default` is called where nothing else lists the model it stands for: that model's name, never "Default". */
function aloneName(info: ClaudeModelInfo): string {
  const what = info.description?.split(" · ")[0]?.trim()
  if (what && /^(opus|sonnet|haiku|fable|claude)/i.test(what)) return what
  // "claude-opus-5-5" → "Opus 5.5" (a date or a window after it left out).
  const parts = (info.resolvedModel ?? "").replace(/^claude-/, "").split("-").filter((part) => /^[a-z]+$/i.test(part) || /^\d{1,2}$/.test(part))
  const [maker, ...version] = parts
  return maker ? `${maker[0].toUpperCase()}${maker.slice(1)}${version.length ? " " + version.join(".") : ""}` : "Claude Code's recommended model"
}

/** Whether `info` is the model Claude Code's `default` stands for now: the same one it resolves to, or, where it doesn't say, the same name. */
function stoodFor(standing: ClaudeModelInfo, info: ClaudeModelInfo): boolean {
  if (standing.resolvedModel && info.resolvedModel) return standing.resolvedModel === info.resolvedModel
  return modelName(standing) === modelName(info)
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
    // (Until Claude Code says which its default is, a session on it shows as this and goes on.)
    model(providerID, "opus", "Opus", { family: "claude-opus", images: true, variants: ["low", "medium", "high", "xhigh", "max"], released: 3, aliases: ["default"] }),
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
  /** It's the /compact you asked for: no turn of words, and it may fail with a result that says success. */
  compacting?: boolean
  compactFailed?: boolean
  /** Claude turned its sign-in away: a turn to sign in again for, not to try again. */
  signInTurnedAway?: boolean
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

/** A subagent Claude Code started, as its conversation keeps it: its session, and Claude Code's id for it. */
interface KnownSubagent {
  sessionID: string
  title: string
  /** The kind of agent it is ("Explore"). */
  kind?: string
  /** Claude Code's id for it (its task's), which SendMessage reaches it by. */
  agentID?: string
}

/** How many subagents a conversation remembers, newest kept. */
const knownSubagents = 100

/**
 * How you write to a Claude Code subagent: through the agent that started it, which passes your
 * message on with its SendMessage tool. Its Explore and Plan agents run once and take none.
 */
function subagentRoute(kind: unknown): SubagentMessages {
  if (kind === "Explore" || kind === "Plan") return { via: "none", note: `Claude Code's ${kind} agents can't take messages.` }
  return { via: "parent" }
}

class ClaudeThread implements Thread {
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
  private tasks = new Map<string, { type: string; description: string; toolUseID?: string; shell?: string; outputFile?: string; last?: { output: string; total: number }; since?: number; backgrounded?: boolean }>()
  /** Its live background tasks, as it last listed them. */
  private liveTasks = new Set<string>()
  /** Commands it ran, by their call: what a background one runs. */
  private commands = new Map<string, string>()
  /** The last of its tasks to end: what began a turn it starts on its own. */
  private lastEnded?: { type: string; description: string; command?: string; status: string; summary?: string }
  private opened?: { model: string; effort?: string; plan: boolean; append: string; program: number; tools?: string; skills?: string; fence: string; subagents: string }
  /** Your subagents as it was last given them (their rules hold for their tools). */
  private subagents?: Subagents
  /** What a subagent of yours may do, for each of its tools it's asked about: by the tool's call. */
  private subagentAsks = new Map<string, PermissionRule[]>()
  /** The computer's servers it was last told (their names). */
  private servers?: string

  constructor(
    private readonly agent: ClaudeAgent,
    private readonly session: Session,
    private readonly state: Record<string, unknown>,
  ) {}

  /**
   * Its subagents, by the call that started each, kept with the conversation: one at work after
   * its turn goes on in its session, and one you write to is passed on by its id, after a restart too.
   */
  private get subagentSessions(): Record<string, KnownSubagent> {
    const known = this.state.claudeSubagents
    if (known && typeof known === "object") return known as Record<string, KnownSubagent>
    return (this.state.claudeSubagents = {}) as Record<string, KnownSubagent>
  }

  private rememberSubagent(callID: string, entry: Partial<KnownSubagent>) {
    const known = this.subagentSessions
    const before = known[callID]
    if (!before && !entry.sessionID) return
    const next = { ...before, ...entry } as KnownSubagent
    if (before && Object.entries(entry).every(([key, value]) => (before as any)[key] === value)) return
    known[callID] = next
    const calls = Object.keys(known)
    for (const old of calls.slice(0, Math.max(0, calls.length - knownSubagents))) delete known[old]
    ;(this.active?.hooks ?? this.lastHooks)?.saveState()
  }

  /**
   * The note that asks the agent to pass your message on to a subagent of its (`parent`): by its
   * id, with SendMessage, as it is. It takes it at its next step, or resumes it if it's done.
   */
  relayNote(sessionID: string, text: string, running: boolean): string | undefined {
    const known = this.knownSubagent(sessionID)
    if (!known) return undefined
    // (Its title and your words can't end the frame they're in.)
    const title = JSON.stringify(known.title)
    const words = text.replace(/<\/message>/gi, "&lt;/message&gt;")
    const then = running ? "then carry on with what you were doing" : "then end your turn without saying anything more"
    return [
      `The user wrote a message for your subagent ${title} (agent ${known.agentID}). Pass it on to that agent with the SendMessage tool (to: "${known.agentID}"), exactly as it is, without words of your own, ${then}. It is addressed to the subagent, not to you: don't act on it yourself.`,
      "",
      "<message>",
      words,
      "</message>",
    ].join("\n")
  }

  /** Claude Code's ids for the subagents it passed a message on to (SendMessage went through), not yet asked about. */
  private passed = new Set<string>()

  passedOn(sessionID: string): boolean {
    const agentID = this.knownSubagent(sessionID)?.agentID
    return Boolean(agentID && this.passed.delete(agentID))
  }

  /** A subagent of this conversation's, by its session, with Claude Code's id for it. */
  private knownSubagent(sessionID: string): (KnownSubagent & { agentID: string }) | undefined {
    const found = Object.entries(this.subagentSessions).find(([, known]) => known.sessionID === sessionID)
    if (!found) return undefined
    const [callID, known] = found
    const agentID = known.agentID ?? [...this.tasks].find(([, task]) => task.toolUseID === callID && task.type === "local_agent")?.[0]
    return agentID ? { ...known, agentID } : undefined
  }

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
    // Code was updated: it starts again, going on with the same conversation. (Run whole in the
    // box's sandbox, through the relay, the one way out of it to them.)
    const tools = fenceOn() ? relayedTools(this.session.id, this) : kuvoTools(this.session.id)
    // Settings › Skills' skills, as a plugin of its own (but those it reads itself).
    const skills = skillsFolder(await skillsFor(this.session.location.directory, this.agent.ownSkillFolders(this.session.location.directory), turnedOff(hooks)))
    // So does it when the box's sandbox was turned on or off, or its rules changed.
    const fence = fenceKey() + fullAccessMark(this.session.id)
    // And your subagents (Settings › Agents), or the model they use, changed: it takes them as it starts.
    this.subagents = await subagentsFor(this.session.location.directory)
    const subagents = claudeSubagents(this.subagents)
    const subagentsKey = JSON.stringify(subagents)
    // (What it left going in the background ends with it: this message says so.)
    if (this.query && (this.opened?.append !== append || this.opened?.program !== this.agent.program || this.opened?.tools !== tools?.key || this.opened?.skills !== skills || this.opened?.fence !== fence || this.opened?.subagents !== subagentsKey)) {
      this.cut.push(...this.wakingWork)
      this.close()
    }
    // The computer's MCP servers (yours, the integrations', a bot's with its own keys), through the
    // relay, which keeps their keys: another set of them is told to the same Claude Code.
    const computer = await computerServers(this.session.location.directory)
    const servers = relayedServers(this.session.id, this, this.session.location.directory, computer)
    const serversNow = serversKey(this.session.id, computer)
    const opening = !this.query
    if (opening) {
      this.open(sdk, modelID, effort, input.plan, append, hooks, skills, subagents)
    } else {
      // The same Claude Code goes on, told what changed.
      if (this.opened?.model !== modelID) await this.query.setModel(modelID === "default" ? undefined : modelID).catch(() => {})
      if (this.opened?.effort !== effort) await this.query.applyFlagSettings({ effortLevel: effort ?? null }).catch(() => {})
      if (this.opened?.plan !== input.plan) await this.query.setPermissionMode(input.plan ? "plan" : "default").catch(() => {})
      this.opened = { model: modelID, effort, plan: input.plan, append, program: this.agent.program, tools: tools?.key, skills, fence, subagents: subagentsKey }
    }
    // Kuvo Code's own tools, as the engine's models have them, and those servers: told over its
    // pipe, not on its command line (where any process could read their key).
    if (this.query && (opening || this.servers !== serversNow)) {
      const entries: Record<string, unknown> = {}
      // (Its key to them made again, if it started again: the old one went with it.)
      const tools = fenceOn() ? relayedTools(this.session.id, this) : kuvoTools(this.session.id)
      if (tools) entries[tools.name] = tools.kind === "http" ? { type: "http", url: tools.url, headers: tools.headers, timeout: tools.timeout } : { type: "stdio", command: tools.command, args: tools.args, env: tools.env, timeout: tools.timeout }
      for (const server of servers) entries[server.name] = { type: "http", url: server.url, headers: server.headers, timeout: server.timeout }
      this.servers = serversNow
      await this.query.setMcpServers(entries as any).catch(() => {})
    }
    if (hooks.signal.aborted) return { outcome: "interrupted" }
    // Stopped while it was told what changed (it couldn't start, say): nothing to send it to.
    if (!this.query || !this.input) {
      await this.heard(this.lastEnd, hooks.signal)
      if (hooks.signal.aborted) return { outcome: "interrupted" }
      return { outcome: "failed", error: this.stoppedWhy(this.lastEnd) }
    }
    return new Promise<RunResult>((resolve) => {
      this.lastHooks = hooks
      // A conversation it goes on with keeps the instructions it started with (until it's
      // summarized): what changed in them since is said ahead of the message, once. Not ahead of
      // a command (its /compact, a skill's), which goes as typed: the next message says it.
      const command = input.compact || input.text.trimStart().startsWith("/")
      const note = command ? undefined : instructionsNote(toldOf(this.state, "claudeTold"), append)
      const lostNote = this.cut.length && !command ? lostWorkNote("Claude Code started again before this message.", this.cut.splice(0)) : undefined
      // (A command, as typed, has no room for it: the session hears it as a note instead.)
      if (this.cut.length && command) this.onWorkLost?.(this.cut.splice(0))
      const ahead = [lostNote, note].filter(Boolean).join("\n\n")
      const message = userMessage(ahead ? { ...input, text: `${ahead}\n\n${input.text}` } : input, this.copies())
      let active: Active | undefined
      const answered = (result: RunResult) => {
        // (Said once it took the message, not one it never got to.)
        if (note && (result.outcome !== "failed" || !active?.steered.has(message.uuid))) {
          this.state.claudeTold = append
          hooks.saveState()
        }
        resolve(result)
      }
      // The turn ends with the result that answers it (one of its own before, like a command's
      // end it took up, doesn't end it). Its /compact, typed as you would, ends with the first.
      this.active = active = this.turnFor(turn, hooks, answered, input.auto, new Map(input.compact ? [] : [[message.uuid, ""]]))
      this.active.compacting = input.compact
      this.input!.push(message)
    })
  }

  /**
   * Claude Code rendered its instructions again, as it was started with them (a new conversation,
   * or one it summarized, as it keeps them until then): that's what it was told.
   */
  private promptRendered() {
    if (this.opened) this.state.claudeTold = this.opened.append
  }

  /** A turn here; as it ends, its subagents in the background are kept, to go on in their sessions. */
  private turnFor(turn: Turn, hooks: TurnHooks, resolve: (result: RunResult) => void, auto: boolean | undefined, steered: Map<string, string>): Active {
    const active: Active = { turn, hooks, resolve, streamed: new Set(), blockTools: new Map(), calls: new Map(), subagents: new Map(), auto, steered }
    active.resolve = (result) => {
      // Whatever the outcome: one this turn started, stopped or failed with it, the session ends
      // (and it's forgotten then); one an earlier turn sent off goes on, after a Stop too.
      for (const [callID, lane] of active.subagents) if (lane.background && !lane.turn.isEnded) this.backgroundLanes.set(callID, lane)
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
        const type = message.task_type ?? known?.type ?? ""
        // A subagent picked up again (your message, passed on with SendMessage) keeps its id and
        // its call: what it says comes under the call that started it, in the same session.
        const resumed = type === "local_agent" && known?.toolUseID && message.tool_use_id && message.tool_use_id !== known.toolUseID ? known.toolUseID : undefined
        // (Whether it runs in the background is Claude Code's to say: its Agent tool's default is.)
        const backgrounded = typeof message.is_backgrounded === "boolean" ? message.is_backgrounded : known?.backgrounded
        this.tasks.set(message.task_id, { ...known, type, description: message.description ?? known?.description ?? "", toolUseID: resumed ?? message.tool_use_id ?? known?.toolUseID, backgrounded })
        if (type === "local_agent" && typeof message.tool_use_id === "string" && !resumed) {
          this.rememberSubagent(message.tool_use_id, { agentID: message.task_id })
          // A subagent's own (the turn's have theirs from their call): its session from the start,
          // as the turn may end before it says anything.
          if (this.active) this.subagentLane(this.active, message.tool_use_id)
          if (backgrounded) this.toBackground(message.tool_use_id)
        }
        if (resumed && this.active) this.resumedLane(this.active, resumed)
        if (message.is_backgrounded && !message.ambient) this.shellFor(message.task_id)
        return
      }
      case "task_updated": {
        if (!message.patch?.is_backgrounded) return
        const task = this.tasks.get(message.task_id)
        if (task) task.backgrounded = true
        this.shellFor(message.task_id)
        // A subagent moved to the background: it works on past the turn.
        if (task?.type === "local_agent" && task.toolUseID) this.toBackground(task.toolUseID)
        return
      }
      case "task_notification": {
        const task = this.tasks.get(message.task_id)
        if (task && typeof message.output_file === "string") task.outputFile = message.output_file
        const command = task?.toolUseID ? this.commands.get(task.toolUseID) : undefined
        this.lastEnded = { type: task?.type ?? "", description: task?.description ?? String(message.summary ?? ""), command, status: String(message.status ?? "completed"), summary: message.summary }
        if (task?.shell) endShell(task.shell, message.status === "completed" ? 0 : undefined)
        // A subagent in the background done: its session's work ends. (One picked up again says
        // the call that did, SendMessage's: its own is the one that started it.)
        const callID = task?.type === "local_agent" && task.toolUseID ? task.toolUseID : typeof message.tool_use_id === "string" ? message.tool_use_id : task?.toolUseID
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
          this.tasks.set(task.task_id, { ...known, type: task.task_type ?? known?.type ?? "", description: task.description ?? known?.description ?? "", since: known?.since ?? Date.now() })
          this.shellFor(task.task_id)
        }
        for (const [id, task] of this.tasks) if (task.shell && !this.liveTasks.has(id)) endShell(task.shell)
        emit("session.background.updated", { sessionID: this.session.id }, this.session.location.directory)
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

  onWorkLost?: (lost: LostWork[]) => void
  /** What it had going when it was started again for a message, for that message to say. */
  private cut: LostWork[] = []

  /** What it left going, each of which tells it as it ends (Claude Code carries on then). */
  get wakingWork(): LostWork[] {
    if (!this.query) return []
    return [...this.liveTasks].map((id) => {
      const task = this.tasks.get(id)
      const output = task?.last?.output.trim().slice(-2_000) || undefined
      if (task?.type === "local_bash") return { kind: "command", what: (task.toolUseID ? this.commands.get(task.toolUseID) : undefined) ?? task.description, output }
      return { kind: "task", what: task?.description || "A task in the background", output }
    })
  }

  /** What it keeps going that's neither a command (in the bar) nor a subagent (a session of its own). */
  get backgroundTasks() {
    if (!this.query) return []
    return [...this.liveTasks].flatMap((id) => {
      const task = this.tasks.get(id)
      // (A subagent with a session is listed as one, under a turn or after it.)
      if (task?.shell || task?.type === "local_bash" || (task?.toolUseID && (this.backgroundLanes.has(task.toolUseID) || this.active?.subagents.has(task.toolUseID)))) return []
      return [{ id, since: task?.since ?? Date.now() }]
    })
  }

  async stopBackgroundTasks() {
    for (const { id } of this.backgroundTasks) await this.query?.stopTask?.(id).catch(() => {})
  }

  private open(sdk: any, modelID: string, effort: string | undefined, plan: boolean, append: string, hooks: TurnHooks, skills?: string, subagents: ReturnType<typeof claudeSubagents> = { agents: {} }) {
    // (Without it, the SDK's own words would be about a build of its own it doesn't have.)
    if (!this.agent.executable()) throw new Error(`Install Claude Code first: ${this.agent.install}`)
    // Why an earlier one ended is not this one's.
    this.lastEnd = undefined
    this.said = undefined
    let id = this.state.claudeSession as string | undefined
    const resume = Boolean(id && this.state.claudeStarted)
    if (!id) {
      id = randomUUID()
      this.state.claudeSession = id
      hooks.saveState()
    }
    // A new conversation counts its cost from nothing, and has the instructions it's given now.
    if (!resume) {
      delete this.state.claudeCost
      this.state.claudeTold = append
      hooks.saveState()
    }
    // While the box's sandbox is on, Claude Code runs whole in it, and so does all it starts: its
    // commands, its hooks and MCP servers (yours, and a project's).
    const whole = this.whole(skills, id)
    const named = botMemory(this.session)
    const ownMemory = named && existsSync(named) ? named : undefined
    this.input = new Queue()
    const tools = fenceOn() ? relayedTools(this.session.id, this) : kuvoTools(this.session.id)
    this.opened = { model: modelID, effort, plan, append, program: this.agent.program, tools: tools?.key, skills, fence: fenceKey() + fullAccessMark(this.session.id), subagents: JSON.stringify(subagents) }
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
        // Your subagents, over one of the same name in ~/.claude/agents (as its --agents flag's are).
        ...(Object.keys(subagents.agents).length ? { agents: subagents.agents } : {}),
        ...(resume ? { resume: id } : { sessionId: id }),
        // A bot's memory in its own folder, once it's there.
        ...(ownMemory ? { settings: { autoMemoryDirectory: ownMemory } as any } : {}),
        // Its commands know their conversation, as the engine's do (kuvo-wake schedules for it).
        // And the model its subagents use when theirs doesn't say (Settings › Agents), one it runs.
        env: { ...this.agent.env(), OPENCODE_SESSION_ID: this.session.id, ...(subagents.model ? { CLAUDE_CODE_SUBAGENT_MODEL: subagents.model } : {}), ...whole?.env },
        // Its own sandbox off while the box's is on (yours, or a project's settings, may turn it
        // on): one sandbox can't run inside another on a Mac, and every command would fail.
        ...(whole ? { sandbox: { enabled: false }, spawnClaudeCodeProcess: whole.spawn } : {}),
        stderr: () => {},
      },
    })
    void this.read(this.query)
  }

  /**
   * While the box's sandbox is on here, how Claude Code starts in it, whole: through the box's
   * launcher, in the conversation's folder, with its settings folder its own (`STATE_IN_HOME`), the
   * skills it's given and the files you attach to read, and its Kuvo Code tools through the relay.
   * Undefined while it's off; on, but with no launcher yet (a box from before it had one, until it
   * starts again), it doesn't start, rather than outside it.
   */
  private whole(skills: string | undefined, conversation: string) {
    this.sandboxedNow = fenceOn() || undefined
    if (!this.sandboxedNow) return undefined
    this.environment(conversation)
    const started = ++this.startsInSandbox
    const directory = this.session.location.directory
    const attached = fenceAttachments(directory)
    const settings = this.agent.configHome
    // (On a machine, the script that gives its commands the machine's own folders back, in Kuvo Code's.)
    const machineFolders = this.agent.env().CLAUDE_ENV_FILE
    const fence = fenceAgent(this.agent.executable()!, directory, {
      homes: [settings],
      state: STATE_IN_HOME,
      kept: KEPT_IN_HOME,
      read: [...(skills ? [skills] : []), ...(attached ? [attached] : []), ...(machineFolders ? [machineFolders] : [])],
      port: relayPort(),
      session: this.session.id,
      bot: seatBot(this.session),
    })
    if (!fence) throw new Error("Claude Code runs in the sandbox here, and it isn't ready: restart Kuvo Code.")
    // Its temporary files where the launcher puts them (the box's own folder is hidden from it),
    // its commands with no shell of the box's (they're in the sandbox already, and one can't run
    // inside another), and no updates of its own, which it can't write there (Update does, outside).
    const env: Record<string, string | undefined> = { CLAUDE_CODE_TMPDIR: undefined, CLAUDE_CODE_SHELL: undefined, DISABLE_AUTOUPDATER: "1" }
    return {
      env,
      spawn: (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal }) => {
        // (The program as the SDK names it.)
        const given = Object.fromEntries(Object.entries({ ...options.env, ...fence.env, KUVO_FENCE_SHELL: options.command, ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined))
        const child = spawn(fence.command, options.args, { cwd: options.cwd ?? directory, env: given, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] })
        child.once("exit", () => {
          fence.ended()
          // (Not as one being replaced stops: the new one needs them.)
          if (started === this.startsInSandbox) this.environmentsEnded()
        })
        // What it says as it stops, for why it did (the SDK keeps that only for a process it starts
        // itself), this one's alone: one being replaced can still be writing.
        const said = new Said()
        this.said = said
        this.saidAll = new Promise((done) => {
          if (!child.stderr) return done()
          child.stderr.once("close", () => {
            said.finish()
            done()
          })
        })
        child.stderr?.setEncoding("utf8")
        child.stderr?.on("data", (chunk: string) => said.add(chunk))
        child.stderr?.on("error", () => {})
        return child
      },
    }
  }

  /**
   * A conversation's `session-env` folder, made here, outside the sandbox. Claude Code makes it before
   * each SessionStart hook (and Setup, CwdChanged and FileChanged hook) to name it a file there, and
   * the hook doesn't start if it can't. It stays closed to the sandbox, as it must: your own Claude
   * Code runs what's in it before each command if you open this conversation yourself. So a hook's
   * `CLAUDE_ENV_FILE` isn't written, and what it sets doesn't reach the commands here.
   */
  private environment(conversation: string) {
    if (!/^[A-Za-z0-9-]+$/.test(conversation)) return
    const folder = join(this.agent.configHome, "session-env", conversation)
    try {
      mkdirSync(folder, { recursive: true })
      this.environments.add(folder)
    } catch {}
  }

  /** As it stops, those it left empty: it can't clear out old ones itself in the sandbox. Yours, with your own hooks' files in them, stay. */
  private environmentsEnded() {
    for (const folder of this.environments)
      try {
        rmdirSync(folder)
      } catch {}
    this.environments.clear()
  }

  private environments = new Set<string>()
  private startsInSandbox = 0

  /** How the files you attach reach this Claude Code: in the box's sandbox, copies it reads. */
  private copies(): ((path: string) => string) | undefined {
    const directory = this.session.location.directory
    return this.sandboxedNow ? (path) => fenceCopy(directory, path) : undefined
  }

  /** Whether the box's sandbox was on as this Claude Code started: it runs whole in it. */
  private sandboxedNow?: true

  get sandboxed() {
    return Boolean(this.query) && this.sandboxedNow === true
  }
  // (Started while the sandbox was off: it, and what it runs, are outside it.)
  get outside() {
    return Boolean(this.query) && this.sandboxedNow === undefined
  }

  private async read(query: any) {
    let ended: unknown
    try {
      for await (const message of query) this.handle(message)
    } catch (error) {
      ended = error
    }
    if (this.query === query) {
      // Ended by itself between turns (killed, or crashed) with work going that would have woken
      // it as it ended: that went with it, and nothing will (no turn here to fail and say so).
      const lost = this.active ? [] : this.wakingWork
      this.query = undefined
      this.input = undefined
      this.lastEnd = ended
      // Claude Code stopped (or crashed): what it left running went with it.
      this.leftRunning()
      emit("session.background.updated", { sessionID: this.session.id }, this.session.location.directory)
      if (lost.length) this.onWorkLost?.(lost)
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
    else {
      if (!active.problem) await this.heard(ended, active.hooks.signal)
      if (active.hooks.signal.aborted) return active.resolve({ outcome: "interrupted" })
      active.resolve({ outcome: "failed", error: this.failed(active, active.problem ? told(active.problem) : this.stoppedWhy(ended, "Claude Code stopped.")) })
    }
  }

  /** Why its last Claude Code stopped, when no turn was there to say. */
  private lastEnd?: unknown

  /** What the Claude Code run whole in the sandbox says on its error output, and when that's all there. */
  private said?: Said
  private saidAll?: Promise<void>

  /** Until all it said has come for a failure (its exit can arrive first), but not for long: a
   * command it left running can hold its error output open. Nor once you stop the turn. */
  private async heard(ended: unknown, stopped: AbortSignal) {
    if (ended === undefined || !this.said || stopped.aborted) return
    let bound: ReturnType<typeof setTimeout> | undefined
    let stop = () => {}
    await Promise.race([
      this.saidAll,
      new Promise<void>((done) => {
        bound = setTimeout(done, ClaudeAgent.heardWithin)
        stop = done
        stopped.addEventListener("abort", stop, { once: true })
      }),
    ])
    clearTimeout(bound)
    stopped.removeEventListener("abort", stop)
  }

  /** A Claude Code that stopped (before it took the turn's message, say): why, as it said, with the
   * last line it wrote as it stopped ("Can't read the current directory…"). */
  private stoppedWhy(ended: unknown, otherwise = "Claude Code stopped before it took your message.") {
    const error = told(ended ?? otherwise)
    const last = this.said?.last
    return ended !== undefined && last && !error.message.includes(last) ? { ...error, message: `${error.message}: ${last}` } : error
  }

  /**
   * A turn's failure, as the apps offer a way out of it. Claude turned the sign-in away: one to
   * sign in again for, and this Claude Code goes (it holds the sign-in it started with), so the
   * next message starts one that reads the sign-in as it is then.
   */
  private failed(active: Active, error: { type: string; message: string }) {
    if (!active.signInTurnedAway) return error
    this.close()
    return { ...error, type: "signin" }
  }

  private handle(message: any) {
    this.said?.forget()
    if (message.type === "system" && message.subtype === "init") {
      if (!this.state.claudeStarted || this.state.claudeSession !== message.session_id) {
        // (Its /clear: a new name it chose, for its next hooks. The one for that moment ran already.)
        if (this.sandboxedNow && typeof message.session_id === "string") this.environment(message.session_id)
        this.state.claudeSession = message.session_id
        this.state.claudeStarted = true
        // A new conversation (its first, or its /clear) has the instructions it was started with.
        this.promptRendered()
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
          this.agent.turnAway()
          if (active) {
            active.problem = "Claude ended this sign-in, and Claude Code couldn't renew it."
            active.signInTurnedAway = true
          }
        } else if (typeof error === "string" && active && lane === active) {
          // Its own words when it has them ("prompt is too long: 210000 > 200000"), in the failure.
          const said = content.flatMap((block: any) => (block.type === "text" && block.text ? [String(block.text).trim()] : [])).join("\n").trim()
          active.problem ??= said || apiErrorWords(error)
        }
        // Its words for an error the turn fails with: said once, as its failure, not as a reply too.
        const failing = Boolean(error) && active !== undefined && lane === active
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
            if (block.type === "text" && block.text && !failing) turn.text(block.text)
            else if (block.type === "thinking" && block.thinking) turn.reasoning(block.thinking)
            else if (block.type === "redacted_thinking") turn.reasoning("(The model kept this thinking to itself.)")
            else if (block.type === "compaction") turn.compacted(true)
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
        const info = message.rate_limit_info ?? {}
        // Where the plan stands, for its limits (limits.ts), whichever turn heard it.
        for (const window of heardWindows(info)) this.agent.limits.heard?.(window)
        if (!active || lane !== active) return
        // A limit being used up: said once per threshold it passes, and again once it's close, so the stop doesn't come out of nowhere.
        if (info.status === "allowed_warning") {
          const warning = limitWarning(info)
          this.noticeOnce(`warn:${info.rateLimitType}:${info.surpassedThreshold ?? ""}:${warning.close ? "close" : ""}`, turn, warning.text)
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
        this.promptRendered()
        this.lastHooks?.saveState()
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
        // Summarized: its instructions are as it was started with again. (One you asked for shows
        // as that, whichever way it ends.)
        if (!message.parent_tool_use_id) {
          this.promptRendered()
          this.lastHooks?.saveState()
        }
        if (!active?.compacting) turn.compacted(true)
        return
      case "status": {
        // One it makes by itself: `compacting` as it begins (and again while it waits), then a
        // `null` status with how it went. A bare `null` one says no more than that it isn't
        // summarizing now: it may begin again at once (the same row), or the model answers next
        // (which ends the row: see Turn.startStep), or the turn ends.
        if (active?.compacting) {
          if (message.compact_result !== "failed") return
          active.compactFailed = true
          active.problem = `Claude Code couldn't summarize the conversation${message.compact_error ? `: ${String(message.compact_error).replace(/\.$/, "")}` : ""}.`
          return
        }
        if (message.status === "compacting") turn.compacting()
        else if (message.compact_result === "success" || message.compact_result === "failed") turn.compacted(message.compact_result === "success")
        return
      }
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
        if (message.outcome === "error" || message.exit_code) turn.notice(`Your ${message.hook_name ?? message.hook_event ?? ""} hook failed${this.hookWords(String(message.stderr ?? ""))}.`)
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

  /** What a hook that failed said, for its row. Where the sandbox kept it from its session's
   * environment (`environment`), that in words, not the folder's path. */
  private hookWords(said: string): string {
    const lines = said.trim().split("\n")
    const about = lines.filter((line) => line.includes("session-env"))
    if (!this.sandboxedNow || !about.length) return said.trim() ? `: ${said.trim()}` : ""
    const why = about.some((line) => line.includes("mkdir")) ? "Claude Code can't start this one in the sandbox" : "the sandbox doesn't let a hook set environment variables with CLAUDE_ENV_FILE"
    return `: ${[...lines.filter((line) => !line.includes("session-env") && line.trim()), why].join("\n")}`
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
    const before = this.subagentSessions[callID]
    let run: SubagentRun
    let background = false
    if (call) {
      const input = call.input
      if (kuvoTool(call.name, input).name !== "subagent") return undefined
      // As Claude Code says it runs (its Agent tool runs one in the background unless told not
      // to); before it says, as the call asked.
      const agentID = [...this.tasks].find(([, task]) => task.toolUseID === callID && task.type === "local_agent")?.[0]
      background = (agentID ? this.tasks.get(agentID)?.backgrounded : undefined) ?? input.run_in_background === true
      run = active.hooks.subagent(callID, { title: String(input.description ?? ""), prompt: typeof input.prompt === "string" ? input.prompt : undefined, agent: input.subagent_type, background, messages: subagentRoute(input.subagent_type) })
      run.stop = () => this.stopSubagent(callID)
      this.rememberSubagent(callID, { sessionID: run.sessionID, title: String(input.description ?? ""), ...(typeof input.subagent_type === "string" ? { kind: input.subagent_type } : {}), ...(agentID ? { agentID } : {}) })
    } else if (before) {
      // One sent off in the background in an earlier turn, still at work: its session goes on.
      run = active.hooks.subagent(callID, { title: before.title, sessionID: before.sessionID, background: true, messages: subagentRoute(before.kind) })
      run.stop = () => this.stopSubagent(callID)
      background = true
    } else {
      return undefined
    }
    const lane = { turn: run.turn, streamed: new Set<string>(), blockTools: new Map<number, string>(), calls: new Map<string, { name: string; input: Record<string, any> }>(), run, background }
    active.subagents.set(callID, lane)
    return lane
  }

  /**
   * A subagent picked up again with your message (SendMessage resumed it once it was done): its
   * session goes on, as one in the background, until it says it's done.
   */
  private resumedLane(active: Active, callID: string) {
    const before = this.subagentSessions[callID]
    if (!before) return
    // Still at work: it takes the message at its next step.
    const known = active.subagents.get(callID) ?? this.keptLane(callID)
    if (known && !known.run.turn.isEnded) return
    this.backgroundLanes.delete(callID)
    const run = active.hooks.subagent(callID, { title: before.title, sessionID: before.sessionID, background: true, messages: subagentRoute(before.kind) })
    run.stop = () => this.stopSubagent(callID)
    active.subagents.set(callID, { turn: run.turn, streamed: new Set<string>(), blockTools: new Map<number, string>(), calls: new Map<string, { name: string; input: Record<string, any> }>(), run, background: true })
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
    // A message passed on to a subagent (SendMessage went through): by its id, and the one
    // Claude Code says it reached.
    if (active && lane === active && call?.name === "SendMessage" && !block.is_error && !/"success"\s*:\s*false/.test(text)) {
      if (typeof call.input.to === "string") this.passed.add(call.input.to)
      try {
        const said = JSON.parse(text)
        for (const id of [said?.resumedAgentId, said?.pin?.id]) if (typeof id === "string") this.passed.add(id)
      } catch {}
    }
    // A subagent's task came back: its session's work is done (one sent off in the background
    // goes on, and ends with the turn).
    const subagent = active && lane === active ? active.subagents.get(id) : undefined
    // Launched in the background, as its result says (a Claude Code that doesn't say so as it starts).
    if (subagent && structured?.status === "async_launched") this.toBackground(id)
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
    const succeeded = result.subtype === "success" && !result.is_error && !active.compactFailed
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
    active.resolve({ outcome: "failed", error: this.failed(active, { type: "agent", message }), taken: true })
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
    // A subagent of yours goes by what it may do (Settings › Agents), with the session's rules over that.
    const agentRules = input.agent_id ? subagentRules(this.subagents, input.agent_type) : undefined
    if (agentRules && typeof input.tool_use_id === "string") {
      this.subagentAsks.set(input.tool_use_id, agentRules)
      // (Only those it then asks about are taken back: the last hundred are plenty.)
      for (const old of [...this.subagentAsks.keys()].slice(0, Math.max(0, this.subagentAsks.size - 100))) this.subagentAsks.delete(old)
    }
    const ask = { ...permissionAsk(String(input.tool_name ?? ""), input.tool_input ?? {}), ...(agentRules ? { agentRules } : {}) }
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
      let declinedWords: string | undefined
      const answer = await hooks.question({ title: questions.length === 1 ? questions[0].header ?? "Question" : "Questions", fields, toolCallID: toolUseID , declined: (words) => { declinedWords = words } })
      if (!answer) return { behavior: "deny", message: declinedWords ?? "The user dismissed the question.", toolUseID }
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

  /** A subagent Claude Code runs in the background, as it says: its session goes on past the turn. */
  private toBackground(callID: string) {
    const lane = this.active?.subagents.get(callID) ?? this.keptLane(callID)
    if (!lane || lane.background || lane.run.turn.isEnded) return
    lane.background = true
    lane.run.inBackground()
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
    const agentRules = typeof toolUseID === "string" ? this.subagentAsks.get(toolUseID) : undefined
    if (typeof toolUseID === "string") this.subagentAsks.delete(toolUseID)
    const ask = permissionAsk(name, input)
    const decision = await permission({ toolCallID: toolUseID, ...ask, message: options?.title ?? options?.description, ...(agentRules ? { agentRules } : {}) })
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
    const message = { ...userMessage(input, this.copies()), priority: "next" }
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
    // Its key to its tools and servers through the relay goes with it.
    dropRelayed(this.session.id, this)
  }

  /** What it left running ends with it. */
  private leftRunning() {
    for (const task of this.tasks.values()) if (task.shell) endShell(task.shell)
    // (Its subagents in the background, kept or with the turn under way now.)
    for (const lane of this.active?.subagents.values() ?? []) if (lane.background) lane.run.end("interrupted")
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
export const claudeMessages = new Set(["assistant", "user", "stream_event", "result", "system", "rate_limit_event", "auth_status", "conversation_reset", "tool_progress", "tool_use_summary", "prompt_suggestion", "command_lifecycle"])

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
    case "seven_day":
      return "You've reached your weekly Claude limit."
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

/** A message of yours, with the files you attach as Claude Code reaches them (`copy`: run whole in the box's sandbox, copies it reads). */
function userMessage(input: Pick<RunInput, "text" | "files">, copy: (path: string) => string = (path) => path): any {
  const content: any[] = []
  const others: string[] = []
  for (const file of input.files) {
    const isImage = /^image\/(png|jpeg|gif|webp)$/.test(file.mime)
    const data = file.data ?? (isImage && file.path ? safeBase64(file.path) : undefined)
    if (isImage && data) content.push({ type: "image", source: { type: "base64", media_type: file.mime, data } })
    else if (file.path) others.push(copy(file.path))
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

/** When a Keychain item was last changed, by its date only (its secret is never read): 0 if none. */
async function keychainWritten(service: string): Promise<number> {
  const result = await run("/usr/bin/security", ["find-generic-password", "-s", service], { timeout: 5_000 }).catch(() => undefined)
  const date = /"mdat"<timedate>=0x[0-9A-F]+\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(result?.stdout ?? "")
  return date ? Date.UTC(+date[1]!, +date[2]! - 1, +date[3]!, +date[4]!, +date[5]!, +date[6]!) : 0
}

/** Who's signed in and on which plan, as `claude auth status` says. */
function describe(status: Status): string {
  const plan = status.subscriptionType ? `${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)} plan` : undefined
  const who = status.email ?? (status.apiProvider && status.apiProvider !== "firstParty" ? status.apiProvider : undefined)
  return [who, plan].filter(Boolean).join(" · ")
}
