import Testing
@testable import KuvoCode

/// Settings' search: a word for a setting finds the page it's on, and only that page among this
/// Mac's.
@MainActor
@Suite struct SettingsSearchTests {
    @Test(arguments: [
        ("swipe", SettingsPage.general), ("computers", .general), ("awake", .general), ("sleep", .general),
        ("opencode", .general), ("beta", .general), ("accent", .appearance), ("dark", .appearance),
    ])
    func aSettingsWordFindsItsPage(word: String, page: SettingsPage) {
        let found = SettingsPage.allCases.filter { [.general, .appearance, .storage].contains($0) && $0.matches(word) }
        #expect(found == [page], "\(word) found \(found)")
    }
}
