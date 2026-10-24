import Foundation
import Testing
import WebKit
@testable import KuvoCode

/// The panel's browser (E6, L37): what you type in its address field, and a page's own dialogs.
/// A confirmation or a question waits in a bar over the page until you answer it, and the page
/// gets your answer. While one of the agent's steps works in the page, it's answered at once
/// instead (declined, unless the step said to accept), and the agent is told. Real WebKit, on
/// local pages.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PageDialogsTests {
    let folder = AppInfo.testRoot.appending(path: "Pages-\(UUID().uuidString.prefix(6))")

    /// A page that asks as it opens and writes what it heard as its title.
    private func page(_ script: String) throws -> String {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: "\(UUID().uuidString.prefix(6)).html")
        try "<html><body><script>setTimeout(() => { document.title = \(script) }, 50)</script></body></html>".write(to: file, atomically: true, encoding: .utf8)
        return file.path(percentEncoded: false)
    }

    @Test func aConfirmationWaitsForYourAnswer() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let session = BrowserSession()
        session.load(try page(#"confirm("Delete the draft?") ? "yes" : "no""#))
        try await until { session.dialog != nil }
        #expect(session.dialog?.kind == .confirm)
        #expect(session.dialog?.message == "Delete the draft?")
        session.answerDialog(accept: true)
        #expect(session.dialog == nil)
        try await until { session.title == "yes" }
    }

    @Test func aQuestionGetsWhatYouTyped() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let session = BrowserSession()
        session.load(try page(#"prompt("Your name?", "") || "none""#))
        try await until { session.dialog != nil }
        #expect(session.dialog?.kind == .prompt)
        session.answerDialog(accept: true, text: "Ada")
        try await until { session.title == "Ada" }
    }

    /// The address field: a file's path on this Mac opens the file (these pages are opened so),
    /// an address goes there, anything else is searched.
    @Test func whatYouTypeInTheAddressField() {
        #expect(BrowserSession.url(from: "/Users/me/site/index.html") == URL(filePath: "/Users/me/site/index.html"))
        #expect(BrowserSession.url(from: "~/site/index.html")?.isFileURL == true)
        #expect(BrowserSession.url(from: "localhost:3000")?.absoluteString == "http://localhost:3000")
        #expect(BrowserSession.url(from: "example.com/docs")?.absoluteString == "https://example.com/docs")
        #expect(BrowserSession.url(from: "swift concurrency")?.isFileURL == false)
    }

    /// A search reaches the search engine as typed: it reads `+` as a space, so "c++" must be sent
    /// as `c%2B%2B`, or it searches for "c".
    @Test func aSearchIsSentAsTyped() throws {
        let typed = "c++ templates & more=1"
        let url = try #require(BrowserSession.url(from: typed))
        let query = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQueryItems?.first { $0.name == "q" }?.value)
        #expect(query.replacingOccurrences(of: "+", with: " ").removingPercentEncoding == typed)
    }

    /// While the agent's step works in the page: answered at once, declined unless the step said
    /// to accept; it hears what the page asked.
    @Test(arguments: [false, true])
    func whileTheAgentWorksItsAnsweredForIt(accepting: Bool) async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let session = BrowserSession()
        session.agentStepBegan(nil, accepting: accepting)
        session.load(try page(#"confirm("Send the form?") ? "yes" : "no""#))
        try await until { session.title == "yes" || session.title == "no" }
        #expect(session.title == (accepting ? "yes" : "no"))
        #expect(session.dialog == nil, "nothing left waiting in the bar")
        #expect(session.agentNotes.contains { $0.contains("Send the form?") && $0.contains(accepting ? "accepted" : "declined") })
    }
}
