import Foundation
import OpenCodeKit

/// Every file in a project's folders, for filtering the file tree and for @ mentions.
nonisolated enum ProjectFiles {
    struct File: Identifiable, Hashable, Sendable {
        /// Relative to its folder; with several folders, starting with the folder's name.
        let path: String
        let url: URL
        /// Which of the project's folders it's in: 0 is the primary one.
        var folder = 0
        /// How "@" names it: inside the primary folder, where the agent works, its path there;
        /// elsewhere, after its folder's name, which the agent knows.
        var mention: String
        /// When it last changed, when asked for: the newest come first before anything's typed.
        var modified: Date?

        var id: URL { url }
        var name: String { url.lastPathComponent }
        /// One of the project's folders, listed by name ("api/").
        var isFolder: Bool { path.hasSuffix("/") }
    }

    /// What "@" can point at: with several folders, each folder first, then every file, with
    /// when it last changed.
    static func mentionable(_ roots: [URL]) -> [File] {
        (roots.count > 1 ? roots.enumerated().map { File(path: $1.lastPathComponent + "/", url: $1, folder: $0, mention: $1.lastPathComponent + "/") } : []) + newestFirst(list(roots, dated: true))
    }

    /// Files sorted by when they last changed, newest first: what a list shows before
    /// anything's typed. Sorted once here, off the main thread.
    static func newestFirst(_ files: [File]) -> [File] {
        files.sorted { ($0.modified ?? .distantPast) > ($1.modified ?? .distantPast) }
    }

    /// The files in `roots`, the primary folder's first; `dated`, with when each last changed.
    /// Slow for big trees: call it off the main thread.
    static func list(_ roots: [URL], dated: Bool = false) -> [File] {
        listing(roots, dated: dated).files
    }

    /// The same, with why a folder couldn't be read (the first one that couldn't), so a list
    /// that's empty for that never says there's nothing.
    static func listing(_ roots: [URL], dated: Bool = false) -> (files: [File], failure: FolderFailure?) {
        var failure: FolderFailure?
        let files = roots.enumerated().flatMap { index, root in
            let prefix = roots.count > 1 ? root.lastPathComponent + "/" : ""
            let paths: [String]
            switch listFiles(in: root) {
            case .success(let listed): paths = listed
            case .failure(let reason): paths = []; failure = failure ?? reason
            }
            return paths.map { path in
                let url = root.appending(path: path)
                // (A machine's files go without: a date each would be a round trip each.)
                let modified = dated && url.isFileURL ? (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate : nil
                return File(path: prefix + path, url: url, folder: index, mention: index == 0 ? path : prefix + path, modified: modified)
            }
        }
        return (files, failure)
    }

    /// git's list (tracked and new, without ignored files) in a repository; otherwise a
    /// walk that skips the usual heavy folders. So too for a folder git lists nothing in: one its
    /// repository ignores (a dotfiles repository at home that ignores everything) has files.
    private static func listFiles(in root: URL) -> Result<[String], FolderFailure> {
        // Names as they are (git quotes ones with accents, CJK or emoji otherwise), once each (a
        // file in conflict is listed for each side), as many as a walk gives.
        if let listed = Git.run(["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], in: RemoteFolder.folder(of: root)), !listed.isEmpty {
            var seen = Set<String>()
            return .success(listed.split(separator: "\0").map(String.init).filter { seen.insert($0).inserted }.prefix(20_000).map { $0 })
        }
        let skip: Set<String> = [".git", "node_modules", "build", "DerivedData", ".build", "Pods", "dist", ".next"]
        if !root.isFileURL { return RemoteShell.files(in: root, skipping: skip, limit: 20_000) }
        var files: [String] = []
        // Paths relative to the folder as the walk gives them, also where the folder, or one it's
        // in, is a link (/tmp, a cloud drive's).
        let folder = root.resolvingSymlinksInPath()
        do {
            _ = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        } catch {
            return .failure(FolderFailure(error))
        }
        guard let walker = FileManager.default.enumerator(atPath: folder.path) else { return .success([]) }
        while let path = walker.nextObject() as? String {
            if skip.contains((path as NSString).lastPathComponent) { walker.skipDescendants(); continue }
            if walker.fileAttributes?[.type] as? FileAttributeType != .typeDirectory {
                files.append(path)
                if files.count >= 20_000 { break }
            }
        }
        return .success(files)
    }
}

/// Why a folder couldn't be read, as the computer puts it ("Permission denied"), so it never looks
/// like one that's empty.
nonisolated struct FolderFailure: Error, Hashable, Sendable {
    /// What the computer said, or, when it couldn't be asked, that.
    var reason: String
    /// The computer was reached, and said `reason`.
    var said = true

    static let denied = FolderFailure(reason: "Permission denied")
    static let missing = FolderFailure(reason: "No such folder")
    static let notFolder = FolderFailure(reason: "Not a folder")
    static func unreached(_ machine: String) -> FolderFailure { FolderFailure(reason: "Couldn't reach \(machine)", said: false) }

    /// One of this Mac's folders, by what reading it threw.
    init(_ error: Error) {
        let error = error as NSError
        let posix = (error.userInfo[NSUnderlyingErrorKey] as? NSError).flatMap { $0.domain == NSPOSIXErrorDomain ? $0.code : nil }
        switch (error.code, posix) {
        case (_, Int(ENOTDIR)?): self = .notFolder
        case (NSFileReadNoPermissionError, _), (_, Int(EACCES)?), (_, Int(EPERM)?): self = .denied
        case (NSFileReadNoSuchFileError, _), (NSFileNoSuchFileError, _), (_, Int(ENOENT)?): self = .missing
        default: self.init(reason: error.localizedDescription)
        }
    }

    init(reason: String, said: Bool = true) {
        self.reason = reason
        self.said = said
    }

    /// Under "Couldn't read this folder": what `computer` said (nil: this Mac, which needn't be
    /// named), or that it couldn't be asked.
    func detail(on computer: String?) -> String {
        guard said, let computer else { return reason + "." }
        return "\(computer) said: \(reason)."
    }

    /// A script that goes into `path` on a machine and runs `body` there, first saying whether it
    /// could: a line `checked` reads, so a folder that can't be read never lists as empty. What
    /// `body` says on stderr is let go (a folder in it that can't be read leaves out only that).
    static func checking(_ path: String, then body: String) -> String {
        """
        p=\(SSHConnection.quoted(path))
        if [ ! -e "$p" ]; then if [ -x "$(dirname -- "$p")" ]; then echo kuvo-folder:missing; else echo kuvo-folder:denied; fi
        elif [ ! -d "$p" ]; then echo kuvo-folder:not-a-folder
        elif ! cd "$p" 2>/dev/null || [ ! -r . ]; then echo kuvo-folder:denied
        else echo kuvo-folder:ok; \(body) 2>/dev/null; fi
        exit 0
        """
    }

    /// What a `checking` script printed: what `body` said, or why it didn't run (nil: SSH failed).
    static func checked(_ output: Data?, machine: String) -> Result<Data, FolderFailure> {
        guard let output else { return .failure(.unreached(machine)) }
        guard let end = output.firstIndex(of: UInt8(ascii: "\n")) else { return .failure(.unreached(machine)) }
        switch String(decoding: output[..<end], as: UTF8.self) {
        case "kuvo-folder:ok": return .success(Data(output[output.index(after: end)...]))
        case "kuvo-folder:denied": return .failure(.denied)
        case "kuvo-folder:not-a-folder": return .failure(.notFolder)
        case "kuvo-folder:missing": return .failure(.missing)
        default: return .failure(.unreached(machine))
        }
    }
}
