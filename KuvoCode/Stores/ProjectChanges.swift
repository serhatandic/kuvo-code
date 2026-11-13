import ClientChanges
import ClientDesign
import Foundation
import OpenCodeKit
import UniformTypeIdentifiers

/// One changed file, parsed from a unified diff: every line it shows, with its numbers
/// on each side. Git is asked for the whole file as context, so unchanged stretches can
/// be folded and opened again without another call.
nonisolated struct ChangedFile: Identifiable, Hashable, Sendable {
    typealias Status = PatchFile.Status

    /// Relative to the repository (or the project, without one).
    var path: String
    var oldPath: String?
    var status: Status
    var isBinary = false
    /// Too big to read line by line (a new file of a few megabytes); shown like a binary one.
    var isTooBig = false
    /// A folder with a repository of its own (a nested repository, a new submodule), listed
    /// as one new file.
    var isFolder = false
    var lines: [DiffLine] = []
    /// Where the file is on disk.
    var url: URL
    /// The repository, and git's names for the two versions ("HEAD:path", ":path" for
    /// the index); nil reads that side from disk, or means there's none.
    var root: String?
    var oldObject: String?
    var newObject: String?
    /// A new file, listed but not read yet (`Git.readNew`): this Mac's from disk, a machine's from
    /// its box.
    var unread = false
    /// A new file's stamp (its size and when it last changed), as listed: its read is kept until
    /// that changes.
    var hash: String?
    /// What git names its two sides by (`PatchFile.index`): a picture made again reads as changed.
    var index: String?

    var id: String { path }

    /// Pictures get a before and after instead of lines.
    var isImage: Bool {
        UTType(filenameExtension: (path as NSString).pathExtension)?.conforms(to: .image) == true
    }
    var additions: Int { lines.count { $0.kind == .added } }
    var deletions: Int { lines.count { $0.kind == .removed } }
}

extension ChangedFile {
    /// A file from git's diff, in the repository at `root` (as this Mac names it).
    nonisolated init(_ parsed: PatchFile, root: String) {
        self.init(path: parsed.path, oldPath: parsed.oldPath, status: parsed.status, isBinary: parsed.isBinary, isTooBig: parsed.isTooBig,
                  isFolder: parsed.isFolder, lines: parsed.lines, url: RemoteFolder.url(root).appending(path: parsed.path), unread: parsed.unread)
        index = parsed.index
    }
}

/// What's changed in a project, as Codex shows it: the working tree against git, new
/// files included. Outside a repository, it falls back to the engine's record of the
/// session's edits.
@Observable
final class ProjectChanges {
    enum Scope: String, CaseIterable, Identifiable {
        /// `branch` is everything since the branch left its base, committed or not; `session`
        /// is the session's own edits, as the engine recorded them.
        case uncommitted, unstaged, staged, branch, session
        var id: Self { self }
        var title: String {
            switch self {
            case .uncommitted: "Uncommitted"
            case .unstaged: "Unstaged"
            case .staged: "Staged"
            case .branch: "Branch"
            case .session: "This Session"
            }
        }
    }

    let directory: String
    /// Another scope's list isn't this one's as last seen.
    var scope = Scope.uncommitted { didSet { if scope != oldValue { hasRead = false } } }
    /// The branch this one comes from, for the Branch scope: a worktree's base, or the
    /// repository's default branch.
    var base: String?
    private(set) var files: [ChangedFile] = []
    /// False outside a git repository; the scopes don't apply then.
    private(set) var isRepository = true
    /// Something isn't committed yet, so there's something to commit (the Branch scope shows
    /// committed changes too).
    private(set) var hasUncommitted = true
    private(set) var isLoaded = false
    /// A machine's box couldn't be asked before anything showed: not a folder without git, and
    /// Stage and Discard come back with the list.
    private(set) var isUnreachable = false
    /// When the list was last read: what's said of it as last seen while its machine is away. Not
    /// watched, so a look every few seconds doesn't redraw the panel (nothing reads it while away).
    @ObservationIgnored private(set) var read: Date?
    private var hasRead = false
    /// Its machine isn't connected: its box isn't asked until it's back, and the list shows as last
    /// seen. Set from the machine's engine.
    var isAway = false
    private var signature = 0
    /// Each refresh's number: only the latest one's list shows.
    private var generation = 0
    /// New files as they were last read, by path and stamp (`ChangedFile.hash`), so each look
    /// reads only those that changed: after an install in a project with no .gitignore, thousands.
    private var reads: [String: ChangedFile] = [:]

