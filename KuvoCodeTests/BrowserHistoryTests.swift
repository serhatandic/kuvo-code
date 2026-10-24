import Foundation
import Testing
@testable import KuvoCode

/// The panel browser's history, for the new tab page's suggestions (C5, privacy): a site once
/// however it's written, the ones visited most lately first, one removed left out until it's
/// visited again, and Clear leaves nothing of it on this Mac, not even a site's icon still on its
/// way. Sites' icons come from a stub.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BrowserHistoryTests {
    let folder = AppInfo.testRoot.appending(path: "Browser-\(UUID().uuidString.prefix(8))")

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["example.com", "www.example.com", "news.example.org"])
    }

    private func done() {
        StubWeb.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    @Test func aSiteOnceAndRemovedUntilVisitedAgain() throws {
        defer { done() }
        let history = BrowserHistory(folder: folder)
        history.record(URL(string: "https://www.example.com/")!, title: "Example", iconURL: nil)
        history.record(URL(string: "https://example.com/docs")!, title: "Docs", iconURL: nil)
        history.record(URL(string: "https://news.example.org/")!, title: "News", iconURL: nil)
        #expect(history.suggestions(5).map(\.host) == ["example.com", "news.example.org"])
        #expect(history.sites.first { $0.host == "example.com" }?.title == "Example", "a site's front page names it")

        history.remove(try #require(history.sites.first { $0.host == "example.com" }))
        #expect(BrowserHistory(folder: folder).suggestions(5).map(\.host) == ["news.example.org"], "removed, after a relaunch too")
        history.record(URL(string: "https://example.com/")!, title: "Example", iconURL: nil)
        #expect(history.suggestions(5).map(\.host).contains("example.com"))
    }

    /// Clear: nothing of it on this Mac, though a site's icon was still on its way.
    @Test func clearLeavesNothing() async throws {
        defer { done() }
        let gate = Gate()
        defer { gate.open() }
        let asked = Asked()
        StubWeb.handle("https://example.com/favicon.ico") { _, _ in
            asked.note()
            gate.wait()
            return StubWeb.Answer(status: 200, body: Self.png)
        }
        let history = BrowserHistory(folder: folder)
        history.record(URL(string: "https://example.com/")!, title: "Example", iconURL: nil)
        try await until { asked.count > 0 }
        history.clear()
        gate.open()
        // Until the icon's request has had its answer, and a moment for what follows it.
        for _ in 0..<50 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(history.sites.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: folder.path(percentEncoded: false)), "left: \((try? FileManager.default.subpathsOfDirectory(atPath: folder.path(percentEncoded: false))) ?? [])")
        #expect(BrowserHistory(folder: folder).sites.isEmpty)
    }

    /// Visited again right after Clear, its icon from before still on its way: it gets its icon
    /// all the same, from the new visit.
    @Test func visitedAgainRightAfterClearItGetsItsIcon() async throws {
        defer { done() }
        let gate = Gate()
        defer { gate.open() }
        let asked = Asked()
        StubWeb.handle("https://example.com/favicon.ico") { _, _ in
            asked.note()
            gate.wait()
            return StubWeb.Answer(status: 200, body: Self.png)
        }
        let history = BrowserHistory(folder: folder)
        history.record(URL(string: "https://example.com/")!, title: "Example", iconURL: nil)
        try await until { asked.count > 0 }
        history.clear()
        history.record(URL(string: "https://example.com/")!, title: "Example", iconURL: nil)
        gate.open()
        let site = try #require(history.sites.first { $0.host == "example.com" })
        try await until { history.icon(for: site) != nil }
        #expect(asked.count == 2, "asked again for the new visit")
        #expect(history.icon(for: site) != nil)
    }

    nonisolated final class Asked: @unchecked Sendable {
        private let lock = NSLock()
        private var times = 0
        func note() {
            lock.withLock { times += 1 }
            TestPulse.beat()
        }
        var count: Int { lock.withLock { times } }
    }

    /// A one-pixel PNG.
    nonisolated static let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
}
