// This box's home: its folder and the files every part of it reads, and what kind of box it is
// (a machine's, in `~/.kuvo-code`; or this Mac's, which its app starts in a folder of its own).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// (Your account, whatever HOME says: shared with the coding agents' bridge.)
import { accountHome, accountName, homeFolder } from "../shared/account";
export { accountHome, accountName, homeFolder };

export const K = process.env.KUVO_HOME || path.join(homeFolder(), ".kuvo-code");

/** Where a box records what kind it is (`box/kind`: `mac` or `machine`, a word on a line), which
 * `kuvo-start` reads too: none on a machine set up from a Mac, nor in this Mac's app's own folder. */
export const KIND_FILE = path.join(K, "box", "kind");
/** The kind this box recorded, or null for none (or a word it doesn't know). */
export function recordedKind(file = KIND_FILE): "mac" | "machine" | null {
  let word = "";
  try { word = fs.readFileSync(file, "utf8").trim(); } catch {}
  return word === "mac" || word === "machine" ? word : null;
}
// This Mac's box: the app's keeper says so as it starts it in the app's folder (BoxProcess,
// `KUVO_BOX=mac`), which wins over anything recorded there (a `box/kind` a move back left); or a box
// in a home of its own recorded it (`box/kind`), laid out as a machine's is (#333).
export const IS_MAC = process.env.KUVO_BOX === "mac" || recordedKind() === "mac";
/** This Mac's app's own folder, when its box lives in it (`<support>/box`, which the app's keeper
 * starts it in, `KUVO_BOX=mac`): the one box that reaches beside its home, for what its app keeps
 * there (its chats, the files you attach, its machines' bridges). Null for every box laid out in a
 * home of its own: a machine's, and a Mac's in `~/.kuvo-code`, which name each folder from it. */
export const APP_FOLDER = process.env.KUVO_BOX === "mac" ? path.dirname(path.resolve(K)) : null;
/** A Mac's box in a home of its own: what its app did for it in its folder, it does itself (its
 * integration keys' files, keeping the Mac awake while agents work). */
