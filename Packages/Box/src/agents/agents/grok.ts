// Grok's CLI, as T3 Code runs it: your own `grok`, signed in with `grok login` (SuperGrok, or an
// xAI key in XAI_API_KEY), each session one `grok agent stdio` speaking ACP.

import { homedir } from "node:os"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { providerID, type AgentAccount } from "../accounts"
import type { Agent, AgentContext, Account, SignInAttempt, SignInOptions, Thread } from "../agent"
import { accountName, ContextWindows, KnownAccount, model, signOutWith, TookTooLong } from "../agent"
import { emit } from "../events"
import { readGrok } from "../engine-limits"
import { fingerprint, LimitsProblem, xaiIdentity, type LimitsSource } from "../limits"
import { AcpThread, questionFields } from "../acp"
import { withOwnFolders } from "../machine"
import { install, maintenance, update, type MaintenanceDefinition } from "../maintenance"
import { plain, run, which } from "../proc"
import { commandSignIn } from "../signin"
import { skillsFolder, skillsFor, turnedOff, upward } from "../skills"
import { grokSubagents, subagentsFor } from "../subagents"
import type { Model, Session } from "../wire"

const places = [join(homedir(), ".grok/bin"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]

/**
 * Run whole in the box's sandbox (acp.ts `whole`), Grok writes of its home (GROK_HOME) only its
 * state (on a Mac; on Linux, a machine's Grok home is Kuvo Code's own, and written whole): its
 * conversations, logs and traces, its sign-in and its locks. Nothing else there: what Grok reads as
 * it starts or as you work with it, and runs or takes as its instructions (its settings, hooks and
 * the paths it loads them from, language servers, the settings xAI sends, its models' list, which
 * names where each model's requests go; its program, plugins, skills and memories).
 * A file it saves whole goes through a new one beside it, renamed into place: its sign-in through
 * `.<process>.<count>.tmp`, its running sessions' list through `active_sessions.json.tmp` (and one
 * it can't read it keeps aside, `.corrupt`). Names like those it never reads, and the sandbox goes by the name a file is renamed to, so one can't
 * become its settings.
 */
const STATE_IN_HOME = [
  "sessions", "logs", "memtrace", "debug", "crash",
  "auth.json*", "agent_id", "*.lock", ".metadata_version", "worktrees.db*", "active_sessions.json", "active_sessions.json.tmp", "active_sessions.json.corrupt", "experiments_state.json", "*.log", "sandbox-events.jsonl",
  ".*.*.tmp",
]
/** What it never writes in its state either: settings put there (the commands each project always allows are kept in its sessions). */
const KEPT_IN_HOME = ["*.toml", "hooks-paths", "disabled-hooks", "*.sh"]

export class GrokAgent implements Agent {
  id = "grok"
  compacts = true
  readonly providerID: string
  get name() {
    return accountName("Grok", this.instance)
  }
  /** xAI's installer, as its docs give it (it needs no Node). */
  install = "curl -fsSL https://x.ai/cli/install.sh | bash"
  private status?: { at: number; signedIn: boolean; models: { id: string; name: string; isDefault: boolean }[] }
  private promptCount = 0

  /** Each model's reasoning efforts and its default, as its sessions said last (kept in Kuvo Code's folder). */
  private get effortsFile() {
    return join(this.context.home, "grok", `efforts-${this.instance.id}.json`)
  }

  private efforts(): Record<string, { values: string[]; default?: string }> {
    try {
      return JSON.parse(readFileSync(this.effortsFile, "utf8"))
    } catch {
      return {}
    }
  }

  /** Keeps what a session says of its models' efforts, for the model picker. */
  saveEfforts(setup: any) {
    const known: Record<string, { values: string[]; default?: string }> = {}
    for (const info of setup?.models?.availableModels ?? []) {
      // (One it describes with no efforts has none to pick.)
      if (!info?.modelId || typeof info._meta !== "object" || !info._meta) continue
      const levels: any[] = Array.isArray(info._meta.reasoningEfforts) ? info._meta.reasoningEfforts : []
      known[info.modelId] = { values: levels.map((level) => String(level.value)), default: levels.find((level) => level.default)?.value ?? info._meta.reasoningEffort }
    }
    if (!Object.keys(known).length || JSON.stringify(known) === JSON.stringify(this.efforts())) return
    try {
      mkdirSync(dirname(this.effortsFile), { recursive: true })
      writeFileSync(this.effortsFile, JSON.stringify(known))
    } catch {}
  }

  /** Its own sign-in on a machine: Kuvo Code's, in its folder there, so signed out here. */
  signOut?: () => Promise<void>

  constructor(
    readonly context: AgentContext,
    readonly instance: AgentAccount = { id: "default" },
  ) {
    this.providerID = providerID("grok", instance.id)
    if (instance.id === "default" && instance.home) {
      this.signOut = async () => {
        await signOutWith("Grok", this.executable(), ["logout"], this.env())
        // A session's Grok holds the sign-in it started with: its next message starts one signed out.
        this.programUpdated()
        this.known.reset()
        this.status = undefined
      }
    }
  }

  executable(): string | undefined {
    return which("grok", places)
  }

  /** Its own installer puts it in `~/.grok`: `grok update`. */
  private get definition(): MaintenanceDefinition | undefined {
    const executable = this.executable()
    if (!executable) return undefined
    return { name: "Grok's CLI", executable, npmPackage: "@xai-official/grok", nativeUpdate: { args: ["update"], isNative: (path) => path.includes("/.grok/") } }
  }

  async maintenance(fresh = false) {
    const definition = this.definition
    return definition ? maintenance(definition, fresh) : {}
  }

  async update() {
    const definition = this.definition
    if (!definition) return { updated: false, message: "Grok's CLI isn't installed." }
    return update(definition, this.context.temporary)
  }

  /** Its program, with xAI's installer. */
  async installProgram() {
    return install("Grok's CLI", this.install, this.context.temporary, () => this.executable())
  }

  /** Counts updates of Grok's CLI: a session's agent started before the last one starts again. */
  program = 0

  /** Its models asked of the new CLI; sessions start it at their next message. */
  programUpdated() {
    this.program++
    if (this.status) this.status.at = 0
  }

  methods() {
    return [{ type: "oauth" as const, id: "grok", label: "Sign in with Grok" }]
  }

  /**
   * Grok's home (GROK_HOME) as it runs here: an added account's own folder (Kuvo Code's on a
   * machine), else your `GROK_HOME` (`~/` as your home), else your `~/.grok`.
   */
  get grokHome(): string {
    if (this.instance.home) return this.instance.home
    const set = process.env.GROK_HOME?.trim()
    if (set) return set === "~" ? homedir() : set.startsWith("~/") ? join(homedir(), set.slice(2)) : set
    return join(homedir(), ".grok")
  }

  /**
   * Where it keeps its conversations (each session's `updates.jsonl`, which its usage is read from).
   * A moved session's leftovers are cleared only from here, and Grok has none (no `conversationFiles`).
   */
  conversationRoots() {
    return [join(this.grokHome, "sessions")]
  }

  /**
   * Where Grok reads skills itself: its home's, and Claude Code's and Cursor's (`~/.claude/skills`,
   * `~/.cursor/skills`), and a project's `.grok`, `.claude`, `.cursor` and `.agents` skills.
   */
  ownSkillFolders(directory: string): string[] {
    const home = this.grokHome
    const projects = upward(directory).flatMap((folder) => [".grok", ".claude", ".cursor", ".agents"].map((name) => join(folder, name, "skills")))
    return [join(home, "skills"), join(homedir(), ".claude", "skills"), join(homedir(), ".cursor", "skills"), ...projects]
  }

  /**
   * Its plan's weekly pool (limits.ts), read with the sign-in Grok keeps in its home (Kuvo Code's
   * folder for it on a machine, or one you added), as the Grok CLI reads it; never renewed here.
   */
  readonly limits: LimitsSource = {
    every: 10 * 60_000,
    signIn: () => fingerprint(this.grokSignIn()?.key),
    read: async (now) => {
      // (A sign-in left behind by a Grok that's gone isn't read.)
      if (!this.executable()) throw new LimitsProblem("none", "Grok isn't installed here.", undefined, false)
      const entry = this.grokSignIn()
      if (!entry) throw new LimitsProblem("none", "Not signed in to Grok here.")
      // (The Grok CLI writes `expires_at`.)
      const expires = Date.parse(entry.expires_at ?? entry.expiresAt ?? entry.expires ?? "")
      if (Number.isFinite(expires) && expires <= now) throw new LimitsProblem("expired", "Its sign-in has lapsed: Grok renews it the next time it runs here.")
      return readGrok(entry.key.trim(), undefined, now)
    },
    identity: () => {
      const entry = this.grokSignIn()
      return xaiIdentity(entry?.key, entry?.id_token)
    },
  }

  /** The sign-in Grok keeps in its home, as it is now. */
  private grokSignIn(): { key: string; id_token?: string; expires_at?: string; expiresAt?: string; expires?: string } | undefined {
    const home = this.grokHome
    try {
      const entries = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) ?? {}
      return Object.values<any>(entries).find((each) => typeof each?.key === "string" && each.key.trim())
    } catch {
      return undefined
    }
  }

  env(): Record<string, string | undefined> {
    // An added account's own GROK_HOME: its sign-in and sessions there.
    return withOwnFolders({ ...process.env, GROK_DISABLE_AUTOUPDATER: "1", ...(this.instance.home ? { GROK_HOME: this.instance.home } : {}) })
  }

  /**
   * `grok models` says whether you're signed in, and lists your models; throws when it says neither
   * (`TookTooLong`, or why not), and the models it listed last are kept.
   */
  private async read(fresh: boolean) {
    if (!fresh && this.status && Date.now() - this.status.at < 30_000) return this.status
    const executable = this.executable()!
    const result = await run(executable, ["models"], { env: this.env(), timeout: 20_000, cwd: this.context.temporary })
    const text = plain(result.stdout + "\n" + result.stderr)
    const signedOut = /not authenticated|not logged in|grok login|log ?in first|sign in first/i.test(text)
    if (result.timedOut) throw new TookTooLong("Grok's CLI took too long to say whether it's signed in.")
    if (!text.trim() || (!signedOut && !/you are logged in/i.test(text) && !process.env.XAI_API_KEY)) {
      const words = text.trim().split("\n").pop()?.trim().slice(0, 300)
      throw new Error(words ? `Grok's CLI couldn't say whether it's signed in: ${words}` : `Grok's CLI couldn't say whether it's signed in (it stopped with code ${result.code}).`)
    }
    const signedIn = Boolean(process.env.XAI_API_KEY) || !signedOut
    const models: { id: string; name: string; isDefault: boolean }[] = []
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*[*-]\s+(\S+)(.*)$/)
      if (match) models.push({ id: match[1], name: match[1], isDefault: /\(default\)/i.test(match[2]) })
    }
    this.status = { at: Date.now(), signedIn, models }
    return this.status
  }

  /** Its sign-in as Grok's CLI last said (a check that fails isn't a sign-out). */
  private known = new KnownAccount()

  async account(fresh = false): Promise<Account> {
    if (!this.executable()) return { installed: false, signedIn: false, message: "Install Grok's CLI, then sign in here." }
    return this.known.read(fresh, async () => {
      const status = await this.read(fresh)
      if (!status.signedIn) return { installed: true, signedIn: false, message: "Sign in to Grok with your SuperGrok plan." }
      return { installed: true, signedIn: true, label: process.env.XAI_API_KEY ? "xAI API key" : "grok.com" }
    })
  }

  /** Its device code works wherever its page is opened. */
  readonly signsInRemotely = true

  async signIn(_methodID = "grok", options: SignInOptions = {}): Promise<SignInAttempt> {
    const executable = this.executable()
    if (!executable) throw new Error(`Install Grok's CLI first: ${this.install}`)
    // On another device: a device code, as `grok login --device-auth` has it.
    return commandSignIn({
      command: executable,
      args: options.remote ? ["login", "--device-auth"] : ["login"],
      env: this.env(),
      home: this.context.home,
      temporary: this.context.temporary,
      instructions: options.remote
        ? "Open Grok's page, sign in, and enter the code it shows here. Grok's CLI keeps the sign-in, as when you run grok login."
        : "Finish signing in to Grok in your browser. Grok's CLI keeps the sign-in, as when you run grok login.",
      signedIn: async () => (await this.read(true)).signedIn,
      printedPage: options.remote,
      userCode: options.remote ? /\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/ : undefined,
    })
  }

  async models(): Promise<Model[]> {
    const listed = await this.read(false).then(
      (status) => status.models,
      () => this.status?.models ?? [],
    )
    const efforts = this.efforts()
    // (Before a session has said, the efforts every Grok model has.)
    return listed.map((info, index) => model(this.providerID, info.id, info.name, { released: info.isDefault ? 1000 : 500 - index, context: this.windows.get(info.id) ?? 256_000, variants: efforts[info.id]?.values ?? ["low", "medium", "high"] }))
  }

  /** How much each model holds, as Grok says in a turn. */
  private windows = new ContextWindows()

  thread(session: Session, state: Record<string, unknown>): Thread {
    const agent = this
    return new AcpThread(
      {
        noteContext(model, size) {
          if (agent.windows.note(model, size)) emit("model.updated", {})
        },
        fileSystem: false,
        initializeMeta: { clientType: "extension" },
        authMethod: () => (process.env.XAI_API_KEY ? "xai.api_key" : "cached_token"),
        restartAfterInterrupt: true,
        program: () => agent.program,
        whole: { homes: (env) => [env.GROK_HOME ?? join(homedir(), ".grok")], state: STATE_IN_HOME, kept: KEPT_IN_HOME, env: { GROK_SANDBOX: "off", GROK_MEMORY: "0" } },
        async command({ approvesAll, plan, skills, subagents, whole }) {
          const executable = agent.executable()
          if (!executable) throw new Error(`Install Grok's CLI first: ${agent.install}`)
          // Settings › Skills' skills, and your subagents (Settings › Agents), as plugins for this
          // process alone.
          // Run whole in the box's sandbox: never in a shared leader (one you started yourself runs its
          // commands outside it).
          const plugin = [...(whole ? ["--no-leader"] : []), ...(skills ? ["--plugin-dir", skills] : []), ...(subagents ? ["--plugin-dir", subagents] : [])]
          const argv = plan
            ? [executable, "--permission-mode", "plan", "agent", ...plugin, "stdio"]
            : approvesAll
              ? [executable, "agent", ...plugin, "--always-approve", "stdio"]
              : [executable, "--permission-mode", "default", "agent", ...plugin, "stdio"]
          return { argv, env: agent.env() }
        },
        async skills(directory, hooks) {
          return skillsFolder(await skillsFor(directory, agent.ownSkillFolders(directory), turnedOff(hooks)))
        },
        // Named `kuvo:<name>` there, on their own model when it's one of Grok's (its own subagents
        // keep the conversation's: Grok takes a model for them only in your ~/.grok settings).
        async subagents(directory) {
          return grokSubagents(await subagentsFor(directory))
        },
        async selectModel(rpc, sessionId, modelID, setup, variant) {
          agent.saveEfforts(setup)
          if (setup?.models?.currentModelId !== modelID) {
            await rpc.request("session/set_model", { sessionId, modelId: modelID }, 30_000)
            if (setup?.models) setup.models.currentModelId = modelID
          }
          // Its reasoning effort: the one you picked, or (after one was) the model's own: as Grok
          // describes the model, or what the session had before one was picked.
          const option = (setup?.configOptions ?? []).find((option: any) => option.id === "reasoning_effort" || option.category === "thought_level")
          const described = (setup?.models?.availableModels ?? []).find((info: any) => info?.modelId === modelID)?._meta?.reasoningEffort
          const wanted = variant ?? (setup?.kuvoEffort ? (agent.efforts()[modelID]?.default ?? described ?? setup.kuvoEffortBefore) : undefined)
          const key = `${modelID}:${variant ?? ""}`
          if (!option || !wanted || setup.kuvoEffort === key) return
          if (!setup.kuvoEffort) setup.kuvoEffortBefore ??= option.currentValue
          await rpc.request("session/set_config_option", { sessionId, configId: option.id, value: wanted }, 30_000)
          setup.kuvoEffort = variant ? key : undefined
        },
        promptMeta() {
          const id = `kuvo-prompt-${++agent.promptCount}`
          return { promptId: id, requestId: id }
        },
        notification(method, params, context) {
          // Grok can say the prompt is over before answering it.
          const name = method.replace(/^_/, "")
          // What it keeps going in the background, each of which wakes it as it ends: listed whole
          // at each change, those that ended still there (not running).
          if (name === "x.ai/session/update" && params?.update?.sessionUpdate === "background_tasks" && Array.isArray(params.update.tasks)) {
            const running = params.update.tasks.filter((task: any) => typeof task?.task_id === "string" && task.status === "running")
            context.background(
              running.map((task: any) => ({ id: task.task_id, command: typeof task.command === "string" ? task.command : undefined, description: typeof task.description === "string" ? task.description : undefined, kind: typeof task.kind === "string" ? task.kind : undefined, started: Date.parse(task.started_at) || undefined, outputFile: typeof task.output_file === "string" ? task.output_file : undefined })),
              typeof params.sessionId === "string" ? params.sessionId : undefined,
              Boolean(params?._meta?.isReplay),
            )
          }
          // One it ran on its own after a task of its own completed: that turn's end.
          if (name === "x.ai/session/prompt_complete" && String(params?.promptId ?? "").startsWith("task-completed-")) context.endOwn()
          if (name === "x.ai/session/prompt_complete" && !String(params?.promptId ?? "").startsWith("task-completed-")) {
            context.endPrompt(params?.stopReason ?? "end_turn", params?.stopReason === "rate_limit" ? "You've reached your Grok usage limit for now." : params?.stopReason === "error" ? String(params?.agentResult ?? "Grok stopped with an error.") : undefined, params?.promptId)
          }
        },
        request(method, params, context) {
          const name = method.replace(/^_/, "")
          const call = params?.params ?? params
          if (name === "x.ai/ask_user_question") {
            return (async () => {
              const questions = call?.questions ?? []
              let declined: string | undefined
              const answer = context.hooks ? await context.hooks.question({ title: "Question", fields: questionFields(questions), toolCallID: call?.toolCallId, declined: (words) => { declined = words } }) : null
              if (!answer && !declined) return { outcome: "cancelled" }
              const answers: Record<string, string[]> = {}
              questions.forEach((question: any, index: number) => {
                // (Turned down by its box with words: that's what it hears.)
                const value = answer?.[question.id ?? `q${index}`] ?? declined
                answers[question.question] = Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]
              })
              return { outcome: "accepted", answers }
            })()
          }
          if (name === "x.ai/exit_plan_mode") {
            // Its plan, shown (it says the plan is in front of you).
            const plan = [call?.plan, call?.planText, call?.content].find((value) => typeof value === "string" && value.trim())
            if (plan && context.turn) {
              context.turn.text(plan)
              context.turn.endBlock()
            }
            return Promise.resolve({ outcome: "abandoned", feedback: "The plan is shown to the user. Stop here and wait: they'll switch out of plan mode and ask you to build it when they're ready." })
          }
          return undefined
        },
      },
      session,
      state,
      this.name,
    )
  }
}
