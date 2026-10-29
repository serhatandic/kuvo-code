// The sandbox's policy in macOS's own terms: a Seatbelt profile for `sandbox-exec`, which the
// launcher (`bin/kuvo-fence`) runs each command in, with the conversation's folder, its git
// repository, the commands' temporary folder and where its wake-ups are kept as the profile's
// parameters (WORK, GIT, TMP, WAKES).
//
// Later rules win, so each part carves out of the ones before it. Two profiles: one for a folder
// outside Kuvo Code's (a project), where Kuvo Code's folders are hidden even inside it; and one
// for a folder of Kuvo Code's own (a chat's or a bot's), which is given back after them, alone
// among its neighbours (another bot's folder stays hidden).
//
// `watch`: each refusal is allowed and logged instead (with its tag), for what would have been
// stopped (`log show --predicate 'sender == "Sandbox"'`).

import type { FencePolicy } from "./policy";

export interface SeatbeltOptions {
  /** The conversation's folder is inside Kuvo Code's own (a chat's or a bot's). */
  inside: boolean;
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
// settings in a project, whose hooks and servers they run as they start there: Claude Code's,
// Codex's, Cursor's, Grok's and Gemini's folders, and Claude Code's `.mcp.json`) or change what the
// engine does (its settings, its plugins).
const GIT_GUARDED = String.raw`((modules/.+|worktrees/[^/]+)/)?(hooks(/|$)|config(\.worktree)?$)`;
const GUARDED = String.raw`(.*/)?(\.git/${GIT_GUARDED}|\.(opencode|claude|codex|cursor|grok|gemini)(/|$)|opencode\.jsonc?$|\.mcp\.json$)`;

export function seatbeltProfile(policy: FencePolicy, options: SeatbeltOptions): string {
  const mode = options.mode ?? "enforce";
  const tag = quote(options.tag ?? "kuvo-sandbox");
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
  // Regexes over a parameter take its escaped copy (`WORK_RE`, `GIT_RE`: the launcher escapes them).
  const under = (base: string, rest: string) => `(regex (string-append "^" (param ${quote(base)}) ${quote(rest)}))`;

  out.push(";; writes: its folder, its repository, temporary folders, devices and tools' caches");
  deny("file-write*", subpath("/"));
  allow("file-write*", ...policy.writable.map(subpath), param("WORK"), param("GIT"));
  deny("file-write*", ...policy.readOnly.map(subpath));

  // What's in them is neither read (nor listed) nor written; a path through them is still looked up,
  // so a command can go to its own folder inside them. (A carve-out overrides a refusal only of
  // the very same operations, so each names them as the refusal does.)
  out.push(";; Kuvo Code's own folders: neither read nor written; its helpers run");
  const HIDDEN = "file-read-data file-write*";
  deny(HIDDEN, ...policy.kuvo.map(subpath), ...policy.kuvoPatterns.map(regex));
  allow("file-read-data", ...policy.kuvoReadable.map(subpath));
  allow(HIDDEN, param("TMP"));
  if (options.inside) allow(HIDDEN, param("WORK"));
  // Its conversation's wake-ups and watches (kuvo-wake): what's kept there is read, and only its
  // inbox written, which the box takes in, out of its reach (kuvo-wake's `take`).
  allow("file-read-data", param("WAKES"));
  allow(HIDDEN, `(subpath (string-append (param "WAKES") "/inbox"))`);

  out.push(";; what runs outside the sandbox, or changes the engine");
  deny("file-write*", under("WORK_RE", "/" + GUARDED), under("GIT_RE", "/" + GIT_GUARDED));

  out.push(";; your secrets");
  deny("file-read*", ...policy.secrets.map(subpath));

  out.push(";; Kuvo Code's own servers and sockets");
  deny("network-outbound", ...policy.ports.map(port => `(remote tcp ${quote(`localhost:${port}`)})`));
  deny("network-outbound", ...policy.kuvo.map(folder => `(remote unix-socket ${subpath(folder)})`),
    ...policy.kuvoPatterns.map(pattern => `(remote unix-socket ${regex(pattern)})`));
  // But its own SSH agent, Kuvo Code's (vault/ssh.ts), in `/tmp/kuvo-ssh-<uid>` with the app's
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
