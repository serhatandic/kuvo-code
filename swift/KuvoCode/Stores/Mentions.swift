import Foundation

/// "@" in the composer: the word being typed after it, and the project's files that match.
/// The message keeps the mention as a path the agent can open ("@src/App.swift", or
/// "@api/README.md" in a project's other folder, which the agent knows by name).
nonisolated enum Mentions {
    /// What follows an "@" that starts a word at the end of `text`, while it's being typed.
    /// Nil when there's none, or the word has ended.
    static func query(in text: String) -> (query: String, start: String.Index)? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at > text.startIndex, !text[text.index(before: at)].isWhitespace { return nil }
        let query = text[text.index(after: at)...]
        guard !query.contains(where: \.isWhitespace) else { return nil }
        return (String(query), at)
    }

    /// The best matches first: the name itself, then names starting with it, then names
    /// containing it, then anywhere in the path; among equals, the primary folder's and
    /// shorter paths first. Before anything's typed: the project's folders, then the first
    /// files, which `ProjectFiles.newestFirst` puts in order.
    static func matches(_ query: String, in files: [ProjectFiles.File], limit: Int = 8) -> [ProjectFiles.File] {
        let query = query.lowercased()
        guard !query.isEmpty else {
            return Array((files.filter(\.isFolder) + files.lazy.filter { !$0.isFolder }.prefix(limit)).prefix(limit))
        }
        func rank(_ file: ProjectFiles.File) -> Int? {
            let name = file.name.lowercased()
            if name == query { return 0 }
            if name.hasPrefix(query) { return 1 }
            if name.contains(query) { return 2 }
            if file.path.lowercased().contains(query) { return 3 }
            return nil
        }
        return files
            .compactMap { file in rank(file).map { (file, $0) } }
            .sorted { ($0.1, $0.0.folder, $0.0.path.count, $0.0.path) < ($1.1, $1.0.folder, $1.0.path.count, $1.0.path) }
            .prefix(limit)
            .map(\.0)
    }

    /// `text` with the mention being typed replaced by `file`'s path and a space.
    static func insert(_ file: ProjectFiles.File, into text: String) -> String {
        guard let (_, start) = query(in: text) else { return text }
        return String(text[..<start]) + "@" + file.mention + " "
    }
}
