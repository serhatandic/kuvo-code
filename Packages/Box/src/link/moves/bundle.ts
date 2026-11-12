// What a move carries from one box to another, in one file (`bundle.tgz`): `move.json` (its
// conversations as the engine exports them, a bot's own keys, a group chat as its bridge held it)
// and its folder (a bot's, or a chat's wake-ups'). Made on the box it leaves, put in place on the box
// it goes to: its conversations under their own IDs, its folder where that box keeps them.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { MoveKind } from "../../shared/routes/moves";
import { answerBotKeys } from "../areas/bot-keys";
import { askGroups } from "../areas/groups";
import { chatNotes } from "../engine/chats";
import { asked, call } from "../engine/client";
import { BOTS, CHATS, IS_MAC, K, SESSION_WAKES } from "../home";
import { hostTrash } from "../host-interface";
import { bundleOf } from "./records";
import { filesSize, stageFiles, type CarriedQueues } from "../work-queue/moves";

/** The most a move carries (1 GB, as clients say sizes): past that it's refused before anything's
 * held for long. */
export const MOST_BUNDLE = 1_000_000_000;
/** How long a move waits on its engine or its group chats for one answer, at most: past that it
 * takes them for not answering (a move never hangs on them). */
export const ENGINE_WAIT = 2 * 60_000;
/** And for a conversation's whole export (a big one takes a while). */
const EXPORT_WAIT = 10 * 60_000;
/** `signal`, or `most` gone by, whichever comes first. */
export const engineWait = (signal?: AbortSignal, most = ENGINE_WAIT): AbortSignal => signal ? AbortSignal.any([signal, AbortSignal.timeout(most)]) : AbortSignal.timeout(most);

/** What `move.json` holds. */
export interface Contents {
  kind: MoveKind;
  thing: string;
  name: string;
  /** Root first, then its subagents', as the engine exports them (`{info, messages}`). */
  exports: unknown[];
  /** The folder's name in the bundle (a bot's ID, a chat's session), when it carries one. */
  folder?: string;
  /** A bot's own keys, by integration. */
  keys?: Record<string, Record<string, string>>;
  /** A group chat as its bridge held it. */
  group?: { group: unknown; messages: unknown };
  wasPaused: boolean;
  /** Its conversations' queues that are paused or have something waiting on the box, by session
   * (`packQueues`): a conversation you stopped stays stopped there, with what waits for it. */
  queues?: Record<string, unknown>;
  /** The calls its conversations made on Autopilot, by session. */
  decided?: Record<string, unknown>;
  /** It talks with a coding agent: its conversations are in the bundle's `carry` folder as the agents
   * bridge packed them (`exports` is empty), these. */
  lane?: { sessions: string[]; root: string };
  /** Its conversations' Work Queues, their files beside `move.json` (`work-queue/<item>`). */
  workQueue?: CarriedQueues;
  /** Where it was: the computer's name, and its folder (bots and chats). */
  was?: { place: string; folder?: string };
}

// A chat's folder here: conversations of no project (this Mac's app's own, a machine's in its box).
export { CHATS };

/** Where a thing's folder is kept on this box: a bot's, or a chat's wake-ups'. */
export const folderOf = (kind: MoveKind, thing: string): string | null => kind === "bot" ? path.join(BOTS, thing) : kind === "chat" ? path.join(SESSION_WAKES, thing) : null;

/** Where its conversations work on this box: a bot in its folder's workspace, a chat in the chats folder. */
export const directoryOf = (kind: MoveKind, thing: string): string => kind === "bot" ? path.join(BOTS, thing, "workspace") : CHATS;

/** `program arguments`, run; its output, or why it failed. */
function run(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // A Mac's tar adds its own files (`._…`) and attributes, which a Linux machine has no use for.
    const child = spawn(program, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
    let said = "";
    child.stderr.on("data", chunk => { said += chunk; });
    child.once("error", reject);
    child.once("exit", code => (code === 0 ? resolve() : reject(new Error(said.trim() || `${program} ended with ${code}`))));
  });
}

export async function hashOf(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("base64url");
}

/** The conversation and every subagent's under it, root first, as the engine exports them. */
export async function exportAll(engine: Target, root: string): Promise<unknown[]> {
  const exports: unknown[] = [await call(engine, "GET", `/api/experimental/session/${encodeURIComponent(root)}/export`, undefined, engineWait(undefined, EXPORT_WAIT))];
  const next = [root];
  while (next.length) {
    const parent = next.pop()!;
    for (const child of await childrenOf(engine, parent)) {
      exports.push(await call(engine, "GET", `/api/experimental/session/${encodeURIComponent(child.id)}/export`, undefined, engineWait(undefined, EXPORT_WAIT)));
      next.push(child.id);
    }
  }
  return exports;
}

