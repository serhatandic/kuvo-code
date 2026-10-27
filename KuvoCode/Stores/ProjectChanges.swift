import ClientDesign
import Foundation
import OpenCodeKit
import UniformTypeIdentifiers

/// One changed file, parsed from a unified diff: every line it shows, with its numbers
/// on each side. Git is asked for the whole file as context, so unchanged stretches can
/// be folded and opened again without another call.
nonisolated struct ChangedFile: Identifiable, Hashable, Sendable {
    enum Status: Sendable { case added, deleted, modified, renamed }

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
    /// A new file on a machine, listed but not read yet: its box sends it (`Git.readNew`).
    var unread = false

    var id: String { path }

    /// Pictures get a before and after instead of lines.
    var isImage: Bool {
        UTType(filenameExtension: (path as NSString).pathExtension)?.conforms(to: .image) == true
    }
    var additions: Int { lines.count { $0.kind == .added } }
    var deletions: Int { lines.count { $0.kind == .removed } }
}

nonisolated struct DiffLine: Hashable, Sendable {
    enum Kind: Sendable { case context, added, removed }
    var kind: Kind
    var oldNumber: Int?
    var newNumber: Int?
    var text: String
    /// Unchanged lines git left out between two hunks (only with very long files).
    var gapBefore = false
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
    var scope = Scope.uncommitted
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
    private var signature = 0

    init(directory: String) {
        self.directory = directory
    }

    var additions: Int { files.reduce(0) { $0 + $1.additions } }
    var deletions: Int { files.reduce(0) { $0 + $1.deletions } }

    /// Reads the changes again. `fallback` is the engine's diff, used outside a repository, or
    /// when it's empty there (the engine keeps no snapshots outside one), `edits`: the files the
    /// session's edits changed.
    func refresh(fallback: [FileDiff] = [], edits: [FileDiff] = []) async {
        let directory = directory, scope = scope, base = base
        if scope == .session {
            hasUncommitted = false
            apply(fallback.map { DiffParser.file(from: $0, directory: directory) })
            isLoaded = true
            return
        }
        let (result, uncommitted) = await Task.detached {
            (Git.changes(in: directory, scope: scope, base: base), scope != .branch || Git.hasUncommittedChanges(in: directory))
        }.value
        if let result {
            isRepository = true
            if hasUncommitted != uncommitted { hasUncommitted = uncommitted }
            apply(await Git.readNew(result))
        } else {
            isRepository = false
            apply((fallback.isEmpty ? edits : fallback).map { DiffParser.file(from: $0, directory: directory) })
        }
        isLoaded = true
    }

    enum Action { case stage, unstage, discard }

    /// Stages, unstages or discards one file's changes, then reads the changes again. Discard
    /// follows the scope: in Unstaged only what isn't staged, otherwise back to the last commit.
    /// A file git doesn't know yet goes to the Trash. Returns git's complaint, if any.
    func perform(_ action: Action, on file: ChangedFile) async -> String? {
        guard let root = file.root else { return nil }
        let scope = scope
        let failure = await Task.detached { Git.perform(action, on: file, root: root, scope: scope) }.value
        await refresh()
        return failure
    }

    /// Commits what's staged, or everything in the project's folder when nothing is, and
    /// pushes if asked. Returns git's complaint, if any. `environment` is your shell's, so
    /// hooks, signing and pushing see what they do in Terminal.
    func commit(message: String, push: Bool, environment: [String: String]) async -> String? {
        let directory = directory
        let failure = await Task.detached { Git.commit(message: message, push: push, in: directory, environment: environment) }.value
        if failure == nil { Analytics.shared.track("changes_committed", ["pushed": push]) }
        await refresh()
        return failure
    }

    /// The diff a commit would take (what's staged, or everything with new files' names),
    /// cut to a size a model reads quickly.
    func commitDiff() async -> String {
        let directory = directory
        return await Task.detached { Git.commitDiff(in: directory) }.value
    }

    /// Whether anything is staged, which is what a commit takes then.
    func hasStaged() async -> Bool {
        let directory = directory
        return await Task.detached { Git.hasStaged(in: directory) }.value
    }

    /// Only publishes when something changed, so a refresh doesn't redraw the panel.
    private func apply(_ files: [ChangedFile]) {
        let signature = files.hashValue
        guard signature != self.signature else { return }
        self.signature = signature
        self.files = files
    }
}

