import Foundation
import OpenCodeKit

/// Settings › Skills on one box, as every client has it (PROTOCOL.md, "Skills"): the box's skills
/// folder and which of its skills came from GitHub, writing and putting away the skills you add
/// there, and adding one from GitHub, which the box fetches itself. All through the box's routes
/// (`BoxClient`), this Mac's as a machine's.
///
/// GitHub's collections are browsed through this Mac's own box (`library`), whichever box the page
/// is for: what a collection has is the same from anywhere, and a machine's is reached over SSH.
struct BoxSkills {
    /// The box the page is for.
    let box: BoxClient
    /// This Mac's box, which reaches GitHub for the page.
    let library: BoxClient

    /// The box's skills folder, as its engine names skills in it, the folders in it (a new skill
    /// can't take their names), and the skills in it from GitHub.
    struct Folder: Decodable {
        var folder: String
        var folders: [String]
        var github: [String: SkillSource]
    }

    func folder() async throws -> Folder {
        try await box.value(Folder.self, "GET", "kuvo/skills")
    }

    /// A skill's SKILL.md, as it's written.
    func text(of name: String) async throws -> String {
        struct Text: Decodable { var text: String }
        return try await box.value(Text.self, "GET", "kuvo/skills/" + Self.part(name)).text
    }

    /// Writes a skill's SKILL.md: `isNew`, one that mustn't take another's name (the box says so).
    func write(_ name: String, _ text: String, isNew: Bool) async throws {
        struct Written: Encodable { var text: String; var new: Bool? }
        _ = try await box.value(Empty.self, "PUT", "kuvo/skills/" + Self.part(name), body: Written(text: text, new: isNew ? true : nil))
    }

    /// Puts a skill's folder away, in the box's Recently Deleted.
    func remove(_ name: String) async throws {
        _ = try await box.value(Empty.self, "DELETE", "kuvo/skills/" + Self.part(name))
    }

    /// Whether the box has Recently Deleted, as its `kuvo/info` says (`skills.trash`). This Mac's
    /// always has: it's the one the app brings.
    func offersRecentlyDeleted() async throws -> Bool {
        if BoxClient.hasEveryFeature(box.box) { return true }
        struct Info: Decodable { var features: [String]? }
        return try await box.value(Info.self, "GET", "kuvo/info").features?.contains("skills.trash") == true
    }

    /// The box's Recently Deleted, newest first.
    func deleted() async throws -> [DeletedSkill] {
        struct Listed: Decodable { var entries: [DeletedSkill] }
        return try await box.value(Listed.self, "GET", "kuvo/skill-trash").entries
    }

    /// Puts a skill from Recently Deleted back, under its folder's name; the box refuses (409) when
    /// a skill has that name now.
    func restore(_ entry: DeletedSkill) async throws {
        struct Restored: Decodable { var name: String }
        _ = try await box.value(Restored.self, "POST", "kuvo/skill-trash/" + Self.part(entry.id) + "/restore")
    }

    /// Adds a skill from GitHub to the box, under its folder's name.
    func add(_ skill: CollectionSkill, from collection: SkillCollection) async throws {
        struct Install: Encodable { var repository: String; var path: String }
        struct Installed: Decodable { var name: String }
        _ = try await box.value(Installed.self, "POST", "kuvo/skill-library/install", body: Install(repository: collection.id, path: skill.path))
    }

    // MARK: GitHub's collections

    /// The well-known collections, roughly most popular first.
    func collections() async throws -> [SkillCollection] {
        struct Listed: Decodable { var repositories: [SkillCollection] }
        return try await library.value(Listed.self, "GET", "kuvo/skill-library").repositories
    }

    /// A collection's skills, each with what it says it is: one of the well-known ones, or any repository on GitHub, by its
    /// name ("owner/name") or its address there.
    func listing(_ typed: String) async throws -> CollectionListing {
        var name = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["https://github.com/", "http://github.com/", "github.com/"] where name.hasPrefix(prefix) { name.removeFirst(prefix.count) }
        let parts = name.split(separator: "/").prefix(2).map(String.init)
        guard parts.count == 2 else { throw BoxRefusal(status: 404, message: "\(typed) wasn’t found on GitHub.") }
        return try await library.value(CollectionListing.self, "GET", "kuvo/skill-library/\(Self.part(parts[0]))/\(Self.part(parts[1]))")
    }

