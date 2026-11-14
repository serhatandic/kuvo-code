import Foundation
import Testing

/// The checkout the tests were built from, for a test that reads the sources themselves: what
/// `scripts/test-app.sh` gives (KUVO_SOURCE_ROOT), a run's checkout, or its batch's exported sources.
/// Never the file path the compiler gives: built with Xcode's compilation cache, it's /^src/…, no
/// file on this Mac.
enum SourceRoot {
    static func url() throws -> URL {
        let root = try #require(ProcessInfo.processInfo.environment["KUVO_SOURCE_ROOT"].flatMap { $0.isEmpty ? nil : URL(filePath: $0, directoryHint: .isDirectory) },
                                "No source root: run the app's tests with scripts/test-app.sh, which gives it (KUVO_SOURCE_ROOT)")
        try #require(FileManager.default.fileExists(atPath: root.appending(path: "swift/KuvoCode.xcodeproj").path),
                     "KUVO_SOURCE_ROOT isn't a checkout of the app: \(root.path)")
        return root
    }
}
