import ClientSessions
import ClientText
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Conversations you start from another show under it in the sidebar: one made with Branch from
/// here (its box marks where it came from), a handoff's and one its agent started, newest first, a branch's own under
/// it. A subagent's session isn't one: the agent started it, and it shows in the conversation it
/// works for. The box is the agents bridge the app ships, run for real; the engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BranchesTests {
    let engine = StubEngine(port: 47915)
    let workspace = Workspace()
    let folder = AppInfo.testRoot.appending(path: "Branches-\(UUID().uuidString.prefix(6))")
    let directory = "/tmp/kuvo-tests-branches"

    init() {
        workspace.api = engine.api
    }

    private func session(_ id: String, _ title: String, created: Double, extra: [String: Any] = [:]) -> [String: Any] {
        StubEngine.session(id, title: title, directory: directory, created: created, extra: extra)
    }

    private func clean() {
        engine.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    @Test func branchFromHereShowsUnderTheConversationItCameFrom() async throws {
        defer { clean() }
        engine.list([session("ses_timer", "Timer cycle", created: 1, extra: ["model": ["id": "m", "providerID": "p"]])])
        engine.on("GET", "/api/session/ses_timer", json: ["data": session("ses_timer", "Timer cycle", created: 1)])
        engine.on("GET", "/api/session/active", json: ["data": [:]])
        engine.on("GET", "/api/event") { _ in StubWeb.Answer(status: 200, body: Data()) }
        engine.on("GET", "/api/provider", json: ["data": []])
        engine.on("GET", "/api/integration", json: ["data": []])
        let messages: [[String: Any]] = [
            ["id": "msg_0001", "type": "user", "text": "Split the timer into phases.", "time": ["created": 1]],
            ["id": "msg_0002", "type": "user", "text": "Now test the long break.", "time": ["created": 3]],
        ]
        engine.conversation("ses_timer", messages)
        // The engine's copy, which says nothing of where it came from.
        engine.on("POST", "/api/session/ses_timer/fork", json: ["data": session("ses_tried", "Timer cycle", created: 5)])
        // (Read by its box just before it's marked.)
        engine.on("GET", "/api/session/ses_tried", json: ["data": session("ses_tried", "Timer cycle", created: 5)])
        engine.on("PATCH", "/api/session/ses_tried", json: ["data": [:]])
        await workspace.refresh()
        try await engine.listed(for: workspace)

        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        defer { bridge.stop() }
        workspace.agents = bridge.agents
        try await until { bridge.agents.runsKeywords == true }

        guard case .user(let message) = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: messages[1])) else {
            throw TestFailure("not a user message")
        }
        try await workspace.fork("ses_timer", from: message)

        #expect(engine.requests("POST", "/api/session/ses_timer/fork").first?.body["before"] as? String == "msg_0002")
        let marked = try #require(engine.requests("PATCH", "/api/session/ses_tried").first?.body["metadata"] as? [String: Any])
        #expect((marked["kuvo"] as? [String: Any])?["branchedFrom"] as? String == "ses_timer", "its box marked where it came from")
        // (Its box lists it, as its engine does.)
        engine.lists(session("ses_tried", "Timer cycle", created: 5, extra: ["metadata": marked]))
        try await until { workspace.projects.flatMap(\.sessions).contains { $0.id == "ses_tried" } }
        #expect(Branches.tree(workspace.projects.flatMap(\.sessions)).under["ses_timer"]?.map(\.id) == ["ses_tried"], "under the one it came from")
        #expect(workspace.projects.flatMap(\.sessions).map(\.id).contains("ses_tried"), "a conversation of its own, all the same")
        #expect(Branches.tree(workspace.projects.flatMap(\.sessions)).top.map(\.id) == ["ses_timer"], "not a row at the top")
    }

    /// With no box that marks it (one from before branches, its bridge down), the engine's copy is
    /// marked from here as the box would: under the one it came from, unpinned, not under where
    /// that one was handed off from.
    @Test func withoutTheBoxsRouteABranchIsStillMarked() async throws {
        defer { clean() }
        engine.list([session("ses_timer", "Timer cycle", created: 1)])
        engine.on("POST", "/api/session/ses_timer/fork", json: ["data": session("ses_tried", "Timer cycle", created: 5,
                                                                                extra: ["metadata": ["kuvo.pinned": true, "kuvo": ["handoffFrom": "ses_old", "startedBy": "ses_lead", "beside": true, "kuvoAgent": "claude"]]])])
        engine.on("PATCH", "/api/session/ses_tried", json: ["data": [:]])
        await workspace.refresh()
        try await engine.listed(for: workspace)
        let message = Message.User(id: "msg_0002", time: .init(created: 3), text: "Now test the long break.")
        try await workspace.fork("ses_timer", from: message)

        let marked = try #require(engine.requests("PATCH", "/api/session/ses_tried").first?.body["metadata"] as? [String: Any])
        #expect(marked["kuvo.pinned"] == nil, "it starts unpinned")
        #expect(marked["kuvo"] as? [String: String] == ["branchedFrom": "ses_timer", "kuvoAgent": "claude"])
        engine.lists(session("ses_tried", "Timer cycle", created: 5, extra: ["metadata": marked]))
        try await until { workspace.projects.flatMap(\.sessions).contains { $0.id == "ses_tried" } }
        #expect(Branches.tree(workspace.projects.flatMap(\.sessions)).under["ses_timer"]?.map(\.id) == ["ses_tried"])
    }

    /// Branched from a goal, the new conversation's composer has it as a goal: /goal and its words,
    /// ready to ask for it another way (it had the words alone, a plain message).
    @Test func aBranchFromAGoalStartsWithTheGoalInItsComposer() async throws {
        defer {
            clean()
            Drafts.shared.remove("ses_tried")
        }
        engine.list([session("ses_timer", "Timer cycle", created: 1)])
        engine.on("POST", "/api/session/ses_timer/fork", json: ["data": session("ses_tried", "Timer cycle", created: 5)])
        engine.on("PATCH", "/api/session/ses_tried", json: ["data": [:]])
        await workspace.refresh()
        try await engine.listed(for: workspace)
        let message = Message.User(id: "msg_0002", time: .init(created: 3), text: "Summarize the commits weekly\n\n<sent-with>\n\(SentWithKeyword.goalHeading)\n/goal\n</sent-with>")
        try await workspace.fork("ses_timer", from: message)
        #expect(Drafts.shared["ses_tried"].text == "/goal Summarize the commits weekly")
    }

    @Test func branchesAndHandoffsNestAndSubagentsStayInTheirConversation() async throws {
        defer { clean() }
        engine.list([
            session("ses_timer", "Timer cycle", created: 1),
            session("ses_tried", "Try a state machine", created: 10, extra: ["metadata": ["kuvo": ["branchedFrom": "ses_timer"]]]),
            session("ses_carried", "Timer cycle (continued)", created: 20, extra: ["metadata": ["kuvo": ["handoffFrom": "ses_timer"]]]),
            session("ses_deeper", "Try it with an enum", created: 30, extra: ["metadata": ["kuvo": ["branchedFrom": "ses_tried"]]]),
            session("ses_find", "Find where the timer state lives", created: 40, extra: ["parentID": "ses_timer"]),
            session("ses_lost", "From one archived since", created: 50, extra: ["metadata": ["kuvo": ["branchedFrom": "ses_gone"]]]),
            // One its agent started (start_session), whatever kind of agent.
            session("ses_review", "Review the timer tests", created: 25, extra: ["metadata": ["kuvo": ["startedBy": "ses_timer", "beside": true]]]),
        ])
        await workspace.refresh()
        try await engine.listed(for: workspace)

        let tree = Branches.latestFirst(try #require(workspace.projects.first).sessions)
        #expect(tree.under["ses_timer"]?.map(\.id) == ["ses_review", "ses_carried", "ses_tried"], "newest first, one its agent started too")
        #expect(tree.under["ses_tried"]?.map(\.id) == ["ses_deeper"], "a branch's own, under it")
        #expect(tree.top.map(\.id) == ["ses_lost", "ses_timer"], "the latest first, each as new as its newest branch")
        #expect(!tree.under.values.joined().contains { $0.id == "ses_find" }, "a subagent isn't a branch")
        #expect(workspace.subSessions["ses_timer"]?.map(\.id) == ["ses_find"], "it's the conversation's, shown there")
    }

    /// One a lead on another computer started says where at its row's end, "from Mini", and the
    /// whole when pointed at and to VoiceOver, also with that computer's sessions in the sidebar
    /// (they are, connected or last seen): its lead isn't on this Mac's page, so nothing above the
    /// row says it. One started here sits under its lead with nothing at its end.
    @Test func oneALeadOnAnotherComputerStartedSaysWhereWithThatComputersSessionsListedToo() async throws {
        defer { clean() }
        let lead: [String: Any] = ["box": "Mini", "name": "Foreman", "key": String(repeating: "N", count: 43)]
        engine.list([
            session("ses_review", "Review the timer tests", created: 25, extra: ["metadata": ["kuvo": ["startedBy": "ses_foreman", "lead": lead]]]),
            // The lead, among Mini's sessions, which the sidebar holds as well.
            StubEngine.session("ses_foreman", title: "Foreman", directory: RemoteFolder.folder("/home/me/kuvo", on: "mini.invalid"), created: 20),
            session("ses_timer", "Timer cycle", created: 1),
            session("ses_tried", "Try a state machine", created: 30, extra: ["metadata": ["kuvo": ["startedBy": "ses_timer"]]]),
        ])
        await workspace.refresh()
        try await engine.listed(for: workspace)

        #expect(workspace.session("ses_foreman") != nil, "Mini's lead is in the sidebar's lists")
        let review = try #require(workspace.session("ses_review"))
        #expect(SidebarView.tail(of: review, in: workspace, nested: false) == "from Mini")
        #expect(SidebarView.origin(of: review, in: workspace, nested: false) == "Started from Foreman on Mini")
        let tried = try #require(workspace.session("ses_tried"))
        #expect(SidebarView.tail(of: tried, in: workspace, nested: true) == nil)
        #expect(SidebarView.origin(of: tried, in: workspace, nested: true) == "Started from Timer cycle")
    }
}
