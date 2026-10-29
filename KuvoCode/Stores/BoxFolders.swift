import Foundation

// What a box says of its own folders and of npm, for settings that name a folder or a package:
// each computer answers for itself (PROTOCOL.md, `kuvo/folders`, `kuvo/worktrees/where` and
// `kuvo/plugins/search`), so a machine's are found there, with the Mac closed too.

/// The folders in one of a box's folders, to choose one.
struct BoxFolderListing: Decodable, Equatable {
    var path: String
    var home: String
    /// Nil at `/`.
    var parent: String?
    var folders: [Folder]

    struct Folder: Decodable, Equatable, Hashable, Identifiable {
        var name: String
        /// A git repository's own checkout.
        var repository: Bool?
        var id: String { name }
    }
}

/// Where new worktrees go with a Worktrees folder, for each of the box's projects in a repository.
struct WorktreesWhere: Decodable, Equatable {
    /// The Worktrees folder this answers for, as written; nil for the engine's own.
    var directory: String?
    /// The engine's own folder, where each project has one of its own.
    var `default`: String
    /// The computer's home folder, for showing paths from `~`.
    var home: String
    var projects: [Project]

    struct Project: Decodable, Equatable, Identifiable {
        var project: String
        var name: String
        /// Nil until the engine runs and says which of its own folders is the project's.
        var folder: String?
        var exists: Bool?
        var canMake: Bool?
        /// In the repository's own checkout; `ignored`: git ignores it there.
        var inside: Bool?
        var ignored: Bool?
        var id: String { project }

        /// Git would list each worktree there as new files in the project.
        var isInRepository: Bool { inside == true && ignored != true }
        var cantBeMade: Bool { exists == false && canMake == false }
    }
}

/// npm's packages the engine can load as plugins.
struct PluginSearch: Decodable, Equatable {
    var packages: [Package]
    /// What was asked for exactly that npm doesn't have.
    var missing: String?

    struct Package: Decodable, Equatable, Hashable, Identifiable {
        var name: String
        var version: String?
        var description: String?
        /// Downloads last week.
        var weekly: Int?
        var id: String { name }
    }
}

extension BoxClient {
    /// The folders in `path` (nil: the home folder), on this box.
    func folders(at path: String?) async throws -> BoxFolderListing {
        try await value(BoxFolderListing.self, "GET", path.map { "kuvo/folders?path=\(Workspace.queryValue($0))" } ?? "kuvo/folders")
    }

    /// A new folder at `path`, as a folder panel's New Folder makes one: its full path.
    func makeFolder(at path: String) async throws -> String {
        struct Made: Decodable { var path: String }
        return try await value(Made.self, "POST", "kuvo/folders", body: ["path": path]).path
    }

    /// Where new worktrees go with `directory` as the Worktrees folder (nil: the engine's own).
    func worktreesWhere(_ directory: String?) async throws -> WorktreesWhere {
        try await value(WorktreesWhere.self, "GET", directory.map { "kuvo/worktrees/where?directory=\(Workspace.queryValue($0))" } ?? "kuvo/worktrees/where")
    }

    /// Where new projects go on this box (`kuvo/work/settings`): nil until you pick a folder, with
    /// one to offer then.
    func workSettings() async throws -> WorkSettings {
        try await value(WorkSettings.self, "GET", "kuvo/work/settings")
    }

    /// New projects to go in `folder` on this box from now on; nil for none picked.
    @discardableResult
    func setProjectsFolder(_ folder: String?) async throws -> WorkSettings {
        try await value(WorkSettings.self, "PATCH", "kuvo/work/settings", body: WorkSettings(projectsFolder: folder))
    }

    /// npm's packages for opencode that `query` finds; with none, the most used plugins.
    func searchPlugins(_ query: String) async throws -> PluginSearch {
        try await value(PluginSearch.self, "GET", "kuvo/plugins/search?q=\(Workspace.queryValue(query))")
    }
}

enum BoxPaths {
    /// A path as it's shown: starting at `~` when it's in the home folder.
    static func display(_ path: String, home: String?) -> String {
        guard let home, !home.isEmpty, home != "/" else { return path }
        if path == home { return "~" }
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    /// A folder as a setting names it: from `~/` when it's in the home folder (the engine reads
    /// that as the home folder of the computer it runs on), else as it is.
    static func setting(_ path: String, home: String) -> String {
        path.hasPrefix(home + "/") ? "~/" + path.dropFirst(home.count + 1) : path
    }
}

/// Where new projects go on a box (`kuvo/work/settings`), and a folder to offer while none is
/// picked.
struct WorkSettings: Codable, Equatable {
    var projectsFolder: String?
    var suggested: String?

    private enum CodingKeys: String, CodingKey { case projectsFolder, suggested }

    // (None picked is sent as null, which the box takes as none.)
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectsFolder, forKey: .projectsFolder)
    }
}