    /// A box's routes, by its id: git runs on the box the folder is on, this Mac's too.
    private let box: (String) -> BoxClient

    init(directory: String, box: @escaping (String) -> BoxClient = { BoxClient.routes($0) }) {
        self.directory = directory
        self.box = box
    }

    /// Where `folder`'s git runs.
    private func place(_ folder: String) -> GitPlace { GitPlace.of(folder, box: box) }

    /// The list as it is, as last seen under the away bar, or (never read) the machine's connection
    /// in its place.
    var shown: ChangesAway.Shown { ChangesAway.shown(isAway: isAway || isUnreachable, read: hasRead ? read : nil) }

    var additions: Int { files.reduce(0) { $0 + $1.additions } }
    var deletions: Int { files.reduce(0) { $0 + $1.deletions } }

    /// Reads the changes again. `fallback` is the engine's diff, used outside a repository, or
    /// when it's empty there (the engine keeps no snapshots outside one), `edits`: the files the
    /// session's edits changed.
    func refresh(fallback: [FileDiff] = [], edits: [FileDiff] = []) async {
        let directory = directory, scope = scope, base = base
        // Not asked while it's away: its connection says when it's back.
        if isAway { return }
        generation += 1
        let mine = generation
        if scope == .session {
            hasUncommitted = false
            isUnreachable = false
            apply(fallback.map { DiffParser.file(from: $0, directory: directory) })
            isLoaded = true
            stamp()
            return
        }
        let place = place(directory)
        let found = await Git.found(at: place, scope: scope, base: base)
        // This Mac's box starting (with the app, or again after an update): still loading, or what
        // showed stays, until it answers or says why it can't.
        if case .starting = found { return }
        // A machine's box out of reach for a moment: what showed stays, rather than reading as no
        // repository. Out of reach from the start: said so.
        if case .unreachable = found {
            guard mine == generation, !Task.isCancelled, !isLoaded || isUnreachable else { return }
            isUnreachable = true
            isLoaded = true
            return
        }
        // Answered, but not with the changes (git couldn't say for a moment): what showed stays.
        if case .refused = found, isLoaded, !isUnreachable { return }
        if case .listed(let result, let uncommitted) = found {
            let client = place.client
            let read = await Git.readNew(result, known: reads) { _ in client }
            // Kept whichever list shows: what was read is the file as it is.
            reads = Git.kept(read)
            let signature = await Task.detached { Git.signature(of: read) }.value
            // Gone to another scope, or a later refresh is under way: theirs shows.
            guard mine == generation, !Task.isCancelled else { return }
            isRepository = true
            isUnreachable = false
            if hasUncommitted != uncommitted { hasUncommitted = uncommitted }
            apply(read, signature: signature)
        } else {
            guard mine == generation, !Task.isCancelled else { return }
            isRepository = false
            isUnreachable = false
            apply((fallback.isEmpty ? edits : fallback).map { DiffParser.file(from: $0, directory: directory) })
        }
        isLoaded = true
        stamp()
    }

    enum Action { case stage, unstage, discard }

    /// Stages, unstages or discards one file's changes, then reads the changes again. Discard
    /// follows the scope: in Unstaged only what isn't staged, otherwise back to the last commit.
    /// A file git doesn't know yet goes to the Trash. Returns git's complaint, if any.
    func perform(_ action: Action, on file: ChangedFile) async -> String? {
        guard let root = file.root else { return nil }
        // (Asked for before it went: its alert was open.)
        if isAway { return ChangesAway.notBack(RemoteFolder.machine(of: directory) ?? "Its machine") }
        let failure = await Git.performing(action, on: file, at: place(root), scope: scope)
        await refresh()
        return failure
    }

