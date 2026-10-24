import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The window's tabs (A2): opening, closing and reopening tabs where they were, split views and
/// which half you work in, what the side panel follows, a conversation moved to the coding agents
/// keeping its tab, an agent's new session opening beside the one that started it, and the tabs
/// coming back at the next launch, also as an older version kept them. The engine and the agents'
/// bridge are stubbed; the window itself isn't driven: what it shows is what `WindowTabs` holds.
@MainActor
@Suite(.serialized) struct WindowTabsTests {
    let engine = StubEngine(port: 47974)
    let bridge = StubEngine(port: 47975, alongside: true)
    let app = AppModel()
    let folder = "/tmp/kuvo-tests-window-tabs"
    var tabs: WindowTabs { app.tabs }

    init() {
        app.workspace.api = engine.api
        app.workspace.agents = app.agents
        app.agents.connect(bridge.api.client.endpoint, folderPrefix: "")
        // As the app has it (AppModel.start).
        app.workspace.onMovedToAgents = { [weak app] from, to in await app?.movedToAgents(from: from, to: to) ?? false }
    }

    private func done() {
        app.agents.disconnect()
        engine.stop()
    }

    /// Sessions `ids` in the project, loaded.
    private func sessions(_ ids: [String], extra: [String: [String: Any]] = [:]) async {
        engine.list(ids.map { StubEngine.session($0, title: $0, directory: folder, extra: extra[$0] ?? [:]) })
        await app.workspace.refresh()
    }

    /// What the window shows the panel, as it does each time it changes.
    private func panelFollows() {
        app.utilities.inView = tabs.inView
    }

    private var keys: [String] { tabs.keys.map(\.text) }

    // MARK: Opening, closing, reopening

    @Test func aTabOpensBesideTheOneInViewAndComesBackWhereItWasClosed() async {
        defer { done() }
        await sessions(["ses_a", "ses_b", "ses_c"])
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_c"))
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_b"))
        #expect(keys == ["ses_a", "ses_b", "ses_c"], "each opens next to the one in view")
        #expect(tabs.selection == .session("ses_b"))

        tabs.close(.session("ses_b"))
        #expect(keys == ["ses_a", "ses_c"])
        #expect(tabs.selection == .session("ses_c"), "the one that took its place is in view")
        tabs.open(.session("ses_a"))
        #expect(keys == ["ses_a", "ses_c"], "an open tab comes forward, not twice")

        #expect(tabs.canReopenTab)
        tabs.reopenClosedTab()
        #expect(keys == ["ses_a", "ses_b", "ses_c"], "back where it was")
        #expect(tabs.selection == .session("ses_b"))
        #expect(!tabs.canReopenTab)
    }

    @Test func aSessionDeletedSinceIsntReopened() async {
        defer { done() }
        await sessions(["ses_a", "ses_b"])
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_b"))
        tabs.close(.session("ses_b"))
        await sessions(["ses_a"])
        tabs.dropClosed()
        #expect(!tabs.canReopenTab)
        tabs.reopenClosedTab()
        #expect(keys == ["ses_a"])
    }

    /// A split closed comes back as a pair, and the half beside closed on its own goes back beside.
    @Test func aSplitClosedComesBackAsAPair() async {
        defer { done() }
        await sessions(["ses_a", "ses_b", "ses_c"])
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_c"))
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_b")
        #expect(keys == ["ses_a", "ses_c"], "one tab for the two")
        #expect(tabs.pairs[.session("ses_a")] == "ses_b")

        tabs.closeBesideTab(.session("ses_a"))
        #expect(tabs.pairs.isEmpty)
        tabs.reopenClosedTab()
        #expect(tabs.pairs[.session("ses_a")] == "ses_b", "back beside it")
        #expect(keys == ["ses_a", "ses_c"])

        tabs.close(.session("ses_a"))
        #expect(keys == ["ses_c"])
        tabs.reopenClosedTab()
        #expect(keys == ["ses_a", "ses_c"])
        #expect(tabs.pairs[.session("ses_a")] == "ses_b", "the pair comes back as a pair")

        tabs.swapBeside(.session("ses_a"))
        #expect(keys == ["ses_b", "ses_c"], "swapped, the tab stays where it is")
        #expect(tabs.pairs == [.session("ses_b"): "ses_a"])
        #expect(tabs.selection == .session("ses_b"))
        tabs.closeBeside(.session("ses_b"))
        #expect(keys == ["ses_b", "ses_a", "ses_c"], "each in a tab of its own again")
    }

    // MARK: The panel

