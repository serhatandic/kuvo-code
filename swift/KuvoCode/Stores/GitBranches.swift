import ClientChanges
import Foundation
import OpenCodeKit

/// The repository a folder is in, as the box it's on says (`kuvo/git/branches`, `kuvo/git/status`),
/// and switching its branch there (`kuvo/git/switch`), as a phone would ask: the title bar's branch
/// menu, Edit Project's worktree setup, and what Delete says goes with a worktree.
nonisolated extension Git {
    /// A folder's repository, as its box lists it for a branch menu.
    struct Branches: Decodable, Equatable, Sendable {
        /// In a repository at all.
        var repository: Bool
        /// The branch checked out; nil on none, or outside a repository.
        var current: String?
        /// Its branches, the latest commit first.
        var branches: [String]

        init(repository: Bool, current: String? = nil, branches: [String] = []) {
            (self.repository, self.current, self.branches) = (repository, current, branches)
        }

        init(from decoder: any Decoder) throws {
            enum Keys: String, CodingKey { case repository, current, branches }
            let container = try decoder.container(keyedBy: Keys.self)
            repository = try container.decode(Bool.self, forKey: .repository)
            current = try container.decodeIfPresent(String.self, forKey: .current)
            branches = try container.decodeIfPresent([String].self, forKey: .branches) ?? []
        }
    }

    private struct InFolder: Encodable { let directory: String }

    /// The folder's repository and its branches; nil when its box couldn't say. While this Mac's box
    /// is starting (with the app, or again after an update), asked again each `pause`, for as long
    /// as it says so (a minute at most), as the Changes panel waits for it.
    @concurrent static func branches(at place: GitPlace, pause: Duration = .seconds(1)) async -> Branches? {
        let asked = try? JSONEncoder().encode(InFolder(directory: place.path))
        var answer = try? await place.client.send("POST", "kuvo/git/branches", body: asked)
        while let (status, data) = answer, status == 503, BoxRefusal(status: status, data: data).reason == "starting", !Task.isCancelled {
            try? await Task.sleep(for: pause)
            answer = try? await place.client.send("POST", "kuvo/git/branches", body: asked)
        }
        // (A box held for its update, #679, or one that couldn't say: none listed.)
        guard let (status, data) = answer, !Task.isCancelled, (200..<300).contains(status) else { return nil }
        return try? JSONDecoder().decode(Branches.self, from: data)
    }

    /// Switches the folder's repository to `branch`, or (`creating`) to a new one from where it is,
    /// on its box, its hooks run there as in your terminal; nil when it went, else why not (a box
    /// held for its update says so, #679).
    @concurrent static func switching(to branch: String, creating: Bool, at place: GitPlace) async -> String? {
        struct Asked: Encodable { let directory, branch: String; let create: Bool }
        do {
            let (status, data) = try await place.client.send("POST", "kuvo/git/switch", body: JSONEncoder().encode(Asked(directory: place.path, branch: branch, create: creating)))
            if (200..<300).contains(status) { return nil }
            return BoxRefusal(status: status, data: data).message
        } catch {
            return place.unreachable(error)
        }
    }

    /// Whether anything in the folder's repository isn't committed, as its box says: changes, new
    /// files git doesn't ignore, and changes in submodules whatever their `ignore` setting (which
    /// removing a worktree would delete unasked). When it can't say (its box away, the folder not a
    /// repository now), as if there were, so nothing is thrown away on a guess.
    @concurrent static func hasUncommittedChanges(at place: GitPlace) async -> Bool {
        struct Answer: Decodable { let repository: Bool; let uncommitted: Bool? }
        guard let (status, data) = try? await place.client.send("POST", "kuvo/git/status", body: JSONEncoder().encode(InFolder(directory: place.path))),
              (200..<300).contains(status),
              let answer = try? JSONDecoder().decode(Answer.self, from: data), answer.repository else { return true }
        return answer.uncommitted ?? true
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