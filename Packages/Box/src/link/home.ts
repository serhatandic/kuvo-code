// This box's home: its folder and the files every part of it reads, and what kind of box it is
// (a machine's, in `~/.kuvo-code`; or this Mac's, which its app starts in a folder of its own).

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The home folder, as its HOME names it (as the shell and the engine have it), read each time: a
 * test's own HOME counts under Bun too, which otherwise keeps the one it started with. */
export function homeFolder(): string {
  return process.env.HOME || os.homedir();
}

let account: { name: string; home: string } | undefined;
/** Your account as the system has it, whatever HOME and USER say (Bun's `os.userInfo()` follows
 * them, and a machine's keeper starts the engine with neither USER nor LOGNAME): `id -P` on macOS,
 * `getent passwd` on Linux, the password file without it. */
function accountEntry(): { name: string; home: string } {
  if (account) return account;
  // (Never `os.userInfo()` alone: it throws for an account with no passwd entry, as a container's.)
  const uid = process.getuid?.() ?? -1;
  let line: string | undefined;
  if (process.platform === "darwin") {
    line = spawnSync("/usr/bin/id", ["-P"], { encoding: "utf8", timeout: 5000 }).stdout;
  } else {
    line = spawnSync("getent", ["passwd", String(uid)], { encoding: "utf8", timeout: 5000 }).stdout;
    if (!line?.trim()) {
      try { line = fs.readFileSync("/etc/passwd", "utf8").split("\n").find(each => each.split(":")[2] === String(uid)); } catch {}
    }
  }
  const fields = line?.trim().split(":") ?? [];
  let home = fields[process.platform === "darwin" ? 8 : 5] || "";
  if (!path.isAbsolute(home)) try { home = os.userInfo().homedir; } catch { home = homeFolder(); }
  account = { name: fields[0] || "", home };
  return account;
}

/** Your account's own home folder, as the system has it, whatever HOME says. */
export function accountHome(): string {
  return accountEntry().home;
}

/** Your account's name, as the system has it (zsh's `%n`), whatever USER says: empty when it has
 * none (an account with no passwd entry). */
export function accountName(): string {
  return accountEntry().name;
}

export const K = process.env.KUVO_HOME || path.join(homeFolder(), ".kuvo-code");

/** Your own data folder (`XDG_DATA_HOME`, else `~/.local/share`), as apps other than Kuvo Code's
 * read it: on a machine, the box's points into Kuvo Code's folder, and yours is what its launch
 * kept (`KUVO_OWN_XDG_DATA_HOME`, empty for none). */
export function ownDataHome(env: NodeJS.ProcessEnv = process.env, home = homeFolder()): string {
  const own = "KUVO_OWN_XDG_DATA_HOME" in env ? env.KUVO_OWN_XDG_DATA_HOME
    : env.XDG_DATA_HOME && !path.resolve(env.XDG_DATA_HOME).startsWith(path.resolve(K)) ? env.XDG_DATA_HOME : undefined;
  return own && path.isAbsolute(own) ? own : path.join(home, ".local", "share");
}

/**
 * Where an opencode used apart from Kuvo Code keeps its sign-ins, on both systems: in its data
 * folder (`ownDataHome`).
 */
export function opencodeAuthFile(home = homeFolder(), env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ownDataHome(env, home), "opencode", "auth.json");
}

export const RUN = path.join(K, "run");
export const LINK_FILE = path.join(RUN, "link.json");
export const ENGINE_FILE = path.join(RUN, "engine.json");
// The coding agents' bridge beside the engine (kuvo-agents.js): its port and password.
export const BRIDGE_FILE = path.join(RUN, "bridge.json");
export const PID_FILE = path.join(RUN, "link.pid");
// While it's there, the box's keeper keeps this bridge running (`bin/kuvo-start keep`).
export const NEEDED_FILE = path.join(RUN, "link.needed");
export const VERSION_FILE = path.join(RUN, "link.version");
// What every process that connects to the box's own sockets (the vault's, the browser's keeper's)
// gives first: Kuvo Code's processes read it here, a command in the sandbox can't (it can connect
// to a socket it can't read the folder of). The same in kuvo-browser.js.
export const SOCKET_KEY_FILE = path.join(RUN, "socket.key");
/** Where the sandbox's launcher notes each conversation for its SSH agent (vault/ssh.ts), and where
 * the agents are, both out of commands' sight (not in `run/fence`, which they read): a machine's in
 * its own folder. A socket's path is at most 104 bytes on macOS, so this Mac's app's are in Kuvo
 * Code's short folder in `/tmp` (one per box), which the sandbox refuses but each command's own; as
 * are those of a box on a Mac whose folder is too deep for them (a test's). */
