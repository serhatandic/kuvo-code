import ClientChanges
import Foundation
import OpenCodeKit

/// Branches and worktrees: what a session in a worktree needs to start, and to bring its work
/// back (a merge, or a pull request).
nonisolated extension Git {
    /// The branch `directory` has checked out, or nil (no repository, or no branch).
    static func currentBranch(in directory: String) -> String? {
        let name = run(["symbolic-ref", "--quiet", "--short", "HEAD"], in: directory)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name : nil
    }

    /// Changes that aren't committed, new files included; and, when git can't say (a machine's
    /// connection dropped), as if there were, so nothing is thrown away on a guess.
    /// New files count whatever git's settings say, as the Changes panel lists them.
    /// `includingHidden`: also changes in submodules their `ignore` setting leaves out, for
    /// before a worktree is removed, which would delete them unasked.
    static func hasUncommittedChanges(in directory: String, includingHidden: Bool = false) -> Bool {
        uncommittedChanges(in: directory, includingHidden: includingHidden) ?? true
    }

    /// The same, or nil when git can't say.
    static func uncommittedChanges(in directory: String, includingHidden: Bool = false) -> Bool? {
        let hidden = ["--untracked-files=normal"] + (includingHidden ? ["--ignore-submodules=none"] : [])
        return run(["status", "--porcelain"] + hidden, in: directory).map { !$0.isEmpty }
    }

    /// How many commits `directory`'s branch has that `base` doesn't; nil when git can't say (its
    /// base is gone, a machine's connection dropped).
    static func commitsAhead(of base: String, in directory: String) -> Int? {
        run(["rev-list", "--count", base + "..HEAD"], in: directory).flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    enum MergeResult: Equatable, Sendable {
        case merged
        /// Nothing changed: the merge stopped on these files.
        case conflict([String])
        case failed(String)
    }

    /// Merges `branch` into what `directory` has checked out. A merge that conflicts is
    /// taken back, so the folder is as it was.
    static func merge(_ branch: String, into directory: String, environment: [String: String]) -> MergeResult {
        // One you're in the middle of there is yours: never taken back with this one.
        if run(["rev-parse", "-q", "--verify", "MERGE_HEAD"], in: directory) != nil {
            return .failed("The project’s folder is in the middle of a merge. Finish it there first.")
        }
        guard let failure = report(["merge", "--no-edit", branch], in: directory, environment: environment) else { return .merged }
        // By their names as they are: not quoted or escaped, whatever letters are in them.
        let conflicted = (run(["-c", "core.quotepath=off", "diff", "--name-only", "-z", "--diff-filter=U"], in: directory) ?? "").split(separator: "\0").map(String.init)
        // Stopped partway for another reason (a hook, signing the commit): taken back too, or the
        // folder stays in the middle of a merge.
        if run(["rev-parse", "-q", "--verify", "MERGE_HEAD"], in: directory) != nil {
            _ = report(["merge", "--abort"], in: directory, environment: environment)
        }
        return conflicted.isEmpty ? .failed(failure) : .conflict(conflicted)
    }
}

/// Create Pull Request, on the box the project is on, as a phone asks it: its confirmation first
/// (`kuvo/git/pull-request/draft`), then the box pushes the branch and creates it with `gh`, or
/// gives the host's page when `gh` isn't signed in there.
nonisolated enum PullRequests {
    enum Made: Equatable, Sendable {
        /// Made on the host (or one already open for the branch).
        case made(URL)
        /// Pushed; this page creates it, its title and description filled in.
        case toOpen(URL)
        /// Pushed, to a host the box can't open one on.
        case pushed
    }

    /// `withSummary`: with what the branch brings, for a model to write them from.
    static func draft(on box: BoxClient, directory: String, withSummary: Bool = false) async throws -> PullRequestDraft {
        struct Asked: Encodable { let directory: String; let summary: Bool }
        return try await box.value(PullRequestDraft.self, "POST", "kuvo/git/pull-request/draft", body: Asked(directory: directory, summary: withSummary))
    }

    /// `session`: the one it's made from (the one in view), whose pull request it is from now on, on
    /// its row and card.
    static func create(on box: BoxClient, directory: String, title: String, body: String, session: String? = nil) async throws -> Made {
        struct Asked: Encodable { let directory, title, body: String; let session: String? }
        struct Answer: Decodable { var url: String?; var compareURL: String? }
        let made = try await box.value(Answer.self, "POST", "kuvo/git/pull-request", body: Asked(directory: directory, title: title, body: body, session: session))
        if let url = made.url.flatMap(URL.init(string:)) { return .made(url) }
        if let page = made.compareURL.flatMap(URL.init(string:)) { return .toOpen(page) }
        return .pushed
    }
}

/// Bringing a worktree session's work back: Merge in its Changes panel.
nonisolated extension Workspace.Worktree {
    enum MergeOutcome: Equatable, Sendable {
        case merged(into: String)
        /// Nothing changed: the merge stopped on these files.
        case conflict([String], into: String)
        case failed(String)
    }

    /// Merges what's committed on the worktree's branch (`directory` is the session's folder in
    /// it) into the project's folder, on the branch it was made from.
    func mergeBack(from directory: String, environment: [String: String]) -> MergeOutcome {
        guard let target = Git.currentBranch(in: project) else { return .failed("The project’s folder isn’t on a branch.") }
        if let base, target != base {
            return .failed("The project’s folder is on \(target) now. Switch it back to \(base) to merge, or create a pull request.")
        }
        if let reason = unready(in: directory, against: target) { return .failed(reason) }
        return switch Git.merge(branch, into: project, environment: environment) {
        case .merged: .merged(into: target)
        case .conflict(let files): .conflict(files, into: target)
        case .failed(let message): .failed(message)
        }
    }

    /// Why the work can't go anywhere yet, if it can't.
    func unready(in directory: String, against target: String) -> String? {
        if Git.hasUncommittedChanges(in: directory) { return "Commit the changes first. Only what’s committed goes." }
        if Git.commitsAhead(of: target, in: directory) == 0 { return "\(branch) has nothing \(target) doesn’t have yet." }
        return nil
    }
}

/// What git said when it refused.
struct GitFailure: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// Settings › Git: how branches are named, and what you'd like commit messages and pull requests
/// written like.
nonisolated enum GitPreferences {
    static let branchPrefixKey = "git.branchPrefix"
    static let commitInstructionsKey = "git.commitInstructions"
    static let pullRequestInstructionsKey = "git.pullRequestInstructions"
    static let defaultBranchPrefix = "kuvo/"

    /// What a session's own branch starts with ("kuvo/").
    /// As git takes it in a branch's name: without spaces around it (one typed at the end of
    /// the field doesn't show), the characters a branch can't have (~ ^ : ? * [ \), "..", or a
    /// start in - / or .; else every worktree's branch would fail to be made.
    static var branchPrefix: String {
        let typed = UserDefaults.standard.string(forKey: branchPrefixKey) ?? defaultBranchPrefix
        var prefix = typed.trimmingCharacters(in: .whitespacesAndNewlines).filter { character in
            !" ~^:?*[\\".contains(character) && !character.isWhitespace && !(character.asciiValue.map { $0 < 32 || $0 == 127 } ?? false)
        }
        while prefix.contains("..") { prefix = prefix.replacingOccurrences(of: "..", with: ".") }
        while let first = prefix.first, "-/.".contains(first) { prefix.removeFirst() }
        return prefix
    }

    /// A prompt for a commit message or pull request, with your instructions for it added.
    static func prompt(_ prompt: String, instructionsKey: String) -> String {
        let instructions = (UserDefaults.standard.string(forKey: instructionsKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instructions.isEmpty else { return prompt }
        return prompt + "\n\nAlso follow these instructions from the user:\n" + instructions
    }
}