/** Every subagent's conversation `parent` started, page after page (the engine gives 100 at a time). */
async function childrenOf(engine: Target, parent: string): Promise<{ id: string }[]> {
  const all: { id: string }[] = [];
  const seen = new Set<string>();
  let route = `api/session?parentID=${encodeURIComponent(parent)}&limit=100&order=desc`;
  for (;;) {
    const page = await asked(engine, "GET", route) as { data?: unknown; cursor?: { next?: unknown } } | null;
    const listed = (Array.isArray(page?.data) ? page.data : []).filter((one): one is { id: string } => isObject(one) && typeof one.id === "string" && !seen.has(one.id));
    for (const one of listed) seen.add(one.id);
    all.push(...listed);
    const next = page?.cursor?.next;
    if (listed.length === 0 || (Array.isArray(page?.data) && page.data.length < 100) || typeof next !== "string") return all;
    route = `api/session?parentID=${encodeURIComponent(parent)}&limit=100&cursor=${encodeURIComponent(next)}`;
  }
}

/** What's wrong with a bundle that came, in words that may be said back to the box that sent it
 * (anything else that goes wrong as it's set up is this box's own business). */
export class NotTaken extends Error {}

/** Whether `exports` are one conversation and its subagents', rooted at `root`: each its own ID,
 * once; one with no parent, `root`; every other's parent among them. */
export function ownTree(exports: unknown[], root: string): boolean {
  const infos = exports.map(each => (isObject(each) && isObject(each.info) ? each.info : null));
  const ids = infos.map(info => info?.id);
  if (!root || !ids.length || ids.some(id => typeof id !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(id)) || new Set(ids).size !== ids.length || !ids.includes(root)) return false;
  return infos.every(info => (info!.id === root ? info!.parentID == null : typeof info!.parentID === "string" && ids.includes(info!.parentID)));
}

/** Each export's session ID, root first. */
export const idsOf = (exports: unknown[]): string[] => exports.flatMap(each => {
  const id = isObject(each) && isObject(each.info) ? each.info.id : null;
  return typeof id === "string" ? [id] : [];
});

/** A conversation's fingerprint as exported: its sessions and their messages, word for word, kept
 * instead of the whole of it to see whether anything changed. */
export function conversationHash(exports: unknown[]): string {
  const hash = crypto.createHash("sha256");
  for (const each of exports) hash.update(JSON.stringify(isObject(each) ? [isObject(each.info) ? each.info.id : null, each.messages ?? null] : null)).update("\n");
  return hash.digest("base64url");
}

/** A bot's own keys here, by integration (null when they can't be read now). */
export async function keysOf(bot: string): Promise<Record<string, Record<string, string>> | null> {
  const listed = await answerBotKeys("GET", `kuvo/bots/${bot}/keys`, null, null);
  const each = (listed.value as { keys?: unknown } | null)?.keys;
  if (listed.status !== 200 || !Array.isArray(each)) return listed.status === 409 ? {} : null;
  const keys: Record<string, Record<string, string>> = {};
  for (const entry of each as { integration?: unknown; own?: unknown }[]) {
    if (entry.own !== true || typeof entry.integration !== "string") continue;
    const read = await answerBotKeys("GET", `kuvo/bots/${bot}/keys/${encodeURIComponent(entry.integration)}`, null, null);
    const values = (read.value as { keys?: unknown } | null)?.keys;
    if (read.status !== 200 || !isObject(values)) return null;
    keys[entry.integration] = values as Record<string, string>;
  }
  return keys;
}

/** What `pack` throws for one more than `MOST_BUNDLE`, before it packs any of it. */
export class TooBig extends Error {}

/** The bytes in `folder`'s files, counted until there are more than `most` (links not followed). */
function bytesIn(folder: string, most: number, counted = 0): number {
  let names: string[] = [];
  try { names = fs.readdirSync(folder); } catch { return counted; }
  for (const name of names) {
    if (counted > most) break;
    let entry: fs.Stats;
    try { entry = fs.lstatSync(path.join(folder, name)); } catch { continue; }
    counted = entry.isDirectory() ? bytesIn(path.join(folder, name), most, counted) : counted + entry.size;
  }
  return counted;
}

/** The bundle made for move `id`: its file, size and hash. One whose files come to more than
 * `MOST_BUNDLE` isn't packed (`TooBig`). */
