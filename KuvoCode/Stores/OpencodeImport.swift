import CryptoKit
import Foundation
import OpenCodeKit

/// What you set up in opencode itself, brought over to Kuvo Code's engine, which keeps its own
/// settings and accounts apart: opencode's accounts, default model, MCP servers, agents,
/// commands, plugins, permissions, instructions and providers, and its skills. opencode's files
/// are only read, and nothing already set here is replaced. Its API keys come over; a sign-in
/// (OAuth) doesn't, since two apps refreshing one sign-in can sign both out where a provider
/// turns its refresh tokens over (ChatGPT's does): those are named, to sign in to here.
///
/// Its settings file is read by a private engine of Kuvo Code's own, which turns an older
/// opencode's into its own form: it reads a copy, in a folder only you can read in Kuvo Code's
/// temporary folder, and stops, and the folder goes, right after. (Not `opencode debug config`,
/// which goes through, and starts, a background service that stays.) Its accounts (`auth.json`) are turned into the engine's
/// as the engine's own import of them does, and stored through its API, in memory on the way.
enum OpencodeImport {
    /// What there is to bring over, as it would land here.
    struct Plan {
        /// Settings to add, in the engine's form, at the top level of its settings file.
        var settings: [String: JSONValue] = [:]
        /// API keys, by integration, in the engine's form.
        var accounts: [(integration: String, label: String, value: JSONValue)] = []
        /// Integrations opencode is signed in to and this engine isn't: to sign in to here.
        var signIns: [String] = []
        /// opencode's skills folders, for the engine to find skills in too.
        var skillFolders: [String] = []
        /// Why opencode's settings couldn't be read, when they couldn't: its keys and skills come
        /// over anyway.
        var settingsFailure: String?

        var isEmpty: Bool { settings.isEmpty && accounts.isEmpty && skillFolders.isEmpty }

        /// What it brings, in a few words each, for you to look over first; `name` names a provider.
        func lines(name: (String) -> String) -> [String] {
            var lines: [String] = []
            if !accounts.isEmpty { lines.append("API keys: " + accounts.map { name($0.integration) }.joined(separator: ", ")) }
            if let model = settings["model"] { lines.append("Model for new sessions: " + OpencodeImport.modelName(model)) }
            for (key, title) in [("mcp", "MCP servers"), ("agents", "Agents"), ("commands", "Commands"), ("providers", "Providers")] {
                let names = key == "mcp" ? settings["mcp"]?["servers"]?.object?.keys.sorted() : settings[key]?.object?.keys.sorted()
                if let names, !names.isEmpty { lines.append("\(title): " + names.joined(separator: ", ")) }
            }
            if let plugins = settings["plugins"]?.array, !plugins.isEmpty { lines.append("Plugins: " + plugins.compactMap(\.string).joined(separator: ", ")) }
            if let rules = settings["permissions"]?.array, !rules.isEmpty { lines.append(rules.count == 1 ? "1 permission rule" : "\(rules.count) permission rules") }
            if let instructions = settings["instructions"]?.array, !instructions.isEmpty { lines.append("Instructions: " + instructions.compactMap(\.string).map { ($0 as NSString).lastPathComponent }.joined(separator: ", ")) }
            for folder in skillFolders {
                let count = (try? FileManager.default.contentsOfDirectory(atPath: folder).filter { !$0.hasPrefix(".") }.count) ?? 0
                lines.append("Skills in \((folder as NSString).abbreviatingWithTildeInPath)" + (count > 0 ? " (\(count))" : ""))
            }
            return lines
        }
    }

    /// opencode's settings folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
    static var configFolder: URL {
        let base = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"].map { URL(filePath: $0) } ?? URL.homeDirectory.appending(path: ".config")
        return base.appending(path: "opencode")
    }

    /// opencode's data folder, where it keeps its accounts.
    static var dataFolder: URL {
        let base = ProcessInfo.processInfo.environment["XDG_DATA_HOME"].map { URL(filePath: $0) } ?? URL.homeDirectory.appending(path: ".local/share")
        return base.appending(path: "opencode")
    }

    private static let settingsFiles = ["opencode.json", "opencode.jsonc", "config.json"]
    /// Folders of agents and commands written as Markdown, older names and newer.
    private static let markdownFolders = ["agent", "agents", "command", "commands"]
    private static let skillsFolders = ["skill", "skills"]

