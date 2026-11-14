import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What this Mac's box asks the keeper to open for its agents' browser (#333 piece 3; KuvoLink's
/// PROTOCOL.md, "Host interface", `app/open`): only the Kuvo Code the keeper runs from, as Kuvo Code
/// signed it. Any other place a file names (another app, a copy that calls itself Kuvo Code) is
/// refused, and nothing is opened: each case here is refused before anything is asked of macOS
/// (and the app's tests never open an app anyway, `AppOpener.openQuietly`).
@MainActor @Suite struct HostOpensAppTests {
    let folder = AppInfo.testRoot.appending(path: "HostOpensApp-\(UUID().uuidString.prefix(6))")

    /// An app bundle in the test's folder whose Info.plist names `id`, with no signature.
    private func app(_ name: String, id: String?) throws -> URL {
        let bundle = folder.appending(path: "\(name).app")
        try FileManager.default.createDirectory(at: bundle.appending(path: "Contents/MacOS"), withIntermediateDirectories: true)
        var info: [String: Any] = ["CFBundleExecutable": name, "CFBundlePackageType": "APPL"]
        if let id { info["CFBundleIdentifier"] = id }
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: bundle.appending(path: "Contents/Info.plist"))
        try Data("#!/bin/sh\n".utf8).write(to: bundle.appending(path: "Contents/MacOS/\(name)"))
        return bundle
    }

    private func status(_ answer: HTTPResponse) -> Int { answer.status }

    @Test func onlyTheAppItRunsFromSignedAsItIsOpened() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let own = try app("Kuvo Code", id: Bundle.main.bundleIdentifier)
        // Not there any more.
        #expect(status(await HostInterface.openApp(at: folder.appending(path: "Gone.app"), runningFrom: own)) == 410)
        // Another place, though it says it's Kuvo Code.
        let copy = try app("Copy", id: Bundle.main.bundleIdentifier)
        #expect(status(await HostInterface.openApp(at: copy, runningFrom: own)) == 403)
        // Another app at the very place.
        let other = try app("Other", id: "com.example.other")
        #expect(status(await HostInterface.openApp(at: other, runningFrom: other)) == 403)
        // The app it runs from, with its ID but not signed as this one is.
        #expect(status(await HostInterface.openApp(at: own, runningFrom: own)) == 403)
        #expect(!HostInterface.isSignedAsThis(own))
    }
}
