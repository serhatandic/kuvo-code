import Foundation
import KuvoLink

/// How a bot talks. The same words tell you what it's like and tell the bot how to be.
struct Personality: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var description: String
    /// An SF Symbol for its tile.
    var symbol: String
    /// For the library's copies to meet by: when it was made (milliseconds since 1970), counted on by
    /// one with each change (one you made: Kuvo Code's own have none).
    var updated: Double?

    var isCustom: Bool { !id.hasPrefix("preset.") }

    /// What a bot is told, with its name and description in place of ⟦name⟧ and ⟦description⟧
    /// (a machine words a personality made there the same way).
    static let words = "Your personality: ⟦name⟧. ⟦description⟧ Let it show in how you write, not in what you do or how carefully you work."

    /// What the bot is told.
    var instruction: String {
        Self.words.replacingOccurrences(of: "⟦name⟧", with: name).replacingOccurrences(of: "⟦description⟧", with: description)
    }
}

/// The personalities to pick from: Kuvo Code's own, then ones you made. The ones you make are one
/// library on every computer, which each computer's box keeps (`kuvo/personalities`, in its bots
/// folder: this Mac's beside its bots, a machine's in `~/.kuvo-code/bots`), and copies meet box to
/// box (each one's view is a document of its own, PROTOCOL.md "Documents") and as this Mac connects
/// to a machine: per personality a removal wins, and stays noted so no copy brings it back;
/// otherwise the change counted highest. This keeps this Mac's box's library as it last said it
/// (`follow`), for what reads it at once (the picker, bots' instructions), and changes it there.
@Observable
final class Personalities {
    static let shared = Personalities()

    static let presets: [Personality] = [
        Personality(id: "preset.straight", name: "Straight Shooter", description: "Direct and brief. Leads with the answer, skips the pleasantries, and says plainly when something's wrong.", symbol: "bolt"),
        Personality(id: "preset.cheerful", name: "Cheerleader", description: "Warm and upbeat. Celebrates progress and keeps spirits up, while staying honest about problems.", symbol: "sparkles"),
        Personality(id: "preset.mentor", name: "Mentor", description: "Patient and clear. Explains the why behind things, step by step, and points out what's worth learning.", symbol: "graduationcap"),
        Personality(id: "preset.skeptic", name: "Skeptic", description: "Questions assumptions and looks for what could go wrong. Wants evidence before agreeing, and says so when an idea won't hold.", symbol: "magnifyingglass"),
        Personality(id: "preset.pragmatist", name: "Pragmatist", description: "Gets things shipped. Prefers the simplest thing that works, names the tradeoffs, and leaves polish for later.", symbol: "hammer"),
        Personality(id: "preset.perfectionist", name: "Perfectionist", description: "Careful and thorough. Checks the edge cases, double-checks the facts, and won't call something done until it is.", symbol: "checkmark.seal"),
        Personality(id: "preset.visionary", name: "Visionary", description: "Thinks big. Connects the work to where it's going, proposes bold ideas, and names the first small step.", symbol: "lightbulb"),
        Personality(id: "preset.dry", name: "Dry Wit", description: "Calm, with a dry sense of humor. Understated and to the point, and never silly about serious things.", symbol: "theatermasks"),
    ]

    /// A personality removed, and when.
    struct Removal: Codable, Hashable {
        var id: String
        var removed: Double
    }

    /// The ones you made, and those removed: what copies on other computers meet.
    struct Library: Codable, Equatable {
        var personalities: [Personality] = []
        var removed: [Removal] = []
    }

    private(set) var custom: [Personality] = []
    private(set) var removed: [Removal] = []
    /// This Mac's box, where the library is kept.
    @ObservationIgnored var box: () -> BoxClient? = { nil }
    /// Its library changed (made, changed or removed here, from a phone, or taken from another
    /// computer's copy): those that changed, by ID.
    @ObservationIgnored var onChange: (Set<String>) -> Void = { _ in }

    var all: [Personality] { Self.presets + custom }

    var library: Library { Library(personalities: custom, removed: removed) }

    func personality(_ id: String?) -> Personality? {
        id.flatMap { id in all.first { $0.id == id } }
    }

    struct Unreachable: LocalizedError {
        var errorDescription: String? { "Kuvo Code’s background service on this Mac isn’t running. Try again in a moment." }
    }

    private func client() throws -> BoxClient {
        guard let client = box() else { throw Unreachable() }
        return client
    }

    /// The box's library as it is now, in place of this one: what changed, told.
    @discardableResult
    func refresh() async -> Set<String> {
        guard let client = box(), let now = try? await client.value(Library.self, "GET", "kuvo/personalities/document") else { return [] }
        return apply(now)
    }

