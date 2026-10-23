import Foundation
import OpenCodeKit

/// A machine's settings, its own (`MachineBox`): read, and changed key by key, over SSH.
protocol RemoteSettings {
    func read() async throws -> [String: JSONValue]
    /// The settings after the changes, with what changed elsewhere meanwhile.
    func change(_ changes: [(path: [String], value: JSONValue?)]) async throws -> [String: JSONValue]
}

/// A computer's engine settings, each computer's own (a box of its own): this Mac's file,
/// `opencode.json` in its engine's config folder, or a machine's, over SSH (`remote`). The engine
/// reads them as its global configuration, and reloads them when they change. Settings edit them
/// in place and keep whatever they don't show, so a hand-edited file loses nothing.
@Observable
final class EngineConfig {
    let file: URL
    /// The file's settings; empty when there's no file yet (or, a machine's, until they're read).
    private(set) var settings: [String: JSONValue] = [:]
    /// Why the file couldn't be read. It's left alone until it's fixed.
    private(set) var problem: String?
    /// A machine's settings, read and changed there; nil for this Mac's file.
    @ObservationIgnored let remote: RemoteSettings?
    /// Read at least once: a machine's come once it's reached.
    private(set) var isLoaded = false
    /// A machine's change that didn't get there (it's shown as it is there again), until the
    /// next one does.
    private(set) var notSaved: String?

    /// Settings kept only here, never written anywhere: something being made (a new agent),
    /// filled in by the same controls, until it's created.
    let isDraft: Bool

    init(file: URL) {
        self.file = file
        isDraft = false
        remote = nil
        reload()
        isLoaded = true
        Self.current = self
    }

    init(draft settings: [String: JSONValue]) {
        file = URL(filePath: "/dev/null")
        isDraft = true
        remote = nil
        self.settings = settings
        isLoaded = true
    }

    /// A machine's: read once it's reached (`took`, `reload`).
    init(remote: RemoteSettings) {
        file = URL(filePath: "/dev/null")
        isDraft = false
        self.remote = remote
    }

    /// This Mac's, for the places that make a session's rules.
    static weak var current: EngineConfig?
    /// A machine's, by its name, while it's added; and every machine's.
    static var machine: (String) -> EngineConfig? = { _ in nil }
    static var machines: () -> [EngineConfig] = { [] }

    /// The settings of the computer a session is on (nil: this Mac).
    static func of(_ machine: String?) -> EngineConfig? {
        guard let machine else { return current }
        return Self.machine(machine)
    }

    /// Settings › Permissions' rules of the computer a session is on (nil: this Mac), from its
    /// own settings: none for a machine not read yet (it's read before its engine is reached, so
    /// only just after it's added), whose sessions wait for them (`knowsRules`).
    static func rules(on machine: String?) -> [PermissionRule] {
        guard let config = of(machine), config.isLoaded else { return [] }
        return config.permissionRules
    }

    /// The computer's rules are known: this Mac's always, a machine's once read.
    static func knowsRules(on machine: String?) -> Bool {
        of(machine)?.isLoaded == true
    }

    /// A machine's settings as they were just read some other way (as it's started).
    func took(_ read: [String: JSONValue]) {
        guard remote != nil else { return }
        let first = !isLoaded
        reads += 1
        confirmed = read
        // What's on its way, in the order it was changed.
        settings = Self.applying(sent + pending, to: read)
        problem = nil
        isLoaded = true
        // A change that didn't get there is said once it's shown as it is there; read again
        // after that, all's as it is.
        if keepsNotice { keepsNotice = false } else { notSaved = nil }
        // Known now, rules or none: sessions there that waited for them take them.
        if first {
            rules = settings["permissions"]
            onRulesChanged()
        } else {
            noteRules()
        }
    }

    /// Once what's been changed here has reached the machine (at once for this Mac's file): nil,
    /// or why it didn't get there.
    func settled() async -> String? {
        guard remote != nil, isSending else { return remote == nil ? problem : notSaved }
        await withCheckedContinuation { settling.append($0) }
        return notSaved
    }

    @ObservationIgnored private var settling: [CheckedContinuation<Void, Never>] = []

