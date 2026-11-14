#if DEBUG
import ClientSessions
import Foundation
import OpenCodeKit

extension GoalPlans {
    /// KUVO_DEMO_GOAL=<bot's name>:<proposed|cant|running|month|weekly|done|sweep|sweepcard|sweepnew|sweeprun|sweeptwo>: the bot's goal, a sample (the
    /// Driftwood landing page), for a look at its card and its lanes; `sweepnew`, `sweeprun` and `sweeptwo` are Sweep
    /// with short step names, before a step begins, three steps in, and three done with two under way
    /// together, due in three days; `cant` is the card of a box
    /// that can't work on it alone, its sandbox check failed (KUVO_DEMO_SANDBOX=<reason> for another reason,
    /// or `old`).
    func demo(for bot: Bot) {
        guard let spec = ProcessInfo.processInfo.environment["KUVO_DEMO_GOAL"], let colon = spec.lastIndex(of: ":"),
              String(spec[..<colon]) == bot.name else { return }
        let kind = String(spec[spec.index(after: colon)...])
        if kind == "cant" {
            let reason = ProcessInfo.processInfo.environment["KUVO_DEMO_SANDBOX"] ?? "checkFailed"
            demoSandbox = reason == "old" ? .old : .status(GoalSandbox.Status(
                on: false, able: true, agents: false, reason: reason,
                route: ["checking", "checkFailed", "engineMissing", "plugin"].contains(reason) ? "POST kuvo/sandbox/check" : ["engineDown", "waiting"].contains(reason) ? "POST kuvo/engine/restart" : nil,
                needs: reason == "kernel" ? "Linux 5.13" : nil, check: reason == "checkFailed" ? "readsOwn" : nil, failures: reason == "checkFailed" ? 2 : nil))
        }
        demo = Self.sample(kind, bot: bot)
    }

