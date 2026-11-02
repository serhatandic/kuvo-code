// What a command an agent runs on this box may do, as one policy that each system's sandbox writes
// in its own terms (seatbelt.ts on macOS, landlock.ts on Linux). People never see the word "fence":
// it's the sandbox in Settings and the docs, and plain words on cards.
//
// Walls only for catastrophes (the research of 2 November 2026, design C): a command reads
// everything but your secrets and Kuvo Code's own folders, and adds and changes files anywhere in
// your home, but never deletes or moves one there. It deletes and moves only in its conversation's
// folder (and that folder's git repository, but never what git runs on its own: hooks, its
// config), its own temporary folder, the system's, devices and tools' caches. It never writes what
// runs later by itself, outside the sandbox (your shell's start-up files, the folders on your PATH,
// git's and the coding agents' settings, ~/Library on a Mac but its caches), and your personal
// folders (Documents, Desktop…) only take new files on a Mac, and are only read on Linux, where
// Landlock can't tell a new file from an old one. The conversation's folder, its repository and its
// temporary folder aren't known until a command runs, so each sandbox takes them then (WORK, GIT
// and TMP): from the engine's own record of the conversation's folder, never from the command.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountHome, accountName, homeFolder, IS_MAC, K } from "../home";

export interface FencePolicy {
  /** The home folder whose secrets are hidden. */
  home: string;
  /** Kuvo Code's own folders, neither read nor written (bots', chats' and the conversation's own
   * folder inside them come back as WORK). */
  kuvo: string[];
  /** On macOS, patterns for every copy's folders (`run.kuvo.code…`), wherever the system keeps
   * an app's: regular expressions over whole paths. */
  kuvoPatterns: string[];
  /** On macOS, the folders that hold what those patterns and `readOnlyPatterns` name (where the
   * system keeps apps' folders, your temporary folder): regular expressions over whole paths. */
  patternFolders?: string[];
  /** Inside them, what commands may run: Kuvo Code's own helpers (`bin`). */
  kuvoReadable: string[];
  /** Written besides WORK, GIT and TMP: the system's temporary folders, devices, tools' caches. */
  writable: string[];
  /** Where files are added and changed, but nothing deleted or moved: your home folder. */
  homeWrites?: string[];
  /** Inside those, never written, but for what's `writable` in them (~/Library on a Mac, but its
   * caches): what runs later is so much of it that it's kept whole. */
  homeKept?: string[];
  /** Inside those, and kept, where files are added and changed again (~/Library's logs). */
  homeOpen?: string[];
  /** Your personal folders: on a Mac only new files are added (nothing changed, deleted or moved),
   * on Linux they're only read; the conversation's folder and Also Allowed inside one are its own. */
  personal?: string[];
  /** Kuvo Code's own caches for commands, inside its folders: written, and never used outside the
   * sandbox (`sandboxCaches`). */
  commandCaches: string[];
  /** Inside those, what's only read: what runs later outside the sandbox (tools' own programs and
   * settings, scripts they run as they start). */
  readOnly: string[];
  /** On macOS, more of them by name: regular expressions over whole paths (bunx's packages in your
   * temporary folder, p10k's files in your cache folder). */
  readOnlyPatterns?: string[];
  /** Never read: your secrets (folders or files). */
  secrets: string[];
  /** Kuvo Code's own servers on 127.0.0.1, refused where the system can (macOS); everywhere their
   * passwords are in files a command can't read. */
  ports: number[];
  /** Other apps' sockets that run what they're asked, outside the sandbox (folders or sockets),
   * refused on macOS and hidden on Linux: the ChatGPT app's, Grok's shared leader's
   * (`~/.grok/leader.sock`), and your SSH and GPG agents', which sign with the keys commands can't
   * read (ssh-agent's, 1Password's, Secretive's, Bitwarden's, yubikey-agent's, the box's own
   * `SSH_AUTH_SOCK`). */
  sockets?: string[];
  /** On macOS, more of them by name: regular expressions over whole paths (the system's SSH agent's,
   * where launchd keeps it, one a shell started, gpg-agent's, your tmux's), neither moved nor
   * removed where commands write, so never reached by another name. */
  socketPatterns?: string[];
  /** Their folders where commands write, which aren't moved either (only the folders: a file or a
   * socket of the command's own by such a name, like ssh's shared connection, is its own). */
  socketFolders?: string[];
}

