import Foundation
import Testing
@testable import OpenCodeKit

// A problem reported from the app opens GitHub's bug form filled in: what you wrote and the
// versions, nothing else (issues are public).

@Test func aReportOpensTheBugFormWithWhatYouWroteAndTheVersionsOnly() throws {
    let report = ProblemReport(description: "  The sidebar shows no sessions\nafter I open a project in /tmp.  ",
                               versions: [("Kuvo Code", "0.8.0 (812)"), ("macOS", "26.1"), ("Mac", "Mac15,12"), ("Engine", "2.0.32")])
    let url = report.issueURL
    let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    #expect(url.absoluteString.hasPrefix("https://github.com/serhatandic/kuvo-code/issues/new?"))
    #expect(query["template"] == "bug_report.yml")
    #expect(query["title"] == "[Bug]: The sidebar shows no sessions")
    #expect(query["description"] == "The sidebar shows no sessions\nafter I open a project in /tmp.")
    #expect(query["version"] == "0.8.0 (812)")
    #expect(query["macos"] == "macOS: 26.1, Mac: Mac15,12, Engine: 2.0.32")
    #expect(Set(query.keys) == ["template", "title", "description", "version", "macos"])
    #expect(!ProblemReport(description: " \n ", versions: []).canSend)
}

@Test func aLongFirstLineMakesAShortTitle() {
    let long = String(repeating: "word ", count: 30)
    let title = URLComponents(url: ProblemReport(description: long, versions: []).issueURL, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "title" }?.value ?? ""
    #expect(title.hasPrefix("[Bug]: word word"))
    #expect(title.hasSuffix("…"))
    #expect(title.count <= "[Bug]: ".count + 72)
}

/// The link's fields as GitHub reads them: a form's, where "+" is a space.
private func asGitHubReads(_ url: URL) -> [String: String] {
    let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery ?? ""
    return Dictionary(uniqueKeysWithValues: query.split(separator: "&").map { pair in
        let parts = pair.split(separator: "=", maxSplits: 1).map { String($0).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "" }
        return (parts[0], parts.count > 1 ? parts[1] : "")
    })
}

@Test func symbolsArriveAsTyped() {
    let fields = asGitHubReads(ProblemReport(description: "C++ crash & a=b #1, 100% sure?", versions: [("Kuvo Code", "0.8.0+1")]).issueURL)
    #expect(fields["description"] == "C++ crash & a=b #1, 100% sure?")
    #expect(fields["title"] == "[Bug]: C++ crash & a=b #1, 100% sure?")
    #expect(fields["version"] == "0.8.0+1")
}

@Test func aVeryLongReportStillMakesALinkGitHubTakes() {
    let report = ProblemReport(description: String(repeating: "It froze again. ", count: 2_000), versions: [("Kuvo Code", "0.8.0")])
    let fields = asGitHubReads(report.issueURL)
    #expect(report.issueURL.absoluteString.utf8.count < 8_000)
    #expect(fields["description"]?.hasSuffix("[…cut here: the rest didn’t fit in the link]") == true)
    // Written in Turkish, with emoji: each letter takes more of the link, and it still fits.
    let turkish = ProblemReport(description: String(repeating: "Çalışırken donuyor ğüş 😕 ", count: 400), versions: [("Kuvo Code", "0.8.0")])
    #expect(turkish.issueURL.absoluteString.utf8.count < 8_000)
    #expect(asGitHubReads(turkish.issueURL)["description"]?.hasPrefix("Çalışırken donuyor ğüş 😕") == true)
}
