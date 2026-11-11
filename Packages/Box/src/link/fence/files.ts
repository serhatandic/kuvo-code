// What the box writes for the sandbox, with its own folders in them: the engine's plugin, which
// sends each command through the launcher; and the launcher, which runs the command's shell in
// the sandbox (`sandbox-exec` on macOS, the Landlock script through the engine's Bun on Linux).
//
// The plugin is set up once for each folder the engine works in, and takes that folder from the
// engine (`ctx.location.directory`): never from the command, whose own folder (the shell tool's
// `workdir`) the agent picks. The engine reads its plugins folder as it runs, so a plugin written
// now is used from the next command on, with no restart.

import { MOST_FOLDERS } from "./allowed";
import { HIDE } from "./landlock";
import { AGENT_FOLDERS } from "./seatbelt";

/** Where the box keeps the sandbox's own files (profiles, the plugin's note, commands' temporary
 * folder), what it hides, and where commands' own folders inside Kuvo Code's are. */
export interface FencePlaces {
  /** `run/fence` */
  folder: string;
  /** `bin/kuvo-fence`, and the Linux script beside it. */
  launcher: string;
  runner: string;
  /** Folders of Kuvo Code's own whose folders are each a conversation's own (bots'): in one, a
   * command gets that folder back, and not its neighbours. */
  inside: string[];
  /** Folders of Kuvo Code's own that conversations work in themselves (the chats', which every chat
   * shares): in one, or a folder in it, a command gets that folder back. */
  shared: string[];
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
  /** npm's, pnpm's, uv's and corepack's caches for commands (`sandboxCaches`). */
  caches: { npm: string; pnpm: string; uv: string; corepack: string };
  platform: "darwin" | "linux";
}

