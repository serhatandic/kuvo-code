import Foundation
import XCTest

extension XCTestCase {
    /// A throwaway `UserDefaults` suite that leaves nothing behind.
    ///
    /// A suite named like a bundle id ("OpenUsageTests.x") lives in `~/Library/Preferences/<name>.plist`,
    /// which `cfprefsd` writes asynchronously, so deleting it at teardown races the write and the plists
    /// pile up. A suite named by an absolute path is stored at that path instead, so each one gets a folder
    /// of its own in the temporary directory, deleted at teardown, and nothing reaches `~/Library`.
    ///
    /// `domain` is the name to pass wherever code asks for the suite's domain
    /// (`persistentDomain(forName:)`). It isn't `suiteName`.
    func testDefaultsWithDomain(suiteName: String) -> (defaults: UserDefaults, domain: String)? {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("UsageKitTestDefaults-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            return nil
        }
        let domain = folder.appendingPathComponent(suiteName).path
        guard let defaults = UserDefaults(suiteName: domain) else {
            try? FileManager.default.removeItem(at: folder)
            return nil
        }
        addTeardownBlock {
            try? FileManager.default.removeItem(at: folder)
        }
        return (defaults, domain)
    }

    func testDefaults(suiteName: String) -> UserDefaults? {
        testDefaultsWithDomain(suiteName: suiteName)?.defaults
    }
}
