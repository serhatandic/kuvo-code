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

/// The personalities to pick from: Kuvo Code's own, then ones you made, kept in
/// `personalities.json`. The ones you make are one library on every computer: each keeps its copy
/// (a machine's in `~/.kuvo-code/bots`), and copies meet box to box (each one's view is a document
/// of its own, PROTOCOL.md "Documents") and as this Mac connects to a machine: per personality a
/// removal wins, and stays noted (`personalities-removed.json`) so no copy brings it back;
/// otherwise the change counted highest (`PersonalityLibraries`, the same rules as a machine's).
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
    private let file: URL
    private let removedFile: URL
    /// A change made here (not taken from another computer's copy): the copies there take it.
    @ObservationIgnored var onChange: () -> Void = {}

    private convenience init() {
        self.init(folder: AppInfo.supportDirectory)
    }

    init(folder: URL) {
        file = folder.appending(path: "personalities.json")
        removedFile = folder.appending(path: "personalities-removed.json")
        // One made before the library: as old as can be, so any copy's change wins over it.
        custom = (JSONFile.read([Personality].self, from: file) ?? []).map { kept in
            var personality = kept
            personality.updated = kept.updated ?? 0
            return personality
        }
        removed = (JSONFile.read([Removal].self, from: removedFile) ?? []).sorted { $0.removed > $1.removed }
    }

    var all: [Personality] { Self.presets + custom }

    var library: Library { Library(personalities: custom, removed: removed) }

    func personality(_ id: String?) -> Personality? {
        id.flatMap { id in all.first { $0.id == id } }
    }

    private static var now: Double { (Date.now.timeIntervalSince1970 * 1000).rounded() }

    /// Your personalities are one document on every computer, which holds so much: a change past that
    /// is refused, here as on a machine.
    struct NoRoom: LocalizedError {
        var errorDescription: String? { "There’s no room for more in your personalities. Shorten or remove one, then try again." }
    }

    /// Whether `library` fits in the document every computer copies.
    private static func fits(_ library: Library) -> Bool {
        let met = merged([library])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return ((try? encoder.encode(met))?.count ?? .max) <= Documents.mostBody
    }

    func add(name: String, description: String) throws -> Personality {
        // As every copy keeps it (one shared without words, from a bot's file, says its name).
        let id = "custom." + UUID().uuidString.lowercased()
        let words = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleaned = PersonalityLibraries.cleaned(.init(id: id, name: name, description: words.isEmpty ? name : words, symbol: "person.crop.circle", updated: Self.now))
        let personality = Personality(id: id, name: cleaned?.name ?? name, description: cleaned?.description ?? description, symbol: "person.crop.circle", updated: Self.now)
        guard Self.fits(Library(personalities: custom + [personality], removed: removed)) else { throw NoRoom() }
        custom.append(personality)
        save()
        onChange()
        return personality
    }

    func update(_ personality: Personality) throws {
        guard let index = custom.firstIndex(where: { $0.id == personality.id }) else { return }
        var changed = personality
        // Counted on from the one it replaces, whatever this Mac's clock says.
        changed.updated = (custom[index].updated ?? 0) + 1
        var after = custom
        after[index] = changed
        guard Self.fits(Library(personalities: after, removed: removed)) else { throw NoRoom() }
        custom = after
        save()
        onChange()
    }

    func delete(_ personality: Personality) {
        guard let kept = custom.first(where: { $0.id == personality.id }) else { return }
        custom.removeAll { $0.id == personality.id }
        // Newest first, as every copy keeps them.
        removed.insert(Removal(id: personality.id, removed: (kept.updated ?? 0) + 1), at: 0)
        save()
        onChange()
    }

    /// Another computer's copy, met with this one: the IDs of those that changed here.
    @discardableResult
    func take(_ other: Library) -> Set<String> {
        let met = Self.merged([library, other])
        guard met != library else { return [] }
        let before = Dictionary(custom.map { ($0.id, $0) }) { first, _ in first }
        let after = Dictionary(met.personalities.map { ($0.id, $0) }) { first, _ in first }
        let changed = Set(before.keys).union(after.keys).filter { before[$0] != after[$0] }
        custom = met.personalities
        removed = met.removed
        save()
        return changed
    }

    private func save() {
        JSONFile.write(custom, to: file, readable: true)
        JSONFile.write(removed, to: removedFile, readable: true)
    }

    // MARK: Meeting

    /// Libraries as one (`PersonalityLibraries`, the rules every copy keeps to).
    static func merged(_ libraries: [Library]) -> Library {
        let met = PersonalityLibraries.merged(libraries.map { library in
            PersonalityLibraries.Library(
                personalities: library.personalities.map { .init(id: $0.id, name: $0.name, description: $0.description, symbol: $0.symbol, updated: $0.updated ?? 0) },
                removed: library.removed.map { .init(id: $0.id, removed: $0.removed) })
        })
        return Library(
            personalities: met.personalities.map { Personality(id: $0.id, name: $0.name, description: $0.description, symbol: $0.symbol, updated: $0.updated) },
            removed: met.removed.map { Removal(id: $0.id, removed: $0.removed) })
    }
}