export const OWN_HOME_MAC = IS_MAC && APP_FOLDER === null;
// (The app's keeper names a folder of the app's: one whose folder around it is your home is a home
// of its own, started as the app's by mistake, which would take your home for the app's folder.)
if (APP_FOLDER && [homeFolder(), accountHome()].some(home => located(APP_FOLDER) === located(home))) {
  throw new Error(`This Mac's box was started as the app's (KUVO_BOX=mac) in ${K}, a home of its own: its folder around it is your home, not the app's.`);
}

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
 * are those of a box on a Mac whose folder is too deep for them (a test's). A Mac's box in a home of
 * its own goes by its folder's length, as a machine's does. */
export const SSH_FOR = path.join(RUN, "ssh-for");
const OWN_SSH_AGENTS = path.join(RUN, "ssh-agents");
// (68 bytes, to be safe: what a socket's path leaves for its folder, with a slash and its name, vault/ssh.ts.)
export const SSH_AGENTS = process.platform === "darwin" && (APP_FOLDER !== null || Buffer.byteLength(OWN_SSH_AGENTS) > 68)
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
  const made = `${SOCKET_KEY_FILE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  // (A new file only you can read, never one there before; gone below, however this goes.)
  try { fs.writeFileSync(made, madeKey(), { mode: 0o600, flag: "wx" }); } catch (error) { fs.rmSync(made, { force: true }); throw error; }
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
// Its chats (conversations of no project): where a Mac's app keeps them (KUVO_CHATS, beside its box),
// a box in a home of its own in its folder. The one place a box names it (`kuvo/info`'s `chats`, the
// chat mark, moves, the sandbox).
export const CHATS = process.env.KUVO_CHATS || (APP_FOLDER ? path.join(APP_FOLDER, "Chats") : path.join(K, "chats"));

// This Mac's box: the Mac app's own Attachments folder (BoxProcess gives it, KUVO_MAC_ATTACHMENTS),
// where it keeps the files its sessions sent a folder for each session, as the box keeps its own:
// they go with their session here too (`letAttachmentsGo`).
export const MAC_ATTACHMENTS = process.env.KUVO_MAC_ATTACHMENTS || null;

/** Where sessions' files are kept, a folder each: this box's, and on this Mac's box, the Mac app's. */
export const attachmentRoots = (): string[] => [path.join(K, "attachments"), ...(MAC_ATTACHMENTS ? [MAC_ATTACHMENTS] : [])];

// This Mac's box (`IS_MAC`, above): its bots are the Mac's own, made with the kit its app gives it
// and told they run on this Mac; it names no machine, keeps no notes for a Mac to take in, and goes
// by the Mac's own clock. Its settings are the engine's own, its own from the start: in the app's
// engine's folder, where they've always been, in its app's folder (KUVO_ENGINE_CONFIG, the engine's
// XDG_CONFIG_HOME), and in `config` in a home of its own. Its keys are in the Mac's Keychain, which
// the engine reads from files: those the app writes them to (KUVO_KEYS) in its folder, the box's
// own (`box/keys`, `box/bot-keys`) in a home of its own. And the servers that use a Mac's own apps
// run here.
// The versions of this Mac's app and of the engine it brings, as the app that started it says
// (BoxProcess: KUVO_APP_VERSION, KUVO_ENGINE_VERSION), for what it says of itself with the app closed.
export const MAC_APP_VERSION = process.env.KUVO_APP_VERSION || null;
export const MAC_ENGINE_VERSION = process.env.KUVO_ENGINE_VERSION || null;
// This box's computer, as what it says names it.
export const HERE = IS_MAC ? "this Mac" : "this machine";
// Where its engine's settings are: this Mac's app's engine's, or a Mac's box's own `config` in a home
// of its own (a machine's are in `box`).
export const ENGINE_CONFIG = process.env.KUVO_ENGINE_CONFIG || (OWN_HOME_MAC ? path.join(K, "config") : undefined);
// (This Mac's box in its app's folder has them there, always: BoxProcess gives both.)
if (IS_MAC && !ENGINE_CONFIG) throw new Error("This Mac's box was started without KUVO_ENGINE_CONFIG, the folder its engine's settings are in.");
/** Whether the box writes the files its engine reads its integrations' keys from itself, as a
 * machine's does (`box/keys`, a bot's own in `box/bot-keys`), while their values are kept on its host
 * (this Mac's Keychain): a Mac's box in a home of its own, which no app writes them for (KUVO_KEYS). */
export const writesKeyFiles = (): boolean => OWN_HOME_MAC && KEYS_ON_HOST && !APP_KEY_FILES;

// This Mac's app's host interface, as it was given when the box started (`KUVO_HOST_URL`,
// `KUVO_HOST_PASSWORD`), which it uses while there's no `run/host.json` (host-interface.ts): its
// password out of the environment here, as the box loads, before anything copies the environment
// for what it runs (git, kuvo-wake), so nothing it runs has it.
export const LAUNCH_HOST = process.env.KUVO_HOST_URL && process.env.KUVO_HOST_PASSWORD
  ? { url: process.env.KUVO_HOST_URL.replace(/\/+$/, ""), password: process.env.KUVO_HOST_PASSWORD } : null;
// A box whose keys its app keeps (this Mac's, KUVO_KEYS_ON_HOST), without a way to reach it: its
// keys can't be reached, rather than kept in files of its own instead of your Keychain.
// A Mac's box in a home of its own keeps them on its host whichever process asks (`serve`, or a
// client's `box route`), as its kind says, not its environment: all of them agree where a key is.
// (#333's question 1: in the Keychain, through its host. Should they be files after all, this goes.)
export const KEYS_ON_HOST = process.env.KUVO_KEYS_ON_HOST === "1" || Boolean(process.env.KUVO_HOST_URL) || OWN_HOME_MAC;
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