    /// Whether this Mac has opencode set up, with anything to bring over.
    static var isAvailable: Bool {
        let manager = FileManager.default
        return (settingsFiles.map { configFolder.appending(path: $0) } + [dataFolder.appending(path: "auth.json")]).contains { manager.fileExists(atPath: $0.path) }
            || skillsFolders.contains { manager.fileExists(atPath: configFolder.appending(path: $0).path) }
    }

    // MARK: Reading

    /// What there is to bring over that isn't here yet: settings `config` doesn't have, accounts
    /// for integrations `connected` doesn't, skills folders the engine doesn't look in.
    static func plan(engine: URL, config: [String: JSONValue], connected: Set<String>) async throws -> Plan {
        var plan = Plan()
        do {
            if let read = try await settings(engine: engine) { plan.settings = missing(from: read, in: config) }
        } catch {
            plan.settingsFailure = error.localizedDescription
        }
        let found = accounts().filter { !connected.contains($0.integration) }
        plan.accounts = found.filter { $0.value["type"]?.string == "key" }
        plan.signIns = found.filter { $0.value["type"]?.string == "oauth" }.map(\.integration)
        let looked = Set((config["skills"]?.array ?? []).compactMap(\.string).map { ($0 as NSString).expandingTildeInPath })
        plan.skillFolders = skillsFolders.map { configFolder.appending(path: $0).path }
            .filter { FileManager.default.fileExists(atPath: $0) && !looked.contains($0) }
        return plan
    }

    /// opencode's settings, as Kuvo Code's engine reads them: its settings files and its Markdown
    /// agents and commands, copied into a folder of their own (not its plugins' packages).
    private static func settings(engine: URL) async throws -> [String: JSONValue]? {
        let manager = FileManager.default
        let present = settingsFiles.filter { manager.fileExists(atPath: configFolder.appending(path: $0).path) }
        let folders = markdownFolders.filter { manager.fileExists(atPath: configFolder.appending(path: $0).path) }
        guard !present.isEmpty || !folders.isEmpty else { return nil }
        let root = manager.temporaryDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code").appending(path: "opencode-import-\(UUID().uuidString)")
        let copy = root.appending(path: "config/opencode")
        let engineFolders = EngineFolders(root: root)
        let server: ServerProcess
        do {
            try manager.createDirectory(at: copy, withIntermediateDirectories: true)
            try? manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            // `{env:…}` and `{file:…}` come over as written, not as the engine would fill them in
            // here (from an empty environment, a file's secret pasted in): kept from it, then
            // put back.
            for name in present {
                let text = try String(contentsOf: configFolder.appending(path: name), encoding: .utf8)
                try Data(Self.keep(text).utf8).write(to: copy.appending(path: name))
            }
            for name in folders { try manager.copyItem(at: configFolder.appending(path: name), to: copy.appending(path: name)) }
            let home = root.appending(path: "home")
            try manager.createDirectory(at: home, withIntermediateDirectories: true)
            server = try await ServerProcess.start(executable: engine, folders: engineFolders, environment: ["PATH": "/usr/bin:/bin", "HOME": home.path])
        } catch {
            // The copy holds opencode's settings, keys and all: it doesn't stay behind.
            try? manager.removeItem(at: root)
            throw error
        }
        var sources: JSONValue?
        var failure: Error?
        do { sources = try await OpenCodeAPI(endpoint: server.endpoint).configSources(directory: engineFolders.workspace.path) } catch { failure = error }
        // Its folder goes once it has stopped.
        server.stop()
        Task.detached {
            for _ in 0..<40 where server.isRunning { try? await Task.sleep(for: .milliseconds(250)) }
            try? FileManager.default.removeItem(at: root)
        }
        // Not read (a settings file it can't make sense of): said, rather than nothing to bring.
        if let failure { throw failure }
        guard case .array(let sources)? = sources else { return nil }
        // Each source's settings, later ones over earlier, as the engine layers them.
        var merged: [String: JSONValue] = [:]
        for source in sources {
            guard let info = source["info"]?.object else { continue }
            merged = deepMerged(merged, info)
        }
        return restored(.object(merged)).object ?? [:]
    }

