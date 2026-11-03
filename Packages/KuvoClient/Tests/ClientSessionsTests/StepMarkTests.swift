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
        #expect(GoalPlanWords.mark(of: step("Fix the sign-in", site: "support.apple.com")) == nil, "any of a maker's own sites")
        #expect(GoalPlanWords.mark(of: step("Turn on the API", site: "console.cloud.google.com")) == nil)
    }

    /// App Store Connect is on Apple's domain, whose icon is Apple's logo: it shows its own letter.
    /// So do the checks and waits that name it.
    @Test func aServiceOnAMakersDomainShowsItsOwnLetterNotTheMakersLogo() {
        #expect(GoalPlanWords.mark(of: step("Submit for review", site: "appstoreconnect.apple.com")) == .letter("App Store Connect"))
        #expect(GoalPlanWords.mark(site: "testflight.apple.com") == .letter("TestFlight"))
        #expect(GoalPlanWords.mark(site: "developer.apple.com") == .letter("Apple Developer"), "a check or a wait at a maker's site still names it")
        #expect(GoalPlanWords.mark(site: "dash.cloudflare.com") == .site("dash.cloudflare.com"))
    }

    /// The services that have a site of their own keep its mark, named for them.
    @Test func aServicesStepKeepsItsMark() {
        #expect(GoalPlanWords.mark(of: step("Monetization: RevenueCat SDK, paywall, StoreKit test configuration", site: "revenuecat.com")) == .site("revenuecat.com"))
        #expect(GoalPlanWords.mark(of: step("DNS", site: "cloudflare.com")) == .site("cloudflare.com"))
        #expect(GoalPlanWords.mark(of: step("Plan the screens", site: nil)) == nil)
        #expect(GoalPlanWords.service("appstoreconnect.apple.com") == "App Store Connect")
        #expect(GoalPlanWords.service("dash.cloudflare.com") == "Cloudflare")
    }
}
