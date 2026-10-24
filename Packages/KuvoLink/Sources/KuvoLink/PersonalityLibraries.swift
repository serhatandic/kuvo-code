import Foundation

/// The personalities you make are one library on every computer: each keeps its copy, and copies
/// meet box to box and as a Mac connects to a machine (PROTOCOL.md, "Personalities"). Per
/// personality a removal wins over any change, and stays noted, so no copy brings it back;
/// otherwise the newest change, by a count each change moves on from the one before it (`updated`),
/// whatever any clock says, and at the same count the words that sort last, so every copy picks the
/// same.
/// The same rules as the bridge's `mergePersonalities`, held to `Vectors/personalities.json`.
public enum PersonalityLibraries {
    /// One you made, as a copy keeps it.
    public struct Kept: Codable, Hashable, Sendable {
        public var id: String
        public var name: String
        public var description: String
        public var symbol: String
        /// When it was made or last changed, in milliseconds since 1970.
        public var updated: Double

        public init(id: String, name: String, description: String, symbol: String, updated: Double) {
            self.id = id
            self.name = name
            self.description = description
            self.symbol = symbol
            self.updated = updated
        }
    }

    /// One removed, and when.
    public struct Removal: Codable, Hashable, Sendable {
        public var id: String
        public var removed: Double

        public init(id: String, removed: Double) {
            self.id = id
            self.removed = removed
        }
    }

    public struct Library: Codable, Equatable, Sendable {
        public var personalities: [Kept]
        public var removed: [Removal]

        public init(personalities: [Kept] = [], removed: [Removal] = []) {
            self.personalities = personalities
            self.removed = removed
        }
    }

    /// Removals noted, the newest kept.
    public static let mostRemovals = 500
    /// A change's count no higher than this, so the next one is always higher; one past it isn't taken.
    public static let mostCount: Double = 4_503_599_627_370_496

    /// One as every copy keeps it, as the bridge's `keptPersonality` does: an ID of one you made,
    /// a name on one line (80 characters at most), words trimmed (2,000 at most), a symbol; nil
    /// for what isn't one.
    public static func cleaned(_ kept: Kept) -> Kept? {
        guard kept.id.range(of: #"\Acustom\.[A-Za-z0-9._-]{1,80}\z"#, options: .regularExpression) != nil else { return nil }
        let name = utf16Prefix(plain(kept.name), 80)
        let description = utf16Prefix(kept.description.trimmingCharacters(in: .whitespacesAndNewlines), 2000)
        guard !name.isEmpty, !description.isEmpty else { return nil }
        let symbol = kept.symbol.isEmpty ? "person.crop.circle" : utf16Prefix(kept.symbol, 80)
        return Kept(id: kept.id, name: name, description: description, symbol: symbol, updated: kept.updated)
    }

    /// A name as one line of plain text: what isn't text (control and direction marks) a space,
    /// runs of space one.
    public static func plain(_ text: String) -> String {
        let marks = Set<Unicode.Scalar>((0x00...0x1F).compactMap(Unicode.Scalar.init) + [Unicode.Scalar(0x7F)!, "\u{200E}", "\u{200F}"]
            + (0x202A...0x202E).compactMap(Unicode.Scalar.init) + (0x2066...0x2069).compactMap(Unicode.Scalar.init))
        let spaced = String(String.UnicodeScalarView(text.unicodeScalars.map { marks.contains($0) ? " " : $0 }))
        return spaced.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// At most `count` UTF-16 units, as JavaScript's `slice` cuts.
    private static func utf16Prefix(_ text: String, _ count: Int) -> String {
        guard text.utf16.count > count else { return text }
        return String(decoding: Array(text.utf16.prefix(count)), as: UTF16.self)
    }

    /// Libraries as one, in the order their personalities were first seen. Kuvo Code's presets,
    /// and one without a name or words, aren't in it.
    public static func merged(_ libraries: [Library]) -> Library {
        enum Take { case kept(Kept), gone(Removal) }
        func time(_ take: Take) -> Double {
            switch take {
            case .kept(let kept): kept.updated
            case .gone(let removal): removal.removed
            }
        }
        func newer(_ a: Take, _ b: Take) -> Take {
            switch (a, b) {
            case (.gone, .kept): return a
            case (.kept, .gone): return b
            case (.gone, .gone): return time(a) >= time(b) ? a : b
            case (.kept(let x), .kept(let y)):
                if x.updated != y.updated { return x.updated > y.updated ? a : b }
                // As the bridge compares them: by UTF-16 code unit.
                return (x.name + "\n" + x.description).utf16.lexicographicallyPrecedes((y.name + "\n" + y.description).utf16) ? b : a
            }
        }
        var order: [String] = []
        var byID: [String: Take] = [:]
        func meet(_ take: Take, id: String) {
            guard id.hasPrefix("custom."), id.count > "custom.".count else { return }
            if let had = byID[id] {
                byID[id] = newer(had, take)
            } else {
                order.append(id)
                byID[id] = take
            }
        }
        for library in libraries {
            for kept in library.personalities.compactMap(cleaned) where kept.updated <= mostCount { meet(.kept(kept), id: kept.id) }
            for removal in library.removed where removal.removed <= mostCount { meet(.gone(removal), id: removal.id) }
        }
        var met = Library()
        for id in order {
            switch byID[id] {
            case .kept(let kept)?: met.personalities.append(kept)
            case .gone(let removal)?: met.removed.append(removal)
            case nil: break
            }
        }
        met.removed = Array(met.removed.sorted { $0.removed > $1.removed }.prefix(mostRemovals))
        return met
    }
}
