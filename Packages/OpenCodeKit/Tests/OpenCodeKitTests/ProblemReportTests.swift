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
