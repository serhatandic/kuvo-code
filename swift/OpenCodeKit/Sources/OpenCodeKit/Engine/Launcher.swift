import Foundation

/// `kuvo-npx`, in the `bin` folder beside `kuvo-wake`: runs an npm package's command for an MCP
/// server (an integration's), with Node when the computer has it, else the engine's own Bun
/// (`bun x`), so such a server needs nothing installed. With Node, each version is installed once
/// in the engine's cache (`kuvo-npx/<package>@<version>`, its other versions removed) and its
/// command run by Node itself: `npx` would stay running beside every server, about as big as it
/// (npx is what's left when that can't be done). What's downloaded stays in the engine's cache
/// (`npm_config_cache`, `BUN_INSTALL`). The server gets its own keys under their own names (its
/// settings say which); every integration's `KUVO_KEY_…` is taken away first. With Bun, a `node`
/// beside it (in `runtime`) runs the engine's Bun too: a package's command starts with `node`, and
/// without one Bun makes its own in `/tmp`, whatever `TMPDIR` says.
public enum Launcher {
    public static let name = "kuvo-npx"
    /// The folder beside it with `node`.
    public static let runtime = "runtime"

    /// The script, running the engine at `engine` for Bun (a path, or a shell word like
    /// "$K/engine/2.2.6/opencode").
    public static func script(engine: String) -> String {
        """
        #!/bin/sh
        # Kuvo Code: runs an npm package's command for an MCP server.
        for v in $(env | sed 's/=.*//' | grep '^KUVO_KEY_'); do unset "$v" 2>/dev/null; done
        # Nor the engine's password or settings, which it has no use for.
        unset OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD OPENCODE_CONFIG_CONTENT 2>/dev/null
        # An integration's server runs apart from the project (KUVO_NPX_APART): its .env, .npmrc
        # and bunfig.toml aren't its. With "fetch", only getting the package is: Node runs the server
        # in the project, where a file it's asked to save goes (npx and Bun, which get and run it at
        # once, stay apart).
        here=
        if [ -n "$KUVO_NPX_APART" ]; then
          [ "$KUVO_NPX_APART" = fetch ] && here=$PWD
          apart="${XDG_CACHE_HOME:-${TMPDIR:-/tmp}}/kuvo-npx"
          mkdir -p "$apart" 2>/dev/null && cd "$apart" 2>/dev/null
          unset KUVO_NPX_APART
        fi
        if [ -n "$XDG_CACHE_HOME" ] && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
          spec=$1; shift
          case ${spec#?} in *@*) name=${spec%@*} ;; *) name=$spec ;; esac
          folder="$XDG_CACHE_HOME/kuvo-npx/$(printf '%s' "$spec" | tr '/' '+')"
          if [ ! -s "$folder/.main" ]; then
            mkdir -p "$XDG_CACHE_HOME/kuvo-npx"
            # One install at a time, by the start that holds the lock (its process in it): another
            # waits for it, however long it takes, and takes over one whose start is gone (it
            # crashed), one at a time and only once it's sure. One that stops waiting without the
            # lock leaves the other's install alone, and npx runs it.
            waits=$KUVO_NPX_WAITS
            case $waits in '' | *[!0-9]*) waits=600 ;; esac
            i=0; locked=
            while :; do
              if mkdir "$folder.lock" 2>/dev/null; then
                echo $$ >"$folder.lock/pid"; locked=1; break
              fi
              [ -s "$folder/.main" ] && break
              # Its start is gone: its process doesn't run, or it named none (an older kuvo-npx's,
              # or one that crashed as it took it) minutes ago. A taking over that crashed half way
              # is let go of after a minute.
              holder=$(cat "$folder.lock/pid" 2>/dev/null); gone=
              if [ -n "$holder" ]; then
                kill -0 "$holder" 2>/dev/null || gone=1
              elif [ -n "$(find "$folder.lock" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
                gone=1
              fi
              # (Renamed away first, so one start alone lets it go.)
              if [ -n "$(find "$folder.lock.breaking" -maxdepth 0 -mmin +1 2>/dev/null)" ] && mv "$folder.lock.breaking" "$folder.lock.breaking.$$" 2>/dev/null; then
                rm -rf "$folder.lock.breaking.$$"
              fi
              if [ -n "$gone" ] && mkdir "$folder.lock.breaking" 2>/dev/null; then
                echo $$ >"$folder.lock.breaking/pid"
                [ "$(cat "$folder.lock/pid" 2>/dev/null)" = "$holder" ] && rm -rf "$folder.lock"
                # Only its own: one let go of meanwhile as stale, and taken by another, isn't.
                [ "$(cat "$folder.lock.breaking/pid" 2>/dev/null)" = $$ ] && rm -rf "$folder.lock.breaking"
                continue
              fi
              [ $i -ge "$waits" ] && break
              sleep 0.5; i=$((i + 1))
            done
            if [ -n "$locked" ] && [ ! -s "$folder/.main" ]; then
              rm -rf "$folder"
              # Its output to stderr: stdout is the server's, to the engine.
              npm install --prefix "$folder" --no-save --no-package-lock --no-audit --no-fund --loglevel=error "$spec" >&2 &&
                node -e 'const [dir, short] = process.argv.slice(1); const bin = JSON.parse(require("fs").readFileSync(dir + "/package.json", "utf8")).bin; const main = typeof bin === "string" ? bin : bin && (bin[short] || Object.values(bin)[0]); if (main) console.log(main)' "$folder/node_modules/$name" "${name##*/}" >"$folder/.main"
              if [ -s "$folder/.main" ] && [ "$name" != "$spec" ]; then
                for other in "${folder%@*}"@*; do
                  case $other in "$folder" | *.lock | *.lock.breaking*) ;; *) rm -rf "$other" ;; esac
                done
              fi
            fi
            # (Only its own: a start that took over from it has its own there.)
            [ -n "$locked" ] && [ "$(cat "$folder.lock/pid" 2>/dev/null)" = $$ ] && rm -rf "$folder.lock"
          fi
          if [ -s "$folder/.main" ]; then
            [ -n "$here" ] && cd "$here" 2>/dev/null
            exec node "$folder/node_modules/$name/$(cat "$folder/.main")" "$@"
          fi
          exec npx -y "$spec" "$@"
        fi
        if command -v npx >/dev/null 2>&1; then exec npx -y "$@"; fi
        PATH="$(dirname "$0")/\(runtime):$PATH" BUN_BE_BUN=1 exec \(engine) x "$@"
        """
    }

