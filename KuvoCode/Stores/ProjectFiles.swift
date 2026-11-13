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

    /// What "@" can point at: with several folders, each folder first, then every file, newest
    /// first. `box`: a box's routes by its id.
    @MainActor static func mentionable(_ roots: [URL], box: (String) -> BoxClient = { BoxClient.routes($0) }) async -> [File] {
        (roots.count > 1 ? roots.enumerated().map { File(path: $1.lastPathComponent + "/", url: $1, folder: $0, mention: $1.lastPathComponent + "/") } : [])
            + (await newestFirst(roots, box: box))
    }

    /// Every file, newest first: what a list shows before anything's typed.
    @MainActor static func newestFirst(_ roots: [URL], box: (String) -> BoxClient = { BoxClient.routes($0) }) async -> [File] {
        await read(roots, at: places(roots, box), dated: true, sorted: true).files
    }

    /// Files sorted by when they last changed, newest first: what a list shows before
    /// anything's typed.
    static func newestFirst(_ files: [File]) -> [File] {
        files.sorted { ($0.modified ?? .distantPast) > ($1.modified ?? .distantPast) }
    }

    /// The files in `roots`, the primary folder's first; `dated`, with when each last changed.
    @MainActor static func list(_ roots: [URL], dated: Bool = false, box: (String) -> BoxClient = { BoxClient.routes($0) }) async -> [File] {
        await listing(roots, dated: dated, box: box).files
    }

    /// The same, with why a folder couldn't be read (the first one that couldn't), so a list
    /// that's empty for that never says there's nothing.
    @MainActor static func listing(_ roots: [URL], dated: Bool = false, box: (String) -> BoxClient = { BoxClient.routes($0) }) async -> (files: [File], failure: FolderFailure?) {
        await read(roots, at: places(roots, box), dated: dated, sorted: false)
    }

    /// Each root on the box it's on.
    @MainActor private static func places(_ roots: [URL], _ box: (String) -> BoxClient) -> [GitPlace] {
        roots.map { GitPlace.of(RemoteFolder.folder(of: $0), box: box) }
    }

    /// Off the main thread: thousands of files, and for this Mac's, when each last changed.
    @concurrent private static func read(_ roots: [URL], at places: [GitPlace], dated: Bool, sorted: Bool) async -> (files: [File], failure: FolderFailure?) {
        var failure: FolderFailure?
        var files: [File] = []
        for (index, root) in roots.enumerated() {
            let prefix = roots.count > 1 ? root.lastPathComponent + "/" : ""
            let paths: [String]
            switch await listFiles(in: root, at: places[index]) {
            case .success(let listed): paths = listed
            case .failure(let reason): paths = []; failure = failure ?? reason
            }
            files += paths.map { path in
                let url = root.appending(path: path)
                // (A machine's files go without: a date each would be a round trip each.)
                let modified = dated && url.isFileURL ? (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate : nil
                return File(path: prefix + path, url: url, folder: index, mention: index == 0 ? path : prefix + path, modified: modified)
            }
        }
        return (sorted ? newestFirst(files) : files, failure)
    }

    /// The files under one root, as the box it's on lists them (`kuvo/folders/tree`): git's list
    /// (tracked and new, without ignored files) in a repository; otherwise, and where git lists
    /// nothing (a folder its repository ignores), a walk that skips the usual heavy folders.
    private static func listFiles(in root: URL, at place: GitPlace) async -> Result<[String], FolderFailure> {
        struct Tree: Decodable { let files: [String] }
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "path", value: place.path)]
        let asked = "kuvo/folders/tree?" + (query.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        let status: Int, data: Data
        do {
            (status, data) = try await place.client.send("GET", asked)
        } catch {
            return .failure(place.machine.map(FolderFailure.unreached) ?? FolderFailure(reason: "Kuvo Code’s background service on this Mac didn’t answer", said: false))
        }
        if (200..<300).contains(status) {
            guard let tree = try? JSONDecoder().decode(Tree.self, from: data) else { return .failure(FolderFailure(reason: "Its list of files couldn’t be read", said: false)) }
            return .success(tree.files)
        }
        if Git.lacksRoute(status, data) {
            // COMPAT(beta.1 git-older-box): this Mac's older box, running on after an update, says the list waits for it; a machine's box from before `kuvo/folders/tree` lists them with its git or a walk over SSH, as before. Goes when 0.8.0 ships.
            guard place.machine != nil else { return .failure(FolderFailure(reason: "Kuvo Code on this Mac is finishing an update. Try again once the work that’s running now ends", said: false)) }
            if let listed = Git.run(["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], in: RemoteFolder.folder(of: root)), !listed.isEmpty {
                var seen = Set<String>()
                return .success(listed.split(separator: "\0").map(String.init).filter { seen.insert($0).inserted }.prefix(20_000).map { $0 })
            }
            return RemoteShell.files(in: root, skipping: [".git", "node_modules", "build", "DerivedData", ".build", "Pods", "dist", ".next"], limit: 20_000)
        }
        let refusal = BoxRefusal(status: status, data: data)
        // This Mac's box starting (with the app, or again after an update), or not up.
        if status == 503 { return .failure(FolderFailure(reason: refusal.reason == "starting" ? "Kuvo Code’s background service on this Mac is starting" : refusal.message, said: false)) }
        // What the computer said ("Permission denied").
        return .failure(FolderFailure(reason: refusal.reason ?? refusal.message))
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
        if [ ! -e "$p" ]; then d=$(dirname -- "$p"); while [ ! -e "$d" ]; do d=$(dirname -- "$d"); done
          if [ -x "$d" ]; then echo kuvo-folder:missing; else echo kuvo-folder:denied; fi
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