// Tools' caches, written by installs and builds in any project.
const CACHES = [".npm", ".bun", ".cache", ".cargo", ".rustup", ".swiftpm", ".gradle", ".m2", "go/pkg", ".pnpm-store",
  ".yarn", ".node-gyp", ".local/state", ".deno", ".pub-cache", ".nuget/packages", ".dotnet"];
const MAC_CACHES = ["Library/pnpm/store", "Library/Caches", "Library/Developer"];
const LINUX_CACHES = [".local/share/pnpm/store"];
// In them, what you run later, outside the sandbox: installed programs (on your PATH), tools'
// settings that name programs, scripts they run as they start, packages npx runs as they are, and
// what your shell profile sources as it starts (rustup's, deno's and bun's installers add those).
const RUNS_LATER = [".cargo/bin", ".cargo/config", ".cargo/config.toml", ".cargo/env", ".cargo/env.fish", ".cargo/env.nu",
  ".bun/bin", ".bun/install/global", ".bun/_bun", ".deno/bin", ".deno/env", ".deno/env.fish",
  ".dotnet/tools", ".gradle/init.d", ".gradle/init.gradle", ".gradle/init.gradle.kts", ".gradle/gradle.properties",
  ".m2/settings.xml", ".npm/_npx", ".rustup/settings.toml", ".rustup/toolchains", ".pub-cache/bin", "go/bin"];
// In your cache folder (`~/.cache`, and your own `XDG_CACHE_HOME`), tools' caches whole: pre-commit's
// hooks, what `pnpm dlx` and uvx fetched, and the pnpm and yarn corepack fetched run from them, and
// what's installed from them is linked to their files. (pnpm's own on a Mac is in `Library/Caches`.)
// And what zsh sources as a terminal starts: p10k's instant prompt and its state (named for your
// account; on macOS every `p10k-` name, its temporary files too, which p10k moves into place),
// gitstatusd's program, oh-my-zsh's and prezto's completions, a `zsh` folder of your own for them,
// antidote's and zsh4humans' plugins, oh-my-posh's init.
const TOOL_CACHES = ["pre-commit", "pnpm", "uv", "node/corepack", "gitstatus", "oh-my-zsh", "prezto", "zsh", "antidote",
  "zsh4humans", "oh-my-posh"];
const SHELL_CACHES = (me: string) => [`p10k-instant-prompt-${me}.zsh`, `p10k-instant-prompt-${me}.zsh.zwc`,
  `p10k-dump-${me}.zsh`, `p10k-dump-${me}.zsh.zwc`, `p10k-${me}`];
// (antidote's on a Mac; and in `~/.local/state`, which Linux's Landlock would no longer let commands
// make a folder in, so only on a Mac, the configs mise trusts to run.)
const MAC_RUNS_LATER = ["Library/Caches/pnpm", "Library/Caches/antidote", ".local/state/mise/trusted-configs"];

// In your home, besides, what runs later by itself or as you run something, outside the sandbox:
// your shell's start-up files and its plugins, the folders on your PATH and the version managers'
// shims, Python's user site (a `.pth` file runs as Python starts), what direnv and mise trust, SSH's
// settings and who it lets in, git's settings and the templates they name, the coding agents' and
// editors' settings, hooks and extensions, and tools' settings that name programs or where packages
// come from. Never written; the research's list, section 5.
const HOME_RUNS_LATER = [".profile", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".zsh", ".zfunc", ".oh-my-zsh", ".zinit", ".zplug", ".zim", ".zimrc",
  ".antigen", ".p10k.zsh", ".config/zsh", ".config/fish", ".config/nushell", ".config/powershell", ".config/starship.toml",
  ".tcshrc", ".cshrc", ".kshrc", ".mkshrc", ".inputrc", ".tmux.conf", ".config/tmux", ".screenrc",
  ".local/bin", "bin", ".bin", ".npm-global", ".volta", ".asdf", ".nvm", ".fnm", ".local/share/fnm", ".pyenv", ".rbenv", ".jenv",
  ".nodenv", ".goenv", ".sdkman", ".ghcup/bin", ".local/share/mise", ".config/mise", ".config/direnv", ".local/share/direnv",
  ".ssh/config", ".ssh/config.d", ".ssh/authorized_keys", ".ssh/authorized_keys2", ".ssh/rc", ".ssh/environment",
  ".gitconfig", ".config/git", ".git-templates", ".git_template", ".config/husky", ".huskyrc",
  ".claude", ".claude.json", ".codex", ".cursor", ".gemini", ".grok", ".config/opencode", ".opencode", ".aider.conf.yml",
  ".continue", ".copilot", ".config/github-copilot", ".factory", ".config/amp",
  ".vscode", ".vscode-server", ".vscode-oss", ".cursor-server", ".windsurf", ".config/Code", ".config/Cursor", ".config/VSCodium",
  ".config/JetBrains", ".config/zed", ".config/helix", ".vim", ".vimrc", ".config/nvim", ".local/share/nvim", ".emacs", ".emacs.d", ".config/emacs",
  ".bunfig.toml", ".config/.bunfig.toml", ".docker/cli-plugins", ".terraformrc", ".config/gh", ".local/share/gh",
  ".config/pip", ".pip", ".pydistutils.cfg", ".condarc", ".gemrc", ".irbrc", ".pryrc", ".yarnrc", ".gnupg", ".wgetrc", ".curlrc",
  ".hgrc", ".config/hg"];
