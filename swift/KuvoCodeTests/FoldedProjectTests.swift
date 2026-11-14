import ClientDesign
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A folded project still says what calls you back to it, with the mark its most pressing session
/// shows: one finished since you looked makes it new, one at work makes it working over that, and
/// one waiting on you wins over both. A project whose sessions are all quiet shows none, and a
/// subagent's news shows on it as its session's would. The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct FoldedProjectTests {
    let engine = StubEngine(port: 47905)
    let app = AppModel()
    let folder = "/tmp/kuvo-tests-folded-project"

    init() {
        TestEnvironment.prepare()
        app.workspace.api = engine.api
    }

    private func session(_ id: String, parent: String? = nil, created: Double, idle: Double, viewed: Double) -> [String: Any] {
        var extra: [String: Any] = ["time": ["created": created, "updated": idle, "idle": idle, "viewed": viewed]]
        if let parent { extra["parentID"] = parent }
        return StubEngine.session(id, title: id, directory: folder, created: created, extra: extra)
    }

    private var mark: StatusMark.Kind? {
        let project = app.workspace.projects.first { $0.directory == folder }
        return foldedMark(of: project?.sessions ?? [], workspace: app.workspace, app: app)
    }

    @Test func aFoldedProjectShowsItsMostPressingSessionsMark() async throws {
        defer { engine.stop() }
        engine.list([
            session("ses_read", created: 1, idle: 2, viewed: 3),
            session("ses_quiet", created: 4, idle: 5, viewed: 6),
        ])
        await app.workspace.refresh()
        try await engine.listed(for: app.workspace)
        #expect(mark == nil, "nothing under it calls you back")

        // One finishes while you look elsewhere: new.
        engine.list([
            session("ses_read", created: 1, idle: 2, viewed: 3),
            session("ses_quiet", created: 4, idle: 9, viewed: 6),
        ])
        await app.workspace.refresh()
        try await engine.listed(for: app.workspace)
        #expect(mark == .new)

        // Another goes to work: working, over the news.
        engine.list([
            session("ses_read", created: 1, idle: 2, viewed: 3),
            session("ses_quiet", created: 4, idle: 9, viewed: 6),
        ], running: ["ses_read"])
        await app.workspace.refresh()
        try await engine.listed(for: app.workspace)
        try await until { mark == .working }

        // And one asks you something: it needs you, over both.
        app.workspace.handle(try engine.event("permission.asked", ["id": "per_1", "sessionID": "ses_quiet", "action": "edit", "resources": ["Timer.swift"]]))
        try await until { mark == .needsYou }
    }

    @Test func aSubagentFinishingUnderAFoldedProjectMakesItNew() async throws {
        defer { engine.stop() }
        engine.list([
            session("ses_timer", created: 1, idle: 5, viewed: 5),
            session("ses_find", parent: "ses_timer", created: 2, idle: 4, viewed: 4),
        ])
        await app.workspace.refresh()
        try await engine.listed(for: app.workspace)
        #expect(mark == nil, "its subagent finished before you were last in its session")

        // The subagent finishes again, after you looked; its session itself is read.
        engine.list([
            session("ses_timer", created: 1, idle: 5, viewed: 5),
            session("ses_find", parent: "ses_timer", created: 2, idle: 12, viewed: 4),
        ])
        await app.workspace.refresh()
        try await engine.listed(for: app.workspace)
        #expect(app.workspace.hasNewSubSessions("ses_timer"))
        #expect(mark == .new, "the subagent's news shows on the folded project")
    }
}
