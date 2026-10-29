// This box's home: its folder and the files every part of it reads, and what kind of box it is
// (a machine's, in `~/.kuvo-code`; or this Mac's, which its app starts in a folder of its own).

import os from "node:os";
import path from "node:path";

/** The home folder, as its HOME names it (as the shell and the engine have it), read each time: a
 * test's own HOME counts under Bun too, which otherwise keeps the one it started with. */
export function homeFolder(): string {
  return process.env.HOME || os.homedir();
}

export const K = process.env.KUVO_HOME || path.join(homeFolder(), ".kuvo-code");
export const RUN = path.join(K, "run");
export const LINK_FILE = path.join(RUN, "link.json");
export const ENGINE_FILE = path.join(RUN, "engine.json");
// The coding agents' bridge beside the engine (kuvo-agents.js): its port and password.
export const BRIDGE_FILE = path.join(RUN, "bridge.json");
export const PID_FILE = path.join(RUN, "link.pid");
// While it's there, the box's keeper keeps this bridge running (`bin/kuvo-start keep`).
export const NEEDED_FILE = path.join(RUN, "link.needed");
export const VERSION_FILE = path.join(RUN, "link.version");

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
// A test's folder (not a machine's own `~/.kuvo-code`), where a test's stand-ins for npm and
// GitHub are taken.
export const IN_TEST_FOLDER = path.resolve(K) !== path.join(homeFolder(), ".kuvo-code");
// The engine's settings and keys change one at a time, whoever changes them.
export const CONFIG_LOCK = path.join(RUN, ".config.lock");

// A Mac's box finds them where its app keeps them, as the engine does (KUVO_BOTS, KUVO_WAKES, and the
// app's own kuvo-wake); a machine's, in its folder.
export const BOTS = process.env.KUVO_BOTS || path.join(K, "bots");

// This Mac's box (BoxProcess says so as it starts it, `KUVO_BOX=mac`): its bots are the Mac's own,
// made with the kit its app gives it and told they run on this Mac; it names no machine, keeps no
// notes for a Mac to take in, and goes by the Mac's own clock. Its settings are the app's engine's,
// where they've always been (KUVO_ENGINE_CONFIG, the engine's XDG_CONFIG_HOME), its own from the
// start; its keys are in the Mac's Keychain, which the engine reads from the files the app writes
// them to (KUVO_KEYS); and the servers that use a Mac's own apps run here.
export const IS_MAC = process.env.KUVO_BOX === "mac";
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

// The box's own script (kuvo-link.js, or its source in a debug run), for what it runs again as a
// command of its own (`box reconnect`, `update`): said once as it starts, by main.ts.
export let SCRIPT = "";
export const scriptIs = (file: string) => {
  SCRIPT = file;
};
