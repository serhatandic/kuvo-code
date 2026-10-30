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

        /// Archived elsewhere (from a phone), as the engine then lists it.
        func archive(_ id: String) {
            lock.withLock { if let index = listed.firstIndex(where: { $0["id"] as? String == id }) { listed[index]["metadata"] = ["kuvo.archived": true] } }
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

    private func expectOnlySesATerminalsGone() {
        let tabs = app.utilities.tabs
        #expect(tabs.filter { $0.owner == "ses_a" }.map(\.kind) == [.changes], "its terminals stopped, its other tabs kept")
        #expect(tabs.filter { $0.owner == "ses_b" && $0.kind == .terminal }.count == 1, "another session's goes on")
    }

    @Test func archivingASessionStopsItsTerminalsAndKeepsItsOtherTabs() async throws {
        defer { done() }
        openPanels()
        #expect(await app.workspace.setArchived("ses_a", true))
        expectOnlySesATerminalsGone()
    }

    @Test func aSessionArchivedFromAPhoneStopsItsTerminalsHere() async throws {
        defer { done() }
        openPanels()
        sessions.archive("ses_a")
        await app.workspace.refresh()
        #expect(app.workspace.session("ses_a").map(Workspace.isArchived) == true)
        expectOnlySesATerminalsGone()
    }
}
