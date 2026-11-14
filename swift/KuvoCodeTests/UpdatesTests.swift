import Foundation
import Testing
@testable import KuvoCode

/// Updates: a build that names no update feed (this copy, and every development build) never
/// starts the updater, which would replace it with the released app, and hides Check for
/// Updates. That a release build names its feed is checked on the built app (CI's "Check the app
/// bundle").
@MainActor
@Suite struct UpdatesTests {
    @Test func aBuildWithoutAFeedNeverUpdates() {
        #expect(Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") == nil, "a copy of its own, not a release")
        let updates = Updates()
        #expect(!updates.isAvailable, "Check for Updates stays hidden")
        #expect(!updates.canCheck)
        #expect(!updates.checksAutomatically)
        updates.check()
        #expect(!updates.canCheck, "and nothing starts")
    }
}