    /// `now` in place of the library as it was: what changed, by ID, told.
    @discardableResult
    private func apply(_ now: Library) -> Set<String> {
        guard now != library else { return [] }
        let before = Dictionary(custom.map { ($0.id, $0) }) { first, _ in first }
        let after = Dictionary(now.personalities.map { ($0.id, $0) }) { first, _ in first }
        let changed = Set(before.keys).union(after.keys).filter { before[$0] != after[$0] }
        custom = now.personalities
        removed = now.removed
        if !changed.isEmpty { onChange(changed) }
        return changed
    }

    /// The library as this Mac's box keeps it, from now on (`kuvo/personalities/events`): a change
    /// from Edit Bot, a phone or another computer shows, and is told, as it happens.
    func follow() async {
        while !Task.isCancelled {
            if let client = box() {
                do {
                    for try await _ in client.follow("kuvo/personalities/events") { await refresh() }
                } catch {}
            }
            // Its box started again, or isn't up yet: followed again in a moment.
            try? await Task.sleep(for: .seconds(2))
        }
    }

    func add(name: String, description: String) async throws -> Personality {
        let words = description.trimmingCharacters(in: .whitespacesAndNewlines)
        struct Making: Encodable { var name: String; var description: String }
        let made = try await client().value(Personality.self, "POST", "kuvo/personalities", body: Making(name: name, description: words.isEmpty ? name : words))
        await refresh()
        return made
    }

    func update(_ personality: Personality) async throws {
        struct Changing: Encodable { var name: String; var description: String }
        let _: Personality = try await client().value(Personality.self, "PATCH", Self.path(personality.id), body: Changing(name: personality.name, description: personality.description))
        await refresh()
    }

    func delete(_ personality: Personality) async throws {
        let (status, data) = try await client().send("DELETE", Self.path(personality.id))
        // Gone already: as asked.
        guard (200..<300).contains(status) || status == 404 else { throw BoxRefusal(status: status, data: data) }
        await refresh()
    }

    /// Another computer's copy, met with this one where it's kept: the IDs of those that changed here.
    @discardableResult
    func take(_ other: Library) async -> Set<String> {
        await taken(other) ?? []
    }

    /// `take`, nil when the box couldn't take it.
    private func taken(_ other: Library) async -> Set<String>? {
        struct Taking: Encodable { var document: Library }
        struct Taken: Decodable { var changed: [String] }
        guard let client = box(), (try? await client.value(Taken.self, "POST", "kuvo/personalities/take", body: Taking(document: other))) != nil else { return nil }
        return await refresh()
    }

    private static func path(_ id: String) -> String {
        "kuvo/personalities/" + (id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)
    }

    // MARK: Moving to the box

    /// Where Kuvo Code kept them before its box did (0.8.0 betas): a copy stays there, so going back
    /// to one finds them; what one changed there is taken in again as this one starts.
    private static var oldFile: URL { AppInfo.supportDirectory.appending(path: "personalities.json") }
    private static var oldRemovedFile: URL { AppInfo.supportDirectory.appending(path: "personalities-removed.json") }
    /// Where this Mac's box keeps them (`KUVO_BOTS`).
    static var boxFile: URL { Bots.root.appending(path: "personalities.json") }
    /// When the old files were last taken in (their latest change then).
    private static let takenKey = "personalities.takenFromOld"

    /// The old files' latest change, nil when there are none.
    private static var oldChanged: Date? {
        [oldFile, oldRemovedFile].compactMap { (try? FileManager.default.attributesOfItem(atPath: $0.path))?[.modificationDate] as? Date }.max()
    }

    /// The old files as a library, a personality made before the library as old as can be.
    private static var oldLibrary: Library {
        let personalities = (JSONFile.read([Personality].self, from: oldFile) ?? []).map { kept in
            var personality = kept
            personality.updated = kept.updated ?? 0
            return personality
        }
        return Library(personalities: personalities, removed: JSONFile.read([Removal].self, from: oldRemovedFile) ?? [])
    }

    /// Before this Mac's box starts: the old files as its library, where it keeps it, if it has
    /// none yet (they stay where they were).
    static func moveToBox() {
        guard let changed = oldChanged, !FileManager.default.fileExists(atPath: boxFile.path) else { return }
        struct Kept: Encodable { var kuvo = 1; var personalities: [Personality]; var removed: [Removal] }
        let old = oldLibrary
        try? FileManager.default.createDirectory(at: boxFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(Kept(personalities: old.personalities, removed: old.removed)),
              (try? data.write(to: boxFile, options: .atomic)) != nil else { return }
        UserDefaults.standard.set(changed.timeIntervalSince1970, forKey: takenKey)
    }

    /// Once this Mac's box is up: what a 0.8.0 beta changed in the old files since they were last
    /// taken in, met with the box's library.
    func takeFromOld() async {
        guard let changed = Self.oldChanged, changed.timeIntervalSince1970 > UserDefaults.standard.double(forKey: Self.takenKey) else { return }
        // Not taken (the box away): tried again at the next start.
        guard await taken(Self.oldLibrary) != nil else { return }
        UserDefaults.standard.set(changed.timeIntervalSince1970, forKey: Self.takenKey)
    }
}