export const SSH_FOR = path.join(RUN, "ssh-for");
const OWN_SSH_AGENTS = path.join(RUN, "ssh-agents");
// (68 bytes, to be safe: what a socket's path leaves for its folder, with a slash and its name, vault/ssh.ts.)
export const SSH_AGENTS = process.platform === "darwin" && (process.env.KUVO_BOX === "mac" || Buffer.byteLength(OWN_SSH_AGENTS) > 68)
  ? path.join("/private/tmp", `kuvo-ssh-${os.userInfo().uid}`, `agents-${crypto.createHash("sha256").update(K).digest("hex").slice(0, 8)}`)
  : OWN_SSH_AGENTS;
/** What the engine tells its agents of the sandbox, as it's on here or not (fence/state.ts writes it),
 * named in the settings each box starts its engine with (engine/compatibility.ts). */
export const SANDBOX_NOTE = path.join(RUN, "fence", "agents.md");

const KEY_SHAPE = /^[0-9a-f]{64}$/;
const madeKey = () => crypto.randomBytes(32).toString("hex") + "\n";

/** The key for the box's sockets, made once (whole, before anyone can read it). */
export function socketKey(): string {
  try {
    const key = fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim();
    if (KEY_SHAPE.test(key)) return key;
  } catch {}
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const made = `${SOCKET_KEY_FILE}.${process.pid}`;
  fs.writeFileSync(made, madeKey(), { mode: 0o600 });
  // Linked into place: whoever made it first, the others take theirs. (One that isn't a key at all
  // is replaced, as it is where a folder can't link files.)
  try { fs.linkSync(made, SOCKET_KEY_FILE); } catch {
    let there = "";
    try { there = fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim(); } catch {}
    if (!KEY_SHAPE.test(there)) try { fs.renameSync(made, SOCKET_KEY_FILE); } catch {}
  }
  fs.rmSync(made, { force: true });
  return fs.readFileSync(SOCKET_KEY_FILE, "utf8").trim();
}

/** Whether `given` is the key for the box's sockets. */
export function isSocketKey(given: unknown): boolean {
  if (typeof given !== "string") return false;
  let key: Buffer;
  try { key = Buffer.from(socketKey()); } catch { return false; }
  const said = Buffer.from(given);
  return said.length === key.length && crypto.timingSafeEqual(said, key);
}

// COMPAT(0.7 settings): until a Mac adopts them (`adoptBox`), a machine's settings are the ones an older Mac's start left. Goes 3 months after 0.8.0.
// A machine's own settings and keys, in a folder of their own (`box`), which no older Kuvo Code
// writes: the engine reads the file (`OPENCODE_CONFIG`, over the global one) and reloads it when it
// changes. Before a Mac made them the machine's own (`adoptBox`), its Mac's.
export const BOX = path.join(K, "box");
// The box's folder as its settings name it: "~/.kuvo-code", as the Mac's start wrote key paths.
const home = homeFolder();
export const shownRoot = K.startsWith(home + "/") ? "~" + K.slice(home.length) : K;

