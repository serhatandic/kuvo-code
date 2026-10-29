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
  /** Where kuvo-wake keeps a conversation's wake-ups and watches: its bot's folder in `bots`, or its
   * own in `wakes`. */
  bots: string;
  wakes: string;
  /** `run/socket.key`, the box's sockets' key, which the plugin makes anew as an engine first sends
   * commands through the sandbox. */
  key: string;
  platform: "darwin" | "linux";
}

const sh = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** `bin/kuvo-fence`: the shell the engine runs each command with (`kuvo-fence -c <command>`). */
export function launcherScript(places: FencePlaces): string {
  const insideCases = [...places.inside.map(folder => `${sh(folder)}/?*`), sh(places.probe)].join("|");
  const run = places.platform === "darwin"
    ? [
        `escaped() { printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\\\&/g'; }`,
        `exec /usr/bin/sandbox-exec -D WORK="$work" -D GIT="$git" -D TMP="$tmp" -D WAKES="$own" -D WORK_RE="$(escaped "$work")" -D GIT_RE="$(escaped "$git")" -f "$F/$profile.sb" "$shell" "$@"`,
      ]
    : [
        // Kuvo Code's own commands (kuvo-wake's watches) run it with no engine: the box names the
        // engine's runtime in the sandbox's folder. It starts in the command's folder, which the
        // agent writes: Bun's settings (`bunfig.toml`, its preloads) and a `.env` from nowhere.
        `[ -n "$runtime" ] || runtime=$(cat "$F/runtime" 2>/dev/null)`,
        `[ -x "$runtime" ] || { echo "This command can't run in the sandbox here: the engine's runtime wasn't given." >&2; exit 126; }`,
        `BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec "$runtime" --config=/dev/null --no-env-file ${sh(places.runner)} "$F/policy.json" "$work" "$git" "$tmp" "$own" "$shell" "$@"`,
      ];
  return [
    "#!/bin/sh",
    "# Kuvo Code writes this each time its box starts: changes here don't last.",
    "# The engine runs each command an agent (or you, with !) runs through this: the command's own",
    "# shell, in the sandbox. Its plugin (kuvo-sandbox.js) names the conversation's folder.",
    `F=${sh(places.folder)}`,
    `shell=\${KUVO_FENCE_SHELL:-/bin/sh} work=\${KUVO_FENCE_WORK-} git=\${KUVO_FENCE_GIT-} runtime=\${KUVO_FENCE_RUNTIME-}`,
    "unset KUVO_FENCE_SHELL KUVO_FENCE_WORK KUVO_FENCE_GIT KUVO_FENCE_RUNTIME",
    // The engine's own settings and passwords (all of its but the conversation's name), Kuvo Code's
    // passwords and keys, and your SSH agent (which would use the keys the sandbox hides), stay out
    // of the command.
    `for v in $(env | sed -n 's/^\\(OPENCODE_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(KUVO_[A-Za-z0-9_]*\\)=.*/\\1/p'); do`,
    `  case $v in OPENCODE_SESSION_ID) ;; OPENCODE_*|*PASSWORD*|*SECRET*|*TOKEN*|*KEY*|KUVO_HOST_*|KUVO_VAULT_*) unset "$v" ;; esac`,
    `done`,
    "unset SSH_AUTH_SOCK KUVO_WAKE_FOLDER",
    `case $work in /*) ;; *) echo "This command can't run in the sandbox here: its conversation's folder wasn't given." >&2; exit 126 ;; esac`,
    `work=$(cd "$work" 2>/dev/null && pwd -P) || { echo "This command can't run: its conversation's folder isn't there." >&2; exit 126; }`,
    `case $git in /*) git=$(cd "$git" 2>/dev/null && pwd -P) || git=$work ;; *) git=$work ;; esac`,
    "profile=project",
    `case $work in ${insideCases}) profile=inside ;; esac`,
    // Temporary files of its own: each conversation's folder has its own (by a sum no folder's
    // name can be picked to share).
    `sum=$( (printf '%s' "$work" | sha256sum || printf '%s' "$work" | shasum -a 256) 2>/dev/null | cut -c 1-32)`,
    `case $sum in ????????????????????????????????) ;; *) echo "This command can't run in the sandbox here: it can't name its temporary folder." >&2; exit 126 ;; esac`,
    `tmp=$F/tmp/$sum`,
    `(umask 077; mkdir -p "$tmp") && touch "$tmp" && export TMPDIR="$tmp/"`,
    // Its conversation's wake-ups and watches (kuvo-wake): its bot's folder, or its own in the
    // box's wakes folder, which this makes with the folder it works in (never the command's: a
    // watch's check runs there). The engine names the conversation; your ! commands have none, and
    // name no folder (one that isn't there).
    `own=$F/none`,
    `case \${OPENCODE_SESSION_ID-} in`,
    `  ses_*[!A-Za-z0-9_]*|ses_) ;;`,
    `  ses_*)`,
    `    w_own=`,
    `    for b in ${sh(places.bots)}/*/; do [ "$(cat "\${b}session" 2>/dev/null)" = "$OPENCODE_SESSION_ID" ] && w_own=\${b%/} && break; done`,
    `    if [ -z "$w_own" ]; then`,
    `      w_own=${sh(places.wakes)}/$OPENCODE_SESSION_ID`,
    `      [ -f "$w_own/session" ] || { (umask 077; mkdir -p "$w_own") && printf '%s' "$OPENCODE_SESSION_ID" >"$w_own/session" && printf '%s' "$work" >"$w_own/directory"; }`,
    `    fi`,
    `    (umask 077; mkdir -p "$w_own/wakes" "$w_own/watches" "$w_own/inbox") 2>/dev/null && touch "$w_own" && w_own=$(cd "$w_own" && pwd -P) && own=$w_own && export KUVO_WAKE_FOLDER="$own" ;;`,
    `esac`,
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
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const FOLDER = ${JSON.stringify(places.folder)}
const KEY = ${JSON.stringify(places.key)}
const LAUNCHER = ${JSON.stringify(places.launcher)}
const VERSION = ${JSON.stringify(version)}

// The folder's git repository, which its commands may write too: its .git folder, or for a
// worktree the repository's own (where its commits go), found from the engine's folder upwards.
// Only a real one: a command can change what's in the folder, so a .git that's a link, or names
// a folder that isn't a repository, or a worktree the repository doesn't name back, counts for
// nothing (its commands write only the folder).
const real = (where) => { try { return fs.realpathSync(where) } catch { return "" } }
function isRepository(git) {
  try {
    if (fs.lstatSync(git).isSymbolicLink() || !fs.statSync(path.join(git, "HEAD")).isFile()) return false
    return fs.statSync(path.join(git, "objects")).isDirectory() && fs.statSync(path.join(git, "refs")).isDirectory()
  } catch { return false }
}
function repository(folder) {
  for (let at = folder; at && at !== path.dirname(at); at = path.dirname(at)) {
    const git = path.join(at, ".git")
    let stat
    try { stat = fs.lstatSync(git) } catch { continue }
    if (stat.isSymbolicLink()) return ""
    if (stat.isDirectory()) return isRepository(git) ? real(git) : ""
    try {
      const named = fs.readFileSync(git, "utf8").match(/^gitdir:\\s*(.+)$/m)?.[1]?.trim()
      if (!named) return ""
      // A worktree's own folder in the repository (\`<repository>/worktrees/<name>\`), which names
      // this .git back.
      const own = real(path.resolve(at, named))
      if (!own || path.basename(path.dirname(own)) !== "worktrees") return ""
      if (real(fs.readFileSync(path.join(own, "gitdir"), "utf8").trim()) !== real(git)) return ""
      const common = real(path.resolve(own, fs.readFileSync(path.join(own, "commondir"), "utf8").trim()))
      return common && common === path.dirname(path.dirname(own)) && isRepository(common) ? common : ""
    } catch { return "" }
  }
  return ""
}

export default {
  id: "kuvo-code.sandbox",
  setup: async (ctx) => {
    const work = ctx.location?.directory ?? ""
    const git = work ? repository(work) : ""
    // Tells the box this engine sends its commands through the sandbox. As it first does, before any
    // command runs in it: a new key for the box's sockets, so one a command read before (it could
    // read the box's folder then) opens nothing.
    const note = path.join(FOLDER, "engine.json")
    let noted = {}
    try { noted = JSON.parse(fs.readFileSync(note, "utf8")) } catch {}
    if (noted.pid !== process.pid || noted.version !== VERSION) {
      const made = KEY + "." + process.pid
      try { fs.writeFileSync(made, crypto.randomBytes(32).toString("hex") + "\\n", { mode: 0o600 }); fs.renameSync(made, KEY) } catch { try { fs.rmSync(made, { force: true }) } catch {} }
    }
    try { fs.writeFileSync(note, JSON.stringify({ pid: process.pid, version: VERSION })) } catch {}
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
