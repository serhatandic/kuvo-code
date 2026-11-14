import Foundation

/// What a box's agents made, as its record has it (PROTOCOL.md, "Artifacts"): each file a
/// conversation wrote, edited, made or showed, with a version for each turn that changed it. The
/// Mac and the phone read it alike, from `kuvo/artifacts`.
public struct Artifact: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var path: String
    public var name: String
    public var kind: Kind
    public var type: String
    public var `where`: Where
    public var pinned: Pin?
    /// When it was deleted, in seconds since 1970; its versions stay.
    public var gone: Double?
    /// When an agent last showed it in a panel.
    public var shown: Double?
    /// A document wake-ups keep rewriting: a page kept up to date.
    public var living: Bool?
    /// In a git repository.
    public var git: Bool?
    /// A version of it can be put back (it's in a bot's folder or its project).
    public var restorable: Bool?
    public var updated: Double
    /// Every version, oldest first. (A list has `ArtifactSummary`s, with only the newest.)
    public var versions: [Version]

    public enum Kind: String, Codable, Hashable, Sendable, CaseIterable {
        case memory, skill, image, page, document, download, code, file
        /// One this app doesn't know yet (a newer box's).
        case other

        public init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
        }
    }

    public struct Where: Codable, Hashable, Sendable {
        public var bots: [String]
        public var project: String?
        public var sessions: [String]
        public var groups: [String]
    }

    public struct Pin: Codable, Hashable, Sendable {
        /// "bot" (it marked it final) or "you".
        public var by: String
        public var at: Double
        public var note: String?
    }

    /// The versions that are the file's own, not what it was before the record saw it change.
    public var made: [Version] { versions.filter { $0.before != true } }
}

/// One version of an artifact: what one turn made of it.
public struct ArtifactVersion: Codable, Hashable, Identifiable, Sendable {
    public var n: Int
    public var at: Double
    public var by: Who
    public var turn: Turn?
    public var group: Group?
    public var trigger: String?
    public var via: [String]
    public var status: Status
    public var edits: Int
    public var lines: Lines?
    public var size: Int
    public var hash: String?
    /// Its bytes are kept, so it can be opened and compared.
    public var kept: Bool
    /// Why it has no copy.
    public var reason: NoCopy?
    /// The change its turn's tool calls made, for code git keeps (which has no copy).
    public var patch: String?
    /// It put back this version.
    public var restored: Int?
    /// What the file was before the record first saw it change.
    public var before: Bool?
    public var handoff: Handoff?

    public var id: Int { n }

    /// Whether a client may save or share this version as the file is now, when the box kept no
    /// copy: never what looks like a secret (or a reason this app doesn't know yet); what git
    /// ignores may go, since build outputs are often what you want.
    public var mayLeave: Bool { reason != .secret && reason != .other }

    public enum NoCopy: String, Codable, Hashable, Sendable {
        /// It looks like it holds a secret: never copied, never sent.
        case secret
        /// Git ignores it: never copied; saved or shared only as the file is now (`mayLeave`).
        case ignored
        /// Code git keeps: only its change.
        case git
        case tooBig = "too-big"
        /// The disk was nearly full.
        case lowDisk = "low-disk"
        /// Cleared to keep older versions within the budget.
        case cleared
        /// One this app doesn't know yet.
        case other

        public init(from decoder: Decoder) throws {
            self = NoCopy(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
        }

        /// Why, in a sentence.
        public var words: String {
            switch self {
            case .secret: "It looks like it holds a secret, so no copy is kept."
            case .ignored: "Git ignores it, so no copy is kept."
            case .git: "Git keeps this file’s history: see it in Changes."
            case .tooBig: "It’s too big to keep a copy of."
            case .lowDisk: "The disk was nearly full, so no copy was kept."
            case .cleared, .other: "Its copy was cleared to save space. The newest version is always kept."
            }
        }
    }

    public struct Who: Codable, Hashable, Sendable {
        /// "agent", "you" or "outside".
        public var kind: String
        public var session: String?
        public var bot: String?
        public var agent: String?
    }

    public struct Turn: Codable, Hashable, Sendable {
        public var session: String
        public var message: String?
    }

    public struct Group: Codable, Hashable, Sendable {
        public var id: String
        public var message: String?
    }

    public enum Status: String, Codable, Hashable, Sendable {
        case added, modified, deleted
        /// One this app doesn't know yet (a newer box's): read as a change.
        case other

        public init(from decoder: Decoder) throws {
            self = Status(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
        }
    }

