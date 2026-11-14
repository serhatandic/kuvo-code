import Foundation
import KuvoLink
import OpenCodeKit
import os
import Testing
@testable import KuvoCode

/// A session's wake-ups follow the conversation: they move with it when it carries on with the
/// coding agents, and one made while it's archived waits, as those it had when archived do. This
/// Mac's box keeps and sends them, as the app runs it. The engine and the agents' bridge are
/// stubbed; the box, the wake-ups' folders and kuvo-wake are real.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct WakeUpsTests {
    static let engine = "http://127.0.0.1:47996"
    static let bridge = "http://127.0.0.1:47995"
    let app = AppModel()
    let id = "ses_wakeful"

    private static func session(_ id: String, archived: Bool = false, agent: Bool = false) -> [String: Any] {
        var metadata: [String: Any] = [:]
        if archived { metadata["kuvo.archived"] = true }
        if agent { metadata["kuvoAgent"] = "claude-code" }
        return [
            "id": id, "projectID": "p", "cost": 0, "title": "Nightly checks",
            "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
            "time": ["created": 1, "updated": 2], "location": ["directory": "/tmp/kuvo-tests-project"],
            "model": ["id": "luna", "providerID": "openai"], "agent": "build", "metadata": metadata,
        ]
    }

    /// The app, its stand-in engine and this Mac's box (`boxing` false: the test starts it, with
    /// `startBox`).
    @discardableResult
    private func start(archived: Bool = false, boxing: Bool = true) async throws -> TestBox? {
        TestEnvironment.prepare()
        try? FileManager.default.removeItem(at: WakeUps.root)
        StubWeb.start(hosts: ["127.0.0.1"])
        let listed = StubWeb.json(["data": [Self.session(id, archived: archived)]])
        StubWeb.route(Self.engine + "/api/session") { _ in listed }
        StubWeb.route(Self.engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        let one = StubWeb.json(["data": Self.session(id, archived: archived)])
        StubWeb.route(Self.engine + "/api/session/\(id)") { _ in one }
        StubWeb.route(Self.engine + "/api/session/\(id)/message") { _ in StubWeb.json(["data": []]) }
        StubWeb.route(Self.engine + "/api/session/\(id)/inbox") { _ in StubWeb.json(["data": []]) }
        app.wakeUps.app = app
        app.workspace.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        await app.workspace.refresh()
        return boxing ? try await startBox() : nil
    }

    private func startBox() async throws -> TestBox {
        try await TestBox(engine: Self.engine)
    }

    private func done(_ box: TestBox?) {
        box?.stop()
        StubWeb.stop()
        app.workspace.agents?.disconnect()
        try? FileManager.default.removeItem(at: WakeUps.root)
    }

    /// Its agent's wake-up tool, as this Mac's tool server passes the call on to the box
    /// (`kuvo/agent-tools`), then the app reading its wake-ups again, as it would on hearing of them
    /// (`kuvo/wakes/events`).
    private func tool(_ box: TestBox?, _ name: String, _ arguments: [String: Any]) async -> (text: String, isError: Bool) {
        guard let box else { return ("This Mac's box isn't running.", true) }
        let mail = AgentMail()
        mail.box = { box.client(engine: Self.engine) }
        let said = await mail.call(name, arguments: arguments, caller: id)
        if let session = app.workspace.session(id) { await app.wakeUps.read(WakeUps.owner(of: session)) }
        return said
    }

    private func folder(_ session: String, _ parts: String...) -> String {
        parts.reduce(WakeUps.root.appending(path: session)) { $0.appending(path: $1) }.path
    }

    /// A session with a wake-up for tomorrow moves to Claude Code: the wake-up is the new
    /// session's, waiting, not left behind with the old one in Archived.
    @Test func wakeUpsMoveWithTheConversation() async throws {
        let box = try #require(try await start())
        defer { done(box) }
        let moved = "ses_onagents"
        let imported = StubWeb.json(["data": Self.session(moved, agent: true)])
        StubWeb.route(Self.bridge + "/api/session/import") { _ in imported }
        // (The box carries it, to the bridge it's told of.)
        try await box.agents(at: Self.bridge)
        app.workspace.boxes = { _ in box.client(engine: Self.engine) }
        let agents = OutsideAgents()
        agents.connect(ServerEndpoint(url: URL(string: Self.bridge)!, password: "test"), folderPrefix: "")
        app.workspace.agents = agents

        let owner = WakeUps.owner(of: try #require(app.workspace.session(id)))
        try await app.wakeUps.add(to: owner, at: .now.addingTimeInterval(86_400), every: nil, note: "Check the nightly build")
        let wake = try #require(FileManager.default.contentsOfDirectory(atPath: folder(id, "wakes")).first)

        try await app.workspace.moveToAgents(id, model: ModelRef(id: "sonnet", providerID: "claude-code"))

        #expect(FileManager.default.fileExists(atPath: folder(moved, "wakes", wake)))
        #expect(try String(contentsOfFile: folder(moved, "session"), encoding: .utf8) == moved)
        #expect(try String(contentsOfFile: folder(moved, "via"), encoding: .utf8) == "bridge")
        #expect(!FileManager.default.fileExists(atPath: folder(moved, "paused")))
        #expect(!FileManager.default.fileExists(atPath: folder(id)))
    }

    /// An archived session's agent schedules a wake-up (it was still working): it waits with the
    /// session, and comes when you bring the session back.
    @Test func aWakeUpMadeWhileArchivedWaits() async throws {
        let box = try await start(archived: true)
        defer { done(box) }
        let made = await tool(box, "schedule_wake_up", ["when": "+2h", "note": "Look again"])
        #expect(!made.isError, "\(made.text)")
        #expect(FileManager.default.fileExists(atPath: folder(id, "paused")))
        #expect(app.wakeUps.paused.contains(id))
        #expect(app.wakeUps.wakes[id]?.count == 1)

        await app.wakeUps.archived(try #require(app.workspace.session(id)), false)
        #expect(!FileManager.default.fileExists(atPath: folder(id, "paused")))
        #expect(!app.wakeUps.paused.contains(id))
    }

    /// The agent gives its wake-up and its watch a summary, the one line its card shows: kept beside
    /// the note, which stays whole for the agent.
    @Test func theAgentsSummaryIsKeptForTheCard() async throws {
        let box = try await start()
        defer { done(box) }
        let note = "Look at the last CI run. If it failed, read the log and tell the user what broke."
        let made = await tool(box, "schedule_wake_up", ["when": "+2h", "note": note, "summary": "Check CI"])
        #expect(!made.isError, "\(made.text)")
        let wake = try #require(FileManager.default.contentsOfDirectory(atPath: folder(id, "wakes")).first)
        let letters = try #require(Wakes.Pending(id: wake, note: "")).letters
        #expect(try String(contentsOfFile: folder(id, "wakes", wake), encoding: .utf8) == note)
        #expect(try String(contentsOfFile: folder(id, "summaries", letters), encoding: .utf8) == "Check CI")

        let watched = await tool(box, "watch_for_change", ["every": "10m", "check": "cat state.txt", "note": "Tell the user what changed", "summary": "State changed"])
        #expect(!watched.isError, "\(watched.text)")
        let watch = try #require(FileManager.default.contentsOfDirectory(atPath: folder(id, "watches")).first)
        #expect(try String(contentsOfFile: folder(id, "watches", watch, "summary"), encoding: .utf8) == "State changed")
    }

    /// A phone lists every session that waits at once, for the marks beside them in its list: the
    /// soonest wake-up, and whether it watches.
    @Test func aPhoneSeesWhichSessionsWait() async throws {
        let box = try await start()
        defer { done(box) }
        let made = await tool(box, "schedule_wake_up", ["when": "+2h", "note": "Look again"])
        #expect(!made.isError, "\(made.text)")
        let link = PhoneLink()
        var listed = Data()
        for try await part in PhoneLink.respond(to: LinkRequest(path: "kuvo/wakes"), link: link, engine: URL(string: Self.engine + "/")!, password: nil, agents: nil) {
            if case .body(let data) = part { listed += data }
        }
        let sessions = try #require((try JSONSerialization.jsonObject(with: listed) as? [String: Any])?["sessions"] as? [[String: Any]])
        #expect(sessions.map { $0["session"] as? String } == [id])
        let next = try #require(sessions.first?["next"] as? Double)
        #expect(abs(next - Date.now.addingTimeInterval(7200).timeIntervalSince1970) < 120)
        #expect(sessions.first?["watching"] as? Bool == false)
    }

    /// From a phone, as the bar over the composer does: a session's wake-ups read, one sent now (a
    /// repeating one keeps its time), one canceled; one that isn't there says so.
    @Test func aPhoneSendsOneNowAndCancelsOne() async throws {
        let box = try await start()
        defer { done(box) }
        let prompts = recordPrompts()
        let link = PhoneLink()
        // The app, as it is once it's running.
        let before = AgentMail.shared.app
        AgentMail.shared.app = app
        defer { AgentMail.shared.app = before }
        func ask(_ path: String, _ body: [String: String]? = nil) async throws -> (status: Int, json: [String: Any]?) {
            let request = LinkRequest(method: body == nil ? "GET" : "POST", path: path, headers: ["content-type": "application/json"],
                                      body: try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data())
            var status = 0
            var data = Data()
            for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: Self.engine + "/")!, password: nil, agents: nil) {
                switch part {
                case .head(let code, _): status = code
                case .body(let chunk): data += chunk
                }
            }
            return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        #expect(!(await tool(box, "schedule_wake_up", ["when": "+2h", "note": "Look at the build", "every": "1d"])).isError)
        #expect(!(await tool(box, "schedule_wake_up", ["when": "+3h", "note": "Ask about the release"])).isError)
        let wakes = try #require(try await ask("kuvo/wakes/\(id)").json?["wakes"] as? [[String: Any]])
        #expect(wakes.compactMap { $0["note"] as? String } == ["Look at the build", "Ask about the release"])
        let daily = try #require(wakes.first?["id"] as? String), once = try #require(wakes.last?["id"] as? String)

        #expect(try await ask("kuvo/wakes/\(id)/now", ["wake": daily]).status == 200)
        try await until { prompts.all.contains { $0.contains("Look at the build") } }
        #expect(prompts.all.filter { $0.hasPrefix(Wakes.marker) }.count == 1)
        #expect(try await ask("kuvo/wakes/\(id)/cancel", ["wake": once]).status == 200)
        let left = try #require(try await ask("kuvo/wakes/\(id)").json?["wakes"] as? [[String: Any]])
        #expect(left.compactMap { $0["note"] as? String } == ["Look at the build"], "the daily one keeps coming")
        #expect(try await ask("kuvo/wakes/\(id)/cancel", ["wake": once]).status == 404)
    }

    /// From a phone: a wake-up added to a session, as the bar over the composer adds one, which
    /// repeats; its wake-ups paused and let go; what can't be is said, and nothing's added.
    @Test func aPhoneAddsOneAndPausesThem() async throws {
        let box = try await start()
        defer { done(box) }
        let link = PhoneLink()
        let before = AgentMail.shared.app
        AgentMail.shared.app = app
        defer { AgentMail.shared.app = before }
        func ask(_ path: String, _ body: [String: Any]) async throws -> (status: Int, json: [String: Any]?) {
            let request = LinkRequest(method: "POST", path: path, headers: ["content-type": "application/json"], body: try JSONSerialization.data(withJSONObject: body))
            var status = 0
            var data = Data()
            for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: Self.engine + "/")!, password: nil, agents: nil) {
                switch part {
                case .head(let code, _): status = code
                case .body(let chunk): data += chunk
                }
            }
            return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let due = Date.now.addingTimeInterval(3600).timeIntervalSince1970
        let added = try await ask("kuvo/wakes/\(id)", ["due": due, "every": "1d", "note": "Look at the build"])
        #expect(added.status == 200)
        let wakes = try #require(added.json?["wakes"] as? [[String: Any]])
        #expect(wakes.compactMap { $0["note"] as? String } == ["Look at the build"])
        #expect(wakes.first?["every"] as? String == "1d")
        #expect(abs((wakes.first?["due"] as? Double ?? 0) - due) < 120)

        #expect(try await ask("kuvo/wakes/\(id)/pause", ["paused": true]).json?["paused"] as? Bool == true)
        #expect(FileManager.default.fileExists(atPath: folder(id, "paused")))
        #expect(try await ask("kuvo/wakes/\(id)/pause", ["paused": false]).json?["paused"] as? Bool == false)

        #expect(try await ask("kuvo/wakes/\(id)", ["due": Date.now.addingTimeInterval(10).timeIntervalSince1970, "note": "Too soon"]).status == 400)
        #expect(try await ask("kuvo/wakes/\(id)", ["due": due, "every": "08h", "note": "A bad repeat"]).status == 400)
        #expect(try await ask("kuvo/wakes/\(id)", ["due": due, "note": "  "]).status == 400)
        #expect(try await ask("kuvo/wakes/ses_nobody", ["due": due, "note": "Hi"]).status == 404)
        // The app shows the one the phone added, as its box says.
        let following = Task { await app.wakeUps.follow() }
        defer { following.cancel() }
        let key = WakeUps.owner(of: try #require(app.workspace.session(id))).key
        try await until { app.wakeUps.wakes[key]?.count == 1 }
    }

    /// The prompts the engine was sent for the session, each a wake-up's.
    nonisolated final class Prompts: @unchecked Sendable {
        private let lock = NSLock()
        private var texts: [String] = []
        func add(_ text: String) {
            lock.withLock { texts.append(text) }
            TestPulse.beat()
        }
        var all: [String] { lock.withLock { texts } }
    }

    private func recordPrompts(holding gate: Gate? = nil) -> Prompts {
        let prompts = Prompts()
        StubWeb.handle(Self.engine + "/api/session/\(id)/prompt") { _, body in
            prompts.add((try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["text"] as? String ?? "")
            gate?.wait()
            return StubWeb.json([:])
        }
        return prompts
    }

    /// Wake Up Now, clicked again while the first is on its way (the folder's tools can take a
    /// while): the agent gets it once (L26). A one-off is then done; a repeating one comes back at
    /// its time.
    @Test(arguments: [false, true])
    func wakeUpNowSendsOnce(repeating: Bool) async throws {
        let box = try await start()
        defer { done(box) }
        let gate = Gate()
        defer { gate.open() }
        let prompts = recordPrompts(holding: gate)
        let owner = WakeUps.owner(of: try #require(app.workspace.session(id)))
        try await app.wakeUps.add(to: owner, at: .now.addingTimeInterval(86_400), every: repeating ? .days(1) : nil, note: "Check the nightly build")
        let wake = try #require(app.wakeUps.wakes[owner.key]?.first)

        let first = Task { try await app.wakeUps.wakeNow(wake, of: owner) }
        try await until { prompts.all.count == 1 }
        var secondDone = false
        let second = Task {
            defer {
                secondDone = true
                TestPulse.beat()
            }
            try await app.wakeUps.wakeNow(wake, of: owner)
        }
        // The second click has done what it does: nothing, or sent it again.
        try await until { secondDone || prompts.all.count > 1 }
        gate.open()
        try await first.value
        try await second.value
        // And once more after it went: a one-off isn't there to send again, and says so.
        if !repeating { await #expect(throws: WakeUps.Failure.self) { try await app.wakeUps.wakeNow(wake, of: owner) } }

        #expect(prompts.all == [Wakes.marker + "Check the nightly build"], "sent \(prompts.all.count) times")
        let left = (try? FileManager.default.contentsOfDirectory(atPath: folder(id, "wakes"))) ?? []
        #expect(left.count == (repeating ? 1 : 0))
    }

    /// A session archived from a phone (its metadata changed on the engine, which tells the Mac):
    /// its wake-ups wait, as with Archive here, and come back when the phone brings it back.
    @Test func archivingFromAPhoneHoldsItsWakeUps() async throws {
        let box = try await start()
        defer { done(box) }
        // As the app has it (`startMachines`), each change's work handed to the test to wait for.
        var work: [Task<Void, Never>] = []
        app.workspace.onArchived = { [app] session, _, _ in work.append(app.archivedChanged(session)) }
        let owner = WakeUps.owner(of: try #require(app.workspace.session(id)))
        try await app.wakeUps.add(to: owner, at: .now.addingTimeInterval(86_400), every: nil, note: "Check the nightly build")
        // The engine says it changed; this Mac reads it again, and does what that calls for.
        func changed(archived: Bool) async throws {
            let one = StubWeb.json(["data": Self.session(id, archived: archived)])
            StubWeb.route(Self.engine + "/api/session/\(id)") { _ in one }
            app.workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: [
                "id": UUID().uuidString, "type": "session.metadata.updated", "created": 1, "data": ["sessionID": id],
            ])))
            await app.workspace.reloading[id]?.value
            #expect(work.count == 1, "told once it's read")
            for task in work { await task.value }
            work = []
        }
        try await changed(archived: true)
        #expect(app.wakeUps.paused.contains(id), "archived from the phone: its wake-ups wait")
        #expect((try? String(contentsOfFile: folder(id, "paused"), encoding: .utf8)) == "archived")
        try await changed(archived: false)
        #expect(!app.wakeUps.paused.contains(id), "brought back: they come back")
    }

    /// Archived from a phone while this Mac didn't hear it (its feed was down): once the list is
    /// read again, its wake-ups wait all the same.
    @Test func archivedUnheardHoldsItsWakeUpsOnceTheListIsRead() async throws {
        let box = try await start()
        defer { done(box) }
        var work: [Task<Void, Never>] = []
        app.workspace.onArchived = { [app] session, _, _ in work.append(app.archivedChanged(session)) }
        let owner = WakeUps.owner(of: try #require(app.workspace.session(id)))
        try await app.wakeUps.add(to: owner, at: .now.addingTimeInterval(86_400), every: nil, note: "Check the nightly build")
        let listed = StubWeb.json(["data": [Self.session(id, archived: true)]])
        StubWeb.route(Self.engine + "/api/session") { _ in listed }
        await app.workspace.refresh()
        #expect(work.count == 1, "told once, as the list is read")
        for task in work { await task.value }
        #expect(app.wakeUps.paused.contains(id))
    }

    /// Archived while it waits on you (a permission): its box stops its run, as a bot's Stop and
    /// Archive has it, rather than leave it waiting out of sight; and the ask goes with the run, off
    /// the Dock. One brought back stops nothing.
    @Test func archivingOneThatWaitsOnYouStopsItsRun() async throws {
        let box = try await start()
        defer { done(box) }
        var work: [Task<Void, Never>] = []
        app.workspace.onArchived = { [app] session, _, _ in work.append(app.archivedChanged(session)) }
        let permission: [String: Any] = ["id": "per_push", "sessionID": id, "action": "shell", "resources": ["git push"]]
        let asked = StubWeb.json(["data": [permission]])
        StubWeb.route(Self.engine + "/api/session/\(id)/permission") { _ in asked }
        StubWeb.route(Self.engine + "/api/session/\(id)/form") { _ in StubWeb.json(["data": []]) }
        StubWeb.route(Self.engine + "/api/session/\(id)/interrupt") { _ in StubWeb.json(["data": true]) }
        func event(_ type: String, _ data: [String: Any]) throws -> ServerEvent {
            try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": type, "created": 1, "data": data]))
        }
        app.workspace.handle(try event("permission.asked", permission))
        #expect(app.workspace.waitingCount == 1)
        let stopped = { StubWeb.asked.filter { $0.hasSuffix("/api/session/\(self.id)/interrupt") }.count }
        // The stand-in keeps what Archive writes, as the engine does: the box stops a run only
        // while its engine has it archived.
        let archivedThere = OSAllocatedUnfairLock(initialState: false)
        let (open, archived) = (StubWeb.json(["data": Self.session(id)]), StubWeb.json(["data": Self.session(id, archived: true)]))
        StubWeb.route(Self.engine + "/api/session/\(id)", sent: { request, body in
            if request.httpMethod == "PATCH" {
                let metadata = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["metadata"] as? [String: Any]
                let flag = metadata?["kuvo.archived"] as? Bool ?? false
                archivedThere.withLock { $0 = flag }
            }
            return archivedThere.withLock { $0 } ? archived : open
        })

        await app.workspace.setArchived(id, true)
        for task in work { await task.value }
        #expect(stopped() == 1, "archived while it waits on you: its run stops")
        // The engine lets the run's ask go with it, without a word.
        app.workspace.handle(try event("session.execution.interrupted", ["sessionID": id]))
        #expect(app.workspace.waitingCount == 0, "off the Dock")

        // Opened from search and worked in, archived still: a first wake-up its agent makes holds,
        // and stops nothing (the stand-in still says it waits).
        let made = await tool(box, "schedule_wake_up", ["when": "+2h", "note": "Check again"])
        #expect(!made.isError, "\(made.text)")
        #expect(app.wakeUps.paused.contains(id))
        #expect(stopped() == 1, "a wake-up isn't an archive")

        work = []
        await app.workspace.setArchived(id, false)
        for task in work { await task.value }
        #expect(stopped() == 1, "brought back: nothing more stops")
    }

    /// Wake-ups you paused stay paused when the session is archived and brought back; ones paused
    /// only by archiving come back with it.
    @Test func aPauseYouSetOutlastsArchiving() async throws {
        let box = try await start()
        defer { done(box) }
        let session = try #require(app.workspace.session(id))
        let owner = WakeUps.owner(of: session)
        try await app.wakeUps.add(to: owner, at: .now.addingTimeInterval(86_400), every: nil, note: "Check the nightly build")
        try await app.wakeUps.setPaused(true, owner)

        await app.wakeUps.archived(session, true)
        await app.wakeUps.archived(session, false)
        #expect(app.wakeUps.paused.contains(id), "your pause should hold after the session comes back")
        #expect(FileManager.default.fileExists(atPath: folder(id, "paused")))

        try await app.wakeUps.setPaused(false, owner)
        await app.wakeUps.archived(session, true)
        #expect(app.wakeUps.paused.contains(id), "archived, its wake-ups wait")
        await app.wakeUps.archived(session, false)
        #expect(!app.wakeUps.paused.contains(id))
        #expect(!FileManager.default.fileExists(atPath: folder(id, "paused")))

        // Archived with an earlier Kuvo Code, whose hold said nothing: it comes back with it too.
        await app.wakeUps.archived(session, true)
        try Data().write(to: URL(filePath: folder(id, "paused")))
        await app.wakeUps.archived(session, false)
        #expect(!app.wakeUps.paused.contains(id), "archived before holds said whose they were: let go")
    }

    /// Archiving that the engine didn't take (it couldn't be reached): the session stays where it
    /// was, not archived, and nothing is told it was (which would hold its wake-ups). Taken, it is.
    @Test func anArchiveTheEngineDidntTakeHoldsNothing() async throws {
        let box = try await start()
        defer { done(box) }
        var told: [Bool] = []
        app.workspace.onArchived = { _, isArchived, _ in told.append(isArchived) }
        let answer = StubWeb.json(["data": Self.session(id)])
        StubWeb.route(Self.engine + "/api/session/\(id)") { _ in StubWeb.json(["message": "Session is busy"], status: 500) }

        await app.workspace.setArchived(id, true)
        #expect(!Workspace.isArchived(try #require(app.workspace.session(id))), "the engine didn't archive it")
        #expect(told.isEmpty, "a session that wasn't archived holds nothing")

        StubWeb.route(Self.engine + "/api/session/\(id)") { _ in answer }
        await app.workspace.setArchived(id, true)
        #expect(Workspace.isArchived(try #require(app.workspace.session(id))))
        #expect(told == [true])
    }

    /// Pinned while archiving it was on its way, and the engine then not taking the archive: it's
    /// back where it was, and still pinned.
    @Test func aPinMadeWhileAnArchiveWasRefusedStays() async throws {
        let box = try await start()
        defer { done(box) }
        // The archive's request (no pin in it yet) refused; the pin's taken.
        let answer = StubWeb.json(["data": Self.session(id)])
        StubWeb.route(Self.engine + "/api/session/\(id)", sent: { _, body in
            let metadata = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["metadata"] as? [String: Any]
            return metadata?["kuvo.pinned"] == nil ? StubWeb.json(["message": "Session is busy"], status: 500) : answer
        })
        let archiving = Task { await app.workspace.setArchived(id, true) }
        await Task.yield()
        #expect(Workspace.isArchived(try #require(app.workspace.session(id))), "shown archived at once")
        await app.workspace.setPinned(id, true)
        await archiving.value
        let session = try #require(app.workspace.session(id))
        #expect(!Workspace.isArchived(session), "the engine didn't archive it")
        #expect(Workspace.isPinned(session), "the pin made meanwhile stays")
    }

    /// Wake-ups that came due while Kuvo Code was closed (L19): each goes once as this Mac's box
    /// starts, a daily one once however many days it missed, then waits for its next time; a
    /// one-off is done. The app shows what's left as the box says.
    @Test func wakeUpsMissedWhileClosedGoOnceAsItOpens() async throws {
        var box: TestBox?
        defer { done(box) }
        try await start(boxing: false)
        let prompts = recordPrompts()
        let owner = WakeUps.owner(of: try #require(app.workspace.session(id)))
        let wakes = folder(id, "wakes")
        try FileManager.default.createDirectory(atPath: wakes, withIntermediateDirectories: true)
        try Data(id.utf8).write(to: URL(filePath: folder(id, "session")))
        try Data(owner.directory.utf8).write(to: URL(filePath: folder(id, "directory")))
        let daily = Wakes.name(due: .now.addingTimeInterval(-3 * 86_400), every: .days(1))
        let once = Wakes.name(due: .now.addingTimeInterval(-3600), every: nil)
        try Data("Check the nightly build".utf8).write(to: URL(filePath: wakes + "/" + daily))
        try Data("Stand up and stretch".utf8).write(to: URL(filePath: wakes + "/" + once))

        box = try await startBox()
        let following = Task { await app.wakeUps.follow() }
        defer { following.cancel() }
        try await until { prompts.all.count == 2 && app.wakeUps.wakes[owner.key]?.count == 1 }
        #expect(prompts.all.sorted() == [Wakes.marker + "Check the nightly build", Wakes.marker + "Stand up and stretch"])
        let left = try FileManager.default.contentsOfDirectory(atPath: wakes)
        #expect(left.count == 1, "the one-off is done: \(left)")
        let next = try #require(left.first.flatMap { Wakes.Pending(id: $0, note: "") })
        #expect(next.due > .now && next.due < .now.addingTimeInterval(86_400 + 60), "the daily one waits for its next time")
    }
}
