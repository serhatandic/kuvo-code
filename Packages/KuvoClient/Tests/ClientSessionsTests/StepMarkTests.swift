import ClientSessions
import Testing

/// Which mark a goal's step shows beside its name, on both apps: the product it's about, or the
/// service it's done at, never its maker's mark for anything the maker makes.
@Suite struct StepMarkTests {
    private func step(_ text: String, site: String?) -> GoalPlan.Step {
        GoalPlan.Step(id: "s", text: text, state: .todo, site: site)
    }

    /// The user's iOS goal: a bot gave its Xcode steps Apple's developer site, and they showed
    /// Apple's logo.
    @Test func anXcodeStepIsXcodesNotApples() {
        #expect(GoalPlanWords.mark(of: step("Scaffold the Sweep Xcode project (SwiftUI, SwiftData, app + test targets)", site: "developer.apple.com")) == .product("xcode"))
        #expect(GoalPlanWords.mark(of: step("Build and test on the simulator and a device", site: "developer.apple.com")) == nil)
        #expect(GoalPlanWords.mark(of: step("Ship it", site: "www.apple.com")) == nil)
    }

    /// The services that have a site of their own keep its mark, named for them.
    @Test func aServicesStepKeepsItsMark() {
        #expect(GoalPlanWords.mark(of: step("Monetization: RevenueCat SDK, paywall, StoreKit test configuration", site: "revenuecat.com")) == .site("revenuecat.com"))
        #expect(GoalPlanWords.mark(of: step("App Store listing, screenshots and privacy details", site: "appstoreconnect.apple.com")) == .site("appstoreconnect.apple.com"))
        #expect(GoalPlanWords.mark(of: step("DNS", site: "cloudflare.com")) == .site("cloudflare.com"))
        #expect(GoalPlanWords.mark(of: step("Plan the screens", site: nil)) == nil)
        #expect(GoalPlanWords.service("appstoreconnect.apple.com") == "App Store Connect")
        #expect(GoalPlanWords.service("dash.cloudflare.com") == "Cloudflare")
    }
}
