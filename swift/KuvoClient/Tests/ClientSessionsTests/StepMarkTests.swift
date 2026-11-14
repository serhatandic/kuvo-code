import ClientSessions
import Foundation
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

    /// A step done in an app on the computer shows that app's own icon, once its box found the app
    /// there; one the box didn't find shows none. Where a step names both, the site's shows.
    @Test func aStepDoneInAnAppShowsThatAppsIconOnceItsBoxFoundIt() throws {
        let decoded = try JSONDecoder().decode(GoalPlan.Step.self, from: Data(#"{"id":"s","text":"Build the core app","state":"doing","app":{"name":"Xcode","id":"com.apple.dt.Xcode"}}"#.utf8))
        #expect(GoalPlanWords.mark(of: decoded) == .app(id: "com.apple.dt.Xcode", name: "Xcode"))
        let missing = try JSONDecoder().decode(GoalPlan.Step.self, from: Data(#"{"id":"s","text":"Sketch the icon","state":"todo","app":{"name":"Sketch"}}"#.utf8))
        #expect(GoalPlanWords.mark(of: missing) == nil)
        let both = GoalPlan.Step(id: "s", text: "Submit", state: .todo, site: "appstoreconnect.apple.com", app: .init(name: "Transporter", id: "com.apple.TransporterApp"))
        #expect(GoalPlanWords.mark(of: both) == .site("appstoreconnect.apple.com"))
        let waiting = try JSONDecoder().decode(GoalPlan.Waiting.self, from: Data(#"{"id":"w","kind":"you","text":"Sign in to Xcode","app":{"name":"Xcode","id":"com.apple.dt.Xcode"},"at":1}"#.utf8))
        #expect(GoalPlanWords.mark(of: waiting) == .app(id: "com.apple.dt.Xcode", name: "Xcode"))
    }

    /// Where Start makes each project, as a proposed goal's box says; and your renames and moves go
    /// back to it in order.
    @Test func aProposedGoalSaysWhereItsProjectsGoAndTakesYourEdits() throws {
        let plan = try JSONDecoder().decode(GoalPlan.self, from: Data(#"{"id":"g","bot":"b","name":"Pixel","session":"s","goal":"An app","state":"proposed","steps":[],"proposed":1,"alone":true,"folders":[{"project":"Sweep","folder":"/Users/me/Projects/Sweep","shown":"~/Projects/Sweep","there":true},{"project":"Sweep Site","folder":null,"shown":null}]}"#.utf8))
        #expect(plan.folders == [.init(project: "Sweep", folder: "/Users/me/Projects/Sweep", shown: "~/Projects/Sweep", there: true), .init(project: "Sweep Site", folder: nil, shown: nil)])
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(GoalPlanAnswer.projects(["Tidy", "~/Code/Sweep Site"]))) as? [String: Any]
        #expect(sent?["action"] as? String == "projects")
        #expect(sent?["projects"] as? [String] == ["Tidy", "~/Code/Sweep Site"])
    }

    /// Renaming a project on its chip keeps where it goes; moving it keeps its name.
    @Test func aProjectRenamedKeepsItsPlaceAndMovedKeepsItsName() {
        #expect(GoalPlanWords.renamed("Sweep", to: " Tidy ") == "Tidy")
        #expect(GoalPlanWords.renamed("~/Code/Sweep", to: "Tidy") == "~/Code/Tidy")
        #expect(GoalPlanWords.renamed("/srv/apps/Sweep", to: "Tidy") == "/srv/apps/Tidy")
        #expect(GoalPlanWords.renamed("Sweep", to: "Sweep") == nil, "unchanged")
        #expect(GoalPlanWords.renamed("Sweep", to: "a/b") == nil)
        #expect(GoalPlanWords.renamed("Sweep", to: "  ") == nil)
        #expect(GoalPlanWords.moved("Sweep", into: "/Users/me/Code") == "/Users/me/Code/Sweep")
        #expect(GoalPlanWords.moved("~/Code/Sweep", into: "/srv/apps") == "/srv/apps/Sweep")
        #expect(GoalPlanWords.moved("/srv/apps/Sweep", into: "/srv/apps") == nil, "already there")
        #expect(GoalPlanWords.projectName("~/Code/Sweep") == "Sweep")
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
