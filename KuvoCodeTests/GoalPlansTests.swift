import AppKit
import ClientSessions
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// A bot's goal, as this Mac shows it (PROTOCOL.md, "Work › Goals"): the card a bot puts to you
/// waits on you in the sidebar; Start Goal takes your end, limits and digest to the bot's box,
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
    private func lab(_ state: String = "proposed", alone: Bool = true, waiting: [[String: Any]] = [], ends: Double? = nil, projects: [String] = []) async throws -> MachineTestBox {
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
            "projects": projects, "wake": false, "digest": "day", "proposed": now, "waiting": waiting, "paused": [Any](), "waited": 0, "watching": [String](),
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
        #expect(GoalPlanWords.summary(plan) == "2 steps", "its phase (Launch) isn't said")
        #expect(GoalPlanWords.spend(plan.spend[0]) == "ads, up to $20 a day")
        #expect(GoalPlanWords.spokenState(of: plan.steps[0], in: plan) == "not started")
        #expect(app.workspace.needsAttention("ses_pixel"), "the bot waits on you in the sidebar")

        let ends = Date.now.addingTimeInterval(7 * 86_400)
        let started = try #require(try await app.goalPlans.answer(plan, on: box, .start(wake: true, digest: .week, ends: ends, spend: [.init(cap: 30, per: .week)])))
        #expect(started.state == .running)
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
        let started = try #require(try await app.goalPlans.answer(plan, on: box, .start(wake: false)))
        #expect(started.state == .running)
    }

    @Test func stopEndsAGoalUnderWayAndATrackSaysHowFarItIsOnlyWhereItsMeasured() async throws {
        let machine = try await lab("running")
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        #expect(plan.underWay.map(\.text) == ["Build the site"])
        #expect(GoalPlanWords.spokenState(of: plan.steps[0], in: plan) == "About half")
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
        let row = { (reading: GoalSandbox.Reading?, onThisMac: Bool, codingAgent: Bool) in
            GoalSandbox.row(reading, computer: onThisMac ? "This Mac" : "devbox", onThisMac: onThisMac, bot: "Pixel", codingAgent: codingAgent)
        }
        let status = { (reason: String, route: String?) in GoalSandbox.Reading.status(.init(on: false, reason: reason, route: route)) }

        #expect(row(.status(.init(on: true)), true, false) == nil)
        let notOn = try #require(row(.status(.init(on: false)), true, false), "not on, with no reason (switched off for the rollout): it says so, with nothing to press")
        #expect(notOn.title == "This Mac can’t work on its own yet")
        #expect(notOn.buttons.isEmpty)
        let unknown = try #require(row(status("somethingNew", "POST kuvo/sandbox/check"), false, false), "a reason from a newer box still says it can't, and checks again")
        #expect(unknown.title == "devbox can’t work on its own yet")
        #expect(unknown.buttons == [.init(label: "Try Again", action: .route(method: "POST", path: "kuvo/sandbox/check"))])

        let kernel = try #require(row(.status(.init(on: false, able: false, reason: "kernel", needs: "Linux 5.13")), false, false))
        #expect(kernel.text.contains("Linux 5.13 or later"))
        #expect(kernel.buttons.map(\.label) == ["How to Check…"])
        // A machine whose commands can't have a namespace of their own, from a box that doesn't run without one.
        let namespaces = try #require(row(.status(.init(on: false, able: false, reason: "namespaces", needs: "user namespaces")), false, false))
        #expect(namespaces.title == "devbox can’t work on its own")
        #expect(namespaces.text.contains("Ask whoever runs it to allow user namespaces"))
        #expect(namespaces.buttons.map(\.label) == ["How to Check…"])
        #expect(row(status("macos", nil), true, false)?.buttons == [.init(label: "Software Update…", action: .open(GoalSandbox.softwareUpdate))])

        let failedOnce = try #require(row(.status(.init(on: false, reason: "checkFailed", route: "POST kuvo/sandbox/check", check: "readsOwn", failures: 1)), true, false))
        #expect(failedOnce.text == "Its check found that a command could still read Kuvo Code’s files, so commands run outside the sandbox for now. Try Again checks it again.")
        #expect(failedOnce.buttons == [.init(label: "Try Again", action: .route(method: "POST", path: "kuvo/sandbox/check"))])
        let failedTwice = try #require(row(.status(.init(on: false, reason: "checkFailed", route: "POST kuvo/sandbox/check", check: "tempFiles", failures: 2)), true, false))
        #expect(failedTwice.text.hasPrefix("Its check failed again: a command couldn’t write its temporary files"))
        #expect(failedTwice.buttons.map(\.label) == ["Try Again", "Report a Problem…"], "Report a Problem joins once it fails again")

        #expect(row(status("plugin", "POST kuvo/sandbox/check"), true, false)?.buttons == [.init(label: "Fix It", action: .route(method: "POST", path: "kuvo/sandbox/check"))])
        for reason in ["engineDown", "waiting"] {
            #expect(row(status(reason, "POST kuvo/engine/restart"), true, false)?.buttons == [.init(label: "Restart Sessions", action: .restartSessions(method: "POST", path: "kuvo/engine/restart"))])
        }
        #expect(row(status("waiting", "POST kuvo/engine/restart"), false, false)?.text.hasPrefix("Sessions on devbox started before the sandbox was set up") == true)
        #expect(row(status("checking", "POST kuvo/sandbox/check"), false, false)?.checking == true)
        // Restart Sessions pressed (review of 8eb319e: it was posted and let go): it says they're
        // restarting while the box says they're down or from before it, and nothing to press.
        for reason in ["engineDown", "waiting"] {
            let back = try #require(GoalSandbox.row(status(reason, "POST kuvo/engine/restart"), computer: "devbox", onThisMac: false, bot: "Pixel", codingAgent: false, restartingSessions: true))
            #expect(back.title == "Restarting sessions in the sandbox…" && back.checking && back.buttons.isEmpty)
            #expect(back.text == "Pixel works while you’re here until they’re back.")
        }
        #expect(GoalSandbox.row(status("checking", "POST kuvo/sandbox/check"), computer: "devbox", onThisMac: false, bot: "Pixel", codingAgent: false, restartingSessions: true)?.title == "Checking the sandbox…",
                "back, the box checks its sandbox: it says that")
        // A box that doesn't answer: it says so, and Try Again only reads it again.
        let unreadable = try #require(row(.unreadable, false, false))
        #expect(unreadable.text == "Its sandbox can’t be read now. Until then, Pixel works while you’re here.")
        #expect(unreadable.buttons == [.init(label: "Try Again", action: .readAgain)] && !unreadable.checking)

        // A box from before the sandbox: the machine is updated from Machines; this Mac, as an app.
        #expect(row(.old, false, false)?.buttons == [.init(label: "Update devbox…", action: .updateMachine)])
        #expect(row(.old, true, false)?.buttons == [.init(label: "Check for Updates…", action: .checkForUpdates)])

        // A bot on a coding agent: its commands are in the sandbox as the engine's are, so the row
        // is the box's own. Only a coding agent's process started before the sandbox, still running
        // outside it (any agent's: the box can't say whose), holds it back: restarted in it, as the
        // box offers.
        #expect(row(.status(.init(on: true, agents: true)), true, true) == nil, "all in it: nothing to fix")
        // A machine whose commands can still reach your login's services: on, but no goal alone.
        let services = try #require(row(.status(.init(on: true, agents: true, needs: "user namespaces", gaps: ["services"])), false, false))
        #expect(services.title == "devbox can’t work on its own")
        #expect(services.text.contains("your login’s services") && services.text.contains("Pixel works while you’re here"))
        #expect(services.buttons == [.init(label: "How to Check…", action: .open(GoalSandbox.machinesPage))])
        #expect(row(.status(.init(on: true, agents: true, gaps: ["somethingNew"])), false, false) == nil, "a gap a newer box adds, unknown here, isn't taken for this one")
        #expect(row(status("engineDown", "POST kuvo/engine/restart"), true, true)?.buttons == [.init(label: "Restart Sessions", action: .restartSessions(method: "POST", path: "kuvo/engine/restart"))])
        let outside = try #require(row(.status(.init(on: true, agents: false, outside: true)), true, true))
        #expect(outside.title == "Agents started before the sandbox")
        #expect(outside.text == "Some coding agents on this Mac still run outside it, so Pixel works while you’re here. Restart them in the sandbox, and Pixel works on its own.")
        #expect(outside.buttons == [.init(label: "Restart Agents", action: .restartAgents)])
        let restarting = try #require(GoalSandbox.row(.status(.init(on: true, agents: false, outside: true)), computer: "This Mac", onThisMac: true, bot: "Pixel", codingAgent: true, restarting: true))
        #expect(restarting.checking && restarting.buttons.isEmpty, "restarting: it says so until the box has it in the sandbox")
        #expect(row(.status(.init(on: true, agents: false)), true, true)?.checking == true, "the agents bridge hasn't said yet: still checking")
        #expect(row(.status(.init(on: true, agents: false, restart: true)), true, true)?.buttons == [.init(label: "Restart Agents", action: .restartAgents)],
                "a box from before `outside` says it only by asking to restart them")
        #expect(row(.status(.init(on: true, agents: false, outside: true)), true, false) == nil, "a bot on the built-in models isn't held back by them")
        // Plain words: nothing about a sandbox that doesn't cover agents yet, nor the engine.
        let every = [outside, restarting, notOn, kernel, services] + ["engineMissing", "plugin", "engineDown", "waiting"].compactMap { row(status($0, "POST kuvo/sandbox/check"), false, false) }
        for each in every {
            let words = "\(each.title) \(each.text) \(each.buttons.map(\.label))"
            #expect(!words.contains("doesn’t cover") && !words.localizedCaseInsensitiveContains("engine"), "\(words)")
        }
    }

    @Test func startSendsTheCardsDeadlineAndChangedLimitsAndHoldsNothingPublicBack() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let plan = GoalPlan(id: "goal_1", bot: "bot_pixel", name: "Pixel", session: "ses_pixel", goal: "Launch Driftwood.", state: .proposed, steps: [],
                            spend: [.init(what: "ads", cap: 20, currency: "USD", per: .day)],
                            proposed: now.timeIntervalSince1970 * 1000, alone: true)
        let answer = GoalCard.start(plan, wake: true, digest: .week, deadline: .days(1), caps: [30], periods: [.week], now: now, calendar: calendar)
        #expect(answer.action == .start)
        let sent = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as? [String: Any])
        #expect(!sent.keys.contains("public"), "no switch for anything public: the conversation's mode decides")
        #expect(!sent.keys.contains("mode"), "with no Autopilot row showing, it leaves how the conversation runs alone")
        #expect(GoalCard.start(plan, wake: false, digest: .none, deadline: .none, caps: [], periods: [], autopilot: true).mode == .autopilot)
        #expect(GoalCard.start(plan, wake: false, digest: .none, deadline: .none, caps: [], periods: [], autopilot: false).mode == .interactive)
        #expect(answer.spend == [.init(cap: 30, per: .week)])
        #expect(answer.wake == true && answer.digest == .week)
        let tomorrow = calendar.date(bySettingHour: 23, minute: 59, second: 0, of: calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))!)!
        #expect(answer.ends == tomorrow.timeIntervalSince1970 * 1000, "Tomorrow ends as tomorrow does")
        #expect(GoalCard.start(plan, wake: false, digest: .none, deadline: .none, caps: [], periods: [], now: now, calendar: calendar).ends == nil)
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
            try await app.goalPlans.answer(plan, on: box, .start(wake: false))
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
        let row = try #require(GoalSandbox.row(reading, computer: "lab", onThisMac: false, bot: "Pixel", codingAgent: false))
        #expect(row.title.hasPrefix("lab can’t work on its own"))
    }

    @Test func noneAfterTheBotsDeadlineStartsTheGoalWithNoEnd() async throws {
        let machine = try await lab(ends: Date.now.addingTimeInterval(7 * 86_400).timeIntervalSince1970 * 1000)
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        #expect(plan.ends != nil, "the bot proposed an end")
        let answer = GoalCard.start(plan, wake: false, digest: .none, deadline: .none, caps: [], periods: [])
        let started = try #require(try await app.goalPlans.answer(plan, on: box, answer))
        #expect(started.state == .running)
        #expect(started.ends == nil, "None takes the bot's end away")
        #expect(try kept(machine)["ends"] == nil)
    }

    /// A step, or what waits for you, done in an app on its computer shows that app's own icon,
    /// from the box that found it there; what waits in an app opens it only at that computer: on a
    /// machine, there's nothing to open from here.
    @Test func whatWaitsInAnAppShowsItsIconFromItsBoxAndOpensOnlyAtThatComputer() async throws {
        let machine = try await lab("running", waiting: [["id": "w1", "kind": "you", "text": "Sign in to Finder", "app": ["name": "Finder", "id": "com.apple.finder"], "at": Date.now.timeIntervalSince1970 * 1000]])
        defer { machine.stop() }
        // The icon as the box kept it once it found the app.
        let apps = machine.folder.appending(path: "apps")
        try FileManager.default.createDirectory(at: apps, withIntermediateDirectories: true)
        let drawn = NSImage(size: NSSize(width: 64, height: 64), flipped: false) { rect in
            NSColor.systemBlue.setFill()
            rect.fill()
            return true
        }
        let png = try #require(drawn.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))?.representation(using: .png, properties: [:]))
        try png.write(to: apps.appending(path: "com.apple.finder.png"))
        ServiceIcons.shared.boxes = { [app] box in app.goalPlans.client(box) }
        await app.goalPlans.read("lab")
        let (_, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        let item = try #require(plan.waiting.first)
        let mark = try #require(GoalPlanWords.mark(of: item))
        #expect(mark == .app(id: "com.apple.finder", name: "Finder"))
        _ = ServiceIcons.shared.icon(mark, on: "lab")
        try await until { ServiceIcons.shared.icon(mark, on: "lab") != nil }
        #expect(ServiceIcons.shared.icon(mark, on: "lab")?.isValid == true, "the box's own icon")
        #expect(GoalPlanBar.app(of: item, on: "lab") == nil, "an app on a machine has no Open here")
        #expect(GoalPlanBar.app(of: item, on: BoxClient.mac)?.name == "Finder", "on this Mac's own box, Open Finder")
    }

    /// A proposed goal's projects renamed or moved on its card go to its box, which says again
    /// where Start makes each: a folder with files there already says so, and never holds Start
    /// back.
    @Test func aProjectRenamedOrMovedOnTheCardIsWhereStartMakesIt() async throws {
        let machine = try await lab(projects: ["Sweep"])
        defer { machine.stop() }
        await app.goalPlans.read("lab")
        let (box, plan) = try #require(app.goalPlans.plan(for: "ses_pixel"))
        #expect(plan.folders.map(\.project) == ["Sweep"])

        let renamed = try #require(GoalPlanWords.renamed(plan.projects[0], to: "Tidy"))
        let afterRename = try #require(try await app.goalPlans.answer(plan, on: box, .projects([renamed])))
        #expect(afterRename.projects == ["Tidy"])

        let code = machine.folder.appending(path: "Code")
        try FileManager.default.createDirectory(at: code.appending(path: "Tidy"), withIntermediateDirectories: true)
        try Data("hello".utf8).write(to: code.appending(path: "Tidy/README.md"))
        let moved = try #require(GoalPlanWords.moved(afterRename.projects[0], into: code.path))
        let afterMove = try #require(try await app.goalPlans.answer(afterRename, on: box, .projects([moved])))
        #expect(afterMove.folders.first?.folder == code.appending(path: "Tidy").path)
        #expect(afterMove.folders.first?.there == true, "something with files is there already")
        #expect(try kept(machine)["projects"] as? [String] == [moved], "kept on its box, which makes it")

        let started = try #require(try await app.goalPlans.answer(afterMove, on: box, .start(wake: false)))
        #expect(started.state == .running, "a folder there already doesn't hold Start back")
    }
}
