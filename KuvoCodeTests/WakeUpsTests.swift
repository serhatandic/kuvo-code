import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A session's wake-ups follow the conversation: they move with it when it carries on with the
/// coding agents, and one made while it's archived waits, as those it had when archived do. The
/// engine and the agents' bridge are stubbed; the wake-ups' folders and kuvo-wake are real.
@MainActor
@Suite(.serialized) struct WakeUpsTests {
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

    private func start(archived: Bool = false) async {
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
    }

    private func done() {
        StubWeb.stop()
        app.workspace.agents?.disconnect()
        try? FileManager.default.removeItem(at: WakeUps.root)
    }

    private func folder(_ session: String, _ parts: String...) -> String {
        parts.reduce(WakeUps.root.appending(path: session)) { $0.appending(path: $1) }.path
    }

    /// A session with a wake-up for tomorrow moves to Claude Code: the wake-up is the new
    /// session's, waiting, not left behind with the old one in Archived.
    @Test func wakeUpsMoveWithTheConversation() async throws {
        await start()
        defer { done() }
        let moved = "ses_onagents"
        let imported = StubWeb.json(["data": Self.session(moved, agent: true)])
        StubWeb.route(Self.bridge + "/api/session/import") { _ in imported }
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
        await start(archived: true)
        defer { done() }
        let made = await app.wakeUps.call("schedule_wake_up", arguments: ["when": "+2h", "note": "Look again"], caller: id)
        #expect(!made.isError, "\(made.text)")
        #expect(FileManager.default.fileExists(atPath: folder(id, "paused")))
        #expect(app.wakeUps.paused.contains(id))
        #expect(app.wakeUps.wakes[id]?.count == 1)

        await app.wakeUps.archived(try #require(app.workspace.session(id)), false)
        #expect(!FileManager.default.fileExists(atPath: folder(id, "paused")))
        #expect(!app.wakeUps.paused.contains(id))
    }

    /// A phone lists every session that waits at once, for the marks beside them in its list: the
    /// soonest wake-up, and whether it watches.
    @Test func aPhoneSeesWhichSessionsWait() async throws {
        await start()
        defer { done() }
        let made = await app.wakeUps.call("schedule_wake_up", arguments: ["when": "+2h", "note": "Look again"], caller: id)
        #expect(!made.isError, "\(made.text)")
        let link = PhoneLink()
        link.wakeUps = app.wakeUps
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
        await start()
        defer { done() }
        let prompts = recordPrompts()
        let link = PhoneLink()
        link.wakeUps = app.wakeUps
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
        #expect(!(await app.wakeUps.call("schedule_wake_up", arguments: ["when": "+2h", "note": "Look at the build", "every": "1d"], caller: id)).isError)
        #expect(!(await app.wakeUps.call("schedule_wake_up", arguments: ["when": "+3h", "note": "Ask about the release"], caller: id)).isError)
        let wakes = try #require(try await ask("kuvo/wakes/\(id)").json?["wakes"] as? [[String: Any]])
        #expect(wakes.compactMap { $0["note"] as? String } == ["Look at the build", "Ask about the release"])
        let daily = try #require(wakes.first?["id"] as? String), once = try #require(wakes.last?["id"] as? String)

        #expect(try await ask("kuvo/wakes/\(id)/now", ["wake": daily]).status == 200)
        try await eventually { prompts.all.contains { $0.contains("Look at the build") } }
        #expect(prompts.all.filter { $0.hasPrefix(Wakes.marker) }.count == 1)
        #expect(try await ask("kuvo/wakes/\(id)/cancel", ["wake": once]).status == 200)
        let left = try #require(try await ask("kuvo/wakes/\(id)").json?["wakes"] as? [[String: Any]])
        #expect(left.compactMap { $0["note"] as? String } == ["Look at the build"], "the daily one keeps coming")
        #expect(try await ask("kuvo/wakes/\(id)/cancel", ["wake": once]).status == 404)
    }

    /// From a phone: a wake-up added to a session, as the bar over the composer adds one, which
    /// repeats; its wake-ups paused and let go; what can't be is said, and nothing's added.
    @Test func aPhoneAddsOneAndPausesThem() async throws {
        await start()
        defer { done() }
        let link = PhoneLink()
        link.wakeUps = app.wakeUps
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
        #expect(app.wakeUps.wakes[WakeUps.owner(of: try #require(app.workspace.session(id))).key]?.count == 1)
    }

    /// The prompts the engine was sent for the session, each a wake-up's.
    nonisolated final class Prompts: @unchecked Sendable {
        private let lock = NSLock()
        private var texts: [String] = []
        func add(_ text: String) { lock.withLock { texts.append(text) } }
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
        await start()
        defer { done() }
        let gate = Gate()
        defer { gate.open() }
        let prompts = recordPrompts(holding: gate)
        let owner = WakeUps.owner(of: try #require(app.workspace.session(id)))
        try await app.wakeUps.add(to: owner, at: .now.addingTimeInterval(86_400), every: repeating ? .days(1) : nil, note: "Check the nightly build")
        let wake = try #require(app.wakeUps.wakes[owner.key]?.first)

        let first = Task { try await app.wakeUps.wakeNow(wake, of: owner) }
        try await eventually { prompts.all.count == 1 }
        var secondDone = false
        let second = Task {
            defer { secondDone = true }
            try await app.wakeUps.wakeNow(wake, of: owner)
        }
        // The second click has done what it does: nothing, or sent it again.
        try await eventually { secondDone || prompts.all.count > 1 }
        gate.open()
        try await first.value
        try await second.value
        // And once more after it went: a one-off isn't there to send again.
        if !repeating { try await app.wakeUps.wakeNow(wake, of: owner) }

        #expect(prompts.all == [Wakes.marker + "Check the nightly build"], "sent \(prompts.all.count) times")
        let left = (try? FileManager.default.contentsOfDirectory(atPath: folder(id, "wakes"))) ?? []
        #expect(left.count == (repeating ? 1 : 0))
    }

    /// A session archived from a phone (its metadata changed on the engine, which tells the Mac):
    /// its wake-ups wait, as with Archive here, and come back when the phone brings it back.
    @Test func archivingFromAPhoneHoldsItsWakeUps() async throws {
        await start()
        defer { done() }
        // As the app has it (`startMachines`), each change's work handed to the test to wait for.
        var work: [Task<Void, Never>] = []
        app.workspace.onArchived = { [app] session, _ in work.append(app.archivedChanged(session)) }
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
        await start()
        defer { done() }
        var work: [Task<Void, Never>] = []
        app.workspace.onArchived = { [app] session, _ in work.append(app.archivedChanged(session)) }
        let owner = WakeUps.owner(of: try #require(app.workspace.session(id)))
        try await app.wakeUps.add(to: owner, at: .now.addingTimeInterval(86_400), every: nil, note: "Check the nightly build")
        let listed = StubWeb.json(["data": [Self.session(id, archived: true)]])
        StubWeb.route(Self.engine + "/api/session") { _ in listed }
        await app.workspace.refresh()
        #expect(work.count == 1, "told once, as the list is read")
        for task in work { await task.value }
        #expect(app.wakeUps.paused.contains(id))
    }

    /// Wake-ups you paused stay paused when the session is archived and brought back; ones paused
    /// only by archiving come back with it.
    @Test func aPauseYouSetOutlastsArchiving() async throws {
        await start()
        defer { done() }
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
        await start()
        defer { done() }
        var told: [Bool] = []
        app.workspace.onArchived = { _, isArchived in told.append(isArchived) }
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
        await start()
        defer { done() }
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

    /// Wake-ups that came due while Kuvo Code was closed (L19): each goes once as it opens, a daily
    /// one once however many days it missed, then waits for its next time; a one-off is done.
    @Test func wakeUpsMissedWhileClosedGoOnceAsItOpens() async throws {
        await start()
        defer { done() }
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

        app.wakeUps.start()
        try await eventually { prompts.all.count >= 2 && ((try? FileManager.default.contentsOfDirectory(atPath: wakes))?.count ?? 0) == 1 }
        #expect(prompts.all.sorted() == [Wakes.marker + "Check the nightly build", Wakes.marker + "Stand up and stretch"])
        let left = try FileManager.default.contentsOfDirectory(atPath: wakes)
        #expect(left.count == 1, "the one-off is done: \(left)")
        let next = try #require(left.first.flatMap { Wakes.Pending(id: $0, note: "") })
        #expect(next.due > .now && next.due < .now.addingTimeInterval(86_400 + 60), "the daily one waits for its next time")
    }
}
