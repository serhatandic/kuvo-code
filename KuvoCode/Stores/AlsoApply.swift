import Foundation
import OpenCodeKit

/// Making changes made on one computer's settings on another too, when you ask ("Also Apply
/// to…"): each computer keeps its own settings, and nothing goes from one to another otherwise.
/// A list of rules (Settings › Permissions' rules and blocks, an agent's) gets what was added to
/// it and loses what was taken out, keeping the rest of the other computer's own; anything else
/// (another list, like a server's command, too) is set as it is here. An integration's keys go
/// along, from where this computer keeps them to where the other does, unless it has its own.
enum AlsoApply {
    enum Failure: LocalizedError {
        /// Its settings couldn't be read: `connected`, though it's connected.
        case unread(connected: Bool)
        case refused(String)

        /// Why, for several computers at once.
        var plural: String {
            switch self {
            case .unread(let connected): connected ? "their settings couldn’t be read." : "they aren’t connected."
            case .refused(let why): why
            }
        }

        var errorDescription: String? {
            switch self {
            case .unread(let connected): connected ? "its settings couldn’t be read." : "it isn’t connected."
            case .refused(let why): why
            }
        }
    }

    /// Where a change wasn't made and why, as the bar says it, computers with the same reason
    /// together: "Not applied on A and B: they aren't connected." `titled`: the bar's title says
    /// where already, so only why ("A and B aren't connected.").
    static func failures(_ missed: [(name: String, error: any Error)], titled: Bool) -> String {
        var reasons: [(error: any Error, names: [String])] = []
        for (name, error) in missed {
            if let at = reasons.firstIndex(where: { $0.error.localizedDescription == error.localizedDescription }) {
                reasons[at].names.append(name)
            } else {
                reasons.append((error, [name]))
            }
        }
        return reasons.map { error, names in
            let who = names.formatted(.list(type: .and))
            let one = names.count == 1
            guard titled else {
                let why = one ? error.localizedDescription : (error as? Failure)?.plural ?? error.localizedDescription
                return "Not applied on \(who): \(why)"
            }
            return switch error as? Failure {
            case .unread(connected: false): "\(who) \(one ? "isn’t" : "aren’t") connected."
            case .unread(connected: true): one ? "\(who)’s settings couldn’t be read." : "The settings of \(who) couldn’t be read."
            default: "\(who): \(error.localizedDescription)"
            }
        }.joined(separator: " ")
    }

    /// The changes as one: each place's first value before and last after, in the order they were
    /// first made; those that came back to where they were left out.
    static func net(_ changes: [EngineConfig.Change]) -> [EngineConfig.Change] {
        var order: [[String]] = []
        var first: [[String]: EngineConfig.Change] = [:]
        var last: [[String]: EngineConfig.Change] = [:]
        for change in changes {
            if first[change.path] == nil {
                order.append(change.path)
                first[change.path] = change
            }
            last[change.path] = change
        }
        return order.compactMap { path in
            guard let start = first[path], let end = last[path], start.before != end.after else { return nil }
            return EngineConfig.Change(id: end.id, path: path, before: start.before, after: end.after)
        }
    }

    /// What `changes` make of `target`'s settings, there: the path and the value to set.
    static func translated(_ changes: [EngineConfig.Change], onto target: [String: JSONValue], to machine: String?) -> [(path: [String], value: JSONValue?)] {
        translation(changes, onto: target, to: machine).made
    }

    /// What `target` doesn't have that `changes` are to (an agent, a command, a server, a
    /// provider), so they aren't made there: by entry (`describe` says each), once each.
    static func leftOut(_ changes: [EngineConfig.Change], onto target: [String: JSONValue], to machine: String?) -> [[String]] {
        translation(changes, onto: target, to: machine).leftOut
    }

    /// The servers among `changes` that use a Mac's own apps (Apple Calendar & Reminders, Chrome's
    /// tools), which stay on Macs: as the bar names them.
    static func macOnly(_ changes: [EngineConfig.Change]) -> [String] {
        var named: [String] = []
        for change in changes where change.path.count >= 3 && change.path[0] == "mcp" && change.path[1] == "servers" {
            let id = change.path[2]
            guard Integrations.macOnly.contains(id) || MCPCatalog.macOnly.contains(id) else { continue }
            let name = Integrations.service(id)?.title ?? MCPCatalog.servers.first { $0.id == id }?.title ?? id
            if !named.contains(name) { named.append(name) }
        }
        return named
    }