    /// You work in the session beside: its panel shows, and stays its while the expanded panel
    /// covers it; once the window is too narrow for both, it's the tab's again.
    @Test func thePanelFollowsTheHalfYouWorkIn() async throws {
        defer { done() }
        await sessions(["ses_a", "ses_b"])
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_b")
        panelFollows()
        #expect(tabs.focus == .split, "Open Beside: its composer takes the keyboard")
        #expect(app.utilities.panelKey == "ses_b")
        let file = URL(filePath: folder + "/Notes.md")
        app.utilities.open(file)
        #expect(app.utilities.visibleTabs.contains { $0.kind == .file(file) })

        tabs.focus = .conversation
        panelFollows()
        #expect(app.utilities.panelKey == "ses_a", "clicking into the tab's half")
        #expect(!app.utilities.visibleTabs.contains { $0.kind == .file(file) }, "its own panel")

        tabs.focus = .split
        tabs.showPanel()
        tabs.panelExpanded = true
        panelFollows()
        #expect(tabs.besideID == nil, "under the expanded panel, the session beside is out of view")
        #expect(app.utilities.panelKey == "ses_b", "but the panel is still its")
        #expect(app.utilities.visibleTabs.contains { $0.kind == .file(file) })
        #expect(tabs.focusedModel?.id == "ses_b", "and the menus' commands go to it")

        tabs.room.width = 600
        panelFollows()
        #expect(app.utilities.panelKey == "ses_a", "out of room, it gave way: the tab's again")
    }

    /// Short of room, only the split you opened last keeps its place: another tab's, met again,
    /// gives way, and its session beside isn't in view (nor read) the moment you get there.
    @Test func aSplitMetAgainGivesWay() async {
        defer { done() }
        await sessions(["ses_a", "ses_b", "ses_c", "ses_d"])
        tabs.room = .init(width: 800, sessions: 280)
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_b")
        tabs.open(.session("ses_c"))
        tabs.openBeside("ses_d")
        #expect(tabs.sessionsInView == ["ses_c", "ses_d"])
        #expect(tabs.layout().sessions == nil, "the sidebar gave way for the split opened last")
        tabs.open(.session("ses_a"))
        #expect(tabs.sessionsInView == ["ses_a"])
        #expect(tabs.layout().split == nil)
        #expect(tabs.layout().sessions != nil)
    }

    @Test func anotherTabStartsInItsOwnConversation() async {
        defer { done() }
        await sessions(["ses_a", "ses_b", "ses_c"])
        tabs.open(.session("ses_c"))
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_b")
        #expect(tabs.workedBesideID == "ses_b")
        tabs.cycle(by: 1)
        #expect(tabs.selection == .session("ses_c"))
        #expect(tabs.focus == .conversation)
        tabs.cycle(by: 1)
        #expect(tabs.selection == .session("ses_a"))
        #expect(tabs.workedBesideID == nil, "back on the split, you're in its tab's half until you click beside")
    }

    // MARK: Sessions that carry on, or start

    /// Picking a coding agent's model in a session that's in a tab: the new session is in the same
    /// tab, in the same place, at once.
    @Test func aSessionMovedToTheCodingAgentsKeepsItsTab() async throws {
        defer { done() }
        await sessions(["ses_a", "ses_engine", "ses_c"])
        engine.conversation("ses_engine", [["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Add a settings page"]])
        engine.on("GET", "/api/session/ses_engine", json: ["data": StubEngine.session("ses_engine", directory: folder)])
        engine.on("GET", "/api/session/ses_engine/inbox", json: ["data": []])
        engine.on("PATCH", "/api/session/ses_engine", json: [:])
        bridge.on("POST", "/api/session/import", json: ["data": StubEngine.session("ses_agent", title: "Settings", directory: folder)])
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_engine"))
        tabs.open(.session("ses_c"))
        tabs.open(.session("ses_engine"))

        try await app.workspace.moveToAgents("ses_engine", model: ModelRef(id: "sonnet", providerID: "claude-code"))

        #expect(keys == ["ses_a", "ses_agent", "ses_c"])
        #expect(tabs.selection == .session("ses_agent"))
        tabs.dropClosed()
        #expect(keys == ["ses_a", "ses_agent", "ses_c"], "the archived one's going doesn't take the tab")
    }

    @Test func aSessionMovedFromBesideStaysBeside() async throws {
        defer { done() }
        await sessions(["ses_a", "ses_engine"])
        engine.conversation("ses_engine", [])
        engine.on("GET", "/api/session/ses_engine", json: ["data": StubEngine.session("ses_engine", directory: folder)])
        engine.on("GET", "/api/session/ses_engine/inbox", json: ["data": []])
        engine.on("PATCH", "/api/session/ses_engine", json: [:])
        bridge.on("POST", "/api/session/import", json: ["data": StubEngine.session("ses_agent", directory: folder)])
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_engine")

        try await app.workspace.moveToAgents("ses_engine", model: ModelRef(id: "sonnet", providerID: "claude-code"))

        #expect(keys == ["ses_a"])
        #expect(tabs.pairs[.session("ses_a")] == "ses_agent")
        #expect(tabs.workedBesideID == "ses_agent", "you go on working in it")
    }