    /// This Mac's, saved with a change (`AppModel.settingsSaved`).
    @ObservationIgnored var onSaved: () -> Void = {}
    /// Settings › Permissions' rules changed, wherever from (Settings, a phone, the file edited
    /// by hand): open sessions follow (`Workspace.syncPermissions`).
    @ObservationIgnored var onRulesChanged: () -> Void = {}
    /// The rules as they were last, to tell when they change.
    @ObservationIgnored private var rules: JSONValue?

    private func noteRules() {
        guard settings["permissions"] != rules else { return }
        rules = settings["permissions"]
        onRulesChanged()
    }

    /// Reads the file again and adds what Kuvo Code starts every engine with, unless it sets it:
    /// web search through Exa, which needs no key. The engine has none chosen, and every search
    /// the agent tried failed ("Web search provider is required"). Not "random": that keeps one
    /// service a session, and one that needs a key (Firecrawl) answers every search with nothing.
    ///
    /// It goes in the file, so a choice made anywhere (here, in Settings, in a project's own
    /// settings) wins over it, and only once: what you change or remove later stays as you left
    /// it. A file Kuvo Code can't read is left alone; a new one (none yet, or deleted to start
    /// over) gets it again.
    func addDefaults() {
        guard remote == nil else { return }
        reload()
        guard problem == nil else { return }
        let isNew = !FileManager.default.fileExists(atPath: file.path)
        let defaults = UserDefaults.standard
        if isNew || !defaults.bool(forKey: Self.defaultsAddedKey) {
            if settings["websearch"] == nil { add(Self.search, as: "websearch") }
            if problem == nil {
                defaults.set(true, forKey: Self.defaultsAddedKey)
                defaults.set(true, forKey: Self.searchMovedKey)
            }
        } else if !defaults.bool(forKey: Self.searchMovedKey) {
            // "random", as Kuvo Code chose it before: Exa instead, once.
            if value(at: ["websearch"]) == .object(["provider": .string("random")]) { set(Self.search, at: ["websearch"]) }
            if problem == nil { defaults.set(true, forKey: Self.searchMovedKey) }
        }
    }

    private static let search: JSONValue = .object(["provider": .string("exa")])
    private static let defaultsAddedKey = "engine.defaultsAdded"
    private static let searchMovedKey = "engine.searchMovedToExa"