// Its integrations' keys (KUVO_KEY_…), and its bots' own.
export const BOX_KEYS = path.join(BOX, "keys");
// Bots' own keys (`answerBotKeys`), the box's own beside its shared ones: a start from a Mac
// replaces what it sent in `keys`, and leaves `box` alone.
export const BOT_KEYS = path.join(K, "box", "bot-keys");
// What the box's own updates keep: the files a rollback puts back, what was installed.
export const UPDATES = path.join(K, "updates");
/** What was said in each conversation, kept to search it (`kuvo/search`) until its session changes. */
export const SEARCH = path.join(K, "search");
// What integrations' servers keep (a sign-in), where the engine runs them with it (KUVO_INTEGRATIONS:
// this Mac's in the app's own folder, a machine's in `integrations`).
export const INTEGRATION_DATA = process.env.KUVO_INTEGRATIONS || path.join(K, "integrations");
// The engine's own data (its sessions' database, and where new worktrees go): in this box's folder
// on a machine, in the app's on a Mac (KUVO_ENGINE_DATA).
export const ENGINE_DATA = process.env.KUVO_ENGINE_DATA || path.join(K, "data", "opencode");
// Conversations' own wake-ups and watches, beside them as `kuvo-wake` keeps them, and kuvo-wake
// itself: in this box's folder on a machine, the app's on a Mac (KUVO_WAKES, KUVO_WAKE_COMMAND).
export const SESSION_WAKES = process.env.KUVO_WAKES || path.join(K, "wakes");
export const WAKE_COMMAND = process.env.KUVO_WAKE_COMMAND || path.join(K, "bin", "kuvo-wake");
// This Mac's: the files its app writes its Keychain's keys to, which the engine reads (KUVO_KEYS);
// null on a machine.
export const APP_KEY_FILES = process.env.KUVO_KEYS ? process.env.KUVO_KEYS.replace(/\/+$/, "") : null;
// Where a folder really is, as the system names it: through links, and in its own letters (a Mac's
// disk doesn't count case). As it reads when it isn't there.
export function located(folder: string): string {
  try { return fs.realpathSync.native(folder); } catch { return path.resolve(folder); }
}
// A real box's folder, never a test's: a machine's own `~/.kuvo-code` (your account's home, as the
// system has it: tests give HOME a folder of their own), or a Mac app's (`run.kuvo.code…/box`, any
// copy's), however it's named.
export const REAL_BOX = (() => {
  const home = located(K);
  return home === located(path.join(accountHome(), ".kuvo-code")) || path.basename(path.dirname(home)).toLowerCase().startsWith("run.kuvo.code");
})();
// A test's folder, where a test's stand-ins for npm and GitHub are taken.
export const IN_TEST_FOLDER = !REAL_BOX;
// The engine's settings and keys change one at a time, whoever changes them.
export const CONFIG_LOCK = path.join(RUN, ".config.lock");

// A Mac's box finds them where its app keeps them, as the engine does (KUVO_BOTS, KUVO_WAKES, and the
// app's own kuvo-wake); a machine's, in its folder.
export const BOTS = process.env.KUVO_BOTS || path.join(K, "bots");
// Its chats (conversations of no project): where a Mac's app keeps them (KUVO_CHATS), a machine's in
// its folder.
export const CHATS = process.env.KUVO_CHATS || path.join(K, "chats");

// This Mac's box: the Mac app's own Attachments folder (BoxProcess gives it, KUVO_MAC_ATTACHMENTS),
// where it keeps the files its sessions sent a folder for each session, as the box keeps its own:
// they go with their session here too (`letAttachmentsGo`).
export const MAC_ATTACHMENTS = process.env.KUVO_MAC_ATTACHMENTS || null;

/** Where sessions' files are kept, a folder each: this box's, and on this Mac's box, the Mac app's. */
export const attachmentRoots = (): string[] => [path.join(K, "attachments"), ...(MAC_ATTACHMENTS ? [MAC_ATTACHMENTS] : [])];

