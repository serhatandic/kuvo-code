// What the box writes for the sandbox, with its own folders in them: the engine's plugin, which
// sends each command through the launcher; and the launcher, which runs the command's shell in
// the sandbox (`sandbox-exec` on macOS, the Landlock script through the engine's Bun on Linux).
//
// The plugin is set up once for each folder the engine works in, and takes that folder from the
// engine (`ctx.location.directory`): never from the command, whose own folder (the shell tool's
// `workdir`) the agent picks. The engine reads its plugins folder as it runs, so a plugin written
// now is used from the next command on, with no restart.

import { MOST_FOLDERS } from "./allowed";
import { AGENT_FOLDERS } from "./seatbelt";

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
  /** Where the launcher notes each conversation for its SSH agent, and where the agents are
   * (vault/ssh.ts): there only while agents may use the vault. */
  sshFor: string;
  sshAgents: string;
  platform: "darwin" | "linux";
}

const sh = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** `bin/kuvo-fence`: the shell the engine runs each command with (`kuvo-fence -c <command>`). */
export function launcherScript(places: FencePlaces): string {
  const insideCases = [...places.inside.map(folder => `${sh(folder)}/?*`), sh(places.probe)].join("|");
  const run = places.platform === "darwin"
    ? [
        // Its refusals, in macOS's log, name its conversation and the command, by a sum of it (a
        // sandbox_ask's card shows what stopped that command: fence/outside.ts).
        `for c_last; do :; done`,
        `c_sum=$( (printf '%s' "\${c_last-}" | shasum -a 256) 2>/dev/null | cut -c 1-16)`,
        `case \${OPENCODE_SESSION_ID-} in ses_*[!A-Za-z0-9_]*|ses_|'') tag="kuvo-sandbox" ;; *) tag="kuvo-sandbox $OPENCODE_SESSION_ID $c_sum" ;; esac`,
        `[ "$as_bun" != 1 ] || export BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`,
        `exec /usr/bin/sandbox-exec -D TAG="$tag" -D WORK="$work" -D GIT="$git" -D TMP="$tmp" -D WAKES="$own" -D SSH="$ssh" -D WORK_RE="$(escaped "$work")" -D GIT_RE="$(escaped "$git")" ${Array.from({ length: MOST_FOLDERS }, (_, at) => `-D ALLOW${at}="$a${at}" -D ALLOW${at}_RE="$r${at}"`).join(" ")} ${Array.from({ length: AGENT_FOLDERS }, (_, at) => `-D OWN${at}="$o${at}" -D OWN${at}_RE="$q${at}" -D READ${at}="$k${at}"`).join(" ")} -D STATE="$(names "$state_list")" -D KEPT="$(names "$kept_list")" -D PORT="$port" -f "$F/$profile$agent.sb" "$shell" "$@"`,
      ]
    : [
        // Kuvo Code's own commands (kuvo-wake's watches) run it with no engine: the box names the
        // engine's runtime in the sandbox's folder. It starts in the command's folder, which the
        // agent writes: Bun's settings (`bunfig.toml`, its preloads) and a `.env` from nowhere.
        `[ -n "$runtime" ] || runtime=$(cat "$F/runtime" 2>/dev/null)`,
        `[ -x "$runtime" ] || { echo "This command can't run in the sandbox here: the engine's runtime wasn't given." >&2; exit 126; }`,
        `KUVO_FENCE_OWN="$own_list" KUVO_FENCE_READ="$read_list" KUVO_FENCE_BUN="$as_bun" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec "$runtime" --config=/dev/null --no-env-file ${sh(places.runner)} "$F/policy.json" "$work" "$git" "$tmp" "$own" "$allowed" "$shell" "$@"`,
      ];
  return [
    "#!/bin/sh",
    "# Kuvo Code writes this each time its box starts: changes here don't last.",
    "# The engine runs each command an agent (or you, with !) runs through this: the command's own",
    "# shell, in the sandbox. Its plugin (kuvo-sandbox.js) names the conversation's folder.",
    `F=${sh(places.folder)}`,
    `shell=\${KUVO_FENCE_SHELL:-/bin/sh} work=\${KUVO_FENCE_WORK-} git=\${KUVO_FENCE_GIT-} runtime=\${KUVO_FENCE_RUNTIME-}`,
    // A coding agent run whole in it (the agents' bridge names them): its homes and the folders it
    // only reads, one a line; in its homes, the folders of its state and what it never writes, by
    // name (`*` for any letters), one a line; and its Kuvo Code tools' port.
    // And whether its program is the engine's runtime, run as Bun (Cursor's SDK, in a process of its own).
    `own_list=\${KUVO_FENCE_OWN-} read_list=\${KUVO_FENCE_READ-} state_list=\${KUVO_FENCE_STATE-} kept_list=\${KUVO_FENCE_KEPT-} port=\${KUVO_FENCE_PORT:-0} as_bun=\${KUVO_FENCE_BUN-}`,
    "unset KUVO_FENCE_SHELL KUVO_FENCE_WORK KUVO_FENCE_GIT KUVO_FENCE_RUNTIME KUVO_FENCE_OWN KUVO_FENCE_READ KUVO_FENCE_STATE KUVO_FENCE_KEPT KUVO_FENCE_PORT KUVO_FENCE_BUN",
    `case $port in *[!0-9]*|'') port=0 ;; esac`,
    `agent=; [ "$port" = 0 ] || agent=-agent`,
    ...Array.from({ length: AGENT_FOLDERS }, (_, at) => `o${at}=$F/none q${at}=- k${at}=$F/none`),
    `i=0; while IFS= read -r line; do [ $i -lt ${AGENT_FOLDERS} ] || break; case $line in /*) eval "o$i=\\$line"; i=$((i + 1)) ;; esac; done <<EOF_OWN`,
    "$own_list",
    "EOF_OWN",
    `i=0; while IFS= read -r line; do [ $i -lt ${AGENT_FOLDERS} ] || break; case $line in /*) eval "k$i=\\$line"; i=$((i + 1)) ;; esac; done <<EOF_READ`,
    "$read_list",
    "EOF_READ",
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
    // On this Mac, in the app's own temporary folder instead (`temporary`: it, and a key commands
    // can't read), by a short name: a socket's path is at most 103 letters on macOS, and a server's
    // tests or Python's multiprocessing make theirs in it. (Named from the key, so a command still
    // can't pick a folder whose name another conversation's has.)
    ...(places.platform === "darwin" ? [
      `if [ -f "$F/temporary" ]; then`,
      `  { IFS= read -r t_root; IFS= read -r t_key; } <"$F/temporary"`,
      `  t_name=$( (printf '%s\n%s' "$t_key" "$work" | shasum -a 256) 2>/dev/null | cut -c 1-8)`,
      `  case $t_root:$t_key:$t_name in /*:????????????????????????????????????????????????????????????????:????????) tmp=$t_root/$t_name ;; *) echo "This command can't run in the sandbox here: it can't name its temporary folder." >&2; exit 126 ;; esac`,
      `fi`,
    ] : []),
    // What Also Allowed gives this project's commands to write (fence/allowed.ts): the box's file
    // for it, by the same sum, one folder a line; each that isn't given stays where nothing is.
    `allowed=$F/allowed/$sum`,
    // A worktree of a repository (a session's branch) has its repository's folder's: the project's.
    `if [ -f "$work/.git" ]; then case $git in */.git) p_sum=$( (printf '%s' "\${git%/.git}" | sha256sum || printf '%s' "\${git%/.git}" | shasum -a 256) 2>/dev/null | cut -c 1-32); case $p_sum in ????????????????????????????????) allowed=$F/allowed/$p_sum ;; esac ;; esac; fi`,
    // (On a Mac, each escaped too, for what's kept from its commands inside it; `-` matches no path.)
    ...(places.platform === "darwin" ? [`escaped() { printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\\\&/g'; }`,
      // An agent's homes, escaped too, and the names in them as one pattern (`-/` matches no name).
      ...Array.from({ length: AGENT_FOLDERS }, (_, at) => `q${at}=$(escaped "$o${at}")`),
      "names() { r=; while IFS= read -r n; do case $n in ''|*/*) ;; *) r=\"$r|$(escaped \"$n\" | sed 's/\\\\\\*/[^\\/]*/g')\" ;; esac; done <<EOF_NAMES",
      "$1",
      "EOF_NAMES",
      "if [ -n \"$r\" ]; then printf '%s' \"${r#|}\"; else printf '%s' -/; fi; }",
    ] : []),
    ...Array.from({ length: MOST_FOLDERS }, (_, at) => `a${at}=$F/none r${at}=-`),
    `if [ -f "$allowed" ]; then i=0; while IFS= read -r line && [ $i -lt ${MOST_FOLDERS} ]; do case $line in /*) eval "a$i=\\$line"; ${places.platform === "darwin" ? `eval "r$i=\\$(escaped \\"\\$line\\")"; ` : ""}i=$((i + 1)) ;; esac; done <"$allowed"; else allowed=$F/none; fi`,
    `(umask 077; mkdir -p "$tmp") && touch "$tmp" && export TMPDIR="$tmp/"`,
    // (As the sandbox compares paths: through links, `/var` being `/private/var`.)
    ...(places.platform === "darwin" ? [`tmp=$(cd "$tmp" 2>/dev/null && pwd -P) || { echo "This command can't run: its temporary folder isn't there." >&2; exit 126; }`] : []),
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
    // Kuvo Code's SSH agent for the conversation (the vault's SSH keys), while agents may use it:
    // noted where commands can't write, then handed the command once the box has opened it. Its
    // name starts with its note's sum; the rest, no command can list or guess.
    `ssh=`,
    `if [ -d ${sh(places.sshAgents)} ]; then`,
    `  case \${OPENCODE_SESSION_ID-} in ses_*[!A-Za-z0-9_]*|ses_|'') note=dir-$sum ;; ses_*) note=$OPENCODE_SESSION_ID ;; *) note=dir-$sum ;; esac`,
    `  N=${sh(places.sshFor)}`,
    // (Waiting for the box only when this command noted it: an agent that's gone stays gone.)
    `  tries=1`,
    `  [ "$(cat "$N/$note" 2>/dev/null)" = "$work" ] || { (umask 077; mkdir -p "$N" && printf '%s' "$work" >"$N/.$note.$$" && mv -f "$N/.$note.$$" "$N/$note") && tries=40; }`,
    `  p=$( (printf '%s' "$note" | sha256sum || printf '%s' "$note" | shasum -a 256) 2>/dev/null | cut -c 1-16)`,
    `  case $p in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) tries=0 ;; esac`,
    `  i=0`,
    `  while [ $i -lt $tries ]; do`,
    `    for s in ${sh(places.sshAgents)}/"$p"*.sock; do [ -S "$s" ] && ssh=$s; done`,
    `    [ -n "$ssh" ] && break`,
    `    i=$((i + 1)); [ $i -lt $tries ] && sleep 0.05`,
    `  done`,
    `  [ -n "$ssh" ] && export SSH_AUTH_SOCK="$ssh"`,
    `fi`,
    ...run,
    "",
  ].filter(line => line !== "").join("\n") + "\n";
}