    public struct Lines: Codable, Hashable, Sendable {
        public var added: Int
        public var removed: Int
    }

    public struct Handoff: Codable, Hashable, Sendable {
        public var from: String
    }
}

extension Artifact {
    public typealias Version = ArtifactVersion
}

/// An artifact as a list has it: its newest version, and how many there are.
public struct ArtifactSummary: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var path: String
    public var name: String
    public var kind: Artifact.Kind
    public var type: String
    public var `where`: Artifact.Where
    public var pinned: Artifact.Pin?
    public var gone: Double?
    public var shown: Double?
    public var living: Bool?
    public var git: Bool?
    public var restorable: Bool?
    public var updated: Double
    /// How many versions it has.
    public var versions: Int
    public var latest: ArtifactVersion

    /// Itself without its versions, as a Timeline's entry has it.
    public var header: ArtifactHeader {
        ArtifactHeader(id: id, path: path, name: name, kind: kind, type: type, where: `where`, pinned: pinned, gone: gone, shown: shown, living: living, git: git, restorable: restorable, updated: updated)
    }
}

/// A scope's artifacts, as `kuvo/artifacts` and its events answer.
public struct ArtifactList: Codable, Hashable, Sendable {
    public var artifacts: [ArtifactSummary]
    /// Pass as `before` for older ones (an opaque cursor); nil when there are none.
    public var next: String?

    /// The route of a list of what was made for a conversation, a bot, a group chat or a project.
    public static func path(_ scope: ArtifactScope, events: Bool = false) -> String {
        var query = URLComponents()
        query.queryItems = [scope.item]
        return "kuvo/artifacts" + (events ? "/events" : "") + "?" + (query.percentEncodedQuery ?? "")
    }
}

extension ArtifactList {
    /// This first page as it is now, with the older ones already shown after it kept (Show More
    /// read them): a change to what's newest doesn't take them away again.
    public func keeping(_ shown: [ArtifactSummary]) -> [ArtifactSummary] {
        guard let last = artifacts.last else { return artifacts }
        let first = Set(artifacts.map(\.id))
        return artifacts + shown.filter { !first.contains($0.id) && $0.pinned == nil && $0.updated <= last.updated }
    }
}

extension ArtifactTimeline {
    /// This first page as it is now, with the older entries already shown after it kept.
    public func keeping(_ shown: [Entry]) -> [Entry] {
        guard let last = entries.last else { return entries }
        let first = Set(entries.map(\.id))
        return entries + shown.filter { !first.contains($0.id) && $0.version.at <= last.version.at }
    }
}

/// Every version made in a scope, newest first, each with its artifact (`kuvo/artifacts/timeline`).
public struct ArtifactTimeline: Codable, Hashable, Sendable {
    public struct Entry: Codable, Hashable, Identifiable, Sendable {
        /// Its artifact, without its versions.
        public var artifact: ArtifactHeader
        public var version: ArtifactVersion
        public var id: String { artifact.id + "#\(version.n)" }
    }

    public var entries: [Entry]
    /// Pass as `before` for older ones (an opaque cursor); nil when there are none.
    public var next: String?

    /// `by`: only what this bot made (in a group chat's).
    public static func path(_ scope: ArtifactScope, by bot: String? = nil, events: Bool = false) -> String {
        var query = URLComponents()
        query.queryItems = [scope.item] + (bot.map { [URLQueryItem(name: "by", value: $0)] } ?? [])
        return "kuvo/artifacts/timeline" + (events ? "/events" : "") + "?" + (query.percentEncodedQuery ?? "")
    }
}

/// An artifact without its versions, as a Timeline's entry has it.
public struct ArtifactHeader: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var path: String
    public var name: String
    public var kind: Artifact.Kind
    public var type: String
    public var `where`: Artifact.Where
    public var pinned: Artifact.Pin?
    public var gone: Double?
    public var shown: Double?
    public var living: Bool?
    public var git: Bool?
    public var restorable: Bool?
    public var updated: Double
}

/// What a box keeps of what its agents made (`kuvo/artifacts/storage`), in bytes.
public struct ArtifactStorage: Codable, Hashable, Sendable {
    /// All the copies.
    public var copies: Double
    /// Older versions' copies, which can go.
    public var older: Double
    /// What older versions may take.
    public var budget: Double
    /// The disk's free space, and the floor the record keeps it above.
    public var free: Double
    public var floor: Double
    /// Free space is under the floor: what a new version replaces keeps no copy.
    public var low: Bool
}

