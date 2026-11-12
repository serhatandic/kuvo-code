// A command an agent needs outside the sandbox (PROTOCOL.md, "Sandbox", "Asks"): its `sandbox_ask`,
// which both tool servers (this Mac's app, a machine's kuvo-browser.js) pass here as it is. You're
// asked on any client, with what the sandbox stopped; Allow Once and Always have the box
// run that one command itself, outside the sandbox, in the conversation's folder, and hand its
// output back. Always also lets the project's commands write, in the sandbox, the one folder this
// one was stopped writing in (fence/allowed.ts); a command itself is never let out for good, and
// is asked about each time. The agent never lets a command out of the sandbox itself, and no tool
// answers an ask: only a client, or in Auto the conversation's reviewer (which never asks you), or
// in Full Access nothing.

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
import { markedFullAccess } from "../work/full";
import { findConversation, heldUnreached, inAuto, inFullAccess, refusalWords, reviewIn } from "../work/reviewing";
import { forgetFetched } from "../work/reviewer";
import { addRule, ownerOf, writeRuleWouldBe } from "./allowed";
import { askedAbout, fencePolicy, macMayAsk, type FencePolicy } from "./policy";
import { notOnWords } from "./state";
import { sandboxGap } from "../work/sandbox";

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
    description: "Ask the user to run a command outside the sandbox, when the sandbox stopped one the task needs (\"Operation not permitted\" or \"Permission denied\" outside the folders you may write, or a refused connection or app). They allow it once or say no, and where it was stopped writing in one folder, can let your commands write there from now on. Allowed, it runs in your project's folder, and you get its output. Waits for their answer. Never use it to get around a rule you were told, nor for a command you haven't tried in the sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Exactly as you ran it." },
        why: { type: "string", description: "Why the task needs it, in one sentence the user reads." },
        error: { type: "string", description: "What it printed when the sandbox stopped it." },
        timeout: { type: "number", description: "How long it may run once allowed, in seconds: 300 by default, 600 at most." },
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
// When to read macOS's log again for what the sandbox refused, while it isn't there yet (ms).
const LOG_LATER = [1000, 2000, 4000, 8000, 15_000, 30_000];

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
export async function stopsFor(session: string, command: string, minutes = 3, signal?: AbortSignal): Promise<SandboxStop[]> {
  if (process.platform !== "darwin" || !/^ses_[A-Za-z0-9_]{1,80}$/.test(session) || signal?.aborted) return [];
  const tagged = `kuvo-sandbox ${session} ${commandSum(command)}`;
  const read = await new Promise<string>(resolve => {
    const child = spawn("/usr/bin/log", ["show", "--last", `${minutes}m`, "--style", "ndjson", "--predicate", `sender == "Sandbox" AND eventMessage CONTAINS "${tagged}"`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
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
function alwaysFor(stops: SandboxStop[], project: string): Promise<SandboxAsk["always"]> | undefined {
  const writes = [...new Set(stops.filter(stop => stop.kind === "write" && stop.path).map(stop => stop.path!))];
  // (None at once, so an ask with none goes up without waiting a turn.)
  if (writes.length !== 1 || !stops.every(stop => stop.kind === "write")) return undefined;
  return alwaysForWrite(writes, project);
}

async function alwaysForWrite(writes: string[], project: string): Promise<SandboxAsk["always"]> {
  await askedAbout([project, writes[0], path.dirname(writes[0])]);
  const real = (where: string) => { try { return fs.realpathSync(where); } catch { return path.resolve(where); } };
  const own = real(project);
  const where = real(path.dirname(writes[0]));
  if (where === own || where.startsWith(own + "/")) return undefined;
  const isFolder = (() => { try { return fs.statSync(writes[0]).isDirectory(); } catch { return false; } })();
  const given = (isFolder ? null : await writeRuleWouldBe(path.dirname(writes[0]))) ?? await writeRuleWouldBe(writes[0]);
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
  if (caller.folder && macMayAsk(caller.folder)) await askedAbout([caller.folder]);
  const project = caller.folder && fs.existsSync(caller.folder) ? caller.folder : null;
  if (!project) return failed("This conversation's folder isn't there, so nothing can run for it.");

  // In Full Access it just runs. In Auto, its reviewer decides, never you: it runs, or the agent
  // hears why not and goes on another way (and you can approve it later, from Decisions).
  // (Where the engine doesn't answer, as it was last found; one never found is held back, as one
  // the reviewer couldn't judge.)
  const conversation = caller.root ?? caller.session;
  const { at, unreached } = conversation ? await findConversation(conversation).catch(() => ({ at: null, unreached: true })) : { at: null, unreached: false };
  // (One the box hasn't found since it started again goes as it's marked: Full Access has no asks.)
  const full = at ? inFullAccess(at) : Boolean(unreached && conversation && markedFullAccess(conversation));
  const action = { kind: "command" as const, command, folder: project };
  // (A review that fails is a refusal: in Auto nothing waits for you.)
  const reviewing = full ? null : at ? reviewIn(conversation!, action, signal, at) : unreached ? heldUnreached(conversation!, action, signal) : null;
  const verdict = reviewing && await reviewing
    .catch(error => ({ decision: "refuse" as const, reason: `Auto's reviewer couldn't review it (${String((error as Error)?.message ?? error).slice(0, 120)}).`, by: "code" as const, held: false, why: "failed" as const, paused: false, fetched: undefined }));
  if (verdict?.decision === "refuse") return { text: refusalWords(verdict), isError: false };
  // What the sandbox refused, from macOS's log, is for you when you're asked: read only then, so
  // Full Access and Auto don't wait on the log.
  const asks = !full && verdict?.decision !== "allow";
  // (By the command as it ran, whitespace and all.)
  const stopped = asks && caller.session ? await stopsFor(caller.session, String(args.command)) : [];
  const alwaysNow = alwaysFor(stopped, project);
  let always = alwaysNow && await alwaysNow;
  // macOS writes what its sandbox refused to its log a while after (a busy Mac, seconds): until
  // it's there, the ask goes up without it, and gets it once it is.
  let asking: string | undefined;
  const heard = new AbortController();
  if (asks && !stopped.length && caller.session && process.platform === "darwin") void (async () => {
    for (const wait of LOG_LATER) {
      await new Promise(resolve => setTimeout(resolve, wait).unref?.());
      if (heard.signal.aborted) return;
      const found = await stopsFor(caller.session!, String(args.command), 3, heard.signal);
      if (heard.signal.aborted || !found.length) continue;
      always = await alwaysFor(found, project);
      if (asking) book.update(asking, { stopped: found, ...(always ? { always } : {}) });
      return;
    }
  })();
  const answered: SandboxAnswer = full ? { answer: "once", client: "Full Access" } : verdict?.decision === "allow" ? { answer: "once", client: "Auto" } : await book.ask({
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
  }, signal, undefined, id => { asking = id; }).finally(() => heard.abort());
  // (A script from the web, fetched once for the review: that copy is what runs, then it's gone.)
  const fetched = verdict?.fetched;
  if (answered.unanswered) return { text: "Nobody answered in time, so it didn't run. Don't get around the sandbox another way: go on without it, or ask the user when they're back.", isError: false };
  if (answered.answer === "no") return { text: "The user said no: don't run it, nor get around the sandbox another way. Find another way to do the task, or ask them why.", isError: false };
  let how: "once" | "always" = "once";
  if (answered.answer === "always" && always) {
    try { await addRule({ project, ...always, ...(answered.client ? { by: answered.client } : {}) }); how = "always"; } catch {}
  }
  // Allowed by Auto's reviewer, which counts on the sandbox: only while it's still on (its check may
  // have failed, or not finished, while the reviewer decided).
  const notNow = verdict?.decision === "allow" ? stillOff(at?.agents ?? true) : null;
  if (notNow) { forgetFetched(fetched); return { text: notNow, isError: false }; }
  const left = Math.floor((CALL_BUDGET - (Date.now() - started)) / 1000);
  const seconds = Math.max(1, Math.min(600, left, Number(args.timeout) || 300));
  const { shown, code, timedOut } = await runOutside(fetched?.command ?? command, project, seconds, signal).finally(() => forgetFetched(fetched));
  const ended = timedOut ? `It was stopped after ${seconds} seconds.` : `It ended with ${code}.`;
  const head = how === "always" ? `Ran outside the sandbox · Always for this: from now on your commands can write in ${always!.path} in the sandbox, so run them there.` : verdict?.decision === "allow" ? (verdict.by === "you" ? "Ran outside the sandbox · Approved by the user" : `Ran outside the sandbox · Allowed by Auto's reviewer: ${verdict.reason}`) : full ? "Ran outside the sandbox · Full Access" : "Ran outside the sandbox · Allowed once";
  return { text: `${head}\n\n${shown.trim() ? shown.trimEnd() + "\n\n" : "It printed nothing.\n\n"}${ended}`, isError: timedOut || code !== 0 };
}

/** Whether the sandbox, and not something else, stopped a command that printed `printed`: on a
 * Mac, "Operation not permitted", which its sandbox answers and a file's own permissions or a
 * database don't (its log isn't enough: it has what the sandbox quietly refused any command too);
 * on Linux, what Landlock answers (or a read-only folder), or a secret that's hidden from commands
 * said not to be there. */
function stoppedBySandbox(printed: string, policy: FencePolicy): boolean {
  if (process.platform === "darwin") return /operation not permitted|\bEPERM\b/i.test(printed);
  if (/permission denied|read-only file system|operation not permitted|\bE(PERM|ACCES|ROFS)\b/i.test(printed)) return true;
  const named = printed.match(/(?:~|\/)[^\s'"`:,;()]+/g) ?? [];
  return /no such file or directory/i.test(printed) && named.some(word => {
    const where = path.resolve(word.replace(/^~(?=\/|$)/, policy.home));
    return policy.secrets.some(wall => where === wall || where.startsWith(wall + "/"));
  });
}

/** A command the sandbox stopped as an agent's shell tool ran it (the engine's plugin tells the box
 * as the call ends: `kuvo/sandbox/stopped`), in a conversation in Auto: its reviewer decides, as for
 * sandbox_ask, with nobody asked, seeing what it printed and what the sandbox refused it. Allowed,
 * it runs again outside the sandbox where the agent ran it, and the agent gets that output instead
 * (`exit`); refused, why not, after what it printed (no `exit`: the call ended as it did). Stopped
 * once the agent's call is (`calling`). Null in any other mode (the agent can ask you with
 * sandbox_ask), for what something else refused, and where it can't be told. */
export async function stoppedInAuto(caller: Caller, input: Record<string, unknown>, printed: string, calling: () => Promise<boolean>, signal?: AbortSignal): Promise<{ text: string; exit?: number } | null> {
  const started = Date.now();
  const command = typeof input.command === "string" ? input.command : "";
  await askedAbout([caller.folder]);
  const project = caller.folder && fs.existsSync(caller.folder) ? caller.folder : null;
  if (caller.seat || !command.trim() || command.length > 8000 || !project) return null;
  // (Where the agent ran it: its shell tool's own folder, from the conversation's.)
  const given = typeof input.workdir === "string" ? input.workdir : typeof input.cwd === "string" ? input.cwd : "";
  const folder = given ? path.resolve(project, given.replace(/^~(?=\/|$)/, os.homedir())) : project;
  await askedAbout([folder]);
  if (!fs.existsSync(folder)) return null;
  const conversation = caller.root ?? caller.session;
  const at = conversation ? (await findConversation(conversation).catch(() => ({ at: null }))).at : null;
  if (!at || !inAuto(at) || !stoppedBySandbox(printed, fencePolicy())) return null;
  // What macOS's log says the sandbox refused it, which comes a moment after (by the command as it
  // ran, whitespace and all).
  let stops: SandboxStop[] = [];
  if (process.platform === "darwin" && caller.session) {
    for (const wait of [0, ...LOG_LATER.slice(0, 2)]) {
      if (wait) await new Promise(resolve => setTimeout(resolve, wait).unref?.());
      stops = await stopsFor(caller.session, command, 3, signal);
      if (stops.length || signal?.aborted) break;
    }
  }
  const verdict = await reviewIn(conversation!, { kind: "command", command, folder, stopped: { printed: cut(printed, 4000), stops } }, signal, at)
    .catch(error => ({ decision: "refuse" as const, reason: `Auto's reviewer couldn't review it (${String((error as Error)?.message ?? error).slice(0, 120)}).`, by: "code" as const, held: false, why: "failed" as const, paused: false, fetched: undefined }));
  if (!verdict) return null;
  if (verdict.decision === "refuse") return { text: refusalWords(verdict) };
  // (Only while the sandbox is still on, which Auto counts on: its check may have failed, or not
  // finished, while the reviewer decided.)
  const notNow = stillOff(at.agents);
  if (notNow) { forgetFetched(verdict.fetched); return { text: notNow }; }
  // (A shell tool's timeout is in milliseconds, and none is the most; within what the call has left.)
  const asked = Number(input.timeout);
  const left = Math.floor((CALL_BUDGET - (Date.now() - started)) / 1000);
  const seconds = Math.max(1, Math.min(600, left, asked > 0 ? Math.ceil(asked / 1000) : asked === 0 ? 600 : 300));
  // Stopped with the agent's call: the user pressed Stop.
  const stop = new AbortController();
  signal?.addEventListener("abort", () => stop.abort(), { once: true });
  const watching = setInterval(() => { void calling().then(still => { if (!still) stop.abort(); }, () => {}); }, 3000);
  const ran = await runOutside(verdict.fetched?.command ?? command, folder, seconds, stop.signal).finally(() => { clearInterval(watching); forgetFetched(verdict.fetched); });
  const head = verdict.by === "you" ? "The sandbox stopped it · Ran again outside the sandbox · Approved by the user" : `The sandbox stopped it · Ran again outside the sandbox · Allowed by Auto's reviewer: ${verdict.reason}`;
  return { text: `${head}\n\n${ran.shown.trimEnd()}${ran.timedOut ? `\n\nIt was stopped after ${seconds} seconds.` : ""}`, exit: ran.timedOut ? 124 : ran.code ?? 1 };
}

/** Why Auto lets nothing out of the sandbox now, as Auto itself goes by it (`sandboxGap`, for a
 * conversation on the coding agents or the engine): checked again after its reviewer decides, as the
 * sandbox may have gone while it did. Null where it's still all there. */
function stillOff(agents: boolean): string | null {
  const gap = sandboxGap(agents);
  if (gap === "partial") return "Auto needs the whole sandbox, and on this computer it can't keep commands from your login's services now, so nothing is let out of it: run the command with your shell tool, which asks the user first.";
  if (gap === "agents") return "Auto needs the coding agents' own programs in the sandbox, and some still run outside it, so nothing is let out of it: run the command with your shell tool, which asks the user first.";
  return gap ? notOnWords() : null;
}

/** `command` run outside the sandbox in `folder`, for at most `seconds`: its output, cut to the
 * end where it's long. */
async function runOutside(command: string, folder: string, seconds: number, signal?: AbortSignal) {
  const { output, code, timedOut } = await runCommand(command, folder, commandEnv(), seconds * 1000, signal);
  const shown = output.length > MOST_OUTPUT ? "…" + output.slice(-MOST_OUTPUT).replace(/^[^\n]*\n/, "") : output;
  return { shown, code, timedOut };
}

/** One of the tools, called for `caller`. */
export async function callSandboxTool(name: unknown, args: unknown, caller: Caller, signal?: AbortSignal): Promise<ToolAnswer> {
  const given = isObject(args) ? args : {};
  if (name === "sandbox_ask") return askToRun(caller, given, signal);
  return failed(`There's no sandbox tool “${oneLine(name, 40)}”.`);
}
