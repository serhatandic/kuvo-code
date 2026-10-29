#if DEBUG
import ClientSessions
import Foundation

extension GoalPlans {
    /// KUVO_DEMO_GOAL=<bot's name>:<proposed|cant|running|month|done>: the bot's goal, a sample (the
    /// Driftwood landing page), for a look at its card and its lanes; `cant` is the card of a box
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
        let publics: [GoalPlan.Public] = [.init(id: "p1", text: "Publish the site when it’s ready", on: true), .init(id: "p2", text: "Turn on live payments", on: false)]
        let spend = [GoalPlan.Spend(what: "driftwood.coffee", cap: 15, currency: "USD", per: .goal, spent: kind == "proposed" || kind == "cant" ? 0 : 10.46)]
        let goal = "Launch a landing page for my coffee subscription, Driftwood, with a domain and Stripe checkout."
        let base = { (state: GoalPlan.State, steps: [GoalPlan.Step], checks: [GoalPlan.Check], started: Double?, ended: Double?, waiting: [GoalPlan.Waiting], paused: [GoalPlan.Paused], ends: Double?, report: String?, alone: Bool) in
            GoalPlan(id: "goal_demo", bot: bot.id, name: bot.name, session: bot.sessionID, goal: goal, title: "Driftwood’s landing page", state: state, steps: steps,
                     checks: checks, spend: spend, public: publics, digest: .none, ends: ends, proposed: started ?? ms(-2), started: started, ended: ended,
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
        default:
            return nil
        }
    }
}
#endif
