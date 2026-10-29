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
    private func lab(_ state: String = "proposed", alone: Bool = true) async throws -> MachineTestBox {
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
            "projects": [String](), "wake": false, "digest": "day", "proposed": now, "waiting": [Any](), "paused": [Any](), "waited": 0, "watching": [String](),
        ].merging(state == "running" ? ["started": now] : [:]) { _, given in given }
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
}
