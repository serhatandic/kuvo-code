import Foundation
import OpenCodeKit

/// Well-known MCP servers, each from the company behind it as listed in the official MCP
/// Registry (registry.modelcontextprotocol.io), to add in one click. Servers that need an
/// account sign in through the engine when they're first used.
nonisolated enum MCPCatalog {
    struct Server: Identifiable, Sendable {
        /// Its name in the engine's settings, which its tools are named after.
        var id: String
        var title: String
        var summary: String
        var access: Access
        /// The engine's settings for it.
        var settings: JSONValue
    }

    enum Access: Sendable {
        case signIn, open, local

        var title: String {
            switch self {
            case .signIn: "Needs an account"
            case .open: "No account needed"
            case .local: "Runs on this Mac"
            }
        }
    }

    private static func remote(_ url: String) -> JSONValue {
        .object(["type": .string("remote"), "url": .string(url)])
    }

    /// Run through `kuvo-npx`, pinned, with `environment`.
    private static func local(_ command: [String], environment: [String: String] = [:]) -> JSONValue {
        var settings: [String: JSONValue] = ["type": .string("local"), "command": .array(([Launcher.name] + command).map(JSONValue.string))]
        if !environment.isEmpty { settings["environment"] = .object(environment.mapValues(JSONValue.string)) }
        return .object(settings)
    }

    /// Chrome DevTools' server, and how it's run: with a profile of its own for each copy, in the
    /// temporary folder and gone when it closes (not one in your home folder, which a second
    /// project's copy couldn't open), and nothing sent to Google about its use.
    private static let chromeDevTools = ["chrome-devtools-mcp@1.12.0", "--isolated", "--no-usage-statistics"]
    /// Its package got apart from the project (its .npmrc, .env), run in it (where a screenshot it
    /// saves goes); no update checks or usage statistics, which it keeps in your home folder.
    private static let chromeDevToolsEnvironment = [
        Integrations.apart: "fetch",
        "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1",
        "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1",
    ]

    /// Adds `server` to the engine's settings, as Settings › MCP Servers' Add does (and a phone):
    /// its tools as they are, not through Code Mode, unless its settings say otherwise.
    @MainActor static func add(_ server: Server, to config: EngineConfig) {
        var settings = server.settings
        if case .object(var object) = settings, object["codemode"] == nil {
            object["codemode"] = .bool(false)
            settings = .object(object)
        }
        config.set(settings, at: MCPSettings.path + [server.id])
        Analytics.shared.track("mcp_server_added", ["catalog": server.id])
    }

    /// Servers that use this Mac's own apps (its Chrome), left out of machines' settings.
    static let macOnly = ["chrome-devtools"]

    /// Chrome DevTools as an older version added it (through npx, unpinned, an older version), as
    /// it's offered now: a newer version you chose stays, and so do your options (--no-isolated
    /// keeps a profile of its own) and anything else set on it.
    @MainActor static func upgrade(_ config: EngineConfig) {
        guard case .object(var server)? = config.value(at: MCPSettings.path + ["chrome-devtools"]),
              case .array(let old)? = server["command"] else { return }
        let words = old.compactMap(\.string)
        guard let at = words.firstIndex(where: { $0 == "chrome-devtools-mcp" || $0.hasPrefix("chrome-devtools-mcp@") }) else { return }
        let version = words[at].split(separator: "@", maxSplits: 1).dropFirst().first.map(String.init)
        let package = isOlder(version, than: chromeDevTools[0]) ? chromeDevTools[0] : words[at]
        var options = Array(words[(at + 1)...])
        for (flag, opposite) in [("--no-usage-statistics", "--usage-statistics"), ("--isolated", "--no-isolated")]
        where !options.contains(where: { $0 == flag || $0 == opposite || $0.hasPrefix(opposite + "=") }) {
            options.insert(flag, at: 0)
        }
        let command = [Launcher.name, package] + options
        var environment = server["environment"]?.object ?? [:]
        for (name, value) in chromeDevToolsEnvironment where environment[name] == nil || name == Integrations.apart {
            environment[name] = .string(value)
        }
        guard command != words || environment != (server["environment"]?.object ?? [:]) else { return }
        server["command"] = .array(command.map(JSONValue.string))
        server["environment"] = .object(environment)
        config.set(.object(server), at: MCPSettings.path + ["chrome-devtools"], noted: false)
    }

    /// Whether `version` ("1.10.2"; nil or "latest", as unpinned) is before `pinned`'s.
    private static func isOlder(_ version: String?, than pinned: String) -> Bool {
        guard let version, version != "latest", let wanted = pinned.split(separator: "@").last else { return true }
        func numbers(_ text: Substring) -> [Int] { text.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 } }
        let mine = numbers(Substring(version)), theirs = numbers(wanted)
        for index in 0..<max(mine.count, theirs.count) {
            let a = index < mine.count ? mine[index] : 0, b = index < theirs.count ? theirs[index] : 0
            if a != b { return a < b }
        }
        return false
    }

    static let servers: [Server] = [
        Server(id: "linear", title: "Linear", summary: "Issues, projects and cycles", access: .signIn, settings: remote("https://mcp.linear.app/mcp")),
        Server(id: "sentry", title: "Sentry", summary: "Errors and performance problems in your apps", access: .signIn, settings: remote("https://mcp.sentry.dev/mcp")),
        Server(id: "notion", title: "Notion", summary: "Pages and databases in your workspace", access: .signIn, settings: remote("https://mcp.notion.com/mcp")),
        Server(id: "atlassian", title: "Atlassian", summary: "Jira issues and Confluence pages", access: .signIn, settings: remote("https://mcp.atlassian.com/v2/mcp")),
        Server(id: "stripe", title: "Stripe", summary: "Payments, customers and Stripe's docs", access: .signIn, settings: remote("https://mcp.stripe.com")),
        Server(id: "supabase", title: "Supabase", summary: "Databases, auth and storage in your projects", access: .signIn, settings: remote("https://mcp.supabase.com/mcp")),
        Server(id: "neon", title: "Neon", summary: "Postgres databases and branches", access: .signIn, settings: remote("https://mcp.neon.tech/mcp")),
        Server(id: "context7", title: "Context7", summary: "Current docs and examples for libraries", access: .open, settings: remote("https://mcp.context7.com/mcp")),
        Server(id: "cloudflare-docs", title: "Cloudflare Docs", summary: "Cloudflare's documentation", access: .open, settings: remote("https://docs.mcp.cloudflare.com/mcp")),
        Server(id: "huggingface", title: "Hugging Face", summary: "Models, datasets, Spaces and papers", access: .open, settings: remote("https://huggingface.co/mcp")),
        Server(id: "chrome-devtools", title: "Chrome DevTools", summary: "Inspect and debug pages in Google Chrome", access: .local, settings: local(chromeDevTools, environment: chromeDevToolsEnvironment)),
    ]
}
