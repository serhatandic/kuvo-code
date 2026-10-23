// Antigravity, as T3 Code runs it: Google's own Antigravity agent (`agy_acp_server`), downloaded
// from Google the first time you sign in, signed in with your Google account, speaking ACP. All of
// it (the agent, your sign-in, its conversations) stays in the bridge's `antigravity` folder.

import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { providerID, type AgentAccount } from "../accounts"
import type { Agent, AgentContext, Account, SignInAttempt, SubagentRun, Thread, SubagentTask, TurnHooks } from "../agent"
import { accountName, ContextWindows, failure, model } from "../agent"
import { AcpThread } from "../acp"
import { emit } from "../events"
import { withOwnFolders } from "../machine"
import { newID } from "../ids"
import { run, which } from "../proc"
import { RPC } from "../rpc"
import { catcher } from "../signin"
import { copySkillsInto, skillsFor, turnedOff } from "../skills"
import type { Turn } from "../turn"
import type { Model, OAuthStatus, Session } from "../wire"

const version = "1.3.0"
const releases: Record<string, { url: string; sha256: string; bytes: number }> = {
  "darwin-arm64": {
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip",
    sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
    bytes: 111456962,
  },
  "darwin-x64": {
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip",
    sha256: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
    bytes: 117245544,
  },
  "linux-x64": {
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip",
    sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
    bytes: 333727150,
  },
  "linux-arm64": {
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip",
    sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
    bytes: 321690363,
  },
}
const executableName = "agy_acp_server.par"
const harnessName = "localharness_external"
/** What it says on stdout when it wants you to sign in (not ACP). */
const signInLine = "Open the following link to authenticate the ACP server:"
/** Your other Google keys and settings, kept from it: it signs in its own way. */
const scrubbed = [
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT", "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH", "GEMINI_HOME", "AGY_ACP_FORCE_FILE_STORAGE", "ANTIGRAVITY_HARNESS_PATH", "BROWSER", "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
]

