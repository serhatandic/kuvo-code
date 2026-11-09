// A provider's models asked of again (PROTOCOL.md, `kuvo/accounts/<provider>/refresh`): the
// engine's lists made afresh without a restart, and what providers need learned again at once.
//
// The engine reads some providers' lists from your account as it opens a folder (GitHub Copilot's,
// with the models your plan has), and again only when the account in use changes. opencode (2.2.5)
// has no way to ask again but to close the folder (`DELETE api/debug/location`): its next use opens
// it afresh. Closing one stops its terminals and its commands, and drops a question waiting on
// you, so only a folder where nothing's going on is closed now; one at work is noted here
// (`run/models-due.json`, for the engine it was asked of) and closed once its work is done
// (`settleDueModels`, as the box hears its events).

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { EngineRecord, Target } from "../../shared/records";
import { writePrivate } from "../files";
import { RUN } from "../home";
import { engineGet } from "./client";
import { learnCompatibility } from "./compatibility";

export const MODELS_DUE_FILE = path.join(RUN, "models-due.json");

/** The engine's events after which a folder that was at work may be done: the box looks again. */
export const WORK_ENDS = new Set([
  "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "pty.exited", "pty.deleted", "shell.exited", "shell.deleted",
  "permission.replied", "permission.rejected", "form.replied", "form.cancelled",
]);

/** What `refreshModels` came to: done, with the folders that get it once their work is done
 * (`waiting`); no such provider; or the engine not answering. */
export type ModelsRefresh = { status: 200; waiting: string[] } | { status: 404 } | { status: 503; message: string };

/** Which engine it is: a restarted one opened every folder afresh. */
const engineOf = (engine: Target & Pick<EngineRecord, "pid">): string => `${engine.pid ?? ""}:${engine.port}`;

/** `run/models-due.json`: the folders still to close, for the engine they were asked of. */
interface ModelsDue {
  engine: string;
  folders: string[];
}

function readDue(file: string): ModelsDue | null {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isObject(kept) && typeof kept.engine === "string" && Array.isArray(kept.folders)) {
      return { engine: kept.engine, folders: kept.folders.filter((folder): folder is string => typeof folder === "string") };
    }
  } catch {}
  return null;
}

function writeDue(file: string, due: ModelsDue | null): void {
  if (!due?.folders.length) return void fs.rmSync(file, { force: true });
  writePrivate(file, JSON.stringify(due));
}

/** The engine's answer's `data` as a list (empty for none). */
const listOf = (answer: unknown): unknown[] => (isObject(answer) && Array.isArray(answer.data) ? answer.data : Array.isArray(answer) ? answer : []);

/** The folders the engine has open now. */
async function openFolders(engine: Target): Promise<string[]> {
  const open = await engineGet(engine, "api/debug/location");
  return [...new Set(listOf(open).map(each => (isObject(each) ? each.directory : null)).filter((folder): folder is string => typeof folder === "string" && folder !== ""))];
}

/** Of `folders`, those with something going on that closing them would cut: a run under way (the
 * engine's runs are its sessions', each in a folder), a question or a permission waiting on you, a
 * terminal, a command still running. One the engine can't say about counts as at work. */
async function atWork(engine: Target, folders: string[]): Promise<Set<string>> {
  const busy = new Set<string>();
  try {
    const active = await engineGet(engine, "api/session/active");
    const data = isObject(active) ? active.data : null;
    const sessions = Array.isArray(data) ? data : isObject(data) ? Object.keys(data) : [];
    for (const id of sessions) {
      if (typeof id !== "string") continue;
      const session = await engineGet(engine, `api/session/${encodeURIComponent(id)}`).catch(() => null);
      const location = isObject(session) && isObject(session.data) && isObject(session.data.location) ? session.data.location.directory : null;
      // A run whose folder can't be read: none is closed.
      if (typeof location !== "string") return new Set(folders);
      busy.add(location);
    }
  } catch {
    return new Set(folders);
  }
  for (const folder of folders) {
    if (busy.has(folder)) continue;
    try {
      const [forms, permissions, terminals, commands] = await Promise.all(["api/form", "api/permission/request", "api/pty", "api/shell"].map(route => engineGet(engine, route, folder)));
      const running = (answer: unknown) => listOf(answer).some(each => !isObject(each) || each.status === "running");
      if (listOf(forms).length || listOf(permissions).length || running(terminals) || running(commands)) busy.add(folder);
    } catch {
      busy.add(folder);
    }
  }
  return busy;
}