export async function pack(id: string, contents: Contents): Promise<{ file: string; size: number; hash: string }> {
  const folder = bundleOf(id);
  const staging = path.join(folder, "pack");
  const moveJSON = JSON.stringify(contents);
  const original = contents.folder ? folderOf(contents.kind, contents.thing) : null;
  const carried = contents.lane ? path.join(folder, "carry") : null;
  if (Buffer.byteLength(moveJSON) + (original ? bytesIn(original, MOST_BUNDLE) : 0) + (carried ? bytesIn(carried, MOST_BUNDLE) : 0) + filesSize(contents.workQueue) > MOST_BUNDLE) throw new TooBig();
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staging, "move.json"), moveJSON, { mode: 0o600 });
  const queueFiles = stageFiles(contents.workQueue, staging);
  const file = path.join(folder, "bundle.tgz");
  const args = [...(process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : []), "-czf", file, "-C", staging, "move.json", ...(queueFiles ? ["work-queue"] : [])];
  if (original) args.push("-C", path.dirname(original), path.basename(original));
  if (carried) args.push("-C", folder, "carry");
  await run("tar", args);
  fs.rmSync(staging, { recursive: true, force: true });
  if (carried) fs.rmSync(carried, { recursive: true, force: true });
  return { file, size: fs.statSync(file).size, hash: await hashOf(file) };
}

/** The bundle that came for move `id`, opened: what it holds, and the folder it brought (in the
 * move's own folder, until it's put in place). */
export async function unpack(id: string): Promise<{ contents: Contents; folder: string | null; carry: string | null; opened: string }> {
  const folder = bundleOf(id);
  const opened = path.join(folder, "opened");
  fs.rmSync(opened, { recursive: true, force: true });
  fs.mkdirSync(opened, { recursive: true, mode: 0o700 });
  await run("tar", ["-xzf", path.join(folder, "bundle.tgz"), "-C", opened]).catch(() => { throw new NotTaken("What came isn’t a move."); });
  // A file of its own, read as it came (never through a link, to a file of this computer's), and
  // what's wrong with it never said back.
  let contents: Contents;
  try {
    const file = path.join(opened, "move.json");
    if (!fs.lstatSync(file).isFile()) throw new Error();
    contents = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new NotTaken("What came isn’t a move.");
  }
  if (!isObject(contents) || !Array.isArray(contents.exports)) throw new NotTaken("What came isn’t a move.");
  const brought = contents.folder && /^[A-Za-z0-9_]+$/.test(contents.folder) ? path.join(opened, contents.folder) : null;
  // Only files and folders: never a link (to somewhere else on this computer) or anything else, the
  // folder itself included (it's put in place, and written to, where it is).
  let kind: fs.Stats | null = null;
  if (brought) try { kind = fs.lstatSync(brought); } catch {}
  if (kind && !kind.isDirectory()) throw new NotTaken(`It brought ${kind.isSymbolicLink() ? "a link" : "something that isn’t a folder"} for its folder, which isn’t taken.`);
  if (brought && kind) plainOnly(brought, true);
  // (The agents bridge checks each of these against what it says they are.)
  const carried = path.join(opened, "carry");
  let carry: string | null = null;
  if (contents.lane) {
    try {
      if (fs.lstatSync(carried).isDirectory()) carry = carried;
    } catch {}
    if (!carry) throw new NotTaken("Its conversation didn’t come with it.");
    // (A conversation never has a link: the agents bridge sends none.)
    plainOnly(carried, false);
  }
  // The Work Queue's files: plain files only.
  const queueFiles = path.join(opened, "work-queue");
  let queueKind: fs.Stats | null = null;
  try { queueKind = fs.lstatSync(queueFiles); } catch {}
  if (queueKind && !queueKind.isDirectory()) throw new NotTaken("It brought something that isn’t a folder for its Work Queue’s files, which isn’t taken.");
  if (queueKind) plainOnly(queueFiles, false);
  return { contents, folder: kind ? brought : null, carry, opened };
}

/** Whether `entry`, in the folder `root`, goes as it is: a file or folder, or a relative link to
 * something in that folder (a project's `node_modules/.bin`, say), which goes on pointing there.
 * Such a link never climbs out of the folder on its way (so it means the same wherever the folder
 * is), and, followed as the computer follows it (through any other link on the way), ends in it. */
function goesAsIs(root: string, entry: string, kind: fs.Stats): boolean {
  if (kind.isFile() || kind.isDirectory()) return true;
  if (!kind.isSymbolicLink()) return false;
  let target: string;
  try { target = fs.readlinkSync(entry); } catch { return false; }
  if (path.isAbsolute(target)) return false;
  let depth = path.relative(root, path.dirname(entry)).split(path.sep).filter(part => part && part !== ".").length;
  for (const part of target.split("/")) {
    if (part === "..") depth -= 1;
    else if (part && part !== ".") depth += 1;
    if (depth < 0) return false;
  }
  // (`.native`: the plain one reads a `..` as text, not after the link before it.)
  try { return fs.realpathSync.native(entry).startsWith(fs.realpathSync.native(root) + path.sep); } catch { return false; }
}

