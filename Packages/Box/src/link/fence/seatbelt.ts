// The sandbox's policy in macOS's own terms: a Seatbelt profile for `sandbox-exec`, which the
// launcher (`bin/kuvo-fence`) runs each command in, with the conversation's folder, its git
// repository, the commands' temporary folder and where its wake-ups are kept as the profile's
// parameters (WORK, GIT, TMP, WAKES, and MEMORY, its bot's memory file), what Also Allowed gives its project (ALLOW0…, escaped for
// regexes as ALLOW0_RE…), and the tag
// its refusals are logged with (TAG: `kuvo-sandbox <session>`). A coding agent run whole in it
// (Codex; Grok, Cursor, Antigravity) has homes of its own too (OWN0…, escaped as OWN0_RE…), of
// which it writes only what's named its state at their top (STATE: its sign-in, databases and
// conversations, files or folders), never what's named KEPT anywhere in them (settings it keeps
// inside its state), nor anything else there (its settings, plugins and skills, which run as it
// starts, outside the sandbox, when you use it yourself); folders it only reads (READ0…: the
// skills it's given, in Kuvo Code's); and the one
// port of its own Kuvo Code tools (PORT, in its profiles of their own: `-agent`).
//
// Later rules win, so each part carves out of the ones before it. Two profiles: one for a folder
// outside Kuvo Code's (a project), where Kuvo Code's folders are hidden even inside it; and one
// for a folder of Kuvo Code's own (a chat's or a bot's), which is given back after them, alone
// among its neighbours (another bot's folder stays hidden).
//
// `watch`: each refusal is allowed and logged instead (with its tag), for what would have been
// stopped (`log show --predicate 'sender == "Sandbox"'`).

import path from "node:path";
import { MOST_FOLDERS } from "./allowed";
import type { FencePolicy } from "./policy";

/** How many homes of its own, and folders it only reads, an agent run whole in the sandbox has (each). */
export const AGENT_FOLDERS = 4;

export interface SeatbeltOptions {
  /** The conversation's folder is inside Kuvo Code's own (a chat's or a bot's). */
  inside: boolean;
  /** For a coding agent run whole in it, with its Kuvo Code tools' port (PORT). */
  agent?: boolean;
  mode?: "enforce" | "watch";
  tag?: string;
}

const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const subpath = (folder: string) => `(subpath ${quote(folder)})`;
// (A plain string, unescaped once as it's read; `#"…"` would keep the doubled backslashes.)
const regex = (pattern: string) => `(regex ${quote(pattern)})`;
const param = (name: string) => `(subpath (param ${quote(name)}))`;

// Inside a folder commands write: what would run outside the sandbox (git's hooks, its config, which
// can name programs: the repository's, its submodules' and its worktrees'; the coding agents' own
// settings files in a project, whose hooks and servers they run as they start there, and their hooks'
// scripts, but not the rest of their folders, like rules and commands, which run nothing) or change
// what the engine does (its settings, its plugins). A folder moved or linked into place is checked
// only by its own name, never by what's in it, so the folders that hold those (`.git`, a submodule's
// or a worktree's repository, the agents' folders) can't be made, moved or removed, only written in.
const GIT_GUARDED = String.raw`(((modules/.+|worktrees/[^/]+)/)?(hooks(/|$)|config(\.worktree)?$|commondir$|gitdir$)|(modules|worktrees)/[^/]+$)`;
const AGENTS_GUARDED = String.raw`\.claude/settings(\.local)?\.json|\.mcp\.json|\.codex/(config\.toml|hooks\.json|\.env|rules(/.*)?)|\.cursor/(hooks|mcp)\.json|\.(gemini|grok)/settings\.json|\.grok/(config\.toml|sandbox\.toml|lsp\.json|(hooks|plugins|agents|workflows)(/.*)?)|\.(claude|cursor)/hooks(/.*)?|\.(claude|codex|cursor|gemini|grok)`;
/** Every kind of write, by name. A rule on a kind by its name is checked before any on `file-write*`,
 * whatever their order, so the profile names them all wherever it carves one out of another, and
 * later rules win. (`file-write*` itself only refuses, first, any kind macOS adds later.) */
const WRITE = "file-write-acl file-write-create file-write-data file-write-finderinfo file-write-flags file-write-mode file-write-owner file-write-setugid file-write-times file-write-unlink file-write-xattr";

/** What's done in your home: everything a write does but unlinking (so neither deleting nor moving). */
const HOME_WRITES = "file-write-create file-write-data file-write-flags file-write-mode file-write-times file-write-xattr";

const GUARDED = String.raw`(.*/)?(\.git$|\.git/(${GIT_GUARDED})|\.opencode(/|$)|opencode\.jsonc?$|(${AGENTS_GUARDED})$)`;

