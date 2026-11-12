import Foundation

/// Create Pull Request's confirmation, as both apps show it before the box the project is on
/// pushes the branch and creates it (`kuvo/git/pull-request/draft`, PROTOCOL.md): the branch, the
/// base it goes into, a title and description from the commits, and what Create will do there.
public struct PullRequestDraft: Decodable, Equatable, Sendable {
    public var branch: String
    /// The branch it goes into; nil when the box goes by the repository's main branch.
    public var base: String?
    public var title, body: String
    /// What the branch brings, for a model to write the title and description from; only when
    /// asked for (`"summary": true`).
    public var summary: String?
    /// What a model is asked to write them from, in the box's words with your instructions on that
    /// computer (Settings › Git); only when asked for (`"prompt": true`), and from a box that has them.
    public var prompt: String?
    /// "github", "gitlab" or "other".
    public var host: String
    /// Made on the box with `gh`; else the host's page opens.
    public var creates: Bool
    /// Why not on GitHub: "signed-out", or "missing" (not installed).
    public var gh: String?

    public init(branch: String, base: String?, title: String, body: String, summary: String? = nil, prompt: String? = nil, host: String, creates: Bool, gh: String?) {
        (self.branch, self.base, self.title, self.body, self.summary, self.prompt, self.host, self.creates, self.gh) = (branch, base, title, body, summary, prompt, host, creates, gh)
    }

    /// "dark-mode into main".
    public var into: String {
        "\(branch) into \(base ?? "the repository’s main branch")"
    }

    /// What Create does, said before it's clicked, on `place` (this Mac, a machine's name).
    public func what(on place: String) -> String {
        switch host {
        case "github" where creates: "Pushes \(branch) and creates the pull request on GitHub."
        case "github" where gh == "missing": "GitHub’s gh isn’t installed on \(place), so this pushes \(branch) and opens GitHub’s page to create it there."
        case "github": "GitHub’s gh isn’t signed in on \(place), so this pushes \(branch) and opens GitHub’s page to create it there."
        case "gitlab": "Pushes \(branch) and opens GitLab’s page to create the merge request there."
        default: "Pushes \(branch). Open the pull request on your git host."
        }
    }

    /// Its button.
    public var action: String {
        switch host {
        case "github" where creates: "Create Pull Request"
        case "github": "Push and Open GitHub"
        case "gitlab": "Push and Open GitLab"
        default: "Push"
        }
    }

    /// A model's pull request, as a title (its first line) and a description (the rest).
    public static func parse(_ text: String) -> (title: String, body: String)? {
        var lines = text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
        lines.removeAll { $0.hasPrefix("```") }
        guard let first = lines.first?.trimmingCharacters(in: .whitespaces), !first.isEmpty else { return nil }
        var title = first
        for prefix in ["# ", "Title: ", "title: "] where title.hasPrefix(prefix) { title = String(title.dropFirst(prefix.count)) }
        title = title.trimmingCharacters(in: CharacterSet(charactersIn: "*`\" "))
        let body = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : (String(title.prefix(120)), String(body.prefix(4_000)))
    }
}
