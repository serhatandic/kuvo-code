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
import { watchFolder } from "../../shared/watch";
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
const NOTE_KEPT = 30 * 24 * 60 * 60_000;
const IDLE = 60 * 60_000;

/** Whether the agents' folder is in a folder that's this user's alone: on a Mac, `/tmp/kuvo-ssh-<uid>`,
 * which anyone could have made first (a folder, not a link, owned by you, `0700`), or none yet. */
function safeFolder(): boolean {
  if (process.platform !== "darwin") return true;
  const parent = path.dirname(SSH_AGENTS);
  try {
    const seen = fs.lstatSync(parent);
    return seen.isDirectory() && seen.uid === process.getuid?.() && (seen.mode & 0o077) === 0;
  } catch {
    return true;
  }
}
// Where any conversation's commands can reach any conversation's agent (see above).
const EVERYONE_ONLY = process.platform !== "darwin";
const NOTE = /^(ses_[A-Za-z0-9_]{1,80}|dir-[0-9a-f]{32})$/;

const real = (where: string) => { try { return fs.realpathSync(where); } catch { return path.resolve(where); } };

// Who the conversation a note names is: the engine's word for a session (its folder, which the note
// must name too), or for a command of yours, the bot whose folder it's in. Null: no one's keys.
function callerFor(note: string, folder: string): () => Promise<Caller | null> {
  if (note.startsWith("ses_")) return async () => {
    const who = await callerOf(note, readEngineFile, readBridgeFile);
    return who.folder && real(who.folder) === real(folder) ? who : null;
  };
  return async () => {
    const bot = listBots().find(each => each.folder && (folder === each.folder || folder.startsWith(each.folder + path.sep)));
    return { folder, yours: true, ...(bot ? { bot: bot.id, botName: bot.name, ...(bot.session ? { session: bot.session, root: bot.session } : {}) } : {}) };
  };
}