/** `run/fence/shell/<zsh|bash>`: the shell Claude Code runs its commands with while the sandbox is on
 * (`CLAUDE_CODE_SHELL`), the launcher with the real one. Named as the shell it stands for: Claude
 * Code takes a shell only by its name. Its process names the conversation's folder and repository.
 * With no shell, `run/fence/shell/run`: the launcher as the agents' bridge runs a whole agent in the
 * sandbox (Grok, Cursor, Antigravity), naming the program. */
export function agentShellScript(places: FencePlaces, shell?: string): string {
  return [
    "#!/bin/sh",
    "# Kuvo Code writes this each time its box starts: changes here don't last.",
    `${shell ? `KUVO_FENCE_SHELL=${sh(shell)} ` : ""}exec ${sh(places.launcher)} "$@"`,
    "",
  ].join("\n");
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

/** What the engine tells its agents while their commands run in the sandbox here (`run/fence/agents.md`,
 * among the instructions each box starts its engine with): what they can't do, and how builds and
 * tools that would fail in it run. */
export function agentsNote(platform: "darwin" | "linux"): string {
  const mac = platform === "darwin";
  return [
    "# Commands run in a sandbox here",
    "",
    "Each command you run with the shell tool runs in Kuvo Code's sandbox. It writes only in this conversation's folder, its git repository, temporary folders (`$TMPDIR`, `/tmp`) and tools' caches, and it can't read Kuvo Code's own folders or the user's secrets (private SSH keys, cloud and package tokens)." +
      (mac ? " Nor can it change git's hooks or config, or the settings opencode and the coding agents start with in a project (`.opencode/`, `opencode.json`, `.claude/settings.json`, `.mcp.json`, `.codex/config.toml`, `.cursor/hooks.json` and the like, and their hooks' scripts), nor make, move or remove the folders that hold them (`.git`, `.claude`, `.codex`, `.cursor` and the like): writing in them is fine. If a task needs one changed, ask the user." : ""),
    ...(mac
      ? [
          "",
          "On this Mac:",
          "- `swift build`, `swift test` and `swift run` need `--disable-sandbox`: SwiftPM's own sandbox can't start inside this one.",
          "- `xcodebuild` on a project with Swift packages needs `-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES`. It can't open a Swift package that has no Xcode project: use `swift build --disable-sandbox` or `swift test --disable-sandbox` there.",
          "- `ps` and `top` are refused: use `pgrep -fl` or `lsof`.",
          "- Commands can't open apps (`open`) or start launchd jobs.",
        ]
      : []),
    "",
    "`ssh` and git over SSH use only the keys the user lets this conversation use from Kuvo Code's vault, through `$SSH_AUTH_SOCK`. With none, use HTTPS or ask the user.",
    "",
    "When the sandbox refuses something a task needs (\"Operation not permitted\" or \"Permission denied\" outside these folders), don't work around it: ask the user with sandbox_ask, giving the command as you ran it and why the task needs it. They can let it run outside the sandbox once (and let your commands write in the folder it was stopped writing in from now on), or say no; allowed, it runs for you and you get its output.",
    "",
  ].join("\n");
}
