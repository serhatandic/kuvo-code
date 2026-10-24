import Foundation
import Testing
import WebKit
@testable import KuvoCode

/// A file a page downloads in the panel's browser (E4, L21): it lands in your Downloads folder, a
/// second one of the same name beside the first rather than over it, the bar shows it done, and the
/// agent hears where it is, to work with it. Nothing is left in the app's temporary folder. Real
/// WebKit; Downloads is a folder of the test's own (KUVO_DEMO_DOWNLOADS).
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BrowserDownloadsTests {
    let downloads = AppInfo.testRoot.appending(path: "Downloads-\(UUID().uuidString.prefix(6))")
    let pages = AppInfo.testRoot.appending(path: "DownloadPages-\(UUID().uuidString.prefix(6))")

    @Test func aDownloadLandsInDownloadsAndTheAgentHearsWhere() async throws {
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: pages, withIntermediateDirectories: true)
        setenv("KUVO_DEMO_DOWNLOADS", downloads.path(percentEncoded: false), 1)
        defer {
            unsetenv("KUVO_DEMO_DOWNLOADS")
            try? FileManager.default.removeItem(at: downloads)
            try? FileManager.default.removeItem(at: pages)
        }
        let page = pages.appending(path: "report.html")
        try #"<html><body><a id="csv" href="data:text/csv,city%2Ctemp%0AIstanbul%2C21%0A" download="weather.csv">CSV</a></body></html>"#
            .write(to: page, atomically: true, encoding: .utf8)
        let session = BrowserSession()
        session.load(page.path(percentEncoded: false))
        try await until { !session.isLoading && session.url != nil }

        func download() async throws {
            let before = session.downloads.filter { $0.state == .done }.count
            _ = try await session.webView.evaluateJavaScript("document.getElementById('csv').click(); true")
            try await until { session.downloads.filter { $0.state == .done }.count > before }
        }
        try await download()
        let first = downloads.appending(path: "weather.csv")
        #expect(try String(contentsOf: first, encoding: .utf8) == "city,temp\nIstanbul,21\n")
        #expect(session.downloads.last?.file == first)
        #expect(session.agentNotes.contains { $0.contains("Downloaded weather.csv to \(first.path)") }, "the agent hears where: \(session.agentNotes)")

        // Again: beside it, not over it.
        try await download()
        #expect(FileManager.default.fileExists(atPath: downloads.appending(path: "weather 2.csv").path(percentEncoded: false)))
        #expect(try String(contentsOf: first, encoding: .utf8) == "city,temp\nIstanbul,21\n")
        let scratch = FileManager.default.temporaryDirectory.appending(path: "Downloads")
        #expect(((try? FileManager.default.contentsOfDirectory(atPath: scratch.path(percentEncoded: false))) ?? []).isEmpty, "nothing left in the temporary folder")
    }
}
