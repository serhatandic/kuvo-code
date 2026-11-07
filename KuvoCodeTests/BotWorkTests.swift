import ClientDesign
import ClientSessions
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A bot running sessions, as this Mac shows it (PROTOCOL.md, "Work"): its conversation's At work
/// bar reads its work from its box (the sessions it runs and where each stands, the asks it
/// answered), and Edit Bot › Work keeps the limits you set on that box. The machine's box is the
/// real one (`kuvo-link.js serve`), reached over HTTP where a Mac reaches it over SSH; its engine is
/// a stand-in.
@MainActor
@Suite(.serialized) struct BotWorkTests {
    let engine = StubEngine(port: 47_987)
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
        try? FileManager.default.removeItem(at: Bots.file)
        app.bots.app = app
        app.botWork.app = app
    }

    private func done(_ machine: MachineTestBox) {
        machine.stop()
        StubWeb.stopListening(port: 47_987)
        engine.stop()
        try? FileManager.default.removeItem(at: Bots.file)
    }

    /// Pixel, a bot on the machine, and a session it started there, at work in Tidepool, with an
    /// ask it answered.
    private func lab() async throws -> MachineTestBox {
        let machine = try await MachineTestBox(name: "lab")
        let folder = machine.folder.appending(path: "bots/bot_pixel00001")
        try FileManager.default.createDirectory(at: folder.appending(path: "wakes"), withIntermediateDirectories: true)
        try Data(#"{"kuvo": 1, "id": "bot_pixel00001", "name": "Pixel", "job": "Builds apps", "look": {"color": "sky", "shape": "round", "face": "calm"}, "created": "2026-10-01T09:00:00Z", "updated": "2026-10-01T09:00:00Z"}"#.utf8)
            .write(to: folder.appending(path: "bot.json"))
        try Data("ses_pixel".utf8).write(to: folder.appending(path: "session"))
        try Data("# Pixel's memory\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
        try JSONEncoder().encode(app.bots.kit(for: "lab")).write(to: machine.folder.appending(path: "bots/kit.json"))
        let answer: [String: Any] = ["ask": "per_1", "call": "call_1", "what": "Wants to run a command: npm test", "decision": "allow", "reason": "The plan runs the tests.",
                                     "by": ["bot": "bot_pixel00001", "name": "Pixel"], "at": Date.now.timeIntervalSince1970 * 1000]
        let signIn = StubEngine.session("ses_signin", title: "Sign-in", directory: "/home/me/tidepool", created: Date.now.timeIntervalSince1970 * 1000, extra: [
            "model": ["id": "claude-sonnet-5-5", "providerID": "anthropic"],
            "metadata": ["kuvo": ["startedBy": "ses_pixel", "by": ["bot": "bot_pixel00001", "name": "Pixel"], "depth": 1, "answers": [answer]]],
        ])
        engine.list([StubEngine.session("ses_pixel", title: "Pixel", directory: folder.appending(path: "workspace").path), signIn], running: ["ses_signin"])
        engine.on("GET", "/api/session/ses_signin", json: ["data": signIn])
        engine.on("GET", "/api/session/ses_signin/permission", json: ["data": []])
        engine.on("GET", "/api/session/ses_signin/form", json: ["data": []])
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        try await StubWeb.listen(port: 47_987)
        try FileManager.default.createDirectory(at: machine.folder.appending(path: "run"), withIntermediateDirectories: true)
        try Data(#"{"port": 47987, "password": "test"}"#.utf8).write(to: machine.folder.appending(path: "run/engine.json"))
        app.bots.boxes = { box in box == "lab" ? machine.client : BoxClient(box: box, transport: LocalBox { _ in AsyncThrowingStream { $0.finish() } }) }
        app.bots.reachable = { $0 == "lab" }
        app.botWork.boxes = { box in box == "lab" ? machine.client : BoxClient(box: box, transport: LocalBox { _ in AsyncThrowingStream { $0.finish() } }) }
        await app.bots.refresh("lab")
        return machine
    }

    @Test func aBotsConversationShowsTheSessionsItRunsAndTheAsksItAnswered() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        await app.botWork.read(pixel)
        let report = try #require(app.botWork.reports[pixel.id])
        #expect(report.atWork.map(\.title) == ["Sign-in"])
        #expect(BotWorkBar.title(report) == "A session is at work")
        #expect(BotWorkBar.progress(report) == "answered 1 ask")
        let answer = try #require(report.answered.first)
        #expect(answer.verdict == "Allowed by Pixel" && answer.reason == "The plan runs the tests." && answer.session == "ses_signin")
    }

    /// A session read as it was made, before its task reached it, isn't at work yet. Once it is, its
    /// box says its bot's work changed, and the bar says so too, though nothing this Mac sees of
    /// the sessions changed (the user's goal said "research session running" over "2 sessions
    /// today, none at work").
    @Test func theBarSaysASessionIsAtWorkOnceItsBoxSaysItStarted() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        let signIn = StubEngine.session("ses_signin", title: "Sign-in", directory: "/home/me/tidepool", created: Date.now.timeIntervalSince1970 * 1000, extra: [
            "metadata": ["kuvo": ["startedBy": "ses_pixel", "by": ["bot": "bot_pixel00001", "name": "Pixel"], "depth": 1]],
        ])
        let own = StubEngine.session("ses_pixel", title: "Pixel", directory: machine.folder.appending(path: "bots/bot_pixel00001/workspace").path)
        engine.list([own, signIn], running: [])
        await app.botWork.read(pixel)
        #expect(BotWorkBar.title(app.botWork.reports[pixel.id]) == "1 session today, none at work")

        app.botWork.connected = { $0 == "lab" }
        let following = Task { await app.botWork.follow(pixel) }
        defer { following.cancel() }
        // Its task reaches it, and it works: the box notes its bot's work changed, as it does on the
        // engine's word that it started (the bridge's bots-work-wakes tests).
        engine.list([own, signIn], running: ["ses_signin"])
        let changes = machine.folder.appending(path: "run/work")
        try FileManager.default.createDirectory(at: changes, withIntermediateDirectories: true)
        try Data(#"{"bot_pixel00001": \#(Int(Date.now.timeIntervalSince1970 * 1000))}"#.utf8).write(to: changes.appending(path: "changes.json"))
        try await until { app.botWork.reports[pixel.id]?.atWork.count == 1 }
        #expect(BotWorkBar.title(app.botWork.reports[pixel.id]) == "A session is at work")
    }

    /// A session of the bot's whose turn ended while a command it started runs on (the sidebar once
    /// said 6 at work, the bar 3): at work in the bot's row, its face and the bar over its composer
    /// alike, each worked out from what its box says (`AtWork`), though the bar's report was read
    /// before the command was known and isn't read again.
    @Test func aSessionWaitingOnItsBackgroundCommandCountsInTheRowAndTheBarAlike() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        // Its turn over, nothing left running: done, as the report and this Mac both say.
        let signIn = StubEngine.session("ses_signin", title: "Sign-in", directory: "/home/me/tidepool", created: Date.now.timeIntervalSince1970 * 1000, extra: [
            "metadata": ["kuvo": ["startedBy": "ses_pixel", "by": ["bot": "bot_pixel00001", "name": "Pixel"], "depth": 1]],
        ])
        engine.list([StubEngine.session("ses_pixel", title: "Pixel", directory: machine.folder.appending(path: "bots/bot_pixel00001/workspace").path), signIn], running: [])
        app.workspace.api = engine.api
        await app.workspace.refresh()
        await app.botWork.read(pixel)
        #expect(app.botWork.report(of: pixel)?.atWork.isEmpty == true)
        #expect(AtWork.sessions(of: pixel.id, in: app.workspace.sessions, isAtWork: app.workspace.isAtWork).isEmpty)

        // The command it left running, as its box keeps it.
        let work = machine.folder.appending(path: "run/work")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let command: [String: Any] = ["id": "sh_1", "command": "npm test", "started": Date.now.timeIntervalSince1970 * 1000]
        try JSONSerialization.data(withJSONObject: ["bridge": ["sessions": ["ses_signin": ["commands": [command], "subagents": [Any](), "tasks": [Any]()]], "folders": [Any]()]])
            .write(to: work.appending(path: "background.json"))
        app.workspace.boxes = { _ in machine.client }
        let workspace = app.workspace
        let follow = Task { await workspace.followBackground("lab") }
        defer { follow.cancel() }
        try await until { app.workspace.isWorking("ses_signin") }

        let row = AtWork.sessions(of: pixel.id, in: app.workspace.sessions, isAtWork: app.workspace.isAtWork)
        #expect(row.map(\.id) == ["ses_signin"], "the sessions its row and face go by")
        #expect(app.bots.isOverseeingWork(pixel, in: app.workspace))
        #expect(app.bots.mood(of: pixel, in: app.workspace) == .working, "its face works, not asleep")
        let bar = try #require(app.botWork.report(of: pixel))
        #expect(bar.atWork.map(\.session) == row.map(\.id), "the bar counts the same session")
        #expect(BotWorkBar.title(bar) == "A session is at work")
        #expect(app.botWork.reports[pixel.id]?.atWork.isEmpty == true, "from the facts, not from reading the report again")
    }

    @Test func limitsSetInEditBotAreKeptOnItsBoxAndCanBeTakenAway() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        try await app.botWork.setLimits(WorkLimits(atOnce: 2, tokensPerDay: 1_000_000), for: pixel)
        #expect(app.botWork.reports[pixel.id]?.limits == WorkLimits(atOnce: 2, tokensPerDay: 1_000_000))
        // Edit Bot's menus start from the bot as its box lists it, so the next pick keeps these.
        #expect(app.bots.bot(pixel.id)?.limits == WorkLimits(atOnce: 2, tokensPerDay: 1_000_000))
        let kept = try JSONSerialization.jsonObject(with: Data(contentsOf: machine.folder.appending(path: "bots/bot_pixel00001/bot.json"))) as? [String: Any]
        #expect((kept?["work"] as? [String: Any])?["limits"] as? [String: Int] == ["atOnce": 2, "tokensPerDay": 1_000_000])
        #expect(kept?["name"] as? String == "Pixel", "the rest of its description kept")
        try await app.botWork.setLimits(nil, for: pixel)
        #expect(app.botWork.reports[pixel.id]?.limits == nil)
        #expect(app.bots.bot(pixel.id)?.limits == nil)
    }

    @Test func oneOfItsSessionsStopsFromTheBar() async throws {
        let machine = try await lab()
        defer { done(machine) }
        engine.on("GET", "/api/session/ses_signin/inbox", json: ["data": []])
        engine.on("POST", "/api/session/ses_signin/interrupt", json: [:])
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        try await app.botWork.stop("ses_signin", of: pixel)
        #expect(engine.requests("POST", "/api/session/ses_signin/interrupt").count == 1)
    }

    @Test func aBotOnABoxFromBeforeSaysItCantRunSessionsThere() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        // An older box: no such route, and it says nothing.
        app.botWork.boxes = { box in BoxClient(box: box, transport: LocalBox { _ in AsyncThrowingStream { $0.yield(.head(status: 404, headers: [:])); $0.yield(.body(Data("{}".utf8))); $0.finish() } }) }
        #expect(app.botWork.runsWork(pixel))
        await app.botWork.read(pixel)
        #expect(!app.botWork.runsWork(pixel))
        #expect(app.botWork.reports[pixel.id] == nil)
    }
}
