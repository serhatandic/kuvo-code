import Foundation
import Testing
@testable import KuvoCode

/// What Kuvo Code keeps in its JSON files survives a relaunch, and a file that won't read (from a
/// newer version, or damaged) is set aside whole, never written over, so nothing in it is lost.
/// Through the panel browser's history, one of the stores that keep such a file.
@MainActor
@Suite(.serialized) struct StoredFilesTests {
    let folder: URL
    var file: URL { folder.appending(path: "history.json") }

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "Browser/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Its sites' icons are fetched from the sites: answered here, not by the web.
        StubWeb.start(hosts: ["example.com", "docs.example.com", "kuvo.test"])
    }

    private func setAside() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("history.unreadable-") }
    }

    @Test func historySurvivesARelaunch() throws {
        defer { StubWeb.stop() }
        let history = BrowserHistory(folder: folder)
        history.record(URL(string: "https://example.com/")!, title: "Example", iconURL: nil)
        history.record(URL(string: "https://www.example.com/docs")!, title: "Docs page", iconURL: nil)
        history.record(URL(string: "https://kuvo.test/")!, title: "Kuvo", iconURL: nil)
        let again = BrowserHistory(folder: folder)
        #expect(again.sites.count == 2)
        // One site per host (www. or not), named by its front page, the most visited first.
        #expect(again.suggestions(1).first?.title == "Example")
        #expect(again.suggestions(2).first?.visits == 2)
    }

    @Test func anUnreadableFileIsSetAsideNotOverwritten() throws {
        defer { StubWeb.stop() }
        let damaged = Data("{\"sites\": [ this isn't JSON".utf8)
        try damaged.write(to: file)
        let history = BrowserHistory(folder: folder)
        #expect(history.sites.isEmpty)
        history.record(URL(string: "https://example.com/")!, title: "Example", iconURL: nil)
        let aside = try setAside()
        #expect(aside.count == 1)
        #expect(try Data(contentsOf: aside[0]) == damaged)
        #expect(BrowserHistory(folder: folder).sites.map(\.host) == ["example.com"])
    }

    /// Two damaged versions, one right after the other: both kept.
    @Test func twoUnreadableVersionsAreBothKept() throws {
        defer { StubWeb.stop() }
        for version in ["first", "second"] {
            try Data("not json: \(version)".utf8).write(to: file)
            let history = BrowserHistory(folder: folder)
            history.record(URL(string: "https://kuvo.test/")!, title: "Kuvo", iconURL: nil)
        }
        let kept = try setAside().map { String(decoding: try Data(contentsOf: $0), as: UTF8.self) }.sorted()
        #expect(kept == ["not json: first", "not json: second"])
    }
}