    /// `node`, for a package's command: the engine's Bun.
    public static func node(engine: String) -> String {
        """
        #!/bin/sh
        # Kuvo Code: the engine's Bun, by Node's name, for an MCP server's command.
        BUN_BE_BUN=1 exec \(engine) "$@"
        """
    }

    /// Writes it into `folder` (this Mac's `bin`), for the engine at `engine`.
    public static func install(in folder: URL, engine: URL) throws {
        let quoted = "\"\(engine.path)\""
        try write(script(engine: quoted), to: folder.appending(path: name))
        try write(node(engine: quoted), to: folder.appending(path: runtime).appending(path: "node"))
    }

    private static func write(_ text: String, to file: URL) throws {
        let data = Data(text.utf8)
        if (try? Data(contentsOf: file)) == data { return }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
    }

    #if os(macOS)
    /// Puts it in `$K/bin` on a machine (needs `$K`), for its engine.
    static var installScript: String {
        let engine = "\"$HOME/\(RemoteEngineInstaller.root)/engine/\(OpenCodeEngine.version)/opencode\""
        return """
        cat >"$K/bin/\(name).new" <<'KUVO_NPX'
        \(script(engine: engine))
        KUVO_NPX
        chmod 755 "$K/bin/\(name).new" && mv -f "$K/bin/\(name).new" "$K/bin/\(name)"
        mkdir -p "$K/bin/\(runtime)"
        cat >"$K/bin/\(runtime)/node.new" <<'KUVO_NODE'
        \(node(engine: engine))
        KUVO_NODE
        chmod 755 "$K/bin/\(runtime)/node.new" && mv -f "$K/bin/\(runtime)/node.new" "$K/bin/\(runtime)/node"
        """
    }
    #endif
}