    private struct Empty: Decodable {}

    /// A part of a route's path, read back exactly as it's named.
    private static func part(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")) ?? text
    }
}

/// A skill in its box's Recently Deleted (PROTOCOL.md, "Skills"), as the box says it is: kept 30
/// days from when it was deleted, which the box decides.
struct DeletedSkill: Decodable, Hashable, Identifiable {
    /// The entry, as the box names it.
    var id: String
    /// The folder's name it goes back under.
    var folder: String
    /// What its SKILL.md says it is.
    var name: String
    var description: String?
    /// When it was deleted, and when the box clears it, in seconds since 1970.
    var deleted: Double
    var goes: Double

    /// "Deleted 3 days ago · goes in 27 days", as of `now`, in calendar days: one deleted last
    /// night was deleted yesterday.
    func when(now: Date = .now, calendar: Calendar = .current) -> String {
        let today = calendar.startOfDay(for: now)
        let days = { (date: Double) in
            calendar.dateComponents([.day], from: today, to: calendar.startOfDay(for: Date(timeIntervalSince1970: date))).day ?? 0
        }
        let since = switch -days(deleted) {
        case ...0: "Deleted today"
        case 1: "Deleted yesterday"
        case let ago: "Deleted \(ago) days ago"
        }
        let until = switch days(goes) {
        case ...0: "goes today"
        case 1: "goes tomorrow"
        case let left: "goes in \(left) days"
        }
        return "\(since) · \(until)"
    }
}

/// Settings › Skills' Recently Deleted for one box: what the box lists, and restoring from it. The
/// box decides what's kept and what can be restored; this shows what it says.
@MainActor @Observable
final class RecentlyDeletedSkills {
    let routes: BoxSkills
    /// Newest first; nil until the box has listed them.
    private(set) var entries: [DeletedSkill]?
    /// Why the box couldn't list them.
    private(set) var failure: String?
    /// Why the box didn't restore one, by entry: the entry stays, with this under it.
    private(set) var refusals: [String: String] = [:]
    /// The entry being restored.
    private(set) var restoring: String?
    /// Whether the box has Recently Deleted (`skills.trash`); nil until it's said.
    private(set) var isOffered: Bool?

    /// What deleting a skill says becomes of it, on a box with Recently Deleted or one without.
    static func deletionNote(recentlyDeleted: Bool) -> String {
        recentlyDeleted
            ? "Its folder, with anything else in it, is kept for 30 days in Recently Deleted, where you can restore it."
            : "Its folder, with anything else in it, is put away in Kuvo Code’s trash for 30 days."
    }

    init(routes: BoxSkills) {
        self.routes = routes
    }

    /// Lists them again, as the box has them now.
    func load() async {
        do {
            // A box from before Recently Deleted (bridge 0.9.43 to 0.9.47) keeps a deleted skill in
            // its trash without offering it back: it has none to show.
            if isOffered == nil { isOffered = try await routes.offersRecentlyDeleted() }
            guard isOffered == true else {
                entries = []
                failure = nil
                return
            }
            let listed = try await routes.deleted()
            entries = listed
            failure = nil
            // A refusal stays with its entry while it's there.
            refusals = refusals.filter { id, _ in listed.contains { $0.id == id } }
        } catch {
            failure = error.localizedDescription
        }
    }

    /// Puts one back. True once it's back where it was.
    @discardableResult
    func restore(_ entry: DeletedSkill) async -> Bool {
        guard restoring == nil else { return false }
        restoring = entry.id
        refusals[entry.id] = nil
        defer { restoring = nil }
        do {
            try await routes.restore(entry)
            await load()
            return true
        } catch {
            refusals[entry.id] = error.localizedDescription
            await load()
            return false
        }
    }
}

/// What Settings › Skills says of each skill its box's engine lists: where it's from, and whether
/// it's one you wrote there, to edit.
struct SkillsShown {
    /// The box's skills folder, as its engine names skills in it; nil until the box has said.
    var folder: String?
    /// Those added from GitHub, by their folder's name.
    var github: [String: SkillSource] = [:]
    /// The folders in it, listed by its engine or not.
    var folders: [String] = []

