// A command an agent needs outside the sandbox (PROTOCOL.md, "Sandbox", "Asks"): its `sandbox_ask`,
// which both tool servers (this Mac's app, a machine's kuvo-browser.js) pass here as it is. You're
// asked on any client, with what the sandbox stopped; Allow Once and Always for This have the box
// run that one command itself, outside the sandbox, in the conversation's folder, and hand its
// output back. Always also lets the project's commands write, in the sandbox, the one folder this
// one was stopped writing in (fence/allowed.ts); a command itself is never let out for good, and
// is asked about each time. The agent never lets a command out of the sandbox itself, and no tool
// answers an ask: only a client.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { SandboxAsk, SandboxStop } from "../../shared/routes/sandbox";
import { cut, oneLine } from "../../shared/text";
import { IS_MAC } from "../home";
import { askBook } from "../notices/asking";
import type { Notice } from "../notices/notice";
import { commandEnv, runCommand } from "../run-command";
import type { Caller } from "../vault/who";
import { addRule, ownerOf, writeRuleWouldBe } from "./allowed";

/** Your answer, and who gave it: "Mac", or a phone's name. */
export interface SandboxAnswer {
  answer: "once" | "always" | "no";
  client?: string;
  /** Nobody answered in time (or the agent stopped waiting): not your no. */
  unanswered?: boolean;
}

const book = askBook<SandboxAsk, SandboxAnswer>("sq_", { answer: "no", unanswered: true });
export const listSandboxAsks = book.list;
export const onSandboxAsksChanged = book.onChanged;
export const answerSandboxAsk = book.answer;

export const SANDBOX_TOOLS = [
  {
    name: "sandbox_ask",
    description: "Ask the user to run a command outside the sandbox, when the sandbox stopped one the task needs (\"Operation not permitted\" or \"Permission denied\" outside the folders you may write, or a refused connection or app). They see the command, why, and what was refused, and allow it once or say no; where it was stopped writing in one folder, they can also let your commands write there from now on. Allowed, Kuvo Code runs it for you outside the sandbox, in your project's folder, and you get its output. Waits for their answer. Don't use it to get around a rule you were told, and never for a command you haven't tried in the sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command, exactly as you ran it." },
        why: { type: "string", description: "Why the task needs it, in one sentence the user reads." },
        error: { type: "string", description: "What the command printed when the sandbox stopped it." },
        timeout: { type: "number", description: "How long it may run once allowed, in seconds (300 unless you say; at most 600)." },
      },
      required: ["command", "why"],
      additionalProperties: false,
    },
  },
] as const;

export const SANDBOX_TOOL_NAMES: readonly string[] = SANDBOX_TOOLS.map(tool => tool.name);

/** What a tool answers: words for the agent, and whether it failed. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
}

const MOST_OUTPUT = 64 * 1024;
// What a call may take, the asking included: a little under the tool servers' 16 minutes.
const CALL_BUDGET = 15.5 * 60_000;
const MOST_STOPS = 20;

const KINDS: [RegExp, SandboxStop["kind"]][] = [
  [/^file-write/, "write"], [/^file-read/, "read"], [/^network-/, "connect"], [/^job-creation/, "job"],
  [/^(appleevent-send|mach-lookup)/, "app"],
];

/** The launcher's sum of a command, as its refusals are tagged with it. */
export const commandSum = (command: string) => crypto.createHash("sha256").update(command).digest("hex").slice(0, 16);

/** What the sandbox refused `command` lately in `session`, from macOS's own log (the launcher tags
 * each command's refusals `kuvo-sandbox <session> <sum of the command>`); none where it can't be
 * read, or for a command that didn't run as it's named. (Read without holding up the box: it can
 * take seconds.) */
