import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A session's terminals in the side panel stop when it's archived, here or from a phone: out of
/// sight in the archive, nothing of it goes on running. Its other tabs stay for when it comes
/// back. (A machine removed stops those on it: MachineConnectionTests.)
/// The engine is stubbed.
@MainActor
@Suite(.serialized) struct PanelTerminalsTests {
    static let engine = "http://127.0.0.1:47993"
    let app = AppModel()
    let folder = FileManager.default.temporaryDirectory.appending(path: "KuvoCodeTests-terminals-\(UUID().uuidString)")
    private let sessions: EngineSessions

    private nonisolated final class EngineSessions: @unchecked Sendable {
        private let lock = NSLock()
        private var listed: [[String: Any]]

        init(_ listed: [[String: Any]]) { self.listed = listed }

        func list() -> StubWeb.Answer { lock.withLock { StubWeb.json(["data": listed]) } }

        /// Archived elsewhere (from a phone), as the engine then lists it; `carriedTo`, by a box
        /// that moved it to the coding agents.
        func archive(_ id: String, carriedTo: String? = nil) {
            var metadata: [String: Any] = ["kuvo.archived": true]
            if let carriedTo { metadata["kuvo.carriedTo"] = carriedTo }
            lock.withLock { if let index = listed.firstIndex(where: { $0["id"] as? String == id }) { listed[index]["metadata"] = metadata } }
        }

        func change(_ request: URLRequest, _ body: Data) -> StubWeb.Answer {
            guard request.httpMethod == "PATCH", let id = request.url?.lastPathComponent else { return StubWeb.Answer(status: 404) }
            return lock.withLock {
                guard let index = listed.firstIndex(where: { $0["id"] as? String == id }) else { return StubWeb.Answer(status: 404) }
                if let metadata = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["metadata"] { listed[index]["metadata"] = metadata }
                return StubWeb.json(["data": [:]])
            }
        }
    }

    private static func session(_ id: String, in directory: String) -> [String: Any] {
        ["id": id, "projectID": "p", "cost": 0, "title": id,
         "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
         "time": ["created": 1, "updated": 10], "location": ["directory": directory], "metadata": [:]]
    }

    init() async throws {
        TestEnvironment.prepare()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        StubWeb.start(hosts: ["127.0.0.1"])
        sessions = EngineSessions([Self.session("ses_a", in: folder.path), Self.session("ses_b", in: folder.path)])
        let sessions = sessions
        StubWeb.route(Self.engine + "/api/session") { _ in sessions.list() }
        StubWeb.route(Self.engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        StubWeb.handle(Self.engine + "/api/session/") { request, body in sessions.change(request, body) }
        // As the app has it (`startMachines`).
        app.followSessions()
        app.workspace.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        await app.workspace.refresh()
    }

    private func done() {
        app.utilities.closeAll()
        StubWeb.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    /// `ses_a` with two terminals (one Run's) and Changes, and `ses_b` with a terminal.
    private func openPanels() {
        let panel = app.utilities
        panel.inView = .init(session: "ses_a")
        panel.newTerminal(in: folder.path, environment: shell)
        panel.run("true", in: folder.path, environment: shell)
        panel.showChanges()
        panel.inView = .init(session: "ses_b")
        panel.newTerminal(in: folder.path, environment: shell)
    }

    private let shell = ["SHELL": "/bin/sh"]

    /// `ses_a`'s terminals, Run's among them.
    private var sesATerminals: [TerminalSession] {
        app.utilities.tabs.filter { $0.owner == "ses_a" }.compactMap { app.utilities.terminals[$0.id] }
    }

    private func expectOnlySesATerminalsGone(_ stopped: [TerminalSession]) {
        let tabs = app.utilities.tabs
        #expect(tabs.filter { $0.owner == "ses_a" }.map(\.kind) == [.changes], "its terminals' tabs closed, its other tabs kept")
        #expect(stopped.count == 2 && stopped.allSatisfy { !$0.isRunning }, "its shells ended, Run's dev server with it")
        #expect(tabs.filter { $0.owner == "ses_b" && $0.kind == .terminal }.count == 1, "another session's goes on")
    }

    @Test func archivingASessionStopsItsTerminalsAndKeepsItsOtherTabs() async throws {
        defer { done() }
        openPanels()
        let terminals = sesATerminals
        #expect(await app.workspace.setArchived("ses_a", true))
        expectOnlySesATerminalsGone(terminals)
    }

    /// Brought back from the archive: nothing of its panel is closed then.
    @Test func bringingASessionBackClosesNothing() async throws {
        defer { done() }
        #expect(await app.workspace.setArchived("ses_a", true))
        openPanels()
        #expect(await app.workspace.setArchived("ses_a", false))
        #expect(sesATerminals.count == 2 && sesATerminals.allSatisfy { $0.isRunning })
    }

    /// Moved to the coding agents by its box (from a phone, say): archived, it carries on in the
    /// new session, and so do its terminals, Run's dev server still running.
    @Test func aConversationCarriedOnElsewhereKeepsItsTerminals() async throws {
        defer { done() }
        openPanels()
        let terminals = sesATerminals
        sessions.archive("ses_a", carriedTo: "ses_c")
        await app.workspace.refresh()
        #expect(app.utilities.tabs.filter { $0.owner == "ses_c" && $0.kind == .terminal }.count == 2)
        #expect(terminals.allSatisfy { $0.isRunning })
    }

    /// One carried on before, brought back from the archive and archived again: its terminals end
    /// as any archived session's do, rather than moving into the conversation it carried on in.
    @Test func aCarriedOnConversationBroughtBackAndArchivedAgainStopsItsTerminals() async throws {
        defer { done() }
        sessions.archive("ses_a", carriedTo: "ses_c")
        await app.workspace.refresh()
        #expect(await app.workspace.setArchived("ses_a", false))
        openPanels()
        let terminals = sesATerminals
        #expect(await app.workspace.setArchived("ses_a", true))
        expectOnlySesATerminalsGone(terminals)
        #expect(!app.utilities.tabs.contains { $0.owner == "ses_c" }, "nothing moved into the other conversation")
    }

    @Test func aSessionArchivedFromAPhoneStopsItsTerminalsHere() async throws {
        defer { done() }
        openPanels()
        let terminals = sesATerminals
        sessions.archive("ses_a")
        await app.workspace.refresh()
        #expect(app.workspace.session("ses_a").map(Workspace.isArchived) == true)
        expectOnlySesATerminalsGone(terminals)
    }
}
