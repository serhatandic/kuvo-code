// The SSH agent each conversation's commands get in the sandbox (D9), from the process that holds
// the vault. The sandbox hides your SSH keys and your own agent from them; the keys you keep in the
// vault for a conversation (by its bot, its project or everyone) sign through an agent of its own
// instead, as `ssh`, git over SSH and `ssh-add` expect (`SSH_AUTH_SOCK`).
//
// The sandbox's launcher, which the engine runs each command through before the sandbox closes,
// notes the conversation (`run/ssh-for/<session>`, or `dir-<sum>` for a command of yours with
// none, by its folder's sum) where commands can't write; this sees the note and opens that
// conversation's agent in the agents' folder, under a name no one else's commands can list or
// guess, which the launcher hands the command. On macOS the sandbox lets a command reach its own
// agent's socket alone. Landlock can't refuse a socket, and shows every folder's names, so on Linux
// any conversation's commands could reach another's agent: there it offers only the keys you keep
// for everyone, until it can tell which conversation a connection comes from.

import crypto from "node:crypto";
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import type { VaultItem } from "../../shared/routes/vault";
import { listBots } from "../bots/list";
import { readBridgeFile, readEngineFile } from "../engine/client";
import { SSH_AGENTS, SSH_FOR } from "../home";
import { agentsUseVault } from "./gate";
import { type AgentKey, privateKeyOf, serveAgent } from "./ssh-agent";
import { isLocked, itemByID, pausedFor, readGrants, readItems, valuesOf } from "./store";
import { mayUse, noteUse } from "./use";
import { type Caller, callerOf, grantFor } from "./who";

/** An SSH key in the vault: a `key` item with a `private_key`. */
export const isSshKey = (item: VaultItem) => item.kind === "key" && item.fields.includes("private_key");

const sumOf = (text: string) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
const REFUSED_FOR = 30_000;
// Where any conversation's commands can reach any conversation's agent (see above).
const EVERYONE_ONLY = process.platform !== "darwin";
const NOTE = /^(ses_[A-Za-z0-9_]{1,80}|dir-[0-9a-f]{32})$/;

function callerFor(note: string, folder: string): () => Promise<Caller> {
  if (note.startsWith("ses_")) return async () => ({ ...(await callerOf(note, readEngineFile, readBridgeFile)), folder });
  return async () => {
    const bot = listBots().find(each => each.folder && (folder === each.folder || folder.startsWith(each.folder + path.sep)));
    return { folder, ...(bot ? { bot: bot.id, botName: bot.name, ...(bot.session ? { session: bot.session, root: bot.session } : {}) } : {}) };
  };
}

function sourceFor(caller: () => Promise<Caller>) {
  // Each key read once while it's the same item (values from the Keychain, or the store).
  const read = new Map<string, { changed: number; key: AgentKey | null }>();
  const asking = new Map<string, Promise<boolean>>();
  const refused = new Map<string, number>();
  return {
    keys: async (): Promise<AgentKey[]> => {
      if (!agentsUseVault() || isLocked()) return [];
      const who = await caller();
      if (pausedFor(who.bot, who.root ?? who.session)) return [];
      const keys: AgentKey[] = [];
      const grants = EVERYONE_ONLY ? readGrants().filter(grant => grant.who.everyone) : readGrants();
      for (const item of readItems()) {
        if (!isSshKey(item) || grantFor(item, who, grants) === null) continue;
        let kept = read.get(item.id);
        if (!kept || kept.changed !== item.changed) {
          try {
            kept = { changed: item.changed, key: { id: item.id, name: item.name, ...privateKeyOf((await valuesOf(item.id)).private_key ?? "") } };
          } catch {
            kept = { changed: item.changed, key: null };
          }
          read.set(item.id, kept);
        }
        if (kept.key) keys.push(kept.key);
      }
      return keys;
    },
    // One ask at a time per key, whichever of the conversation's commands signs: the others wait
    // for its answer. After a no, it's no for a little while, without asking again.
    allow: (key: AgentKey, signal: AbortSignal): Promise<boolean> => {
      if (Date.now() < (refused.get(key.id) ?? 0)) return Promise.resolve(false);
      let answer = asking.get(key.id);
      if (!answer) {
        answer = (async () => {
          const item = itemByID(key.id);
          if (!item || !agentsUseVault()) return false;
          const who = await caller();
          const allowed = await mayUse(item, who, { program: "ssh", signal });
          if (allowed.ok) noteUse(item, who, { program: "ssh" }, allowed.how);
          else refused.set(key.id, Date.now() + REFUSED_FOR);
          return allowed.ok;
        })().catch(() => false).finally(() => asking.delete(key.id));
        asking.set(key.id, answer);
      }
      return answer;
    },
  };
}

/**
 * Keeps each noted conversation's agent while agents may use the vault (one with no keys of its own
 * offers none, and a key added later is there at once), in the process that holds the vault.
 * Returns what stops them.
 */
export function keepSshAgents(): () => void {
  const agents = new Map<string, { folder: string; server: net.Server }>();
  const close = (note: string) => {
    const agent = agents.get(note);
    if (!agent) return;
    agent.server.close();
    agents.delete(note);
  };
  const look = () => {
    if (!agentsUseVault()) {
      for (const note of [...agents.keys()]) close(note);
      fs.rmSync(SSH_AGENTS, { recursive: true, force: true });
      return;
    }
    fs.mkdirSync(SSH_AGENTS, { recursive: true, mode: 0o700 });
    let notes: string[] = [];
    try { notes = fs.readdirSync(SSH_FOR).filter(name => NOTE.test(name)); } catch {}
    for (const note of notes) {
      let folder = "";
      try { folder = fs.readFileSync(path.join(SSH_FOR, note), "utf8"); } catch { continue; }
      // A note by folder names the folder whose sum it is: never another's.
      if (!path.isAbsolute(folder) || (note.startsWith("dir-") && note !== `dir-${sumOf(folder)}`)) continue;
      if (agents.get(note)?.folder === folder) continue;
      close(note);
      const prefix = sumOf(note).slice(0, 16);
      for (const old of fs.readdirSync(SSH_AGENTS)) if (old.startsWith(prefix)) fs.rmSync(path.join(SSH_AGENTS, old), { force: true });
      const socket = path.join(SSH_AGENTS, `${prefix}${crypto.randomBytes(9).toString("base64url")}.sock`);
      agents.set(note, { folder, server: serveAgent(socket, sourceFor(callerFor(note, folder))) });
    }
    for (const note of [...agents.keys()]) if (!notes.includes(note)) close(note);
  };
  fs.mkdirSync(SSH_FOR, { recursive: true, mode: 0o700 });
  // Sockets an earlier process left (killed before it could clear them): this one holds the vault now.
  fs.rmSync(SSH_AGENTS, { recursive: true, force: true });
  look();
  let watcher: fs.FSWatcher | null = null;
  try { watcher = fs.watch(SSH_FOR, () => look()); watcher.unref?.(); } catch {}
  // The vault's items and the sandbox change too: looked at again now and then.
  const every = setInterval(look, 30_000);
  every.unref?.();
  const stop = () => {
    watcher?.close();
    clearInterval(every);
    for (const note of [...agents.keys()]) close(note);
    try { fs.rmSync(SSH_AGENTS, { recursive: true, force: true }); } catch {}
  };
  // The box exits on SIGTERM without closing its servers: its agents go with it all the same.
  process.once("exit", stop);
  return stop;
}