    /// Commits what's staged, or everything in the project's folder when nothing is, and
    /// pushes if asked, on the box the folder is on. Returns git's complaint, if any.
    /// `environment` is your shell's: its git author goes along.
    func commit(message: String, push: Bool, environment: [String: String]) async -> String? {
        if isAway { return ChangesAway.notBack(RemoteFolder.machine(of: directory) ?? "Its machine") }
        let failure = await Git.committing(message: message, push: push, at: place(directory), environment: environment)
        if failure == nil { Analytics.shared.track("changes_committed", ["pushed": push]) }
        await refresh()
        return failure
    }

    /// Whether anything is staged, which is what a commit takes then.
    func hasStaged() async -> Bool {
        await Git.commitDiffing(at: place(directory)).staged
    }

    private func stamp() {
        read = .now
        if !hasRead { hasRead = true }
    }

    /// Only publishes when something changed, so a refresh doesn't redraw the panel.
    private func apply(_ files: [ChangedFile], signature: Int? = nil) {
        let signature = signature ?? files.hashValue
        guard signature != self.signature else { return }
        self.signature = signature
        self.files = files
    }
}

// MARK: - Git

/// Where a folder's git runs: on the box it's on, this Mac's or a machine's, as a phone asks it
/// (`kuvo/git/…`), with the folder as that box names it.
nonisolated struct GitPlace: Sendable {
    let client: BoxClient
    /// The folder as its box names it.
    let path: String
    /// The machine it's on, as this Mac names its folders; nil for this Mac's own.
    let machine: String?

    /// `folder` (as this Mac names it) on its box: a machine's, or this Mac's (`BoxClient.thisMac`,
    /// the one attached in place when it's that), by `box`, a box's routes by its id.
    @MainActor static func of(_ folder: String, box: (String) -> BoxClient = { BoxClient.routes($0) }) -> GitPlace {
        if let (machine, path) = RemoteFolder.parse(folder) { return GitPlace(client: box(machine), path: path, machine: machine) }
        return GitPlace(client: box(BoxClient.thisMac), path: folder, machine: nil)
    }

    /// A folder its box named, as this Mac names it.
    func here(_ path: String) -> String { machine.map { RemoteFolder.folder(path, on: $0) } ?? path }

    /// Why its box couldn't be asked, in words.
    func unreachable(_ error: any Error) -> String {
        machine == nil ? "Kuvo Code’s background service on this Mac didn’t answer. Try again in a moment." : error.localizedDescription
    }
}

