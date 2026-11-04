import AppKit
import Testing
@testable import KuvoCode

/// The mode chip's menu (the four modes, then Build and Plan) checks what's picked once, on the
/// row's trailing side, and VoiceOver hears which one it is.
@MainActor
@Suite struct ModeMenuTests {
    init() {
        TestEnvironment.prepare()
    }

    @Test func thePickedRowShowsOneCheckOnItsTrailingSideAndVoiceOverHearsItsSelected() {
        let menu = NSMenu()
        let askFirst = ActionItem("Ask First", subtitle: "Asks before edits and commands") {}
        let auto = ActionItem("Auto", subtitle: "Works on its own; a reviewer checks the rest") {}
        let build = ActionItem("Build", subtitle: "Makes changes and runs commands") {}
        let plan = ActionItem("Plan") {}
        for item in [askFirst, auto, build, plan] { menu.addItem(item) }
        menu.checksOnTrailingSide([auto, build])

        // AppKit draws a leading check for any row that's on, state column or not: none is.
        #expect(menu.items.filter { $0.state != .off }.map(\.title) == [])
        for (item, picked) in [(askFirst, false), (auto, true), (build, true), (plan, false)] {
            let drawn = item.attributedTitle?.string ?? item.title
            #expect(drawn.filter { $0 == "✓" }.count == (picked ? 1 : 0), "\(item.title): \(drawn)")
            #expect(!picked || drawn.hasSuffix("✓"), "\(item.title)'s check is on its trailing side")
            #expect(item.accessibilityLabel() == item.title, "VoiceOver reads the name, not the check's glyph")
            #expect(item.accessibilityValue() as? String == (picked ? "selected" : nil), "\(item.title)")
        }
    }
}
