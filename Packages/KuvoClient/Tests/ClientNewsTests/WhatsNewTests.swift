import Foundation
import Testing
@testable import ClientNews

/// What's New as people meet it: the highlights once after an update (never on a first launch,
/// never twice), and "New" marks until they're used or a few weeks have gone by.
@MainActor
struct WhatsNewTests {
    let news = WhatsNew(releases: [
        .init(version: "0.9.0", highlights: [.init(title: "Goals that keep going", line: "/goal and it keeps at it.", symbol: "target")], marks: ["keyword/goal"]),
        .init(version: "0.8.0", highlights: [.init(title: "Worktrees", line: "Pick where they go.", symbol: "folder")], marks: ["settings/worktrees"]),
    ])

    /// A copy's own defaults, as an app keeps them.
    private func memory() -> NewsMemory {
        NewsMemory(defaults: UserDefaults(suiteName: "whats-new-\(UUID())")!)
    }

    @Test func anUpdateShowsItsHighlightsOnce() {
        let memory = memory()
        // The copy before, which had What's New already.
        #expect(memory.afterLaunch(news, version: "0.8.0", ranBefore: true)?.version == "0.8.0")
        #expect(memory.afterLaunch(news, version: "0.8.0", ranBefore: true) == nil, "not again")
        // Updated.
        #expect(memory.afterLaunch(news, version: "0.9.0", ranBefore: true)?.highlights.map(\.title) == ["Goals that keep going"])
        #expect(memory.afterLaunch(news, version: "0.9.0", ranBefore: true) == nil)
    }

    @Test func theFirstLaunchShowsNothingAndEverythingIsSeen() {
        let memory = memory()
        #expect(memory.afterLaunch(news, version: "0.9.0", ranBefore: false) == nil)
        let marks = NewMarks(news: news, memory: memory)
        #expect(!marks.isNew("keyword/goal"))
        #expect(!marks.isNew("settings/worktrees"))
        // Nor once it opens again.
        #expect(memory.afterLaunch(news, version: "0.9.0", ranBefore: false) == nil)
    }

    @Test func aBetasHighlightsAreNotShownAgainWithItsRelease() {
        let beta = WhatsNew(releases: [.init(version: "Unreleased", highlights: news.releases[0].highlights)])
        let memory = memory()
        _ = memory.afterLaunch(news, version: "0.8.0", ranBefore: true)
        #expect(memory.afterLaunch(beta, version: "0.9.0", ranBefore: true) != nil, "the beta, before its version is named")
        #expect(memory.afterLaunch(news, version: "0.9.0", ranBefore: true) == nil, "the release, with the same highlights")
    }

    @Test func aReleaseWithoutHighlightsShowsNothing() {
        let memory = memory()
        let quiet = WhatsNew(releases: [.init(version: "0.9.1", marks: ["keyword/loop"])] + news.releases)
        _ = memory.afterLaunch(news, version: "0.9.0", ranBefore: true)
        #expect(memory.afterLaunch(quiet, version: "0.9.1", ranBefore: true) == nil)
        // Help › What's New still has the last ones.
        #expect(quiet.latestHighlights?.version == "0.9.0")
    }

    @Test func updatingPastAReleaseToAFixAfterItStillShowsWhatItBrought() {
        let memory = memory()
        _ = memory.afterLaunch(news, version: "0.7.2", ranBefore: true)
        // 0.9.1 tells nothing of its own (it isn't in the file): 0.9.0's, which you skipped.
        #expect(memory.afterLaunch(news, version: "0.9.1", ranBefore: true)?.version == "0.9.0")
        // Never one from after this copy.
        #expect(news.release(of: "0.8.5")?.version == "0.8.0")
        #expect(news.release(of: "0.7.0") == nil)
        // A beta of the next one (its section still Unreleased): what's Unreleased.
        let next = WhatsNew(releases: [.init(version: "Unreleased", highlights: [.init(title: "Next", line: "", symbol: "star")])] + news.releases)
        #expect(next.release(of: "0.10.0-beta.1")?.version == "Unreleased")
        #expect(next.release(of: "0.9.0")?.version == "0.9.0")
    }

    @Test func aMarkStaysUntilUsed() {
        let memory = memory()
        _ = memory.afterLaunch(news, version: "0.9.0", ranBefore: true)
        let marks = NewMarks(news: news, memory: memory)
        #expect(marks.isNew("keyword/goal"))
        #expect(!marks.isNew("keyword/nothing"), "only what a release brought")
        marks.use("keyword/goal")
        #expect(!marks.isNew("keyword/goal"))
        // Remembered: the app opened again.
        #expect(!NewMarks(news: news, memory: memory).isNew("keyword/goal"))
    }

    @Test func aMarkGoesAfterAFewWeeksUnused() {
        let memory = memory()
        _ = memory.afterLaunch(news, version: "0.9.0", ranBefore: true)
        let shown = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(memory.isNew("settings/worktrees", in: news, now: shown))
        #expect(memory.isNew("settings/worktrees", in: news, now: shown.addingTimeInterval(20 * 24 * 60 * 60)))
        #expect(!memory.isNew("settings/worktrees", in: news, now: shown.addingTimeInterval(22 * 24 * 60 * 60)))
    }
}
