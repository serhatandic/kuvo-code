// Sessions with outside agents while the bridge runs: what's waiting to be sent, the turn under
// way, what it asks you, and the agents' own conversations behind each. A session can move from
// one agent to another (you pick a model of another, or Auto goes on with the next in your list):
// each agent keeps its own conversation, and gets what it hasn't seen as a handover.
//
// What's waiting goes as the engine sends it, which the app counts on: a message sent while
// nothing runs starts at once ("steer"), or waits for a nudge ("queue"); after a turn that ends
// on its own the next one starts; after Stop, or an error, nothing does until the app says.

import { createHash } from "node:crypto"
import { spawn as spawnProcess } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Agent, OwnTurn, PermissionAsk, PromptFile, QuestionAsk, RunInput, RunResult, SubagentRun, SubagentTask, Thread, TurnHooks } from "./agent"
import { failure } from "./agent"
import { Auto, autoProvider, resetTime, type AutoEntry } from "./auto"
import { emit } from "./events"
import { handover, withHandover } from "./handover"
import { onMachine } from "./machine"
import { messageID, newID } from "./ids"
import type { Roster } from "./roster"
import { asksFirst, matches, ruled } from "./rules"
import { skillFolders, within } from "./skills"
import type { Record_, Store } from "./store"
import { Turn, type Outcome } from "./turn"
import type { AssistantMessage, Attachment, Decision, FormAnswer, FormRequest, Message, ModelRef, PermissionRequest, PermissionRule, Session, ShellMessage, FileDiff, StructuredError } from "./wire"
import { plain } from "./proc"
import type { Snapshots } from "./snapshots"
import { noTokens } from "./wire"

type Delivery = "steer" | "queue"

interface Input {
  id: string
  text: string
  files: { uri: string; name?: string }[]
  delivery: Delivery
  /** From the app, not you ("you switched the model while it worked"): the agent gets it as a note. */
  synthetic?: { description?: string; metadata?: Record<string, unknown> }
  /** A turn the agent on this model began on its own (a command it left running ended): it's taken, not sent. */
  adopt?: ModelRef
}

/** A turn under way. */
interface Run {
  turn: Turn
  abort: AbortController
  /** The agent at work in it now (Auto may go through several), for Stop and for what you send partway. */
  agent?: { provider: string; thread: Thread; abandon: () => void }
  /** The slot of the agent that ran last in it: it sees the turn's end too. */
  last?: Slot
  /** What the files were before each message you sent partway through it, for Undo. */
  steered: SnapshotNote[]
}

/**
 * What a session is doing, one thing at a time; nothing else says so. It moves only like this:
 *
 * - idle → running: a message, or a turn an agent began on its own, starts (`start`)
 * - running → stopping: Stop (`interrupt`)
 * - running or stopping → keeping, then idle: the turn ended, and what it changed is read for Undo (`runTurn`, `free`)
 * - idle → reverting → idle: Undo or Redo puts the files back (`stageRevert`, `clearRevert`, `free`)
 * - idle → keeping → idle: a turn a quit cut short is read (`finishNotes`, `free`)
 * - any → deleting: the session is being deleted (`remove`); nothing leaves it, and nothing starts
 *
 * What comes in meanwhile waits in the session's `own`, `go` and `waiting`, and `advance` starts
 * what's next whenever the session is idle.
 */
type Doing = { kind: "idle" } | { kind: "running" | "stopping"; run: Run } | { kind: "keeping" | "reverting" } | { kind: "deleting" }

interface Live {
  /** Each agent's conversation in this session, by provider. */
  threads: Map<string, Thread>
  doing: Doing
  /** A turn an agent began on its own, taken but waiting for the session to be free: it goes first. */
  own?: Input
  /** Start the first message you steered once nothing runs: Send Now (Stop with resume), or one sent while files were kept or put back. */
  go: boolean
  /** Undo and Redo calls waiting for the files to be kept or put back, in the order they came. */
  waiting: (() => void)[]
  /** Your messages being handed to the turn under way: not started meanwhile, and cancelled only once it's known the agent didn't take one. */
  steering: Map<string, { cancelled: boolean }>
  permissions: Map<string, { request: PermissionRequest; resolve: (decision: Decision) => void; turn?: Turn }>
  forms: Map<string, { form: FormRequest; resolve: (answer: FormAnswer | null) => void }>
  /** "Always allow" answers given in this session: an action, on these patterns. */
  always: { action: string; patterns: string[] }[]
  /** Closes its agents' processes once it has been idle a while. */
  idle?: ReturnType<typeof setTimeout>
  /** Its subagents at work, each a session of its own: their turns, by session. */
  subagents: Map<string, Turn>
  /** And their runs (to stop one), by session. */
  runs: Map<string, SubagentRun>
  /** Those sent off in the background: they go on after the turn that started them. */
  background: Set<string>
  /** Settings › Permissions' Blocks as the turn began: what nothing allows (undefined: not known). */
  blocks?: PermissionRule[]
  /** The session's agent of yours (Settings › Agents), as the turn began: what it's told to be. */
  agentPrompt?: string
  /** The session's agent's permissions as the engine has them (its defaults, Settings', the agent's own). */
  agentRules?: PermissionRule[]
  /** Which agent those are. */
  rulesFor?: string
  /** The model each agent here ran last, by provider: a turn it begins on its own is on it. */
  models: Map<string, ModelRef>
}

/** At work: a turn, or the files being kept or put back (the app shows it working, and Undo waits). */
function isBusy(doing: Doing): boolean {
  return doing.kind !== "idle" && doing.kind !== "deleting"
}

/** The files are being kept (what a turn changed) or put back (Undo, Redo). */
function onFiles(doing: Doing): boolean {
  return doing.kind === "keeping" || doing.kind === "reverting"
}

/** Stopping a turn, or deleting the session: nothing more is asked of you. */
function stopping(doing: Doing): boolean {
  return doing.kind === "stopping" || doing.kind === "deleting"
}

/** The turn under way, stopped or not. */
function runOf(doing: Doing): Run | undefined {
  return doing.kind === "running" || doing.kind === "stopping" ? doing.run : undefined
}

/** What the bridge keeps of each agent's conversation in a session. */
interface Slot {
  /** The agent's own state (its conversation's ID, to resume it). */
  state: Record<string, unknown>
  /** The last message it has seen: what comes after goes to it as a handover. */
  seen?: string
}

/** What a session's `agent.json` held before sessions could move between agents. */
const legacyKeys = ["claudeSession", "claudeStarted", "codexThread", "acpSession", "acpInstructed", "cursorAgent", "cursorInstructed"]

/** What an agent that has your message already is told when it's to go on with it on another of its models. */
const carryOn = "Carry on with my last message from where you left off: you're on another model now."

/** How long an agent gets to stop when you press Stop, before its conversation is closed; how long a session's agents keep running with nothing to do (the next message starts them again, in the same conversation); how lately a turn the bridge quit in must have last written for what changed since to count as its own. */
export const timing = { stopGrace: 8_000, idleClose: 15 * 60_000, cutShort: 2 * 60_000 }

/** In plan mode, what changes files: refused, whatever your rules say. */
const changes = new Set(["edit", "write", "patch"])

/** How long a command you run with "!" may take, and how much of what it printed is kept. */
const shellTimeout = 10 * 60_000
const shellOutputLimit = 50_000

/**
 * A command you typed with "!", run through your shell in its own process group: what it printed
 * (its end, when there's a lot), kept as it comes; stopped whole when it runs too long. Its output
 * stops being waited for a moment after it ends (a job it left running may keep it open).
 */
function runCommand(command: string, directory: string): Promise<{ code: number; output: string; truncated: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = ""
    let truncated = false
    let timedOut = false
    let done = false
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.length > shellOutputLimit * 2) {
        output = output.slice(-shellOutputLimit)
        truncated = true
      }
    }
    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = plain(output).trimEnd()
      resolve({ code, output: text.length > shellOutputLimit ? text.slice(-shellOutputLimit) : text, truncated: truncated || text.length > shellOutputLimit, timedOut })
    }
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess(process.env.SHELL || "/bin/zsh", ["-c", command], { cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error: any) {
      output = String(error?.message ?? error)
      return finish(1)
    }
    const group = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      group("SIGTERM")
      setTimeout(() => group("SIGKILL"), 5_000)
    }, shellTimeout)
    child.stdout?.on("data", take)
    child.stderr?.on("data", take)
    child.on("error", (error) => {
      output += String(error?.message ?? error)
      finish(1)
    })
    child.on("exit", (code, signal) => setTimeout(() => finish(code ?? (signal ? 128 + 15 : 1)), 500))
  })
}

/** What's kept of the project's files around one of your messages, for Undo. */
interface SnapshotNote {
  /** Before its turn. */
  before?: string
  /** When that was kept (ms): a file made before it isn't one its turn made, whatever git says. */
  at?: number
  /** The files its turn changed (the repository's paths), once it ended. */
  files?: string[]
  /** They couldn't be kept: Undo can't put them back. */
  failed?: boolean
}