    /// Adds a setting to the file as it's written, keeping its layout and order: one line at its
    /// end. A file that's new, or not laid out as expected, is written whole, as `set` does.
    private func add(_ value: JSONValue, as key: String) {
        if let original = try? String(contentsOf: file, encoding: .utf8),
           let text = Self.adding(key, value, to: original),
           let parsed = try? JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8)),
           parsed == settings.merging([key: value], uniquingKeysWith: { $1 }) {
            do {
                try Data(text.utf8).write(to: target, options: .atomic)
                settings = parsed
                noteRules()
            } catch {
                problem = "It couldn't be saved: \(error.localizedDescription)"
            }
        } else {
            set(value, at: [key])
        }
    }

    /// `text`, a JSON object, with `key: value` added as its last member, laid out like the rest
    /// (on a line of its own, indented as the one before it, or all on one line); nil when it
    /// doesn't end as an object does.
    static func adding(_ key: String, _ value: JSONValue, to text: String) -> String? {
        guard let close = text.lastIndex(where: { !$0.isWhitespace }), text[close] == "}",
              let last = text[..<close].lastIndex(where: { !$0.isWhitespace }),
              let member = inline(.object([key: value])).map({ String($0.dropFirst().dropLast()) }) else { return nil }
        let isEmpty = text[last] == "{"
        let head = String(text[...last]), tail = String(text[close...])
        // The file's own line ending ("\r\n" is one Character to Swift, so it's read by scalar).
        let scalars = text.unicodeScalars
        let newline = scalars.contains("\r") ? (scalars.contains("\n") ? "\r\n" : "\r") : scalars.contains("\n") ? "\n" : nil
        guard let newline else { return head + (isEmpty ? "" : ", ") + member + tail }
        let lineStart = text[..<last].lastIndex(where: \.isNewline).map { text.index(after: $0) } ?? text.startIndex
        let indent = isEmpty ? "  " : String(text[lineStart...].prefix { $0 == " " || $0 == "\t" })
        return head + (isEmpty ? "" : ",") + newline + indent + member + newline + tail
    }

    /// `value` as JSON on one line, spaced as people write it: `{"provider": "random"}`.
    private static func inline(_ value: JSONValue) -> String? {
        switch value {
        case .object(let object):
            var members: [String] = []
            for key in object.keys.sorted() {
                guard let name = inline(.string(key)), let value = inline(object[key]!) else { return nil }
                members.append(name + ": " + value)
            }
            return "{" + members.joined(separator: ", ") + "}"
        case .array(let items):
            var texts: [String] = []
            for item in items {
                guard let text = inline(item) else { return nil }
                texts.append(text)
            }
            return "[" + texts.joined(separator: ", ") + "]"
        default:
            let encoder = JSONEncoder()
            encoder.outputFormatting = .withoutEscapingSlashes
            return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) }
        }
    }

    /// Where the file is written: through a link (to a dotfiles folder, say) to the file it names,
    /// so the link stays a link.
    private var target: URL {
        var url = file.resolvingSymlinksInPath()
        // A link to a file that isn't there yet, which that leaves as it is.
        for _ in 0..<8 {
            guard let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: url.path) else { break }
            url = URL(filePath: destination, relativeTo: url.deletingLastPathComponent()).standardizedFileURL
        }
        return url
    }

    /// Settings › Permissions' rules, in their order: what every session and mode is held to.
    var permissionRules: [PermissionRule] {
        guard let value = settings["permissions"], let data = try? JSONEncoder().encode(value) else { return [] }
        return (try? JSONDecoder().decode([PermissionRule].self, from: data)) ?? []
    }

    /// Reads the file again, after it was changed elsewhere (a machine's, in a moment).
    func reload() {
        guard !isDraft else { return }
        if let remote {
            reads += 1
            let read = reads
            Task {
                do {
                    let found = try await remote.read()
                    // One read or saved since knows better.
                    guard read == reads else { return }
                    took(found)
                } catch {
                    // Read before: kept as they were until the next read (a change there is
                    // said again), rather than shut for a moment's trouble with the connection.
                    guard read == reads, !isLoaded else { return }
                    problem = "Its settings couldn't be read: \(error.localizedDescription)"
                }
            }
            return
        }
        guard let data = try? Data(contentsOf: file) else {
            settings = [:]
            problem = nil
            noteRules()
            return
        }
        do {
            settings = data.isEmpty ? [:] : try JSONDecoder().decode([String: JSONValue].self, from: data)
            problem = nil
            noteRules()
        } catch {
            problem = "It isn't plain JSON, so Kuvo Code leaves it alone. (Comments aren't supported here.)"
        }
    }

    /// The value at a path of keys: `value(at: ["compaction", "auto"])`.
    func value(at path: [String]) -> JSONValue? {
        var current: JSONValue? = .object(settings)
        for key in path { current = current?[key] }
        return current
    }

    /// Sets the value at a path of keys, or removes it with nil (and any object it leaves
    /// empty), then saves.
    /// `noted`: false for what Kuvo Code changes itself (bringing settings up to date), rather
    /// than you.
    func set(_ value: JSONValue?, at path: [String], noted: Bool = true) {
        guard problem == nil, isLoaded, !path.isEmpty else { return }
        if noted { note(path, from: self.value(at: path), to: value) }
        settings = Self.setting(value, at: path[...], in: settings)
        save([(path, value)])
    }

    /// Several changes at once, in one write: the engine reloads its settings once, not after
    /// each of them. `noted`: false for those made on another computer first ("Also Apply to…").
    func set(_ changes: [(path: [String], value: JSONValue?)], noted: Bool = true) {
        guard problem == nil, isLoaded else { return }
        for change in changes where !change.path.isEmpty {
            if noted { note(change.path, from: value(at: change.path), to: change.value) }
            settings = Self.setting(change.value, at: change.path[...], in: settings)
        }
        save(changes.filter { !$0.path.isEmpty })
    }

    /// A change made here (in Settings, not by another computer or a phone), what it was before
    /// and after: for making it on other computers too ("Also Apply to…").
    struct Change: Identifiable, Equatable {
        let id: Int
        let path: [String]
        let before: JSONValue?
        let after: JSONValue?
    }

    /// The changes made here, the last hundred.
    private(set) var changes: [Change] = []
    @ObservationIgnored private var changeCount = 0

    #if DEBUG
    /// A change, noted without being made: for screenshots of "Also Apply to…".
    func noteForDemo(_ path: [String], to after: JSONValue?) {
        note(path, from: value(at: path), to: after)
    }
    #endif

    private func note(_ path: [String], from before: JSONValue?, to after: JSONValue?) {
        guard !isDraft, before != after else { return }
        changeCount += 1
        changes.append(Change(id: changeCount, path: path, before: before, after: after))
        if changes.count > 100 { changes.removeFirst(changes.count - 100) }
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

    private static func applying(_ changes: [(path: [String], value: JSONValue?)], to settings: [String: JSONValue]) -> [String: JSONValue] {
        changes.reduce(settings) { setting($1.value, at: $1.path[...], in: $0) }
    }

    /// What's at `path` in `settings`, as a computer's settings file has them.
    static func value(at path: [String], in settings: [String: JSONValue]) -> JSONValue? {
        var current: JSONValue? = .object(settings)
        for key in path { current = current?[key] }
        return current
    }

    /// A machine's changes waiting to be sent, and those sent and not answered yet: what's read
    /// meanwhile shows them as they'll be.
    @ObservationIgnored private var pending: [(path: [String], value: JSONValue?)] = []
    @ObservationIgnored private var sent: [(path: [String], value: JSONValue?)] = []
    @ObservationIgnored private var isSending = false
    /// A machine's settings as it last said they are (read, or answered with a change).
    @ObservationIgnored private var confirmed: [String: JSONValue] = [:]
    /// Goes up with each read and each answer to a change, so an older read that comes back
    /// later doesn't put back what was before.
    @ObservationIgnored private var reads = 0
    /// The read after a change that didn't get there keeps saying so.
    @ObservationIgnored private var keepsNotice = false

    /// A machine's changes, sent in order, a batch at a time, key by key: what comes back is its
    /// settings, with others' changes to other keys meanwhile. One that doesn't get there shows
    /// as it is there at once; those after it are still sent.
    private func send(_ changes: [(path: [String], value: JSONValue?)]) {
        guard let remote, !changes.isEmpty else { return }
        pending += changes
        guard !isSending else { return }
        isSending = true
        Task {
            while !pending.isEmpty {
                sent = pending
                pending.removeAll()
                let asked = reads
                do {
                    let after = try await remote.change(sent)
                    // Read since (a phone's change to another key, say): that stays, with what
                    // this change made of its own keys.
                    confirmed = reads == asked ? after : Self.applying(sent.map { ($0.path, Self.value(at: $0.path, in: after)) }, to: confirmed)
                    sent.removeAll()
                    reads += 1
                    settings = Self.applying(pending, to: confirmed)
                    notSaved = nil
                    noteRules()
                } catch {
                    notSaved = "It couldn't be saved there: \(error.localizedDescription)"
                    sent.removeAll()
                    // As it is there, rather than as it would have been, and read again.
                    settings = Self.applying(pending, to: confirmed)
                    noteRules()
                    keepsNotice = true
                    reload()
                }
            }
            isSending = false
            let waiting = settling
            settling.removeAll()
            for each in waiting { each.resume() }
        }
    }

    private func save(_ changes: [(path: [String], value: JSONValue?)] = []) {
        guard !isDraft else { return }
        if remote != nil { return send(changes) }
        // No "$schema": opencode's published schema is still v1's, and would mark v2's keys
        // as errors in an editor.
        let document = settings
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        do {
            let target = target
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try encoder.encode(document).write(to: target, options: .atomic)
            settings = document
            onSaved()
            noteRules()
        } catch {
            problem = "It couldn't be saved: \(error.localizedDescription)"
        }
    }
}

// MARK: - Reading values

extension JSONValue {
    /// Whole numbers as `Int`: nil for one that isn't whole or doesn't fit.
    var int: Int? { number.flatMap { Int(exactly: $0) } }
}
