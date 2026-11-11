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
import { escapeRegex, type FencePolicy } from "./policy";

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
// or a worktree's repository, and the folders that hold those, `modules` and `worktrees`, and the
// agents' folders) can't be made, moved or removed, only written in.
const GIT_GUARDED = String.raw`((((worktrees/[^/]+/)?modules/.+|worktrees/[^/]+)/)?(hooks(/|$)|config(\.worktree)?$|commondir$|gitdir$)|(modules|worktrees)(/[^/]+)?$|worktrees/[^/]+/modules$)`;
// A submodule's repository is any folder below `modules` (`vendor/lib`, one's own `modules/b`), so
// none of those folders is made, moved or removed by a command: one moved in would bring its own
// hooks and settings. But for what git keeps in each as it fetches and tidies up (its objects, refs,
// logs), whose folders come and go.
const MODULE_FOLDERS = String.raw`/(worktrees/[^/]+/)?modules/.+`;
const MODULE_KEPT = String.raw`/(worktrees/[^/]+/)?modules/.+/(objects/([0-9a-f][0-9a-f]|pack|info|tmp_objdir-[^/]+)|(refs|logs|lfs|rr-cache)(/.+)?|info)$`;
const AGENTS_GUARDED = String.raw`\.claude/settings(\.local)?\.json|\.mcp\.json|\.codex/(config\.toml|hooks\.json|\.env|rules(/.*)?)|\.cursor/(hooks|mcp)\.json|\.(gemini|grok)/settings\.json|\.grok/(config\.toml|sandbox\.toml|lsp\.json|(hooks|plugins|agents|workflows)(/.*)?)|\.(claude|cursor)/hooks(/.*)?|\.(claude|codex|cursor|gemini|grok)`;
/** Every kind of write, by name, and `file-write*`. A rule on a kind by its name is checked before any
 * on `file-write*`, whatever their order, so the profile names them all wherever it carves one out of
 * another, and later rules win; and some writes are checked only as `file-write*` (a file's times,
 * set by `utimes`, on macOS 27), so it's named with them. */
const WRITE = "file-write* file-write-acl file-write-create file-write-data file-write-finderinfo file-write-flags file-write-mode file-write-owner file-write-setugid file-write-times file-write-unlink file-write-xattr";

/** What's done in your home: everything a write does but unlinking (so neither deleting nor moving). */
const HOME_WRITES = "file-write* file-write-create file-write-data file-write-flags file-write-mode file-write-times file-write-xattr";

/** Folders as few regular expressions as fit the system's limit on a profile's strings (about 1 KB:
 * longer, it can't read the profile), each a folder and all in it. */
function chunked(folders: string[], most = 700): string[] {
  const out: string[] = [];
  let names: string[] = [];
  const close = () => { if (names.length) out.push(`^(${names.join("|")})(/|$)`); names = []; };
  for (const folder of folders) {
    const name = escapeRegex(folder);
    if (names.length && names.join("|").length + name.length + 1 > most) close();
    names.push(name);
  }
  close();
  return out;
}

/** What's kept from commands inside a folder they write (git's hooks and settings, the engine's and
 * the coding agents' settings), as a pattern over the path after that folder's `/`. */