/** The first thing in `folder` that can't go to another computer (a link out of it, or something
 * that isn't a file), by its path in it; null when there's none, or when there's more than `most`
 * to look through (looked for again as it's packed). */
export function notPlainIn(folder: string, most = Infinity): { path: string; link: boolean } | null {
  const left = [""];
  let looked = 0;
  while (left.length) {
    const at = left.pop()!;
    let names: string[];
    try { names = fs.readdirSync(path.join(folder, at)); } catch { continue; }
    for (const name of names) {
      if (++looked > most) return null;
      const inside = at ? path.join(at, name) : name;
      let kind: fs.Stats;
      try { kind = fs.lstatSync(path.join(folder, inside)); } catch { continue; }
      if (kind.isDirectory()) left.push(inside);
      else if (!goesAsIs(folder, path.join(folder, inside), kind)) return { path: inside, link: kind.isSymbolicLink() };
    }
  }
  return null;
}

/** Only files and folders, and with `links` relative links within `root`: never a link to somewhere
 * else on this computer, or anything else. */
function plainOnly(folder: string, links: boolean, root = folder): void {
  for (const name of fs.readdirSync(folder)) {
    const entry = path.join(folder, name);
    const kind = fs.lstatSync(entry);
    if (kind.isDirectory()) plainOnly(entry, links, root);
    else if (!(links ? goesAsIs(root, entry, kind) : kind.isFile())) throw new NotTaken(`It brought ${kind.isSymbolicLink() ? "a link" : "something that isn’t a file"} (${path.basename(entry)}), which isn’t taken.`);
  }
}

/** `folder` to Kuvo Code's trash here (on a Mac, on to the Finder's Trash), as a deleted bot goes:
 * where it is now, while that's this box's trash. */
export async function toTrash(folder: string): Promise<string | undefined> {
  if (!fs.existsSync(folder)) return undefined;
  const now = new Date();
  const two = (number: number) => String(number).padStart(2, "0");
  const when = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const trash = path.join(K, "trash", `${when}-${process.pid}`);
  fs.mkdirSync(trash, { recursive: true });
  const trashed = path.join(trash, path.basename(folder));
  fs.renameSync(folder, trashed);
  if (IS_MAC) {
    await hostTrash(trashed).catch(() => {});
    if (!fs.existsSync(trashed)) try { fs.rmdirSync(trash); } catch {}
  }
  return fs.existsSync(trashed) ? trashed : undefined;
}

/** Each export into `engine` at `directory`, under its own ID (until `signal` gives up on it). */
export async function importAll(engine: Target, exports: unknown[], directory: string, signal?: AbortSignal): Promise<void> {
  for (const exported of exports) {
    if (!isObject(exported)) continue;
    // (One there already isn't replaced: what a move brought before goes first, `clearCopy`.) A
    // chat's mark as it is here, from the first: kept where it lands among this box's chats, taken
    // off anywhere else.
    const info = isObject(exported.info) ? { ...exported.info, metadata: chatNotes(exported.info.metadata, directory) } : exported.info;
    await call(engine, "POST", "/api/experimental/session/import", { info, messages: exported.messages, location: { directory } }, signal);
  }
}

/** Gone from `engine`; one that isn't there is as good as gone. */
export async function deleteSession(engine: Target, id: string): Promise<void> {
  try {
    await call(engine, "DELETE", `/api/session/${encodeURIComponent(id)}`, undefined, engineWait());
  } catch (error) {
    if ((error as { status?: number } | null)?.status !== 404 && !/404|not found/i.test(String((error as Error | null)?.message ?? error))) throw error;
  }
}

/** A group chat on this box's bridge: `action` (hold, activate, release), its answer's data. */
export async function groupAction(bridge: Target, group: string, action: "hold" | "activate" | "release"): Promise<unknown> {
  const answer = await askGroups<{ data?: unknown; message?: unknown }>(bridge, "POST", `/${encodeURIComponent(group)}/${action}`, undefined, engineWait());
  if (answer.status === 404 && action === "release") return null;
  if (answer.status !== 200) throw Object.assign(new Error(typeof answer.value?.message === "string" ? answer.value.message : `Its group chats answered ${answer.status}.`), { status: answer.status });
  return answer.value?.data ?? null;
}
