// What a command an agent runs on this box may do, as one policy that each system's sandbox writes
// in its own terms (seatbelt.ts on macOS, landlock.ts on Linux). People never see the word "fence":
// it's the sandbox in Settings and the docs, and plain words on cards.
//
// A command writes only in its conversation's folder (and that folder's git repository, but never
// what git runs on its own: hooks, its config), its own temporary folder, the system's, devices and
// tools' caches. It never reads or writes Kuvo Code's own folders (its settings, keys, the vault,
// other bots' folders), and never reads your secrets: cloud and package tokens, browsers' and
// password managers' data, private SSH keys. The conversation's folder, its repository and its
// temporary folder aren't known until a command runs, so each sandbox takes them then (WORK, GIT
// and TMP): from the engine's own record of the conversation's folder, never from the command.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_MAC, K } from "../home";

export interface FencePolicy {
  /** The home folder whose secrets are hidden. */
  home: string;
  /** Kuvo Code's own folders, neither read nor written (bots', chats' and the conversation's own
   * folder inside them come back as WORK). */
  kuvo: string[];
  /** On macOS, patterns for every copy's folders (`run.kuvo.code…`), wherever the system keeps
   * an app's: regular expressions over whole paths. */
  kuvoPatterns: string[];
  /** Inside them, what commands may run: Kuvo Code's own helpers (`bin`). */
  kuvoReadable: string[];
  /** Written besides WORK, GIT and TMP: the system's temporary folders, devices, tools' caches. */
  writable: string[];
  /** Inside those, what's only read: what runs later outside the sandbox (tools' own programs and
   * settings, scripts they run as they start). */
  readOnly: string[];
  /** Never read: your secrets (folders or files). */
  secrets: string[];
  /** Kuvo Code's own servers on 127.0.0.1, refused where the system can (macOS); everywhere their
   * passwords are in files a command can't read. */
  ports: number[];
  /** Other apps' sockets that run what they're asked, outside the sandbox (folders), refused where
   * the system can (macOS): the ChatGPT app's, and Grok's shared leader's (`~/.grok/leader.sock`). */
  sockets?: string[];
}

// Tools' caches, written by installs and builds in any project.
const CACHES = [".npm", ".bun", ".cache", ".cargo", ".rustup", ".swiftpm", ".gradle", ".m2", "go/pkg", ".pnpm-store",
  ".yarn", ".node-gyp", ".local/state", ".deno", ".pub-cache", ".nuget/packages", ".dotnet"];
const MAC_CACHES = ["Library/pnpm/store", "Library/Caches", "Library/Developer"];
const LINUX_CACHES = [".local/share/pnpm/store"];
// In them, what you run later, outside the sandbox: installed programs (on your PATH), tools'
// settings that name programs, scripts they run as they start, packages npx runs as they are.
const RUNS_LATER = [".cargo/bin", ".cargo/config", ".cargo/config.toml", ".bun/bin", ".bun/install/global", ".deno/bin",
  ".dotnet/tools", ".gradle/init.d", ".gradle/init.gradle", ".gradle/init.gradle.kts", ".gradle/gradle.properties",
  ".m2/settings.xml", ".npm/_npx", ".cache/pre-commit", ".rustup/settings.toml", ".rustup/toolchains", ".pub-cache/bin", "go/bin"];

// Your secrets (each a folder or a file in your home folder).
const SECRETS = [".aws", ".config/gcloud", ".azure", ".kube", ".docker/config.json", ".oci", ".config/doctl",
  ".terraform.d/credentials.tfrc.json", ".netrc", ".npmrc", ".yarnrc.yml", ".pypirc", ".cargo/credentials.toml",
  ".cargo/credentials", ".gem/credentials", ".git-credentials", ".gnupg/private-keys-v1.d", ".gnupg/secring.gpg",
  ".password-store", ".config/op", ".config/hub"];
const MAC_SECRETS = ["Library/Application Support/Google/Chrome", "Library/Application Support/BraveSoftware",
  "Library/Application Support/Arc", "Library/Application Support/Firefox", "Library/Application Support/Microsoft Edge",
  "Library/Safari", "Library/Cookies", "Library/Application Support/1Password", "Library/Group Containers/2BUA8C4S2C.com.1password",
  "Library/Application Support/Bitwarden"];
