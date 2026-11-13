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

    /// Switching branches on this Mac while Kuvo Code finishes an update: its background service
    /// moves to the new version once the work that's running ends.
    static let switchAfterUpdate = "Kuvo Code on this Mac is finishing an update. Switching branches works again once the work that’s running now ends; try again then."
    /// Switching branches where this Mac is attached in place to a box from before it.
    static let switchNeedsNewerService = "Kuvo Code’s background service on this Mac needs a newer version to switch branches. It updates by itself overnight."

    /// Whether a box answered as one from before the route: `404` with nothing to say (a folder
    /// that isn't there says why).
    static func lacksRoute(_ status: Int, _ data: Data) -> Bool {
        status == 404 && ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["message"] == nil
    }

    private struct InFolder: Encodable { let directory: String }

    /// The folder's repository and its branches; nil when its box couldn't say.
    @concurrent static func branches(at place: GitPlace) async -> Branches? {
        guard let (status, data) = try? await place.client.send("POST", "kuvo/git/branches", body: JSONEncoder().encode(InFolder(directory: place.path))) else { return nil }
        if (200..<300).contains(status) { return try? JSONDecoder().decode(Branches.self, from: data) }
        guard lacksRoute(status, data), place.machine != nil else { return nil }
        // COMPAT(beta.1 git-older-box): a machine's box from before `kuvo/git/branches`: its git over SSH, as before. Goes when 0.8.0 ships.
        let folder = place.here(place.path)
        guard run(["rev-parse", "--git-dir"], in: folder) != nil else { return Branches(repository: false) }
        let listed = run(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"], in: folder) ?? ""
        return Branches(repository: true, branches: listed.split(separator: "\n").map(String.init))
    }

    /// Switches the folder's repository to `branch`, or (`creating`) to a new one from where it is,
    /// on its box, its hooks run there as in your terminal; nil when it went, else why not.
    /// `environment`: your shell's, for a machine's older box only (over SSH, as before).
    @concurrent static func switching(to branch: String, creating: Bool, at place: GitPlace, environment: [String: String]) async -> String? {
        struct Asked: Encodable { let directory, branch: String; let create: Bool }
        do {
            let (status, data) = try await place.client.send("POST", "kuvo/git/switch", body: JSONEncoder().encode(Asked(directory: place.path, branch: branch, create: creating)))
            if (200..<300).contains(status) { return nil }
            guard lacksRoute(status, data) else { return BoxRefusal(status: status, data: data).message }
            // COMPAT(beta.1 git-older-box): this Mac's older box says Switch waits for it (running on after an update) or needs a newer version (one attached in place); a machine's box from before `kuvo/git/switch` switches with its git over SSH, as before. Goes when 0.8.0 ships.
            guard place.machine != nil else { return place.client.box == BoxClient.mac ? switchAfterUpdate : switchNeedsNewerService }
            return report(["switch"] + (creating ? ["-c"] : []) + [branch], in: place.here(place.path), environment: environment)
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
        guard let (status, data) = try? await place.client.send("POST", "kuvo/git/status", body: JSONEncoder().encode(InFolder(directory: place.path))) else { return true }
        if (200..<300).contains(status) {
            guard let answer = try? JSONDecoder().decode(Answer.self, from: data), answer.repository else { return true }
            return answer.uncommitted ?? true
        }
        guard lacksRoute(status, data), place.machine != nil else { return true }
        // COMPAT(beta.1 git-older-box): a machine's box from before `kuvo/git/status`: its git over SSH, as before. Goes when 0.8.0 ships.
        return run(["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"], in: place.here(place.path)).map { !$0.isEmpty } ?? true
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

    /// Merge into… on this Mac while Kuvo Code finishes an update: its background service moves to
    /// the new version once the work that's running ends.
    static let mergeAfterUpdate = "Kuvo Code on this Mac is finishing an update. Merge into… works again once the work that’s running now ends; try again then."

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
            // A box from before Merge into… (bridge 0.9.143) has no such route, nor, from before
            // #341, merges without a branch named. A machine takes this Mac's as it connects, so
            // only one not updated since.
            if status == 404 && answer?.message == nil || status == 400 && base == nil {
                // COMPAT(beta.1 merge-older-box): says Merge into… waits while this Mac's older box runs on after an update, until the work under way ends (its keeper makes way then). Goes when 0.8.0 ships.
                guard let machine = place.machine else { return .failed(Self.mergeAfterUpdate) }
                return .failed("\(machine) needs a newer Kuvo Code to merge. It updates by itself overnight, or connect to it from this Mac.")
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