    static func sample(_ kind: String, bot: Bot, now: Date = .now) -> GoalPlan? {
        let ms = { (minutes: Double) in now.addingTimeInterval(minutes * 60).timeIntervalSince1970 * 1000 }
        let cloudflare = "cloudflare.com", stripe = "stripe.com"
        let checks: [GoalPlan.Check] = [
            .init(id: "c1", text: "Add a Cloudflare API token", detail: "for the domain, DNS and hosting", state: .needs, by: .bot, site: cloudflare,
                  action: .init(kind: .open, label: "Add", url: URL(string: "https://dash.cloudflare.com/profile/api-tokens"))),
            .init(id: "c2", text: "Finish Stripe’s identity check", detail: "until then, checkout stays in test mode", state: .needs, by: .bot, site: stripe,
                  action: .init(kind: .open, label: "Open Stripe", url: URL(string: "https://dashboard.stripe.com"))),
            .init(id: "c3", text: "Stripe key works", detail: "restricted, from the vault", state: .ok, by: .bot, site: stripe),
            .init(id: "c4", text: "driftwood.coffee is free", detail: "$10.46 a year", state: .ok, by: .bot),
        ]
        let spend = [GoalPlan.Spend(what: "driftwood.coffee", cap: 15, currency: "USD", per: .goal, spent: kind == "proposed" || kind == "cant" ? 0 : 10.46)]
        let goal = "Launch a landing page for my coffee subscription, Driftwood, with a domain and Stripe checkout."
        let base = { (state: GoalPlan.State, steps: [GoalPlan.Step], checks: [GoalPlan.Check], started: Double?, ended: Double?, waiting: [GoalPlan.Waiting], paused: [GoalPlan.Paused], ends: Double?, report: String?, alone: Bool) in
            GoalPlan(id: "goal_demo", bot: bot.id, name: bot.name, session: bot.sessionID, goal: goal, title: "Driftwood’s landing page", state: state, steps: steps,
                     checks: checks, spend: spend, digest: .none, ends: ends, proposed: started ?? ms(-2), started: started, ended: ended,
                     waiting: waiting, paused: paused, report: report, alone: alone)
        }
        let plain: [GoalPlan.Step] = [
            .init(id: "s1", text: "Site", state: .todo),
            .init(id: "s2", text: "Domain", state: .todo, site: cloudflare),
            .init(id: "s3", text: "DNS", state: .todo, site: cloudflare, after: ["s2"]),
            .init(id: "s4", text: "Stripe", state: .todo, site: stripe),
            .init(id: "s5", text: "Checkout", state: .todo, site: stripe, after: ["s4"]),
            .init(id: "s6", text: "Deploy", state: .todo, site: cloudflare, after: ["s1", "s3"]),
        ]
        let identity = GoalPlan.Waiting(id: "w1", kind: .you, text: "Stripe’s identity check", url: URL(string: "https://dashboard.stripe.com"), site: stripe, at: ms(-130))
        switch kind {
        case "proposed":
            return base(.proposed, plain, checks, nil, nil, [], [], nil, nil, true)
        case "cant":
            let alone = GoalPlan.Check(id: "alone", text: "This Mac can’t work on it alone yet", state: .failed, by: .box)
            return base(.proposed, plain, checks + [alone], nil, nil, [], [], nil, nil, false)
        case "running":
            let steps: [GoalPlan.Step] = [
                .init(id: "s1", text: "Site", state: .doing, progress: 0.75, note: "6 of 8 pages", began: ms(-140)),
                .init(id: "s2", text: "Domain", state: .done, note: "$10.46", site: cloudflare, began: ms(-138), ended: ms(-112)),
                .init(id: "s3", text: "DNS", state: .doing, note: "Spreading", site: cloudflare, after: ["s2"], began: ms(-110)),
                .init(id: "s4", text: "Stripe", state: .waiting, site: stripe, began: ms(-128)),
                .init(id: "s5", text: "Checkout", state: .paused, progress: 0.4, site: stripe, after: ["s4"], sessions: ["ses_checkout"], resumes: ms(48), began: ms(-90), ended: nil),
                .init(id: "s6", text: "Deploy", state: .todo, site: cloudflare, after: ["s3"]),
            ]
            return base(.running, steps, checks.filter { $0.state == .ok }, ms(-142), nil, [identity], [.init(why: "Claude’s limit", until: ms(48), session: "ses_checkout")], nil, nil, true)
        case "done":
            let steps = plain.enumerated().map { index, step in
                GoalPlan.Step(id: step.id, text: step.text, state: .done, note: index == 1 ? "$10.46" : nil, site: step.site, after: step.after,
                              began: ms(-200 + Double(index) * 22), ended: ms(-160 + Double(index) * 25))
            }
            return base(.done, steps, checks.filter { $0.state == .ok }, ms(-202), ms(-10), [], [], nil,
                        "Driftwood’s landing page is live at driftwood.coffee, with checkout in test mode until Stripe’s identity check is done.", true)
        case "month":
            let day = 24.0 * 60
            let step = { (id: String, text: String, phase: String, state: GoalPlan.Step.State, from: Double?, to: Double?, progress: Double?, site: String?, note: String?) in
                GoalPlan.Step(id: id, text: text, state: state, progress: progress, note: note, phase: phase, site: site, began: from.map { ms($0 * day) }, ended: to.map { ms($0 * day) })
            }
            let steps: [GoalPlan.Step] = [
                step("m1", "Research", "Research", .done, -9, -8.5, nil, nil, nil),
                step("m2", "Brand and copy", "Research", .done, -8.5, -7, nil, nil, nil),
                step("m3", "Domain", "Build", .done, -8, -7.8, nil, cloudflare, nil),
                step("m4", "DNS", "Build", .done, -7.8, -7.2, nil, cloudflare, nil),
                step("m5", "Site", "Build", .done, -7, -3, nil, nil, nil),
                step("m6", "Pricing page", "Build", .done, -4, -1.5, nil, nil, nil),
                step("m7", "Deploy", "Build", .done, -1.5, -0.8, nil, cloudflare, nil),
                step("m8", "Subscriber portal", "Build", .doing, -2, nil, 0.6, nil, "3 of 5 screens"),
                step("m9", "Search setup", "Build", .paused, -0.6, nil, nil, nil, nil),
                step("m10", "Stripe live", "Launch", .waiting, -0.5, nil, nil, stripe, nil),
                step("m11", "Press kit", "Launch", .doing, -1.4, nil, 0.5, nil, "2 of 4 assets"),
                GoalPlan.Step(id: "m12", text: "Launch post", state: .todo, phase: "Launch", after: ["m11"]),
                GoalPlan.Step(id: "m13", text: "Newsletter", state: .todo, phase: "Grow", after: ["m12"]),
                GoalPlan.Step(id: "m14", text: "Ads", state: .todo, phase: "Grow", after: ["m12"]),
                GoalPlan.Step(id: "m15", text: "First 100 subscribers", state: .todo, phase: "Grow", site: stripe, after: ["m13", "m14"]),
            ]
            return base(.running, steps, checks.filter { $0.state == .ok }, ms(-9 * day), nil, [GoalPlan.Waiting(id: "w1", kind: .you, text: "Stripe’s identity check", url: URL(string: "https://dashboard.stripe.com"), site: stripe, at: ms(-0.5 * day))],
                        [.init(why: "Claude’s limit", until: ms(48))], ms(21 * day), nil, true)
        case "weekly":
            // Two months of weekly summaries: many steps, long names, the next one at a time.
            let day = 24.0 * 60
            let weeks: [GoalPlan.Step] = (0..<9).map { week in
                let from = Double(week - 2) * 7
                let state: GoalPlan.Step.State = week < 2 ? .done : .todo
                return GoalPlan.Step(id: "w\(week)", text: "Summarise the week’s commits, releases and open questions (\(week + 1) of 9)", state: state,
                                     note: week < 2 ? "Posted in #updates" : nil, after: week == 0 ? [] : ["w\(week - 1)"],
                                     began: state == .done ? ms(from * day) : nil, ended: state == .done ? ms(from * day + 50) : nil)
            }
            return GoalPlan(id: "goal_demo", bot: bot.id, name: bot.name, session: bot.sessionID,
                            goal: "Every Monday, write a summary of the week’s work on kuvo-ai and kuvo-code-ios for the changelog, and post it in #updates, for the next two months.",
                            title: "Weekly summaries", state: .running, steps: weeks, ends: ms(49 * day), proposed: ms(-15 * day), started: ms(-14 * day),
                            next: ms(2 * day), alone: true)
        case "sweep", "sweepcard":
            // An iOS app from nothing, as a bot writes it: two paragraphs with Markdown, long step
            // names, Apple's sites, and no times yet (nothing has started).
            let apple = "developer.apple.com", connect = "appstoreconnect.apple.com", revenuecat = "revenuecat.com"
            let goal = """
                Build **Sweep**, a native iOS app that helps people keep their homes tidy with short daily routines, streaks and gentle reminders, with a monthly and a yearly subscription through RevenueCat, and ship it to the App Store.

                I'll plan the screens, scaffold the Xcode project, build the routines, streaks and reminders, wire up RevenueCat with a StoreKit test configuration, write the App Store listing and screenshots, and get it through TestFlight to review. You only need to set up the accounts I can't make myself.
                """
            let steps: [GoalPlan.Step] = [
                .init(id: "i1", text: "Plan the screens, data model and navigation", state: .todo),
                .init(id: "i2", text: "Scaffold the Sweep Xcode project (SwiftUI, SwiftData, navigation, app + test targets)", state: .todo, after: ["i1"]),
                .init(id: "i3", text: "Routines, streaks and reminders", state: .todo, after: ["i2"]),
                .init(id: "i4", text: "Monetization: RevenueCat SDK, paywall, monthly and yearly products, StoreKit test configuration", state: .todo, site: revenuecat, after: ["i2"]),
                .init(id: "i5", text: "Build and test on the simulator and a device", state: .todo, after: ["i3", "i4"]),
                .init(id: "i6", text: "App Store listing, screenshots and privacy details", state: .todo, site: connect, after: ["i5"]),
                .init(id: "i7", text: "TestFlight, then submit for review", state: .todo, site: connect, after: ["i6"]),
            ]
            let checks: [GoalPlan.Check] = [
                .init(id: "k1", text: "Apple Developer account", detail: "to sign and ship the app", state: .needs, by: .bot, site: apple,
                      action: .init(kind: .open, label: "Open", url: URL(string: "https://developer.apple.com/account"))),
                .init(id: "k2", text: "RevenueCat project", detail: "with an API key for the app", state: .needs, by: .bot, site: revenuecat,
                      action: .init(kind: .open, label: "Open", url: URL(string: "https://app.revenuecat.com"))),
                .init(id: "k3", text: "Subscription products", detail: "monthly and yearly, in App Store Connect", state: .needs, by: .bot, site: connect,
                      action: .init(kind: .open, label: "Open", url: URL(string: "https://appstoreconnect.apple.com/apps"))),
                .init(id: "k4", text: "Xcode 27 is installed", state: .ok, by: .bot),
            ]
            let running = kind == "sweep"
            let waiting = [GoalPlan.Waiting(id: "w1", kind: .you, text: "RevenueCat project", detail: "with an API key for the app", url: URL(string: "https://app.revenuecat.com"), site: revenuecat, at: ms(-12))]
            return GoalPlan(id: "goal_demo", bot: bot.id, name: bot.name, session: bot.sessionID, goal: goal, title: "Sweep iOS app",
                            state: running ? .running : .proposed, steps: steps, checks: running ? checks.filter { $0.state == .ok } : checks,
                            proposed: ms(-20), started: running ? ms(-15) : nil, waiting: running ? waiting : [], alone: true)
        case "sweepnew", "sweeprun", "sweeptwo":
            // Sweep with short names, due in three days: before a step begins, three steps in with
            // the paywall under way, or three done with the dashboard and the polish under way together.
            let revenuecat = "revenuecat.com", appStoreConnect = "appstoreconnect.apple.com"
            let run = kind != "sweepnew", two = kind == "sweeptwo"
            let goal = "Build an iOS app that prints money: a shippable product, no backend, **RevenueCat** for users and payments, project at `~/Desktop/main/money-printer`. No budget needed: everything runs locally, no paid APIs or services. Concept I'd ship: **Sweep**, an on-device photo and storage cleaner that finds duplicates, blurry shots and old screenshots, with a yearly subscription."
            let steps: [GoalPlan.Step] = [
                .init(id: "p1", text: "Set up the Xcode project", state: run ? .done : .todo, detail: "SwiftUI app and test targets", began: run ? ms(-130) : nil, ended: run ? ms(-94) : nil),
                .init(id: "p2", text: "Photo scan engine", state: run ? .done : .todo, detail: "Duplicates and blurry shots", after: ["p1"], began: run ? ms(-94) : nil, ended: run ? ms(-22) : nil),
                .init(id: "p3", text: "Storage dashboard", state: two ? .doing : .todo, progress: two ? 0.4 : nil, detail: "Space used, by kind", after: ["p2"], began: two ? ms(-21) : nil),
                .init(id: "p4", text: "RevenueCat paywall", state: two ? .done : run ? .doing : .todo, progress: run && !two ? 0.5 : nil, note: run && !two ? "2 of 4 screens" : nil,
                      detail: "SDK, paywall, test config", site: revenuecat, after: ["p1"], began: run ? ms(-88) : nil, ended: two ? ms(-40) : nil),
                .init(id: "p5", text: "Icon and polish", state: two ? .doing : .todo, detail: "Icon, launch, empty states", after: ["p4"], began: two ? ms(-38) : nil),
                .init(id: "p6", text: "Test on a device", state: .todo, detail: "Device runs and screenshots", after: ["p3", "p5"]),
                .init(id: "p7", text: "App Store kit", state: .todo, detail: "Privacy, listing, screenshots", site: appStoreConnect, after: ["p6"]),
                .init(id: "p8", text: "Submit for review", state: .todo, detail: "Upload and send for review", site: appStoreConnect, after: ["p7"]),
            ]
            let waiting = two ? [] : [GoalPlan.Waiting(id: "w1", kind: .you, text: "RevenueCat project", detail: "with an API key for the app", url: URL(string: "https://app.revenuecat.com"), site: revenuecat, at: ms(-12))]
            return GoalPlan(id: "goal_demo_\(kind)", bot: bot.id, name: bot.name, session: bot.sessionID, goal: goal, title: "Sweep iOS app",
                            state: .running, steps: steps, ends: ms(3 * 24 * 60), proposed: ms(-140), started: ms(run ? -131 : -1), waiting: waiting, alone: true)
        default:
            return nil
        }
    }

    /// KUVO_DEMO_GOAL_STATE=<working|paused:<you|limit|error|stalled>>, with KUVO_DEMO_GOAL: the
    /// conversation's own goal beside the sample, so its bar has Pause, or Resume and why it's paused.
    static func demoGoal(for plan: GoalPlan) -> Goal? {
        guard plan.id.hasPrefix("goal_demo"), let spec = ProcessInfo.processInfo.environment["KUVO_DEMO_GOAL_STATE"] else { return nil }
        let parts = spec.split(separator: ":").map(String.init)
        guard !parts.isEmpty else { return nil }
        var goal: [String: Any] = ["session": plan.session, "condition": plan.goal, "state": parts[0], "started": plan.started ?? plan.proposed, "turns": 4, "checking": false]
        if parts.count > 1 {
            goal["pausedBy"] = parts[1]
            if parts[1] == "error" { goal["note"] = "The last turn failed: the model’s provider answered 529, overloaded." }
        }
        return (try? JSONSerialization.data(withJSONObject: goal)).flatMap { try? JSONDecoder().decode(Goal.self, from: $0) }
    }
}
#endif