    init() {}

    init(_ read: BoxSkills.Folder) {
        folder = read.folder
        folders = read.folders
        github = read.github
    }

    /// The names a new skill can't take: those the engine lists, and the folders there.
    func taken(listed skills: [Skill]) -> Set<String> {
        Set(skills.map(\.id)).union(folders)
    }

    /// In the skills folder there.
    private func isHere(_ path: String?) -> Bool {
        guard let path, let folder else { return false }
        return path.hasPrefix(folder + "/")
    }

    /// The folder in the skills folder a skill is in, as the box names it (its name inside its
    /// SKILL.md can differ); nil for one elsewhere.
    func folder(of skill: Skill) -> String? {
        guard isHere(skill.path), let folder, let path = skill.path else { return nil }
        return path.dropFirst(folder.count + 1).split(separator: "/").first.map(String.init)
    }

    /// Where it came from on GitHub, for one added from there.
    func gitHub(_ skill: Skill) -> SkillSource? {
        folder(of: skill).flatMap { github[$0] }
    }

    /// One you wrote there, rather than added from GitHub or found elsewhere.
    func isYours(_ skill: Skill) -> Bool {
        isHere(skill.path) && gitHub(skill) == nil
    }

    /// The engine's list as the box has the skills folder now: one whose folder it just took
    /// away isn't there any more, though the engine lists it a moment longer.
    func current(_ listed: [Skill]) -> [Skill] {
        listed.filter { skill in folder(of: skill).map(folders.contains) ?? true }
    }

    /// The box's folders the engine doesn't list yet (one just added or written).
    func unlisted(_ listed: [Skill]) -> [String] {
        let named = Set(listed.compactMap(folder(of:)))
        return folders.filter { !named.contains($0) && !$0.hasPrefix(".") }
    }

    /// Where a skill comes from, when that's short to say: built in, added there, or the GitHub
    /// repository it came from. One found in a folder (~/.claude/skills) goes without.
    func source(of skill: Skill) -> String? {
        if let source = gitHub(skill) { return source.repository }
        guard let path = skill.path else { return nil }
        if path.hasPrefix("/builtin/") { return "Built in" }
        if isHere(path) { return "Added here" }
        return nil
    }

    /// The folder a skill found elsewhere is in, for its row's tip.
    func place(of skill: Skill) -> String? {
        guard source(of: skill) == nil, let path = skill.path else { return nil }
        return (path as NSString).abbreviatingWithTildeInPath
            .components(separatedBy: "/").dropLast(2).joined(separator: "/")
    }
}

/// A repository of skills on GitHub.
struct SkillCollection: Codable, Hashable, Identifiable {
    /// "owner/name".
    var id: String
    var owner: String
    var name: String
    var title: String
    var summary: String

    var webURL: URL { URL(string: "https://github.com/\(owner)/\(name)")! }
}

/// A skill in a collection: the folder its SKILL.md is in.
struct CollectionSkill: Codable, Hashable, Identifiable {
    /// The name it's added under: its folder's.
    var name: String
    /// The folder in the repository, like `skills/pdf` ("" for a repository that's one skill).
    var path: String
    /// Every file in it, relative to the repository.
    var files: [String]
    /// What its SKILL.md says it is.
    var about: SkillAbout?

    /// Unique in its repository; two folders can share a name.
    var id: String { path }

    /// A file of it, relative to its folder.
    func relative(_ file: String) -> String { path.isEmpty ? file : String(file.dropFirst(path.count + 1)) }
}

/// A collection's skills, and whether GitHub cut the list short (a very big repository).
struct CollectionListing: Decodable {
    var repository: SkillCollection
    var skills: [CollectionSkill]
    var partial: Bool
}

/// Where a skill added from GitHub came from.
struct SkillSource: Codable, Hashable {
    var repository: String
    var path: String
}

/// What a SKILL.md says about itself.
struct SkillAbout: Codable, Hashable {
    var name: String?
    var description: String?
}