export function seatbeltProfile(policy: FencePolicy, options: SeatbeltOptions): string {
  const mode = options.mode ?? "enforce";
  const tag = options.tag ? quote(options.tag) : `(param "TAG")`;
  const out = ["(version 1)", "(allow default)"];
  // With no filters, the operation everywhere (`whole`); otherwise nothing to refuse.
  const deny = (operations: string, ...filters: string[]) => denyIn(false, operations, ...filters);
  const denyAll = (operations: string) => denyIn(true, operations);
  const denyIn = (whole: boolean, operations: string, ...filters: string[]) => {
    if (!whole && !filters.length) return;
    const where = filters.length ? " " + filters.join(" ") : "";
    out.push(mode === "enforce"
      ? `(deny ${operations} (with message ${tag})${where})`
      : `(allow ${operations} (with report) (with message ${tag})${where})`);
  };
  const allow = (operations: string, ...filters: string[]) => {
    if (filters.length) out.push(`(allow ${operations} ${filters.join(" ")})`);
  };
  // Regexes over a parameter take its escaped copy (`WORK_RE`, `GIT_RE`, `ALLOW0_RE`…: the launcher
  // escapes them).
  const under = (base: string, rest: string) => `(regex (string-append "^" (param ${quote(base)}) ${quote(rest)}))`;

  out.push(";; writes: files added and changed in your home, never deleted or moved there (but in its folder,");
  out.push(";; its repository, temporary folders, devices and tools' caches); your personal folders only take new files");
  deny(`file-write* ${WRITE}`, subpath("/"));
  // (A move takes unlinking what's moved, so with no unlink, nothing's moved either.)
  allow(HOME_WRITES, ...(policy.homeWrites ?? []).map(subpath));
  deny(WRITE, ...(policy.homeKept ?? []).map(subpath));
  allow(HOME_WRITES, ...(policy.homeOpen ?? []).map(subpath));
  // A new file is made and written in one go; one that's there isn't written, truncated, replaced,
  // removed or changed in mode (each a new file's own first open still writes it).
  deny("file-write-data file-write-unlink file-write-mode file-write-flags", ...(policy.personal ?? []).map(subpath));
  allow(WRITE, ...policy.writable.map(subpath), param("WORK"), param("GIT"));
  // What you let this project's commands write (Also Allowed), before what follows takes back
  // Kuvo Code's folders, git's hooks and the agents' settings in it.
  allow(WRITE, ...Array.from({ length: MOST_FOLDERS }, (_, at) => param(`ALLOW${at}`)));
  deny(WRITE, ...policy.readOnly.map(subpath), ...(policy.readOnlyPatterns ?? []).map(regex));

  // What's in them is neither read (nor listed) nor written; a path through them is still looked up,
  // so a command can go to its own folder inside them. (A carve-out overrides a refusal only of
  // the very same operations, so each names them as the refusal does.)
  out.push(";; Kuvo Code's own folders: neither read nor written; its helpers run");
  const HIDDEN = `file-read-data ${WRITE}`;
  deny(HIDDEN, ...policy.kuvo.map(subpath), ...policy.kuvoPatterns.map(regex));
  allow("file-read-data", ...policy.kuvoReadable.map(subpath));
  // A coding agent's own homes, run whole in the sandbox: read, and written only where its state is
  // named at their top (a file, or a folder and all in it), and there only files and folders: never
  // a link, which would have your own agent write elsewhere (one in a folder moved in, the bridge
  // takes away as the agent stops: fence.ts `fenceAgent`); and the folders it only reads.
  const homes = Array.from({ length: AGENT_FOLDERS }, (_, at) => `OWN${at}`);
  allow("file-read-data", ...homes.map(param), ...Array.from({ length: AGENT_FOLDERS }, (_, at) => param(`READ${at}`)));
  const inHome = (home: string, rest: string) => `(regex (string-append "^" (param ${quote(`${home}_RE`)}) ${rest}))`;
  allow(WRITE, ...homes.flatMap(home => ["$", "/"].flatMap(after => ["REGULAR-FILE", "DIRECTORY"].map(type =>
    `(require-all ${inHome(home, `"/(" (param "STATE") ")${after}"`)} (vnode-type ${type}))`))));
  allow(HIDDEN, param("TMP"));
  // Kuvo Code's own caches for commands (npm's, pnpm's, uv's, corepack's), in its folders.
  allow(HIDDEN, ...policy.commandCaches.map(subpath));
  if (options.inside) allow(HIDDEN, param("WORK"));
  // Its conversation's wake-ups and watches (kuvo-wake): what's kept there is read, and only its
  // inbox written, which the box takes in, out of its reach (kuvo-wake's `take`).
  allow("file-read-data", param("WAKES"));
  allow(HIDDEN, `(subpath (string-append (param "WAKES") "/inbox"))`);
  // Its bot's memory, which the launcher names (MEMORY): read and written in place, never made,
  // moved or removed (so never a link, or another name for another file).
  allow("file-read-data file-write-data", `(literal (param "MEMORY"))`);

  out.push(";; what runs outside the sandbox, or changes the engine");
  // The conversation's folder and its repository's, themselves: never removed or made again, so
  // never traded for a link to somewhere else (another bot's folder) the next command would work in.
  deny("file-write-unlink file-write-create", `(literal (param "WORK"))`, `(literal (param "GIT"))`);
  // Nor any folder that holds what's kept from commands (a secret in a cache they write, what runs
  // later, Kuvo Code's own): moved away or cloned whole (clonefile, checked only for the folder),
  // what's in it would be read or changed by its new name; nor one that isn't there yet traded for a
  // link to a folder of its own. (One that isn't there yet can still be made, so moved into place.)
  const holders = new Set<string>();
  for (const kept of [...policy.secrets, ...policy.readOnly, ...policy.kuvo])
    for (let at = path.dirname(kept); at !== path.dirname(at); at = path.dirname(at)) holders.add(at);
  const held = [...[...holders].map(folder => `(literal ${quote(folder)})`), ...(policy.patternFolders ?? []).map(regex)];
  deny("file-write-unlink file-clone", ...held);
  // (Nor closed off by its mode or flags: your home, ~/.ssh, a folder of secrets.)
  deny("file-write-mode file-write-flags", ...held);
  deny("file-write-create", ...held.map(folder => `(require-all ${folder} (vnode-type SYMLINK))`));
  // Nor your agents' sockets or their folders in the temporary folders commands write (moved, one
  // would be reached by a name the rule below doesn't know).
  deny("file-write-unlink", ...(policy.socketPatterns ?? []).map(regex),
    ...(policy.socketFolders ?? []).map(folder => `(require-all ${regex(folder)} (vnode-type DIRECTORY))`));
  deny(WRITE, under("WORK_RE", "/" + GUARDED), under("GIT_RE", "/" + GIT_GUARDED),
    ...Array.from({ length: MOST_FOLDERS }, (_, at) => under(`ALLOW${at}_RE`, "/" + GUARDED)));
  deny(WRITE, ...homes.map(home => inHome(home, `"/(.*/)?(" (param "KEPT") ")(/|$)"`)));

  out.push(";; your secrets");
  // Never read, nor moved, named again or replaced: one in a folder commands write (cargo's sign-in
  // in its cache) would be read by another name.
  deny(`file-read* ${WRITE}`, ...policy.secrets.map(subpath));

  out.push(";; Kuvo Code's own servers and sockets");
  deny("network-outbound", ...policy.ports.map(port => `(remote tcp ${quote(`localhost:${port}`)})`));
  // But an agent's own Kuvo Code tools, run whole in the sandbox.
  if (options.agent) allow("network-outbound", `(remote tcp (string-append "localhost:" (param "PORT")))`);
  deny("network-outbound", ...policy.kuvo.map(folder => `(remote unix-socket ${subpath(folder)})`),
    ...policy.kuvoPatterns.map(pattern => `(remote unix-socket ${regex(pattern)})`));
  out.push(";; other apps' sockets that run what they're asked outside it");
  deny("network-outbound", ...(policy.sockets ?? []).map(folder => `(remote unix-socket ${subpath(folder)})`),
    ...(policy.socketPatterns ?? []).map(pattern => `(remote unix-socket ${regex(pattern)})`));
  // But its own, in its temporary folder (in the app's on this Mac).
  allow("network-outbound", `(remote unix-socket ${param("TMP")})`);
  // And its own SSH agent, Kuvo Code's (vault/ssh.ts), in `/tmp/kuvo-ssh-<uid>` with the app's
  // connections to your machines, which the launcher names (none: nothing).
  allow("network-outbound", `(remote unix-socket (literal (param "SSH")))`);

  // Signals stay allowed: xcodebuild stops the xctest it started through the Simulator, which runs
  // outside the sandbox (refused, it waits forever); a signal reads nothing. Launchd jobs, opening
  // an app and Apple Events don't: each would run a command outside it.
  out.push(";; what would run outside the sandbox: launchd jobs, apps opened (LaunchServices), Apple Events");
  denyAll("job-creation");
  deny("mach-lookup", `(global-name "com.apple.coreservices.launchservicesd")`, `(global-name-prefix "com.apple.lsd.")`,
    `(global-name "com.apple.coreservices.quarantine-resolver")`);
  denyAll("appleevent-send");
  return out.join("\n") + "\n";
}
