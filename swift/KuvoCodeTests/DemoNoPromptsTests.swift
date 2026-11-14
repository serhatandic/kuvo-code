import Foundation
import Testing
import UserNotifications
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

    /// Its notifications go by what macOS was told for it before (the e2e copy, allowed once,
    /// keeps its banners); only one never asked stays quiet rather than ask.
    @Test func notificationsGoByWhatMacOSWasToldBefore() {
        #expect(Notifier.answered(.authorized) == true)
        #expect(Notifier.answered(.provisional) == true)
        #expect(Notifier.answered(.denied) == false)
        #expect(Notifier.answered(.notDetermined) == nil, "never asked: it would have to ask")
    }

    /// A usage screen asked for by name (screenshots) still opens; the panel otherwise stays out.
    @Test func aUsageScreenAskedForByNameStillOpens() {
        #expect(AppInfo.demoUsageScreen(["KUVO_DEMO_BACKGROUND": "1", "KUVO_DEMO_USAGE": "dashboard"]) == "dashboard")
        #expect(AppInfo.demoUsageScreen(["KUVO_DEMO_BACKGROUND": "1", "KUVO_DEMO_USAGE": "settings"]) == "settings")
        #expect(AppInfo.demoUsageScreen(["KUVO_DEMO_USAGE": "off"]) == nil)
        #expect(AppInfo.demoUsageScreen(["KUVO_DEMO_BACKGROUND": "1"]) == nil)
    }
}