/// Whose artifacts: exactly one conversation, bot, group chat or project.
public enum ArtifactScope: Hashable, Sendable {
    case session(String), bot(String), group(String), project(String)

    var item: URLQueryItem {
        switch self {
        case .session(let id): URLQueryItem(name: "session", value: id)
        case .bot(let id): URLQueryItem(name: "bot", value: id)
        case .group(let id): URLQueryItem(name: "group", value: id)
        case .project(let folder): URLQueryItem(name: "project", value: folder)
        }
    }
}

/// What changed between two versions, as the box works it out so every client marks the same words.
public enum ArtifactChanges: Decodable, Hashable, Sendable {
    /// Prose: the newer version's lines, with the words that changed marked.
    case words([Line], added: Int, removed: Int)
    /// Code: a unified diff's hunks.
    case lines(patch: String, added: Int, removed: Int)
    /// Pictures and PDFs, shown side by side from each version's bytes.
    case pair(from: Int?, to: Int)
    case none

    public enum Line: Decodable, Hashable, Sendable {
        case same(String), added(String), removed(String)
        case changed([Run])
        /// A stretch that stayed the same, folded to how many lines it has.
        case folded(Int)

        private enum Keys: String, CodingKey { case kind, text, runs, lines }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Keys.self)
            switch try container.decode(String.self, forKey: .kind) {
            case "added": self = .added(try container.decode(String.self, forKey: .text))
            case "removed": self = .removed(try container.decode(String.self, forKey: .text))
            case "changed": self = .changed(try container.decode([Run].self, forKey: .runs))
            case "folded": self = .folded(try container.decode(Int.self, forKey: .lines))
            default: self = .same((try? container.decode(String.self, forKey: .text)) ?? "")
            }
        }
    }

    /// Words kept, added or removed.
    public struct Run: Decodable, Hashable, Sendable {
        public enum Mark: String, Decodable, Hashable, Sendable {
            case same = " ", added = "+", removed = "-"
        }

        public var mark: Mark
        public var text: String

        private enum Keys: String, CodingKey { case t, text }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Keys.self)
            mark = (try? container.decode(Mark.self, forKey: .t)) ?? .same
            text = try container.decode(String.self, forKey: .text)
        }
    }

    private enum Keys: String, CodingKey { case style, lines, patch, added, removed, from, to }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let added = (try? container.decode(Int.self, forKey: .added)) ?? 0
        let removed = (try? container.decode(Int.self, forKey: .removed)) ?? 0
        switch try container.decode(String.self, forKey: .style) {
        case "words": self = .words(try container.decode([Line].self, forKey: .lines), added: added, removed: removed)
        case "lines": self = .lines(patch: try container.decode(String.self, forKey: .patch), added: added, removed: removed)
        case "pair": self = .pair(from: try container.decodeIfPresent(Int.self, forKey: .from), to: try container.decode(Int.self, forKey: .to))
        default: self = .none
        }
    }
}

/// How the Mac and the phone put what was made into words and sections, alike.
public enum ArtifactWords {
    /// An SF Symbol for its kind.
    public static func symbol(kind: Artifact.Kind, type: String) -> String {
        switch kind {
        case .memory: "brain"
        case .skill: "sparkles"
        case .image: "photo"
        case .page: "safari"
        case .download: "arrow.down.circle"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .document: type == "application/pdf" ? "doc.richtext" : type.hasPrefix("text/csv") || type.contains("spreadsheet") ? "tablecells" : "doc.text"
        case .file, .other: "doc"
        }
    }

    /// Its file's name; a bot's memory as "Ben’s memory" (its bot's name, when known).
    public static func name(_ header: ArtifactHeader, bot: String? = nil) -> String {
        guard header.kind == .memory, header.name == "MEMORY.md" else { return header.name }
        return bot.map { "\($0)’s memory" } ?? "Its memory"
    }

    /// "Wrote it", "Ada changed it", "Made it with a command", "Pixel took it" (a screenshot), "You put back version 3"…
    public static func what(_ version: ArtifactVersion, bot: String? = nil) -> String {
        if version.before == true { return "Before it was changed" }
        if let restored = version.restored { return "You put back version \(restored)" }
        if version.by.kind == "outside" { return version.status == .deleted ? "Deleted outside a conversation" : "Changed outside a conversation" }
        if version.by.kind == "you" { return version.status == .deleted ? "You deleted it" : "You changed it" }
        let verb: String
        switch version.status {
        case .deleted: verb = "deleted it"
        case .added:
            verb = version.via.contains("generate_image") ? "made it"
                : version.via.contains("browser_screenshot") ? "took it"
                : version.via.contains("download") ? "downloaded it"
                : version.via.contains("shell") ? "made it with a command"
                : "wrote it"
        case .modified, .other: verb = version.edits > 1 ? "changed it \(version.edits) times" : "changed it"
        }
        let sentence = (bot.map { $0 + " " } ?? "") + verb
        return sentence.prefix(1).uppercased() + sentence.dropFirst()
    }

