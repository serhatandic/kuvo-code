// The engine on this box, as the link answers for it: why it can't be asked now, starting it and
// starting it over (`kuvo/engine/start`, `kuvo/engine/restart`), a sign-in's page loaded here
// (`kuvo/sign-in/return`), a command an agent runs stopped (`kuvo/shell/<id>/stop`), and a socket on it
// (a terminal's).

// Why the engine can't be asked now: stopped on purpose (until it's started, from anywhere); on a
// Mac, given up on, with why (the app's `run/engine-stopped`, until it starts it again); on a
// machine, stopping again and again, with its keeper's next start a while away (`run/engine.retry`,
// when, in seconds since 1970); or starting (again).
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EngineRecord, Target } from "../../shared/records";
import { canonicalPath, signInReturn, socketAllowed } from "../server/paths";
import { IS_MAC, K, RUN } from "../home";
import { phoneHere } from "../compat/leave-running";
import { readEngineFile } from "../engine/client";
import { isUpdating, updateState } from "../updates/update";
import type { UpdateStep } from "../../shared/routes/box";
import type { SessionPhone, SocketEvents, SocketHandle } from "../relay/host";
import type { AnswerPiece, LinkRequest, RouteContext } from "../server/context";

export const engineDown = (): string => {
  // COMPAT(0.7 engine-stop): an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
  if (fs.existsSync(path.join(RUN, "stopped"))) return "The engine isn't running.";
  if (IS_MAC) {
    let why = "";
    try { why = fs.readFileSync(path.join(RUN, "engine-stopped"), "utf8").trim(); } catch {}
    // (While it's tried again by itself, `run/engine.retry`, its reason says so.)
    if (why) return `This Mac's engine isn't running. ${why}${fs.existsSync(path.join(RUN, "engine.retry")) ? "" : " Try Again in Kuvo Code on the Mac starts it."}`;
    return "This Mac's engine is starting. Try again in a moment.";
  }
  const retry = Number(fs.existsSync(path.join(RUN, "engine.retry")) ? fs.readFileSync(path.join(RUN, "engine.retry"), "utf8").trim() : NaN);
  // (The keeper looks every fifteen seconds, and a start takes a few more.)
  const minutes = Math.ceil((retry - Date.now() / 1000) / 60);
  if (Number.isFinite(retry) && retry - Date.now() / 1000 > 30) {
    return `This machine's engine keeps stopping. It's started again in ${minutes === 1 ? "about a minute" : `about ${minutes} minutes`}.`;
  }
  return "This machine's engine is starting. Try again in a moment.";
};

/** What starting the engine here came to: its status (202, under way), and why not, when it isn't. */
export interface EngineControlOutcome {
  status: number;
  message?: string;
}

// An update's steps before it stops the engine.
const ENGINE_UP_WHILE: UpdateStep[] = ["checking", "downloading", "downloading the engine", "checking it"];

// COMPAT(0.7 engine-stop): `start`, for an engine an older Mac's Stop left down (`restart` stays). Goes 3 months after 0.8.0.
// The engine here started, or started over, by the box's own tool (`bin/kuvo-start`, as the Mac
// has it do): `start` for one an older Mac's Stop left down (until it's started, from anywhere),
// and `restart`. This bridge stays up through each. Answered at once (202), and the phone sees it
// come up as `kuvo/info` says (`running`, `started`).
export async function engineControl(command: "start" | "restart"): Promise<EngineControlOutcome> {
  const start = path.join(K, "bin", "kuvo-start");
  if (!fs.existsSync(start)) return { status: 409, message: "Kuvo Code hasn't set this machine up yet." };
  // Started from a Mac once, which keeps how (`run/launch.env`) and what starts it (`bin/kuvo-launch`).
  // (A Mac's own `kuvo-start` asks its keeper, which knows how: PROTOCOL.md, "The keeper".)
  if (!IS_MAC && ![path.join(K, "bin", "kuvo-launch"), path.join(RUN, "launch.env")].every(file => fs.existsSync(file))) {
    return { status: 409, message: "Start it once from Kuvo Code on your Mac." };
  }
  // An update stops the engine on purpose while it swaps its files, and starts it once that's done.
  // (While it checks for one or downloads it, the engine runs as ever.)
  if (isUpdating() && !ENGINE_UP_WHILE.includes(updateState().running as UpdateStep)) {
    return { status: 409, message: "This machine is updating. Its engine starts again once that's done." };
  }
  // Not with what runs this bridge (the engine's runtime as Bun), which would make `opencode
  // serve` a script to look for.
  const environment = { ...process.env };
  delete environment.BUN_BE_BUN;
  delete environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  const workspace = path.join(K, "workspace");
  const options = { cwd: fs.existsSync(workspace) ? workspace : K, env: environment };
  try {
    const child = spawn("sh", [start, command], { ...options, detached: true, stdio: "ignore" });
    lastToolRun = { child, ended: new Promise(resolve => { child.on("exit", resolve); child.on("error", resolve); }) };
    child.unref();
  } catch {
    return { status: 503, message: "It couldn't be started." };
  }
  return { status: 202 };
}

// The box's tool, as last started here, ending as it does (what a test waits for).
let lastToolRun: { child: ChildProcess; ended: Promise<unknown> } | null = null;
export const toolRun = (): Promise<unknown> => {
  lastToolRun?.child.ref();
  return lastToolRun?.ended ?? Promise.resolve();
};

