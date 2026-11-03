import ClientSessions
import Testing

/// Which mark a goal's step shows beside its name, on both apps: the icon of the site the plan says
/// it's done at, never one guessed from its words or its maker.
@Suite struct StepMarkTests {
    private func step(_ text: String, site: String?) -> GoalPlan.Step {
        GoalPlan.Step(id: "s", text: text, state: .todo, site: site)
    }

    /// The user's iOS goal: a bot gave its Xcode step Apple's developer site, and it showed Apple's
    /// logo. A step done on the computer has no site, so no mark, whatever product its words name.
    @Test func aLocalStepHasNoMarkWhateverItsWordsName() {
        #expect(GoalPlanWords.mark(of: step("Scaffold the Sweep Xcode project", site: nil)) == nil)
        #expect(GoalPlanWords.mark(of: step("Plan the screens", site: nil)) == nil)
    }

    /// A step done at a site shows that site's own icon, whoever makes it.
    @Test func aStepDoneAtASiteShowsThatSitesIcon() {
        #expect(GoalPlanWords.mark(of: step("Submit for review", site: "appstoreconnect.apple.com")) == .site("appstoreconnect.apple.com"))
        #expect(GoalPlanWords.mark(of: step("RevenueCat paywall", site: "revenuecat.com")) == .site("revenuecat.com"))
        #expect(GoalPlanWords.mark(of: step("Turn on the API", site: "console.cloud.google.com")) == .site("console.cloud.google.com"))
    }

    @Test func aServiceIsNamedFromItsSite() {
        #expect(GoalPlanWords.service("dash.cloudflare.com") == "Cloudflare")
        #expect(GoalPlanWords.service("www.stripe.com") == "Stripe")
    }

    @Test func aServiceIsNamedAsTheAskWritesIt() {
        #expect(GoalPlanWords.service("app.revenuecat.com", in: ["RevenueCat project", "with an API key for the app"]) == "RevenueCat")
        #expect(GoalPlanWords.service("appstoreconnect.apple.com", in: ["Agreements in App Store Connect"]) == "App Store Connect")
        #expect(GoalPlanWords.service("dash.cloudflare.com", in: ["Point the domain at the app"]) == "Cloudflare", "words that don't name it leave its site's name")
        #expect(GoalPlanWords.service("billing.stripe.com", in: ["Update billing details"]) == "Stripe", "a plain word isn't the service's name")
        #expect(GoalPlanWords.service("console.cloud.google.com", in: ["Create a key in the Cloud console"]) == "Google")
        #expect(GoalPlanWords.service("", in: [""]) == "")
    }
}
