import Foundation
import Observation
import OpenCodeKit

/// A message that ran a command shows the command ("/review main") rather than the long
/// prompt the command sent for it, the same in both apps. The engine doesn't mark these messages,
/// so the app notes each one as it arrives, and keeps the notes across launches.
@MainActor @Observable
public final class CommandMessages {
    /// The app's own, kept in its settings.
    public static let shared = CommandMessages(defaults: .standard)
    private static let key = "commandMessages"
    private static let limit = 500

    /// Message IDs and their commands, oldest first.
    private var entries: [[String]]
    private var commands: [String: String]
    @ObservationIgnored private let save: ([[String]]) -> Void

    /// Notes `kept` from before (oldest first), each saved as it changes with `save`.
    public init(kept: [[String]], save: @escaping ([[String]]) -> Void) {
        let stored = kept.filter { $0.count == 2 }
        entries = stored
        commands = Dictionary(stored.map { ($0[0], $0[1]) }, uniquingKeysWith: { $1 })
        self.save = save
    }

    /// Kept in `defaults`.
    public convenience init(defaults: UserDefaults) {
        self.init(kept: defaults.array(forKey: Self.key) as? [[String]] ?? []) { defaults.set($0, forKey: Self.key) }
    }

    public subscript(id: String) -> String? { commands[id] }

    /// What `message` says as you wrote it: the command, if it ran one.
    public func text(of message: Message.User) -> String {
        commands[message.id] ?? message.text
    }

    public func note(_ id: String, command: String) {
        // Noted again (its events read twice): its newest place, once, so the oldest going doesn't
        // take it.
        if commands[id] != nil { entries.removeAll { $0.first == id } }
        commands[id] = command
        entries.append([id, command])
        if entries.count > Self.limit {
            for entry in entries.prefix(entries.count - Self.limit) { commands[entry[0]] = nil }
            entries.removeFirst(entries.count - Self.limit)
        }
        save(entries)
    }
}