function sourceFor(caller: () => Promise<Caller | null>) {
  // Each key read once while it's the same item (values from the Keychain, or the store), and
  // forgotten while the vault is locked or the conversation paused.
  const read = new Map<string, { changed: number; key: AgentKey | null }>();
  const asking = new Map<string, { answer: Promise<boolean>; waiting: number; stop: AbortController }>();
  const refused = new Map<string, number>();
  const leftUndone = new Map<string, number>();
  // Where any conversation's commands could reach this agent, it's asked as no one: only what you
  // keep for everyone, never a bot's or a project's. Only whether it's on Autopilot is taken from what
  // it says it is, as that can only leave a use undone. And that's the conversation to watch meanwhile.
  const asked = async (): Promise<{ who: Caller | null; watch?: string }> => {
    const said = await caller();
    return { who: EVERYONE_ONLY ? (said?.autopilot ? { autopilot: true } : {}) : said, ...(said?.session && !said.yours ? { watch: said.session } : {}) };
  };
  return {
    keys: async (): Promise<AgentKey[]> => {
      const who = agentsUseVault() && !isLocked() ? await caller() : null;
      if (!who || pausedFor(who.bot, who.root ?? who.session)) {
        read.clear();
        return [];
      }
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
    // One ask at a time per key, whichever of the conversation's commands signs: the others wait for
    // its answer, and it's taken back only when every one of them has gone. After your no, it's no
    // for a little while, without asking again.
    allow: (key: AgentKey, signal: AbortSignal): Promise<boolean> => {
      if (Date.now() < (refused.get(key.id) ?? 0)) return Promise.resolve(false);
      let open = asking.get(key.id);
      if (!open) {
        const stop = new AbortController();
        const answer = (async () => {
          const item = itemByID(key.id);
          const { who, watch } = await asked();
          if (!item || !who || !agentsUseVault()) return false;
          const allowed = await mayUse(item, who, { program: "ssh", signal: stop.signal, watch, leftUndoneNoted: Date.now() < (leftUndone.get(key.id) ?? 0) });
          if (allowed.ok) noteUse(item, who, { program: "ssh" }, allowed.how);
          // (Left undone on Autopilot isn't your no: turned back, it asks. Noted once a while: a
          // command signing again and again isn't that many things left.)
          else if (allowed.leftUndone) leftUndone.set(key.id, Date.now() + REFUSED_FOR);
          else if (!stop.signal.aborted) refused.set(key.id, Date.now() + REFUSED_FOR);
          return allowed.ok;
        })().catch(() => false).finally(() => asking.delete(key.id));
        open = { answer, waiting: 0, stop };
        asking.set(key.id, open);
      }
      const it = open;
      it.waiting++;
      const gone = () => { if (--it.waiting === 0) it.stop.abort(); };
      signal.addEventListener("abort", gone, { once: true });
      return it.answer.finally(() => signal.removeEventListener("abort", gone));
    },
  };
}

/**
 * Keeps each noted conversation's agent while agents may use the vault (one with no keys of its own
 * offers none, and a key added later is there at once), in the process that holds the vault.
 * Returns what stops them.
 */
export function keepSshAgents(watch = watchFolder): () => void {
  const agents = new Map<string, { folder: string; server: net.Server; used: number }>();
  const close = (note: string) => {
    const agent = agents.get(note);
    if (!agent) return;
    agent.server.close();
    agents.delete(note);
  };
  const look = () => {
    try {
      lookNow();
    } catch (error) {
      console.error(`Kuvo Code's SSH agents couldn't be kept (${SSH_AGENTS}): ${error instanceof Error ? error.message : error}`);
    }
  };
  const lookNow = () => {
    if (!agentsUseVault() || !safeFolder()) {
      for (const note of [...agents.keys()]) close(note);
      if (safeFolder()) fs.rmSync(SSH_AGENTS, { recursive: true, force: true });
      return;
    }
    fs.mkdirSync(SSH_AGENTS, { recursive: true, mode: 0o700 });
    // An agent no command used for a while goes, with its note: the conversation's next command
    // notes it again.
    for (const [note, agent] of agents) {
      if (Date.now() - agent.used < IDLE) continue;
      close(note);
      fs.rmSync(path.join(SSH_FOR, note), { force: true });
    }
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
      const agent = { folder, server: serveAgent(socket, sourceFor(callerFor(note, folder))), used: Date.now() };
      agent.server.on("connection", () => { agent.used = Date.now(); });
      // One that couldn't open (its socket couldn't be put at its name) is made anew at the next look.
      agent.server.on("error", () => { if (agents.get(note) === agent) agents.delete(note); });
      agents.set(note, agent);
    }
    for (const note of [...agents.keys()]) if (!notes.includes(note)) close(note);
  };
  try {
    fs.mkdirSync(SSH_FOR, { recursive: true, mode: 0o700 });
    // Sockets an earlier process left (killed before it could clear them): this one holds the vault now.
    if (safeFolder()) fs.rmSync(SSH_AGENTS, { recursive: true, force: true });
    // Notes of conversations long gone (a note is written once, so one still going is noted again by
    // its next command).
    for (const note of fs.readdirSync(SSH_FOR)) {
      try { if (Date.now() - fs.statSync(path.join(SSH_FOR, note)).mtimeMs > NOTE_KEPT) fs.rmSync(path.join(SSH_FOR, note), { force: true }); } catch {}
    }
  } catch {}
  let watcher: fs.FSWatcher | null = null;
  try { watcher = watch(SSH_FOR, () => look()); watcher.unref?.(); } catch {}
  look();
  // On a busy Mac the watch tells late or not at all, and the launcher waits for the agent only a
  // moment before the command runs without it (git over SSH then finds no key): the notes' folder
  // is looked at each second too (its time, which a note moved in changes), and looked into when
  // it changed.
  // (Its time, change time and size together; and while its time is this very second, each time:
  // a folder whose times count whole seconds changes them once in a second.)
  let noted = "";
  const quick = setInterval(() => {
    let seen: fs.Stats;
    try { seen = fs.statSync(SSH_FOR); } catch { return; }
    const changed = `${seen.mtimeMs}:${seen.ctimeMs}:${seen.size}`;
    if (changed === noted && Date.now() - seen.mtimeMs > 1500) return;
    noted = changed;
    look();
  }, 1000);
  quick.unref?.();
  // The vault's items and the sandbox change too: looked at again now and then.
  const every = setInterval(look, 30_000);
  every.unref?.();
  const stop = () => {
    watcher?.close();
    clearInterval(quick);
    clearInterval(every);
    for (const note of [...agents.keys()]) close(note);
    try { if (safeFolder()) fs.rmSync(SSH_AGENTS, { recursive: true, force: true }); } catch {}
  };
  // The box exits on SIGTERM without closing its servers: its agents go with it all the same.
  process.once("exit", stop);
  return stop;
}
