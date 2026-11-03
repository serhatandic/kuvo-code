import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A project's branch, as the title bar and the Changes panel's branch menu (Merge, Create Pull
/// Request) show it: read from the engine for the folder the window shows. The engine is stubbed,
/// answering as opencode does.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ProjectBranchTests {
    let engine = StubEngine(port: 47900)
    let workspace = Workspace()
    let directory = "/tmp/kuvo-tests-project-branch"

    private func answersBranch() {
        engine.on("GET", "/api/vcs", json: ["location": ["directory": directory], "data": ["provider": "git", "branch": ["current": "dark-mode", "default": "main"]]])
    }

    private func branch(_ current: String?) -> StubWeb.Answer {
        let branch: [String: Any] = current.map { ["current": $0, "default": "main"] } ?? [:]
        return StubWeb.json(["location": ["directory": directory], "data": ["provider": "git", "branch": branch]])
    }

    /// The engine's branch answers, one per read in the order they're asked: sent at once, or
    /// held until the test sends it (a slow reply, landing after later ones).
    private nonisolated final class Replies: @unchecked Sendable {
        enum Reply { case held, now(StubWeb.Answer) }
        private let lock = NSLock()
        private var script: [Reply]
        private var held: [@Sendable (StubWeb.Answer) -> Void] = []
        private var count = 0
        var asked: Int { lock.withLock { count } }

        init(_ engine: StubEngine, _ replies: [Reply]) {
            script = replies
            StubWeb.hold(engine.url + "/api/vcs") { [self] _, _, reply in
                let next: Reply = lock.withLock {
                    count += 1
                    return script.isEmpty ? .now(StubWeb.Answer(status: 500)) : script.removeFirst()
                }
                switch next {
                case .held: lock.withLock { held.append(reply) }
                case .now(let answer): reply(answer)
                }
            }
        }

        /// Sends the `index`th held reply.
        func send(_ index: Int, _ answer: StubWeb.Answer) {
            lock.withLock { held[index] }(answer)
        }
    }

    @Test func aProjectOnABranchOfItsOwnShowsItAndTheBranchItGoesInto() async throws {
        defer { engine.stop() }
        answersBranch()
        workspace.api = engine.api
        await workspace.loadBranch(for: directory)
        #expect(workspace.branches[directory] == "dark-mode")
        #expect(workspace.defaultBranches[directory] == "main")
    }

    /// The window asks for its folder's branch as the app starts, before this Mac's engine is up:
    /// once it is, the branch shows, so Merge and Create Pull Request are there without switching
    /// tabs.
    @Test func aBranchAskedForBeforeTheEngineWasUpShowsOnceItIs() async throws {
        defer { engine.stop() }
        await workspace.loadBranch(for: directory)
        #expect(workspace.branches[directory] == nil)

        answersBranch()
        engine.list([StubEngine.session("ses_dark", title: "Dark mode", directory: directory)])
        engine.on("GET", "/api/session/active", json: ["data": [:]])
        workspace.api = engine.api
        await workspace.refresh()
        try await until { workspace.branches[directory] == "dark-mode" }
        #expect(workspace.defaultBranches[directory] == "main")
    }

    /// An engine that just started answers a folder's branch before it has read its git (no
    /// branch at all), then says the branch changed: the branch shows then, with the one it goes
    /// into, so Create Pull Request is there.
    @Test func aBranchTheEngineReadsAfterItAnsweredShowsWhenItSaysSo() async throws {
        defer { engine.stop() }
        engine.on("GET", "/api/vcs", json: ["location": ["directory": directory], "data": ["branch": [:]]])
        workspace.api = engine.api
        await workspace.loadBranch(for: directory)
        #expect(workspace.branches[directory] == nil)

        answersBranch()
        let event = ["id": "evt_branch", "type": "vcs.branch.updated", "location": ["directory": directory], "data": ["branch": "dark-mode"]] as [String: Any]
        workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: event)))
        try await until { workspace.defaultBranches[directory] == "main" }
        #expect(workspace.branches[directory] == "dark-mode")
    }

    /// A branch switched in the terminal while an earlier read was slow: the earlier answer,
    /// landing last, doesn't put the old branch back.
    @Test func aSlowerEarlierAnswerDoesNotUndoANewerOne() async throws {
        defer { engine.stop() }
        let replies = Replies(engine, [.held, .now(branch("dark-mode"))])
        workspace.api = engine.api
        let earlier = Task { await workspace.loadBranch(for: directory) }
        try await until { replies.asked == 1 }
        await workspace.loadBranch(for: directory)
        replies.send(0, branch("main"))
        await earlier.value
        #expect(workspace.branches[directory] == "dark-mode")
    }

    /// A newer read failing (a machine's connection hiccuping) doesn't lose the answer an earlier
    /// one brings after it.
    @Test func aNewerReadThatFailsKeepsTheEarlierAnswer() async throws {
        defer { engine.stop() }
        let replies = Replies(engine, [.held, .now(StubWeb.Answer(status: 500))])
        workspace.api = engine.api
        let earlier = Task { await workspace.loadBranch(for: directory) }
        try await until { replies.asked == 1 }
        await workspace.loadBranch(for: directory)
        replies.send(0, branch("dark-mode"))
        await earlier.value
        #expect(workspace.branches[directory] == "dark-mode")
        #expect(workspace.defaultBranches[directory] == "main")
    }

    /// The engine says the branch changed while a read asked before is still on its way: that
    /// read's older answer, landing after, doesn't hide the branch, even when the read the
    /// change brings fails.
    @Test func anAnswerFromBeforeTheEngineSaidTheBranchChangedDoesNotHideIt() async throws {
        defer { engine.stop() }
        let replies = Replies(engine, [.held, .now(StubWeb.Answer(status: 500))])
        workspace.api = engine.api
        let earlier = Task { await workspace.loadBranch(for: directory) }
        try await until { replies.asked == 1 }
        let event = ["id": "evt_branch", "type": "vcs.branch.updated", "location": ["directory": directory], "data": ["branch": "dark-mode"]] as [String: Any]
        workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: event)))
        try await until { replies.asked == 2 }
        replies.send(0, branch(nil))
        await earlier.value
        #expect(workspace.branches[directory] == "dark-mode")
    }
}