export const GUARDED = String.raw`(.*/)?(\.git$|\.git/(${GIT_GUARDED})|\.opencode(/|$)|opencode\.jsonc?$|(${AGENTS_GUARDED})$)`;

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
  // The walls: ~/Library, your personal folders and what runs later. The conversation's folder, its
  // repository and what Also Allowed gives its project (the launcher's parameters) are written
  // whole where they're inside one (a project in your Documents, `~/.config/nvim`), and around them
  // where they hold some (your home): which, the profile works out as it's read.
  const walls = [...(policy.homeKept ?? []), ...(policy.personal ?? []), ...policy.readOnly];
  out.push(`(define kuvo-walls '(${walls.map(quote).join(" ")}))`);
  out.push(`(define (kuvo-within? p k) (or (string=? p k) (and (> (string-length p) (string-length k)) (string=? (substring p 0 (+ (string-length k) 1)) (string-append k "/")))))`);
  out.push(`(define (kuvo-in-wall? p) (define (look ws) (cond ((null? ws) #f) ((kuvo-within? p (car ws)) #t) (else (look (cdr ws))))) (look kuvo-walls))`);
  const given = ["WORK", "GIT", ...Array.from({ length: MOST_FOLDERS }, (_, at) => `ALLOW${at}`)];
  const allowGiven = (inWall: boolean) => {
    for (const name of given) out.push(`(if ${inWall ? "" : "(not "}(kuvo-in-wall? (param ${quote(name)}))${inWall ? "" : ")"} (allow ${WRITE} ${param(name)}))`);
  };
  deny(WRITE, subpath("/"));
  // (A move takes unlinking what's moved, so with no unlink, nothing's moved either.)
  allow(HOME_WRITES, ...(policy.homeWrites ?? []).map(subpath));
  allow(WRITE, ...policy.writable.map(subpath));
  // What you let this project's commands write (Also Allowed) with its folder, before what follows
  // takes back the walls, Kuvo Code's folders, git's hooks and the agents' settings in them.
  allowGiven(false);
  deny(WRITE, ...(policy.homeKept ?? []).map(subpath));
  allow(HOME_WRITES, ...(policy.homeOpen ?? []).map(subpath));
  // A new file is made and written in one go; one that's there isn't written, truncated, replaced,
  // removed or changed in mode (each a new file's own first open still writes it).
  deny("file-write-data file-write-unlink file-write-mode file-write-flags", ...(policy.personal ?? []).map(subpath));
  // (Tools' caches in ~/Library again.)
  allow(WRITE, ...policy.writable.filter(folder => (policy.homeKept ?? []).some(kept => folder.startsWith(kept + "/"))).map(subpath));
  // What runs later, in as few rules as the system can read (each a pattern well under its limit):
  // and every other project's in your home too, its git hooks and settings and its agents', but in
  // tools' caches (Xcode's and SwiftPM's checkouts, cargo's), which are theirs to clone and remove.
  const caches = (home: string) => policy.writable.filter(folder => folder.startsWith(home + "/")).map(folder => `(require-not ${subpath(folder)})`);
  deny(WRITE, ...chunked(policy.readOnly).map(regex), ...(policy.readOnlyPatterns ?? []).map(regex),
    ...(policy.homeWrites ?? []).map(home => `(require-all ${regex(`^${escapeRegex(home)}/${GUARDED}`)} ${caches(home).join(" ")})`));
  // (But tools' caches inside one again, as Linux's sandbox has them: pnpm's store in its folder on
  // your PATH.)
  allow(WRITE, ...policy.writable.filter(folder => policy.readOnly.some(wall => folder.startsWith(wall + "/"))).map(subpath));
  allowGiven(true);

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
  // Its agent's own memory, in the bot's folder: only there does it write in that folder.
  allow(HIDDEN, `(subpath (string-append (param "WAKES") "/memory"))`);
  // Its bot's memory, which the launcher names (MEMORY): read and written in place, its times set
  // (`touch`, checked only as `file-write*`: what's named above stays refused), never made, moved or
  // removed (so never a link, or another name for another file).
  allow("file-read-data file-write-data file-write-times file-write*", `(literal (param "MEMORY"))`);
  // Beside it, the new files Claude Code saves it through (MEMORY_RE, escaped; none for no memory):
  // it saves a file whole in `MEMORY.md.tmp.<pid>.<random hex>` first (as of 2.1.319), which it
  // renames onto it; that rename is refused (EPERM), so it writes the memory in place then, and
  // removes the new one. (Where it can't make the new one at all, it gives up on macOS: only EACCES,
  // Linux's, sends it in place.) By that name alone, so never one the box writes through (its
  // Shelf's `.kuvo-restore`); only files, made, written and removed, never a symlink or folder (a
  // hard link only of a file it writes anyway), never moved onto the memory. When Claude Code
  // changes how it saves, test/sandbox-bot-memory.test.ts says so where it's installed.
  allow(`file-write* file-write-create file-write-data file-write-mode file-write-times file-write-unlink`,
    `(require-all ${under("MEMORY_RE", String.raw`\.tmp\.[0-9]+\.[0-9a-f]+$`)} (vnode-type REGULAR-FILE))`);

  out.push(";; what runs outside the sandbox, or changes the engine");
  // The conversation's folder and its repository's, themselves: never removed or made again, so
  // never traded for a link to somewhere else (another bot's folder) the next command would work in.
  deny("file-write-unlink file-write-create", `(literal (param "WORK"))`, `(literal (param "GIT"))`);
  // Nor its temporary folder, which in Kuvo Code's would lead the next command into them (its keys):
  // removed (`rm -rf $TMPDIR`) it may be, but made again only as a folder, never a link or a file in
  // its place (nor one moved there).
  deny("file-write-create", `(require-all (literal (param "TMP")) (require-not (vnode-type DIRECTORY)))`);
  // Nor any folder that holds what's kept from commands (a secret in a cache they write, what runs
  // later, Kuvo Code's own): moved away or cloned whole (clonefile, checked only for the folder),
  // what's in it would be read or changed by its new name; nor one that isn't there yet traded for a
  // link to a folder of its own. (One that isn't there yet can still be made, so moved into place.)
  const holders = new Set<string>();
  for (const kept of [...policy.secrets, ...policy.readOnly, ...policy.kuvo])
    for (let at = path.dirname(kept); at !== path.dirname(at); at = path.dirname(at)) holders.add(at);
  // (And the folders above other apps' sockets, so one isn't moved and reached by another name.)
  for (const socket of policy.sockets ?? [])
    for (let at = path.dirname(socket); at !== path.dirname(at); at = path.dirname(at)) holders.add(at);
  const held = [...[...holders].map(folder => `(literal ${quote(folder)})`), ...(policy.patternFolders ?? []).map(regex)];
  deny("file-write-unlink file-clone", ...held);
  // (Nor closed off by its mode or flags: your home, ~/.ssh, a folder of secrets.)
  deny("file-write-mode file-write-flags", ...held);
  deny("file-write-create", ...held.map(folder => `(require-all ${folder} (vnode-type SYMLINK))`));
  // Nor other apps' sockets, the folders that hold them, or your agents' sockets and their folders
  // in the temporary folders commands write: moved, one would be reached by a name the rules below
  // don't know. (The other files in those folders, an app's settings saved by a new name and
  // renamed into place, and a command's own files by such a name, are still theirs to change.)
  deny("file-write-unlink", ...(policy.sockets ?? []).flatMap(socket => [`(literal ${quote(socket)})`,
    `(require-all ${subpath(socket)} (require-any (vnode-type SOCKET) (vnode-type DIRECTORY)))`]),
    ...(policy.socketPatterns ?? []).map(pattern => `(require-all ${regex(pattern)} (vnode-type SOCKET))`),
    ...(policy.socketFolders ?? []).map(folder => `(require-all ${regex(folder)} (vnode-type DIRECTORY))`));
  deny(WRITE, under("WORK_RE", "/" + GUARDED), under("GIT_RE", "/" + GIT_GUARDED),
    ...Array.from({ length: MOST_FOLDERS }, (_, at) => under(`ALLOW${at}_RE`, "/" + GUARDED)));
  deny(WRITE, ...homes.map(home => inHome(home, `"/(.*/)?(" (param "KEPT") ")(/|$)"`)));
  deny("file-write-create file-write-unlink", `(require-all ${under("GIT_RE", MODULE_FOLDERS)} (vnode-type DIRECTORY))`);
  allow("file-write-create file-write-unlink", `(require-all ${under("GIT_RE", MODULE_KEPT)} (vnode-type DIRECTORY))`);

  out.push(";; your secrets");
  // Never read, nor moved, named again or replaced: one in a folder commands write (cargo's sign-in
  // in its cache) would be read by another name. (Read by name too, so no folder read above gives
  // one back.) But a coding agent's own sign-in, run whole in the sandbox: in its first home (your
  // Codex's `auth.json`), read and written as the rest of its state; never your own in another home
  // of it (your Codex's, for an account you added).
  if (policy.secrets.length) deny(`file-read* file-read-data ${WRITE}`, `(require-all (require-any ${policy.secrets.map(subpath).join(" ")}) (require-not ${param("OWN0")}))`);

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
  // `top`, which the sandbox can't start (it's setuid), runs as it is: it shows what runs and how
  // busy it is, never another program's environment, as `ps -E` would (which stays refused).
  allow("process-exec", `(literal "/usr/bin/top")`, "(with no-sandbox)");
  // Nor apps' and the system's preferences, written through cfprefsd (`defaults write`), outside the
  // files the rules above keep: launchd's and login items' among them. Reading them stays.
  denyAll("user-preference-write");
  return out.join("\n") + "\n";
}
