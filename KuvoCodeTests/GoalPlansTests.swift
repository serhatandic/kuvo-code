import ClientSessions
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// A bot's goal, as this Mac shows it (PROTOCOL.md, "Work › Goals"): the card a bot puts to you
/// waits on you in the sidebar; Start Goal takes your switches, end and digest to the bot's box,
/// which runs it; a box that can't work on it alone says so on the card and runs it all the same;
/// Stop ends one under way; /goal in a bot's chat asks it for a plan. The machine's box is the real
/// one (`kuvo-link.js serve`), reached over HTTP where a Mac reaches it over SSH.
@MainActor
@Suite(.serialized) struct GoalPlansTests {
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
        app.goalPlans.app = app
        app.goalPlans.onChange = { [app] sessions in app.workspace.goalCards = sessions }
    }

    /// Pixel's goal on the machine, at `state`; the machine may work on it alone where `alone`.
    private func lab(_ state: String = "proposed", alone: Bool = true, waiting: [[String: Any]] = [], ends: Double? = nil) async throws -> MachineTestBox {
        let machine = try await MachineTestBox(name: "lab", environment: alone ? ["KUVO_TEST_SANDBOX_ON": "1"] : [:])
        let folder = machine.folder.appending(path: "bots/bot_pixel00001")
        try FileManager.default.createDirectory(at: folder.appending(path: "workspace"), withIntermediateDirectories: true)
        try Data(#"{"kuvo": 1, "id": "bot_pixel00001", "name": "Pixel", "job": "Builds apps", "look": {"color": "graphite", "shape": "squircle", "face": "bright"}, "created": "2026-10-01T09:00:00Z", "updated": "2026-10-01T09:00:00Z"}"#.utf8)
            .write(to: folder.appending(path: "bot.json"))
        try Data("ses_pixel".utf8).write(to: folder.appending(path: "session"))
        let now = Date.now.timeIntervalSince1970 * 1000
        let goal: [String: Any] = [
            "id": "goal_1", "bot": "bot_pixel00001", "name": "Pixel", "session": "ses_pixel", "goal": "Launch Driftwood.", "state": state,
            "steps": [["id": "s1", "text": "Build the site", "state": state == "running" ? "doing" : "todo", "progress": 0.5], ["id": "s2", "text": "Deploy", "state": "todo", "phase": "Launch"]],
            "checks": [["id": "c1", "text": "Add a Cloudflare API token", "state": "needs", "by": "bot", "action": ["kind": "open", "label": "Add", "url": "https://dash.cloudflare.com"]]],
            "spend": [["what": "ads", "cap": 20, "currency": "USD", "per": "day", "spent": 0]], "public": [["id": "p1", "text": "Publish the site", "on": false]],
            "projects": [String](), "wake": false, "digest": "day", "proposed": now, "waiting": waiting, "paused": [Any](), "waited": 0, "watching": [String](),
        ].merging(state == "running" ? ["started": now] : [:]) { _, given in given }.merging(ends.map { ["ends": $0] } ?? [:]) { _, given in given }
        try FileManager.default.createDirectory(at: machine.folder.appending(path: "run/work"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["goals": [goal]]).write(to: machine.folder.appending(path: "run/work/goals.json"))
        app.goalPlans.boxes = { box in box == "lab" ? machine.client : BoxClient(box: box, transport: LocalBox { _ in AsyncThrowingStream { $0.finish() } }) }
        app.goalPlans.connected = { $0 == "lab" }
        return machine
    }

    private func kept(_ machine: MachineTestBox) throws -> [String: Any] {
        let file = try JSONSerialization.jsonObject(with: Data(contentsOf: machine.folder.appending(path: "run/work/goals.json"))) as? [String: Any]
        return try #require((file?["goals"] as? [[String: Any]])?.first)
    }

    @Test func aBotsGoalShowsItsCardAndStartsOnItsBoxWithYourSwitchesEndAndDigest() async throws {
        let machine = try await lab()
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        #expect(box == "lab")
        #expect(plan.isProposed && plan.alone)
        #expect(plan.yours.map(\.text) == ["Add a Cloudflare API token"], "what only you can do comes first, with its button")
        #expect(plan.phases == ["Launch"])
        #expect(GoalPlanWords.spend(plan.spend[0]) == "ads, up to $20 a day")
        #expect(GoalPlanWords.spoken(plan.steps[0]) == "Build the site, not started")
        #expect(app.workspace.needsAttention("ses_pixel"), "the bot waits on you in the sidebar")

        let ends = Date.now.addingTimeInterval(7 * 86_400)
        let started = try #require(try await app.goalPlans.answer(plan, on: box, .start(public: ["p1": true], wake: true, digest: .week, ends: ends, spend: [.init(cap: 30, per: .week)])))
        #expect(started.state == .running)
        #expect(started.public.map(\.on) == [true])
        #expect(started.digest == .week)
        #expect(started.spend.first.map { [$0.cap, $0.per.rawValue] as [AnyHashable] } == [30.0, "week"])
        #expect(!app.workspace.needsAttention("ses_pixel"), "started, it no longer waits on you")
        #expect(try kept(machine)["state"] as? String == "running", "kept on its box, which runs it")
    }

    @Test func aBoxThatCantWorkOnItAloneSaysSoOnTheCardAndRunsItWithYouThere() async throws {
        let machine = try await lab(alone: false)
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        #expect(!plan.alone)
        let found = plan.checks.first { $0.cantWorkAlone }
        let check = try #require(found)
        #expect(check.text.hasPrefix("This machine can"))
        #expect(!check.text.localizedCaseInsensitiveContains("sandbox") && !check.text.localizedCaseInsensitiveContains("fence"))
        let started = try #require(try await app.goalPlans.answer(plan, on: box, .start(public: [:], wake: false)))
        #expect(started.state == .running)
    }

    @Test func stopEndsAGoalUnderWayAndATrackSaysHowFarItIsOnlyWhereItsMeasured() async throws {
        let machine = try await lab("running")
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        #expect(plan.underWay.map(\.text) == ["Build the site"])
        #expect(GoalPlanWords.spoken(plan.steps[0]) == "Build the site, half done")
        #expect(GoalPlanWords.progress(plan) == "0 of 2")
        let stopped = try #require(try await app.goalPlans.answer(plan, on: box, .stop))
        #expect(stopped.state == .stopped)
        #expect(try kept(machine)["state"] as? String == "stopped")
    }

    @Test func whatWaitsForYouPutAwayAndLimitsChangedReachTheGoalsBox() async throws {
        let now = Date.now.timeIntervalSince1970 * 1000
        let machine = try await lab("running", waiting: [["id": "w1", "kind": "you", "text": "Stripe’s identity check", "site": "stripe.com", "url": "https://dashboard.stripe.com", "at": now]])
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        #expect(plan.waiting.map(\.text) == ["Stripe’s identity check"])

        let cleared = try #require(try await app.goalPlans.answer(plan, on: box, .clear(waiting: "w1")))
        #expect(cleared.waiting.isEmpty, "its row goes from under the lanes")
        #expect((try kept(machine)["waiting"] as? [Any])?.isEmpty == true, "and from its box, for every client")

        let changed = try #require(try await app.goalPlans.answer(cleared, on: box, .change(digest: .week, spend: [.init(cap: 40, per: .month)])))
        #expect(changed.digest == .week)
        #expect(changed.spend.first.map { [$0.cap, $0.per.rawValue] as [AnyHashable] } == [40.0, "month"])
        #expect(try kept(machine)["digest"] as? String == "week")
        #expect(app.goalPlans.plan(for: "ses_pixel")?.plan.digest == .week, "the bar shows what its box keeps now")
    }

    /// Why a box can't work on a goal alone, on its card: the words and where its button goes, as
    /// the box names the reason.
    @Test func theSandboxRowSaysWhyAndItsButtonGoesWhereYouCanFixIt() throws {
        let row = { (reading: GoalSandbox.Reading?, onThisMac: Bool, agent: String?) in
            GoalSandbox.row(reading, computer: onThisMac ? "This Mac" : "lokum", onThisMac: onThisMac, bot: "Pixel", agent: agent)
        }
        let status = { (reason: String, route: String?) in GoalSandbox.Reading.status(.init(on: false, reason: reason, route: route)) }

        #expect(row(.status(.init(on: true)), true, nil) == nil)
        let notOn = try #require(row(.status(.init(on: false)), true, nil), "not on, with no reason (switched off for the rollout): it says so, with nothing to press")
        #expect(notOn.title == "This Mac can’t work on its own yet")
        #expect(notOn.buttons.isEmpty)
        let unknown = try #require(row(status("somethingNew", "POST kuvo/sandbox/check"), false, nil), "a reason from a newer box still says it can't, and checks again")
        #expect(unknown.title == "lokum can’t work on its own yet")
        #expect(unknown.buttons == [.init(label: "Try Again", action: .route(method: "POST", path: "kuvo/sandbox/check"))])

        let kernel = try #require(row(.status(.init(on: false, able: false, reason: "kernel", needs: "Linux 5.13")), false, nil))
        #expect(kernel.text.contains("Linux 5.13 or later"))
        #expect(kernel.buttons.map(\.label) == ["How to Check…"])
        #expect(row(status("macos", nil), true, nil)?.buttons == [.init(label: "Software Update…", action: .open(GoalSandbox.softwareUpdate))])

        let failedOnce = try #require(row(.status(.init(on: false, reason: "checkFailed", route: "POST kuvo/sandbox/check", check: "readsOwn", failures: 1)), true, nil))
        #expect(failedOnce.text == "Its check found that a command could still read Kuvo Code’s files, so commands run outside the sandbox for now. Try Again checks it again.")
        #expect(failedOnce.buttons == [.init(label: "Try Again", action: .route(method: "POST", path: "kuvo/sandbox/check"))])
        let failedTwice = try #require(row(.status(.init(on: false, reason: "checkFailed", route: "POST kuvo/sandbox/check", check: "tempFiles", failures: 2)), true, nil))
        #expect(failedTwice.text.hasPrefix("Its check failed again: a command couldn’t write its temporary files"))
        #expect(failedTwice.buttons.map(\.label) == ["Try Again", "Report a Problem…"], "Report a Problem joins once it fails again")

        #expect(row(status("plugin", "POST kuvo/sandbox/check"), true, nil)?.buttons == [.init(label: "Fix It", action: .route(method: "POST", path: "kuvo/sandbox/check"))])
        for reason in ["engineDown", "waiting"] {
            #expect(row(status(reason, "POST kuvo/engine/restart"), true, nil)?.buttons == [.init(label: "Restart Engine", action: .route(method: "POST", path: "kuvo/engine/restart"))])
        }
        #expect(row(status("checking", "POST kuvo/sandbox/check"), false, nil)?.checking == true)

        // A box from before the sandbox: the machine is updated from Machines; this Mac, as an app.
        #expect(row(.old, false, nil)?.buttons == [.init(label: "Update lokum…", action: .updateMachine)])
        #expect(row(.old, true, nil)?.buttons == [.init(label: "Check for Updates…", action: .checkForUpdates)])

        // A bot on a coding agent: the sandbox doesn't cover its commands, whatever the box says.
        let agents = try #require(row(.status(.init(on: true, agents: false)), true, "Claude Code"))
        #expect(agents.title == "Pixel can’t work on its own yet")
        #expect(agents.text.contains("runs on Claude Code"))
        #expect(agents.buttons == [.init(label: "Use the Engine…", action: .editBot)])
    }

    @Test func startSendsTheCardsSwitchesDeadlineAndChangedLimits() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let plan = GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_pixel", goal: "Launch Driftwood.", state: .proposed, steps: [],
                            spend: [.init(what: "ads", cap: 20, currency: "USD", per: .day)],
                            public: [.init(id: "p1", text: "Publish the site", on: true), .init(id: "p2", text: "Turn on live payments", on: false)],
                            proposed: now.timeIntervalSince1970 * 1000, alone: true)
        let answer = GoalCard.start(plan, switches: ["p1": false], wake: true, digest: .week, deadline: .days(1), caps: [30], periods: [.week], now: now, calendar: calendar)
        #expect(answer.action == .start)
        #expect(answer.public == ["p1": false, "p2": false], "the switch turned off goes off; one left alone keeps the plan's")
        #expect(answer.spend == [.init(cap: 30, per: .week)])
        #expect(answer.wake == true && answer.digest == .week)
        let tomorrow = calendar.date(bySettingHour: 23, minute: 59, second: 0, of: calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))!)!
        #expect(answer.ends == tomorrow.timeIntervalSince1970 * 1000, "Tomorrow ends as tomorrow does")
        #expect(GoalCard.start(plan, switches: [:], wake: false, digest: .none, deadline: .none, caps: [], periods: [], now: now, calendar: calendar).ends == nil)
    }

    @Test func aCardFromMoreThanADayAgoSaysWhyItCantStart() async throws {
        let machine = try await lab()
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        // The card stayed open past a day: its box has it as put to you two days ago.
        let file = machine.folder.appending(path: "run/work/goals.json")
        var kept = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        var goals = try #require(kept["goals"] as? [[String: Any]])
        goals[0]["proposed"] = Date.now.timeIntervalSince1970 * 1000 - 2 * 86_400_000
        kept["goals"] = goals
        try JSONSerialization.data(withJSONObject: kept).write(to: file)
        do {
            try await app.goalPlans.answer(plan, on: box, .start(public: [:], wake: false))
            Issue.record("a stale plan can't start")
        } catch let refusal as BoxRefusal {
            #expect(refusal.status == 400)
            #expect(!refusal.message.isEmpty && !refusal.message.hasPrefix("It said no"), "the box's own words, for the card")
        }
    }

    /// A box with goals has the sandbox's check too: one whose sandbox isn't on says why, from the
    /// box's own reading, rather than that it can't tell.
    @Test func aBoxWhoseSandboxIsntOnSaysWhyOnTheGoalsCard() async throws {
        let machine = try await lab(alone: false)
        defer { machine.stop() }
        let reading = await app.goalPlans.sandbox(on: "lab")
        guard case .status(let status) = reading else {
            Issue.record("the box should say how its sandbox stands, not \(reading)")
            return
        }
        #expect(!status.on)
        let row = try #require(GoalSandbox.row(reading, computer: "lab", onThisMac: false, bot: "Pixel", agent: nil))
        #expect(row.title.hasPrefix("lab can’t work on its own"))
    }

    @Test func noneAfterTheBotsDeadlineStartsTheGoalWithNoEnd() async throws {
        let machine = try await lab(ends: Date.now.addingTimeInterval(7 * 86_400).timeIntervalSince1970 * 1000)
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        #expect(plan.ends != nil, "the bot proposed an end")
        let answer = GoalCard.start(plan, switches: [:], wake: false, digest: .none, deadline: .none, caps: [], periods: [])
        let started = try #require(try await app.goalPlans.answer(plan, on: box, answer))
        #expect(started.state == .running)
        #expect(started.ends == nil, "None takes the bot's end away")
        #expect(try kept(machine)["ends"] == nil)
    }
}