// (On Linux, Python's user site is in `.local/lib`, and the desktop and systemd start what's in
// theirs as you log in.)
const LINUX_RUNS_LATER = [".local/lib", ".config/systemd", ".local/share/systemd", ".config/autostart", ".config/environment.d",
  ".pam_environment", ".xprofile", ".xinitrc", ".xsession", ".xsessionrc", ".config/plasma-workspace", ".local/share/applications"];
// (On a Mac, ~/Library is kept whole, but for its caches, logs and iCloud Drive: launchd's agents,
// login items, Python's user site, frameworks dyld falls back to, apps' plugins and preferences are
// in it. And the tools that run what their settings name as you use your Mac.)
const MAC_HOME_KEPT = ["Library"];
const MAC_HOME_OPEN = ["Library/Logs", "Library/Mobile Documents"];
const MAC_HOME_RUNS_LATER = [".hammerspoon", ".config/karabiner", ".config/skhd", ".skhdrc", ".yabairc", ".config/yabai",
  ".aerospace.toml", ".config/aerospace", ".config/sketchybar"];
// zsh's completion dumps, which `compinit` sources (named for the host and version).
const HOME_RUNS_LATER_PREFIXES = [".zcompdump"];

// Your personal folders on a Mac (Linux's are where `~/.config/user-dirs.dirs` says).
const MAC_PERSONAL = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Library/Mobile Documents"];
const LINUX_PERSONAL = { DESKTOP: "Desktop", DOCUMENTS: "Documents", DOWNLOAD: "Downloads", MUSIC: "Music", PICTURES: "Pictures",
  VIDEOS: "Videos", PUBLICSHARE: "Public", TEMPLATES: "Templates" };

/** Linux's personal folders, as `~/.config/user-dirs.dirs` names them (or their usual names), never
 * the home folder itself (one set to `$HOME/`, which means none). */
export function xdgPersonal(home: string): string[] {
  const named: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(home, ".config", "user-dirs.dirs"), "utf8").split("\n")) {
      const found = line.match(/^\s*XDG_([A-Z]+)_DIR\s*=\s*"(.*)"\s*$/);
      if (found) named[found[1]] = found[2].replace(/^\$HOME(?=\/|$)/, home);
    }
  } catch {}
  return Object.entries(LINUX_PERSONAL).map(([key, name]) => named[key] ?? path.join(home, name))
    .filter(folder => path.isAbsolute(folder) && path.resolve(folder) !== path.resolve(home) && path.resolve(folder).startsWith(path.resolve(home) + "/"));
}

/** What in your home starts with one of these names (Linux's sandbox grants what's there, so only
 * those are kept; on a Mac, a pattern keeps new ones too). */
function startingWith(home: string, prefixes: string[]): string[] {
  try { return fs.readdirSync(home).filter(name => prefixes.some(prefix => name.startsWith(prefix))).map(name => path.join(home, name)); } catch { return []; }
}

/**
 * The sockets SSH's settings name (`ControlPath`'s shared connections, `IdentityAgent`'s agents),
 * which sign in to your servers and run what they're asked there: a folder of their own (to hide
 * whole), a socket (by its path), or, where they're named by their host in a folder that holds
 * more (`~/.ssh/cm-%C`), the start of their names (`prefixes`).
 */