    /// What each computer keeps its own, as the bar says it, among `changes`: its shell (each
    /// picks from its own), and a worktrees folder on its disk (one relative to each project goes).
    static func keptOwn(_ changes: [EngineConfig.Change]) -> [String] {
        var kept: [String] = []
        for change in changes {
            if let own = ownSetting(change), !kept.contains(own) { kept.append(own) }
        }
        return kept
    }

    private static func ownSetting(_ change: EngineConfig.Change) -> String? {
        if change.path == ["shell"] { return "shell" }
        if change.path == ["worktree", "directory"], let folder = change.after?.string ?? change.before?.string,
           folder.hasPrefix("/") || folder.hasPrefix("~") { return "worktrees folder" }
        return nil
    }

    /// An entry `leftOut` names, as the bar says it: "the agent review".
    static func describe(_ entry: [String]) -> String {
        let name = entry.last ?? ""
        return switch entry.first {
        case "agents": "the agent \(name)"
        case "commands": "the command /\(name)"
        case "providers": "the provider \(name)"
        default: Integrations.service(name)?.title ?? "the MCP server \(name)"
        }
    }

    private static func translation(_ changes: [EngineConfig.Change], onto target: [String: JSONValue], to machine: String?) -> (made: [(path: [String], value: JSONValue?)], leftOut: [[String]]) {
        var settings = target
        var result: [(path: [String], value: JSONValue?)] = []
        var leftOut: [[String]] = []
        for change in changes {
            // Integrations that use a Mac's own apps stay on Macs.
            if machine != nil, change.path.count >= 3, change.path[0] == "mcp", change.path[1] == "servers",
               Integrations.macOnly.contains(change.path[2]) || MCPCatalog.macOnly.contains(change.path[2]) { continue }
            // What each computer keeps its own (`keptOwn`).
            if ownSetting(change) != nil { continue }
            // A field of a server, agent or command the target doesn't have, or the mode new
            // sessions start in when it's an agent it doesn't have: none made there with only
            // that (adding or removing a whole one still goes).
            if let entry = Self.needs(change), EngineConfig.value(at: entry, in: settings) == nil {
                if !leftOut.contains(entry) { leftOut.append(entry) }
                continue
            }
            var value = change.after.map { keysNamed($0, on: machine) }
            // Rules: none is an empty list, so the first one added (or the last taken out) joins
            // (or leaves) the other's, rather than standing in for them.
            if isRules(change.path), change.before?.array != nil || change.after?.array != nil,
               change.before == nil || change.before?.array != nil, change.after == nil || change.after?.array != nil {
                let before = change.before?.array ?? []
                let after = change.after?.array ?? []
                let there = EngineConfig.value(at: change.path, in: settings)?.array ?? []
                let removed = before.filter { !after.contains($0) }
                let added = after.filter { !before.contains($0) }.map { keysNamed($0, on: machine) }
                let kept = there.filter { !removed.contains($0) }
                let merged = kept + added.filter { !kept.contains($0) }
                value = merged.isEmpty ? nil : .array(merged)
            }
            result.append((change.path, value))
            settings = setting(value, at: change.path[...], in: settings)
        }
        return (result, leftOut)
    }

    /// What a computer needs to have for `change` to be made there: the entry it's a field of, or
    /// the agent `default_agent` names (the engine's own are on every computer).
    static func needs(_ change: EngineConfig.Change) -> [String]? {
        if change.path == ["default_agent"], let agent = change.after?.string, !BuiltInAgents.contains(agent) { return ["agents", agent] }
        return entry(of: change.path)
    }

    /// The named entry (an MCP server, an agent, a command, a provider) `path` is a field of,
    /// when it's one a computer may not have. (The engine's own agents are on every one, named or
    /// not.)
    static func entry(of path: [String]) -> [String]? {
        switch path.first {
        case "mcp" where path.count >= 4 && path[1] == "servers": Array(path.prefix(3))
        case "agents" where path.count >= 3 && BuiltInAgents.contains(path[1]): nil
        case "agents", "commands", "providers": path.count >= 3 ? Array(path.prefix(2)) : nil
        default: nil
        }
    }

    /// A list of rules, merged item by item: Settings › Permissions' rules and blocks, and an
    /// agent's own rules.
    static func isRules(_ path: [String]) -> Bool {
        guard let last = path.last else { return false }
        return last == "permissions" || last == "policies"
    }

