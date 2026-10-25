import Foundation
import Testing
@testable import KuvoCode

/// A demo copy left to run on its own never shows a macOS prompt nobody is there to answer: one
/// launched in the background asks nothing unless told it may, one told never to asks nothing in
/// front too, and one launched by hand with neither asks as the app does.
@Suite struct DemoNoPromptsTests {
    @Test func aBackgroundDemoCopyAsksNothing() {
        #expect(AppInfo.demoNeverPrompts(["KUVO_DEMO_BACKGROUND": "1", "KUVO_DEMO_OFFSCREEN": "1"]))
        #expect(AppInfo.demoNeverPrompts(["KUVO_DEMO_NO_PROMPTS": "1"]), "in front, when told")
    }

    @Test func aBackgroundCopyMayAskWhenToldItMay() {
        #expect(!AppInfo.demoNeverPrompts(["KUVO_DEMO_BACKGROUND": "1", "KUVO_DEMO_NO_PROMPTS": "0"]))
    }

    @Test func aCopyYouRunYourselfAsksAsTheAppDoes() {
        #expect(!AppInfo.demoNeverPrompts([:]))
        #expect(!AppInfo.demoNeverPrompts(["KUVO_DEMO_WINDOW": "1300x820", "KUVO_DEMO_APPEARANCE": "dark"]))
    }

    @Test func theTestCopyNeverAsks() {
        #expect(AppInfo.neverPrompts)
    }
}