/** The subagents an invoke_subagent call starts: {Subagents: [{Role, TypeName, Prompt, Model}]}, as an object or as JSON. */
/** The subagents an `invoke_subagent` call asks for (its `Subagents`: a list, or the list written as JSON). */
export function antigravitySubagents(args: any): SubagentTask[] {
  let list = args?.Subagents
  if (typeof list === "string") {
    try {
      list = JSON.parse(list)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return list.map((subagent: any) => ({
    title: String(subagent?.Role ?? subagent?.TypeName ?? "A subagent's task"),
    prompt: typeof subagent?.Prompt === "string" ? subagent.Prompt : undefined,
    agent: typeof subagent?.TypeName === "string" && subagent.TypeName !== "self" ? subagent.TypeName : undefined,
  }))
}

/**
 * The image a generate_image call saved in the conversation's folder (`<image_name>_<time>.jpg`),
 * the newest; one saved since the turn began (`since`, ms), when it isn't named (the folder holds
 * your attachments and earlier pictures too).
 */
export function generatedImages(folder: string, input: Record<string, unknown>, since?: number): { type: "file"; uri: string; mime: string; name: string }[] {
  const stem = String(decoded(input.image_name ?? input.ImageName ?? "") ?? "")
  if (!stem && since === undefined) return []
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }
  const images = names
    .map((name) => ({ name, type: types[name.split(".").pop()?.toLowerCase() ?? ""] }))
    .filter((file) => file.type && (!stem || file.name.startsWith(`${stem}_`) || file.name.startsWith(`${stem}.`)))
    .map((file) => ({ ...file, at: (() => {
      try {
        return statSync(join(folder, file.name)).mtimeMs
      } catch {
        return 0
      }
    })() }))
    .filter((file) => stem || file.at >= since!)
    .sort((a, b) => b.at - a.at)
  const newest = images[0]
  return newest ? [{ type: "file", uri: pathToFileURL(join(folder, newest.name)).href, mime: newest.type!, name: newest.name }] : []
}

/** One step of Antigravity's record of a conversation (`brain/<id>/.system_generated/logs/transcript.jsonl`). */
interface Step {
  step_index: number
  type?: string
  status?: string
  content?: string
  tool_calls?: { name?: string; args?: Record<string, unknown> }[]
}

interface Child {
  id: string
  row: string
  task: SubagentTask
  run: SubagentRun
  /** Each step shown so far, with its status then. */
  shown: Map<number, string>
  /** Its tool calls waiting for their results, oldest first, and the step that gave each a result. */
  open: string[]
  results: Map<number, string>
  toolsSinceText: boolean
  ended: boolean
}

/**
 * Antigravity tells the conversation's own words and tools over its protocol, but not its
 * subagents: it writes them down. This follows that record while a turn runs: a row and a session
 * for each subagent it starts (with its role and task), and each one's steps in its session.
 */
export class AntigravityFollower {
  private seen = new Set<number>()
  private pending: SubagentTask[] = []
  private children = new Map<string, Child>()
  private timer?: ReturnType<typeof setInterval>
  private turn?: Turn
  private hooks?: TurnHooks

  constructor(
    private readonly brain: string,
    private readonly sessionId: string,
    private readonly every = 1_000,
  ) {
    // What's there already (a conversation picked up again) was shown with its own turns.
    for (const step of this.steps(sessionId)) this.seen.add(step.step_index)
  }

  /** Follows a turn of the conversation: each of its turns in turn, the one it began on its own too. */
  follow(turn: Turn, hooks: TurnHooks): this {
    clearInterval(this.timer)
    this.turn = turn
    this.hooks = hooks
    // One still at work as the last turn ended was ended with it: what it does next opens its session again.
    for (const child of this.children.values()) if (!child.ended && child.run.turn.isEnded) child.ended = true
    this.timer = setInterval(() => this.read(), this.every)
    return this
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
    this.read()
    // One that finished its work is done; the rest end with the turn.
    for (const child of this.children.values()) if (!child.ended && this.isDone(child)) this.end(child)
  }

  private steps(conversation: string): Step[] {
    try {
      return readFileSync(join(this.brain, conversation, ".system_generated", "logs", "transcript.jsonl"), "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            const step = JSON.parse(line)
            return typeof step?.step_index === "number" ? [step as Step] : []
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  read() {
    if (!this.turn || this.turn.isEnded) return
    for (const step of this.steps(this.sessionId)) {
      if (this.seen.has(step.step_index) || step.status === "RUNNING") continue
      this.seen.add(step.step_index)
      for (const call of step.tool_calls ?? []) if (call?.name === "invoke_subagent") this.pending.push(...antigravitySubagents(call.args))
      // "Created the following subagents": their conversations, in the order they were asked for.
      if (step.type === "INVOKE_SUBAGENT" && typeof step.content === "string") {
        for (const match of step.content.matchAll(/"conversationId":\s*"([^"]+)"/g)) this.start(match[1])
      }
    }
    for (const child of this.children.values()) this.readChild(child)
  }

  private start(id: string) {
    if (this.children.has(id)) return
    const task = this.pending.shift() ?? { title: "A subagent's task" }
    const row = `agy-subagent:${id}`
    this.turn!.toolStart(row, "subagent", { description: task.title, prompt: task.prompt, agent: task.agent })
    const run = this.hooks!.subagent(row, task)
    this.turn!.toolSucceeded(row, "Started.", { sessionID: run.sessionID })
    this.children.set(id, { id, row, task, run, shown: new Map(), open: [], results: new Map(), toolsSinceText: false, ended: false })
  }

  private readChild(child: Child) {
    const steps = this.steps(child.id)
    for (const step of steps) {
      const was = child.shown.get(step.step_index)
      if (was === step.status) continue
      // More to do after it was done (a message for it, a timer of its own): its session goes on.
      if (child.ended && was === undefined) {
        // (What it was asked first is in its session already; what it's told now shows as it comes.)
        child.run = this.hooks!.subagent(child.row, { ...child.task, prompt: undefined, sessionID: child.run.sessionID })
        child.ended = false
        child.toolsSinceText = false
      }
      child.shown.set(step.step_index, step.status ?? "")
      if (was === undefined) this.show(child, step)
      else this.settle(child, step)
    }
    if (!child.ended && this.isDone(child, steps)) this.end(child)
  }

  /** A step it took, in its session. */
  private show(child: Child, step: Step) {
    const turn = child.run.turn
    // The task it was given, and messages for it (a timer, another agent): in its session already, or not words of its own.
    if (step.type === "SYSTEM_MESSAGE" || step.type === "USER_INPUT") return
    if (step.type === "PLANNER_RESPONSE") {
      if (step.content?.trim()) {
        if (child.toolsSinceText) {
          turn.endStep()
          turn.startStep()
          child.toolsSinceText = false
        }
        turn.text(step.content)
        turn.endBlock()
      }
      ;(step.tool_calls ?? []).forEach((call, index) => {
        const id = `${child.id}:${step.step_index}:${index}`
        const tool = followedTool(call)
        turn.toolStart(id, tool.name, tool.input)
        child.open.push(id)
        child.toolsSinceText = true
      })
      return
    }
    // Anything else is what a tool call came back with, in order. One that goes on in the
    // background (a timer) came back too: its record just stays "running".
    const id = child.open[0]
    if (!id) return
    child.results.set(step.step_index, id)
    this.settle(child, step)
  }

  /** A tool's result, done (or failed). */
  private settle(child: Child, step: Step) {
    const id = child.results.get(step.step_index)
    if (!id || !child.open.includes(id)) return
    child.open = child.open.filter((open) => open !== id)
    const output = resultText(step.content)
    if (step.status === "ERROR" || step.status === "FAILED" || step.status === "CANCELED") child.run.turn.toolFailed(id, output || "The tool failed.")
    else child.run.turn.toolSucceeded(id, output)
  }

  /**
   * Done: its last step is its answer, and nothing it left running in the background (a timer)
   * is still to come back to it ("sender=<its task>" says one has).
   */
  private isDone(child: Child, steps = this.steps(child.id)): boolean {
    const last = steps.at(-1)
    if (!last || last.type !== "PLANNER_RESPONSE" || last.status !== "DONE" || last.tool_calls?.length) return false
    return steps.every((step) => {
      if (step.status !== "RUNNING") return true
      const task = /task id: (\S+)/.exec(step.content ?? "")?.[1]
      return Boolean(task && steps.some((later) => later.step_index > step.step_index && later.type === "SYSTEM_MESSAGE" && (later.content ?? "").includes(`sender=${task}`)))
    })
  }

  private end(child: Child) {
    child.ended = true
    child.run.end("succeeded")
  }
}

/** A tool call it wrote down, as the app shows the engine's. */
function followedTool(call: { name?: string; args?: Record<string, unknown> }): { name: string; input: Record<string, unknown> } {
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(call.args ?? {})) {
    if (key === "toolAction" || key === "toolSummary") continue
    args[key] = decoded(value)
  }
  const description = decoded(call.args?.toolSummary)
  const name = call.name ?? "tool"
  switch (name) {
    case "run_command":
      return { name: "shell", input: { command: args.CommandLine ?? args.Command, cwd: args.Cwd, description } }
    case "view_file":
      return { name: "read", input: { path: args.AbsolutePath ?? args.File } }
    case "write_to_file":
      return { name: "write", input: { path: args.TargetFile, content: args.CodeContent } }
    case "replace_file_content":
    case "multi_replace_file_content":
      return { name: "edit", input: { path: args.TargetFile, description } }
    case "grep_search":
      return { name: "grep", input: { pattern: args.Query, path: args.SearchPath } }
    case "list_dir":
      return { name: "list", input: { path: args.DirectoryPath } }
    case "find_by_name":
      return { name: "glob", input: { pattern: args.Pattern, path: args.SearchDirectory } }
    case "read_url_content":
      return { name: "webfetch", input: { url: args.Url } }
    case "search_web":
      return { name: "websearch", input: { query: args.query ?? args.Query } }
  }
  return { name, input: { ...args, ...(description ? { description } : {}) } }
}

/** Its arguments are written as JSON text ("\"hi\"", "180"): as values. */
function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** A result without its "Created At: … Completed At: …" lines. */
function resultText(content: string | undefined): string {
  return (content ?? "").replace(/^(Created At|Completed At):[^\n]*\n?/gm, "").trim()
}

export class AntigravityAgent implements Agent {
  id = "antigravity"
  readonly providerID: string
  get name() {
    return accountName("Antigravity", this.instance)
  }
  private installing?: Promise<void>
  /** How far the download has got, while it runs. */
  private downloaded?: { bytes: number; total: number }

  constructor(
    readonly context: AgentContext,
    readonly instance: AgentAccount = { id: "default" },
  ) {
    this.providerID = providerID("antigravity", instance.id)
  }

  private get root() {
    return join(this.context.home, "antigravity")
  }

  private get folder() {
    return join(this.root, version)
  }

  /** Its home (GEMINI_HOME): your sign-in, its settings and conversations; an added account's in its own folder. */
  get profile() {
    return this.instance.home ? join(this.instance.home, "profile") : join(this.root, "profile")
  }

  private get tokenFile() {
    return join(this.profile, "antigravity-acp", "acp_token.json")
  }

  private get modelsFile() {
    return join(this.profile, "kuvo-models.json")
  }

  private get isInstalled() {
    return existsSync(join(this.folder, ".complete"))
  }

  methods() {
    return [{ type: "oauth" as const, id: "oauth-personal", label: "Sign in with Google" }]
  }

  /** Its sign-in file as it was when Google ended the sign-in (its agent asked for a new one): until it's new. */
  private endedSignIn?: number

  /** Google ended the sign-in: shown, and skipped by Custom Auto, until you sign in again. */
  signInEnded() {
    try {
      this.endedSignIn = statSync(this.tokenFile).mtimeMs
    } catch {}
    emit("integration.updated", { integrationID: this.providerID })
  }

  async account(): Promise<Account> {
    const release = releases[`${process.platform}-${process.arch}`]
    if (!release) return { installed: false, signedIn: false, message: "Google doesn't make Antigravity's agent for this computer." }
    if (this.endedSignIn !== undefined) {
      let now: number | undefined
      try {
        now = statSync(this.tokenFile).mtimeMs
      } catch {}
      if (now === this.endedSignIn) return { installed: this.isInstalled, signedIn: false, ended: true, message: "Google ended this sign-in. Sign in again." }
      this.endedSignIn = undefined
    }
    if (!existsSync(this.tokenFile)) {
      return {
        installed: this.isInstalled,
        signedIn: false,
        message: this.isInstalled ? "Sign in with your Google account." : `Sign in with your Google account. Kuvo Code downloads Google's Antigravity agent (about ${Math.round(release.bytes / 1_000_000)} MB) first.`,
      }
    }
    return { installed: this.isInstalled, signedIn: true, label: "Google account" }
  }

  /** Downloads and checks Google's agent, once. */
  private ensureInstalled(): Promise<void> {
    if (this.isInstalled) return Promise.resolve()
    this.installing ??= this.download().finally(() => (this.installing = undefined))
    return this.installing
  }

  private async download() {
    const release = releases[`${process.platform}-${process.arch}`]
    if (!release) throw new Error("Google doesn't make Antigravity's agent for this computer.")
    const staging = join(this.root, `.install-${newID("att")}`)
    mkdirSync(staging, { recursive: true })
    try {
      const archive = join(staging, "download.zip")
      const response = await fetch(release.url)
      if (!response.ok || !response.body) throw new Error(`Couldn't download Antigravity's agent (HTTP ${response.status}).`)
      const hash = createHash("sha256")
      const writer = Bun.file(archive).writer()
      let bytes = 0
      this.downloaded = { bytes, total: release.bytes }
      for await (const chunk of response.body) {
        hash.update(chunk)
        writer.write(chunk)
        bytes += chunk.byteLength
        this.downloaded = { bytes, total: release.bytes }
      }
      await writer.end()
      if (bytes !== release.bytes || hash.digest("hex") !== release.sha256) throw new Error("Antigravity's agent didn't download whole. Try again.")
      const zip = unzipper()
      const listed = await run(zip.program, zip.list(archive))
      const entries = listed.stdout.split("\n").filter(Boolean).sort()
      if (entries.join(",") !== [executableName, harnessName].sort().join(",")) throw new Error("Antigravity's agent wasn't what Kuvo Code expected.")
      const unzipped = await run(zip.program, zip.extract(archive, staging))
      if (unzipped.code !== 0) throw new Error(`Couldn't unpack Antigravity's agent: ${unzipped.stderr.trim()}`)
      rmSync(archive, { force: true })
      for (const name of [executableName, harnessName]) chmodSync(join(staging, name), 0o755)
      writeFileSync(join(staging, ".complete"), JSON.stringify({ version, sha256: release.sha256 }))
      rmSync(this.folder, { recursive: true, force: true })
      renameSync(staging, this.folder)
      // Older versions go.
      for (const name of readdirSync(this.root)) {
        if (name !== version && name !== "profile" && /^\d/.test(name)) rmSync(join(this.root, name), { recursive: true, force: true })
      }
    } finally {
      this.downloaded = undefined
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Where it reads skills itself: its home's (the CLI's) and a project's `.agents/skills` and `.gemini/skills`. */
  ownSkillFolders(directory: string): string[] {
    return [join(this.profile, "antigravity-cli", "skills"), join(directory, ".agents", "skills"), join(directory, ".gemini", "skills")]
  }

  /** How it's started: its own home, its own temporary folder (it unpacks itself there, about 1 GB), and nothing of your other Google keys. */
  private launch(): { argv: string[]; env: Record<string, string | undefined>; cleanEnv: boolean; onExit: () => void; signInFile: string } {
    mkdirSync(join(this.profile, "antigravity-acp", "tmp"), { recursive: true, mode: 0o700 })
    const settings = join(this.profile, "antigravity-acp", "settings.json")
    if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ auth: { type: "oauth-personal" } }))
    const temporary = join(this.context.temporary, "antigravity", newID("att"))
    mkdirSync(temporary, { recursive: true })
    let env: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(process.env)) if (!scrubbed.includes(key.toUpperCase())) env[key] = value
    // On a machine, its commands find the machine's own settings (`gh`, git's).
    env = withOwnFolders(env)
    Object.assign(env, {
      GEMINI_HOME: this.profile,
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      BROWSER: catcher(this.context.temporary),
      KUVO_URL_FILE: join(temporary, "url"),
      PYTHONUNBUFFERED: "1",
      TMPDIR: temporary,
      ANTIGRAVITY_HARNESS_PATH: join(this.folder, harnessName),
    })
    // (Not its start-up syslog, which leaves a marker folder in /tmp, whatever TMPDIR says.)
    const argv = [join(this.folder, executableName), "--nosyslog_on_start", ...(process.platform === "linux" ? ["--uid="] : [])]
    return { argv, env, cleanEnv: true, onExit: () => rmSync(temporary, { recursive: true, force: true }), signInFile: join(temporary, "url") }
  }

  /**
   * Google's page comes back to `localhost` on the computer it runs on: opened on another device
   * (a phone), that device hands the address it was sent back to the computer
   * (`kuvo/sign-in/return`), which loads it there for Google's agent.
   */
  readonly signsInRemotely = true

  async signIn(): Promise<SignInAttempt> {
    // It answers at once: the download (the first time) and Google's page come with its status,
    // which the app shows and opens as they come.
    let status: OAuthStatus = { status: "pending" }
    let link = ""
    let rpc: RPC | undefined
    let cancelled = false
    const found = (url: string) => {
      if (!link && url.startsWith("https://")) link = url
    }
    const flow = async () => {
      await this.ensureInstalled()
      if (cancelled) return
      const launch = this.launch()
      const cwd = join(this.context.temporary, "antigravity", newID("att"))
      mkdirSync(cwd, { recursive: true })
      rpc = new RPC(launch.argv, {
        cwd,
        env: launch.env,
        cleanEnv: true,
        jsonrpc: true,
        firstID: 2 ** 30,
        filter: (line) => {
          const at = line.indexOf(signInLine)
          if (at >= 0) {
            found(line.slice(at + signInLine.length).trim())
            return false
          }
          return true
        },
      })
      rpc.onExit = () => {
        launch.onExit()
        rmSync(cwd, { recursive: true, force: true })
      }
      // It hands the page to its "browser", which writes it down (or says it on a line of its own).
      const watch = setInterval(() => {
        try {
          found(readFileSync(launch.env.KUVO_URL_FILE!, "utf8").split("\n")[0].trim())
        } catch {}
      }, 300)
      try {
        await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "kuvo-code", version: "1" } }, 120_000)
        await rpc.request("authenticate", { methodId: "oauth-personal" }, 600_000)
        // Signed in: a session to check it works, and to learn your models; then it goes.
        const setup: any = await rpc.request("session/new", { cwd, mcpServers: [] }, 120_000)
        this.saveModels(setup)
        if (setup?.sessionId) this.removeSessionFiles(setup.sessionId)
        if (!cancelled) status = { status: "complete" }
      } finally {
        clearInterval(watch)
        rpc.kill()
      }
    }
    flow().catch((error) => {
      if (status.status !== "pending") return
      const message = String(error?.message ?? error)
      status = {
        status: "failed",
        message: cancelled
          ? "Cancelled."
          : /SUBSCRIPTION_REQUIRED/i.test(message)
            ? "Google says this account needs an Antigravity subscription."
            : /access_denied/i.test(message)
              ? "Google sign-in wasn't approved."
              : failure(error).message,
      }
    })
    return {
      url: "",
      instructions: "Finish signing in with Google in your browser.",
      mode: "auto",
      status: () => {
        if (status.status !== "pending") return status
        const downloading = this.downloaded
        if (downloading) {
          const percent = Math.floor((downloading.bytes / downloading.total) * 100)
          return { status: "pending", message: `Downloading Google's Antigravity agent… ${percent}%` }
        }
        if (!link) return { status: "pending", message: "Starting Google's Antigravity agent…" }
        return { status: "pending", url: link, message: "Finish signing in with Google in your browser." }
      },
      cancel: () => {
        cancelled = true
        if (status.status === "pending") status = { status: "failed", message: "Cancelled." }
        rpc?.kill()
      },
    }
  }

  async signOut() {
    rmSync(this.tokenFile, { force: true })
    rmSync(this.modelsFile, { force: true })
  }

  private saveModels(setup: any) {
    const option = (setup?.configOptions ?? []).find((option: any) => option.id === "model" || option.category === "model")
    const flat: { value: string; name: string }[] = []
    for (const entry of option?.options ?? []) {
      if (Array.isArray(entry.options)) for (const inner of entry.options) flat.push({ value: inner.value, name: inner.name ?? inner.value })
      else if (entry.value) flat.push({ value: entry.value, name: entry.name ?? entry.value })
    }
    if (!flat.length) {
      for (const info of setup?.models?.availableModels ?? []) flat.push({ value: info.modelId, name: info.name ?? info.modelId })
    }
    if (flat.length) writeFileSync(this.modelsFile, JSON.stringify({ current: option?.currentValue, models: flat }))
  }

  /** A session made only to check the sign-in leaves nothing behind. */
  private removeSessionFiles(sessionID: string) {
    const folder = join(this.profile, "antigravity-acp")
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) rmSync(join(folder, "conversations", sessionID + suffix), { force: true })
    rmSync(join(folder, "brain", sessionID), { recursive: true, force: true })
  }

  async models(): Promise<Model[]> {
    try {
      const saved = JSON.parse(readFileSync(this.modelsFile, "utf8")) as { current?: string; models: { value: string; name: string }[] }
      return saved.models.map((info, index) => model(this.providerID, info.value, info.name, { images: true, released: info.value === saved.current ? 2000 : 1000 - index, context: this.windows.get(info.value) ?? 1_000_000 }))
    } catch {
      return []
    }
  }

  /** How much each model holds, as Antigravity says in a turn (its models aren't all Gemini's 1M). */
  private windows = new ContextWindows()

  thread(session: Session, state: Record<string, unknown>): Thread {
    const agent = this
    const followers = new Map<string, AntigravityFollower>()
    return new AcpThread(
      {
        noteContext(model, size) {
          if (agent.windows.note(model, size)) emit("model.updated", {})
        },
        fileSystem: true,
        authenticatesFirst: true,
        resumes: true,
        // Google's quotas are each model's own.
        limitScope: "model",
        // Its subagents: from its own record of the conversation (it doesn't tell them).
        // (One for the conversation, from turn to turn: what it has shown isn't shown again.)
        follow: (sessionId, turn, hooks) => {
          let follower = followers.get(sessionId)
          if (!follower) followers.set(sessionId, (follower = new AntigravityFollower(join(agent.profile, "antigravity-acp", "brain"), sessionId)))
          return follower.follow(turn, hooks)
        },
        hides: (call) => /\b(start_subagent|invoke_subagent)\b/.test(`${call?.title ?? ""} ${call?.rawInput?.name ?? ""}`),
        // An image it made is saved in its folder for the conversation, not handed back.
        madeFiles: (call, sessionId, since) => (/\bgenerate_image\b/.test(String(call?.title ?? "")) ? generatedImages(join(agent.profile, "antigravity-acp", "brain", sessionId), call?.rawInput ?? {}, since) : []),
        authMethod: () => "oauth-personal",
        async command() {
          if (!agent.isInstalled) throw new Error("Sign in to Antigravity in Settings › Accounts first.")
          return agent.launch()
        },
        // Settings › Skills' skills, in the skills folder of its home (Kuvo Code's): it reads
        // them from there as it starts. Its home is the account's, for all its sessions.
        async skills(directory, hooks) {
          return copySkillsInto(join(agent.profile, "config", "skills"), await skillsFor(directory, agent.ownSkillFolders(directory), turnedOff(hooks)))
        },
        // Its access lasts an hour, renewed from the sign-in it keeps: one that asks for a new
        // sign-in partway is started again, which renews it.
        asksSignIn: (line) => line.includes(signInLine),
        // "Usage Limit Reached. You have reached your current quota for this period. Your limit
        // will reset in 6 days, 19 hours.", as its whole answer.
        limitReply: (text) => {
          const plain = text.replace(/[#*_>`]/g, " ").replace(/\s+/g, " ").trim().toLowerCase()
          return /^usage limit reached\.? you have reached your current quota for this period\.?(?: your limit will reset in [^.]{1,80}\.?)?$/.test(plain)
        },
        signInEnded: () => agent.signInEnded(),
        async selectModel(rpc, sessionId, modelID, setup) {
          if (setup?.kuvoModel === modelID) return
          await rpc.request("session/set_config_option", { sessionId, configId: "model", value: modelID }, 30_000)
          setup.kuvoModel = modelID
          agent.saveModels(setup)
        },
        async selectMode(rpc, sessionId, { approvesAll, plan }, setup) {
          const option = (setup?.configOptions ?? []).find((option: any) => option.id === "mode" || option.category === "mode")
          const values: string[] = (option?.options ?? []).map((entry: any) => entry.value)
          const wanted = plan && values.includes("plan") ? "plan" : approvesAll ? "yolo" : "default"
          const current = setup?.kuvoMode ?? option?.currentValue
          if (current === wanted) return
          // Running without asking where it should ask (an earlier Approve All session's mode),
          // and no way out of it: not this turn.
          const cantAsk = () => new Error("Antigravity couldn't be set to ask before it acts, so it didn't start. Try again, or pick Approve All for this session.")
          if (!option || (values.length && !values.includes(wanted))) {
            if (wanted !== "yolo" && current === "yolo") throw cantAsk()
            return
          }
          try {
            await rpc.request("session/set_config_option", { sessionId, configId: option.id, value: wanted }, 30_000)
          } catch {
            // Not running without asking when it was to: it asks, and that's answered for it.
            if (wanted !== "yolo") throw cantAsk()
            return
          }
          setup.kuvoMode = wanted
        },
      },
      session,
      state,
      this.name,
    )
  }
}


/**
 * What unpacks a zip here: `unzip` (every Mac has it), or Python's zipfile on a machine without it.
 */
function unzipper(): { program: string; list: (archive: string) => string[]; extract: (archive: string, folder: string) => string[] } {
  const unzip = which("unzip", ["/usr/bin"])
  if (unzip) return { program: unzip, list: (archive) => ["-Z1", archive], extract: (archive, folder) => ["-q", "-o", archive, "-d", folder] }
  const python = which("python3", ["/usr/bin"])
  if (!python) throw new Error("Unpacking Antigravity's agent needs unzip or Python 3 on this machine.")
  return {
    program: python,
    list: (archive) => ["-I", "-c", "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", archive],
    extract: (archive, folder) => ["-I", "-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", archive, folder],
  }
}
