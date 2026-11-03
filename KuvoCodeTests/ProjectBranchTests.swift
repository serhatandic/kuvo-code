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
}
