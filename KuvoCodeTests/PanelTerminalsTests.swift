import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A session's terminals in the side panel stop when it's archived, here or from a phone: out of
/// sight in the archive, nothing of it goes on running. Its other tabs stay for when it comes
/// back, and Run starts over then. (A machine removed stops those on it: MachineConnectionTests.)
/// The engine is stubbed.
@MainActor
@Suite(.serialized) struct PanelTerminalsTests {
    static let engine = "http://127.0.0.1:47993"
    let app = AppModel()
    let folder = FileManager.default.temporaryDirectory.appending(path: "KuvoCodeTests-terminals-\(UUID().uuidString)")

    private nonisolated final class EngineSessions: @unchecked Sendable {
        private let lock = NSLock()
        private var listed: [[String: Any]]

        init(_ listed: [[String: Any]]) { self.listed = listed }

        func list() -> StubWeb.Answer { lock.withLock { StubWeb.json(["data": listed]) } }

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
        let sessions = EngineSessions([Self.session("ses_a", in: folder.path), Self.session("ses_b", in: folder.path)])
        StubWeb.route(Self.engine + "/api/session") { _ in sessions.list() }
        StubWeb.route(Self.engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        StubWeb.handle(Self.engine + "/api/session/") { request, body in sessions.change(request, body) }
        app.workspace.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        await app.workspace.refresh()
    }

    private func done() {
        app.utilities.closeAll()
        StubWeb.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    @Test func archivingASessionStopsItsTerminalsAndKeepsItsOtherTabs() async throws {
        defer { done() }
        // As the app has it (`startMachines`), the change's work handed to the test to wait for.
        var work: [Task<Void, Never>] = []
        app.workspace.onArchived = { [app] session, _ in work.append(app.archivedChanged(session)) }
        let panel = app.utilities
        let shell = ["SHELL": "/bin/sh"]
        panel.inView = .init(session: "ses_a")
        panel.newTerminal(in: folder.path, environment: shell)
        panel.run("true", in: folder.path, environment: shell)
        panel.showChanges()
        panel.inView = .init(session: "ses_b")
        panel.newTerminal(in: folder.path, environment: shell)

        #expect(await app.workspace.setArchived("ses_a", true))
        for task in work { await task.value }

        #expect(panel.tabs.filter { $0.owner == "ses_a" }.map(\.kind) == [.changes], "its terminals stopped, its other tabs kept")
        #expect(panel.tabs.filter { $0.owner == "ses_b" && $0.kind == .terminal }.count == 1, "another session's goes on")
        // Brought back: Run starts a terminal of its own again.
        #expect(await app.workspace.setArchived("ses_a", false))
        panel.inView = .init(session: "ses_a")
        panel.run("true", in: folder.path, environment: shell)
        #expect(panel.visibleTabs.filter { $0.kind == .terminal }.count == 1)
    }
}