    private static let keptEnv = "{kuvo-kept-env:"
    private static let keptFile = "{kuvo-kept-file:"

    /// opencode's settings with their references in a form the engine leaves alone.
    static func keep(_ text: String) -> String {
        text.replacingOccurrences(of: "{env:", with: keptEnv).replacingOccurrences(of: "{file:", with: keptFile)
    }

    /// The references back as written; a file's relative to opencode's settings folder, where
    /// they were, now named from anywhere.
    static func restored(_ value: JSONValue) -> JSONValue {
        switch value {
        case .string(let text):
            guard text.contains("{kuvo-kept-") else { return value }
            var result = text.replacingOccurrences(of: keptEnv, with: "{env:")
            while let range = result.range(of: keptFile) {
                let after = result[range.upperBound...]
                let relative = !(after.hasPrefix("/") || after.hasPrefix("~"))
                result.replaceSubrange(range, with: "{file:" + (relative ? configFolder.path + "/" : ""))
            }
            return .string(result)
        case .array(let items): return .array(items.map(restored))
        case .object(let fields):
            // A name can hold one too (a header named by a variable).
            return .object(Dictionary(fields.map { (restored(.string($0.key)).string ?? $0.key, restored($0.value)) }, uniquingKeysWith: { first, _ in first }))
        default: return value
        }
    }

    /// Where the files opencode's settings name (`{file:…}`) are copied to, so Kuvo Code's don't
    /// depend on opencode's folder: only you can read them.
    static var filesFolder: URL { AppInfo.supportDirectory.appending(path: "opencode-files") }

    /// `value` with each file it names outside Kuvo Code's folder copied into `filesFolder`, and
    /// named there; one that isn't there anymore reads as nothing, as a missing variable does.
    static func ownFiles(_ value: JSONValue) -> JSONValue {
        naming(value) { own($0) }
    }

    /// `value` as `ownFiles` would make it, without copying anything: to tell what's been brought
    /// over before.
    static func owned(_ value: JSONValue) -> JSONValue {
        naming(value) { FileManager.default.fileExists(atPath: $0) ? copyPath(of: $0) : nil }
    }

    /// `value` with each file it names (`{file:…}`) named as `name` says, or left out.
    private static func naming(_ value: JSONValue, _ name: (String) -> String?) -> JSONValue {
        switch value {
        case .string(let text):
            guard text.contains("{file:") else { return value }
            var result = ""
            var rest = Substring(text)
            while let open = rest.range(of: "{file:"), let close = rest[open.upperBound...].firstIndex(of: "}") {
                result += rest[..<open.lowerBound]
                let path = (String(rest[open.upperBound..<close]) as NSString).expandingTildeInPath
                result += name(path).map { "{file:\($0)}" } ?? ""
                rest = rest[rest.index(after: close)...]
            }
            return .string(result + rest)
        case .array(let items): return .array(items.map { naming($0, name) })
        case .object(let fields): return .object(fields.mapValues { naming($0, name) })
        default: return value
        }
    }