// MARK: - Git

nonisolated enum Git {
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
        // paths are read after them.
        var arguments = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U100000"]
        switch scope {
        // The session's edits come from the engine, not git; read like Uncommitted here.
        case .uncommitted, .branch, .session: arguments.append(base)
        case .unstaged: break
        case .staged: arguments += ["--cached", base]
        }
        arguments += ["--", limit.isEmpty ? "." : limit]
        guard let patch = run(arguments, in: root) else { return nil }
        var files = DiffParser.files(from: patch, root: root).map { file in
            // Where each side lives, for showing pictures.
            var file = file
            file.root = root
            if file.status != .added { file.oldObject = (scope == .unstaged ? ":" : base + ":") + (file.oldPath ?? file.path) }
            if scope == .staged, file.status != .deleted { file.newObject = ":" + file.path }
            return file
        }
        // A file that changed kind (a file now a link, or back) comes as two, gone and new: one
        // here, changed, so Discard puts it back rather than throwing the new one away.
        var seen: [String: Int] = [:]
        var merged: [ChangedFile] = []
        for file in files {
            guard let i = seen[file.path] else { seen[file.path] = merged.count; merged.append(file); continue }
            merged[i].status = .modified
            merged[i].lines += file.lines
            merged[i].isBinary = merged[i].isBinary || file.isBinary
            merged[i].isFolder = merged[i].isFolder || file.isFolder
            merged[i].isTooBig = merged[i].isTooBig || file.isTooBig
            if merged[i].isTooBig { merged[i].lines = [] }
            merged[i].oldObject = merged[i].oldObject ?? file.oldObject
            merged[i].newObject = merged[i].newObject ?? file.newObject
        }
        files = merged
        if scope != .staged {
            let untracked = run(["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z", "--", limit.isEmpty ? "." : limit], in: root) ?? ""
            for path in untracked.split(separator: "\0").map(String.init) where !files.contains(where: { $0.path == path }) {
                files.append(newFile(path, root: root))
            }
        }
        return files.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
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
            if let failure = clear(scope == .unstaged ? paths : [file.path]) { return failure }
            if scope == .unstaged { return git(["restore", "--worktree", "--"] + paths) }
            return git(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path])
        }
    }

    /// A folder (not a link to one) is at `url`; on a machine that can't be asked, as if one were,
    /// so nothing is deleted on a guess.
    private static func isFolder(_ url: URL) -> Bool {
        if url.isFileURL { return (try? FileManager.default.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType == .typeDirectory }
        return RemoteShell.isFolder(url) ?? true
    }

    /// The first of the folders `path` is in (in the repository at `root`) that is something else
    /// now, a file or a link: git would delete it to put the folder back.
    private static func fileInPlace(ofFoldersOf path: String, in root: String) -> URL? {
        let folders = path.split(separator: "/").dropLast().map(String.init)
        guard !folders.isEmpty else { return nil }
        var url = RemoteFolder.url(root)
        // On a machine, every level in one go: something else there, or nothing (then nothing
        // below it either).
        if !url.isFileURL, let (machine, base) = RemoteFolder.parse(url) {
            var levels: [String] = []
            for folder in folders { levels.append((levels.last.map { $0 + "/" } ?? "") + folder) }
            guard let data = RemoteShell.run(fileInPlaceScript(base: base, levels: levels), on: machine), !data.isEmpty else { return nil }
            return url.appending(path: String(decoding: data, as: UTF8.self))
        }
        for folder in folders {
            url = url.appending(path: folder)
            guard let type = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType else { return nil }
            if type != .typeDirectory { return url }
        }
        return nil
    }

    /// Of `levels` (folders in `base`, each inside the one before), the first that's a file or a
    /// link now, as it says it; nothing when they're all folders, or one isn't there.
    static func fileInPlaceScript(base: String, levels: [String]) -> String {
        """
        cd \(SSHConnection.quoted(base)) || exit 0
        for d in \(levels.map(SSHConnection.quoted).joined(separator: " ")); do
          if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then printf '%s' "$d"; exit 0; fi
          [ -d "$d" ] || exit 0
        done
        """
    }

    /// To the Trash on this Mac; on a machine, which has none, to `~/.kuvo-code/trash` there.
    private static func trash(_ url: URL) throws {
        if url.isFileURL { return try FileManager.default.moveToTrash(url) }
        if let failure = RemoteShell.trash(url) { throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: failure]) }
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

    /// An untracked file, as all-new lines. A machine's is read afterwards, from its box
    /// (`readNew`), as a phone reads it.
    private static func newFile(_ path: String, root: String) -> ChangedFile {
        let url = RemoteFolder.url(root).appending(path: path)
        var file = ChangedFile(path: path, status: .added, url: url)
        file.root = root
        // git names a repository inside this one by its folder: "web/".
        file.isFolder = path.hasSuffix("/")
        guard url.isFileURL else {
            file.unread = !file.isFolder
            return file
        }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        file.isTooBig = size > 2_000_000
        if !file.isTooBig { fill(&file, with: try? Data(contentsOf: url)) }
        return file
    }

    /// A machine's new files, read from its box (`box`, by the machine's id): their lines, or binary
    /// or too big, as this Mac's are.
    static func readNew(_ files: [ChangedFile], box: (String) -> BoxClient = BoxClient.machine) async -> [ChangedFile] {
        var read = files
        for index in read.indices where read[index].unread {
            read[index].unread = false
            guard let (machine, path) = RemoteFolder.parse(read[index].url) else { continue }
            do {
                fill(&read[index], with: try await box(machine).file(path, max: 2_000_000))
            } catch let refusal as BoxRefusal where refusal.status == 413 {
                read[index].isTooBig = true
            } catch {
                read[index].isBinary = true
            }
        }
        return read
    }

    /// A new file's lines from its bytes: binary when they aren't text, too big past what's read through.
    private static func fill(_ file: inout ChangedFile, with data: Data?) {
        guard let data, !data.contains(0),
              let text = String(data: data, encoding: .utf8) else {
            file.isBinary = true
            return
        }
        var lines = DiffParser.lines(of: text).map(String.init)
        if lines.last == "" { lines.removeLast() }
        // Too big to read through, as a changed one is.
        if lines.count > DiffParser.maxLines || lines.contains(where: { $0.utf8.count > DiffParser.maxLineLength }) {
            file.isTooBig = true
            return
        }
        file.lines = lines.enumerated().map { DiffLine(kind: .added, newNumber: $0 + 1, text: $1) }
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
            let ssh = SSHConnection(destination: remote.machine).arguments(running: "cd \(SSHConnection.quoted(remote.path)) && \(command)")
            return try ChildProcess.runBlocking("/usr/bin/ssh", ssh, errors: errors, limit: limit)
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

nonisolated enum DiffParser {
    /// Every file in `git diff` output.
    static func files(from patch: String, root: String) -> [ChangedFile] {
        var files: [ChangedFile] = []
        var current: ChangedFile?
        var oldLine = 0, newLine = 0, sawHunk = false
        // Set when git left unchanged lines out before the next line (between hunks).
        var pendingGap = false

        func finish() { if let current { files.append(current) } }

        // How many sides a line's marks are for: two in a conflicted file's combined diff.
        var sides = 1
        for raw in lines(of: patch) {
            let line = String(raw)
            if line.hasPrefix("diff --git ") || line.hasPrefix("diff --cc ") {
                finish()
                let combined = line.hasPrefix("diff --cc ")
                let path = combined ? self.path(line.dropFirst("diff --cc ".count)) : pathFromHeader(line)
                current = ChangedFile(path: path, status: .modified, url: RemoteFolder.url(root).appending(path: path))
                sides = combined ? 2 : 1
                sawHunk = false
                continue
            }
            guard var file = current else { continue }
            defer { current = file }
            if line.hasPrefix("@@") {
                let numbers = sides > 1 ? combinedHunkStarts(line) : hunkStarts(line)
                oldLine = numbers.old
                newLine = numbers.new
                pendingGap = sawHunk || (numbers.old > 1 && numbers.new > 1)
                sawHunk = true
                continue
            }
            if !sawHunk {
                if line.hasPrefix("new file mode") { file.status = .added; file.isFolder = line.hasSuffix(" 160000") }
                else if line.hasPrefix("deleted file mode") { file.status = .deleted }
                else if line.hasPrefix("rename from ") { file.oldPath = path(line.dropFirst("rename from ".count)); file.status = .renamed }
                else if line.hasPrefix("rename to ") {
                    file.path = path(line.dropFirst("rename to ".count))
                    file.url = RemoteFolder.url(root).appending(path: file.path)
                }
                else if line.hasPrefix("Binary files ") { file.isBinary = true }
                continue
            }
            guard let first = line.first else { continue }
            var parsed: DiffLine
            if sides > 1 {
                // "++", " +", "- " …: a mark for each side, the file as it is after them.
                let marks = line.prefix(sides)
                guard marks.count == sides, marks.allSatisfy({ "+- ".contains($0) }) else { continue }
                let text = String(line.dropFirst(sides))
                if marks.contains("-") { parsed = DiffLine(kind: .removed, oldNumber: oldLine, text: text); oldLine += 1 }
                else if marks.contains("+") { parsed = DiffLine(kind: .added, newNumber: newLine, text: text); newLine += 1 }
                else { parsed = DiffLine(kind: .context, oldNumber: oldLine, newNumber: newLine, text: text); oldLine += 1; newLine += 1 }
            } else {
                switch first {
                case "+": parsed = DiffLine(kind: .added, newNumber: newLine, text: String(line.dropFirst())); newLine += 1
                case "-": parsed = DiffLine(kind: .removed, oldNumber: oldLine, text: String(line.dropFirst())); oldLine += 1
                case " ": parsed = DiffLine(kind: .context, oldNumber: oldLine, newNumber: newLine, text: String(line.dropFirst())); oldLine += 1; newLine += 1
                default: continue  // "\ No newline at end of file"
                }
            }
            if pendingGap { parsed.gapBefore = true; pendingGap = false }
            file.lines.append(parsed)
        }
        finish()
        // A file too big to read through (a huge or minified one): named, not shown.
        for index in files.indices where files[index].lines.count > maxLines || files[index].lines.contains(where: { $0.text.utf8.count > maxLineLength }) {
            files[index].lines = []
            files[index].isTooBig = true
        }
        return files
    }

    static let maxLines = 20_000
    static let maxLineLength = 20_000

    /// Text's lines, ending at "\n" or "\r\n" (which Swift counts as one character, so a split
    /// at "\n" alone left a file with Windows line endings in one piece).
    static func lines(of text: String) -> [Substring] {
        text.split(omittingEmptySubsequences: false) { $0 == "\n" || $0 == "\r\n" }
    }

    /// The engine's diff of one file (patch text, a few lines of context).
    static func file(from diff: FileDiff, directory: String) -> ChangedFile {
        // The engine names files by their paths where it runs: on a machine, plain paths there.
        let plain = RemoteFolder.parse(directory)?.path ?? directory
        let base = plain.hasSuffix("/") ? plain : plain + "/"
        let path = diff.file.hasPrefix(base) ? String(diff.file.dropFirst(base.count)) : diff.file
        let url = RemoteFolder.fileURL(diff.file, in: directory)
        // The engine's patches may come with git's header already; a second one would read as an
        // empty file before this one.
        let patch = diff.patch.hasPrefix("diff --git ") ? diff.patch : "diff --git a/\(path) b/\(path)\n" + diff.patch
        let parsed = files(from: patch, root: directory).first
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

    /// "diff --git a/x b/x" → "x": the b side. A name git quotes ("a/say \"hi\".txt", one with a
    /// tab or a backslash) is read as git wrote it; one with " b/" in it ("Plan b/notes.md") by
    /// both sides being the same. (A rename's own lines name its paths.)
    static func pathFromHeader(_ line: String) -> String {
        let rest = line.dropFirst("diff --git ".count)
        if rest.hasPrefix("\""), let (first, end) = unquoted(rest) {
            let second = rest[end...].drop { $0 == " " }
            let path = second.hasPrefix("\"") ? unquoted(second)?.text ?? String(second) : String(second)
            return path.hasPrefix("b/") ? String(path.dropFirst(2)) : first.hasPrefix("a/") ? String(first.dropFirst(2)) : path
        }
        if rest.hasSuffix("\""), let range = rest.range(of: " \"b/", options: .backwards), let (path, _) = unquoted(rest[rest.index(after: range.lowerBound)...]) {
            return String(path.dropFirst(2))
        }
        // "a/X b/X": X is half of what's left.
        let half = (rest.count - 5) / 2
        if rest.count % 2 == 1, half > 0, rest.hasPrefix("a/"), rest.dropFirst(2).prefix(half) == rest.suffix(half), rest.dropFirst(2 + half).hasPrefix(" b/") {
            return String(rest.suffix(half))
        }
        if let range = rest.range(of: " b/", options: .backwards) {
            return String(rest[range.upperBound...])
        }
        return String(rest)
    }

    /// A path from a line git may have quoted ("rename to", "diff --cc"): as it is, or unquoted.
    static func path(_ text: some StringProtocol) -> String {
        text.hasPrefix("\"") ? unquoted(text)?.text ?? String(text) : String(text)
    }

    /// The name in a C-style quoted string at the start of `text`, as git writes one ("\"", "\\",
    /// "\t", "\303\251"), and where the string ends; nil when it isn't one.
    private static func unquoted<S: StringProtocol>(_ text: S) -> (text: String, end: S.Index)? {
        guard text.first == "\"" else { return nil }
        var bytes: [UInt8] = []
        var index = text.index(after: text.startIndex)
        while index < text.endIndex {
            let character = text[index]
            if character == "\"" { return (String(decoding: bytes, as: UTF8.self), text.index(after: index)) }
            guard character == "\\" else {
                bytes += Array(String(character).utf8)
                index = text.index(after: index)
                continue
            }
            index = text.index(after: index)
            guard index < text.endIndex else { return nil }
            let escaped = text[index]
            if let digit = escaped.wholeNumberValue, digit < 8 {
                // Three octal digits: one byte of the name's UTF-8.
                var value = 0
                var digits = 0
                while digits < 3, index < text.endIndex, let next = text[index].wholeNumberValue, next < 8 {
                    value = value * 8 + next
                    digits += 1
                    index = text.index(after: index)
                }
                bytes.append(UInt8(truncatingIfNeeded: value))
                continue
            }
            let known: [Character: UInt8] = ["a": 7, "b": 8, "t": 9, "n": 10, "v": 11, "f": 12, "r": 13, "\"": 34, "\\": 92]
            bytes.append(known[escaped] ?? Array(String(escaped).utf8).first ?? 0)
            index = text.index(after: index)
        }
        return nil
    }

    /// "@@@ -12,7 -12,8 +12,9 @@@" → (12, 12): the first side, and the file as it is.
    private static func combinedHunkStarts(_ line: String) -> (old: Int, new: Int) {
        let parts = line.split(separator: " ")
        func start(_ part: Substring?) -> Int {
            guard let part else { return 1 }
            return max(part.dropFirst().split(separator: ",").first.flatMap { Int($0) } ?? 1, 1)
        }
        return (start(parts.first { $0.hasPrefix("-") }), start(parts.first { $0.hasPrefix("+") }))
    }

    /// "@@ -12,7 +12,9 @@" → (12, 12).
    private static func hunkStarts(_ line: String) -> (old: Int, new: Int) {
        let parts = line.split(separator: " ")
        func start(_ part: Substring?) -> Int {
            guard let part else { return 1 }
            let number = part.dropFirst().split(separator: ",").first.flatMap { Int($0) } ?? 1
            return max(number, 1)
        }
        return (start(parts.dropFirst().first), start(parts.dropFirst(2).first))
    }
}