    /// The keys `changes` name (integrations' shared keys, not a bot's own).
    static func keys(in changes: [(path: [String], value: JSONValue?)]) -> Set<String> {
        Set(changes.compactMap(\.value).flatMap(Integrations.keyNames).filter { !IntegrationKeys.isBots($0) })
    }

    /// What applying did on one computer: whether anything there changed or was already so, and
    /// what it doesn't have that some of the changes were to (`describe`d).
    struct Outcome {
        var leftOut: [String] = []
        /// Something was made there, or every change was already so.
        var applied = true
    }

    /// `changes`, made on `source`, made on `target` too: its settings, then the keys they name.
    @discardableResult
    @MainActor static func apply(_ changes: [EngineConfig.Change], from source: SidebarBox, to target: SidebarBox, app: AppModel) async throws -> Outcome {
        let config = app.config(for: target)
        if !config.isLoaded {
            config.reload()
            for _ in 0..<150 where !config.isLoaded && config.problem == nil { try await Task.sleep(for: .milliseconds(100)) }
            guard config.isLoaded else {
                throw Failure.unread(connected: target.machine.map { app.machines.engine($0)?.isReady == true } ?? true)
            }
        }
        let (made, missing) = translation(net(changes), onto: config.settings, to: target.machine)
        // Nothing made, and nothing said of what it doesn't have: what stays with every computer
        // (its shell, a server only Macs run) is said once, by the bar.
        let stays = !keptOwn(net(changes)).isEmpty || (target.machine != nil && !macOnly(net(changes)).isEmpty)
        let outcome = Outcome(leftOut: missing.map(describe), applied: !made.isEmpty || (missing.isEmpty && !stays))
        guard !made.isEmpty else { return outcome }
        // The keys first, so the settings that name them find them there; one the other computer
        // has of its own (another account's token, say) stays.
        for name in keys(in: made) {
            if let there = try await key(name, on: target), !there.isEmpty { continue }
            guard let value = try await key(name, on: source), !value.isEmpty else { continue }
            try await setKey(name, value, on: target)
        }
        config.set(made, noted: false)
        // Applied once it's there, or why it isn't.
        if let failure = await config.settled() { throw Failure.refused(failure) }
        return outcome
    }

    /// A key's value where `box` keeps it.
    @MainActor private static func key(_ name: String, on box: SidebarBox) async throws -> String? {
        guard let machine = box.machine else { return IntegrationKeys.value(name) }
        let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-key-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: file) }
        try await SSHConnection(destination: machine).run(RemoteEngineInstaller.script("cat \"$K/box/keys/\"\(SSHConnection.quoted(name)) 2>/dev/null; true"), output: file)
        return try? String(contentsOf: file, encoding: .utf8)
    }

    @MainActor private static func setKey(_ name: String, _ value: String, on box: SidebarBox) async throws {
        guard let machine = box.machine else {
            IntegrationKeys.set(value, for: name)
            return
        }
        try await MachineBox.setKey(name, value, on: SSHConnection(destination: machine))
    }

    /// Keys named as `machine` (nil: this Mac) keeps them.
    static func keysNamed(_ value: JSONValue, on machine: String?) -> JSONValue {
        switch value {
        case .string(let text):
            guard text.contains("KUVO_KEY_"), let regex = try? NSRegularExpression(pattern: #"\{file:[^{}]*?(KUVO_KEY_[A-Za-z0-9_]+)\}"#) else { return value }
            let original = text as NSString
            let result = NSMutableString(string: text)
            for match in regex.matches(in: text, range: NSRange(location: 0, length: original.length)).reversed() {
                result.replaceCharacters(in: match.range, with: IntegrationKeys.reference(original.substring(with: match.range(at: 1)), on: machine))
            }
            return .string(result as String)
        case .object(let object): return .object(object.mapValues { keysNamed($0, on: machine) })
        case .array(let array): return .array(array.map { keysNamed($0, on: machine) })
        default: return value
        }
    }

    private static func setting(_ value: JSONValue?, at path: ArraySlice<String>, in object: [String: JSONValue]) -> [String: JSONValue] {
        var object = object
        let key = path.first!
        if path.count == 1 {
            object[key] = value
        } else {
            let inner = setting(value, at: path.dropFirst(), in: object[key]?.object ?? [:])
            object[key] = inner.isEmpty ? nil : .object(inner)
        }
        return object
    }
}