/** What the engine asks first about whatever else you've set (reading a .env file), for when it can't say its own. */
const engineDefaults: PermissionRule[] = [
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

/**
 * A command line's commands, each checked on its own as the engine does (it checks every command
 * in the line: `a && b`, `a | b`, `a & b`, `a; b`, `$(b)`, `if a; then b; fi`, `{ b; }`), with
 * the whole line: a rule for one of them holds in any line. What's quoted, commented out or read
 * from a here-document stays in its command; one line that can't be read through (a quote never
 * closed) is also split the plain way, so a Block still finds what's in it.
 */
export function commandParts(line: string): string[] {
  const whole = line.trim()
  const { commands, sure } = parseCommands(whole)
  const parts = new Set(commands.filter((part) => part !== whole))
  if (!sure)
    for (const part of whole.split(/&&|\|\||[;|&\n`()]|\$\(/)) {
      const trimmed = part.trim()
      if (trimmed && trimmed !== whole) parts.add(trimmed)
    }
  return [whole, ...parts]
}

/** The commands a shell would run for a line, and whether it could be read through. */
export function parseCommands(line: string): { commands: string[]; sure: boolean } {
  const state = { sure: true }
  const out: string[] = []
  // A backslash at a line's end joins the next line to it.
  scanCommands(line.replace(/\\\n/g, ""), 0, "", out, state)
  return { commands: [...new Set(out)], sure: state.sure }
}

/** Words that open or close a block around commands, not commands themselves. */
const shellKeywords = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac"])

/**
 * Reads commands from `start` until `close` (the `)` of a `$(`, the closing backtick, or the end),
 * adding each to `out`; where it stopped (at the closer, or the end).
 */
function scanCommands(text: string, start: number, close: string, out: string[], state: { sure: boolean }): number {
  let current = ""
  let depth = 0
  // The last thing taken was escaped (`a\ #` isn't a comment).
  let escaped = false
  const heredocs: { word: string; tabs: boolean }[] = []
  const push = () => {
    addCommand(current, out, state)
    current = ""
  }
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (close && ch === close && (close !== ")" || depth === 0)) {
      push()
      return i
    }
    const wasEscaped = escaped
    escaped = false
    if (ch === "\\") {
      current += text.slice(i, i + 2)
      i += 2
      escaped = true
    } else if ((text.startsWith("$((", i) || (text.startsWith("((", i) && !current.trim())) && arithmeticEnd(text, text[i] === "$" ? i + 1 : i) !== undefined) {
      // Arithmetic (`$((1 << 2))`, `(( n++ ))`): numbers, not commands; one with a command inside
      // isn't read. (`((rm x) && y)` is a subshell in one: read as such, below.)
      const end = arithmeticEnd(text, text[i] === "$" ? i + 1 : i)!
      const inner = text.slice(i, end + 1)
      if (/\$\(|`/.test(inner.slice(3))) state.sure = false
      current += inner
      i = end + 1
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) state.sure = false
      const stop = end < 0 ? text.length : end + 1
      current += text.slice(i, stop)
      i = stop
    } else if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j += 2
        else if (text.startsWith("$((", j) && arithmeticEnd(text, j + 1) !== undefined) {
          const end = arithmeticEnd(text, j + 1)!
          if (/\$\(|`/.test(text.slice(j + 3, end))) state.sure = false
          j = end + 1
        } else if (text.startsWith("$(", j)) j = scanCommands(text, j + 2, ")", out, state) + 1
        else if (text[j] === "`") j = scanCommands(text, j + 1, "`", out, state) + 1
        else j++
      }
      if (j >= text.length) state.sure = false
      current += text.slice(i, j + 1)
      i = j + 1
    } else if (text.startsWith("$(", i) || text.startsWith("<(", i) || text.startsWith(">(", i) || ch === "`") {
      // A command inside this one: checked on its own, and kept in this one's text.
      const from = ch === "`" ? i + 1 : i + 2
      const end = scanCommands(text, from, ch === "`" ? "`" : ")", out, state)
      if (end >= text.length) state.sure = false
      current += text.slice(i, end + 1)
      i = end + 1
    } else if (ch === "#" && !wasEscaped && (current === "" || /\s$/.test(current))) {
      // A comment, to the end of its line.
      const lineEnd = text.indexOf("\n", i)
      i = lineEnd < 0 ? text.length : lineEnd
    } else if (text.startsWith("<<<", i)) {
      // A here-string: a word it reads, on this line.
      current += "<<<"
      i += 3
    } else if (ch === "<" && text.startsWith("<<", i)) {
      // A here-document: its lines (from the next one on) are what it reads, not commands; the
      // rest of this line goes on as usual.
      const match = /^<<(-?)\s*(['"]?)([^\s'"<>;&|()]+)\2/.exec(text.slice(i))
      if (match) heredocs.push({ word: match[3], tabs: match[1] === "-" })
      const taken = match ? match[0].length : 2
      current += text.slice(i, i + taken)
      i += taken
    } else if (ch === "\n") {
      push()
      i++
      for (const doc of heredocs.splice(0)) {
        let found = false
        while (i < text.length) {
          const lineEnd = text.indexOf("\n", i)
          const body = text.slice(i, lineEnd < 0 ? text.length : lineEnd)
          i = lineEnd < 0 ? text.length : lineEnd + 1
          if ((doc.tabs ? body.replace(/^\t+/, "") : body) === doc.word) {
            found = true
            break
          }
        }
        if (!found) state.sure = false
      }
    } else if (ch === "&" && (text[i + 1] === ">" || /[<>]$/.test(current))) {
      // A redirection (2>&1, &>file), not a command of its own.
      current += ch
      i++
    } else if (ch === "|" && /[>]$/.test(current)) {
      current += ch
      i++
    } else if (ch === "&" || ch === "|" || ch === ";" || ch === "(" || ch === ")") {
      if (ch === "(") depth++
      else if (ch === ")") {
        if (depth > 0) depth--
        // One that closes nothing (a case's pattern, say): read as a break, not sure.
        else state.sure = false
      }
      push()
      i += text[i + 1] === ch || (ch === "|" && text[i + 1] === "&") ? 2 : 1
    } else {
      current += ch
      i++
    }
  }
  push()
  if (close || heredocs.length || depth) state.sure = false
  return text.length
}

/**
 * Where arithmetic that opens at `open` (its `((`) ends, at the last `)` of its `))`; undefined
 * when it isn't arithmetic (`((rm x) && y)`: a subshell in a subshell) or doesn't end.
 */
function arithmeticEnd(text: string, open: number): number | undefined {
  let level = 0
  let inner = -1
  for (let j = open; j < text.length; j++) {
    if (text[j] === "(") level++
    else if (text[j] === ")") {
      level--
      if (level === 1 && inner < 0) inner = j
      if (level === 0) return inner === j - 1 ? j : undefined
    }
  }
  return undefined
}

/**
 * One command, as written, and as it runs: without assignments, redirections and wrappers before
 * it (`FOO=1`, `2>/dev/null`, `env`, `sudo`, `nohup`…), and for git, without its own options
 * before the subcommand (`git -C dir push`); a shell given a command line (`bash -c '…'`), that
 * line's commands too.
 */
function addCommand(raw: string, out: string[], state: { sure: boolean }) {
  const words = shellWords(raw.trim())
  while (words.length && shellKeywords.has(words[0])) words.shift()
  // A function's own line (`function f { rm x`): what it runs follows its name.
  if (words[0] === "function") {
    words.splice(0, 2)
    while (words.length && (shellKeywords.has(words[0]) || words[0].startsWith("()"))) words.shift()
  }
  // A loop's or a case's own line: what runs is inside it.
  if (!words.length || /^(for|case|select)$/.test(words[0])) return
  out.push(words.join(" "))
  const bare = withoutPrefix(words, state, (line) => addLine(line, out, state))
  if (!bare.length) return
  out.push(bare.join(" "))
  // As it runs: the words the program gets, and the program by its name (`"git" push`, `\git`,
  // `/usr/bin/git`); written as before where taking the quotes off would join words.
  const plain = bare.map(dequote)
  plain[0] = plain[0].split("/").pop() ?? plain[0]
  const shown = plain.map((word, index) => (/^[\w@%+=:,./-]*$/.test(word) ? word : bare[index]))
  out.push(shown.join(" "))
  // A program named by a variable or a substitution, or quoting this can't read (`$'\x72m'`): not known.
  if (/[$`]/.test(bare[0]) || bare.some(ansiQuoted)) state.sure = false
  const program = plain[0]
  if (program === "git") {
    const rest = shown.slice(1)
    while (rest.length) {
      if (rest[0] === "-C" || rest[0] === "-c" || rest[0] === "--git-dir" || rest[0] === "--work-tree" || rest[0] === "--namespace") rest.splice(0, 2)
      else if (rest[0].startsWith("-")) rest.shift()
      else break
    }
    out.push(["git", ...rest].join(" "))
  } else if (/^(ba|z|da|k|fi|tc|c|a)?sh$/.test(program) || program === "su") {
    // A shell given a command line runs its commands; one reading its script from its input (a
    // here-document, what's piped to it) runs what isn't known here (a script file is as any program).
    const at = plain.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word))
    if (at > 0 && plain[at + 1] !== undefined) addLine(plain[at + 1], out, state)
    else if (plain.includes("-s") || !operands(plain.slice(1)).some((word) => !word.startsWith("-") && !word.startsWith("+"))) state.sure = false
  } else if (program === "eval") {
    addLine(plain.slice(1).join(" "), out, state)
  } else if (program === "xargs") {
    // The command it runs, with arguments from its input (not known here).
    state.sure = false
    let i = 1
    while (i < plain.length && plain[i].startsWith("-")) i += /^-[IinPLsdEaJRS]$/.test(plain[i]) ? 2 : 1
    if (i < plain.length) addCommand(plain.slice(i).map(quoted).join(" "), out, state)
  } else if (program === "find") {
    // What its -exec runs, up to its `;` or `+`.
    for (let i = 1; i < plain.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(plain[i])) continue
      const end = plain.findIndex((word, index) => index > i && (word === ";" || word === "+"))
      addCommand(plain.slice(i + 1, end < 0 ? undefined : end).map(quoted).join(" "), out, state)
      if (end < 0) state.sure = false
    }
  }
}

/** A word with `$'…'` or `$"…"` quoting outside other quotes (`$'\x72m'`), which this doesn't read. */
function ansiQuoted(word: string): boolean {
  let quote = ""
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if (ch === "\\" && quote !== "'") i++
    else if (quote) {
      if (ch === quote) quote = ""
    } else if (ch === "'" || ch === '"') quote = ch
    else if (ch === "$" && (word[i + 1] === "'" || word[i + 1] === '"')) return true
  }
  return false
}

/** A command's words without its redirections (`<<EOF`, `< file`, `2>&1`). */
function operands(words: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < words.length; i++) {
    if (/^\d*(<<<|<<-?|>>|<>|<&|>&|&>>|&>|<|>)$/.test(words[i])) i++
    else if (!/^\d*(<<<|<<-?|>>|<>|<&|>&|&>>|&>|<|>)/.test(words[i])) kept.push(words[i])
  }
  return kept
}

/** A command line inside a command (`bash -c '…'`, `eval …`, `env -S '…'`): its commands too. */
function addLine(line: string, out: string[], state: { sure: boolean }) {
  const inner = parseCommands(line)
  out.push(...inner.commands)
  if (!inner.sure) state.sure = false
}

/** A word as the program gets it, quoted again for a shell to read (it has a space, or quotes). */
function quoted(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** Programs that run the command after them, and which of their options take a value (`sudo -u bob`, `nice -n 10`; `sudo -n` takes none). */
/**
 * Programs that run the command after them, and their options: the short ones that take a value
 * (`sudo -u bob`, `-ubob`, `-iu bob`; `sudo -n` takes none), the long ones that do (`--user bob`),
 * and long ones known to take none. Another long option without `=` isn't known: the line isn't
 * taken as read through.
 */
const wrappers: Record<string, { short: string; long?: string[]; flags?: string[] }> = {
  env: { short: "uCSP", long: ["--unset", "--chdir", "--split-string"], flags: ["--ignore-environment", "--null", "--debug"] },
  command: { short: "" },
  exec: { short: "a" },
  nohup: { short: "" },
  builtin: { short: "" },
  sudo: {
    short: "ugCDhprtUT",
    long: ["--user", "--group", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout"],
    flags: ["--non-interactive", "--login", "--shell", "--preserve-env", "--background", "--stdin", "--reset-timestamp", "--remove-timestamp", "--set-home", "--bell"],
  },
  doas: { short: "uC" },
  time: { short: "of", long: ["--output", "--format"], flags: ["--portability", "--verbose", "--append"] },
  nice: { short: "n", long: ["--adjustment"] },
  caffeinate: { short: "tw" },
  timeout: { short: "sk", long: ["--signal", "--kill-after"], flags: ["--foreground", "--preserve-status", "--verbose"] },
  setsid: { short: "", flags: ["--ctty", "--fork", "--wait"] },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
  watch: { short: "nq", long: ["--interval", "--equexit"], flags: ["--differences", "--no-title", "--beep", "--errexit", "--chgexit", "--exec", "--precise", "--color"] },
  ionice: { short: "cnp", long: ["--class", "--classdata", "--pid"] },
  chronic: { short: "" },
}

/**
 * A command without what comes before what runs; `line` is told a command line an option holds
 * (`env -S '…'`).
 */
function withoutPrefix(words: string[], state?: { sure: boolean }, line?: (text: string) => void): string[] {
  let i = 0
  while (i < words.length) {
    const word = words[i]
    const program = dequote(word).split("/").pop() ?? ""
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i++
    else if (/^\d*(>>?|<|&>|>&|<&|&>>)$/.test(word)) i += 2
    else if (/^\d*(>>?|<|&>|>&|<&|&>>)\S/.test(word)) i++
    else if (program === "coproc") {
      // `coproc [NAME] command`: which word is its name isn't known here.
      if (state) state.sure = false
      i++
    } else if (Object.hasOwn(wrappers, program)) {
      const spec = wrappers[program]
      i++
      while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
        const option = dequote(words[i])
        if (option === "--") {
          i++
          break
        }
        if (option.startsWith("--")) {
          const at = option.indexOf("=")
          const name = at < 0 ? option : option.slice(0, at)
          const takes = spec.long?.includes(name) ?? false
          const value = at >= 0 ? option.slice(at + 1) : takes ? dequote(words[i + 1] ?? "") : undefined
          if (program === "env" && name === "--split-string" && value !== undefined) line?.(value)
          if (at < 0 && !takes && !spec.flags?.includes(name) && state) state.sure = false
          i += at < 0 && takes ? 2 : 1
          continue
        }
        // Short ones, bundled (`-iu bob`, `-oL`, `-S'rm x'`): the first that takes a value takes
        // the rest of the word, or the next one.
        let taken = 1
        for (let k = 1; k < option.length; k++) {
          if (!spec.short.includes(option[k])) continue
          const rest = option.slice(k + 1)
          if (program === "env" && option[k] === "S") line?.(rest || dequote(words[i + 1] ?? ""))
          if (!rest) taken = 2
          break
        }
        i += taken
      }
      // timeout's duration comes before the command.
      if (program === "timeout" && i < words.length) i++
    } else break
  }
  return words.slice(i)
}

/** A command's words: split where a shell would, quotes and substitutions kept whole. */
function shellWords(text: string): string[] {
  const words: string[] = []
  let word = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (word) words.push(word)
      word = ""
      i++
    } else if (ch === "\\") {
      word += text.slice(i, i + 2)
      i += 2
    } else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1
      while (j < text.length && text[j] !== ch) j += ch !== "'" && text[j] === "\\" ? 2 : 1
      word += text.slice(i, j + 1)
      i = j + 1
    } else if (text.startsWith("$(", i)) {
      let depth = 0
      let j = i + 1
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++
        else if (text[j] === ")" && --depth === 0) break
      }
      word += text.slice(i, j + 1)
      i = j + 1
    } else {
      word += ch
      i++
    }
  }
  if (word) words.push(word)
  return words
}

/** A word as the program gets it: its quotes and escapes taken off (substitutions stay as written). */
function dequote(word: string): string {
  let out = ""
  let i = 0
  while (i < word.length) {
    const ch = word[i]
    if (ch === "\\") {
      out += word[i + 1] ?? ""
      i += 2
    } else if (ch === "'") {
      const end = word.indexOf("'", i + 1)
      out += word.slice(i + 1, end < 0 ? word.length : end)
      i = end < 0 ? word.length : end + 1
    } else if (ch === '"') {
      let j = i + 1
      while (j < word.length && word[j] !== '"') {
        if (word[j] === "\\" && /["\\$`]/.test(word[j + 1] ?? "")) {
          out += word[j + 1]
          j += 2
        } else out += word[j++]
      }
      i = j + 1
    } else {
      out += ch
      i++
    }
  }
  return out
}

/**
 * A command line this can't read through, with a Block on commands: what it hides could be what's
 * blocked (`echo 'rm x' | sh`), so you're asked rather than it running unseen.
 */
function hidesFromBlocks(blocks: PermissionRule[] | undefined, ask: PermissionAsk): boolean {
  if (!isShell(ask.action) || !blocks?.some((rule) => rule.effect === "deny" && isShell(rule.action))) return false
  return ask.resources.some((line) => !parseCommands(line.trim()).sure)
}

/** What reads or changes files: its paths may be outside the project. */
const fileActions = new Set(["read", "edit", "write", "patch", "list", "grep", "glob"])

/**
 * Kuvo Code's own folders an agent works with, never "outside the project": the bridge's (the
 * skills it gives agents, their temporary files), files you attached, Claude Code's plans, the
 * skills Settings › Skills lists.
 */
function ownPlaces(): string[] {
  const places = [process.env.KUVO_AGENTS_HOME, process.env.TMPDIR?.replace(/\/$/, ""), join(homedir(), ".claude", "plans")].filter((place): place is string => Boolean(place))
  // This Mac's attachments, beside the bridge's folder (a machine's are in the session).
  if (process.env.KUVO_AGENTS_HOME && !onMachine) places.push(join(dirname(process.env.KUVO_AGENTS_HOME), "Attachments"))
  return [...places, ...skillFolders()]
}

/**
 * The paths an ask about files names outside the session's folder (and Kuvo Code's own, and files
 * attached to the conversation): what your rules for working outside the project
 * (`external_directory`) say of, as the engine's do.
 */
export function outsidePaths(ask: PermissionAsk, directory: string, attached: Set<string>, own = ownPlaces()): string[] {
  if (!fileActions.has(ask.action)) return []
  const paths = ask.resources
    // Paths, from the session's folder (`../x` too), not patterns of names (`*.ts`).
    .filter((resource) => resource && resource !== "*" && (resource.startsWith("/") || resource.startsWith("~/") || !/[*?[]/.test(resource)))
    .map((resource) => resolve(directory, resource.startsWith("~/") ? join(homedir(), resource.slice(2)) : resource))
  return paths.filter((path) => !within(path, [directory, ...own]) && !attached.has(path))
}

/** An ask about working outside the project, for these paths: "Always" allows their folders. */
function outsideAsk(ask: PermissionAsk, paths: string[]): PermissionAsk {
  return { ...ask, action: "external_directory", resources: paths, save: [...new Set(paths.map((path) => join(dirname(path), "*")))], unclassified: false }
}

/** What an ask is about, a command line's commands one by one. */
function partsOf(ask: PermissionAsk): string[] {
  return isShell(ask.action) ? ask.resources.flatMap(commandParts) : ask.resources
}

function isShell(action: string): boolean {
  return action === "shell" || action === "bash"
}

/**
 * You allowed it before ("Always"): each of its resources is one you allowed as it is, or, for a
 * command line, each command in it is covered (a command allowed doesn't take others along).
 */
function coveredBy(patterns: string[], action: string, resources: string[]): boolean {
  return resources.every((resource) => {
    if (patterns.includes(resource)) return true
    if (!isShell(action)) return patterns.some((pattern) => matches(pattern, resource))
    // A line that can't be read through is never let through on its own.
    const { commands, sure } = parseCommands(resource.trim())
    if (!sure) return false
    return (commands.length ? commands : [resource.trim()]).every((command) => patterns.some((pattern) => matches(pattern, command)))
  })
}

/** What the agents do on their own when nothing is to be approved: a rule about these holds them back. */
const agentActions = new Set(["*", "edit", "write", "patch", "shell", "bash", "read", "webfetch", "websearch", "external_directory"])

/** Actions that only look: asked about while Blocks aren't known only when a rule says so. */
const looks = new Set(["read", "glob", "grep", "list", "websearch", "todowrite", "todoread", "question"])

/** What rules say of each part (the last rule that matches it), the strictest of them: deny, then ask, then allow. */
export function strictest(rules: PermissionRule[], action: string, parts: string[]): "allow" | "deny" | "ask" | undefined {
  let result: "allow" | "ask" | undefined
  for (const part of parts.length ? parts : ["*"]) {
    const effect = ruled(rules, action, [part])
    if (effect === "deny") return "deny"
    if (effect === "ask") result = "ask"
    else if (effect === "allow" && !result) result = "allow"
  }
  return result
}

/** A step of the agent's that did something: wrote to you, or used a tool. */
function didWork(message: Message): boolean {
  return message.type === "assistant" && message.content.some((content) => content.type === "tool" || (content.type === "text" && content.text.trim() !== ""))
}

export class Sessions {
  private live = new Map<string, Live>()

  constructor(
    private readonly store: Store,
    private readonly roster: Roster,
    readonly auto: Auto,
    /** Runs a model of the engine's own providers in a session here (Auto's, or one you picked). */
    private readonly engine?: (providerID: string) => Agent | undefined,
    /** Settings › Permissions' Blocks for a folder, from the engine. */
    private readonly policies?: (directory: string) => Promise<PermissionRule[] | undefined>,
    /** The session's agent as the engine has it: what it's told, and its permissions. */
    private readonly agentInfo?: (name: string, directory: string) => Promise<{ system?: string; permissions?: PermissionRule[] } | undefined>,
    /** What the project's files were before each of your messages, for undo. */
    private readonly snapshots?: Snapshots,
    /** The model you picked for sessions' titles (Settings › Agents), an engine's. */
    private readonly titleModel?: (directory: string) => Promise<ModelRef | undefined>,
  ) {
    // Turns a quit or crash cut short: ended, as Stop ends one.
    for (const session of store.all()) this.repair(session.id)
  }

  /** The agent that runs a provider's models: an outside agent's account, or the engine. */
  agent(providerID: string | undefined): Agent | undefined {
    if (!providerID || providerID === autoProvider) return undefined
    return this.roster.find(providerID) ?? this.engine?.(providerID)
  }

  private runs(model: ModelRef | undefined): boolean {
    if (model?.providerID === autoProvider) return this.auto.list(model.id).length > 0
    return Boolean(this.agent(model?.providerID))
  }

  private state(id: string): Live {
    let live = this.live.get(id)
    if (!live) {
      // Blocks aren't known until the engine says (none, without an engine to ask).
      live = { threads: new Map(), doing: { kind: "idle" }, go: false, waiting: [], steering: new Map(), permissions: new Map(), forms: new Map(), always: [], subagents: new Map(), runs: new Map(), blocks: this.policies ? undefined : [], models: new Map(), background: new Set() }
      this.live.set(id, live)
    }
    return live
  }

  private record(id: string) {
    const record = this.store.get(id)
    if (!record) throw new NotFound(`No session ${id}.`)
    return record
  }

  private isBusy(id: string) {
    const live = this.live.get(id)
    return Boolean(live && isBusy(live.doing))
  }

  /**
   * Once the files are kept or put back, when that's what the session is doing (a turn just
   * ended, one a quit cut short is read after a restart, another Undo): an Undo or Redo waits its
   * turn, rather than being told to stop an agent that isn't working. Otherwise there's nothing to
   * wait for, and it isn't awaited: Undo takes the session at once, before anything can start.
   */
  private async whenFiles(live: Live) {
    while (onFiles(live.doing)) await new Promise<void>((resolve) => live.waiting.push(resolve))
  }

  /** What's kept of the project's files around each of your messages, by message. */
  private notes(record: Record_): Record<string, SnapshotNote> {
    const kept = (record.agent.snapshots as Record<string, SnapshotNote | string> | undefined) ?? {}
    // From before notes were kept whole: a tree alone, its turn's files not known.
    for (const [id, value] of Object.entries(kept)) if (typeof value === "string") kept[id] = { before: value, failed: true }
    record.agent.snapshots = kept
    return kept as Record<string, SnapshotNote>
  }

  /** What's waiting to be sent, kept with the session (it outlasts the bridge). */
  private queue(record: Record_): Input[] {
    let queue = record.agent.inbox as Input[] | undefined
    if (!Array.isArray(queue)) record.agent.inbox = queue = []
    return queue
  }

  /** Each agent's slot in a session, made from the single agent's state of before if need be. */
  private slots(record: Record_): Record<string, Slot> {
    let slots = record.agent.threads as Record<string, Slot> | undefined
    if (!slots) {
      slots = {}
      const legacy = Object.fromEntries(legacyKeys.filter((key) => key in record.agent).map((key) => [key, record.agent[key]]))
      // Its one agent wrote its replies (the session's model may have moved since).
      const provider = record.messages.findLast((message): message is AssistantMessage => message.type === "assistant")?.model.providerID ?? record.session.model?.providerID
      if (Object.keys(legacy).length && provider && provider !== autoProvider) {
        // It has seen the whole conversation so far.
        slots[provider] = { state: legacy, seen: record.messages[record.messages.length - 1]?.id }
      }
      for (const key of legacyKeys) delete record.agent[key]
      record.agent.threads = slots
    }
    return slots
  }

  /** A turn the bridge stopped in the middle of (it quit): its steps and tools closed, and its end marked. */
  private repair(id: string) {
    const record = this.store.get(id)
    if (!record) return
    let changed = false
    // A turn starts with your message, or with a note from the app (a mid-turn model switch).
    const lastUser = record.messages.findLastIndex((message) => message.type === "user" || message.type === "synthetic")
    for (const message of record.messages) {
      // A command of yours the bridge stopped with: over.
      if (message.type === "shell" && message.status === "running") {
        message.status = "failed"
        message.time.completed = message.time.created
        changed = true
      }
      if (message.type !== "assistant") continue
      if (!message.time.completed) {
        message.time.completed = message.time.streamed ?? message.time.created
        changed = true
      }
      for (const content of message.content) {
        if (content.type !== "tool" || (content.state.status !== "running" && content.state.status !== "streaming")) continue
        const input = content.state.status === "streaming" ? {} : content.state.input
        const metadata = content.state.status === "running" ? content.state.metadata : undefined
        content.state = { status: "error", input, error: { type: "aborted", message: "Stopped." }, content: [], metadata }
        changed = true
      }
    }
    // A subagent's session can start without a message of yours (its task given elsewhere).
    const lastStep = record.messages.findLastIndex((message) => message.type === "assistant")
    const openStep = record.session.parentID && lastStep > lastUser && !record.messages.slice(lastStep).some((message) => message.type === "idle")
    if ((lastUser >= 0 && !record.messages.slice(lastUser).some((message) => message.type === "idle")) || openStep) {
      const last = record.messages[record.messages.length - 1]
      const at = last?.time.completed ?? last?.time.created ?? Date.now()
      record.messages.push({ type: "idle", id: newID("msg"), time: { created: at }, outcome: "interrupted" })
      record.session.outcome = "interrupted"
      record.session.time.idle = at
      changed = true
    }
    // A turn cut short kept the files before it but not what it changed: read now, so Undo
    // still works for it and the messages before it; unless it stopped a while ago (the app was
    // closed), when what changed since may be yours, which Undo mustn't take back.
    const open = Object.values(this.notes(record)).filter((note) => note.before && !note.files && !note.failed)
    const stopped = this.store.writtenAt(id)
    if (open.length && this.snapshots && stopped !== undefined && Date.now() - stopped < timing.cutShort) void this.finishNotes(id)
    else if (open.length) {
      for (const note of open) note.failed = true
      changed = true
    }
    if (changed) this.store.save(id, true)
  }

  private async finishNotes(id: string) {
    const record = this.store.get(id)
    if (!record || !this.snapshots) return
    const open = Object.values(this.notes(record)).filter((note) => note.before && !note.files && !note.failed)
    const directory = record.session.location.directory
    const live = this.state(id)
    const keeping: Doing = { kind: "keeping" }
    live.doing = keeping
    try {
      const now = await this.snapshots.take(directory)
      if (!now) throw new Error("not kept")
      for (const note of open) note.files = await this.snapshots.changed(directory, note.before!, now)
    } catch {
      for (const note of open) if (!note.files) note.failed = true
    } finally {
      if (this.store.get(id)) this.store.save(id)
      if (live.doing === keeping) this.free(id, live)
    }
  }

  // MARK: Sessions

  create(body: { title?: string; agent?: string; model?: ModelRef; location: { directory: string }; permissions?: PermissionRule[] }): Session {
    if (body.model?.providerID === autoProvider && !this.auto.list(body.model.id).length) throw new BadRequest("That Custom Auto list is empty: add models to it in Settings › Custom Auto.")
    if (!body.model?.id || !this.runs(body.model)) throw new BadRequest("Pick a model of an agent you've connected.")
    const now = Date.now()
    const directory = body.location.directory
    const session: Session = {
      id: newID("ses"),
      projectID: "prj_" + createHash("sha1").update(directory).digest("hex").slice(0, 16),
      agent: typeof body.agent === "string" && body.agent ? body.agent : "build",
      model: body.model,
      cost: 0,
      tokens: noTokens(),
      time: { created: now, updated: now },
      title: body.title,
      location: { directory },
      permissions: body.permissions,
      metadata: { kuvoAgent: this.kind(body.model.providerID) },
    }
    this.store.add(session)
    emit("session.created", { sessionID: session.id, session }, directory)
    return session
  }

  /** What a session's metadata says runs it: an agent (`claude`…), `auto`, or `engine`. */
  private kind(providerID: string): string {
    if (providerID === autoProvider) return autoProvider
    return this.agent(providerID)?.id ?? "engine"
  }

  /**
   * A new session with this one's conversation before `before` (a message of yours), to try
   * another way from there. The agents' own conversations can't be copied: whichever runs it
   * gets what came before as a handover.
   */
  /**
   * A conversation from the engine, carried on here (you picked a coding agent's model in it): a
   * session with its messages, whose agents are handed all of it as they first run, and the
   * messages you'd sent that were waiting there, still waiting (nothing starts).
   */
  importSession(body: { title?: string; agent?: string; model?: ModelRef; location: { directory: string }; permissions?: PermissionRule[]; messages?: unknown[]; waiting?: unknown[] }): Session {
    const session = this.create(body)
    const record = this.store.get(session.id)!
    const known = new Set(["user", "assistant", "synthetic", "system", "idle", "model-switched", "agent-switched", "shell"])
    record.messages = (Array.isArray(body.messages) ? body.messages : []).filter(
      (message): message is Message => typeof message === "object" && message !== null && known.has((message as any).type) && typeof (message as any).id === "string",
    )
    // Its last turn is over (a run left open there isn't one here).
    this.repair(session.id)
    const queue = this.queue(record)
    for (const item of Array.isArray(body.waiting) ? body.waiting : []) {
      const { id, text, files } = (item ?? {}) as { id?: unknown; text?: unknown; files?: unknown }
      if (typeof id !== "string" || typeof text !== "string") continue
      const kept = (Array.isArray(files) ? files : []).filter((file): file is Input["files"][number] => typeof file?.uri === "string")
      queue.push({ id, text, files: kept.map((file) => ({ uri: file.uri, ...(typeof file.name === "string" ? { name: file.name } : {}) })), delivery: "queue" })
    }
    session.title = body.title ?? session.title
    session.time.updated = Date.now()
    this.store.save(session.id, true)
    emit("session.updated", { sessionID: session.id, session }, session.location.directory)
    return session
  }

  fork(id: string, before: string): Session {
    const record = this.record(id)
    const at = record.messages.findIndex((message) => message.id === before)
    if (at < 0) throw new NotFound("That message isn't in this session.")
    const now = Date.now()
    const source = record.session
    const session: Session = {
      id: newID("ses"),
      projectID: source.projectID,
      agent: source.agent,
      model: source.model,
      cost: 0,
      tokens: noTokens(),
      time: { created: now, updated: now },
      title: source.title,
      location: { ...source.location },
      permissions: source.permissions,
      metadata: { ...source.metadata },
    }
    this.store.add(session)
    const copy = this.store.get(session.id)!
    copy.messages = structuredClone(record.messages.slice(0, at))
    if (record.agent.kuvoInstructions) copy.agent.kuvoInstructions = structuredClone(record.agent.kuvoInstructions)
    if (Array.isArray(record.agent.autoHeld)) copy.agent.autoHeld = [...(record.agent.autoHeld as string[])]
    this.store.save(session.id, true)
    emit("session.created", { sessionID: session.id, session }, session.location.directory)
    return session
  }

  /** Sessions, newest first: in a folder, and under a session (`parentID`; "null" for those under none). */
  list(directory?: string, parentID?: string | null): Session[] {
    return this.store
      .all()
      .filter((session) => !directory || session.location.directory === directory)
      .filter((session) => parentID === undefined || (parentID === null ? !session.parentID : session.parentID === parentID))
      .sort((a, b) => b.time.updated - a.time.updated || (a.id < b.id ? 1 : -1))
  }

  get(id: string): Session {
    return this.record(id).session
  }

  /** Its conversation, oldest first, with the turn under way as far as it's got. */
  messages(id: string): Message[] {
    return this.record(id).messages
  }

  update(id: string, body: { title?: string; permissions?: PermissionRule[]; metadata?: Record<string, unknown> }) {
    const record = this.record(id)
    const session = record.session
    const directory = session.location.directory
    if (body.title !== undefined) {
      session.title = body.title
      emit("session.renamed", { sessionID: id, title: body.title }, directory)
    }
    if (body.permissions !== undefined) session.permissions = body.permissions
    if (body.metadata !== undefined) {
      // The bridge's own note stays, whatever the app writes.
      session.metadata = { ...body.metadata, kuvoAgent: session.metadata?.kuvoAgent }
      emit("session.metadata.updated", { sessionID: id }, directory)
    }
    session.time.updated = Date.now()
    this.store.save(id, true)
  }

  async remove(id: string) {
    const record = this.store.get(id)
    if (!record) return
    const live = this.state(id)
    const doing = live.doing
    if (doing.kind === "deleting") return
    // Nothing waiting starts as it stops, nor does anything sent meanwhile.
    live.doing = { kind: "deleting" }
    live.go = false
    this.turnAwayOwn(live)
    for (const waiting of live.waiting.splice(0)) waiting()
    record.agent.inbox = []
    const run = runOf(doing)
    if (run) await this.stop(id, live, run)
    else await this.stopSubagents(id)
    // Its subagents' sessions go with it, unless a fork of it shows them too.
    for (const child of this.list(undefined, id)) if (!this.shownElsewhere(child.id, id)) await this.remove(child.id)
    for (const thread of live.threads.values()) thread.close()
    for (const [provider, slot] of Object.entries(this.slots(record))) await this.agent(provider)?.forgetConversation?.(slot.state).catch(() => {})
    this.store.remove(id)
    this.live.delete(id)
    emit("session.deleted", { sessionID: id }, record.session.location.directory)
  }

  /** Whether a session other than `except` has a step that names `child` (a fork of its conversation). */
  private shownElsewhere(child: string, except: string): boolean {
    for (const session of this.store.all()) {
      if (session.id === except || session.id === child) continue
      const record = this.store.get(session.id)
      if (record?.messages.some((message) => message.type === "assistant" && message.content.some((content) => content.type === "tool" && (content.state as any).metadata?.sessionID === child))) return true
    }
    return false
  }

  view(id: string, idle: number) {
    const session = this.record(id).session
    session.time.viewed = Math.max(idle, session.time.viewed ?? 0)
    this.store.save(id)
  }

  active(): string[] {
    const ids = [...this.live.keys()].filter((id) => this.isBusy(id))
    for (const live of this.live.values()) for (const [child, turn] of live.subagents) if (!turn.isEnded) ids.push(child)
    return ids
  }

  /**
   * A command you typed with "!", run in the session's folder as you, right away, without waking
   * the agent: it and what it printed join the conversation, and the agent gets them with your
   * next message.
   */
  runShell(id: string, command: string) {
    const record = this.record(id)
    if (record.session.parentID) throw new BadRequest("This subagent works for the conversation that started it: run it there.")
    const text = command.trim()
    if (!text) throw new BadRequest("Type a command after the !.")
    const directory = record.session.location.directory
    const shellID = newID("shl")
    // Named after its event, as the app names it from the event.
    const event = emit("session.shell.started", { sessionID: id, shell: { id: shellID, command: text, status: "running" } }, directory)
    const message: ShellMessage = { type: "shell", id: messageID(event.id), time: { created: event.created }, shellID, command: text, status: "running" }
    record.messages.push(message)
    record.session.time.updated = Date.now()
    // Run while an agent works: it hasn't seen it when its turn ends, and gets it with your next message.
    if (this.isBusy(id)) record.agent.lateShells = [...((record.agent.lateShells as string[] | undefined) ?? []), message.id]
    this.store.save(id, true)
    void runCommand(text, directory).then((ran) => {
      message.status = ran.code === 0 && !ran.timedOut ? "completed" : "failed"
      message.exit = ran.code
      message.output = { output: ran.timedOut ? `${ran.output}\n(Stopped: it ran past ${shellTimeout / 60_000} minutes.)`.trim() : ran.output, truncated: ran.truncated }
      message.time.completed = Date.now()
      if (!this.store.get(id)) return
      this.store.save(id, true)
      emit("session.shell.ended", { sessionID: id, shell: { id: shellID, command: text, status: message.status, exit: ran.code }, output: message.output }, directory)
    })
  }

  // MARK: Undo

  /**
   * Takes the conversation back to before your message `messageID`, and the files the agents
   * changed since; the next message makes it final, `clearRevert` brings it all back.
   */
  async stageRevert(id: string, messageID: string): Promise<NonNullable<Session["revert"]>> {
    const record = this.record(id)
    const live = this.state(id)
    if (onFiles(live.doing)) await this.whenFiles(live)
    this.mustBeIdle(id, live)
    const at = record.messages.findIndex((message) => message.id === messageID && message.type === "user")
    if (at < 0) throw new NotFound("No such message of yours.")
    const directory = record.session.location.directory
    const notes = this.notes(record)
    // What the turns from it on changed, as the engine's undo puts back: only those files (your
    // own edits elsewhere, and other sessions', stay).
    const files = new Set<string>()
    let kept = false
    for (const message of record.messages.slice(at)) {
      const note = notes[message.id]
      if (!note) continue
      kept = true
      if (note.failed || !note.before || !note.files) throw new BadRequest("Kuvo Code couldn't keep what the files were around one of these messages, so Undo can't put them back.")
      for (const path of note.files) files.add(path)
    }
    const first = notes[messageID]
    // A message taken partway through a turn (steered) before they were kept has no files of its own.
    if (kept && !first?.before) throw new BadRequest("This message went into the turn before it: undo from that one.")
    let diffs: FileDiff[] = []
    const reverting: Doing = { kind: "reverting" }
    if (first?.before && files.size && this.snapshots) {
      live.doing = reverting
      // What Redo would bring back from an undo that didn't happen isn't kept.
      if (!record.session.revert) {
        delete record.agent.revertNow
        delete record.agent.revertAt
        delete record.agent.revertFiles
      }
      let now: string | undefined
      const nowAt = Date.now()
      try {
        now = await this.snapshots.take(directory)
        if (!now) throw new Error("Kuvo Code couldn't keep the files as they are now.")
        // As they were before any undo, and which: what Redo brings back (kept before a file is touched).
        if (!record.agent.revertNow) {
          record.agent.revertNow = now
          record.agent.revertAt = nowAt
        }
        record.agent.revertFiles = [...new Set([...((record.agent.revertFiles as string[] | undefined) ?? []), ...files])]
        this.store.save(id)
        diffs = await this.snapshots.changes(directory, first.before, now, [...files])
        await this.snapshots.restore(directory, first.before, [...files], first.at)
      } catch (error) {
        // Partway: the files go back to how they were just now, and nothing is staged.
        if (now) await this.snapshots.restore(directory, now, [...files], nowAt).catch(() => {})
        if (!record.session.revert) {
          delete record.agent.revertNow
          delete record.agent.revertAt
          delete record.agent.revertFiles
        }
        this.store.save(id)
        if (live.doing === reverting) this.free(id, live)
        throw error
      }
      if (live.doing !== reverting) throw new NotFound(`No session ${id}.`)
    }
    const revert = { messageID, files: diffs }
    record.session.revert = revert
    this.store.save(id, true)
    emit("session.revert.staged", { sessionID: id, revert }, directory)
    // What you sent meanwhile goes now (and makes the undo final, as any message does).
    if (live.doing === reverting) this.free(id, live)
    return revert
  }

  /** Takes an undo back: the conversation and the files, as they were. */
  async clearRevert(id: string) {
    const record = this.record(id)
    if (!record.session.revert) return
    const live = this.state(id)
    if (onFiles(live.doing)) await this.whenFiles(live)
    this.mustBeIdle(id, live)
    if (!record.session.revert) return
    const directory = record.session.location.directory
    const now = record.agent.revertNow as string | undefined
    const files = (record.agent.revertFiles as string[] | undefined) ?? []
    const reverting: Doing = { kind: "reverting" }
    if (now && files.length && this.snapshots) {
      live.doing = reverting
      try {
        // Kept until it has worked: a Redo that failed can be tried again.
        await this.snapshots.restore(directory, now, files, record.agent.revertAt as number | undefined)
      } catch (error) {
        if (live.doing === reverting) this.free(id, live)
        throw error
      }
      if (live.doing !== reverting) throw new NotFound(`No session ${id}.`)
    }
    delete record.session.revert
    delete record.agent.revertNow
    delete record.agent.revertAt
    delete record.agent.revertFiles
    this.store.save(id, true)
    emit("session.revert.cleared", { sessionID: id }, directory)
    if (live.doing === reverting) this.free(id, live)
  }

  /** Undo and Redo go only while nothing runs. */
  private mustBeIdle(id: string, live: Live) {
    if (live.doing.kind === "deleting") throw new NotFound(`No session ${id}.`)
    if (live.doing.kind !== "idle") throw new BadRequest("Stop the agent first.")
  }

  /** An undo made final: what was taken back goes, and the agents start their conversations over, handed what's left. */
  private commitRevert(id: string, record: Record_, live: Live) {
    const revert = record.session.revert
    if (!revert) return
    const at = record.messages.findIndex((message) => message.id === revert.messageID)
    if (at >= 0) {
      const gone = record.messages.splice(at)
      const kept = this.notes(record)
      for (const message of gone) delete kept[message.id]
    }
    delete record.session.revert
    delete record.agent.revertNow
    delete record.agent.revertAt
    delete record.agent.revertFiles
    // Their own conversations still hold what was undone: let go of (an engine model's hidden
    // session too), and started over.
    for (const thread of live.threads.values()) thread.close()
    live.threads.clear()
    for (const [provider, slot] of Object.entries(this.slots(record))) void this.agent(provider)?.forgetConversation?.(slot.state).catch(() => {})
    record.agent.threads = {}
    this.store.save(id, true)
    emit("session.revert.committed", { sessionID: id, to: revert.messageID }, record.session.location.directory)
  }

  setInstruction(id: string, key: string, text: string | undefined) {
    const record = this.record(id)
    const entries = (record.agent.kuvoInstructions as Record<string, string> | undefined) ?? {}
    if (text === undefined) delete entries[key]
    else entries[key] = text
    record.agent.kuvoInstructions = entries
    this.store.save(id, true)
  }

  // MARK: Model and mode

  /** Another model, of this agent or another (Auto too): the next message goes to it, with what it hasn't seen. */
  selectModel(id: string, model: ModelRef) {
    const record = this.record(id)
    const session = record.session
    const previous = session.model
    if (!model?.providerID || !model.id) throw new BadRequest("That isn't a model.")
    if (model.providerID === autoProvider && !this.auto.list(model.id).length) throw new BadRequest("That Custom Auto list is empty: add models to it in Settings › Custom Auto.")
    if (!this.runs(model)) throw new BadRequest("That model's agent isn't connected.")
    if (previous && previous.providerID === model.providerID && previous.id === model.id && previous.variant === model.variant) return
    // What the session's agent kept, moved to its own slot while it's still the session's.
    this.slots(record)
    session.model = model
    session.metadata = { ...session.metadata, kuvoAgent: this.kind(model.providerID) }
    const event = emit("session.model.selected", { sessionID: id, model, previous }, session.location.directory)
    record.messages.push({ type: "model-switched", id: messageID(event.id), time: { created: event.created }, model, previous })
    this.store.save(id, true)
  }

  selectAgent(id: string, agent: string) {
    const record = this.record(id)
    const session = record.session
    const mode = typeof agent === "string" && agent ? agent : "build"
    const previous = session.agent
    if (previous === mode) return
    session.agent = mode
    const event = emit("session.agent.selected", { sessionID: id, agent: mode, previous }, session.location.directory)
    record.messages.push({ type: "agent-switched", id: messageID(event.id), time: { created: event.created }, agent: mode, previous })
    this.store.save(id, true)
  }

  // MARK: Messages

  inbox(id: string) {
    return this.queue(this.record(id)).map((input) => ({
      id: input.id,
      sessionID: id,
      type: input.synthetic ? "synthetic" : "user",
      payload: input.synthetic ? { text: input.text, description: input.synthetic.description } : { text: input.text, files: input.files },
      delivery: input.delivery,
    }))
  }

  /** A note from the app for the agent, next in line (the app sends one, then Stop with resume, to switch models mid-turn). */
  synthetic(id: string, text: string, description?: string) {
    const record = this.record(id)
    const input: Input = { id: newID("msg"), text, files: [], delivery: "steer", synthetic: { description } }
    this.queue(record).push(input)
    this.store.save(id, true)
    emit("session.inbox.enqueued", { sessionID: id, inboxID: input.id, item: { type: "synthetic", payload: { text, description }, delivery: "steer" } }, record.session.location.directory)
    this.wake(id)
  }

  prompt(id: string, input: Input) {
    const record = this.record(id)
    const live = this.state(id)
    if (live.doing.kind === "deleting") throw new NotFound(`No session ${id}.`)
    if (record.session.parentID) throw new BadRequest("This subagent works for the conversation that started it: write to it there.")
    const queue = this.queue(record)
    // Sent twice (a retry after a timeout): once is enough.
    if (queue.some((waiting) => waiting.id === input.id) || record.messages.some((message) => message.id === input.id)) return
    const doing = live.doing
    // While a turn runs, it waits for it, unless the agent at work takes it partway (Codex does).
    const into = doing.kind === "running" && input.delivery !== "queue" && doing.run.agent?.thread.steer ? doing.run : undefined
    // While nothing runs (or only files are being kept or put back: it goes once that's done), one
    // to go after the turn goes now, as the engine's do (a bot's wake-up), unless others wait
    // before it (held after a Stop).
    const free = doing.kind === "idle" || onFiles(doing)
    const delivery: Delivery = into || (free && (input.delivery !== "queue" || !queue.length)) ? "steer" : "queue"
    queue.push({ ...input, delivery })
    this.store.save(id, true)
    emit("session.inbox.enqueued", { sessionID: id, inboxID: input.id, item: { type: "user", payload: { text: input.text, files: input.files }, delivery } }, record.session.location.directory)
    if (into) void this.steerNow(id, live, into, input)
    else if (delivery === "steer") this.wake(id)
  }

  /**
   * A message of yours into the turn under way, at its next step; it waits for the turn when it
   * can't go. One the agent takes is sent, even if its turn ends just then or you cancel it
   * meanwhile (it can't be taken back).
   */
  private async steerNow(id: string, live: Live, run: Run, input: Input) {
    const agent = run.agent
    const directory = this.store.get(id)?.session.location.directory
    if (!agent?.thread.steer || !directory) return
    const handing = { cancelled: false }
    live.steering.set(input.id, handing)
    let taken = false
    let note: SnapshotNote | undefined
    try {
      // The files as they are before it, for Undo.
      if (this.snapshots) {
        try {
          const at = Date.now()
          const before = await this.snapshots.take(directory)
          if (before) note = { before, at }
        } catch {
          note = { failed: true }
        }
      }
      // A text file you attached goes in the message, as for the message that started the turn.
      const attached = withTextFiles(input.text, input.files.map(promptFile))
      // Still that turn, at work (not stopped) with that agent, and not cancelled meanwhile.
      if (live.doing.kind === "running" && live.doing.run === run && run.agent === agent && !handing.cancelled) {
        taken = await agent.thread.steer({ id: input.id, text: attached.text, files: attached.files }).catch(() => false)
      }
    } finally {
      live.steering.delete(input.id)
    }
    const record = this.store.get(id)
    if (!record) return
    const queue = this.queue(record)
    const at = queue.findIndex((waiting) => waiting.id === input.id)
    // (Gone: the session is being deleted.)
    if (at < 0) return
    if (!taken) {
      if (handing.cancelled) return this.cancelInput(id, input.id)
      // It waits for the turn, which goes on.
      if (live.doing.kind === "running") return this.setDelivery(id, input.id, "queue")
      // Its turn ended meanwhile, or is ending: it goes next, as after any turn, or as you asked
      // with Send Now (one you stopped holds it). Until the turn's over and its files are kept,
      // the turn's end starts it.
      if (live.doing.kind === "idle" && record.session.outcome === "succeeded") live.go = true
      return this.advance(id, live)
    }
    // Into the turn: a Send Now that waited for it is done.
    if (live.doing.kind === "idle" && !live.steering.size) live.go = false
    queue.splice(at, 1)
    emit("session.inbox.delivered", { sessionID: id, inboxID: input.id }, directory)
    const attachments: Attachment[] = input.files.map((file) => ({ mime: mime(file.uri), name: file.name, source: { type: "uri", uri: file.uri } }))
    record.messages.push({ type: "user", id: input.id, time: { created: Date.now() }, text: input.text, files: attachments.length ? attachments : undefined })
    record.session.time.updated = Date.now()
    // Its own undo, while its turn is under way (what the turn changes from here on).
    // (One that couldn't be kept isn't noted: Undo from the message before covers it.)
    if (note?.before && runOf(live.doing) === run) {
      this.notes(record)[input.id] = note
      run.steered.push(note)
    }
    this.store.save(id, true)
  }

  /** Steer (it goes next, and now if nothing runs) or queue (it waits its turn) a waiting message. */
  setDelivery(id: string, inputID: string, delivery: Delivery) {
    const record = this.record(id)
    const input = this.queue(record).find((waiting) => waiting.id === inputID)
    if (!input) throw new NotFound("That message was sent already.")
    if (delivery !== "steer" && delivery !== "queue") throw new BadRequest("Steer or queue.")
    if (input.delivery !== delivery) {
      input.delivery = delivery
      this.store.save(id, true)
      emit("session.inbox.delivery.changed", { sessionID: id, inboxID: inputID, delivery }, record.session.location.directory)
    }
    if (delivery === "steer") this.wake(id)
  }

  cancelInput(id: string, inputID: string) {
    // Being handed to the agent: cancelled if it doesn't take it.
    const handing = this.live.get(id)?.steering.get(inputID)
    if (handing) {
      handing.cancelled = true
      return
    }
    const record = this.store.get(id)
    if (!record) return
    const queue = this.queue(record)
    const index = queue.findIndex((input) => input.id === inputID)
    if (index < 0) return
    queue.splice(index, 1)
    this.store.save(id, true)
    emit("session.inbox.cancelled", { sessionID: id, inboxID: inputID }, record.session.location.directory)
  }

  /**
   * Starts the first message you steered: now if nothing runs, or once the files being kept or
   * put back are. (A turn under way decides at its end: it goes next if the turn ends on its own.)
   */
  private wake(id: string) {
    if (!this.store.get(id)) return
    const live = this.state(id)
    if (live.doing.kind !== "idle" && !onFiles(live.doing)) return
    live.go = true
    this.advance(id, live)
  }

  /**
   * What starts next, when nothing runs: a turn an agent began on its own first, whatever came
   * before (what you asked to start waits for it); then, after a turn that ended on its own, the
   * next message in line, steered ones first; otherwise the first you steered, if you asked
   * (`go`). After a Stop, or an error, nothing more starts until the app says.
   */
  private advance(id: string, live: Live, ended?: Outcome) {
    const record = this.store.get(id)
    if (live.doing.kind !== "idle" || !record) return
    const own = live.own
    live.own = undefined
    if (own) {
      // An undo came first (it was being staged): taking the turn would make it final.
      if (record.session.revert) live.threads.get(own.adopt!.providerID)?.turnAway?.()
      else return this.start(id, live, own)
    }
    const queue = this.queue(record)
    // One being handed to the turn that just ended is settled by that (sent, or back here).
    const free = (input: Input) => !live.steering.has(input.id)
    let index = -1
    if (ended === "succeeded" || live.go) index = queue.findIndex((input) => input.delivery === "steer" && free(input))
    if (ended === "succeeded" && index < 0) index = queue.findIndex(free)
    // (With nothing to start but one being handed, Send Now waits for it.)
    if (index >= 0 || !live.steering.size) live.go = false
    if (index < 0) return
    const [input] = queue.splice(index, 1)
    this.start(id, live, input)
  }

  /**
   * A turn is over and what it changed is kept, or the files are put back: the session is idle,
   * what waited goes, and Undo and Redo calls waiting go on (finding a turn if one started).
   */
  private free(id: string, live: Live, ended?: Outcome) {
    live.doing = { kind: "idle" }
    this.advance(id, live, ended)
    for (const waiting of live.waiting.splice(0)) waiting()
    if (live.doing.kind === "idle") this.closeWhenIdle(id, live)
  }

  /** A turn an agent began on its own, taken but not yet started: let go of (it stops). */
  private turnAwayOwn(live: Live | undefined): boolean {
    const own = live?.own
    if (!live || !own) return false
    live.own = undefined
    live.threads.get(own.adopt!.providerID)?.turnAway?.()
    return true
  }

  /**
   * One answer to a prompt from the session's model (Auto's first that can run), outside the
   * conversation: a commit message, say. Coding agents that can't answer one so say why.
   */
  async generate(id: string, prompt: string): Promise<string> {
    const model = this.record(id).session.model
    if (!model) throw new BadRequest("This session has no model yet.")
    const candidates: ModelRef[] = []
    if (model.providerID !== autoProvider) candidates.push(model)
    else {
      const tried = new Set<string>()
      for (let entry = await this.nextEntry(tried, model.id); entry; entry = await this.nextEntry(tried, model.id)) {
        tried.add(Auto.modelKey(entry))
        candidates.push({ providerID: entry.providerID, id: entry.modelID, ...(entry.variant ? { variant: entry.variant } : {}) })
      }
    }
    for (const candidate of candidates) {
      const agent = this.agent(candidate.providerID)
      if (agent?.generate) return agent.generate(prompt, candidate)
    }
    throw new BadRequest(`${this.agent(candidates[0]?.providerID)?.name ?? "This session's agent"} can't write this outside the conversation.`)
  }

  /** A title from your first message: from the model you picked for titles, or the session's. */
  private async nameSession(id: string, message: string) {
    const directory = this.store.get(id)?.session.location.directory
    const text = ownWords(message)
    if (!directory || !text.trim()) return
    const prompt = `Write a title for a conversation that begins with the message below: a few words (six at most) saying what it's about, in the message's language. Reply with the title alone, without quotes or a period at the end.\n\n<message>\n${text.slice(0, 4_000)}\n</message>`
    // The model you picked for titles; the session's; or, when its agent can't write one
    // (Antigravity, Cursor, Grok), another agent you're signed in to, on a quick model of its own.
    const picked = this.titleModel ? await this.titleModel(directory).catch(() => undefined) : undefined
    const engine = picked ? this.engine?.(picked.providerID) : undefined
    const own = this.store.get(id)?.session.model?.providerID
    let answer = picked && engine?.generate ? await engine.generate(prompt, picked).catch(() => "") : ""
    if (!answer.trim()) answer = await this.generate(id, prompt).catch(() => "")
    for (const agent of answer.trim() ? [] : this.roster.all()) {
      if (!agent.generate || agent.providerID === own) continue
      if (!(await agent.account().catch(() => undefined))?.signedIn) continue
      answer = await agent.generate(prompt).catch(() => "")
      if (answer.trim()) break
    }
    // None could: the app names it.
    if (!answer.trim()) return
    const title = answer
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^["'“”‘’`*#\s]+|["'“”‘’`*\s.]+$/g, "")
      .slice(0, 80)
    const record = this.store.get(id)
    if (!title || !record || record.session.title || this.live.get(id)?.doing.kind === "deleting") return
    this.update(id, { title })
  }

  /** Starts a turn for one message (only while nothing runs): the session is running from now. */
  private start(id: string, live: Live, input: Input) {
    const record = this.store.get(id)
    if (!record || live.doing.kind !== "idle") return
    const session = record.session
    const run: Run = { turn: new Turn(this.store, id, session.location.directory, session.model!, session.agent ?? "build"), abort: new AbortController(), steered: [] }
    live.doing = { kind: "running", run }
    clearTimeout(live.idle)
    void this.runTurn(id, live, record, run, input)
  }

  /** Runs one message: on its model, or down your Auto list. */
  private async runTurn(id: string, live: Live, record: Record_, run: Run, input: Input): Promise<void> {
    const { turn, abort } = run
    const session = record.session
    const directory = session.location.directory
    const model = session.model!
    // A message after an undo makes it final: first, since the app takes away what comes from the
    // undone message on (this message too, were it there already).
    this.commitRevert(id, record, live)
    emit("session.inbox.delivered", { sessionID: id, inboxID: input.id }, directory)
    const attachments: Attachment[] = input.files.map((file) => ({ mime: mime(file.uri), name: file.name, source: { type: "uri", uri: file.uri } }))
    if (input.synthetic) record.messages.push({ type: "synthetic", id: input.id, time: { created: Date.now() }, text: input.text, description: input.synthetic.description, metadata: input.synthetic.metadata })
    else record.messages.push({ type: "user", id: input.id, time: { created: Date.now() }, text: input.text, files: attachments.length ? attachments : undefined })
    session.time.updated = Date.now()
    this.store.save(id, true)
    // Your first message: the session gets a title from it, as the engine's sessions do.
    if (!input.synthetic && !session.title && !session.parentID && record.messages.filter((message) => message.type === "user").length === 1) void this.nameSession(id, input.text).catch(() => {})
    // The project's files as they are before it (yours, not a note from the app), and after its
    // turn: what the turn changed, which Undo puts back.
    let note: SnapshotNote | undefined
    if ((!input.synthetic || input.adopt) && this.snapshots) {
      try {
        const at = Date.now()
        const before = await this.snapshots.take(directory)
        if (before) note = { before, at }
      } catch {
        note = { failed: true }
      }
      if (note) {
        const kept = this.notes(record)
        kept[input.id] = note
        // The last hundred messages' are enough.
        const ids = Object.keys(kept).sort()
        for (const old of ids.slice(0, Math.max(0, ids.length - 100))) delete kept[old]
        this.store.save(id)
      }
    }
    // Blocks as they are now (once the message is in: one sent again meanwhile is known), and
    // what an agent of yours is told to be.
    const blocks = this.policies ? await this.policies(directory).catch(() => undefined) : []
    if (blocks !== undefined) live.blocks = blocks
    const agentName = session.agent ?? "build"
    const info = this.agentInfo ? await this.agentInfo(agentName, directory).catch(() => undefined) : undefined
    // Not known now: the rules kept stand only for the same agent (another's would be wrong).
    if (info?.permissions) live.agentRules = info.permissions
    else if (live.rulesFor !== agentName) live.agentRules = undefined
    live.rulesFor = agentName
    const own = session.agent && session.agent !== "build" && session.agent !== "plan" ? session.agent : undefined
    live.agentPrompt = own ? info?.system : undefined

    let result: RunResult
    let earlier = new Set<string>()
    try {
      // A text file you attached goes in the message, as the engine puts it (the agent reads the rest).
      const attached = withTextFiles(input.text, input.files.map(promptFile))
      const message: RunInput = { text: attached.text, files: attached.files, model, plan: session.agent === "plan" }
      // Subagents an earlier turn sent off in the background, still at work: this turn's end
      // leaves them be.
      earlier = new Set(live.subagents.keys())
      // A message on a model you picked: what Auto held back before isn't news when it's back on.
      if (model.providerID !== autoProvider) delete record.agent.autoHeld
      result = input.adopt
        ? await this.runOn(id, record, live, run, input.adopt, { ...message, model: input.adopt, adopt: true, auto: model.providerID === autoProvider || undefined }, input.id)
        : model.providerID === autoProvider
          ? await this.runAuto(id, record, live, run, { ...message, auto: true }, input.id)
          : await this.runOn(id, record, live, run, model, message, input.id)
    } catch (error) {
      result = { outcome: "failed", error: failure(error) }
    }
    const outcome: Outcome = abort.signal.aborted ? "interrupted" : result.outcome
    const before = record.messages[record.messages.length - 1]?.id
    turn.finish(outcome, outcome === "interrupted" ? undefined : result.error)
    // Subagents still at work end with it, but those it sent off in the background, which go on
    // in their sessions (when it went through: stopped or failed, their agent stops them too, and
    // what they asked goes with them).
    for (const [child, childTurn] of [...live.subagents]) {
      if (outcome === "succeeded" && live.background.has(child) && !childTurn.isEnded) continue
      if (earlier.has(child) && live.background.has(child) && !childTurn.isEnded) continue
      const subagent = live.runs.get(child)
      if (subagent && outcome !== "succeeded" && !childTurn.isEnded) void subagent.stop?.().catch(() => {})
      if (subagent?.turn === childTurn) subagent.end(outcome === "failed" ? "interrupted" : outcome)
      else childTurn.finish(outcome === "failed" ? "interrupted" : outcome)
      live.subagents.delete(child)
      live.background.delete(child)
    }
    // The agent that ended the turn knows how it ended: that's not news to hand it later.
    if (run.last && run.last.seen === before) run.last.seen = record.messages[record.messages.length - 1]?.id
    this.settleAsks(id, live)
    // Deleted meanwhile: nothing more for it.
    if (runOf(live.doing) !== run) return
    // What the turn changed (the session waits for it, as for its turn), from your message and
    // from each you sent partway.
    const turnNotes = [note, ...run.steered].filter((kept): kept is SnapshotNote => Boolean(kept?.before))
    if (turnNotes.length && this.snapshots) {
      const keeping: Doing = { kind: "keeping" }
      live.doing = keeping
      try {
        const after = await this.snapshots.take(directory)
        if (!after) throw new Error("not kept")
        for (const kept of turnNotes) kept.files = await this.snapshots.changed(directory, kept.before!, after)
      } catch {
        for (const kept of turnNotes) if (!kept.files) kept.failed = true
      }
      if (this.store.get(id)) this.store.save(id)
      if (live.doing !== keeping) return
    }
    this.free(id, live, outcome)
  }

  /** A while after its last turn, a session's agents stop running: they go on where they left off next time. */
  private closeWhenIdle(id: string, live: Live) {
    clearTimeout(live.idle)
    live.idle = setTimeout(() => {
      if (live.doing.kind !== "idle" || this.live.get(id) !== live) return
      // Commands it left running would end with it: later.
      if ([...live.threads.values()].some((thread) => thread.keepsWorking)) return this.closeWhenIdle(id, live)
      for (const thread of live.threads.values()) thread.close()
      live.threads.clear()
    }, timing.idleClose)
  }

  /**
   * An agent began a turn of its own (a command it left running ended, and it carries on): a turn
   * here takes it, saying what began it, unless another runs now or an undo waits (it would make
   * the undo final), when it's turned away.
   */
  private ownTurn(id: string, provider: string, note: OwnTurn): boolean {
    const record = this.store.get(id)
    const live = this.live.get(id)
    const model = live?.models.get(provider)
    if (!record || !live || !model || record.session.revert || live.own) return false
    const doing = live.doing
    // Taken: now, when nothing runs; or once the files are kept or put back, or the turn ending
    // ends (a turn still running on this same agent is one it has finished: it begins its own
    // only then). Not while another agent works, after Stop, or as the session is deleted.
    const now = doing.kind === "idle"
    const later = onFiles(doing) || (doing.kind === "running" && doing.run.agent?.provider === provider)
    if (!now && !later) return false
    live.own = { id: newID("msg"), text: note.text, files: [], delivery: "steer", synthetic: { description: note.description, metadata: note.metadata }, adopt: model }
    this.advance(id, live)
    return true
  }

  /** The message on one agent's model, with what that agent hasn't seen of the conversation. */
  private async runOn(id: string, record: Record_, live: Live, run: Run, model: ModelRef, input: RunInput, userMessage: string): Promise<RunResult> {
    const { turn } = run
    const signal = run.abort.signal
    // A turn its agent began on its own, stopped before it was taken: it stops there too.
    let reached = false
    const turnAway = () => {
      if (input.adopt && !reached) live.threads.get(model.providerID)?.turnAway?.()
    }
    const agent = this.agent(model.providerID)
    if (!agent) {
      turnAway()
      return { outcome: "failed", error: { type: "agent", message: "This model's agent isn't available: sign in to it in Settings › Accounts, or pick another model." } }
    }
    // Its account signed out of, where a request on it would be dropped without a word: said.
    if (!input.adopt && (await Promise.race([agent.signedOut?.().catch(() => false), Bun.sleep(10_000).then(() => false)]))) {
      turnAway()
      const machine = onMachine ? process.env.KUVO_MACHINE_NAME || "this machine" : undefined
      const message = machine
        ? `${agent.name} isn't signed in on ${machine}, where this conversation runs (each machine signs in on its own). Sign in to it there in Settings › Accounts, with ${machine} picked, or pick another model.`
        : `${agent.name} isn't signed in. Sign in to it in Settings › Accounts, or pick another model.`
      return { outcome: "failed", error: { type: "provider.auth", message } }
    }
    if (signal.aborted) {
      turnAway()
      return { outcome: "interrupted" }
    }
    const slots = this.slots(record)
    const slot = (slots[model.providerID] ??= { state: {} })
    let thread = live.threads.get(model.providerID)
    if (!thread) {
      thread = agent.thread(record.session, slot.state)
      const provider = model.providerID
      thread.onOwnTurn = (note) => this.ownTurn(id, provider, note)
      live.threads.set(model.providerID, thread)
    }
    live.models.set(model.providerID, model)
    const hooks = this.hooks(id, live, turn, signal, slot, input.plan)
    turn.setModel(model)
    // Given up on (it didn't stop when asked): the turn ends without it.
    let abandon!: () => void
    const abandoned = new Promise<RunResult>((resolve) => (abandon = () => resolve({ outcome: "interrupted" })))
    const working = { provider: model.providerID, thread, abandon }
    run.agent = working
    const from = record.messages.length
    try {
      // Its conversation, ready (Stop gives up on it as on a run): one it had that couldn't be
      // picked up again starts over, and is handed all that came before. (Not for a turn it
      // began on its own: it's at work already, and getting it ready could start it over.)
      if (thread.prepare && !input.adopt) {
        const prepared = await Promise.race([thread.prepare({ ...input, model }, hooks), abandoned.then(() => "abandoned" as const)])
        if (prepared === "abandoned") return { outcome: "interrupted" }
        if (prepared?.fresh) slot.seen = undefined
      }
      if (signal.aborted) return { outcome: "interrupted" }
      // What it hasn't seen: what came before your message since it last ran here, and what
      // another agent did on this message before handing it over.
      const at = record.messages.findIndex((message) => message.id === userMessage)
      const seenAt = slot.seen ? record.messages.findIndex((message) => message.id === slot.seen) : -1
      // It has your message already (Auto went on with another of its models): it carries on from
      // what it hasn't seen since, rather than getting the message again.
      const hasMessage = at >= 0 && seenAt >= at
      // Commands you ran while it (or another) worked come along, though it was there for them.
      const late = new Set((record.agent.lateShells as string[] | undefined) ?? [])
      const before = hasMessage ? [] : record.messages.slice(0, at < 0 ? undefined : at).filter((message, index) => index > seenAt || late.has(message.id))
      // (A turn it began on its own is told nothing: what it missed waits for its next message.)
      const missed = Boolean(input.adopt && (before.length || late.size))
      if (!hasMessage && late.size && !input.adopt) delete record.agent.lateShells
      const partway = at < 0 ? [] : record.messages.slice(Math.max(at, seenAt) + 1)
      const handed = handover(before, partway, (message) => this.stepName(message))
      const text = withHandover(hasMessage ? carryOn : input.text, handed)
      const files = hasMessage ? [] : input.files
      reached = true
      const result = await Promise.race([thread.run({ ...input, model, text, files }, turn, hooks), abandoned])
      // It has seen all of it now, its own replies too; but one that failed with nothing done
      // couldn't take your message (its model is gone, it was turned away), and doesn't count as
      // having it: the next time, it or another model of its agent gets it.
      if (!missed && (result.outcome !== "failed" || result.taken || record.messages.slice(from).some(didWork))) slot.seen = record.messages[record.messages.length - 1]?.id
      // A message you sent partway that it never got to: it's handed that, and what came after, next time.
      const missedAt = result.missed?.length ? record.messages.findIndex((message) => result.missed!.includes(message.id)) : -1
      if (missedAt >= 0) slot.seen = record.messages[missedAt - 1]?.id
      run.last = slot
      return result
    } catch (error) {
      // A broken conversation starts over with the next message (the agent's own may resume, and
      // what it missed goes to it as a handover).
      thread.close()
      if (live.threads.get(model.providerID) === thread) live.threads.delete(model.providerID)
      throw error
    } finally {
      turnAway()
      if (run.agent === working) run.agent = undefined
      this.store.save(id, true)
    }
  }

  /** The message on the first model of your Auto list that isn't at a limit, and on down it while they reach theirs. */
  private async runAuto(id: string, record: Record_, live: Live, run: Run, input: RunInput, userMessage: string): Promise<RunResult> {
    // Held back at a limit when this session's last message on Auto ended: one that runs this
    // one is back (its limit reset), and the session says so.
    const heldBefore = new Set(Array.isArray(record.agent.autoHeld) ? (record.agent.autoHeld as string[]) : [])
    try {
      return await this.runAutoList(id, record, live, run, input, userMessage, heldBefore)
    } finally {
      record.agent.autoHeld = this.auto
        .list(input.model.id)
        .filter((entry) => this.auto.isHeld(entry))
        .map((entry) => Auto.modelKey(entry))
      this.store.save(id)
    }
  }

  private async runAutoList(id: string, record: Record_, live: Live, run: Run, input: RunInput, userMessage: string, heldBefore: Set<string>): Promise<RunResult> {
    const { turn } = run
    const signal = run.abort.signal
    const tried = new Set<string>()
    let last: RunResult | undefined
    let note: string | undefined
    // Subagents at work before the model that just stopped began (sent off in the background by
    // an earlier turn): they go on; that model's own stop with it.
    let earlier = new Set<string>()
    for (;;) {
      if (signal.aborted) return { outcome: "interrupted" }
      const entry = await this.nextEntry(tried, input.model.id)
      if (signal.aborted) return { outcome: "interrupted" }
      if (!entry) {
        if (note) turn.notice(note)
        // Why the rest can't run, each in its words; none left untried: how the last one ended.
        const stopped = await this.whyNone(tried, input.model.id)
        if (stopped) return { outcome: "failed", error: stopped }
        if (last?.limit) return { outcome: "failed", error: { type: "limit", message: `Every model in your Custom Auto list is at a usage limit for now${this.nextReset()}.` } }
        return last ?? { outcome: "failed", error: { type: "limit", message: `Your Custom Auto list has no model to run. Edit it in Settings › Custom Auto.` } }
      }
      if (!tried.size && heldBefore.has(Auto.modelKey(entry))) turn.notice(`Back on ${this.entryName(entry)}: its limit has reset.`)
      tried.add(Auto.modelKey(entry))
      const model: ModelRef = { providerID: entry.providerID, id: entry.modelID, ...(entry.variant ? { variant: entry.variant } : {}) }
      if (note) {
        turn.stopTools("Stopped: going on with another model.")
        for (const [child, childTurn] of [...live.subagents]) {
          if (earlier.has(child)) continue
          const subagent = live.runs.get(child)
          if (subagent && !childTurn.isEnded) void subagent.stop?.().catch(() => {})
          if (subagent?.turn === childTurn) subagent.end("interrupted")
          else childTurn.finish("interrupted")
          live.subagents.delete(child)
          live.background.delete(child)
        }
        turn.notice(`${note} Going on with ${this.entryName(entry)}.`)
      }
      earlier = new Set(live.subagents.keys())
      const from = record.messages.length
      try {
        last = await this.runOn(id, record, live, run, model, input, userMessage)
      } catch (error) {
        // It couldn't start or went wrong (its process, its sign-in): as a model that failed.
        if (signal.aborted) throw error
        last = { outcome: "failed", error: failure(error) }
      }
      if (last.outcome !== "failed" || signal.aborted) return last
      if (!last.limit) {
        // An error (its sign-in ended, its model is gone, it crashed): the next model carries on,
        // as at a limit, from what this one did, which the handover tells it (what was under way
        // was stopped). A sign-in that ended holds back that account's every model until you
        // sign in again (`nextEntry` skips it).
        const agent = this.agent(entry.providerID)
        const account = agent ? await Promise.race([agent.account(true).catch(() => undefined), Bun.sleep(10_000).then(() => undefined)]) : undefined
        if (account && !account.signedIn) emit("integration.updated", { integrationID: entry.providerID })
        const message = last.error?.message?.trim() || "it stopped with an error"
        note = account && !account.signedIn ? `${this.entryName(entry, true)} needs you to sign in again.` : `${this.entryName(entry)} stopped: ${message.replace(/\.$/, "")}.`
        continue
      }
      this.auto.hold(entry, last.limit)
      emit("kuvo.auto.updated", {})
      const whole = last.limit.scope === "provider"
      note = `${this.entryName(entry, whole)} reached ${whole ? "its usage limit" : "this model's limit"}${last.limit.resetsAt ? ` (it resets at ${resetTime(last.limit.resetsAt)})` : ""}.`
    }
  }

  /** The first entry of the Auto list `list` not at a limit, not tried for this message, and signed in. */
  private async nextEntry(tried: Set<string>, list: string): Promise<AutoEntry | undefined> {
    for (const entry of this.auto.list(list)) {
      if (tried.has(Auto.modelKey(entry))) continue
      if (!(await this.whyNot(entry))) return entry
    }
    return undefined
  }

  /** Why an entry can't run now: at a limit, its agent signed out (or not here), its model gone. */
  private async whyNot(entry: AutoEntry): Promise<{ kind: "held"; until: number; whole: boolean } | { kind: "signedOut" | "missing" } | undefined> {
    const held = this.auto.isHeld(entry)
    if (held) return { kind: "held", until: held.until, whole: held.scope === "provider" }
    const agent = this.agent(entry.providerID)
    if (!agent) return { kind: "missing" }
    // Signed out: skipped (an agent slow to say is tried anyway).
    const account = await Promise.race([agent.account().catch(() => undefined), Bun.sleep(10_000).then(() => undefined)])
    if (account && !account.signedIn) return { kind: "signedOut" }
    // A model the engine doesn't offer now (its provider was disconnected): skipped.
    if (agent.id === "engine") {
      const models = await agent.models().catch(() => [])
      if (models.length && !models.some((model) => model.id === entry.modelID)) return { kind: "missing" }
    }
    return undefined
  }

  /**
   * Why no model of the list (none left untried) can take this message, as you'd fix it: the
   * agents to sign in to (here, or on this machine), the limits and when they reset, the models
   * that are gone. Undefined when every one was tried.
   */
  private async whyNone(tried: Set<string>, list: string): Promise<StructuredError | undefined> {
    const signIn = new Set<string>()
    const held = new Map<string, number>()
    const gone: string[] = []
    for (const entry of this.auto.list(list)) {
      if (tried.has(Auto.modelKey(entry))) continue
      const why = await this.whyNot(entry)
      if (!why) continue
      if (why.kind === "signedOut") signIn.add(this.entryName(entry, true))
      else if (why.kind === "held") held.set(this.entryName(entry, why.whole), why.until)
      else gone.push(this.entryName(entry))
    }
    if (!signIn.size && !held.size && !gone.length) return undefined
    // On a machine, which (by the name you know it by), and that your Mac's sign-ins don't reach it.
    const machine = onMachine ? process.env.KUVO_MACHINE_NAME || "this machine" : undefined
    const where = machine ? ` on ${machine}` : ""
    const signInPage = machine ? `Settings › Accounts, with ${machine} picked` : "Settings › Accounts"
    const agents = [...signIn].join(", ").replace(/, ([^,]*)$/, " and $1")
    // Only sign-ins in the way: what to sign in to, and where.
    if (!held.size && !gone.length) {
      const subject = `${tried.size ? "The rest of the agents" : "None of the agents"} in your Custom Auto list ${tried.size ? "aren't" : "is"} signed in`
      if (!machine) return { type: "signin", message: `${subject}. Sign in to ${agents} in ${signInPage}.` }
      return { type: "signin", message: `${subject}${where}, where this conversation runs (each machine signs in on its own: your Mac's sign-ins don't reach it). Sign in to ${agents} there in ${signInPage}.` }
    }
    const limits = [...held].map(([name, until]) => `${name} until ${resetTime(until)}`).join("; ")
    if (!signIn.size && !gone.length && !tried.size) return { type: "limit", message: `Every model in your Custom Auto list is at a usage limit for now: ${limits}.` }
    const reasons = [
      ...(held.size ? [`at a usage limit: ${limits}`] : []),
      ...(signIn.size ? [`not signed in${where}: ${agents} (sign in in ${signInPage})`] : []),
      ...(gone.length ? [`not available now: ${gone.join(", ")}`] : []),
    ]
    return { type: signIn.size ? "signin" : "limit", message: `No ${tried.size ? "other " : ""}model in your Custom Auto list can run now. ${reasons.map((reason) => reason[0]!.toUpperCase() + reason.slice(1)).join(". ")}.` }
  }

  private nextReset(): string {
    const known = this.auto.limits().filter((limit) => limit.known).map((limit) => limit.until)
    return known.length ? `; the first resets at ${resetTime(Math.min(...known))}` : ""
  }

  /** "Claude Code (opus, high)", or the agent alone. */
  private entryName(entry: AutoEntry, agentOnly = false): string {
    const name = this.agent(entry.providerID)?.name ?? entry.providerID
    return agentOnly ? name : `${name} (${entry.modelID}${entry.variant ? `, ${entry.variant}` : ""})`
  }

  /** Who wrote a step, for a handover: the agent and model. */
  private stepName(message: AssistantMessage): string {
    const agent = this.agent(message.model.providerID)
    return `${agent?.name ?? message.model.providerID}, ${message.model.id}`
  }

  /**
   * Stops the turn under way. With `resume`, the message you steered goes next (Send Now);
   * without, nothing waiting starts until the app says. Idle, `resume` starts it at once. A turn
   * an agent began on its own that's waiting to be taken stops too.
   */
  async interrupt(id: string, resume = false) {
    const live = this.live.get(id)
    const turnedAway = this.turnAwayOwn(live)
    const run = live && runOf(live.doing)
    if (live && run) {
      live.doing = { kind: "stopping", run }
      live.go = resume
      await this.stop(id, live, run)
      return true
    }
    // (Asked to start what waits: subagents at work in the background go on.)
    if (resume) {
      this.wake(id)
      return false
    }
    return (await this.stopSubagents(id)) || turnedAway
  }

  /** Stops a turn: what it asks goes, and an agent that doesn't stop has its conversation closed, the turn ending without it. */
  private async stop(id: string, live: Live, run: Run) {
    run.abort.abort()
    this.settleAsks(id, live)
    const agent = run.agent
    setTimeout(() => {
      if (run.turn.isEnded || !agent || run.agent !== agent) return
      agent.thread.close()
      if (live.threads.get(agent.provider) === agent.thread) live.threads.delete(agent.provider)
      agent.abandon()
    }, timing.stopGrace)
    await agent?.thread.interrupt().catch(() => {})
  }

  /** Whatever's still asked of you goes once the turn is over. */
  private settleAsks(id: string, live: Live) {
    const directory = this.store.get(id)?.session.location.directory
    for (const [requestID, pending] of live.permissions) {
      // A subagent at work in the background still waits for its answer.
      if (pending.turn && !pending.turn.isEnded && [...live.subagents.values()].includes(pending.turn)) continue
      pending.resolve("reject")
      emit("permission.replied", { sessionID: id, requestID }, directory)
    }
    for (const [requestID, pending] of [...live.permissions]) if (!pending.turn || pending.turn.isEnded || ![...live.subagents.values()].includes(pending.turn)) live.permissions.delete(requestID)
    for (const [formID, pending] of live.forms) {
      pending.resolve(null)
      emit("form.cancelled", { id: formID, sessionID: id }, directory)
    }
    live.forms.clear()
  }

  // MARK: What the agent asks

  private hooks(id: string, live: Live, turn: Turn, signal: AbortSignal, slot: Slot, plan: boolean): TurnHooks {
    const record = this.record(id)
    return {
      signal,
      state: slot.state,
      saveState: () => this.store.save(id, true),
      instructions: (withAgent = true) =>
        [
          ...Object.values((record.agent.kuvoInstructions as Record<string, string> | undefined) ?? {}),
          withAgent && live.agentPrompt ? `You work as the "${record.session.agent}" agent here. Its instructions:\n\n${live.agentPrompt}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      // Nothing to ask, and nothing refused: an agent may run its tools on its own. With a
      // rule or a block that refuses something (or Blocks not known), or in plan mode, it asks
      // here, and they answer.
      // An agent that can't ask (Cursor) still keeps to known Blocks; only ones not known yet
      // don't hold it back.
      approvesAll: (canAsk = true) => {
        if (plan) return false
        if ((record.session.permissions ?? []).some((rule) => rule.effect === "ask" || rule.effect === "deny")) return false
        const isDefault = (rule: PermissionRule) => engineDefaults.some((other) => other.action === rule.action && other.resource === rule.resource && other.effect === rule.effect)
        if ((live.agentRules ?? []).some((rule) => rule.effect !== "allow" && agentActions.has(rule.action) && !isDefault(rule))) return false
        if (live.blocks === undefined) return !canAsk
        return !live.blocks.some((rule) => rule.effect === "deny")
      },
      check: (ask, ownPlan) => this.checkPermission(live, record.session, ask, plan && !ownPlan),
      permission: (ask) => this.askPermission(id, live, turn, ask, plan),
      question: (ask) => this.askQuestion(id, live, turn, ask),
      subagent: (toolCallID, task) => this.startSubagent(id, live, turn, toolCallID, task, plan),
    }
  }

  /** A subagent's session under `id`, for its tool call there: what it's told, and its turn. */
  private startSubagent(id: string, live: Live, parentTurn: Turn, toolCallID: string, task: SubagentTask, plan = false): SubagentRun {
    const parent = this.record(id).session
    const directory = parent.location.directory
    const now = Date.now()
    const model = parentTurn.currentModel
    const before = task.sessionID ? this.store.get(task.sessionID) : undefined
    if (before && before.session.parentID === id) {
      // The same subagent, given more to do: its session goes on.
      if (task.prompt) before.messages.push({ type: "user", id: newID("msg"), time: { created: now }, text: task.prompt })
      before.session.time.updated = now
      this.store.save(before.session.id, true)
      return this.subagentRun(id, live, parentTurn, toolCallID, before.session, task.background ?? false, plan)
    }
    const session: Session = {
      id: newID("ses"),
      parentID: id,
      projectID: parent.projectID,
      agent: task.agent ?? parent.agent,
      model,
      cost: 0,
      tokens: noTokens(),
      time: { created: now, updated: now },
      title: task.title || "A subagent's task",
      location: { directory },
      metadata: { kuvoAgent: parent.metadata?.kuvoAgent, kuvoSubagent: true },
    }
    this.store.add(session)
    const record = this.store.get(session.id)!
    if (task.prompt) record.messages.push({ type: "user", id: newID("msg"), time: { created: now }, text: task.prompt })
    this.store.save(session.id, true)
    emit("session.created", { sessionID: session.id, session }, directory)
    return this.subagentRun(id, live, parentTurn, toolCallID, session, task.background ?? false, plan)
  }

  private subagentRun(id: string, live: Live, parentTurn: Turn, toolCallID: string, session: Session, background: boolean, plan: boolean): SubagentRun {
    live.subagents.get(session.id)?.finish("succeeded")
    const turn = new Turn(this.store, session.id, session.location.directory, parentTurn.currentModel, session.agent ?? "build")
    live.subagents.set(session.id, turn)
    if (background) live.background.add(session.id)
    else live.background.delete(session.id)
    // Its step in the conversation that started it says which session it is.
    parentTurn.toolProgress(toolCallID, { sessionID: session.id })
    const run: SubagentRun = {
      sessionID: session.id,
      turn,
      end: (outcome, error) => {
        turn.finish(outcome, error)
        if (live.subagents.get(session.id) === turn) {
          live.subagents.delete(session.id)
          live.background.delete(session.id)
        }
        if (live.runs.get(session.id) === run) live.runs.delete(session.id)
        // What it asked and nobody answered goes with it.
        const directory = this.store.get(id)?.session.location.directory
        for (const [requestID, pending] of [...live.permissions]) {
          if (pending.turn !== turn) continue
          live.permissions.delete(requestID)
          pending.resolve("reject")
          emit("permission.replied", { sessionID: id, requestID }, directory)
        }
      },
      // Asked in the conversation that started it, while it works.
      permission: (ask) => this.askPermission(id, live, turn, ask, plan),
    }
    live.runs.set(session.id, run)
    return run
  }

  /**
   * Stop with no turn under way: in a subagent's session, its agent stops it; in a session whose
   * subagents went on in the background, those stop. False when there was nothing to stop.
   */
  private async stopSubagents(id: string): Promise<boolean> {
    const parent = this.store.get(id)?.session.parentID
    const runs = parent ? [this.live.get(parent)?.runs.get(id)] : [...(this.live.get(id)?.runs.values() ?? [])]
    const going = runs.filter((run): run is SubagentRun => Boolean(run && !run.turn.isEnded))
    for (const run of going) {
      // One its agent can't stop ends here; one that doesn't say it stopped, a moment later.
      if (!run.stop) {
        run.end("interrupted")
        continue
      }
      setTimeout(() => {
        if (!run.turn.isEnded) run.end("interrupted")
      }, timing.stopGrace)
      await run.stop().catch(() => {})
    }
    return going.length > 0
  }

  /** What Blocks and rules say of an action without asking you: refused, or to ask first. */
  private checkPermission(live: Live, session: Session, ask: PermissionAsk, plan: boolean): "deny" | "ask" | undefined {
    const parts = partsOf(ask)
    if (live.blocks && strictest(live.blocks, ask.action, parts) === "deny") return "deny"
    if (plan && changes.has(ask.action)) return "deny"
    const rules = [...(live.agentRules ?? engineDefaults), ...(session.permissions ?? [])]
    const effect = strictest(rules, ask.action, parts)
    if (effect === "deny") return "deny"
    // Paths outside the project: your rules for working there too.
    const away = outsidePaths(ask, session.location.directory, this.attached(session.id))
    if (away.length) {
      if (live.blocks && strictest(live.blocks, "external_directory", away) === "deny") return "deny"
      const outside = strictest(rules, "external_directory", away)
      if (outside === "deny") return "deny"
      if (outside === "ask" && !this.allowedBefore(live, outsideAsk(ask, away))) return "ask"
    }
    // Blocks not known (the engine didn't answer): asked, which reads them again.
    if (live.blocks === undefined && !looks.has(ask.action)) return "ask"
    if (hidesFromBlocks(live.blocks, ask)) return "ask"
    return effect === "ask" && !this.allowedBefore(live, ask) ? "ask" : undefined
  }

  /** The files attached to a conversation's messages, by path. */
  private attached(id: string): Set<string> {
    const paths = new Set<string>()
    for (const message of this.store.get(id)?.messages ?? []) {
      if (message.type !== "user") continue
      for (const file of message.files ?? []) {
        const uri = file.source?.type === "uri" ? file.source.uri : undefined
        if (uri?.startsWith("file:")) {
          try {
            paths.add(fileURLToPath(uri))
          } catch {}
        } else if (uri?.startsWith("/")) paths.add(uri)
      }
    }
    return paths
  }

  private allowedBefore(live: Live, ask: PermissionAsk): boolean {
    return live.always.some((rule) => rule.action === ask.action && coveredBy(rule.patterns, ask.action, ask.resources))
  }

  private async askPermission(id: string, live: Live, turn: Turn, ask: PermissionAsk, plan: boolean): Promise<Decision> {
    const session = this.record(id).session
    const parts = partsOf(ask)
    // Blocks not known yet (the engine was slow, or restarting): read again, and asked about if
    // they still aren't.
    if (live.blocks === undefined && this.policies) {
      const blocks = await this.policies(session.location.directory).catch(() => undefined)
      if (blocks !== undefined) live.blocks = blocks
    }
    const unknown = live.blocks === undefined && !looks.has(ask.action)
    // Blocks win over everything, approvals included; each command of a command line counts.
    if (live.blocks && strictest(live.blocks, ask.action, parts) === "deny") return "reject"
    if (plan && changes.has(ask.action)) return "reject"
    // Paths outside the project (the engine weighs its own asks): your rules for working there
    // too. One that asks, where the action itself doesn't, is asked as that.
    const away = ask.weighed ? [] : outsidePaths(ask, session.location.directory, this.attached(id))
    if (away.length) {
      if (live.blocks && strictest(live.blocks, "external_directory", away) === "deny") return "reject"
      const rules = [...(live.agentRules ?? engineDefaults), ...(session.permissions ?? [])]
      const outside = strictest(rules, "external_directory", away)
      if (outside === "deny") return "reject"
      const own = strictest(rules, ask.action, parts) ?? "allow"
      if (outside === "ask" && own !== "deny" && (own === "allow" || this.allowedBefore(live, ask)) && !this.allowedBefore(live, outsideAsk(ask, away))) {
        return this.askPermission(id, live, turn, { ...outsideAsk(ask, away), metadata: ask.metadata, message: ask.message }, plan)
      }
    }
    // The engine's asks were weighed by it already: without a rule of yours, they're yours to
    // answer. Others go by the session's agent's permissions as the engine has them (its own
    // defaults, reading a .env file asks first), with the session's rules over them.
    const matched = ask.weighed
      ? strictest(session.permissions ?? [], ask.action, parts)
      : strictest([...(live.agentRules ?? engineDefaults), ...(session.permissions ?? [])], ask.action, parts)
    const effect = ask.weighed ? matched : (matched ?? "allow")
    if (effect === "deny") return "reject"
    // What the agent asked about, not known by its kind and no rule of yours about it, under Ask
    // First: you answer it, unless you allowed it in this session before.
    const unclassified = ask.unclassified && matched === undefined && asksFirst(session.permissions) && !this.allowedBefore(live, ask)
    if (!unknown && !unclassified && !hidesFromBlocks(live.blocks, ask) && (effect === "allow" || this.allowedBefore(live, ask))) return "once"
    if (turn.isEnded || stopping(live.doing)) return "reject"
    const request: PermissionRequest = {
      id: newID("per"),
      sessionID: id,
      action: ask.action,
      resources: ask.resources,
      save: ask.save ?? ask.resources,
      metadata: ask.metadata,
      message: ask.message,
    }
    const step = ask.toolCallID ? turn.toolStep(ask.toolCallID) : undefined
    if (ask.toolCallID && step) request.source = { type: "tool", messageID: step, id: ask.toolCallID }
    return new Promise<Decision>((resolve) => {
      live.permissions.set(request.id, {
        request,
        turn,
        resolve: (decision) => {
          if (decision === "always") live.always.push({ action: ask.action, patterns: request.save ?? ask.resources })
          resolve(decision)
        },
      })
      emit("permission.asked", request as unknown as Record<string, unknown>, session.location.directory)
      // Settled by the agent itself: the card goes.
      ask.signal?.addEventListener("abort", () => {
        if (!live.permissions.delete(request.id)) return
        resolve("reject")
        emit("permission.replied", { sessionID: id, requestID: request.id }, session.location.directory)
      })
    })
  }

  permissions(id: string): PermissionRequest[] {
    this.record(id)
    return [...(this.live.get(id)?.permissions.values() ?? [])].map((pending) => pending.request)
  }

  replyPermission(id: string, requestID: string, decision: Decision) {
    const live = this.live.get(id)
    const pending = live?.permissions.get(requestID)
    if (!live || !pending) throw new NotFound("That request was answered already.")
    if (!["once", "always", "reject"].includes(decision)) throw new BadRequest("Answer once, always or reject.")
    const directory = this.record(id).session.location.directory
    live.permissions.delete(requestID)
    pending.resolve(decision)
    emit("permission.replied", { sessionID: id, requestID }, directory)
    // "Always": what else waits on the same thing goes too, as the engine does.
    if (decision !== "always") return
    const patterns = pending.request.save ?? pending.request.resources
    for (const [otherID, other] of [...live.permissions]) {
      const covered = other.request.action === pending.request.action && coveredBy(patterns, other.request.action, other.request.resources)
      if (!covered) continue
      live.permissions.delete(otherID)
      other.resolve("once")
      emit("permission.replied", { sessionID: id, requestID: otherID }, directory)
    }
  }

  private askQuestion(id: string, live: Live, turn: Turn, ask: QuestionAsk): Promise<FormAnswer | null> {
    const session = this.record(id).session
    if (turn.isEnded || stopping(live.doing)) return Promise.resolve(null)
    const form: FormRequest = { id: newID("frm"), sessionID: id, title: ask.title, metadata: { kind: "question" }, fields: ask.fields }
    return new Promise((resolve) => {
      live.forms.set(form.id, { form, resolve })
      emit("form.created", { form }, session.location.directory)
      ask.signal?.addEventListener("abort", () => {
        if (!live.forms.delete(form.id)) return
        resolve(null)
        emit("form.cancelled", { id: form.id, sessionID: id }, session.location.directory)
      })
    })
  }

  forms(id: string): FormRequest[] {
    this.record(id)
    return [...(this.live.get(id)?.forms.values() ?? [])].map((pending) => pending.form)
  }

  replyForm(id: string, formID: string, answer: FormAnswer | null) {
    const live = this.live.get(id)
    const pending = live?.forms.get(formID)
    if (!live || !pending) throw new NotFound("That question was answered already.")
    live.forms.delete(formID)
    pending.resolve(answer)
    emit(answer ? "form.replied" : "form.cancelled", { id: formID, sessionID: id }, this.record(id).session.location.directory)
  }

  /** The bridge is stopping: every turn ends as stopped, and every agent's conversation closes. */
  closeAll() {
    for (const [id, live] of this.live) {
      live.go = false
      live.own = undefined
      const run = runOf(live.doing)
      run?.abort.abort()
      this.settleAsks(id, live)
      run?.turn.finish("interrupted")
      for (const child of live.subagents.values()) child.finish("interrupted")
      live.subagents.clear()
      for (const thread of live.threads.values()) thread.close()
    }
  }

  /** An account went: its conversations in sessions close (their sessions go on with another model). */
  forgetProvider(providerID: string) {
    for (const live of this.live.values()) {
      const thread = live.threads.get(providerID)
      if (!thread) continue
      thread.close()
      live.threads.delete(providerID)
    }
  }
}

export class NotFound extends Error {}
export class BadRequest extends Error {}

function mime(uri: string): string {
  if (uri.startsWith("data:")) return uri.slice(5).split(/[;,]/)[0] || "text/plain"
  const extension = uri.split("?")[0].split(".").pop()?.toLowerCase() ?? ""
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      heic: "image/heic",
      pdf: "application/pdf",
      txt: "text/plain",
      md: "text/markdown",
      json: "application/json",
    } as Record<string, string>
  )[extension] ?? "application/octet-stream"
}

/** How much of a text file you attach goes in the message. */
const textFileLimit = 200_000

/** Text files you attached, in the message (as the engine puts them), and the other files. */
export function withTextFiles(text: string, files: PromptFile[]): { text: string; files: PromptFile[] } {
  const others: PromptFile[] = []
  const parts: string[] = []
  for (const file of files) {
    let contents: string | undefined
    if (!file.mime.startsWith("image/") && file.mime !== "application/pdf") {
      try {
        const bytes = file.data ? Buffer.from(file.data, "base64") : file.path && statSync(file.path).isFile() && statSync(file.path).size <= textFileLimit ? readFileSync(file.path) : undefined
        // Text, not something binary that happens to be small.
        if (bytes && !bytes.includes(0)) contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {}
    }
    if (contents === undefined) {
      others.push(file)
      continue
    }
    parts.push(`<file path="${file.path ?? file.name ?? "pasted"}">\n${contents}\n</file>`)
  }
  return { text: parts.length ? `${text}\n\n${parts.join("\n\n")}` : text, files: others }
}

function promptFile(file: { uri: string; name?: string }): PromptFile {
  const type = mime(file.uri)
  if (file.uri.startsWith("data:")) {
    const comma = file.uri.indexOf(",")
    const isBase64 = file.uri.slice(0, comma).endsWith(";base64")
    const payload = file.uri.slice(comma + 1)
    return { uri: file.uri, mime: type, name: file.name, data: isBase64 ? payload : Buffer.from(decodeURIComponent(payload)).toString("base64") }
  }
  let path: string | undefined
  try {
    path = file.uri.startsWith("file:") ? fileURLToPath(file.uri) : undefined
  } catch {}
  return { uri: file.uri, mime: type, name: file.name, path }
}

/**
 * Your words in a message, without the blocks the app adds at its end (the agents you named with
 * "&", your comments on the changes, the note of attached files), as the app's SentMessage reads it.
 */
export function ownWords(message: string): string {
  let text = message.trimEnd()
  for (;;) {
    const tag = ["attached-files", "review-comments", "named-agents"].find((name) => text.endsWith(`\n</${name}>`))
    if (!tag) return text
    const open = text.lastIndexOf(`<${tag}>\n`, text.length - tag.length - 4)
    if (open < 0 || (open > 0 && text[open - 1] !== "\n")) return text
    text = text.slice(0, open).trimEnd()
  }
}
