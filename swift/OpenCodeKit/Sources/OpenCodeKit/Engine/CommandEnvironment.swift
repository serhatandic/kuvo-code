import Foundation

/// The commands the agent runs (its shell tool, and yours with `!`) get your own folders back.
/// The engine keeps its settings, data and caches in folders of its own, through `XDG_…`,
/// `npm_config_cache` and `BUN_INSTALL` ([EngineFolders], and `~/.kuvo-code` on a machine), and
/// the commands it runs would get them too: then `gh` said you weren't signed in, and other tools
/// that keep their sign-ins and settings in `~/.config` or `~/.local/share` (git's own, mise,
/// 1Password's `op`) didn't find them. So the engine starts with what each of those was as
/// `KUVO_OWN_<name>` (empty when it wasn't set), and a plugin of Kuvo Code's, in the engine's
/// `plugins` folder, puts them back for each command, as in your own terminal. What the engine
/// runs itself (MCP servers, `kuvo-npx`) keeps its folders.
public enum CommandEnvironment {
    /// What the engine has in folders of its own, given back to commands. (Not `TMPDIR`: their
    /// temporary files go in the engine's temporary folder, which is cleared.)
    public static let names = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "npm_config_cache", "BUN_INSTALL"]

    /// Where each one's own value goes in the engine's environment.
    public static let prefix = "KUVO_OWN_"

    /// What commands don't get at all: the settings Kuvo Code gives the engine, with the key to
    /// the browser tools in them, which the agent's `env` would print; and the tmux Kuvo Code was
    /// started in, where a command's own tmux would open its windows.
    public static let withheld = ["OPENCODE_CONFIG_CONTENT", "TMUX", "TMUX_PANE"]

    /// The plugin's file, in the engine's `plugins` folder beside its settings file, where it
    /// finds plugins by itself.
    public static let file = "plugins/kuvo-code.js"

    /// What's put in the engine's environment for `base`, the one it starts from.
    public static func variables(from base: [String: String]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: names.map { (prefix + $0, base[$0] ?? "") })
    }

    /// The plugin: for each command, sets each name to its own value, or takes it away when it
    /// had none, and takes the `KUVO_OWN_…` and what's withheld away.
    public static let plugin = """
        // Kuvo Code writes this each time its engine starts: changes here don't last.
        // The commands the agent runs get your own folders back (XDG_CONFIG_HOME and the like),
        // so tools find their sign-ins and settings, as in your own terminal, and not the
        // settings Kuvo Code gives the engine, with its keys.
        const prefix = "\(prefix)"
        const withheld = \(withheld)
        export default {
          id: "kuvo-code.commands",
          setup: async (ctx) => {
            await ctx.shell.hook("create.before", (input) => {
              for (const name of withheld) delete input.env[name]
              for (const key of Object.keys(input.env)) {
                if (!key.startsWith(prefix)) continue
                const name = key.slice(prefix.length)
                const own = input.env[key]
                delete input.env[key]
                if (!name) continue
                if (own) input.env[name] = own
                else delete input.env[name]
              }
            })
          },
        }

        """

    /// Writes the plugin into `folder`, the engine's settings folder (`config/opencode`).
    public static func install(in folder: URL) throws {
        let target = folder.appending(path: file)
        let data = Data(plugin.utf8)
        if (try? Data(contentsOf: target)) == data { return }
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: target, options: .atomic)
    }

    #if os(macOS)
    /// On a machine (needs `$K`), before its folders are pointed into `$K`: each one's own value,
    /// unless an outer script has kept them already. One line.
    static var keepScript: String {
        let keep = names.map { "\(prefix)\($0)=\"${\($0)-}\"" }.joined(separator: " ")
        return "[ -n \"${\(prefix)\(names[1])+set}\" ] || export \(keep)"
    }

    /// Puts the plugin in the engine's settings folder on a machine (needs `$K`).
    static var installScript: String {
        """
        mkdir -p "$K/config/opencode/plugins"
        cat >"$K/config/opencode/\(file).new" <<'KUVO_PLUGIN'
        \(plugin)KUVO_PLUGIN
        cmp -s "$K/config/opencode/\(file).new" "$K/config/opencode/\(file)" && rm -f "$K/config/opencode/\(file).new" || mv -f "$K/config/opencode/\(file).new" "$K/config/opencode/\(file)"
        """
    }
    #endif
}