export async function stopsFor(session: string, command: string, minutes = 3): Promise<SandboxStop[]> {
  if (process.platform !== "darwin" || !/^ses_[A-Za-z0-9_]{1,80}$/.test(session)) return [];
  const tagged = `kuvo-sandbox ${session} ${commandSum(command)}`;
  const read = await new Promise<string>(resolve => {
    const child = spawn("/usr/bin/log", ["show", "--last", `${minutes}m`, "--style", "ndjson", "--predicate", `sender == "Sandbox" AND eventMessage CONTAINS "${tagged}"`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (out.length < 16 * 1024 * 1024) out += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
  const stops: SandboxStop[] = [];
  const seen = new Set<string>();
  for (const line of read.split("\n")) {
    let message = "";
    try { message = JSON.parse(line)?.eventMessage ?? ""; } catch { continue; }
    const [first, tag] = String(message).split("\n");
    if (tag?.trim() !== tagged) continue;
    const found = first.match(/^Sandbox: .+?\(\d+\) deny\(\d+\) (\S+)(?: (.+))?$/);
    if (!found) continue;
    const kind = KINDS.find(([pattern]) => pattern.test(found[1]))?.[1] ?? "other";
    const where = found[2]?.trim();
    const key = `${kind}\0${where ?? found[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stops.push(where && kind !== "app" && kind !== "job" ? { kind, path: where } : { kind });
  }
  return stops.slice(-MOST_STOPS);
}

/** What Always would allow for a command: the one folder it was stopped writing in (the log names
 * the file, which the next run may name differently), or where that can't be given, the file
 * itself; when the log says so and it may be given. Else nothing, and it can only be allowed once:
 * also for what's in its own project, which its commands write already but for what's kept from
 * them there (the settings agents start with), which no rule gives. */
function alwaysFor(stops: SandboxStop[], project: string): SandboxAsk["always"] {
  const writes = [...new Set(stops.filter(stop => stop.kind === "write" && stop.path).map(stop => stop.path!))];
  if (writes.length !== 1 || !stops.every(stop => stop.kind === "write")) return undefined;
  const real = (where: string) => { try { return fs.realpathSync(where); } catch { return path.resolve(where); } };
  const own = real(project);
  const where = real(path.dirname(writes[0]));
  if (where === own || where.startsWith(own + "/")) return undefined;
  const isFolder = (() => { try { return fs.statSync(writes[0]).isDirectory(); } catch { return false; } })();
  const given = (isFolder ? null : writeRuleWouldBe(path.dirname(writes[0]))) ?? writeRuleWouldBe(writes[0]);
  return given ? { kind: "write", path: given } : undefined;
}

/** The notification for an ask, as the Mac words it. */
export function sandboxAskNotice(asked: SandboxAsk): Notice {
  const who = asked.botName ?? asked.sessionName ?? "An agent";
  return {
    title: `${who} wants to run a command outside the sandbox`,
    subtitle: asked.machine,
    body: `${oneLine(asked.command, 120)}${asked.why ? `\n${asked.why}` : ""}`,
    category: "ask",
    thread: asked.session ?? asked.id,
    data: { ...(asked.session ? { session: asked.session } : {}), sandboxAsk: asked.id },
  };
}

/** Your phones hear of each ask still open a moment after it's made. */
export function watchSandboxAsks(tell: (notice: Notice) => boolean, answered: (id: string) => void = () => {}, after = 2000): () => void {
  return book.watch(sandboxAskNotice, tell, answered, after);
}

const failed = (text: string): ToolAnswer => ({ text, isError: true });

async function askToRun(caller: Caller, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolAnswer> {
  const started = Date.now();
  // A bot's seat in a group chat runs no commands, so the sandbox never stopped one of its own; and
  // it's a conversation you can't open, to see what it asks.
  if (caller.seat) return failed("In a group chat you don't run commands, in the sandbox or outside it. Say in your reply what should run, and who should do it.");
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const why = oneLine(typeof args.why === "string" ? args.why : "", 300).trim();
  const error = typeof args.error === "string" ? cut(args.error.trim(), 2000) : "";
  if (!command) return failed("Give the command, exactly as you ran it.");
  if (!why) return failed("Say why the task needs it.");
  if (command.length > 8000) return failed("That command is too long to ask about: put it in a script in your project and ask to run that.");
  const project = caller.folder && fs.existsSync(caller.folder) ? caller.folder : null;
  if (!project) return failed("This conversation's folder isn't there, so nothing can run for it.");

  // (By the command as it ran, whitespace and all.)
  const stopped = caller.session ? await stopsFor(caller.session, String(args.command)) : [];
  const always = alwaysFor(stopped, project);
  const answered = await book.ask({
    ...(caller.root ? { session: caller.root, ...(caller.sessionName ? { sessionName: caller.sessionName } : {}) } : {}),
    ...(caller.bot ? { bot: caller.bot, botName: caller.botName } : {}),
    project,
    command,
    why,
    ...(stopped.length ? { stopped } : {}),
    ...(error ? { error } : {}),
    ...(always ? { always } : {}),
    ...(IS_MAC ? {} : { machine: os.hostname() }),
    owner: ownerOf(project),
  }, signal);
  if (answered.unanswered) return { text: "Nobody answered in time, so it didn't run. Don't get around the sandbox another way: go on without it, or ask the user when they're back.", isError: false };
  if (answered.answer === "no") return { text: "The user said no: don't run it, nor get around the sandbox another way. Find another way to do the task, or ask them why.", isError: false };
  let how: "once" | "always" = "once";
  if (answered.answer === "always" && always) {
    try { addRule({ project, ...always, ...(answered.client ? { by: answered.client } : {}) }); how = "always"; } catch {}
  }
  const left = Math.floor((CALL_BUDGET - (Date.now() - started)) / 1000);
  const seconds = Math.max(1, Math.min(600, left, Number(args.timeout) || 300));
  const { output, code, timedOut } = await runCommand(command, project, commandEnv(), seconds * 1000, signal);
  let shown = output;
  if (shown.length > MOST_OUTPUT) shown = "…" + shown.slice(-MOST_OUTPUT).replace(/^[^\n]*\n/, "");
  const ended = timedOut ? `It was stopped after ${seconds} seconds.` : `It ended with ${code}.`;
  const head = how === "always" ? `Ran outside the sandbox · Always for this: from now on your commands can write in ${always!.path} in the sandbox, so run them there.` : "Ran outside the sandbox · Allowed once";
  return { text: `${head}\n\n${shown.trim() ? shown.trimEnd() + "\n\n" : "It printed nothing.\n\n"}${ended}`, isError: timedOut || code !== 0 };
}

/** One of the tools, called for `caller`. */
export async function callSandboxTool(name: unknown, args: unknown, caller: Caller, signal?: AbortSignal): Promise<ToolAnswer> {
  const given = isObject(args) ? args : {};
  if (name === "sandbox_ask") return askToRun(caller, given, signal);
  return failed(`There's no sandbox tool “${oneLine(name, 40)}”.`);
}
