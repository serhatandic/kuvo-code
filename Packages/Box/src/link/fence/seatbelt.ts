// The sandbox's policy in macOS's own terms: a Seatbelt profile for `sandbox-exec`, which the
// launcher (`bin/kuvo-fence`) runs each command in, with the conversation's folder, its git
// repository and the commands' temporary folder as the profile's parameters (WORK, GIT, TMP).
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
const regex = (pattern: string) => `(regex #${quote(pattern)})`;
const param = (name: string) => `(subpath (param ${quote(name)}))`;

// Inside a folder commands write: what would run outside the sandbox (git's hooks, its config, which
// can name programs) or change what the engine does (its settings, its plugins).
const GUARDED = String.raw`(.*/)?(\.git/(hooks(/|$)|config$)|\.opencode(/|$)|opencode\.jsonc?$)`;

export function seatbeltProfile(policy: FencePolicy, options: SeatbeltOptions): string {
  const mode = options.mode ?? "enforce";
  const tag = quote(options.tag ?? "kuvo-sandbox");
  const out = ["(version 1)", "(allow default)"];
  const deny = (operations: string, ...filters: string[]) => {
    if (!filters.length) return;
    out.push(mode === "enforce"
      ? `(deny ${operations} (with message ${tag}) ${filters.join(" ")})`
      : `(allow ${operations} (with report) (with message ${tag}) ${filters.join(" ")})`);
  };
  const allow = (operations: string, ...filters: string[]) => {
    if (filters.length) out.push(`(allow ${operations} ${filters.join(" ")})`);
  };
  // Regexes over a parameter take its escaped copy (`WORK_RE`, `GIT_RE`: the launcher escapes them).
  const under = (base: string, rest: string) => `(regex (string-append "^" (param ${quote(base)}) ${quote(rest)}))`;

  out.push(";; writes: its folder, its repository, temporary folders, devices and tools' caches");
  deny("file-write*", subpath("/"));
  allow("file-write*", ...policy.writable.map(subpath), param("WORK"), param("GIT"));

  // What's in them is neither read (nor listed) nor written; a path through them is still looked up,
  // so a command can go to its own folder inside them. (A carve-out overrides a refusal only of
  // the very same operations, so each names them as the refusal does.)
  out.push(";; Kuvo Code's own folders: neither read nor written; its helpers run");
  const HIDDEN = "file-read-data file-write*";
  deny(HIDDEN, ...policy.kuvo.map(subpath), ...policy.kuvoPatterns.map(regex));
  allow("file-read-data", ...policy.kuvoReadable.map(subpath));
  allow(HIDDEN, param("TMP"));
  if (options.inside) allow(HIDDEN, param("WORK"));

  out.push(";; what runs outside the sandbox, or changes the engine");
  deny("file-write*", under("WORK_RE", "/" + GUARDED), under("GIT_RE", String.raw`/(hooks(/|$)|config$)`));

  out.push(";; your secrets");
  deny("file-read*", ...policy.secrets.map(subpath));

  out.push(";; Kuvo Code's own servers and sockets");
  deny("network-outbound", ...policy.ports.map(port => `(remote tcp ${quote(`localhost:${port}`)})`));
  deny("network-outbound", ...policy.kuvo.map(folder => `(remote unix-socket ${subpath(folder)})`),
    ...policy.kuvoPatterns.map(pattern => `(remote unix-socket ${regex(pattern)})`));

  // Signals stay allowed: xcodebuild stops the xctest it started through the Simulator, which runs
  // outside the sandbox (refused, it waits forever); a signal reads nothing. Launchd jobs don't:
  // `launchctl submit` would run a command outside it.
  out.push(";; jobs that would run outside the sandbox");
  deny("job-creation");
  return out.join("\n") + "\n";
}