nonisolated enum Git {
    // MARK: On the folder's box

    enum Found {
        /// The changed files, and whether anything isn't committed yet.
        case listed([ChangedFile], Bool)
        /// Not in a repository, or git couldn't say.
        case notRepository
        /// Its box couldn't be asked (the connection, not what it answered).
        case unreachable
        /// This Mac's box is starting, and will answer.
        case starting
        /// Its box answered, but not with the changes (git couldn't say, an older box).
        case refused
    }

    /// The changed files in `scope`, from the box the folder is on (`kuvo/git/changes`), as a
    /// phone reads them.
    @concurrent static func found(at place: GitPlace, scope: ProjectChanges.Scope, base: String?) async -> Found {
        struct Asked: Encodable { let directory: String, scope: String, base: String? }
        struct Answer: Decodable {
            let repository: Bool
            let root, against, patch: String?
            let untracked: [String]?
            let hashes: [String: String]?
            let uncommitted: Bool?
        }
        let asked = Asked(directory: place.path, scope: scope == .session ? "uncommitted" : scope.rawValue, base: base)
        let found: Answer
        do {
            found = try await place.client.value(Answer.self, "POST", "kuvo/git/changes", body: asked)
        } catch let refusal as BoxRefusal where refusal.status == 503 {
            // Not up: starting (with the app, or again after an update), or out of reach (it
            // couldn't start); never a folder without git.
            return refusal.reason == "starting" ? .starting : .unreachable
        } catch is BoxRefusal {
            return .refused
        } catch is DecodingError {
            return .refused
        } catch {
            return .unreachable
        }
        guard found.repository, let root = found.root, let against = found.against, let patch = found.patch else { return .notRepository }
        let files = listed(patch: patch, root: place.here(root), base: against, scope: scope,
                           untracked: found.untracked ?? [], hashes: found.hashes ?? [:])
        return .listed(files, found.uncommitted ?? true)
    }

    /// Stages, unstages or discards one file's changes (`perform`), on its box: `place` is its
    /// repository's.
    @concurrent static func performing(_ action: ProjectChanges.Action, on file: ChangedFile, at place: GitPlace, scope: ProjectChanges.Scope) async -> String? {
        struct Asked: Encodable { let root, path: String, oldPath: String?, status, scope: String }
        let status = switch file.status {
        case .added: "added"
        case .deleted: "deleted"
        case .modified: "modified"
        case .renamed: "renamed"
        }
        let route = switch action {
        case .stage: "stage"
        case .unstage: "unstage"
        case .discard: "discard"
        }
        let asked = Asked(root: place.path, path: file.path, oldPath: file.oldPath, status: status, scope: scope == .session ? "uncommitted" : scope.rawValue)
        return await said(at: place) { try await place.client.send("POST", "kuvo/git/" + route, body: JSONEncoder().encode(asked)) }
    }

    /// Commits (`commit`) on the folder's box, with only your shell's git author settings, which
    /// mean the same there. Its hooks, signing and push run there, with that box's environment.
    @concurrent static func committing(message: String, push: Bool, at place: GitPlace, environment: [String: String]) async -> String? {
        struct Asked: Encodable { let directory, message: String, push: Bool, author: [String: String] }
        let asked = Asked(directory: place.path, message: message, push: push, author: author(of: environment))
        return await said(at: place) { try await place.client.send("POST", "kuvo/git/commit", body: JSONEncoder().encode(asked)) }
    }

    /// Your shell's git author settings, the only ones a box takes along (`author`).
    static func author(of environment: [String: String]) -> [String: String] {
        environment.filter { ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].contains($0.key) }
    }

    /// What a commit would take, and whether that's what's staged, from the folder's box.
    @concurrent static func commitDiffing(at place: GitPlace) async -> (diff: String, staged: Bool) {
        struct Asked: Encodable { let directory: String }
        struct Answer: Decodable { let diff: String, staged: Bool }
        let answer = try? await place.client.value(Answer.self, "POST", "kuvo/git/commit-diff", body: Asked(directory: place.path))
        return (answer?.diff ?? "", answer?.staged ?? false)
    }

    /// A file as git keeps it (`object`: "HEAD:path", ":path" for the index), from its box: `place`
    /// is its repository's.
    @concurrent static func shown(_ object: String, at place: GitPlace) async -> Data? {
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "root", value: place.path), URLQueryItem(name: "object", value: object)]
        guard let encoded = query.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B"),
              let (status, data) = try? await place.client.send("GET", "kuvo/git/show?" + encoded), status == 200 else { return nil }
        return data
    }

    /// nil when the box did it, else what it said (or that it couldn't be reached).
    private static func said(at place: GitPlace, _ answer: () async throws -> (status: Int, body: Data)) async -> String? {
        do {
            let (status, data) = try await answer()
            return (200..<300).contains(status) ? nil : BoxRefusal(status: status, data: data).message
        } catch {
            return place.unreachable(error)
        }
    }

    /// The changed files from git's diff and its new files (`untracked`), as the box sent them:
    /// `root` as this Mac names it, `base` what the diff compared with, `hashes` the box's stamps of
    /// the new files, by path.
    static func listed(patch: String, root: String, base: String, scope: ProjectChanges.Scope, untracked: [String], hashes: [String: String]) -> [ChangedFile] {
        DiffParser.listed(patch: patch, untracked: untracked).map { parsed in
            var file = ChangedFile(parsed, root: root)
            file.root = root
            // A new file git doesn't know (a repository inside this one by its folder, "web/").
            if parsed.unread || parsed.path.hasSuffix("/") {
                // Its stamp, so it's read (`readNew`) only when it changes.
                file.hash = hashes[file.path]
                return file
            }
            // Where each side lives, for showing pictures.
            if file.status != .added { file.oldObject = (scope == .unstaged ? ":" : base + ":") + (file.oldPath ?? file.path) }
            if scope == .staged, file.status != .deleted { file.newObject = ":" + file.path }
            return file
        }
    }

    /// New files' lines, or binary or too big: this Mac's from its disk, a machine's from its box
    /// (`box`, by the machine's id, `kuvo/file`), as a phone reads them, several at a time. `known`: those read
    /// before (`kept`), used again while their stamp is the same.
    @concurrent static func readNew(_ files: [ChangedFile], known: [String: ChangedFile] = [:],
                                    box: @escaping @Sendable (String) -> BoxClient = BoxClient.machine) async -> [ChangedFile] {
        var read = files
        var waiting: [Int] = []
        for index in read.indices where read[index].unread {
            if let hash = read[index].hash, let before = known[read[index].path + "\0" + hash] {
                read[index] = before
            } else {
                waiting.append(index)
            }
        }
        await withTaskGroup(of: (Int, ChangedFile).self) { group in
            var next = waiting.makeIterator()
            func start() {
                guard !Task.isCancelled, let index = next.next() else { return }
                let file = read[index]
                group.addTask { (index, await readOne(file, box: box)) }
            }
            for _ in 0..<8 { start() }
            for await (index, file) in group {
                read[index] = file
                start()
            }
        }
        return read
    }

    private static func readOne(_ file: ChangedFile, box: @Sendable (String) -> BoxClient) async -> ChangedFile {
        var file = file
        file.unread = false
        if file.url.isFileURL {
            // Gone since it was listed: read again next time, not shown as binary.
            guard let size = (try? file.url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else {
                file.hash = nil
                return file
            }
            file.isTooBig = size > 2_000_000
            if !file.isTooBig { fill(&file, with: try? Data(contentsOf: file.url)) }
            return file
        }
        guard let (machine, path) = RemoteFolder.parse(file.url) else { return file }
        do {
            fill(&file, with: try await box(machine).file(path, max: 2_000_000))
        } catch let refusal as BoxRefusal where refusal.status == 413 {
            file.isTooBig = true
        } catch {
            file.isBinary = true
            // Not kept: read again next time (the box away for a moment, a refresh stopped).
            file.hash = nil
        }
        return file
    }

    /// What tells one list from another: a new file by its path and stamp, not by hashing its
    /// lines again each look (thousands, after an install).
    static func signature(of files: [ChangedFile]) -> Int {
        var hasher = Hasher()
        for file in files {
            if let stamp = file.hash, file.status == .added {
                hasher.combine(file.path)
                hasher.combine(stamp)
                hasher.combine(file.isBinary)
                hasher.combine(file.isTooBig)
            } else {
                hasher.combine(file)
            }
        }
        return hasher.finalize()
    }

    /// What `readNew` read, to use again (its `known`).
    static func kept(_ files: [ChangedFile]) -> [String: ChangedFile] {
        Dictionary(files.compactMap { file in file.hash.map { (file.path + "\0" + $0, file) } }, uniquingKeysWith: { first, _ in first })
    }

    /// A new file's lines from its bytes: binary when they aren't text, too big past what's read through.
    private static func fill(_ file: inout ChangedFile, with data: Data?) {
        var parsed = PatchFile(path: file.path, status: file.status)
        DiffParser.fill(&parsed, with: data)
        file.lines = parsed.lines
        file.isBinary = parsed.isBinary
        file.isTooBig = parsed.isTooBig
    }

    // MARK: Run by this app

    // Left for what hasn't moved to the boxes yet (the title bar's branches, the file list, a
    // worktree's changes before Delete): this Mac's git, or a machine's over SSH.


    /// Runs git for something that changes the repository; nil when it worked, else what git
    /// said. It never waits for a password: with nothing to answer, it fails instead. As long as
    /// it takes, and what a hook leaves running doesn't hold it up.
    static func report(_ arguments: [String], in directory: String, environment: [String: String]) -> String? {
        var environment = environment.isEmpty ? ProcessInfo.processInfo.environment : environment
        environment["GIT_TERMINAL_PROMPT"] = "0"
        let result: ChildProcess.Result
        do { result = try run(git: arguments, in: directory, environment: environment, errors: .withOutput, limit: nil) } catch { return error.localizedDescription }
        guard !result.succeeded else { return nil }
        let text = result.outputText.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "git \(arguments.first ?? "") failed." : text
    }

    /// git in `directory`, waited for off the main thread: this Mac's, or, for a folder on a
    /// machine, the machine's own git over SSH (its credentials, not this Mac's; only git's own
    /// settings go along).
    private static func run(git arguments: [String], in directory: String, environment: [String: String],
                            errors: ChildProcess.Errors, limit: Duration?) throws -> ChildProcess.Result {
        if let remote = RemoteFolder.parse(directory) {
            // Only git's settings that mean the same there: a command, key or config file named
            // here (GIT_SSH_COMMAND, GIT_CONFIG_GLOBAL…) is a path on this Mac.
            let portable = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS"]
            let settings = environment.filter { portable.contains($0.key) }.map { "\($0.key)=\(SSHConnection.quoted($0.value))" }.sorted()
            let command = (["exec", "env"] + settings + ["git"] + arguments.map(SSHConnection.quoted)).joined(separator: " ")
            let started = SSHConnection(destination: remote.machine).invocation(running: "cd \(SSHConnection.quoted(remote.path)) && \(command)")
            return try ChildProcess.runBlocking(started.executable, started.arguments, environment: started.environment, directory: started.directory,
                                                errors: errors, limit: limit)
        }
        return try ChildProcess.runBlocking("/usr/bin/git", arguments, environment: environment, directory: URL(filePath: directory),
                                            errors: errors, limit: limit)
    }

    /// Runs git and returns its output, or nil when it fails.
    static func run(_ arguments: [String], in directory: String) -> String? {
        data(arguments, in: directory).map { String(decoding: $0, as: UTF8.self) }
    }

    /// Runs git and returns its raw output (for file contents), or nil when it fails. Reading
    /// takes a while in a big repository, but never ten minutes: one still going then is stuck
    /// (on a lock, a full disk, a machine's hung filesystem), and stopped.
    static func data(_ arguments: [String], in directory: String) -> Data? {
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_OPTIONAL_LOCKS"] = "0"  // Reading only: don't hold the index lock.
        guard let result = try? run(git: arguments, in: directory, environment: environment, errors: .discard, limit: .seconds(600)),
              result.succeeded else { return nil }
        return result.output
    }
}

// MARK: - Parsing

extension DiffParser {
    /// The engine's diff of one file (patch text, a few lines of context).
    nonisolated static func file(from diff: FileDiff, directory: String) -> ChangedFile {
        // The engine names files by their paths where it runs: on a machine, plain paths there.
        let plain = RemoteFolder.parse(directory)?.path ?? directory
        let base = plain.hasSuffix("/") ? plain : plain + "/"
        let path = diff.file.hasPrefix(base) ? String(diff.file.dropFirst(base.count)) : diff.file
        let url = RemoteFolder.fileURL(diff.file, in: directory)
        // The engine's patches may come with git's header already; a second one would read as an
        // empty file before this one.
        let patch = diff.patch.hasPrefix("diff --git ") ? diff.patch : "diff --git a/\(path) b/\(path)\n" + diff.patch
        let parsed = parse(patch).first.map { ChangedFile($0, root: directory) }
        var file = parsed ?? ChangedFile(path: path, status: .modified, url: url)
        file.path = path
        file.url = url
        file.status = switch diff.status {
        case .added: .added
        case .deleted: .deleted
        default: file.status
        }
        return file
    }
}
