import Foundation
import OpenCodeKit

/// A box's settings, read and changed key by key, where the box keeps them.
protocol RemoteSettings {
    func read() async throws -> [String: JSONValue]
    /// The settings after the changes, with what changed elsewhere meanwhile. `was`, for each
    /// change, what its value must still be there (`.null`: none), or nil to change it whatever
    /// it is; refused when one isn't.
    func change(_ changes: [(path: [String], value: JSONValue?)], was: [JSONValue?]) async throws -> [String: JSONValue]
}

/// Any box's settings through its routes (PROTOCOL.md, `kuvo/config`): this Mac's, through its box
/// process, and a machine's, through its box over SSH, the same way.
struct BoxSettings: RemoteSettings {
    let client: BoxClient

    func read() async throws -> [String: JSONValue] {
        try await client.value([String: JSONValue].self, "GET", "kuvo/config")
    }

    func change(_ changes: [(path: [String], value: JSONValue?)], was: [JSONValue?]) async throws -> [String: JSONValue] {
        struct Change: Encodable { var path: [String]; var value: JSONValue; var was: JSONValue? }
        struct Changes: Encodable { var changes: [Change] }
        let sent = changes.enumerated().map { Change(path: $1.path, value: $1.value ?? .null, was: was.indices.contains($0) ? was[$0] : nil) }
        return try await client.value([String: JSONValue].self, "PATCH", "kuvo/config", body: Changes(changes: sent))
    }
}

/// A computer's engine settings, each computer's own (a box of its own): this Mac's and each
/// machine's, read and changed through its box (`BoxSettings`), which keeps them where its engine
/// reads them as its global configuration and reloads them when they change. Settings edit them
/// in place and keep whatever they don't show, so a hand-edited file loses nothing.
@Observable
final class EngineConfig {
    /// This Mac's settings file, where its box keeps it, to open in an editor or show in Finder;
    /// nil for a machine's, and a draft.
    let file: URL?
    /// Its settings; empty until they're read.
    private(set) var settings: [String: JSONValue] = [:]
    /// Why they can't be changed: they couldn't be read, or the box says its file can't be used
    /// (comments in it), which it leaves alone until it's fixed.
    private(set) var problem: String?
    /// Where they're read and changed; nil for a draft.
    @ObservationIgnored let remote: RemoteSettings?
    /// Read at least once.
    private(set) var isLoaded = false
    /// A change that didn't get there (it's shown as it is there again), until the next one does.
    private(set) var notSaved: String?

    /// Settings kept only here, never written anywhere: something being made (a new agent),
    /// filled in by the same controls, until it's created.
    let isDraft: Bool

    /// A box's, read once it's reached (`took`, `reload`). `file`: this Mac's.
    init(remote: RemoteSettings, file: URL? = nil) {
        self.file = file
        isDraft = false
        self.remote = remote
        if file != nil { Self.current = self }
    }

    init(draft settings: [String: JSONValue]) {
        file = nil
        isDraft = true
        remote = nil
        self.settings = settings
        isLoaded = true
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
    /// own settings: none for one not read yet (this Mac's are read before its engine starts, a
    /// machine's before its engine is reached).
    static func rules(on machine: String?) -> [PermissionRule] {
        guard let config = of(machine), config.isLoaded else { return [] }
        return config.permissionRules
    }

    /// Its settings as they were just read some other way (as a machine's engine is started, or
    /// Also Apply's answer).
    func took(_ read: [String: JSONValue]) {
        guard remote != nil else { return }
        let first = !isLoaded
        reads += 1
        let before = confirmed
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
            if before != read { onChanged() }
        }
    }

    /// Once what's been changed here has reached its box: nil, or why it didn't get there (or
    /// couldn't be made: they couldn't be read).
    func settled() async -> String? {
        guard isSending else { return notSaved ?? problem }
        await withCheckedContinuation { settling.append($0) }
        return notSaved
    }

    @ObservationIgnored private var settling: [CheckedContinuation<Void, Never>] = []

    /// Changed, wherever from (Settings, a phone, the file edited by hand), once its box says so.
    @ObservationIgnored var onChanged: () -> Void = {}
    /// Settings › Permissions' rules changed, wherever from (Settings, a phone, the file edited
    /// by hand). (Each box makes its conversations' rules again with them itself.)
    @ObservationIgnored var onRulesChanged: () -> Void = {}
    /// The rules as they were last, to tell when they change.
    @ObservationIgnored private var rules: JSONValue?

    private func noteRules() {
        guard settings["permissions"] != rules else { return }
        rules = settings["permissions"]
        onRulesChanged()
    }

    /// Bots may change their memory (`Bot.memoryFile`) whatever their conversation's mode: a rule
    /// each box adds to its settings once (`kuvo-link.js`'s defaults).
    static let botMemory = PermissionRule(action: "edit", resource: "*/bots/bot_*/MEMORY.md", effect: .allow)

    /// What this Mac kept of the defaults it added before its box added them (its preferences),
    /// as the box notes them (`defaults-added` in its folder), so one you took out stays out.
    static func defaultsAdded(_ defaults: UserDefaults = .standard) -> [String] {
        [("engine.botMemoryRuleAdded", "bot-memory"), ("engine.defaultsAdded", "websearch"), ("engine.searchMovedToExa", "search-exa")]
            .filter { defaults.bool(forKey: $0.0) }.map(\.1)
    }

    /// What a box answers a change to a list someone changed since it was read (`was`).
    static let changedMeanwhile = "It changed since you read it."