    /// Where the copy of the file at `path` goes: named after the file and where it is, so it's
    /// the same copy each time it's brought over (the path itself when it's there already).
    static func copyPath(of path: String) -> String {
        if path.hasPrefix(filesFolder.path + "/") { return path }
        let place = SHA256.hash(data: Data(path.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
        return filesFolder.appending(path: "\(place)-\((path as NSString).lastPathComponent)").path
    }

    /// `json`, settings as text, with what the files in `filesFolder` it names say written in, as
    /// the engine reads them: for a machine, which doesn't have them (in the private settings it
    /// gets, which go when its engine stops).
    static func inlined(_ json: String) -> String {
        let prefix = "{file:" + filesFolder.path + "/"
        guard json.contains(prefix) else { return json }
        var result = ""
        var rest = Substring(json)
        while let open = rest.range(of: prefix), let close = rest[open.upperBound...].firstIndex(of: "}") {
            result += rest[..<open.lowerBound]
            let path = filesFolder.path + "/" + rest[open.upperBound..<close]
            let text = (try? String(contentsOfFile: path, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            // As the inside of the JSON string it's in.
            let encoded = (try? JSONEncoder().encode(text)).map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
            result += encoded.dropFirst().dropLast()
            rest = rest[rest.index(after: close)...]
        }
        return result + rest
    }

    /// A copy of the file at `path` in `filesFolder`, as it says now (the path itself when it's
    /// there already).
    private static func own(_ path: String) -> String? {
        let manager = FileManager.default
        guard manager.fileExists(atPath: path) else { return nil }
        let copy = copyPath(of: path)
        if copy == path { return path }
        try? manager.createDirectory(at: filesFolder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let data = manager.contents(atPath: path), manager.createFile(atPath: copy, contents: data, attributes: [.posixPermissions: 0o600]) else { return path }
        return copy
    }

    private static func deepMerged(_ base: [String: JSONValue], _ over: [String: JSONValue]) -> [String: JSONValue] {
        var result = base
        for (key, value) in over {
            if case .object(let inner) = value, case .object(let existing)? = result[key] {
                result[key] = .object(deepMerged(existing, inner))
            } else {
                result[key] = value
            }
        }
        return result
    }

    /// What `read` has that `config` doesn't: the settings that carry over (not its theme, key
    /// bindings or updates, which are opencode's own), entry by entry, nothing replaced.
    static func missing(from read: [String: JSONValue], in config: [String: JSONValue]) -> [String: JSONValue] {
        var plan: [String: JSONValue] = [:]
        if let model = read["model"], config["model"] == nil { plan["model"] = model }
        for key in ["agents", "commands", "providers"] {
            let theirs = read[key]?.object ?? [:]
            let ours = config[key]?.object ?? [:]
            let new = theirs.filter { ours[$0.key] == nil }
            if !new.isEmpty { plan[key] = .object(new) }
        }
        // A server named as one of Kuvo Code's integrations is opencode's own, not that: named
        // apart, so it isn't taken for it (upgraded, removed with it).
        var servers: [String: JSONValue] = [:]
        for (name, server) in read["mcp"]?["servers"]?.object ?? [:] {
            let named = Integrations.service(name) == nil ? name : name + "-opencode"
            if config["mcp"]?["servers"]?[named] == nil { servers[named] = server }
        }
        if !servers.isEmpty { plan["mcp"] = .object(["servers": .object(servers)]) }
        // As they'd be once brought over: a file they name is the copy in Kuvo Code's folder.
        for key in ["plugins", "instructions", "permissions"] {
            let ours = config[key]?.array ?? []
            let new = (read[key]?.array ?? []).filter { !ours.contains(owned($0)) }
            if !new.isEmpty { plan[key] = .array(new) }
        }
        return plan
    }

    /// opencode's sign-ins, as the engine's own import of them makes them: an API key as a key, a
    /// sign-in with its method and the account it's for. Read when needed, kept in memory.
    static func accounts() -> [(integration: String, label: String, value: JSONValue)] {
        guard let data = try? Data(contentsOf: dataFolder.appending(path: "auth.json")),
              case .object(let entries)? = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
        var found: [(integration: String, label: String, value: JSONValue)] = []
        for (name, entry) in entries.sorted(by: { $0.key < $1.key }) {
            let integration = name.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
            guard !integration.isEmpty, let type = entry["type"]?.string else { continue }
            switch type {
            case "api":
                guard let key = entry["key"]?.string else { continue }
                var value: [String: JSONValue] = ["type": .string("key"), "key": .string(key)]
                if let metadata = entry["metadata"], metadata.object != nil { value["metadata"] = metadata }
                found.append((integration, "API key", .object(value)))
            case "wellknown":
                guard let token = entry["token"]?.string else { continue }
                found.append((integration, "API key", .object(["type": .string("key"), "key": .string(token)])))
            case "oauth":
                guard let refresh = entry["refresh"]?.string, let access = entry["access"]?.string, let expires = entry["expires"]?.number else { continue }
                var value: [String: JSONValue] = [
                    "type": .string("oauth"), "methodID": .string(method(for: integration)),
                    "refresh": .string(refresh), "access": .string(access), "expires": .number(expires),
                ]
                var metadata: [String: JSONValue] = [:]
                if let account = entry["accountId"]?.string { metadata["accountID"] = .string(account) }
                if let url = entry["enterpriseUrl"]?.string { metadata["enterpriseUrl"] = .string(url) }
                if !metadata.isEmpty { value["metadata"] = .object(metadata) }
                found.append((integration, "OAuth", .object(value)))
            default:
                continue
            }
        }
        return found
    }

    /// The engine's sign-in method for an older opencode's sign-in to `integration`.
    private static func method(for integration: String) -> String {
        if integration == "openai" { return "chatgpt-browser" }
        if ["github-copilot", "opencode", "xai"].contains(integration) { return "device" }
        return "oauth"
    }

    static func modelName(_ model: JSONValue) -> String {
        if let text = model.string { return text }
        if let provider = model["providerID"]?.string, let id = model["model"]?.string ?? model["id"]?.string { return provider + "/" + id }
        return "set"
    }

    // MARK: Bringing it over

    /// What bringing a plan over came to.
    struct Outcome {
        /// Settings that came over: none when they weren't saved (`notSaved`).
        var settings = 0
        /// Why the settings weren't saved where the box keeps them, when they weren't.
        var notSaved: String?
        /// API keys the engine took.
        var accounts = 0
        /// The integrations whose keys it didn't take.
        var failedAccounts: [String] = []

        var count: Int { settings + accounts }
    }

    /// Brings the plan over and says how it went, in words: only what got there is counted, and
    /// what didn't is said. `renews`: something came over, for the engine to start again to use.
    @MainActor
    static func bringOver(_ plan: Plan, to config: EngineConfig, api: OpenCodeAPI, name: (String) -> String) async -> (note: String, renews: Bool) {
        let outcome = await apply(plan, to: config, api: api)
        let count = outcome.count
        var note = switch count {
        case 0: "Nothing came over from opencode."
        case 1: "Brought over 1 thing from opencode."
        default: "Brought over \(count) things from opencode."
        }
        if let notSaved = outcome.notSaved { note += " Its settings didn’t come over. \(notSaved)" }
        if !outcome.failedAccounts.isEmpty {
            note += " The API keys for \(ListFormatter.localizedString(byJoining: outcome.failedAccounts.map(name))) couldn’t be copied; add them in Settings › Accounts."
        }
        return (note, count > 0)
    }

    /// Adds the plan's settings to `config` and its accounts to the engine behind `api`.
    @MainActor
    static func apply(_ plan: Plan, to config: EngineConfig, api: OpenCodeAPI) async -> Outcome {
        var count = 0
        // All in one write, so the engine reloads its settings once.
        var changes: [(path: [String], value: JSONValue?)] = []
        for (key, value) in plan.settings.mapValues(ownFiles) {
            switch key {
            case "model":
                changes.append((["model"], value))
                count += 1
            case "mcp":
                for (name, server) in value["servers"]?.object ?? [:] {
                    changes.append((MCPSettings.path + [name], server))
                    count += 1
                }
            case "plugins", "instructions", "permissions":
                let ours = config.value(at: [key])?.array ?? []
                let new = (value.array ?? []).filter { !ours.contains($0) }
                // The last permission rule that matches wins: yours stay after the ones brought over.
                if !new.isEmpty { changes.append(([key], .array(key == "permissions" ? new + ours : ours + new))) }
                count += new.count
            default:
                for (name, entry) in value.object ?? [:] {
                    changes.append(([key, name], entry))
                    count += 1
                }
            }
        }
        if !plan.skillFolders.isEmpty {
            let ours = config.value(at: ["skills"])?.array ?? []
            changes.append((["skills"], .array(ours + plan.skillFolders.map(JSONValue.string))))
            count += plan.skillFolders.count
        }
        var outcome = Outcome(settings: count)
        if !changes.isEmpty {
            if let problem = config.problem {
                outcome.notSaved = problem
            } else if !config.isLoaded {
                outcome.notSaved = "Kuvo Code’s settings haven’t been read yet. Try again in a moment."
            } else {
                config.set(changes)
                // Saved where the box keeps them (before the engine starts again to read them), or
                // why not, as it answers this change.
                outcome.notSaved = await config.settled()
            }
            if outcome.notSaved != nil { outcome.settings = 0 }
        }
        for account in plan.accounts {
            if (try? await api.storeCredential(value: account.value, label: account.label, for: account.integration)) != nil {
                outcome.accounts += 1
            } else {
                outcome.failedAccounts.append(account.integration)
            }
        }
        Analytics.shared.track("opencode_imported", ["things": outcome.count, "accounts": plan.accounts.count])
        return outcome
    }
}
