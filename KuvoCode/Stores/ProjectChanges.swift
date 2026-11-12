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

    /// A machine's box, by the machine's id.
    private let box: @Sendable (String) -> BoxClient

    init(directory: String, box: @escaping @Sendable (String) -> BoxClient = BoxClient.machine) {
        self.directory = directory
        self.box = box
    }

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
        let found = await Git.found(in: directory, scope: scope, base: base, box: box)
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
            let read = await Git.readNew(result, known: reads, box: box)
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
        let failure = await Git.performing(action, on: file, root: root, scope: scope)
        await refresh()
        return failure
    }

    /// Commits what's staged, or everything in the project's folder when nothing is, and
    /// pushes if asked. Returns git's complaint, if any. `environment` is your shell's, so
    /// hooks, signing and pushing see what they do in Terminal.
    func commit(message: String, push: Bool, environment: [String: String]) async -> String? {
        let directory = directory
        if isAway { return ChangesAway.notBack(RemoteFolder.machine(of: directory) ?? "Its machine") }
        let failure = await Git.committing(message: message, push: push, in: directory, environment: environment)
        if failure == nil { Analytics.shared.track("changes_committed", ["pushed": push]) }
        await refresh()
        return failure
    }

    /// The diff a commit would take (what's staged, or everything with new files' names),
    /// cut to a size a model reads quickly.
    func commitDiff() async -> String {
        await Git.commitDiffing(in: directory).diff
    }

    /// Whether anything is staged, which is what a commit takes then.
    func hasStaged() async -> Bool {
        let directory = directory
        guard RemoteFolder.parse(directory) != nil else { return await Task.detached { Git.hasStaged(in: directory) }.value }
        return await Git.commitDiffing(in: directory).staged
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

nonisolated enum Git {
    // MARK: A machine's, from its box

    enum Found {
        /// The changed files, and whether anything isn't committed yet.
        case listed([ChangedFile], Bool)
        /// Not in a repository, or git couldn't say.
        case notRepository
        /// A machine's box couldn't be asked (the connection, not what it answered).
        case unreachable
        /// A machine's box answered, but not with the changes (git couldn't say, an older box).
        case refused
    }

    /// The changed files in `scope`. A machine's come from its box (`kuvo/git/changes`), as a
    /// phone reads them; this Mac's from its git.
    @concurrent static func found(in directory: String, scope: ProjectChanges.Scope, base: String?,
                                  box: @Sendable (String) -> BoxClient = BoxClient.machine) async -> Found {
        guard let (machine, path) = RemoteFolder.parse(directory) else {
            guard let files = changes(in: directory, scope: scope, base: base) else { return .notRepository }
            return .listed(files, scope != .branch || hasUncommittedChanges(in: directory))
        }
        struct Asked: Encodable { let directory: String, scope: String, base: String? }
        struct Answer: Decodable {
            let repository: Bool
            let root, against, patch: String?
            let untracked: [String]?
            let hashes: [String: String]?
            let uncommitted: Bool?
        }
        let asked = Asked(directory: path, scope: scope == .session ? "uncommitted" : scope.rawValue, base: base)
        let found: Answer
        do {
            found = try await box(machine).value(Answer.self, "POST", "kuvo/git/changes", body: asked)
        } catch is BoxRefusal {
            return .refused
        } catch is DecodingError {
            return .refused
        } catch {
            return .unreachable
        }
        guard found.repository, let root = found.root, let against = found.against, let patch = found.patch else { return .notRepository }
        let files = listed(patch: patch, root: RemoteFolder.folder(root, on: machine), base: against, scope: scope,
                           untracked: found.untracked ?? [], hashes: found.hashes ?? [:])
        return .listed(files, found.uncommitted ?? true)
    }

    /// Stages, unstages or discards one file's changes (`perform`): a machine's on its box.
    @concurrent static func performing(_ action: ProjectChanges.Action, on file: ChangedFile, root: String, scope: ProjectChanges.Scope,
                                       box: @Sendable (String) -> BoxClient = BoxClient.machine) async -> String? {
        guard let (machine, path) = RemoteFolder.parse(root) else { return perform(action, on: file, root: root, scope: scope) }
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
        let asked = Asked(root: path, path: file.path, oldPath: file.oldPath, status: status, scope: scope == .session ? "uncommitted" : scope.rawValue)
        return await said { try await box(machine).send("POST", "kuvo/git/" + route, body: JSONEncoder().encode(asked)) }
    }

    /// Commits (`commit`): a machine's on its box, with only your shell's git author settings,
    /// which mean the same there.
    @concurrent static func committing(message: String, push: Bool, in directory: String, environment: [String: String],
                                       box: @Sendable (String) -> BoxClient = BoxClient.machine) async -> String? {
        guard let (machine, path) = RemoteFolder.parse(directory) else { return commit(message: message, push: push, in: directory, environment: environment) }
        struct Asked: Encodable { let directory, message: String, push: Bool, author: [String: String] }
        let author = environment.filter { ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].contains($0.key) }
        return await said { try await box(machine).send("POST", "kuvo/git/commit", body: JSONEncoder().encode(Asked(directory: path, message: message, push: push, author: author))) }
    }

    /// What a commit would take, and whether that's what's staged: a machine's from its box.
    @concurrent static func commitDiffing(in directory: String, box: @Sendable (String) -> BoxClient = BoxClient.machine) async -> (diff: String, staged: Bool) {
        guard let (machine, path) = RemoteFolder.parse(directory) else { return (commitDiff(in: directory), hasStaged(in: directory)) }
        struct Asked: Encodable { let directory: String }
        struct Answer: Decodable { let diff: String, staged: Bool }
        let answer = try? await box(machine).value(Answer.self, "POST", "kuvo/git/commit-diff", body: Asked(directory: path))
        return (answer?.diff ?? "", answer?.staged ?? false)
    }

    /// A file as git keeps it (`object`: "HEAD:path", ":path" for the index), a machine's from its box.
    @concurrent static func shown(_ object: String, in root: String, box: @Sendable (String) -> BoxClient = BoxClient.machine) async -> Data? {
        guard let (machine, path) = RemoteFolder.parse(root) else { return data(["show", object], in: root) }
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "root", value: path), URLQueryItem(name: "object", value: object)]
        guard let encoded = query.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B"),
              let (status, data) = try? await box(machine).send("GET", "kuvo/git/show?" + encoded), status == 200 else { return nil }
        return data
    }

    /// nil when the box did it, else what it said (or that it couldn't be reached).
    private static func said(_ answer: () async throws -> (status: Int, body: Data)) async -> String? {
        do {
            let (status, data) = try await answer()
            return (200..<300).contains(status) ? nil : BoxRefusal(status: status, data: data).message
        } catch {
            return error.localizedDescription
        }
    }

    // MARK: This Mac's

    /// The changed files in `scope`, or nil when `directory` isn't in a repository.
    static func changes(in directory: String, scope: ProjectChanges.Scope, base branch: String? = nil) -> [ChangedFile]? {
        guard let root = toplevel(of: directory) else { return nil }
        // A repository without commits yet: compare with the empty tree.
        var base = run(["rev-parse", "--verify", "-q", "HEAD"], in: root) == nil ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : "HEAD"
        // Since the branch left its base: from where they part, to the files as they are now.
        if scope == .branch, let branch,
           let fork = run(["merge-base", "HEAD", branch], in: root)?.trimmingCharacters(in: .whitespacesAndNewlines), !fork.isEmpty {
            base = fork
        }
        let limit = relativePath(of: directory, in: root)
        // Its own prefixes, whatever the git settings (diff.noprefix, diff.mnemonicPrefix): the
        // paths are read after them. The file's own lines: an unchanged blank line written as " "
        // (diff.suppressBlankEmpty), none through a converter (textconv); each line is counted.
        var arguments = ["-c", "core.quotepath=off", "-c", "diff.suppressBlankEmpty=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U100000"]
        switch scope {
        // The session's edits come from the engine, not git; read like Uncommitted here.
        case .uncommitted, .branch, .session: arguments.append(base)
        case .unstaged: break
        case .staged: arguments += ["--cached", base]
        }
        arguments += ["--", limit.isEmpty ? "." : limit]
        guard let patch = run(arguments, in: root) else { return nil }
        let untracked = scope == .staged ? [] : (run(["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z", "--", limit.isEmpty ? "." : limit], in: root) ?? "")
            .split(separator: "\0").map(String.init)
        return listed(patch: patch, root: root, base: base, scope: scope, untracked: untracked, hashes: [:])
    }

    /// The changed files from git's diff and its new files (`untracked`), wherever git ran: `root`
    /// as this Mac names it, `base` what the diff compared with, `hashes` git's of a machine's new
    /// files, by path.
    static func listed(patch: String, root: String, base: String, scope: ProjectChanges.Scope, untracked: [String], hashes: [String: String]) -> [ChangedFile] {
        DiffParser.listed(patch: patch, untracked: untracked).map { parsed in
            var file = ChangedFile(parsed, root: root)
            file.root = root
            // A new file git doesn't know (a repository inside this one by its folder, "web/").
            if parsed.unread || parsed.path.hasSuffix("/") {
                // Its stamp (a machine's box sends them), so it's read (`readNew`) only when it changes.
                file.hash = file.url.isFileURL ? stamp(file.url) : hashes[file.path]
                return file
            }
            // Where each side lives, for showing pictures.
            if file.status != .added { file.oldObject = (scope == .unstaged ? ":" : base + ":") + (file.oldPath ?? file.path) }
            if scope == .staged, file.status != .deleted { file.newObject = ":" + file.path }
            return file
        }
    }

    /// Why Discard leaves a submodule be, as a machine's box says it too.
    static func submoduleRefusal(_ path: String) -> String {
        "\(path) is a submodule: its changes are in its own repository, so discard them there."
    }

    static func perform(_ action: ProjectChanges.Action, on file: ChangedFile, root: String, scope: ProjectChanges.Scope) -> String? {
        let paths = [file.path] + (file.oldPath.map { [$0] } ?? [])
        // The file's own path, never a pattern: "app/[slug]/page.tsx" would match others, and
        // ":!x" every file but x.
        func on(_ arguments: [String]) -> String? { run(["--literal-pathspecs"] + arguments, in: root) }
        func git(_ arguments: [String]) -> String? {
            on(arguments) == nil ? "git couldn't \(arguments.first ?? "do that") \(file.path)." : nil
        }
        switch action {
        case .stage:
            // A rename's old path only while git still has it: once staged as moved, naming it fails.
            let old = file.oldPath.flatMap { on(["ls-files", "--error-unmatch", "--", $0]) != nil ? $0 : nil }
            return git(["add", "-A", "--", file.path] + (old.map { [$0] } ?? []))
        case .unstage:
            if on(["restore", "--staged", "--"] + paths) != nil { return nil }
            // A repository with no commits yet has nothing to go back to (`restore --staged`
            // fails there): out of what's staged, the file left as it is. Only when git says it
            // has none, not when it couldn't be asked (a machine's connection dropping).
            guard on(["rev-parse", "--git-dir"]) != nil, on(["rev-parse", "--verify", "-q", "HEAD"]) == nil else {
                return "git couldn't restore \(file.path)."
            }
            return git(["rm", "--cached", "-f", "-q", "--"] + paths)
        case .discard:
            // Out of git first, and only once that worked: a file still staged would go with the
            // next commit. `-f` for one staged and then changed again.
            func untrack(_ path: String) -> String? {
                on(["ls-files", "--error-unmatch", "--", path]) == nil ? nil : git(["rm", "--cached", "-f", "-q", "--", path])
            }
            // A folder where a file goes back (put in its place, a repository cloned there): git
            // would delete it, and all in it, for good. It goes to the Trash first. Not a
            // submodule that's one already, which git puts back by its commit and leaves be.
            func clear(_ paths: [String]) -> String? {
                for path in paths {
                    let url = RemoteFolder.url(root).appending(path: path)
                    // A file (or a link) where one of its folders goes back: the same.
                    if let blocking = fileInPlace(ofFoldersOf: path, in: root) {
                        do { try trash(blocking) } catch { return error.localizedDescription }
                        continue
                    }
                    guard isFolder(url) else { continue }
                    let kept = scope == .unstaged ? on(["ls-files", "-s", "--", path]) : on(["ls-tree", "HEAD", "--", path])
                    if kept?.hasPrefix("160000") == true { continue }
                    do { try trash(url) } catch { return error.localizedDescription }
                }
                return nil
            }
            // New to git (untracked, only staged, or only noted with `git add -N`): it has no
            // committed version to go back to, so the file goes to the Trash. (Restoring one only
            // noted would empty it.)
            if file.status == .added {
                if let failure = untrack(file.path) { return failure }
                do { try trash(file.url) } catch { return error.localizedDescription }
                return nil
            }
            // Moved: the new path goes as a new file does, and the old one comes back (from the
            // staged version for unstaged changes, where a move shows only through `add -N`).
            if file.status == .renamed, let old = file.oldPath {
                if let failure = untrack(file.path) ?? clear([old]) { return failure }
                if let failure = git(scope == .unstaged ? ["restore", "--worktree", "--", old] : ["restore", "--source=HEAD", "--staged", "--worktree", "--", old]) {
                    return failure
                }
                do { try trash(file.url) } catch { return error.localizedDescription }
                return nil
            }
            // A submodule with edits of its own: they're in its repository, and git's restore
            // leaves them as they are and says nothing, which read as done. (One moved to another
            // commit, or gone, goes back as before.)
            if file.status == .modified, on(["ls-files", "-s", "--", file.path])?.hasPrefix("160000") == true,
               let edits = run(["status", "--porcelain"], in: (root as NSString).appendingPathComponent(file.path)),
               !edits.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return submoduleRefusal(file.path)
            }
            if let failure = clear(scope == .unstaged ? paths : [file.path]) { return failure }
            if scope == .unstaged { return git(["restore", "--worktree", "--"] + paths) }
            return git(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path])
        }
    }

    /// A folder (not a link to one) is at `url`.
    private static func isFolder(_ url: URL) -> Bool {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType == .typeDirectory
    }

    /// The first of the folders `path` is in (in the repository at `root`) that is something else
    /// now, a file or a link: git would delete it to put the folder back.
    private static func fileInPlace(ofFoldersOf path: String, in root: String) -> URL? {
        let folders = path.split(separator: "/").dropLast().map(String.init)
        guard !folders.isEmpty else { return nil }
        var url = URL(filePath: root)
        for folder in folders {
            url = url.appending(path: folder)
            guard let type = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType else { return nil }
            if type != .typeDirectory { return url }
        }
        return nil
    }

    /// To the Trash.
    private static func trash(_ url: URL) throws {
        try FileManager.default.moveToTrash(url)
    }

    static func commitDiff(in directory: String, limit: Int = 40_000) -> String {
        var text: String
        if hasStaged(in: directory) {
            text = run(["diff", "--cached", "--no-color", "--no-ext-diff"], in: directory) ?? ""
        } else {
            // What committing would take: this folder's, as `commit` adds only it.
            text = run(["diff", "HEAD", "--no-color", "--no-ext-diff", "--", "."], in: directory) ?? ""
            let untracked = run(["ls-files", "--others", "--exclude-standard"], in: directory) ?? ""
            if !untracked.isEmpty { text += "\nNew files:\n" + untracked }
        }
        return text.count > limit ? String(text.prefix(limit)) + "\n…" : text
    }

    static func hasStaged(in directory: String) -> Bool {
        // `diff --quiet` fails when there are differences.
        run(["diff", "--cached", "--quiet"], in: directory) == nil
    }

    static func commit(message: String, push: Bool, in directory: String, environment: [String: String]) -> String? {
        guard let root = toplevel(of: directory) else { return "Not a git repository." }
        if !hasStaged(in: root) {
            let limit = relativePath(of: directory, in: root)
            if let failure = report(["add", "-A", "--", limit.isEmpty ? "." : limit], in: root, environment: environment) { return failure }
        }
        if let failure = report(["commit", "-m", message], in: root, environment: environment) { return failure }
        guard push else { return nil }
        var failure = report(["push"], in: root, environment: environment)
        // A new branch: push it and track it, as `git push -u` would.
        if failure?.contains("no upstream branch") == true {
            failure = report(["push", "-u", "origin", "HEAD"], in: root, environment: environment)
        }
        return failure.map { "Committed, but the push didn't go through:\n\($0)" }
    }

    /// Runs git for something that changes the repository; nil when it worked, else what git
    /// said. It never waits for a password: with nothing to answer, it fails instead. As long as
    /// it takes (a push, a commit's hooks), and what a hook leaves running doesn't hold it up.
    static func report(_ arguments: [String], in directory: String, environment: [String: String]) -> String? {
        var environment = environment.isEmpty ? ProcessInfo.processInfo.environment : environment
        environment["GIT_TERMINAL_PROMPT"] = "0"
        let result: ChildProcess.Result
        do { result = try run(git: arguments, in: directory, environment: environment, errors: .withOutput, limit: nil) } catch { return error.localizedDescription }
        guard !result.succeeded else { return nil }
        let text = result.outputText.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "git \(arguments.first ?? "") failed." : text
    }

    /// New files' lines, or binary or too big: this Mac's from its disk, a machine's from its box
    /// (`box`, by the machine's id), as a phone reads them, several at a time. `known`: those read
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

    /// A file on this Mac as it is now: its size and when it last changed, as a box stamps a
    /// machine's. nil when it can't be read (a broken link), so it's read each time.
    /// One changed in the last few seconds has none (as git treats one it can't be sure of): a
    /// disk that keeps times to the second could change it again, the same size, unseen.
    private static func stamp(_ url: URL) -> String? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
              let size = values.fileSize, let modified = values.contentModificationDate,
              Date().timeIntervalSince(modified) > 3 else { return nil }
        return "\(size)-\(modified.timeIntervalSinceReferenceDate)"
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

    static func relativePath(of directory: String, in root: String) -> String {
        if let folder = RemoteFolder.parse(directory), let top = RemoteFolder.parse(root) {
            guard folder.path.hasPrefix(top.path) else { return "" }
            return String(folder.path.dropFirst(top.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        let resolved = URL(filePath: directory).resolvingSymlinksInPath().path
        let base = URL(filePath: root).resolvingSymlinksInPath().path
        guard resolved.hasPrefix(base) else { return "" }
        return String(resolved.dropFirst(base.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    /// The repository's top folder, written the way `directory` is (on its machine, for a
    /// machine's folder), or nil when it isn't in one.
    static func toplevel(of directory: String) -> String? {
        guard let path = run(["rev-parse", "--show-toplevel"], in: directory)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !path.isEmpty else { return nil }
        return RemoteFolder.machine(of: directory).map { RemoteFolder.folder(path, on: $0) } ?? path
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