export function sshSockets(home: string): { paths: string[]; prefixes: string[] } {
  const paths = new Set<string>();
  const prefixes = new Set<string>();
  const files = [path.join(home, ".ssh", "config")];
  try { for (const name of fs.readdirSync(path.join(home, ".ssh", "config.d"))) files.push(path.join(home, ".ssh", "config.d", name)); } catch {}
  const shared = new Set([home, path.join(home, ".ssh"), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].map(each => path.resolve(each)));
  for (const file of files) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const found = line.match(/^\s*(ControlPath|IdentityAgent)\s*(?:=\s*|\s+)("[^"]*"|\S+)/i);
      if (!found) continue;
      let value = found[2].replace(/^"|"$/g, "");
      if (!value || /^(none|SSH_AUTH_SOCK)$/i.test(value) || value.startsWith("$")) continue;
      value = value.replace(/^~(?=\/|$)/, home).replace(/%d/g, home).replace(/%%/g, "\0");
      if (!path.isAbsolute(value)) continue;
      const token = value.indexOf("%");
      if (token < 0) { paths.add(path.resolve(value.replace(/\0/g, "%"))); continue; }
      const before = value.slice(0, token).replace(/\0/g, "%");
      const folder = before.endsWith("/") ? path.resolve(before) : path.dirname(before);
      // A folder that holds only them is hidden whole; in one that holds more, the names they start with.
      if (shared.has(folder) || before.endsWith("/") && shared.has(folder)) prefixes.add(before.endsWith("/") ? folder + "/" : before);
      else paths.add(folder);
    }
  }
  return { paths: [...paths], prefixes: [...prefixes] };
}

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

/** This Mac's app's temporary folder (`…/T/<bundle>`), where its box's own is (`…/T/<bundle>/box`),
 * as the app names it (`/var/folders/…`, not through its link): null for a box that isn't the app's. */
export function appTemporary(): string | null {
  if (!IS_MAC) return null;
  const tmp = path.dirname(path.resolve(os.tmpdir()));
  return path.basename(tmp) === path.basename(path.dirname(path.resolve(K))) ? tmp : null;
}

/**
 * The caches of npm, pnpm and uv for commands in the sandbox, Kuvo Code's own: npx, `pnpm dlx` and
 * uvx fetch a package there and run it from it, so nothing they fetch runs outside the sandbox, as
 * it would from yours (which commands only read). In this Mac's app's cache folder, on its box (in
 * the home the box is given: a test's box keeps them in its own); in `cache` elsewhere (a machine's
 * `~/.kuvo-code`). Never the engine's own (`cache/npm`), which runs outside it.
 */
export function sandboxCaches(): { npm: string; pnpm: string; uv: string; corepack: string } {
  const tmp = appTemporary();
  const root = realish(tmp ? path.join(homeFolder(), "Library", "Caches", path.basename(tmp)) : path.join(K, "cache"));
  return { npm: path.join(root, "sandbox-npm"), pnpm: path.join(root, "sandbox-pnpm"), uv: path.join(root, "sandbox-uv"), corepack: path.join(root, "sandbox-corepack") };
}

/** This Mac's app's folders, around its box's (`…/Application Support/<bundle>/box`). */
function macFolders(home: string): { kuvo: string[]; readable: string[] } {
  const app = path.dirname(path.resolve(K));
  const bundle = path.basename(app);
  // The app's temporary folder: the box's own is in it (`…/T/<bundle>/box`).
  const tmp = appTemporary();
  const kuvo = [app, path.join(home, "Library", "Caches", bundle), path.join(home, "Library", "Logs", "Kuvo Code"),
    path.join(home, "Library", "WebKit", bundle), path.join(home, "Library", "HTTPStorages", bundle),
    path.join(home, "Library", "Preferences", `${bundle}.plist`), `/private/tmp/kuvo-ssh-${os.userInfo().uid}`];
  // (And its cache folder where the caches for commands are, in the home it's given.)
  if (tmp) kuvo.push(tmp, path.dirname(sandboxCaches().npm));
  return { kuvo, readable: [path.join(app, "bin")] };
}

/**
 * This box's policy, as its folders, your home folder (your account's, whatever HOME says, as
 * `allowed.ts` has it: Bun's `os.userInfo()` follows HOME) and your SSH keys are now: this Mac's app's
 * folders on this Mac's box, a machine's folder on a machine's; the system's own paths and secrets
 * as the computer it runs on has them.
 */