// Not the Keychain's folder: gh and git's helper read their sign-ins from it in their own process
// (its items keep their own access lists, Kuvo Code's too). But the system's own keychain in it
// (`Library/Keychains/<UUID>`), which only its daemons read: `keychainDaemons`.
const LINUX_SECRETS = [".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".mozilla", ".local/share/keyrings"];

/** The system's own keychain folders in your Keychain's (`Library/Keychains/<UUID>`), which only
 * its daemons read, never gh or git themselves. */
function keychainDaemons(home: string): string[] {
  const folder = path.join(home, "Library", "Keychains");
  try {
    return fs.readdirSync(folder).filter(name => /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(name)).map(name => path.join(folder, name));
  } catch {
    return [];
  }
}

/**
 * Your private SSH keys: every file in `~/.ssh` but its settings, known hosts and public keys,
 * whatever they're named (not only `id_*`). Read each time a policy's written, so a key added
 * later is hidden from the next.
 */
export function sshKeys(home: string): string[] {
  const folder = path.join(home, ".ssh");
  let names: string[] = [];
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names.filter(name => !(name === "config" || name === "config.d" || name.startsWith("known_hosts") || name.endsWith(".pub") || name === "authorized_keys"))
    .map(name => path.join(folder, name));
}

/** gh's sign-in: hidden only when its file holds the token itself (gh can't start without reading
 * it; with the token in the Keychain or the keyring, it holds none). */
function ghHosts(home: string): string[] {
  const file = path.join(home, ".config", "gh", "hosts.yml");
  try { return /oauth_token\s*:/.test(fs.readFileSync(file, "utf8")) ? [file] : []; } catch { return []; }
}

/** This Mac's app's folders, around its box's (`…/Application Support/<bundle>/box`). */
function macFolders(home: string): { kuvo: string[]; readable: string[] } {
  const app = path.dirname(path.resolve(K));
  const bundle = path.basename(app);
  // The app's temporary folder: the box's own is in it (`…/T/<bundle>/box`).
  const tmp = path.dirname(path.resolve(os.tmpdir()));
  const kuvo = [app, path.join(home, "Library", "Caches", bundle), path.join(home, "Library", "Logs", "Kuvo Code"),
    path.join(home, "Library", "WebKit", bundle), path.join(home, "Library", "HTTPStorages", bundle),
    path.join(home, "Library", "Preferences", `${bundle}.plist`), `/private/tmp/kuvo-ssh-${os.userInfo().uid}`];
  if (path.basename(tmp) === bundle) kuvo.push(tmp);
  return { kuvo, readable: [path.join(app, "bin")] };
}

/**
 * This box's policy, as its folders, your home folder and your SSH keys are now: this Mac's app's
 * folders on this Mac's box, a machine's folder on a machine's; the system's own paths and secrets
 * as the computer it runs on has them.
 */
export function fencePolicy(ports: number[] = []): FencePolicy {
  const home = realish(os.userInfo().homedir);
  const inHome = (names: string[]) => names.map(name => realish(path.join(home, name)));
  // A machine's folder, and the real one if this is a test's own.
  const own = IS_MAC ? macFolders(home) : { kuvo: [K, path.join(home, ".kuvo-code")], readable: [path.join(K, "bin")] };
  const kuvo = [...new Set(own.kuvo.map(realish))];
  const kuvoReadable = own.readable.map(realish);
  const readOnly = inHome(RUNS_LATER);
  if (process.platform === "darwin") {
    return {
      home, kuvo, kuvoReadable, readOnly, ports,
      // Every copy's (`run.kuvo.code…`), wherever the system keeps an app's.
      kuvoPatterns: [
        `^${escapeRegex(home)}/Library/[^/]+/run\\.kuvo\\.code[^/]*(/|$)`,
        `^/private/var/folders/[^/]+/[^/]+/[^/]+/run\\.kuvo\\.code[^/]*(/|$)`,
      ],
      writable: ["/private/tmp", "/private/var/tmp", "/dev", ...userTemporary(), ...inHome([...CACHES, ...MAC_CACHES])],
      sockets: inHome([".codex/ipc", ".grok"]),
      secrets: [...inHome([...SECRETS, ...MAC_SECRETS]), ...keychainDaemons(home).map(realish), ...sshKeys(home).map(realish), ...ghHosts(home).map(realish)],
    };
  }
  return {
    home, kuvo, kuvoReadable, readOnly, ports,
    kuvoPatterns: [],
    writable: ["/tmp", "/var/tmp", "/dev", "/dev/shm", ...inHome([...CACHES, ...LINUX_CACHES])],
    secrets: [...inHome([...SECRETS, ...LINUX_SECRETS]), ...sshKeys(home), ...ghHosts(home)],
  };
}

/** This Mac's per-user temporary and cache folders (`/private/var/folders/…/{T,C}`), which builds
 * write to: everything in them but Kuvo Code's own, which `kuvoPatterns` hides. */
function userTemporary(): string[] {
  let t = os.tmpdir();
  try { t = fs.realpathSync(t); } catch {}
  const user = t.match(/^(\/private\/var\/folders\/[^/]+\/[^/]+)\//)?.[1];
  return user ? [user] : [];
}

/** A path as the system has it, through symlinks (`/tmp` is `/private/tmp` on macOS), as the
 * sandbox compares them: its deepest folder that's there resolved, the rest as it's named. */
export function realish(where: string): string {
  const full = path.resolve(where);
  for (let at = full, rest = ""; ; rest = path.join(path.basename(at), rest), at = path.dirname(at)) {
    try { return path.join(fs.realpathSync(at), rest); } catch {}
    if (at === path.dirname(at)) return full;
  }
}

export const escapeRegex = (text: string) => text.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
