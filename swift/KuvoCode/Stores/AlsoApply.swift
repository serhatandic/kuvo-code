import Foundation
import OpenCodeKit

/// Making changes made on one computer's settings on another too, when you ask ("Also Apply
/// to…"): each computer keeps its own settings, and nothing goes from one to another otherwise.
/// The same changes go to each box you pick (`kuvo/config/apply`), which makes them as its own
/// settings have room for (PROTOCOL.md): a list of rules gets what was added and loses what was
/// taken out, keeping the rest of its own. The keys they name go first, from where one box keeps
/// them to where the other does, unless it has its own.
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

    /// Something a box doesn't have that some changes were to, as the bar says it: "the agent review".
    static func describe(_ entry: [String]) -> String {
        let name = entry.last ?? ""
        return switch entry.first {
        case "agents": "the agent \(name)"
        case "commands": "the command /\(name)"
        case "providers": "the provider \(name)"
        default: Integrations.service(name)?.title ?? "the MCP server \(name)"
        }
    }

    /// Something each computer keeps its own, as the bar says it: "shell".
    static func describeKept(_ path: [String]) -> String {
        switch path {
        case ["shell"]: "shell"
        case ["worktree", "directory"]: "worktrees folder"
        default: path.joined(separator: " ")
        }
    }

    /// A server that uses a Mac's own apps, which stays on Macs, as the bar names it.
    static func describeServer(_ id: String) -> String {
        Integrations.service(id)?.title ?? MCPCatalog.servers.first { $0.id == id }?.title ?? id
    }

    /// What applying did on one computer, as the bar says it: what it doesn't have that some of
    /// the changes were to, what it keeps its own, the servers that stayed on Macs, and whether
    /// anything there changed or was already so.
    struct Outcome {
        var leftOut: [String] = []
        var kept: [String] = []
        var macOnly: [String] = []
        var applied = true
    }

    /// `changes`, made on `source`, made on `target` too; `target`'s settings, as its box answers,
    /// shown at once.
    @discardableResult
    @MainActor static func apply(_ changes: [EngineConfig.Change], from source: SidebarBox, to target: SidebarBox, app: AppModel) async throws -> Outcome {
        let (outcome, settings) = try await apply(changes, from: app.box(source.id), to: app.box(target.id))
        app.config(for: target).took(settings)
        return outcome
    }

    /// `changes`, made on `source`'s box, made on `target`'s: a look first, which changes nothing
    /// and names the keys they'd need; those keys, from `source` where `target` hasn't its own; then
    /// the changes. Its settings after.
    static func apply(_ changes: [EngineConfig.Change], from source: BoxClient, to target: BoxClient) async throws -> (Outcome, [String: JSONValue]) {
        let sent = net(changes).map { Request.Change(path: $0.path, before: $0.before, after: $0.after) }
        let look = try await ask(target, Request(changes: sent, dry: true))
        // The keys first, so the settings that name them find them there; one the other computer
        // has of its own (another account's token, say) stays.
        var brought: [String] = []
        do {
            for name in look.keys {
                if let there = try await key(name, on: target), !there.isEmpty { continue }
                guard let value = try await key(name, on: source), !value.isEmpty else { continue }
                let (status, data) = try await target.send("PUT", "kuvo/keys/\(name)", body: try JSONEncoder().encode(["value": value]))
                guard (200..<300).contains(status) else { throw Failure.refused(BoxRefusal(status: status, data: data).message) }
                brought.append(name)
            }
            let done = look.made.isEmpty ? look : try await ask(target, Request(changes: sent, dry: false))
            // A key brought for a change that wasn't made after all (its settings changed there
            // meanwhile) doesn't stay there.
            await forget(brought.filter { !done.keys.contains($0) }, on: target)
            let outcome = Outcome(leftOut: done.leftOut.map(describe), kept: done.kept.map(describeKept), macOnly: done.macOnly.map(describeServer), applied: done.applied)
            return (outcome, done.settings)
        } catch {
            // Nothing applied: nor the keys brought for it.
            await forget(brought, on: target)
            throw error
        }
    }

    /// Keys brought to `box` for changes that weren't made there, taken away again.
    private static func forget(_ names: [String], on box: BoxClient) async {
        for name in names { _ = try? await box.send("DELETE", "kuvo/keys/\(name)") }
    }

    private struct Request: Encodable {
        struct Change: Encodable {
            var path: [String]
            var before: JSONValue?
            var after: JSONValue?
        }
        var changes: [Change]
        var dry: Bool
    }

    /// What a box answers `kuvo/config/apply` with.
    private struct Answer: Decodable {
        struct Made: Decodable { var path: [String] }
        var made: [Made]
        var leftOut: [[String]]
        var kept: [[String]]
        var macOnly: [String]
        var keys: [String]
        var applied: Bool
        var settings: [String: JSONValue]
    }

    private static func ask(_ box: BoxClient, _ request: Request) async throws -> Answer {
        do {
            return try await box.value(Answer.self, "POST", "kuvo/config/apply", body: request)
        } catch let refusal as BoxRefusal {
            // A machine whose box hasn't this route yet: its Kuvo Code comes up to date as it connects.
            throw Failure.refused(refusal.status == 404 ? "connect to it once first, to bring it up to date." : refusal.message)
        } catch is DecodingError {
            throw Failure.unread(connected: true)
        } catch {
            throw Failure.unread(connected: false)
        }
    }

    /// A key's value where `box` keeps it; nil for none.
    private static func key(_ name: String, on box: BoxClient) async throws -> String? {
        struct Value: Decodable { var value: String }
        let (status, data) = try await box.send("GET", "kuvo/keys/\(name)")
        if status == 404 { return nil }
        guard (200..<300).contains(status) else { throw Failure.refused(BoxRefusal(status: status, data: data).message) }
        return try? JSONDecoder().decode(Value.self, from: data).value
    }
}
