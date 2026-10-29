// What the box writes for the sandbox, with its own folders in them: the engine's plugin, which
// sends each command through the launcher; and the launcher, which runs the command's shell in
// the sandbox (`sandbox-exec` on macOS, the Landlock script through the engine's Bun on Linux).
//
// The plugin is set up once for each folder the engine works in, and takes that folder from the
// engine (`ctx.location.directory`): never from the command, whose own folder (the shell tool's
// `workdir`) the agent picks. The engine reads its plugins folder as it runs, so a plugin written
// now is used from the next command on, with no restart.

/** Where the box keeps the sandbox's own files (profiles, the plugin's note, commands' temporary
 * folder), what it hides, and where commands' own folders inside Kuvo Code's are. */
export interface FencePlaces {
  /** `run/fence` */
  folder: string;
  /** `bin/kuvo-fence`, and the Linux script beside it. */
  launcher: string;
  runner: string;
  /** Folders of Kuvo Code's own whose folders are each a conversation's own (bots', chats'): in
   * one, a command gets that folder back, and not its neighbours. */
  inside: string[];
  /** The box's own check's folder (`state.ts`, `probe`), also given back. */
  probe: string;
  platform: "darwin" | "linux";
}

const sh = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** `bin/kuvo-fence`: the shell the engine runs each command with (`kuvo-fence -c <command>`). */
export function launcherScript(places: FencePlaces): string {
  const insideCases = [...places.inside.map(folder => `${sh(folder)}/?*`), sh(places.probe)].join("|");
  const run = places.platform === "darwin"
    ? [
        `escaped() { printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\\\&/g'; }`,
        `exec /usr/bin/sandbox-exec -D WORK="$work" -D GIT="$git" -D TMP="$F/tmp" -D WORK_RE="$(escaped "$work")" -D GIT_RE="$(escaped "$git")" -f "$F/$profile.sb" "$shell" "$@"`,
      ]
    : [
        `[ -x "$runtime" ] || { echo "This command can't run in the sandbox here: the engine's runtime wasn't given." >&2; exit 126; }`,
        `BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec "$runtime" ${sh(places.runner)} "$F/policy.json" "$work" "$git" "$F/tmp" "$shell" "$@"`,
      ];
  return [
    "#!/bin/sh",
    "# Kuvo Code writes this each time its box starts: changes here don't last.",
    "# The engine runs each command an agent (or you, with !) runs through this: the command's own",
    "# shell, in the sandbox. Its plugin (kuvo-sandbox.js) names the conversation's folder.",
    `F=${sh(places.folder)}`,
    `shell=\${KUVO_FENCE_SHELL:-/bin/sh} work=\${KUVO_FENCE_WORK-} git=\${KUVO_FENCE_GIT-} runtime=\${KUVO_FENCE_RUNTIME-}`,
    "unset KUVO_FENCE_SHELL KUVO_FENCE_WORK KUVO_FENCE_GIT KUVO_FENCE_RUNTIME",
    `case $work in /*) ;; *) echo "This command can't run in the sandbox here: its conversation's folder wasn't given." >&2; exit 126 ;; esac`,
    `work=$(cd "$work" 2>/dev/null && pwd -P) || { echo "This command can't run: its conversation's folder isn't there." >&2; exit 126; }`,
    `case $git in /*) git=$(cd "$git" 2>/dev/null && pwd -P) || git=$work ;; *) git=$work ;; esac`,
    "profile=project",
    `case $work in ${insideCases}) profile=inside ;; esac`,
    `mkdir -p "$F/tmp" && export TMPDIR="$F/tmp/"`,
    ...run,
    "",
  ].filter(line => line !== "").join("\n") + "\n";
}

/** The engine's plugin (`kuvo-sandbox.js` in its plugins folder). `version` names this box's
 * sandbox files, so the box knows its engine has these and not an older plugin's. */
export function pluginScript(places: FencePlaces, version: string): string {
  return `// Kuvo Code writes this each time its box starts: changes here don't last.
// Each command the engine runs (the agent's, and yours with !) goes through Kuvo Code's sandbox:
// its shell in bin/kuvo-fence, which may write only in this conversation's folder and its git
// repository, and can't read Kuvo Code's own folders or your secrets.
import fs from "node:fs"
import path from "node:path"

const FOLDER = ${JSON.stringify(places.folder)}
const LAUNCHER = ${JSON.stringify(places.launcher)}
const VERSION = ${JSON.stringify(version)}

// The folder's git repository: its .git folder, or for a worktree the repository's own (where its
// commits go), found from the engine's folder upwards.
function repository(folder) {
  for (let at = folder; at && at !== path.dirname(at); at = path.dirname(at)) {
    const git = path.join(at, ".git")
    let stat
    try { stat = fs.statSync(git) } catch { continue }
    if (stat.isDirectory()) return git
    try {
      const named = fs.readFileSync(git, "utf8").match(/^gitdir:\\s*(.+)$/m)?.[1]?.trim()
      if (!named) return ""
      const own = path.resolve(at, named)
      try { return path.resolve(own, fs.readFileSync(path.join(own, "commondir"), "utf8").trim()) } catch { return own }
    } catch { return "" }
  }
  return ""
}

export default {
  id: "kuvo-code.sandbox",
  setup: async (ctx) => {
    const work = ctx.location?.directory ?? ""
    const git = work ? repository(work) : ""
    // Tells the box this engine sends its commands through the sandbox.
    try { fs.writeFileSync(path.join(FOLDER, "engine.json"), JSON.stringify({ pid: process.pid, version: VERSION })) } catch {}
    await ctx.shell.hook("create.before", (input) => {
      input.env.KUVO_FENCE_SHELL = input.shell
      input.env.KUVO_FENCE_WORK = work
      input.env.KUVO_FENCE_GIT = git
      input.env.KUVO_FENCE_RUNTIME = process.execPath
      input.shell = LAUNCHER
    })
  },
}
`;
}
