import Foundation
import Testing
@testable import KuvoCode

/// Moving Kuvo Code to Applications (offered when it's opened from where it was downloaded, so it
/// can update itself): it lands there; an older copy of it there goes to the Trash, not deleted;
/// another app of the same name there is never replaced, and both stay as they were. Folders of
/// the test's own stand in for Applications.
@MainActor
@Suite struct AppLocationTests {
    let root = AppInfo.testRoot.appending(path: "AppLocation-\(UUID().uuidString.prefix(6))")
    var downloads: URL { root.appending(path: "Downloads") }
    var applications: URL { root.appending(path: "Applications") }

    /// An app bundle named "Kuvo Code.app" in `folder`, with `bundleID`, and a file saying which copy it is.
    private func app(in folder: URL, bundleID: String, copy: String) throws -> URL {
        let app = folder.appending(path: "Kuvo Code.app")
        try FileManager.default.createDirectory(at: app.appending(path: "Contents"), withIntermediateDirectories: true)
        let plist: [String: Any] = ["CFBundleIdentifier": bundleID, "CFBundlePackageType": "APPL", "CFBundleName": "Kuvo Code"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appending(path: "Contents/Info.plist"))
        try copy.write(to: app.appending(path: "Contents/copy.txt"), atomically: true, encoding: .utf8)
        return app
    }

    private func copy(of app: URL) -> String? {
        try? String(contentsOf: app.appending(path: "Contents/copy.txt"), encoding: .utf8)
    }

    private var ownID: String { Bundle.main.bundleIdentifier ?? "run.kuvo.code" }

    @Test func aDownloadedCopyMovesIn() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: applications, withIntermediateDirectories: true)
        let downloaded = try app(in: downloads, bundleID: ownID, copy: "new")
        let destination = applications.appending(path: "Kuvo Code.app")
        try AppLocation.move(downloaded, to: destination)
        #expect(copy(of: destination) == "new")
        #expect(!FileManager.default.fileExists(atPath: downloaded.path(percentEncoded: false)), "moved, not copied")
        #expect(try FileManager.default.contentsOfDirectory(atPath: applications.path(percentEncoded: false)) == ["Kuvo Code.app"], "nothing else left there")
    }

    @Test func anOlderCopyGoesToTheTrash() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let older = try app(in: applications, bundleID: ownID, copy: "old")
        let downloaded = try app(in: downloads, bundleID: ownID, copy: "new")
        try AppLocation.move(downloaded, to: older)
        #expect(copy(of: older) == "new")
        let trash = FileManager.default.enumerator(atPath: AppInfo.testTrash.path(percentEncoded: false))?.compactMap { $0 as? String } ?? []
        let trashed = trash.filter { $0.hasSuffix("Kuvo Code.app/Contents/copy.txt") }
            .compactMap { try? String(contentsOf: AppInfo.testTrash.appending(path: $0), encoding: .utf8) }
        #expect(trashed.contains("old"), "the older copy is in the Trash")
    }

    @Test func anotherAppOfTheSameNameIsNeverReplaced() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let other = try app(in: applications, bundleID: "com.example.another-kuvo-code", copy: "someone else's")
        let downloaded = try app(in: downloads, bundleID: ownID, copy: "new")
        #expect(throws: (any Error).self) { try AppLocation.move(downloaded, to: other) }
        #expect(copy(of: other) == "someone else's")
        #expect(copy(of: downloaded) == "new", "this one stays where it was")
    }
}