    /// One with no tab opens in one, as any session does.
    @Test func aSessionMovedWithoutATabOpens() async throws {
        defer { done() }
        await sessions(["ses_engine"])
        engine.conversation("ses_engine", [])
        engine.on("GET", "/api/session/ses_engine", json: ["data": StubEngine.session("ses_engine", directory: folder)])
        engine.on("GET", "/api/session/ses_engine/inbox", json: ["data": []])
        engine.on("PATCH", "/api/session/ses_engine", json: [:])
        bridge.on("POST", "/api/session/import", json: ["data": StubEngine.session("ses_agent", directory: folder)])

        try await app.workspace.moveToAgents("ses_engine", model: ModelRef(id: "sonnet", providerID: "claude-code"))

        #expect(keys == ["ses_agent"])
        #expect(tabs.selection == .session("ses_agent"))
    }

    /// An agent's start_session: beside the conversation in view that started it; another
    /// conversation's in a tab at the end, for you to find.
    @Test func anAgentsNewSessionOpensBesideTheOneThatStartedIt() async throws {
        defer { done() }
        await sessions(["ses_a", "ses_b"])
        tabs.open(.session("ses_a"))
        let now = Date.now.timeIntervalSince1970 * 1000
        for (id, starter) in [("ses_helper", "ses_a"), ("ses_other", "ses_b")] {
            engine.on("GET", "/api/session/\(id)", json: ["data": StubEngine.session(id, directory: folder, created: now, extra: ["metadata": ["kuvo": ["startedBy": starter]]])])
            app.workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.created", "created": 1, "data": ["sessionID": id]])))
            await app.workspace.reloading[id]?.value
        }
        #expect(tabs.pairs[.session("ses_a")] == "ses_helper")
        #expect(keys == ["ses_a", "ses_other"])
        #expect(tabs.selection == .session("ses_a"))
    }

    // MARK: Keeping them

    @Test func theTabsComeBackAtTheNextLaunch() async {
        defer { done() }
        await sessions(["ses_a", "ses_b", "ses_c"])
        tabs.open(.session("ses_a"))
        tabs.open(.draft(folder))
        tabs.open(.group("grp_1"))
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_b")
        tabs.showPanel()
        let saved = tabs.saved

        let nextLaunch = AppModel()
        let next = nextLaunch.tabs
        next.restore(saved, older: .init())
        #expect(next.keys == tabs.keys)
        #expect(next.selection == .session("ses_a"))
        #expect(next.pairs == [.session("ses_a"): "ses_b"])
        #expect(next.showsPanel)
    }

    /// As versions before kept them: the keys a line each, and the pairs as `<tab>=<session>`.
    @Test func tabsKeptTheOlderWayComeBack() {
        let nextLaunch = AppModel()
        let next = nextLaunch.tabs
        next.restore("", older: .init(tabs: "ses_a\ndraft:/tmp/project\ngroup:grp_1\nses_c", selection: "draft:/tmp/project",
                                      pairs: "ses_a=ses_b\nses_c=ses_a", showsPanel: true))
        #expect(next.keys == [.session("ses_a"), .draft("/tmp/project"), .group("grp_1"), .session("ses_c")])
        #expect(next.selection == .draft("/tmp/project"))
        #expect(next.pairs == [.session("ses_a"): "ses_b"], "a session that has a tab isn't also beside another")
        #expect(next.showsPanel)
        let after = AppModel()
        after.tabs.restore(next.saved, older: .init(tabs: "ses_old"))
        #expect(after.tabs.keys == next.keys, "kept the new way from now on")
    }

    /// A folder opened with Kuvo Code as it launched opens in a tab of its own, in view, beside
    /// those kept from before.
    @Test func whatOpenedAtLaunchStaysWithTheRestoredTabs() {
        let nextLaunch = AppModel()
        let next = nextLaunch.tabs
        next.open(.draft("/tmp/opened"))
        next.open(.session("ses_notified"))
        next.restore(#"{"tabs":["ses_a","ses_b"],"selection":"ses_b","pairs":[{"tab":"ses_a","beside":"ses_notified"}]}"#, older: .init())
        #expect(next.keys == [.session("ses_a"), .session("ses_b"), .draft("/tmp/opened"), .session("ses_notified")])
        #expect(next.selection == .session("ses_notified"))
        #expect(next.pairs.isEmpty, "a session opened in a tab of its own isn't also beside another")
        #expect(!next.showsPanel, "what a version that kept less didn't keep is as it starts")
    }
}
