import Foundation

/// A problem reported from the app, Mac or phone: a new issue on Kuvo Code's GitHub, filled in
/// from what you wrote and the versions in use, to add to and post there. Issues are public, so
/// nothing else goes with it: no logs, no paths, no account names.
public struct ProblemReport: Sendable, Equatable {
    /// "What happened?", as you wrote it.
    public var description: String
    /// What's in use, as the sheet lists it and the issue says it: ("Kuvo Code", "0.8.0 (812)"), …
    public var versions: [(label: String, value: String)]

    public init(description: String, versions: [(label: String, value: String)]) {
        self.description = description
        self.versions = versions
    }

    public static func == (a: ProblemReport, b: ProblemReport) -> Bool {
        a.description == b.description && a.versions.map(\.label) == b.versions.map(\.label) && a.versions.map(\.value) == b.versions.map(\.value)
    }

    /// Where new issues are made: the repository's bug report form (`.github/ISSUE_TEMPLATE/bug_report.yml`).
    public static let newIssue = URL(string: "https://github.com/serhatandic/kuvo-code/issues/new")!

    /// The form's own title, before what's typed.
    static let titlePrefix = "[Bug]: "

    /// The new issue's page, its form filled in: the title from the first line of what happened,
    /// what happened, and the versions, by the form's field IDs.
    public var issueURL: URL {
        let said = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let first = said.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let title = first.count > 72 ? String(first.prefix(71)).trimmingCharacters(in: .whitespaces) + "…" : first
        let system = versions.filter { $0.label != "Kuvo Code" }.map { "\($0.label): \($0.value)" }.joined(separator: ", ")
        var components = URLComponents(url: Self.newIssue, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "template", value: "bug_report.yml"),
            URLQueryItem(name: "title", value: Self.titlePrefix + title),
            URLQueryItem(name: "description", value: said),
            URLQueryItem(name: "version", value: versions.first { $0.label == "Kuvo Code" }?.value ?? ""),
            URLQueryItem(name: "macos", value: system),
        ]
        return components.url!
    }

    /// Whether there's something to report: what happened, in a few words at least.
    public var canSend: Bool { !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The words the sheet says about where it goes, on the Mac and the phone alike.
    public static let publicNote = "This opens a new issue on Kuvo Code’s GitHub page, filled in with what you write and the versions below, for you to read over and post. Issues are public: anyone can read them. Leave out anything private, like code, keys, or the names of your projects and accounts."
}