export function fencePolicy(ports: number[] = []): FencePolicy {
  const home = realish(accountHome());
  const inHome = (names: string[]) => names.map(name => realish(path.join(home, name)));
  // And what's kept from commands in the home HOME names, where that isn't your account's, as tools
  // run from it look there.
  const named = realish(process.env.HOME || home);
  const homes = named === home ? [home] : [home, named];
  const inHomes = (names: string[]) => homes.flatMap(each => names.map(name => realish(path.join(each, name))));
  // A machine's folder, and the real one if this is a test's own.
  const own = IS_MAC ? macFolders(home) : { kuvo: [K, path.join(home, ".kuvo-code")], readable: [path.join(K, "bin")] };
  const kuvo = [...new Set(own.kuvo.map(realish))];
  const kuvoReadable = own.readable.map(realish);
  const commandCaches = Object.values(sandboxCaches());
  // Your cache folder, and your own if you set one (on a machine, what its launch kept: the box's
  // own is in Kuvo Code's folder), with the tools' caches in it.
  const ownCache = "KUVO_OWN_XDG_CACHE_HOME" in process.env ? process.env.KUVO_OWN_XDG_CACHE_HOME : process.env.XDG_CACHE_HOME;
  const yourCaches = [realish(path.join(home, ".cache"))];
  if (ownCache && path.isAbsolute(ownCache) && !kuvo.some(folder => realish(ownCache) === folder || realish(ownCache).startsWith(folder + "/"))) yourCaches.push(realish(ownCache));
  const runsLater = [...inHomes(RUNS_LATER), ...new Set(yourCaches.flatMap(folder => [...TOOL_CACHES, ...SHELL_CACHES(accountName())].map(name => path.join(folder, name))))];
  const homeRunsLater = inHomes(HOME_RUNS_LATER);
  const ssh = homes.map(each => sshSockets(each));
  const sshPaths = [...new Set(ssh.flatMap(each => each.paths).map(realish))];
  const sshPrefixes = [...new Set(ssh.flatMap(each => each.prefixes))];
  if (process.platform === "darwin") {
    return {
      home, kuvo, kuvoReadable, readOnly: [...runsLater, ...inHomes(MAC_RUNS_LATER), ...homeRunsLater, ...inHomes(MAC_HOME_RUNS_LATER)], ports, commandCaches,
      homeWrites: homes, homeKept: inHomes(MAC_HOME_KEPT), homeOpen: inHomes(MAC_HOME_OPEN), personal: inHomes(MAC_PERSONAL),
      // bunx's packages, in your temporary folder (`T/bunx-<uid>-<package>`), which it runs again
      // as they are (a command's own bunx is in its own temporary folder); and p10k's files in your
      // cache folder by any name, as it writes each beside it first (`.tmp.<pid>`), then moves it.
      readOnlyPatterns: [...userTemporary().map(folder => `^${escapeRegex(folder)}/T/bunx-`),
        ...yourCaches.map(folder => `^${escapeRegex(folder)}/p10k-`),
        ...homes.flatMap(each => HOME_RUNS_LATER_PREFIXES.map(prefix => `^${escapeRegex(each)}/${escapeRegex(prefix)}`))],
      // Every copy's (`run.kuvo.code…`), wherever the system keeps an app's.
      kuvoPatterns: [
        `^${escapeRegex(home)}/Library/[^/]+/run\\.kuvo\\.code[^/]*(/|$)`,
        `^/private/var/folders/[^/]+/[^/]+/[^/]+/run\\.kuvo\\.code[^/]*(/|$)`,
      ],
      patternFolders: [`^${escapeRegex(home)}/Library/[^/]+$`, `^/private/var/folders/[^/]+/[^/]+/[^/]+$`],
      writable: ["/private/tmp", "/private/var/tmp", "/dev", ...userTemporary(), ...inHome([...CACHES, ...MAC_CACHES])],
      sockets: [...inHome([".codex/ipc", ".grok", ".ssh/agent", "Library/Group Containers/2BUA8C4S2C.com.1password/t",
        "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data", ".bitwarden-ssh-agent.sock",
        "Library/Containers/com.bitwarden.desktop/Data"]),
        "/opt/homebrew/var/run/yubikey-agent.sock", "/usr/local/var/run/yubikey-agent.sock",
        // Docker's and the like, which run anything as the whole computer (a container that mounts
        // your home writes in it), wherever their apps keep them.
        ...inHome([".docker/run", ".orbstack/run", ".colima", ".lima", ".rd", ".local/share/containers/podman/machine",
          "Library/Containers/com.docker.docker/Data", "Library/Group Containers/HUAQ24HBR6.dev.orbstack"]),
        realish("/var/run/docker.sock"), "/private/var/run/docker.sock",
        // SSH's shared connections and agents your settings name.
        ...sshPaths,
        // (And the one this box was started with, wherever it is.)
        ...(process.env.SSH_AUTH_SOCK && path.isAbsolute(process.env.SSH_AUTH_SOCK) ? [realish(process.env.SSH_AUTH_SOCK)] : [])],
      socketPatterns: [
        // The system's, where launchd keeps it, and one your shell starts (`eval $(ssh-agent)`; since
        // OpenSSH 10.1 in ~/.ssh/agent, above).
        "^/private/(var/run|tmp)/com\\.apple\\.launchd\\.[^/]+/",
        "^/private/tmp/ssh-[^/]+/agent\\.", "^/private/var/folders/[^/]+/[^/]+/T/ssh-[^/]+/agent\\.",
        // gpg-agent's own (not its key store's or keyserver helper's, which hold no keys).
        `^${escapeRegex(home)}/\\.gnupg/S\\.(gpg-agent|scdaemon)`,
        // Your tmux's server, which types into your terminals (a command's own is in its temporary
        // folder: the launcher's TMUX_TMPDIR).
        `^/private/tmp/tmux-${os.userInfo().uid}/`,
        // Podman's machine's, in your temporary folder; and SSH's shared connections named by host.
        "^/private/var/folders/[^/]+/[^/]+/T/podman/",
        ...sshPrefixes.map(prefix => `^${escapeRegex(realish(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix))}${prefix.endsWith("/") ? "/" : ""}`),
      ],
      socketFolders: [`^/private/tmp/tmux-${os.userInfo().uid}$`, "^/private/tmp/com\\.apple\\.launchd\\.[^/]+$", "^/private/tmp/ssh-[^/]+$", "^/private/var/folders/[^/]+/[^/]+/T/ssh-[^/]+$"],
      secrets: [...inHomes([...SECRETS, ...MAC_SECRETS]), ...keychainDaemons(home).map(realish), ...homes.flatMap(each => [...sshKeys(each), ...ghHosts(each)]).map(realish)],
    };
  }
  return {
    home, kuvo, kuvoReadable, readOnly: [...runsLater, ...homeRunsLater, ...inHomes(LINUX_RUNS_LATER),
      ...homes.flatMap(each => startingWith(each, HOME_RUNS_LATER_PREFIXES)).map(realish)], ports, commandCaches,
    homeWrites: homes, personal: [...new Set(homes.flatMap(xdgPersonal).map(realish))],
    kuvoPatterns: [],
    writable: ["/tmp", "/var/tmp", "/dev", "/dev/shm", ...inHome([...CACHES, ...LINUX_CACHES])],
    // (Hidden in each command's namespace, beside your session's own: fence/landlock.ts, HIDE.)
    sockets: [...inHome([".grok/leader.sock", ".ssh/agent", ".1password/agent.sock", ".bitwarden-ssh-agent.sock",
      ".gnupg/S.gpg-agent", ".gnupg/S.gpg-agent.ssh", ".gnupg/S.scdaemon"]),
      ...(process.env.SSH_AUTH_SOCK && path.isAbsolute(process.env.SSH_AUTH_SOCK) ? [process.env.SSH_AUTH_SOCK] : []),
      // Docker's and the like, which run anything as the whole computer (rootless ones are in your
      // session's folder, hidden whole).
      ...[...new Set(["/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock", "/var/snap/lxd/common/lxd/unix.socket",
        "/var/lib/lxd/unix.socket", "/var/lib/incus/unix.socket", "/run/incus/unix.socket", "/var/run/libvirt/libvirt-sock",
        "/run/libvirt/libvirt-sock"].map(realish))], ...inHome([".docker/run"]),
      // SSH's shared connections and agents your settings name; those named by host, by the start of
      // their names (each that's there as a command starts).
      ...sshPaths, ...sshPrefixes.map(prefix => prefix + "*")],
    secrets: [...inHomes([...SECRETS, ...LINUX_SECRETS]), ...homes.flatMap(each => [...sshKeys(each), ...ghHosts(each)])],
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
