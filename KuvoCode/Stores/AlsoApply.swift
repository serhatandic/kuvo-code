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
        case unread(String)
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .unread(let name): "\(name)’s settings couldn’t be read."
            case .refused(let why): why
            }
        }
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
        var settings = target
        var result: [(path: [String], value: JSONValue?)] = []
        for change in changes {
            // Integrations that use a Mac's own apps stay on Macs.
            if machine != nil, change.path.count >= 3, change.path[0] == "mcp", change.path[1] == "servers",
               Integrations.macOnly.contains(change.path[2]) || MCPCatalog.macOnly.contains(change.path[2]) { continue }
            // A field of a server, agent or command the target doesn't have: none made there with
            // only that (adding or removing a whole one still goes).
            if let entry = Self.entry(of: change.path), EngineConfig.value(at: entry, in: settings) == nil { continue }
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
        return result
    }

    /// The named entry (an MCP server, an agent, a command) `path` is a field of, when it's one.
    static func entry(of path: [String]) -> [String]? {
        switch path.first {
        case "mcp" where path.count >= 4 && path[1] == "servers": Array(path.prefix(3))
        case "agents", "commands": path.count >= 3 ? Array(path.prefix(2)) : nil
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

    /// `changes`, made on `source`, made on `target` too: its settings, then the keys they name.
    @MainActor static func apply(_ changes: [EngineConfig.Change], from source: SidebarBox, to target: SidebarBox, app: AppModel) async throws {
        let config = app.config(for: target)
        if !config.isLoaded {
            config.reload()
            for _ in 0..<150 where !config.isLoaded && config.problem == nil { try await Task.sleep(for: .milliseconds(100)) }
            guard config.isLoaded else { throw Failure.unread(app.name(of: target)) }
        }
        let made = translated(net(changes), onto: config.settings, to: target.machine)
        guard !made.isEmpty else { return }
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
