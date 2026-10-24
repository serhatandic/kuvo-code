import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A session whose subagent works on (one sent off in the background goes on after the session's
/// own turn) shows working, in its row, tab and bot: when the subagent starts, and when Kuvo Code
/// opens and finds it at work. A subagent gets no row of its own. The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SubagentsAtWorkTests {
    let engine = StubEngine(port: 47989)
    let workspace = Workspace()
    let parent = "ses_lead"
    let child = "ses_helper"

    init() {
        workspace.api = engine.api
        engine.on("GET", "/api/session/\(child)", json: ["data": StubEngine.session(child, title: "Research the API", directory: "/tmp/kuvo-tests-subagents", extra: ["parentID": parent])])
    }

    /// The app opens while the subagent works, its session's own turn over: the session shows working.
    @Test func foundAtWorkOnOpening() async throws {
        defer { engine.stop() }
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")], running: [child])
        await workspace.refresh()
        try await until { workspace.isWorking(parent) }
        #expect(workspace.isWorking(parent), "the session should show working while its subagent works")
        #expect(workspace.helpersAtWork(in: parent) == 1)
        #expect(workspace.session(child) == nil, "a subagent has no row of its own")
    }

    /// The app opens while a subagent's own subagent works (sent off in the background), the
    /// one that started it done: the session at the top shows working.
    @Test func aSubagentsSubagentFoundAtWork() async throws {
        defer { engine.stop() }
        let grandchild = "ses_digger"
        engine.on("GET", "/api/session/\(grandchild)", json: ["data": StubEngine.session(grandchild, title: "Dig through the logs", directory: "/tmp/kuvo-tests-subagents", extra: ["parentID": child])])
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")], running: [grandchild])
        await workspace.refresh()
        try await until { workspace.isWorking(parent) }
        #expect(workspace.isWorking(parent), "the session at the top should show working")
        #expect(workspace.helpersAtWork(in: parent) == 1)
        #expect(workspace.session(child) == nil && workspace.session(grandchild) == nil)
    }

    /// Two of a session's subagents ask you something at once: one session waits for you, on the
    /// Dock too.
    @Test func itsSubagentsAsksAreItsOwn() async throws {
        defer { engine.stop() }
        let second = "ses_helper2"
        engine.on("GET", "/api/session/\(second)", json: ["data": StubEngine.session(second, title: "Check the tests", directory: "/tmp/kuvo-tests-subagents", extra: ["parentID": parent])])
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")], running: [child, second])
        await workspace.refresh()
        try await until { workspace.helpersAtWork(in: parent) == 2 }
        workspace.handle(try engine.event("permission.asked", ["id": "per_1", "sessionID": child, "action": "shell", "resources": ["curl api.example.com"]]))
        workspace.handle(try engine.event("permission.asked", ["id": "per_2", "sessionID": second, "action": "shell", "resources": ["npm test"]]))
        #expect(workspace.needsAttention(parent))
        #expect(workspace.waitingCount == 1, "one session waits for you, not one for each of its subagents")
    }

    /// Started while the app runs: working until the subagent's run ends.
    @Test func startedAndEnded() async throws {
        defer { engine.stop() }
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")])
        await workspace.refresh()
        #expect(!workspace.isWorking(parent))
        workspace.handle(try engine.event("session.execution.started", session: child))
        try await until { workspace.isWorking(parent) }
        #expect(workspace.helpersAtWork(in: parent) == 1)
        #expect(workspace.session(child) == nil)
    }
}
