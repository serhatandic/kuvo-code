import Foundation

/// Branches and worktrees: what a session in a worktree needs to start, and to bring its work
/// back (a merge, or a pull request).
nonisolated extension Git {
    /// The branch `directory` has checked out, or nil (no repository, or no branch).
    static func currentBranch(in directory: String) -> String? {
        let name = run(["symbolic-ref", "--quiet", "--short", "HEAD"], in: directory)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name : nil
    }

    /// Where `directory` is in its repository ("" at the top).
    static func pathInRepository(of directory: String) -> String {
        guard let root = toplevel(of: directory) else { return "" }
        return relativePath(of: directory, in: root)
    }

    /// Checks out a new branch at what `directory` has, named `name` or, when that's taken,
    /// `name-2` and so on. Returns the name it got.
    static func newBranch(named name: String, in directory: String) throws -> String {
        var failure = ""
        for suffix in 1...20 {
            let candidate = suffix == 1 ? name : "\(name)-\(suffix)"
            guard run(["rev-parse", "--verify", "--quiet", "refs/heads/" + candidate], in: directory) == nil else { continue }
            guard let complaint = report(["switch", "--quiet", "-c", candidate], in: directory, environment: [:]) else { return candidate }
            // Made and checked out, but a hook complained after (Git LFS's, say, without git-lfs
            // on the app's PATH): it's the branch all the same.
            if currentBranch(in: directory) == candidate { return candidate }
            failure = complaint
        }
        throw GitFailure(message: failure.isEmpty ? "Couldn't make a branch for the worktree." : failure)
    }

    /// A branch name made from a title: "Trim note titles" is trim-note-titles, "Giriş düzeltmesi"
    /// giris-duzeltmesi (in Latin letters, without their marks, rather than without the letters).
    static func slug(_ title: String, limit: Int = 40) -> String {
        let latin = (title.applyingTransform(.toLatin, reverse: false) ?? title)
            .applyingTransform(.stripDiacritics, reverse: false)?.replacingOccurrences(of: "ı", with: "i") ?? title
        var name = ""
        for word in latin.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) {
            let ascii = word.filter(\.isASCII)
            guard !ascii.isEmpty else { continue }
            let next = name.isEmpty ? String(ascii) : name + "-" + ascii
            if next.count > limit { break }
            name = next
        }
        return name
    }

    /// Renames `branch` to `name` (or `name-2` and so on, when that's taken), unless it's been
    /// pushed: its pull request would lose track of it. Returns the new name.
    static func renameBranch(_ branch: String, to name: String, in directory: String) -> String? {
        guard run(["rev-parse", "--abbrev-ref", branch + "@{upstream}"], in: directory) == nil else { return nil }
        for suffix in 1...20 {
            let candidate = suffix == 1 ? name : "\(name)-\(suffix)"
            guard run(["rev-parse", "--verify", "--quiet", "refs/heads/" + candidate], in: directory) == nil else { continue }
            return report(["branch", "-m", branch, candidate], in: directory, environment: [:]) == nil ? candidate : nil
        }
        return nil
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

    /// Pushes what `directory` has checked out to `origin`, and returns the page that opens a
    /// pull request for it on GitHub, or a merge request on GitLab (nil for other hosts).
    static func pushForPullRequest(branch: String, base: String?, in directory: String, environment: [String: String]) throws -> URL? {
        if let failure = report(["push", "-u", "origin", "HEAD"], in: directory, environment: environment) {
            throw GitFailure(message: failure)
        }
        guard let remote = run(["remote", "get-url", "origin"], in: directory)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let page = webPage(of: remote) else { return nil }
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))
        let source = branch.addingPercentEncoding(withAllowedCharacters: allowed) ?? branch
        let target = base.map { $0.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0 }
        // Without a base, the host compares with the repository's main branch.
        if page.host()?.contains("gitlab") == true {
            return URL(string: page.absoluteString + "/-/merge_requests/new?merge_request%5Bsource_branch%5D=\(source)" + (target.map { "&merge_request%5Btarget_branch%5D=\($0)" } ?? ""))
        }
        if page.host()?.contains("github") == true {
            return URL(string: page.absoluteString + "/compare/" + (target.map { "\($0)...\(source)" } ?? source) + "?expand=1")
        }
        return nil
    }

    /// What a pull request for `directory`'s branch would bring: its commits, the files they
    /// change, and the diff, cut to a size a model reads quickly.
    static func pullRequestSummary(against base: String?, in directory: String, limit: Int = 30_000) -> String {
        let range = base.map { $0 + "...HEAD" } ?? "HEAD~1...HEAD"
        let commits = run(["log", "--no-color", "--format=- %s%n%b", base.map { $0 + "..HEAD" } ?? "-1"], in: directory) ?? ""
        let files = run(["diff", "--no-color", "--stat", range], in: directory) ?? ""
        var diff = run(["diff", "--no-color", "--no-ext-diff", range], in: directory) ?? ""
        if diff.count > limit { diff = String(diff.prefix(limit)) + "\n…" }
        return "Commits:\n\(commits)\nFiles:\n\(files)\nDiff:\n\(diff)"
    }

    /// The pull request page with its title and description filled in.
    static func pullRequestPage(_ page: URL, title: String, body: String) -> URL {
        guard var components = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return page }
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))
        func item(_ name: String, _ value: String) -> URLQueryItem {
            URLQueryItem(name: name.addingPercentEncoding(withAllowedCharacters: allowed) ?? name, value: value.addingPercentEncoding(withAllowedCharacters: allowed))
        }
        let items = page.host()?.contains("gitlab") == true
            ? [item("merge_request[title]", title), item("merge_request[description]", body)]
            : [item("title", title), item("body", body)]
        components.percentEncodedQueryItems = (components.percentEncodedQueryItems ?? []) + items
        return components.url ?? page
    }

    /// A model's pull request, as a title (its first line) and a description (the rest).
    static func parsePullRequest(_ text: String) -> (title: String, body: String)? {
        var lines = text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
        lines.removeAll { $0.hasPrefix("```") }
        guard let first = lines.first?.trimmingCharacters(in: .whitespaces), !first.isEmpty else { return nil }
        var title = first
        for prefix in ["# ", "Title: ", "title: "] where title.hasPrefix(prefix) { title = String(title.dropFirst(prefix.count)) }
        title = title.trimmingCharacters(in: CharacterSet(charactersIn: "*`\" "))
        let body = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : (String(title.prefix(120)), String(body.prefix(4_000)))
    }

    /// A remote's web page: `git@github.com:me/app.git` and `https://github.com/me/app.git`
    /// are both https://github.com/me/app.
    static func webPage(of remote: String) -> URL? {
        var address = remote
        if address.hasSuffix(".git") { address.removeLast(4) }
        if address.hasPrefix("ssh://") || address.hasPrefix("git://") {
            address = "https://" + address.drop { $0 != "/" }.dropFirst(2)
        } else if !address.contains("://"), let colon = address.firstIndex(of: ":") {
            // scp-like: git@host:owner/repo
            address = "https://" + address[..<colon] + "/" + address[address.index(after: colon)...]
        }
        guard var components = URLComponents(string: address), components.scheme == "https" || components.scheme == "http",
              components.host != nil else { return nil }
        components.scheme = "https"
        components.user = nil
        components.password = nil
        components.port = nil
        return components.url
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