// This Mac's box (BoxProcess says so as it starts it, `KUVO_BOX=mac`): its bots are the Mac's own,
// made with the kit its app gives it and told they run on this Mac; it names no machine, keeps no
// notes for a Mac to take in, and goes by the Mac's own clock. Its settings are the app's engine's,
// where they've always been (KUVO_ENGINE_CONFIG, the engine's XDG_CONFIG_HOME), its own from the
// start; its keys are in the Mac's Keychain, which the engine reads from the files the app writes
// them to (KUVO_KEYS); and the servers that use a Mac's own apps run here.
export const IS_MAC = process.env.KUVO_BOX === "mac";
// The versions of this Mac's app and of the engine it brings, as the app that started it says
// (BoxProcess: KUVO_APP_VERSION, KUVO_ENGINE_VERSION), for what it says of itself with the app closed.
export const MAC_APP_VERSION = process.env.KUVO_APP_VERSION || null;
export const MAC_ENGINE_VERSION = process.env.KUVO_ENGINE_VERSION || null;
// This box's computer, as what it says names it.
export const HERE = IS_MAC ? "this Mac" : "this machine";
// Where its engine's settings are: this Mac's app's engine's (a machine's are in `box`).
export const ENGINE_CONFIG = process.env.KUVO_ENGINE_CONFIG;
// (This Mac's box has them there, always: BoxProcess gives both.)
if (IS_MAC && !ENGINE_CONFIG) throw new Error("This Mac's box was started without KUVO_ENGINE_CONFIG, the folder its engine's settings are in.");

// This Mac's app's host interface, as it was given when the box started (`KUVO_HOST_URL`,
// `KUVO_HOST_PASSWORD`), which it uses while there's no `run/host.json` (host-interface.ts): its
// password out of the environment here, as the box loads, before anything copies the environment
// for what it runs (git, kuvo-wake), so nothing it runs has it.
export const LAUNCH_HOST = process.env.KUVO_HOST_URL && process.env.KUVO_HOST_PASSWORD
  ? { url: process.env.KUVO_HOST_URL.replace(/\/+$/, ""), password: process.env.KUVO_HOST_PASSWORD } : null;
// A box whose keys its app keeps (this Mac's, KUVO_KEYS_ON_HOST), without a way to reach it: its
// keys can't be reached, rather than kept in files of its own instead of your Keychain.
export const KEYS_ON_HOST = process.env.KUVO_KEYS_ON_HOST === "1" || Boolean(process.env.KUVO_HOST_URL);
delete process.env.KUVO_HOST_PASSWORD;
// This Mac's vault's two secrets from its app, which no file holds (the host interface's password
// is in `run/host.json`, which an agent's command can read): the host's vault secret, without
// which the app gives no value from the Keychain, and the key that signs the vault's files
// (vault/store.ts). The app sends them on `serve`'s stdin (main.ts), never in its environment,
// which any of your processes can read; `KUVO_HOST_VAULT_SECRET` and `KUVO_VAULT_FILE_KEY` are for
// a test's box alone.
export let HOST_VAULT_SECRET: string | null = process.env.KUVO_HOST_VAULT_SECRET || null;
export let MAC_VAULT_FILE_KEY: Buffer | null = process.env.KUVO_VAULT_FILE_KEY ? Buffer.from(process.env.KUVO_VAULT_FILE_KEY, "base64url") : null;
delete process.env.KUVO_HOST_VAULT_SECRET;
delete process.env.KUVO_VAULT_FILE_KEY;
/** The vault's secrets, as the app sent them on stdin. */
export function takeVaultSecrets(given: { hostVaultSecret?: unknown; vaultFileKey?: unknown }) {
  if (typeof given.hostVaultSecret === "string" && given.hostVaultSecret) HOST_VAULT_SECRET = given.hostVaultSecret;
  if (typeof given.vaultFileKey === "string" && given.vaultFileKey) MAC_VAULT_FILE_KEY = Buffer.from(given.vaultFileKey, "base64url");
}

// What the box runs itself again with, before its script: on the engine's Bun, neither Bun's
// settings (`bunfig.toml`, which can preload a script) nor a `.env` from the folder it starts in
// (Bun would load both, and an agent's command can write them). Node loads neither.
export const OWN_RUNTIME = process.versions.bun ? ["--config=/dev/null", "--no-env-file"] : [];

// The box's own script (kuvo-link.js, or its source in a debug run), for what it runs again as a
// command of its own (`box reconnect`, `update`): said once as it starts, by main.ts.
export let SCRIPT = "";
export const scriptIs = (file: string) => {
  SCRIPT = file;
};