    /// What a deletion's version says in place of the file: to step back where an earlier version's
    /// copy is kept, and plainly that none was where it isn't (one made and removed before a copy).
    public static func deleted(_ version: ArtifactVersion, in versions: [ArtifactVersion]) -> String {
        let earlier = versions.contains { $0.n < version.n && $0.kept && $0.status != .deleted }
        return earlier ? "It was deleted in this version. Step back to see what it was." : "It was deleted in this version. No earlier copy of it was kept."
    }

    /// "Today, 9:00", "Yesterday, 18:40", "12 Oct, 9:00".
    public static func when(_ seconds: Double) -> String {
        day(Date(timeIntervalSince1970: seconds)) + ", " + time(seconds)
    }

    /// "9:00", for a list already under its day.
    public static func time(_ seconds: Double) -> String {
        Date(timeIntervalSince1970: seconds).formatted(date: .omitted, time: .shortened)
    }

    public static func day(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// A Shelf's sections, in order: what's kept first (what you keep, and what its bot marked
    /// final), then memory, pages (and documents wake-ups keep rewriting), documents, images,
    /// skills, downloads, and the rest last.
    public enum Section: String, CaseIterable, Sendable {
        case pinned = "Kept", memory = "Memory", pages = "Pages", documents = "Documents", images = "Images", skills = "Skills", downloads = "Downloads", other = "Other Files"
    }

    /// What's kept reads as: "Final" for what its bot marked final (with its note), "Kept" for yours.
    public static func mark(_ pin: Artifact.Pin) -> String {
        pin.by == "bot" ? "Final" : "Kept"
    }

    /// Keeping something (`kuvo/artifacts/<id>/pin`): the button's words, its symbol and its help,
    /// before and after.
    public static let keep = (title: "Keep", symbol: "star", help: "Keep this and all its versions, at the top")
    public static let kept = (title: "Kept", symbol: "star.fill", help: "Stop Keeping")

    public static func section(of artifact: ArtifactSummary) -> Section {
        if artifact.pinned != nil { return .pinned }
        switch artifact.kind {
        case .memory: return .memory
        case .page: return .pages
        case .document: return artifact.living == true ? .pages : .documents
        case .image: return .images
        case .skill: return .skills
        case .download: return .downloads
        case .code, .file, .other: return .other
        }
    }

    /// The bot's own job (`job.json`), which it rewrites as you tell it more: not something it
    /// made, so it neither shows on the Shelf nor counts as new.
    public static func isJob(_ artifact: ArtifactSummary) -> Bool {
        artifact.kind == .memory && artifact.name == "job.json"
    }

    /// When the newest thing among these was made or changed, for the dot that says there's
    /// something new: never the bot's job (`isJob`), which changes as you tell it more.
    public static func newest(_ artifacts: [ArtifactSummary]) -> Double {
        artifacts.filter { !isJob($0) }.map(\.updated).max() ?? 0
    }

    /// The Shelf: each section with what's in it (none empty), newest first, memory's own file first.
    /// Not the bot's job (`isJob`): that's the bot, not something it made; its Timeline keeps it.
    public static func shelf(_ artifacts: [ArtifactSummary]) -> [(section: Section, artifacts: [ArtifactSummary])] {
        let grouped = Dictionary(grouping: artifacts.filter { !isJob($0) }, by: section(of:))
        return Section.allCases.compactMap { section in
            guard var items = grouped[section], !items.isEmpty else { return nil }
            items.sort { a, b in
                if section == .memory, (a.name == "MEMORY.md") != (b.name == "MEMORY.md") { return a.name == "MEMORY.md" }
                return a.updated > b.updated
            }
            return (section, items)
        }
    }

    /// What a coding session shows of what it made: not its code (that's Changes), nor documents
    /// git keeps there, nor builds' output; but anything it showed you or pinned.
    public static func isOutput(_ artifact: ArtifactSummary) -> Bool {
        if artifact.pinned != nil || artifact.shown != nil { return true }
        switch artifact.kind {
        case .image, .page, .download, .skill: return true
        case .document: return artifact.git != true
        case .memory, .code, .file, .other: return false
        }
    }
}
