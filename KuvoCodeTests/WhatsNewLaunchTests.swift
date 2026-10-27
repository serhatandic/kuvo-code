import ClientNews
import Foundation
import Testing
@testable import KuvoCode

/// What's New after a launch, as the app opens: a release's highlights once after an update, and
/// never on a first launch, even one quit partway through its steps before the window showed
/// (macOS's Quit & Reopen for Screen Recording), whose next launch isn't an update.
@MainActor
@Suite(.serialized) struct WhatsNewLaunchTests {
    let news = WhatsNew(releases: [
        .init(version: "0.9.0", highlights: [.init(title: "Goals that keep going", line: "/goal and it keeps at it.", symbol: "target")], marks: ["keyword/goal"]),
    ])
    let suite = "whats-new-launch-\(UUID().uuidString)"

    private func launch(ranBefore: Bool) -> AppModel {
        AppModel(newMarks: NewMarks(news: news, memory: NewsMemory(defaults: UserDefaults(suiteName: suite)!)), launch: (ranBefore, "0.9.0"))
    }

    @Test func aFirstLaunchQuitBeforeTheWindowShowedIsStillTheFirst() {
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        // The first launch, quit during its steps: the window never showed.
        _ = launch(ranBefore: false)
        // Opened again: it had run before, but nothing was updated.
        let again = launch(ranBefore: true)
        again.whatsNewAfterLaunch()
        #expect(again.whatsNew == nil)
        #expect(!again.newMarks.isNew("keyword/goal"), "everything was new to a first launch")
    }

    @Test func anUpdateShowsItsHighlightsOnceTheWindowIsUp() {
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let updated = launch(ranBefore: true)
        updated.whatsNewAfterLaunch()
        #expect(updated.whatsNew?.version == "0.9.0")
    }
}
