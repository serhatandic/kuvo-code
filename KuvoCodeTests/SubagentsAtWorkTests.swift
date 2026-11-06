import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A session with something still running after its own turn (a subagent sent off in the background,
/// a command, another task of its agent's) shows working, in its row, tab and bot, as its box says
/// (PROTOCOL.md, "Work › Background work"), on this Mac's box and each machine's alike. The box is the
/// real one (`kuvo-link.js serve`), reached over HTTP, with what it keeps as its watcher keeps it; how
/// it works that out is in the bridge's tests (`work-background.test.js`). The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SubagentsAtWorkTests {
    let engine = StubEngine(port: 47989)
    let workspace = Workspace()
    let parent = "ses_lead"
    let child = "ses_helper"

    init() {
        TestEnvironment.prepare()
        workspace.api = engine.api
        engine.on("GET", "/api/session/\(child)", json: ["data": StubEngine.session(child, title: "Research the API", directory: "/tmp/kuvo-tests-subagents", extra: ["parentID": parent])])
    }

    /// What `session` left running, as the box keeps it.
    private func left(_ work: [String: Any]?, by session: String = "ses_lead", on machine: MachineTestBox) throws {
        let folder = machine.folder.appending(path: "run/work")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let empty: [String: Any] = ["commands": [Any](), "subagents": [Any](), "tasks": [Any]()]
        let sessions = work.map { [session: empty.merging($0) { _, given in given }] } ?? [:]
        try JSONSerialization.data(withJSONObject: ["engine": ["sessions": sessions, "folders": [Any]()]]).write(to: folder.appending(path: "background.json"))
    }

    private var now: Double { Date.now.timeIntervalSince1970 * 1000 }

    /// Followed as a box is, in a task that ends with the test.
    private func following(_ machine: MachineTestBox) -> Task<Void, Never> {
        workspace.boxes = { _ in machine.client }
        let workspace = workspace
        return Task { await workspace.followBackground("lab") }
    }

    /// A subagent goes on after the session's turn: the session shows working, its row says a subagent
    /// is at work, and it ends with it.
    @Test func aSubagentLeftAtWorkKeepsItsSessionWorkingUntilItEnds() async throws {
        defer { engine.stop() }
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")], running: [child])
        await workspace.refresh()
        try left(["subagents": [["id": child, "since": now]]], on: machine)
        let follow = following(machine)
        defer { follow.cancel() }
        try await until { workspace.isWorking(parent) }
        #expect(workspace.helpersAtWork(in: parent) == 1)
        #expect(workspace.session(child) == nil, "a subagent has no row of its own")

        try left(nil, on: machine)
        try await until { !workspace.isWorking(parent) }
        #expect(workspace.helpersAtWork(in: parent) == 0)
    }

    /// A command left running after its turn: at work, though no subagent is, and no event of it came
    /// to this Mac (it started while the app wasn't there).
    @Test func aCommandLeftRunningKeepsItsSessionWorking() async throws {
        defer { engine.stop() }
        let machine = try await MachineTestBox(name: "lab")
        defer { machine.stop() }
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")])
        await workspace.refresh()
        #expect(!workspace.isWorking(parent))
        try left(["commands": [["id": "sh_1", "command": "npm test", "started": now]]], on: machine)
        let follow = following(machine)
        defer { follow.cancel() }
        try await until { workspace.isWorking(parent) }
        #expect(workspace.helpersAtWork(in: parent) == 0, "a command isn't a subagent")
    }

    /// The box gone (a machine disconnecting): this Mac doesn't go on saying what it can't know runs.
    @Test func whatABoxSaidGoesWhenItCantBeHeard() async throws {
        defer { engine.stop() }
        let machine = try await MachineTestBox(name: "lab")
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")])
        await workspace.refresh()
        try left(["commands": [["id": "sh_1", "command": "npm test", "started": now]]], on: machine)
        let follow = following(machine)
        defer { follow.cancel() }
        try await until { workspace.isWorking(parent) }
        machine.stop()
        try await until { !workspace.isWorking(parent) }
    }

    /// The box's stream dropping for a moment isn't the work ending: the session keeps showing at work
    /// while it's followed again, and goes only once the box can't be reached.
    @Test func aDroppedStreamLeavesASessionAtWork() async throws {
        defer { engine.stop() }
        let answers = BoxAnswers()
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")])
        await workspace.refresh()
        let list = Data(#"{"sessions": {"\#(parent)": {"commands": 1, "subagents": 0, "tasks": 0, "since": 1}}}"#.utf8) + Data("\n".utf8)
        let (open, keepOpen) = AsyncStream<Void>.makeStream()
        defer { keepOpen.finish() }
        let client = BoxClient(box: "lab", transport: LocalBox { _ in
            let answer = answers.next()
            return AsyncThrowingStream { continuation in
                let task = Task {
                    switch answer {
                    case 1:
                        // What it says, and the stream drops.
                        continuation.yield(.head(status: 200, headers: [:]))
                        continuation.yield(.body(list))
                    case 2:
                        // Followed again, with nothing said yet, and then it goes.
                        continuation.yield(.head(status: 200, headers: [:]))
                        for await _ in open {}
                    default:
                        continuation.finish(throwing: URLError(.cannotConnectToHost))
                        return
                    }
                    continuation.finish()
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        })
        workspace.boxes = { _ in client }
        let workspace = workspace
        let follow = Task { await workspace.followBackground("lab") }
        defer { follow.cancel() }
        try await until { workspace.isWorking(parent) }
        try await until { answers.asked == 2 }
        #expect(workspace.isWorking(parent), "still at work as far as anyone knows")
        keepOpen.finish()
        try await until { !workspace.isWorking(parent) }
    }

    /// A review's part's tab, opened again as Kuvo Code opens after its review was put away,
    /// says the part is gone, not that a subagent is missing.
    @Test func aReviewsPartOpenedIsKnownAfterRelaunch() {
        defer { engine.stop() }
        workspace.rememberReviewPart("ses_part_kept", of: parent)
        let relaunched = Workspace()
        #expect(relaunched.isReviewPart("ses_part_kept"))
        #expect(relaunched.parent(of: "ses_part_kept") == parent)
        #expect(!relaunched.isReviewPart(child))
    }

    /// Two of a session's subagents ask you something at once: one session waits for you, on the
    /// Dock too.
    @Test func itsSubagentsAsksAreItsOwn() async throws {
        defer { engine.stop() }
        let second = "ses_helper2"
        engine.on("GET", "/api/session/\(second)", json: ["data": StubEngine.session(second, title: "Check the tests", directory: "/tmp/kuvo-tests-subagents", extra: ["parentID": parent])])
        engine.list([StubEngine.session(parent, title: "Lead", directory: "/tmp/kuvo-tests-subagents")], running: [child, second])
        await workspace.refresh()
        try await until { workspace.parent(of: child) == parent && workspace.parent(of: second) == parent }
        workspace.handle(try engine.event("permission.asked", ["id": "per_1", "sessionID": child, "action": "shell", "resources": ["curl api.example.com"]]))
        workspace.handle(try engine.event("permission.asked", ["id": "per_2", "sessionID": second, "action": "shell", "resources": ["npm test"]]))
        #expect(workspace.needsAttention(parent))
        #expect(workspace.waitingCount == 1, "one session waits for you, not one for each of its subagents")
    }
}

/// How many times a box was asked, from its transport's own thread.
private nonisolated final class BoxAnswers: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var asked: Int { lock.withLock { count } }
    func next() -> Int {
        defer { TestPulse.beat() }
        return lock.withLock { count += 1; return count }
    }
}
