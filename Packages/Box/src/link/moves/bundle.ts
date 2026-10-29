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
import { asked, call } from "../engine/client";
import { BOTS, IS_MAC, K, SESSION_WAKES } from "../home";
import { hostTrash } from "../host-interface";
import { bundleOf } from "./records";

/** The most a move carries: past that it's refused before anything's held for long. */
export const MOST_BUNDLE = 1024 ** 3;

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
}

// A chat's folder here: conversations of no project (this Mac's app's own, a machine's in its box).
export const CHATS = IS_MAC ? path.join(path.dirname(K), "Chats") : path.join(K, "chats");

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
  const exports: unknown[] = [await call(engine, "GET", `/api/experimental/session/${encodeURIComponent(root)}/export`)];
  const next = [root];
  while (next.length) {
    const parent = next.pop()!;
    for (const child of await childrenOf(engine, parent)) {
      exports.push(await call(engine, "GET", `/api/experimental/session/${encodeURIComponent(child.id)}/export`));
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

/** The bundle made for move `id`: its file, size and hash. */
export async function pack(id: string, contents: Contents): Promise<{ file: string; size: number; hash: string }> {
  const folder = bundleOf(id);
  const staging = path.join(folder, "pack");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staging, "move.json"), JSON.stringify(contents), { mode: 0o600 });
  const file = path.join(folder, "bundle.tgz");
  const args = [...(process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : []), "-czf", file, "-C", staging, "move.json"];
  const original = contents.folder ? folderOf(contents.kind, contents.thing) : null;
  if (original) args.push("-C", path.dirname(original), path.basename(original));
  await run("tar", args);
  fs.rmSync(staging, { recursive: true, force: true });
  return { file, size: fs.statSync(file).size, hash: await hashOf(file) };
}

/** The bundle that came for move `id`, opened: what it holds, and the folder it brought (in the
 * move's own folder, until it's put in place). */
export async function unpack(id: string): Promise<{ contents: Contents; folder: string | null }> {
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
  if (brought && kind) plainOnly(brought);
  return { contents, folder: kind ? brought : null };
}

function plainOnly(folder: string): void {
  for (const name of fs.readdirSync(folder)) {
    const entry = path.join(folder, name);
    const kind = fs.lstatSync(entry);
    if (kind.isDirectory()) plainOnly(entry);
    else if (!kind.isFile()) throw new NotTaken(`It brought ${kind.isSymbolicLink() ? "a link" : "something that isn’t a file"} (${path.basename(entry)}), which isn’t taken.`);
  }
}

/** `folder` to Kuvo Code's trash here (on a Mac, on to the Finder's Trash), as a deleted bot goes. */
export async function toTrash(folder: string): Promise<void> {
  if (!fs.existsSync(folder)) return;
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
}

/** Each export into `engine` at `directory`, under its own ID (until `signal` gives up on it). */
export async function importAll(engine: Target, exports: unknown[], directory: string, signal?: AbortSignal): Promise<void> {
  for (const exported of exports) {
    if (!isObject(exported)) continue;
    // (One there already isn't replaced: what a move brought before goes first, `clearCopy`.)
    await call(engine, "POST", "/api/experimental/session/import", { info: exported.info, messages: exported.messages, location: { directory } }, signal);
  }
}

/** Gone from `engine`; one that isn't there is as good as gone. */
export async function deleteSession(engine: Target, id: string): Promise<void> {
  try {
    await call(engine, "DELETE", `/api/session/${encodeURIComponent(id)}`);
  } catch (error) {
    if (!/404|not found/i.test(String((error as Error | null)?.message ?? error))) throw error;
  }
}

/** A group chat on this box's bridge: `action` (hold, activate, release), its answer's data. */
export async function groupAction(bridge: Target, group: string, action: "hold" | "activate" | "release"): Promise<unknown> {
  const answer = await askGroups<{ data?: unknown; message?: unknown }>(bridge, "POST", `/${encodeURIComponent(group)}/${action}`, undefined, undefined);
  if (answer.status === 404 && action === "release") return null;
  if (answer.status !== 200) throw new Error(typeof answer.value?.message === "string" ? answer.value.message : `Its group chats answered ${answer.status}.`);
  return answer.value?.data ?? null;
}