    /// Settings › Permissions' rules, in their order: what every session and mode is held to.
    var permissionRules: [PermissionRule] {
        guard let value = settings["permissions"], let data = try? JSONEncoder().encode(value) else { return [] }
        return (try? JSONDecoder().decode([PermissionRule].self, from: data)) ?? []
    }

    /// Reads them again, after they changed elsewhere, in a moment.
    func reload() {
        guard !isDraft else { return }
        Task { await refresh() }
    }

    /// Reads them again now.
    func refresh() async {
        guard let remote else { return }
        reads += 1
        let read = reads
        do {
            let found = try await remote.read()
            // One read or saved since knows better.
            guard read == reads else { return }
            took(found)
        } catch {
            guard read == reads else { return }
            if let refusal = error as? BoxRefusal, let unusable = refusal.problem {
                // Its box read the file, and it can't be used (comments in it): left alone until
                // it's fixed, and said on its pages, which show what was read before, if anything.
                problem = unusable
                if !isLoaded {
                    isLoaded = true
                    rules = settings["permissions"]
                    onRulesChanged()
                }
            } else if !isLoaded {
                problem = "Its settings couldn't be read: \(error.localizedDescription)"
            }
            // Read before: kept as they were until the next read (a change there is said again),
            // rather than shut for a moment's trouble with the connection.
        }
    }

    /// Read, now if they weren't yet: whether they are.
    func loaded() async -> Bool {
        if !isLoaded { await refresh() }
        return isLoaded
    }

    /// The value at a path of keys: `value(at: ["compaction", "auto"])`.
    func value(at path: [String]) -> JSONValue? {
        Self.value(at: path, in: settings)
    }

    /// Sets the value at a path of keys, or removes it with nil (and any object it leaves
    /// empty), then saves.
    func set(_ value: JSONValue?, at path: [String]) {
        guard problem == nil, isLoaded, !path.isEmpty else { return }
        note(path, from: self.value(at: path), to: value)
        settings = Self.setting(value, at: path[...], in: settings)
        save([(path, value)])
    }

    /// Several changes at once, in one write: the engine reloads its settings once, not after
    /// each of them.
    func set(_ changes: [(path: [String], value: JSONValue?)]) {
        guard problem == nil, isLoaded else { return }
        for change in changes where !change.path.isEmpty {
            note(change.path, from: value(at: change.path), to: change.value)
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

    /// Changes waiting to be sent, and those sent and not answered yet: what's read meanwhile
    /// shows them as they'll be.
    @ObservationIgnored private var pending: [(path: [String], value: JSONValue?)] = []
    @ObservationIgnored private var sent: [(path: [String], value: JSONValue?)] = []
    @ObservationIgnored private var isSending = false
    /// Its settings as its box last said they are (read, or answered with a change).
    @ObservationIgnored private var confirmed: [String: JSONValue] = [:]
    /// Goes up with each read and each answer to a change, so an older read that comes back
    /// later doesn't put back what was before.
    @ObservationIgnored private var reads = 0
    /// The read after a change that didn't get there keeps saying so.
    @ObservationIgnored private var keepsNotice = false

    /// Changes, sent in order, a batch at a time, key by key: what comes back is its settings,
    /// with others' changes to other keys meanwhile. One that doesn't get there shows as it is
    /// there at once; those after it are still sent.
    private func save(_ changes: [(path: [String], value: JSONValue?)]) {
        guard let remote, !isDraft, !changes.isEmpty else { return }
        pending += changes
        guard !isSending else { return }
        isSending = true
        Task {
            while !pending.isEmpty {
                sent = pending
                pending.removeAll()
                let asked = reads
                // A list (Settings › Permissions' rules, skills switched off) goes whole: sent with
                // what it was here, so one a phone changed meanwhile is refused, and said, rather
                // than its change written over.
                let was: [JSONValue?] = sent.map { change in
                    let before = Self.value(at: change.path, in: confirmed)
                    // A list's last item taken away goes too: the list then goes.
                    guard case .array? = change.value ?? before else { return nil }
                    return before ?? .null
                }
                do {
                    let after = try await remote.change(sent, was: was)
                    let before = confirmed
                    // Read since (a phone's change to another key, say): that stays, with what
                    // this change made of its own keys.
                    confirmed = reads == asked ? after : Self.applying(sent.map { ($0.path, Self.value(at: $0.path, in: after)) }, to: confirmed)
                    sent.removeAll()
                    reads += 1
                    settings = Self.applying(pending, to: confirmed)
                    notSaved = nil
                    noteRules()
                    if before != confirmed { onChanged() }
                } catch {
                    notSaved = (error as? BoxRefusal).map { $0.status == 409 && $0.message == Self.changedMeanwhile } == true
                        ? "It was changed elsewhere meanwhile (from your phone, say), so yours wasn't saved. Here it is as it is now: make your change again."
                        : "It couldn't be saved there: \(error.localizedDescription)"
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
}

// MARK: - Reading values

extension JSONValue {
    /// Whole numbers as `Int`: nil for one that isn't whole or doesn't fit.
    var int: Int? { number.flatMap { Int(exactly: $0) } }
}

/// The engine's own agents, on every computer whether its settings name them or not: the ones
/// people pick and hand work to, and the hidden ones that write titles, summaries and compactions.
nonisolated enum BuiltInAgents {
    static let shown = ["build", "plan", "general", "explore"]
    static let hidden: Set = ["compaction", "title", "summary"]

    static func contains(_ id: String) -> Bool { shown.contains(id) || hidden.contains(id) }
}
