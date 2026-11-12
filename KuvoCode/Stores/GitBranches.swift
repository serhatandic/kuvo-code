import ClientChanges
import Foundation
import OpenCodeKit

/// Whether a worktree has changes before Delete says what goes with it: one of what's left of git
/// run by this app (`Git.run`), with the title bar's branches and the file list.
nonisolated extension Git {
    /// Changes that aren't committed, new files included; and, when git can't say (a machine's
    /// connection dropped), as if there were, so nothing is thrown away on a guess.
    /// New files count whatever git's settings say, as the Changes panel lists them.
    /// `includingHidden`: also changes in submodules their `ignore` setting leaves out, for
    /// before a worktree is removed, which would delete them unasked.
    static func hasUncommittedChanges(in directory: String, includingHidden: Bool = false) -> Bool {
        let hidden = ["--untracked-files=normal"] + (includingHidden ? ["--ignore-submodules=none"] : [])
        return run(["status", "--porcelain"] + hidden, in: directory).map { !$0.isEmpty } ?? true
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

    /// `withPrompt`: with what a model is asked to write them from, in the box's words with your
    /// instructions on that computer.
    static func draft(on box: BoxClient, directory: String, withPrompt: Bool = false) async throws -> PullRequestDraft {
        struct Asked: Encodable { let directory: String; let prompt: Bool }
        return try await box.value(PullRequestDraft.self, "POST", "kuvo/git/pull-request/draft", body: Asked(directory: directory, prompt: withPrompt))
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

/// Bringing a worktree session's work back: Merge in its Changes panel, on the box the worktree is
/// on (`kuvo/git/merge`), as a phone asks it.
nonisolated extension Workspace.Worktree {
    enum MergeOutcome: Equatable, Sendable {
        case merged(into: String)
        /// Nothing changed: the merge stopped on these files.
        case conflict([String], into: String)
        case failed(String)
    }

    /// Merges what's committed on the worktree's branch (`place`: the session's folder in it) into
    /// the branch it was made from, in the project's folder. Its box says whether it can go (the
    /// project's folder on that branch and not in the middle of a merge of yours, the work
    /// committed, something new in it), and takes back a merge that conflicts. `author`: your
    /// shell's git author, for a merge commit.
    @concurrent func mergeBack(at place: GitPlace, author: [String: String]) async -> MergeOutcome {
        struct Asked: Encodable { let directory: String; let into: String?; let author: [String: String] }
        struct Answer: Decodable { var into: String?; var message: String?; var conflicts: [String]? }
        // Without a branch it was made from, its box picks: the one the project's folder is on.
        let asked = Asked(directory: place.path, into: base, author: author)
        do {
            let (status, data) = try await place.client.send("POST", "kuvo/git/merge", body: JSONEncoder().encode(asked))
            let answer = try? JSONDecoder().decode(Answer.self, from: data)
            let into = answer?.into ?? base ?? "the project’s branch"
            if (200..<300).contains(status) { return .merged(into: into) }
            if let conflicts = answer?.conflicts, !conflicts.isEmpty { return .conflict(conflicts, into: into) }
            // A box from before Merge into… (bridge 0.9.143) has no such route. (A machine takes this
            // Mac's as it connects, so only one not connected since.)
            // (Nor, from before #341, one without a branch named.)
            if status == 404 && answer?.message == nil || status == 400 && base == nil {
                return .failed("\(place.machine ?? "This Mac’s box") needs a newer Kuvo Code to merge. It updates by itself overnight, or connect to it from this Mac.")
            }
            return .failed(BoxRefusal(status: status, data: data).message)
        } catch {
            return .failed(place.unreachable(error))
        }
    }
}

/// What git said when it refused.
struct GitFailure: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// What a model is asked to write a commit message from, as the box the project is on words it
/// (`kuvo/git/commit-diff`): what the commit takes, with your instructions on that computer
/// (Settings › Git).
nonisolated enum CommitMessages {
    enum Failure: LocalizedError {
        case nothing
        case olderBox(String)
        var errorDescription: String? {
            switch self {
            case .nothing: "There’s nothing to commit to write a message from."
            case .olderBox(let place): "\(place) needs a newer Kuvo Code to suggest a message. It updates by itself overnight, or connect to it from this Mac."
            }
        }
    }

    /// `place`: the computer, as a refusal names it.
    static func prompt(on box: BoxClient, directory: String, place: String) async throws -> String {
        struct Asked: Encodable { let directory: String; let prompt = true }
        struct Answer: Decodable { let diff: String; let prompt: String? }
        let answer = try await box.value(Answer.self, "POST", "kuvo/git/commit-diff", body: Asked(directory: directory))
        guard !answer.diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Failure.nothing }
        guard let prompt = answer.prompt else { throw Failure.olderBox(place) }
        return prompt
    }
}

/// Settings › Git as this Mac kept it before each computer kept its own (`kuvo/config`'s
/// `branch_prefix`, `commit_instructions`, `pull_request_instructions`): given to each box once.
nonisolated enum GitPreferences {
    static let branchPrefixKey = "git.branchPrefix"
    static let commitInstructionsKey = "git.commitInstructions"
    static let pullRequestInstructionsKey = "git.pullRequestInstructions"

    // COMPAT(0.7 mac-git-settings): this Mac's Settings › Git from before, given to each box once (its box keeps each where it has none of its own); kept here for a computer added later. Goes 3 months after 0.8.0.
    /// Gives `box` this Mac's, when there are any, as it starts or connects: the box takes them
    /// the first time only (one made again later, under the same name too, takes them anew), and
    /// one that couldn't (its settings not its own yet, not reached) is given them next time.
    static func move(to box: BoxClient, defaults: UserDefaults = .standard) async {
        let kept = [("branchPrefix", branchPrefixKey), ("commitInstructions", commitInstructionsKey), ("pullRequestInstructions", pullRequestInstructionsKey)]
            .compactMap { name, key in defaults.string(forKey: key).map { (name, $0) } }
        guard !kept.isEmpty else { return }
        struct Answer: Decodable { let moved: Bool }
        _ = try? await box.value(Answer.self, "POST", "kuvo/git/settings/move", body: Dictionary(uniqueKeysWithValues: kept))
    }
}