// `kuvo/sign-in/return` with {"url"}: where a sign-in's page sent the browser back to this
// machine (an MCP server's, or a coding agent's), which a phone can't load, loaded here as the
// browser would have: only this machine's own address (`signInReturn`), and no further than it
// answers (a redirect isn't followed). Answers with the status it got: 2xx or 3xx, it took it.
export async function* loadSignInReturn(body: Buffer | undefined, signal: AbortSignal | undefined): AsyncGenerator<AnswerPiece> {
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  let given: { url?: unknown } | null = {};
  try {
    given = JSON.parse(Buffer.from(body ?? []).toString("utf8") || "{}");
  } catch {}
  const url = signInReturn(given?.url);
  if (!url) return yield* json(400, { message: "That isn't an address a sign-in returns to on this computer." });
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 15_000);
  const cancel = () => stop.abort();
  signal?.addEventListener("abort", cancel);
  try {
    const response = await fetch(url, { redirect: "manual", signal: stop.signal });
    await response.arrayBuffer().catch(() => {});
    return yield* json(200, { status: response.status });
  } catch {
    return yield* json(502, { message: "Nothing on this computer took it. Start the sign-in again." });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

/** A command an agent runs, as the engine (or the coding agents' bridge) lists it: whether it's
 * running, and its process. */
export interface ShellJob {
  id: string;
  status: string;
  command?: string;
  pid?: number;
  metadata?: unknown;
  time?: { started?: number };
}

// Stops a command an agent runs (the engine's, or a coding agent's through their bridge: the first
// of `runners` that has it): SIGTERM to its process group, here, so it sees it end and tells the
// agent, with what it printed. Its own remove deletes the output too, and the agent hears the
// command was never found, so it's only for when the signal can't be sent.
export async function* stopShell(id: string, runners: Target[], headers: Record<string, string>, signal: AbortSignal | undefined): AsyncGenerator<AnswerPiece> {
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  let job: ShellJob | undefined, url: string | undefined;
  // Whether one of them answered at all: none that did is "no such command", as none that didn't isn't.
  let answered = false;
  for (const runner of runners) {
    url = `http://127.0.0.1:${runner.port}/api/shell/${encodeURIComponent(id)}`;
    const asking = { ...headers, authorization: `Basic ${Buffer.from(`opencode:${runner.password}`).toString("base64")}` };
    try {
      const response = await fetch(url, { headers: asking, signal });
      answered = true;
      if (response.ok) job = ((await response.json()) as { data?: ShellJob }).data;
    } catch {}
    if (job) {
      headers = asking;
      break;
    }
  }
  if (!job && !answered) return yield* json(503, { message: "Its engine didn’t answer. Try again in a moment." });
  if (!job || job.status !== "running") return yield* json(404, {});
  const stopped = await endShellJob(job, url!, headers, signal);
  return stopped ? yield* json(200, { stopped }) : yield* json(422, { message: "It runs on, and couldn’t be stopped." });
}

/** A running command ended (`url`: where it's kept, `headers`: how it's reached): its signal, else
 * the engine's own remove; how, or null when neither could be done. */
export async function endShellJob(job: ShellJob, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<"signal" | "removed" | null> {
  if (Number.isInteger(job.pid) && job.pid! > 1) {
    try {
      process.kill(-job.pid!, "SIGTERM");
      return "signal";
    } catch {}
  }
  try {
    const response = await fetch(url, { method: "DELETE", headers, signal });
    if (response.ok) return "removed";
  } catch {}
  return null;
}

// What LinkHost runs to open a socket: the engine's WebSocket at that path, with its password.
export function engineConnect(readEngine: () => EngineRecord = readEngineFile): (request: LinkRequest, phone: SessionPhone, events: SocketEvents) => SocketHandle {
  return (request, phone, events) => {
    let ended = false;
    const end = (error?: Error) => {
      if (ended) return;
      ended = true;
      events.end(error);
    };
    const refuse = (words: string): SocketHandle => {
      queueMicrotask(() => end(new Error(words)));
      return { send() {}, close() {} };
    };
    if (!socketAllowed(request.path)) return refuse("That isn't available over the link.");
    let engine: EngineRecord;
    try {
      engine = readEngine();
    } catch {
      return refuse("The engine isn't running.");
    }
    phoneHere();
    const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` };
    const directory = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "x-opencode-directory")?.[1];
    // (One value: a phone sends each header once.)
    if (directory) headers["x-opencode-directory"] = directory as string;
    const socket = new WebSocket(`ws://127.0.0.1:${engine.port}/${canonicalPath(request.path)}`, { headers });
    socket.binaryType = "arraybuffer";
    socket.onopen = () => events.open();
    socket.onmessage = event => typeof event.data === "string" ? events.text(Buffer.from(event.data)) : events.binary(Buffer.from(event.data));
    socket.onerror = () => end(new Error("The engine closed it."));
    socket.onclose = () => end();
    return {
      send: data => { if (socket.readyState === 1) socket.send(data.toString("utf8")); },
      close: () => {
        ended = true;
        try { socket.close(); } catch {}
      },
    };
  };
}

// COMPAT(0.7 engine-stop): `kuvo/engine/start`, for an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
// (No Stop: a machine's engine keeps running, and up to date. Start is for one an older Mac stopped.)
export async function* engineControlRoute(context: RouteContext, control: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const { status, message } = await engineControl(control[1] as "start" | "restart");
  return yield* json(status, message ? { message } : {});
}

export async function* signInReturnRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  return yield* loadSignInReturn(request.body, signal);
}