/** Closes `folder` on the engine: its next use opens it afresh. "unsupported" when the engine
 * has no way to (an opencode without `api/debug/location`'s DELETE). */
async function close(engine: Target, folder: string): Promise<"closed" | "failed" | "unsupported"> {
  const query = new URLSearchParams({ "location[directory]": folder });
  const response = await fetch(`http://127.0.0.1:${engine.port}/api/debug/location?${query}`, {
    method: "DELETE",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  response?.body?.cancel();
  if (response?.ok) return "closed";
  return response?.status === 404 || response?.status === 405 ? "unsupported" : "failed";
}

/** The engine can't close a folder: a refresh can't be done without a restart. */
class CantClose extends Error {}

/** Closes those of `folders` where nothing's going on, each looked at just before it's closed (a
 * run started meanwhile in one keeps it open); the rest, it says. */
async function closeQuiet(engine: Target, folders: string[]): Promise<string[]> {
  const waiting: string[] = [];
  for (const folder of folders) {
    if ((await atWork(engine, [folder])).has(folder)) {
      waiting.push(folder);
      continue;
    }
    const closed = await close(engine, folder);
    if (closed === "unsupported") throw new CantClose();
    if (closed === "failed") waiting.push(folder);
  }
  return waiting;
}

/** `provider`'s models asked of again on `engine`, with every other provider's: each folder it has
 * open closed where nothing's going on, the rest noted for once their work is done; then what
 * providers need learned from its list as it is now, and applied. */
export async function refreshModels(engine: EngineRecord, provider: string, file = MODELS_DUE_FILE): Promise<ModelsRefresh> {
  const unreachable = { status: 503 as const, message: "The engine isn't answering. Try again in a moment." };
  const known = await fetch(`http://127.0.0.1:${engine.port}/api/integration/${encodeURIComponent(provider)}`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  known?.body?.cancel();
  if (known?.status === 404) return { status: 404 };
  if (!known?.ok) return unreachable;
  let folders: string[];
  try { folders = await openFolders(engine); } catch { return unreachable; }
  let waiting: string[];
  try {
    waiting = await closeQuiet(engine, folders);
  } catch (error) {
    if (error instanceof CantClose) return { status: 503, message: "This engine can't ask for its models again without restarting. Restart it in Settings › Engine." };
    throw error;
  }
  const before = readDue(file);
  const kept = before?.engine === engineOf(engine) ? before.folders : [];
  writeDue(file, { engine: engineOf(engine), folders: [...new Set([...kept, ...waiting])] });
  // (The folder it opens first, its own, opens afresh for it.)
  await learnCompatibility(engine).catch(() => {});
  return { status: 200, waiting };
}

// One look at a time in this process; one asked for meanwhile goes after it.
let settling: Promise<void> | null = null;
let settleAgain = false;

/** The folders still to close (`run/models-due.json`) closed where their work is done now: as the
 * box hears its engine's events. Those the engine no longer has open open afresh anyway; a list
 * noted for an engine since restarted goes. Then what providers need learned again. */
export function settleDueModels(engine: Target & Pick<EngineRecord, "pid">, file = MODELS_DUE_FILE): Promise<void> {
  if (settling) {
    settleAgain = true;
    return settling;
  }
  settling = (async () => {
    // (Once `settling` is set: a call from here on waits for it, or has it look again.)
    await null;
    try {
      do {
        settleAgain = false;
        const due = readDue(file);
        if (!due) return;
        if (due.engine !== engineOf(engine)) return writeDue(file, null);
        const open = await openFolders(engine).catch(() => null);
        if (!open) return;
        const still = due.folders.filter(folder => open.includes(folder));
        const waiting = await closeQuiet(engine, still).catch(() => null);
        // One that can't close them at all keeps none for later.
        if (!waiting) return writeDue(file, null);
        // As it is now: one noted meanwhile stays.
        const now = readDue(file);
        const added = now?.engine === due.engine ? now.folders.filter(folder => !due.folders.includes(folder)) : [];
        writeDue(file, { engine: due.engine, folders: [...waiting, ...added] });
        if (waiting.length < still.length) await learnCompatibility(engine).catch(() => {});
      } while (settleAgain);
    } finally {
      // Cleared at once after its last look, with nothing in between: one asked for after starts anew.
      settling = null;
    }
  })();
  return settling;
}

/** Whether any folder waits to be closed (a quick look, before asking the engine). */
export const modelsDue = (file = MODELS_DUE_FILE): boolean => fs.existsSync(file);