const sh = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Its conversation's wake-ups and watches (kuvo-wake): its bot's folder, or its own in the box's
 * wakes folder, which this makes with the folder it works in (`$work`; never the command's: a
 * watch's check runs there). The engine names the conversation; your ! commands have none, and
 * name no folder (one that isn't there). */
const wakeLines = (places: FencePlaces) => [
  `own=$F/none w_bot=`,
  `case \${OPENCODE_SESSION_ID-} in`,
  `  ses_*[!A-Za-z0-9_]*|ses_) ;;`,
  `  ses_*)`,
  `    w_own=`,
  `    for b in ${sh(places.bots)}/*/; do [ "$(cat "\${b}session" 2>/dev/null)" = "$OPENCODE_SESSION_ID" ] && w_own=\${b%/} && w_bot=1 && break; done`,
  `    if [ -z "$w_own" ]; then`,
  `      w_own=${sh(places.wakes)}/$OPENCODE_SESSION_ID`,
  `      [ -f "$w_own/session" ] || { (umask 077; mkdir -p "$w_own") && printf '%s' "$OPENCODE_SESSION_ID" >"$w_own/session" && printf '%s' "$work" >"$w_own/directory"; }`,
  `    fi`,
  `    (umask 077; mkdir -p "$w_own/wakes" "$w_own/watches" "$w_own/inbox") 2>/dev/null && touch "$w_own" && w_own=$(cd "$w_own" && pwd -P) && own=$w_own && export KUVO_WAKE_FOLDER="$own" ;;`,
  `esac`,
];

/** `bin/kuvo-fence`: the shell the engine runs each command with (`kuvo-fence -c <command>`). */
export function launcherScript(places: FencePlaces): string {
  const insideCases = [...places.inside.map(folder => `${sh(folder)}/?*`), ...places.shared.flatMap(folder => [sh(folder), `${sh(folder)}/?*`]), sh(places.probe)].join("|");
  const run = places.platform === "darwin"
    ? [
        // Its refusals, in macOS's log, name its conversation and the command, by a sum of it (a
        // sandbox_ask's card shows what stopped that command: fence/outside.ts).
        `for c_last; do :; done`,
        `c_sum=$( (printf '%s' "\${c_last-}" | shasum -a 256) 2>/dev/null | cut -c 1-16)`,
        `case \${OPENCODE_SESSION_ID-} in ses_*[!A-Za-z0-9_]*|ses_|'') tag="kuvo-sandbox" ;; *) tag="kuvo-sandbox $OPENCODE_SESSION_ID $c_sum" ;; esac`,
        `[ "$as_bun" != 1 ] || export BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`,
        `PATH=$user_path exec /usr/bin/sandbox-exec -D TAG="$tag" -D WORK="$work" -D GIT="$git" -D TMP="$tmp" -D WAKES="$own" -D MEMORY="$memory" -D MEMORY_RE="$memory_re" -D SSH="$ssh" -D WORK_RE="$(escaped "$work")" -D GIT_RE="$(escaped "$git")" ${Array.from({ length: MOST_FOLDERS }, (_, at) => `-D ALLOW${at}="$a${at}" -D ALLOW${at}_RE="$r${at}"`).join(" ")} ${Array.from({ length: AGENT_FOLDERS }, (_, at) => `-D OWN${at}="$o${at}" -D OWN${at}_RE="$q${at}" -D READ${at}="$k${at}"`).join(" ")} -D STATE="$(names "$state_list")" -D KEPT="$(names "$kept_list")" -D PORT="$port" -f "$F/$profile$agent.sb" "$shell" "$@"`,
      ]
    : [
        // Kuvo Code's own commands (kuvo-wake's watches) run it with no engine: the box names the
        // engine's runtime in the sandbox's folder. It starts in the command's folder, which the
        // agent writes: Bun's settings (`bunfig.toml`, its preloads) and a `.env` from nowhere.
        `[ -n "$runtime" ] || runtime=$(cat "$F/runtime" 2>/dev/null)`,
        `[ -x "$runtime" ] || { echo "This command can't run in the sandbox here: the engine's runtime wasn't given." >&2; exit 126; }`,
        // In a namespace of its own, where your session's services aren't (fence/landlock.ts, HIDE):
        // the box names the `unshare` that gives it one, or `-` where it runs without, as it was set up.
        `ns=$(cat "$F/namespace" 2>/dev/null)`,
        `set -- "$runtime" --config=/dev/null --no-env-file ${sh(places.runner)} "$F/policy.json" "$work" "$git" "$tmp" "$own" "$allowed" "$shell" "$@"`,
        `case $ns in /*) set -- "$ns" -Urm /bin/sh -c ${sh(HIDE)} "$ns" "$(id -u)" "$(id -g)" "$(id -un 2>/dev/null)" "$F/ns" "$F/sockets" "$t_own" "$t_name" "$@" ;; -) ;; *) echo "This command can't run in the sandbox here: it isn't set up." >&2; exit 126 ;; esac`,
        `PATH=$user_path KUVO_FENCE_OWN="$own_list" KUVO_FENCE_READ="$read_list" KUVO_FENCE_MEMORY="$memory" KUVO_FENCE_BUN="$as_bun" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec "$@"`,
      ];
  return [
    "#!/bin/sh",
    "# Kuvo Code writes this each time its box starts: changes here don't last.",
    "# The engine runs each command an agent (or you, with !) runs through this: the command's own",
    "# shell, in the sandbox (outside it for a conversation in Full Access). Its plugin",
    "# (kuvo-sandbox.js) names the conversation's folder.",
    `F=${sh(places.folder)}`,
    // Until the command runs, only the system's programs: never one a command put on your PATH
    // (in a folder it writes), run here outside the sandbox.
    `user_path=\${PATH-/usr/bin:/bin}; PATH=/usr/sbin:/usr/bin:/sbin:/bin`,
    `shell=\${KUVO_FENCE_SHELL:-/bin/sh} work=\${KUVO_FENCE_WORK-} work_at=\${KUVO_FENCE_WORK_AT-} git=\${KUVO_FENCE_GIT-} runtime=\${KUVO_FENCE_RUNTIME-}`,
    // A coding agent run whole in it (the agents' bridge names them): its homes and the folders it
    // only reads, one a line; in its homes, the folders of its state and what it never writes, by
    // name (`*` for any letters), one a line; and its Kuvo Code tools' port.
    // And whether its program is the engine's runtime, run as Bun (Cursor's SDK, in a process of its own).
    `own_list=\${KUVO_FENCE_OWN-} read_list=\${KUVO_FENCE_READ-} state_list=\${KUVO_FENCE_STATE-} kept_list=\${KUVO_FENCE_KEPT-} port=\${KUVO_FENCE_PORT:-0} as_bun=\${KUVO_FENCE_BUN-}`,
    "unset KUVO_FENCE_SHELL KUVO_FENCE_WORK KUVO_FENCE_WORK_AT KUVO_FENCE_GIT KUVO_FENCE_RUNTIME KUVO_FENCE_OWN KUVO_FENCE_READ KUVO_FENCE_STATE KUVO_FENCE_KEPT KUVO_FENCE_PORT KUVO_FENCE_BUN",
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
    // A conversation in Full Access (the box marks it in the sandbox's folder, which no command
    // writes): its commands, and a coding agent's own program in it, run as yours, outside the
    // sandbox, with your SSH agent. Still with its wake-ups' folder.
    `full=`,
    `case \${OPENCODE_SESSION_ID-} in ses_*[!A-Za-z0-9_]*|ses_|'') ;; ses_*) [ -f "$F/full/$OPENCODE_SESSION_ID" ] && full=1 ;; esac`,
    "unset KUVO_WAKE_FOLDER",
    `if [ -n "$full" ]; then`,
    `  work=$(cd "\${work:-.}" 2>/dev/null && pwd -P) || work=$(pwd -P)`,
    ...wakeLines(places).map(line => `  ${line}`),
    `  [ "$as_bun" != 1 ] || export BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`,
    `  PATH=$user_path exec "$shell" "$@"`,
    `fi`,
    "unset SSH_AUTH_SOCK",
    `case $work in /*) ;; *) echo "This command can't run in the sandbox here: its conversation's folder wasn't given." >&2; exit 126 ;; esac`,
    `work=$(cd "$work" 2>/dev/null && pwd -P) || { echo "This command can't run: its conversation's folder isn't there." >&2; exit 126; }`,
    // Where the folder really was as the engine opened it (its plugin names it): a folder traded
    // since for a link to somewhere else (by another conversation's command, in a folder it writes)
    // isn't worked in there.
    `case $work_at in ''|"$work") ;; *) echo "This command can't run: its conversation's folder now leads somewhere else than when it was opened (it was replaced by a link). Ask the user." >&2; exit 126 ;; esac`,
    `case $git in /*) git=$(cd "$git" 2>/dev/null && pwd -P) || git=$work ;; *) git=$work ;; esac`,
    // Only by a repository's own name (`.git`, `….git`): a command can make what looks like a
    // repository in any folder it writes, then a worktree that names it.
    `case $git in *.git) ;; *) git=$work ;; esac`,
    "profile=project",
    `case $work in ${insideCases}) profile=inside ;; esac`,
    // Temporary files of its own: each conversation's folder has its own (by a sum no folder's
    // name can be picked to share).
    `sum=$( (printf '%s' "$work" | sha256sum || printf '%s' "$work" | shasum -a 256) 2>/dev/null | cut -c 1-32)`,
    `case $sum in ????????????????????????????????) ;; *) echo "This command can't run in the sandbox here: it can't name its temporary folder." >&2; exit 126 ;; esac`,
    `tmp=$F/tmp/$sum`,
    // By a short name, in the folder the box names (`temporary`: on this Mac the app's own
    // temporary folder, elsewhere `t` in Kuvo Code's folder; and a key commands can't read): a
    // socket's path is at most 103 letters on macOS and 107 on Linux, and tmux's server, a server's
    // tests or Python's multiprocessing make theirs in it. (Named from the key, so a command still
    // can't pick a folder whose name another conversation's has.) On Linux each command's namespace
    // sees only its own conversation's in `t` (`t_own`, fence/landlock.ts's HIDE).
    "t_own= t_name=",
    `if [ -f "$F/temporary" ]; then`,
    `  { IFS= read -r t_root; IFS= read -r t_key; } <"$F/temporary"`,
    `  t_name=$( (printf '%s\n%s' "$t_key" "$work" | sha256sum || printf '%s\n%s' "$t_key" "$work" | shasum -a 256) 2>/dev/null | cut -c 1-8)`,
    `  case $t_root:$t_key:$t_name in /*:????????????????????????????????????????????????????????????????:????????) tmp=$t_root/$t_name; t_own=$t_root ;; *) echo "This command can't run in the sandbox here: it can't name its temporary folder." >&2; exit 126 ;; esac`,
    `fi`,
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
    // (Never a link a command put in its place, which would lead into Kuvo Code's folders: one from
    // before the sandbox kept it from that goes.)
    `if [ -L "$tmp" ]; then rm -f "$tmp" || exit 126; fi`,
    `(umask 077; mkdir -p "$tmp") && touch "$tmp" && export TMPDIR="$tmp/"`,
    // pre-commit's hooks set their tools up in its own folder as they first run, which runs later
    // outside the sandbox, so commands only read it: theirs go in their temporary folder instead.
    `export PRE_COMMIT_HOME="$TMPDIR"pre-commit`,
    // npm's, pnpm's, uv's and corepack's, likewise: npx, `pnpm dlx` and uvx fetch a package there
    // and run it from it, and corepack the pnpm and yarn it runs, so their caches are Kuvo Code's own
    // for commands, never used outside the sandbox (yours run outside it, so commands only read
    // them); and uv's tools folder, which uvx writes in as it runs one. (pnpm 11 and later read
    // `pnpm_config_cache_dir`; pnpm 10 only an `npm_config_` one, which npm warns of in every
    // command, so it's left out: pnpm 10's `pnpm dlx` is refused, as it would write in yours. And
    // pnpm 11's global virtual store is off: with it, `pnpm dlx` runs a package from its store's
    // copies, in your store, which your own pnpm runs from later. In a project you set to use it,
    // `pnpm install` in the sandbox stops then, changing nothing, as it won't change the project's
    // store without asking in a terminal.)
    `(umask 077; mkdir -p ${[places.caches.npm, places.caches.pnpm, `${places.caches.uv}/cache`, `${places.caches.uv}/tools`, places.caches.corepack].map(sh).join(" ")})`,
    `export npm_config_cache=${sh(places.caches.npm)} pnpm_config_cache_dir=${sh(places.caches.pnpm)} pnpm_config_enable_global_virtual_store=false UV_CACHE_DIR=${sh(`${places.caches.uv}/cache`)} UV_TOOL_DIR=${sh(`${places.caches.uv}/tools`)} COREPACK_HOME=${sh(places.caches.corepack)}`,
    // On Linux uv links what it installs to its cache's files, which every conversation's commands
    // write: a project's environment it makes copies them instead. (macOS clones them, apart.)
    ...(places.platform === "linux" ? ["export UV_LINK_MODE=copy"] : []),
    // (As the sandbox compares paths: through links, `/var` being `/private/var`.)
    ...(places.platform === "darwin" ? [`tmp=$(cd "$tmp" 2>/dev/null && pwd -P) || { echo "This command can't run: its temporary folder isn't there." >&2; exit 126; }`] : []),
    // tmux's server, in it too: one a command starts is there for the conversation's next ones, and
    // never the one your terminals attach to (yours, which types into them, commands can't reach).
    // Not the one Kuvo Code was started in either, which tmux would take for it.
    `export TMUX_TMPDIR="$tmp"`,
    "unset TMUX TMUX_PANE",
    ...wakeLines(places),
    // Its bot's memory (`MEMORY.md` in its folder), which it's told to keep: the bot whose
    // conversation this is; for its seat in a group chat, the bot the agents bridge names
    // (`KUVO_FENCE_BOT`, as its box marked the seat), or, run by the engine, the bot whose own
    // folder (never a link) it works in. That file alone, read and written in place, as it is (no
    // other name for another file), and on macOS the new files beside it (`MEMORY.md.tmp.…`) that
    // Claude Code saves it through (seatbelt.ts): never another bot's, nor anything else of its folder.
    `memory= m_bot=\${KUVO_FENCE_BOT-}`,
    "unset KUVO_FENCE_BOT",
    `if [ -n "$w_bot" ] && [ "$own" != "$F/none" ]; then memory=$own/MEMORY.md`,
    `else`,
    `  case $m_bot in bot_*[!A-Za-z0-9]*|bot_) ;; bot_*) memory=$(cd ${sh(places.bots)}/"$m_bot" 2>/dev/null && pwd -P)/MEMORY.md ;; esac`,
    `  [ -n "$memory" ] || for b in ${sh(places.bots)}/*/; do [ ! -L "\${b}workspace" ] && [ "$(cd "\${b}workspace" 2>/dev/null && pwd -P)" = "$work" ] && memory=$(cd "$b" && pwd -P)/MEMORY.md && break; done`,
    `fi`,
    `[ -n "$memory" ] && [ -f "$memory" ] && [ ! -L "$memory" ] && [ "$(${places.platform === "darwin" ? "stat -f %l" : "stat -c %h"} "$memory" 2>/dev/null)" = 1 ] || memory=$F/none`,
    // (On macOS, the new files beside it, by its name escaped; with no memory, a name no file has.)
    ...(places.platform === "darwin" ? [`memory_re=-; [ "$memory" = "$F/none" ] || memory_re=$(escaped "$memory")`] : []),
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

/** `run/fence/shell/run`: the launcher as the agents' bridge runs a coding agent whole in the
 * sandbox (Claude Code, Codex, Grok, Cursor, Antigravity), naming the program. */
export function agentShellScript(places: FencePlaces): string {
  return [
    "#!/bin/sh",
    "# Kuvo Code writes this each time its box starts: changes here don't last.",
    `exec ${sh(places.launcher)} "$@"`,
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
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const FOLDER = ${JSON.stringify(places.folder)}
const KEY = ${JSON.stringify(places.key)}
const LAUNCHER = ${JSON.stringify(places.launcher)}
const VERSION = ${JSON.stringify(version)}
const MOVES = path.join(FOLDER, "moves.json")
// Written whole, then put in place, so no engine reads half of it.
function noteMoves(moves) {
  const made = MOVES + "." + process.pid
  try { fs.writeFileSync(made, JSON.stringify(Object.fromEntries(Object.entries(moves).slice(-200)))); fs.renameSync(made, MOVES) } catch { try { fs.rmSync(made, { force: true }) } catch {} }
}

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

// Where a path really is, as the system follows it, a name at a time: through its links (a ..
// after one goes up from where it leads), also to a place that isn't there yet (which writing it
// would make). A loop of links ends it where it's written.
function located(where) {
  let at = "/"
  let rest = path.resolve(where).split("/").filter(Boolean)
  for (let links = 0; rest.length; ) {
    const name = rest.shift()
    if (name === ".") continue
    if (name === "..") { at = path.dirname(at); continue }
    const next = path.join(at, name)
    let link
    try { link = fs.lstatSync(next).isSymbolicLink() ? fs.readlinkSync(next) : undefined } catch { return path.join(next, ...rest) }
    if (link === undefined) { at = next; continue }
    if (++links > 40) return where
    if (link.startsWith("/")) at = "/"
    rest = [...link.split("/").filter(Boolean), ...rest]
  }
  return at
}
// Where a folder really is as the launcher finds it (the shell's pwd -P, which keeps the letters
// it's given: their case, and how an accent is written), or "" if it isn't there.
function opened(folder) {
  try { return execFileSync("/bin/sh", ["-c", 'cd "$1" && pwd -P', "sh", folder], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\\n$/, "") } catch { return "" }
}
const within = (where, folder) => !!folder && (where === folder || where.startsWith(folder + path.sep))
// A path as the engine takes it: ~ is your home folder, anything else from the folder given.
const resolved = (from, given) => path.resolve(from, given === "~" ? os.homedir() : given.startsWith("~/") ? path.join(os.homedir(), given.slice(2)) : given)
// The folder the engine counts as the conversation's project too, as it finds it: the first folder
// up from where it really is with a .git (a repository it can read) or a .hg.
function topOf(folder) {
  for (let at = real(folder); at && at !== path.dirname(at); at = path.dirname(at)) {
    try { fs.lstatSync(path.join(at, ".hg")); return at } catch {}
    try { fs.lstatSync(path.join(at, ".git")) } catch { continue }
    return repository(real(folder)) ? at : ""
  }
  return ""
}
// What the read tool reads instead of a file that isn't there: the one file beside it whose name is
// the same but for how it's written (composed accents, no-break spaces, curly quotes).
function lookalike(where) {
  const same = (name) => name.normalize("NFC").replace(/[\u00a0\u202f]/g, " ").replace(/[\u2018\u2019]/g, "'")
  const name = same(path.basename(where))
  try {
    const found = fs.readdirSync(path.dirname(where)).filter(each => same(each) === name && fs.statSync(path.join(path.dirname(where), each)).isFile())
    return found.length === 1 ? path.join(path.dirname(where), found[0]) : ""
  } catch { return "" }
}

// The engine's own file tools run outside the sandbox, and tell a place outside the conversation's
// folder by the path as it's written: through a link a command made in the folder (to your keys, or
// a start-up script), they'd go there as if it were the folder's. So a path in the folder that a
// link leads out of it is given as where it really is, which the engine's rules for a folder
// outside the project then apply to (Settings › Permissions, a bot's own).
// (And the image tool's, which writes the picture it makes where its \`path\` says.)
const PATHS = { read: "path", write: "path", edit: "path", glob: "path", grep: "path", image: "path" }
// A patch's lines that name a file, as the engine reads them: each line (without a last \\r) with
// the spaces around it trimmed.
const PATCHED = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "]

// What a command prints when the sandbox stopped it (and not when SSH's server turned it away); on
// Linux also a secret hidden from commands, said not to be there. (The box tells which it was.)
const STOPPED = process.platform === "linux"
  ? /operation not permitted|permission denied|read-only file system|no such file or directory|\\bE(PERM|ACCES|ROFS|NOENT)\\b/i
  : /operation not permitted|permission denied|read-only file system|\\bE(PERM|ACCES)\\b/i
const NOT_THE_SANDBOX = /permission denied \\((publickey|password|keyboard-interactive)[^)]*\\)|permission denied, please try again/gi
// The box's long-running process, which takes what the sandbox stopped (kuvo/sandbox/stopped): one
// request on its socket, after a hello with the box's sockets' key. Its answer, or null for none.
function askBox(route, body) {
  return new Promise((resolve) => {
    let key
    try { key = fs.readFileSync(KEY, "utf8").trim() } catch { return resolve(null) }
    const socket = net.createConnection(path.join(path.dirname(KEY), "vault.sock"))
    let heard = "", hello = false
    const done = (value) => { socket.destroy(); resolve(value) }
    // (A command allowed outside runs for ten minutes at most.)
    const late = setTimeout(() => done(null), 16 * 60_000)
    const greeted = setTimeout(() => { if (!hello) done(null) }, 10_000)
    socket.on("connect", () => socket.write(JSON.stringify({ hello: crypto.randomBytes(18).toString("base64url"), key }) + "\\n"))
    socket.on("error", () => done(null))
    socket.on("close", () => { clearTimeout(late); clearTimeout(greeted); done(null) })
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      heard += chunk
      for (let end; (end = heard.indexOf("\\n")) >= 0; heard = heard.slice(end + 1)) {
        if (!hello) {
          hello = true
          socket.write(JSON.stringify({ method: "POST", path: route, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)).toString("base64") }) + "\\n")
          continue
        }
        clearTimeout(late)
        try {
          const answer = JSON.parse(heard.slice(0, end))
          return done(answer.status === 200 ? JSON.parse(Buffer.from(answer.body, "base64").toString("utf8")) : null)
        } catch { return done(null) }
      }
    })
  })
}

export default {
  id: "kuvo-code.sandbox",
  setup: async (ctx) => {
    const work = ctx.location?.directory ?? ""
    // A folder this engine moved a conversation to: where it really was when the move was checked,
    // and its repository and project then (taken once, as the engine opens it). Where the folder is
    // a link now, it's never where the link leads.
    let moved
    try {
      const moves = JSON.parse(fs.readFileSync(MOVES, "utf8"))
      if (typeof moves[work]?.at === "string") { moved = moves[work]; delete moves[work]; noteMoves(moves) }
    } catch {}
    const git = moved ? moved.git || "" : work ? repository(work) : ""
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
    const folder = moved ? moved.at : work ? real(work) : ""
    // (And as it's named: the letters a move's keeps, their case, an accent's form. Both taken as
    // the engine opens it, never where a link put in its place since leads.)
    const asNamed = moved ? moved.at : work ? located(work) : ""
    const openedAt = moved ? moved.at : work ? opened(work) : ""
    await ctx.shell.hook("create.before", (input) => {
      input.env.KUVO_FENCE_SHELL = input.shell
      input.env.KUVO_FENCE_WORK = work
      input.env.KUVO_FENCE_WORK_AT = openedAt
      input.env.KUVO_FENCE_GIT = git
      input.env.KUVO_FENCE_RUNTIME = process.execPath
      input.shell = LAUNCHER
    })
    const top = moved ? moved.top || "" : work ? topOf(work) : ""
    const ours = [work, folder, top].filter(Boolean)
    const really = (given, tool) => {
      if (typeof given !== "string" || !given || !work) return given
      const written = resolved(work, given)
      if (!ours.some(each => within(written, each))) return given
      let where = located(written)
      // A file that isn't there, which read takes a look-alike's place for.
      if (tool === "read" && ours.some(each => within(where, each))) {
        try { fs.statSync(written) } catch { where = located(lookalike(written) || written) }
      }
      return ours.some(each => within(where, each)) ? given : where
    }
    await ctx.tool?.hook("execute.before", (call) => {
      const input = call.input
      if (!input || typeof input !== "object") return
      const field = PATHS[call.tool]
      if (field) {
        const given = really(input[field], call.tool)
        if (given !== input[field]) call.input = { ...input, [field]: given }
      } else if ((call.tool === "patch" || call.tool === "apply_patch") && typeof input.patchText === "string") {
        const patchText = input.patchText.split("\\n").map((line) => {
          const read = (line.endsWith("\\r") ? line.slice(0, -1) : line).trim()
          const head = PATCHED.find(each => read.startsWith(each))
          if (!head) return line
          const given = read.slice(head.length).trim()
          const where = really(given)
          if (where === given) return line
          // (Never a place whose name would make lines of its own.)
          if (/[\\r\\n\\u2028\\u2029]/.test(where)) throw new Error("This patch names a file through a link out of the conversation's folder to a place this can't name. Ask the user.")
          return head + where
        }).join("\\n")
        if (patchText !== input.patchText) call.input = { ...input, patchText }
      } else if (call.tool === "session_move" || call.tool === "opencode_session_move") {
        // Its commands run in its folder's sandbox, so a conversation moved to another folder (your
        // home folder) would write there: only itself, within its folder, or to its repository's
        // worktree.
        const other = input.sessionID !== undefined && input.sessionID !== call.sessionID
        const named = !other && typeof input.directory === "string" ? resolved(work, input.directory.trim()) : ""
        // Where it is, and where its commands will take it to be (pwd -P): both within.
        const to = named ? located(named) : ""
        const at = to ? opened(named) || to : ""
        const inside = (where) => within(where, folder) || within(where, asNamed) || !!(git && repository(where) === git)
        if (!to || !inside(to) || !inside(at)) {
          throw new Error("This conversation's commands run in Kuvo Code's sandbox, in its own folder, so it can't move itself to another one. Ask the user to move it.")
        }
        // The engine moves it later, by the folder's name: noted where it was as it was checked, so
        // its commands don't run where a link put in its place meanwhile leads.
        let moves = {}
        try { moves = JSON.parse(fs.readFileSync(MOVES, "utf8")) } catch {}
        delete moves[named]
        moves[named] = { at, git: repository(at), top: topOf(at) }
        noteMoves(moves)
      }
    })
    // A command the sandbox stopped, told to the box as the agent's call ends: in Auto, its reviewer
    // decides whether it runs outside the sandbox, and the agent gets what that printed, or why not.
    // (Elsewhere the box leaves it as it is: the agent can ask you with sandbox_ask.)
    await ctx.tool?.hook("execute.after", async (call) => {
      if ((call.tool !== "shell" && call.tool !== "bash") || call.status !== "completed" || !call.result) return
      const exit = call.result.metadata?.exit
      if (typeof exit !== "number" || exit === 0) return
      // (What it printed is its result's output, which the agent reads as its content's first text,
      // and then "Exited with code N".)
      const output = call.result.output
      const parts = Array.isArray(call.result.content) ? call.result.content : []
      const printed = typeof output?.output === "string" ? output.output : parts.filter(part => part?.type === "text").map(part => part.text).join("\\n")
      if (!STOPPED.test(printed.replace(NOT_THE_SANDBOX, ""))) return
      const answer = await askBox("kuvo/sandbox/stopped", { session: call.sessionID, input: call.input, output: printed.slice(-4000) })
      if (typeof answer?.text !== "string") return
      // Not let out: why not, after what it printed, and it ended as it did.
      if (typeof answer.exit !== "number") return void (call.result.content = [...parts, { type: "text", text: answer.text }])
      call.result.content = [...parts.filter(part => part?.type !== "text"), { type: "text", text: answer.text }, ...(answer.exit ? [{ type: "text", text: "Exited with code " + answer.exit }] : [])]
      if (output && typeof output === "object") call.result.output = { ...output, output: answer.text, exit: answer.exit, truncated: false }
      call.result.metadata = { ...call.result.metadata, exit: answer.exit, truncated: false }
    })
  },
}
`;
}

/** What the engine tells its agents while their commands run in the sandbox here (`run/fence/agents.md`,
 * among the instructions each box starts its engine with): what they can't do, and how builds and
 * tools that would fail in it run. `tmuxFits`: whether tmux's socket fits in commands' temporary
 * folders here, which a home folder's long path can keep from it. */
export function agentsNote(platform: "darwin" | "linux", tmuxFits = true): string {
  const mac = platform === "darwin";
  return [
    "# Commands run in a sandbox here",
    "",
    "Each command you run with the shell tool runs in Kuvo Code's sandbox:",
    "",
    "- It can't read Kuvo Code's own folders or the user's secrets (private SSH keys, cloud and package tokens).",
    "- It writes and deletes freely in this conversation's folder, its git repository, temporary folders (`$TMPDIR`, `/tmp`) and tools' caches.",
    "- Elsewhere in the home folder it adds and changes files, but never deletes or moves them." + (mac ? "" : " Nor can it make or remove anything right in a folder that holds what's kept (the home folder itself, `~/.config`, `~/.local`): only inside the folders there."),
    "- It never writes what runs later outside the sandbox: shell start-up files, the folders on PATH, git's, SSH's, editors' and the coding agents' settings" + (mac ? ", or `~/Library` apart from its caches, logs and `Developer`" : "") + ".",
    "- The user's personal folders (Documents, Desktop, Downloads and the like) " + (mac ? "only take new files: save a new copy beside one rather than changing it." : "are only read."),
    "- A conversation the user started in one of those folders (a project in Documents, `~/.config/nvim`) writes its own folder freely. A session you start can't be in what runs later" + (mac ? ", `~/Library`" : "") + " or a personal folder itself: ask the user to start it there.",
    "- A tool that moves a new copy over a file (`sed -i`, some installers) can't change one outside the folders it writes freely: make the copy in the project or `$TMPDIR`, then `cp` it over.",
    "- Docker's socket, SSH's shared connections and terminals' and editors' servers aren't reachable.",
    ...(mac ? ["- It can't change git's hooks or config, or the settings opencode and the coding agents start with (`.opencode/`, `opencode.json`, `.claude/settings.json`, `.mcp.json`, `.codex/config.toml`, `.cursor/hooks.json` and the like, and their hooks' scripts), in any project, nor make, move or remove the folders that hold them (`.git`, `.claude`, `.codex`, `.cursor` and the like); writing other files in them is fine. If a task needs one changed, ask the user."] : []),
    ...(mac
      ? [
          "",
          "On this Mac:",
          "- `swift build`, `swift test` and `swift run` need `--disable-sandbox`: SwiftPM's own sandbox can't start inside this one.",
          "- `xcodebuild` on a project with Swift packages needs `-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES`. It can't open a Swift package that has no Xcode project: use `swift build --disable-sandbox` or `swift test --disable-sandbox` there.",
          "- `ps` is refused (it would show other programs' environments): use `pgrep -fl`, `lsof` or `top -l 1`.",
          "- Commands can't open apps (`open`) or start launchd jobs.",
        ]
      : []),
    "",
    "`npm`, `pnpm`, `uv` and corepack use caches of Kuvo Code's own here (`$npm_config_cache`, `$pnpm_config_cache_dir`, `$UV_CACHE_DIR`, `$COREPACK_HOME`): leave them as they are. `npx -y <package>`, `pnpm dlx` and `uvx` fetch what they need (`uvx` with a Python that's installed).",
    "",
    ...(tmuxFits
      ? []
      : ["This computer's home folder's path is too long for tmux in the sandbox: its socket in `$TMPDIR` would pass the system's limit, so tmux fails with \"File name too long\", as can other programs that make a socket there. Don't start tmux with sandbox_ask instead: outside the sandbox it would be the user's own. For another program that needs a socket, ask with sandbox_ask, or tell the user why it can't run in the sandbox here.", ""]),
    "`ssh` and git over SSH use only the keys the user lets this conversation use from Kuvo Code's vault, through `$SSH_AUTH_SOCK`. With none, use HTTPS or ask the user.",
    "",
    "When the sandbox refuses something a task needs (\"Operation not permitted\" or \"Permission denied\"), don't work around it: ask the user with sandbox_ask.",
    "",
  ].join("\n");
}
