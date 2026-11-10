import Foundation
import XCTest

extension XCTestCase {
    func testDefaults(suiteName: String) -> UserDefaults? {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
        addTeardownBlock {
            guard let defaults = UserDefaults(suiteName: suiteName) else { return }
            defaults.removePersistentDomain(forName: suiteName)
            defaults.synchronize()
            let plist = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Preferences", isDirectory: true)
                .appendingPathComponent("\(suiteName).plist")
            if FileManager.default.fileExists(atPath: plist.path) {
                try FileManager.default.removeItem(at: plist)
            }
        }
        return defaults
    }
}
