import Foundation
import OpenCodeKit

/// Services the agent can work with: your mail and calendar, chats, socials, code and work tools.
/// Each one the best way it can: its maker's own MCP server where there is one (you sign in once);
/// else a well-kept open-source server with a key you bring, kept in your Keychain; else the site
/// itself, in the panel's browser, signed in as you. Added, an integration is an MCP server in the
/// engine's settings named by its ID, for every session and bot, on this Mac and its machines.
nonisolated enum Integrations {
    struct Service: Identifiable, Sendable {
        let id: String
        let title: String
        /// What the agent can do with it.
        let summary: String
        let kind: Kind
        let symbol: String
        /// Its site, for the browser, and where to sign in there.
        let site: String
        let way: Way
    }

    enum Kind: String, CaseIterable, Sendable {
        case mail = "Mail and Calendar"
        case chat = "Chat"
        case social = "Social"
        case work = "Code and Work"
    }

    enum Way: Sendable {
        /// Its maker's MCP server at `url`, where you sign in with your account the first time.
        case official(url: String)
        /// Its maker's server, with a token you bring, sent as `Authorization: Bearer`.
        case officialToken(url: String, key: Key, help: String)
        /// Its maker's server, which takes sign-ins only through an app registered with it: you
        /// bring your app's client ID and secret, then sign in.
        case officialApp(url: String, help: String)
        /// An open-source MCP server (an npm package, pinned to a version), run with `kuvo-npx`,
        /// with the keys you bring and settings of its own; `macOnly` for one that uses this Mac's
        /// apps.
        case package(command: [String], keys: [Key], help: String?, by: String, environment: [String: String] = [:], macOnly: Bool = false)
        /// No server worth trusting: the agent uses the site in the panel's browser, signed in as you.
        case browser
    }

    struct Key: Sendable {
        /// The environment variable the server reads (or, for an app, CLIENT_ID and CLIENT_SECRET).
        let name: String
        let label: String
        let prompt: String
    }

    /// Where the engine's own sign-in comes back for a server that signs in through your app.
    static let redirect = "http://127.0.0.1:19876/mcp/oauth/callback"

    /// The keys a service takes, if any.
    static func keys(of way: Way) -> [Key] {
        switch way {
        case .officialToken(_, let key, _): [key]
        case .officialApp: [Key(name: "CLIENT_ID", label: "Client ID", prompt: "From your app"), Key(name: "CLIENT_SECRET", label: "Client secret", prompt: "From your app")]
        case .package(_, let keys, _, _, _, _): keys
        case .official, .browser: []
        }
    }

    /// Its settings in the engine's file. Keys go in as `{file:…}`, the files the engine reads them
    /// from (their values never go in the settings file, see IntegrationKeys). Its tools are plain tools, as the browser's are: behind the
    /// engine's Code Mode, the agent sees only a short list of them under one tool, and went to
    /// the service's site in the browser instead.
    /// With `bot`, the settings that bot's folder has, naming its own keys rather than the shared ones.
    /// On a machine (`machine`), its keys are named where that machine keeps them.
    static func settings(for service: Service, bot: String? = nil, on machine: String? = nil) -> JSONValue? {
        let variable = { (name: String) in bot.map { IntegrationKeys.variable(service.id, name, bot: $0) } ?? IntegrationKeys.variable(service.id, name) }
        guard case .object(var settings) = server(for: service, variable: variable, machine: machine) else { return nil }
        settings["codemode"] = .bool(false)
        return .object(settings)
    }

    /// Brings added integrations up to date before the engine starts: tools made plain tools (for
    /// those added before they were), a package's server started as it's pinned now (so a new
    /// version or option reaches integrations added with an older one), and keys read from their
    /// files where an earlier version named them in the environment. A machine's (`machine`) as
    /// it keeps its keys.
    @MainActor static func upgrade(_ config: EngineConfig, on machine: String? = nil) {
        guard case .object(let servers) = config.value(at: MCPSettings.path) else { return }
        for (id, original) in servers {
            guard let service = service(id), case .object(var server) = original else { continue }
            // One whose maker now runs its own server (Figma's): that server, signed in to, in
            // place of the package, whose key goes.
            if case .official = service.way, case .array(let old)? = server["command"], old.first?.string == Launcher.name,
               let settings = settings(for: service) {
                let keys = Self.keyNames(in: original)
                if let machine {
                    Task { for variable in keys { try? await MachineBox.setKey(variable, nil, on: SSHConnection(destination: machine)) } }
                } else {
                    for variable in keys { IntegrationKeys.set(nil, for: variable) }
                }
                config.set(settings, at: MCPSettings.path + [id], noted: false)
                continue
            }
            if server["codemode"] == nil { server["codemode"] = .bool(false) }
            // The same package through kuvo-npx, pinned or started differently: as it is now.
            if case .package(let command, _, _, _, _, _) = service.way, let package = command.first,
               case .array(let old)? = server["command"], old.first?.string == Launcher.name,
               let oldPackage = old.dropFirst().first?.string, Self.packageName(oldPackage) == Self.packageName(package) {
                server["command"] = .array(([Launcher.name] + command).map(JSONValue.string))
                // Run apart from the project, as one added now is.
                if case .object(var environment) = server["environment"] ?? .object([:]), environment[Self.apart] == nil {
                    environment[Self.apart] = .string("1")
                    server["environment"] = .object(environment)
                }
            }
            let updated = Self.keyFiles(in: .object(server), on: machine)
            if updated != original { config.set(updated, at: MCPSettings.path + [id], noted: false) }
        }
    }

    /// Settings with each key named by the file the computer's engine reads it from (this Mac's,
    /// or `machine`'s): one an earlier version named in the environment (`{env:KUVO_KEY_…}`), or
    /// in another folder.
    nonisolated static func keyFiles(in value: JSONValue, on machine: String? = nil) -> JSONValue {
        switch value {
        case .string(let text):
            guard text.contains("KUVO_KEY_"), let regex = try? NSRegularExpression(pattern: #"\{(?:env|file):[^{}]*?(KUVO_KEY_[A-Z0-9_]+)\}"#) else { return value }
            let original = text as NSString
            let result = NSMutableString(string: text)
            for match in regex.matches(in: text, range: NSRange(location: 0, length: original.length)).reversed() {
                result.replaceCharacters(in: match.range, with: IntegrationKeys.reference(original.substring(with: match.range(at: 1)), on: machine))
            }
            return .string(result as String)
        case .object(let object): return .object(object.mapValues { keyFiles(in: $0, on: machine) })
        case .array(let array): return .array(array.map { keyFiles(in: $0, on: machine) })
        default: return value
        }
    }

    /// The keys a server's settings name (`KUVO_KEY_…`).
    nonisolated static func keyNames(in value: JSONValue) -> [String] {
        switch value {
        case .string(let text):
            guard let regex = try? NSRegularExpression(pattern: "KUVO_KEY_[A-Z0-9_]+") else { return [] }
            return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { (text as NSString).substring(with: $0.range) }
        case .object(let object): return object.values.flatMap(keyNames)
        case .array(let array): return array.flatMap(keyNames)
        default: return []
        }
    }

    /// Settings for a machine, where the engine reads the keys from files of their own in its
    /// folder (see `RemoteServer.launchScript`): each named there.
    nonisolated static func keyVariables(in value: Any) -> Any {
        switch value {
        case let text as String:
            return text.replacingOccurrences(of: "{file:" + IntegrationKeys.folder.path + "/", with: "{file:~/\(RemoteEngineInstaller.root)/keys/")
        case let object as [String: Any]: return object.mapValues(keyVariables)
        case let array as [Any]: return array.map(keyVariables)
        default: return value
        }
    }

    /// "@scope/name" of "@scope/name@1.2.3", "name" of "name@1.2.3".
    static func packageName(_ spec: String) -> String {
        guard let at = spec.dropFirst().lastIndex(of: "@") else { return spec }
        return String(spec[..<at])
    }

    /// `variable` names a key's variable (the shared key's, or a bot's own).
    private static func server(for service: Service, variable: @escaping (String) -> String, machine: String?) -> JSONValue? {
        let env = { (name: String) in JSONValue.string(IntegrationKeys.reference(variable(name), on: machine)) }
        switch service.way {
        case .official(let url):
            return .object(["type": .string("remote"), "url": .string(url)])
        case .officialToken(let url, let key, _):
            return .object([
                "type": .string("remote"), "url": .string(url), "oauth": .bool(false),
                "headers": .object(["Authorization": .string("Bearer " + IntegrationKeys.reference(variable(key.name), on: machine))]),
            ])
        case .officialApp(let url, _):
            return .object([
                "type": .string("remote"), "url": .string(url),
                "oauth": .object(["clientId": env("CLIENT_ID"), "clientSecret": env("CLIENT_SECRET")]),
            ])
        case .package(let command, let keys, _, _, let fixed, _):
            var environment = fixed.mapValues(JSONValue.string)
            for key in keys { environment[key.name] = env(key.name) }
            // Apart from the project it's used in (see `Launcher`).
            environment[Self.apart] = .string("1")
            return .object([
                "type": .string("local"),
                "command": .array(([Launcher.name] + command).map(JSONValue.string)),
                "environment": .object(environment),
            ])
        case .browser:
            return nil
        }
    }

    /// Integrations that only work on this Mac, which machines don't offer: those that use its apps.
    static var macOnly: [String] {
        all.compactMap { service in
            if case .package(_, _, _, _, _, true) = service.way { return service.id }
            return nil
        }
    }

    static func service(_ id: String) -> Service? { all.first { $0.id == id } }

    /// How an added integration is doing on a computer, worst last, as Settings › Integrations
    /// says it: its server's status, then whether it waits for you.
    enum Health: String, Comparable, Sendable {
        case connected, starting, waitsForCode, needsSignIn, failed

        private static let order: [Health] = [.connected, .starting, .waitsForCode, .needsSignIn, .failed]
        static func < (a: Health, b: Health) -> Bool { order.firstIndex(of: a)! < order.firstIndex(of: b)! }
    }

    /// `server`, its server as the engine lists it; `signedIn`, the integrations the engine keeps
    /// a sign-in for; `waitsForCode`, Outlook's sign-in not made yet (`waitsForCode(_:)`).
    static func health(_ service: Service, server: MCPServer?, signedIn: Set<String>, waitsForCode: Bool) -> Health {
        var health: Health = switch server?.status.status {
        case "connected": .connected
        case "needs_auth": .needsSignIn
        case "failed": .failed
        default: .starting
        }
        // A server can answer without a sign-in (Google's do), then turn every call down.
        if health == .connected, let integration = server?.integrationID, !signedIn.contains(integration) {
            switch service.way {
            case .official, .officialApp: health = .needsSignIn
            default: break
            }
        }
        if health == .connected, waitsForCode { health = .waitsForCode }
        return health
    }

    /// Microsoft 365, without its sign-in yet, on this Mac (a machine's isn't looked at): its
    /// server signs in by itself, with a code, when the agent first uses it.
    static func waitsForCode(_ service: Service) -> Bool {
        guard let files = signInFiles[service.id], let first = files.first else { return false }
        return !FileManager.default.fileExists(atPath: AppInfo.supportDirectory.appending(path: "integrations/\(service.id)/\(first)").path)
    }

    // MARK: Their sites

    /// An added integration's site, which the agent reaches through the integration's tools
    /// rather than the browser: what the browser says when the agent opens it anyway.
    struct Site: Codable, Sendable {
        let id: String
        /// Hosts it's on, each with the ones under it.
        let hosts: [String]
        /// Only addresses under this path, where the site's host has more than the service.
        let path: String?
        let note: String
    }

    /// Other hosts a service's pages are on.
    private static let moreHosts: [String: [String]] = [
        "notion": ["notion.com"],
        "atlassian": ["atlassian.net"],
        "microsoft-365": ["outlook.office.com", "outlook.office365.com"],
    ]

    /// The cookie a site keeps while you're signed in to it, for those the agent uses on their
    /// site, by service: how Settings tells whether a browser is signed in there. (The others
    /// keep their sign-in where it can't be read from outside the page.)
    static let signInCookies: [String: (domain: String, name: String)] = [
        "x": ("x.com", "auth_token"),
        "linkedin": ("linkedin.com", "li_at"),
        "reddit": ("reddit.com", "reddit_session"),
    ]

    /// Whether `cookies` (domain, name, expiry) have `service`'s sign-in; nil when that can't be told.
    static func isSignedIn(_ service: String, cookies: [(domain: String, name: String, expires: Date?)]) -> Bool? {
        guard let wanted = signInCookies[service] else { return nil }
        return cookies.contains { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            return (domain == wanted.domain || domain.hasSuffix("." + wanted.domain)) && cookie.name == wanted.name && (cookie.expires ?? .distantFuture) > .now
        }
    }

    /// How to sign in to a service whose server signs in some way of its own, for the agent to
    /// say (otherwise, under Settings › Integrations).
    static let signInHow: [String: String] = [
        "microsoft-365": "use its login tool, which gives the user a code to enter on Microsoft's page",
    ]

    /// The integrations added in the engine's settings, by ID.
    @MainActor static func added(in config: EngineConfig) -> [String] {
        added(inSettings: config.settings)
    }

    /// Those added in `settings` (a box's, say).
    static func added(inSettings settings: [String: JSONValue]) -> [String] {
        (settings["mcp"]?["servers"]?.object ?? [:]).keys.filter { service($0) != nil }.sorted()
    }

    /// The sites of the integrations `ids`, those with tools of their own.
    static func sites(_ ids: some Sequence<String>) -> [Site] {
        ids.compactMap(service).compactMap { service in
            if case .browser = service.way { return nil }
            guard let url = URL(string: service.site), var host = url.host() else { return nil }
            for prefix in ["www.", "app."] where host.hasPrefix(prefix) { host.removeFirst(prefix.count) }
            let path = url.path().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let signIn = signInHow[service.id] ?? "tell the user to sign in to \(service.title) under Settings › Integrations"
            let note = "\(service.title) is connected to Kuvo Code as an integration, so use its tools (their names start with \(service.id)_) rather than its website: they reach the user's account directly. If you don't see them, or they say they need signing in, \(signIn) (if it was just added, it may still be starting: try again in a moment). Only if the user asked for the website itself, call this again with the same address."
            return Site(id: service.id, hosts: [host] + (moreHosts[service.id] ?? []), path: path.isEmpty ? nil : "/" + path, note: note)
        }
    }

    /// The site of an added integration that `address` (what the agent asked the browser to
    /// open) is on, if any.
    static func site(of address: String, in sites: [Site]) -> Site? {
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: trimmed.contains("://") ? trimmed : "https://" + trimmed),
              ["http", "https"].contains(url.scheme ?? ""), !trimmed.contains(" "), let host = url.host()?.lowercased() else { return nil }
        return sites.first { site in
            site.hosts.contains { host == $0 || host.hasSuffix("." + $0) } && site.path.map { url.path().hasPrefix($0) } != false
        }
    }

    /// What tells `kuvo-npx` to run an integration's server apart from the project.
    static let apart = "KUVO_NPX_APART"

    /// Integrations whose servers keep their sign-in in files of their own, in their folder (see
    /// `AppModel.syncSignInFiles`), by the files' names, the sign-in itself first. They go together:
    /// Outlook's is encrypted with the key in `.cache-key`, which each side makes for itself.
    static let signInFiles: [String: [String]] = [
        "microsoft-365": ["token-cache.json", "selected-account.json", ".cache-key"],
    ]

    // Checked 2026-10-16: the official servers with their makers' docs; the open-source ones on
    // npm, pinned. Keep them current with the other upstreams.
    static let all: [Service] = [
        // Mail and calendar
        Service(id: "apple-calendar", title: "Apple Calendar and Reminders", summary: "Events and reminders in your Mac's Calendar and Reminders, with every account you have there", kind: .mail, symbol: "calendar", site: "https://www.icloud.com/calendar",
                way: .package(command: ["mcp-server-apple-events@1.6.1"], keys: [], help: nil, by: "FradSer's mcp-server-apple-events", macOnly: true)),
        Service(id: "microsoft-365", title: "Outlook and Microsoft 365", summary: "Mail, calendar, contacts and files; you sign in with a code the first time", kind: .mail, symbol: "envelope", site: "https://outlook.live.com",
                // --discovery: its own way of keeping its 196 tools (about 280k tokens) out of every
                // request; the agent searches them and runs the one it needs.
                way: .package(command: ["@softeria/ms-365-mcp-server@0.170.2", "--discovery"], keys: [], help: nil, by: "Softeria's ms-365-mcp-server", environment: [
                    // Its sign-in, chosen account and logs in a folder of its own, not the home folder or the keychain.
                    "MS365_MCP_TOKEN_CACHE_PATH": "{env:KUVO_INTEGRATIONS}/microsoft-365/token-cache.json",
                    "MS365_MCP_SELECTED_ACCOUNT_PATH": "{env:KUVO_INTEGRATIONS}/microsoft-365/selected-account.json",
                    "MS365_MCP_LOG_DIR": "{env:KUVO_INTEGRATIONS}/microsoft-365/logs",
                    "MS365_MCP_USE_KEYTAR": "0",
                ])),
        Service(id: "fastmail", title: "Fastmail", summary: "Mail, contacts and calendars", kind: .mail, symbol: "envelope.badge", site: "https://app.fastmail.com",
                way: .official(url: "https://api.fastmail.com/mcp")),
        Service(id: "caldav", title: "Other Calendars", summary: "iCloud, Nextcloud and other CalDAV calendars", kind: .mail, symbol: "calendar.badge.clock", site: "https://www.icloud.com/calendar",
                way: .package(command: ["caldav-mcp@0.10.0"], keys: [
                    Key(name: "CALDAV_BASE_URL", label: "Server", prompt: "https://caldav.icloud.com"),
                    Key(name: "CALDAV_USERNAME", label: "Username", prompt: "you@icloud.com"),
                    Key(name: "CALDAV_PASSWORD", label: "Password", prompt: "An app-specific password"),
                ], help: "https://support.apple.com/en-us/102654", by: "dominik1001's caldav-mcp")),
        Service(id: "gmail", title: "Gmail", summary: "Google's own server, in preview: with an app in your Google Cloud project", kind: .mail, symbol: "envelope.open", site: "https://mail.google.com",
                way: .officialApp(url: "https://gmailmcp.googleapis.com/mcp/v1", help: "https://developers.google.com/workspace/guides/configure-mcp-servers")),
        Service(id: "google-calendar", title: "Google Calendar", summary: "Google's own server, in preview: with an app in your Google Cloud project", kind: .mail, symbol: "calendar.circle", site: "https://calendar.google.com",
                way: .officialApp(url: "https://calendarmcp.googleapis.com/mcp/v1", help: "https://developers.google.com/workspace/guides/configure-mcp-servers")),
        // Chat
        Service(id: "slack", title: "Slack", summary: "Channels, messages and search, through an app you add to your workspace", kind: .chat, symbol: "number", site: "https://app.slack.com",
                way: .officialApp(url: "https://mcp.slack.com/mcp", help: "https://docs.slack.dev/ai/mcp-server/")),
        Service(id: "discord", title: "Discord", summary: "Your servers and messages", kind: .chat, symbol: "bubble.left.and.bubble.right", site: "https://discord.com/app", way: .browser),
        Service(id: "telegram", title: "Telegram", summary: "Your chats", kind: .chat, symbol: "paperplane", site: "https://web.telegram.org", way: .browser),
        Service(id: "whatsapp", title: "WhatsApp", summary: "Your chats", kind: .chat, symbol: "phone.bubble", site: "https://web.whatsapp.com", way: .browser),
        // Social
        Service(id: "x", title: "X", summary: "Posts, replies and messages", kind: .social, symbol: "at", site: "https://x.com", way: .browser),
        Service(id: "linkedin", title: "LinkedIn", summary: "Your feed, posts and messages", kind: .social, symbol: "person.2", site: "https://www.linkedin.com", way: .browser),
        Service(id: "reddit", title: "Reddit", summary: "Posts and comments", kind: .social, symbol: "text.bubble", site: "https://www.reddit.com", way: .browser),
        Service(id: "bluesky", title: "Bluesky", summary: "Posts and replies", kind: .social, symbol: "cloud", site: "https://bsky.app", way: .browser),
        Service(id: "mastodon", title: "Mastodon", summary: "Posts and replies", kind: .social, symbol: "megaphone", site: "https://mastodon.social", way: .browser),
        // Code and work
        Service(id: "github", title: "GitHub", summary: "Repositories, issues, pull requests and Actions", kind: .work, symbol: "chevron.left.forwardslash.chevron.right", site: "https://github.com",
                way: .officialToken(url: "https://api.githubcopilot.com/mcp/", key: Key(name: "TOKEN", label: "Personal access token", prompt: "github_pat_…"), help: "https://github.com/settings/personal-access-tokens/new")),
        Service(id: "gitlab", title: "GitLab", summary: "Projects, issues and merge requests", kind: .work, symbol: "arrow.triangle.branch", site: "https://gitlab.com",
                way: .official(url: "https://gitlab.com/api/v4/mcp")),
        Service(id: "linear", title: "Linear", summary: "Issues, projects and cycles", kind: .work, symbol: "checklist", site: "https://linear.app",
                way: .official(url: "https://mcp.linear.app/mcp")),
        Service(id: "notion", title: "Notion", summary: "Pages and databases", kind: .work, symbol: "doc.text", site: "https://www.notion.so",
                way: .official(url: "https://mcp.notion.com/mcp")),
        Service(id: "atlassian", title: "Jira and Confluence", summary: "Issues and pages at Atlassian", kind: .work, symbol: "square.stack.3d.up", site: "https://www.atlassian.com",
                way: .official(url: "https://mcp.atlassian.com/v2/mcp")),
        Service(id: "todoist", title: "Todoist", summary: "Tasks and projects", kind: .work, symbol: "checkmark.circle", site: "https://app.todoist.com",
                way: .package(command: ["@doist/todoist-mcp@13.6.1"], keys: [Key(name: "TODOIST_API_KEY", label: "API token", prompt: "From Settings › Integrations › Developer")], help: "https://app.todoist.com/app/settings/integrations/developer", by: "Doist's own todoist-mcp")),
        Service(id: "calendly", title: "Calendly", summary: "Your event types, bookings and availability", kind: .work, symbol: "calendar.badge.plus", site: "https://calendly.com/app",
                way: .official(url: "https://mcp.calendly.com")),
        Service(id: "figma", title: "Figma", summary: "Files and frames, to build designs from", kind: .work, symbol: "paintbrush", site: "https://www.figma.com",
                way: .official(url: "https://mcp.figma.com/mcp")),
        Service(id: "asana", title: "Asana", summary: "Tasks and projects, through an app you register", kind: .work, symbol: "circle.grid.3x3", site: "https://app.asana.com",
                way: .officialApp(url: "https://mcp.asana.com/v2/mcp", help: "https://developers.asana.com/docs/using-asanas-mcp-server")),
        Service(id: "zoom", title: "Zoom", summary: "Meetings, recordings and chat, through an app you register", kind: .work, symbol: "video", site: "https://zoom.us/meeting",
                way: .officialApp(url: "https://mcp.zoom.us/mcp/zoom/streamable", help: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/")),
    ]
}
