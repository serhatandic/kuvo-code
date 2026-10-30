import AppKit
import Foundation
import OpenCodeKit
import SwiftTerm
import Testing
@testable import KuvoCode

/// The window's tabs (A2): opening, closing and reopening tabs where they were, split views and
/// which half you work in, what the side panel follows, a conversation moved to the coding agents
/// keeping its tab, an agent's new session leaving the window as it was, a session opened from
/// beside another showing by itself, and the tabs coming back at the next launch, also as an older
/// version kept them. The engine and the agents'
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

    /// A subagent opens in place of the conversation it works for, in its tab; the way back (or
    /// picking that conversation in the sidebar) brings the conversation back there, and a
    /// subagent's own subagent opens in its place in turn. Nothing else gets a tab.
    @Test func aSubagentOpensInPlaceOfItsConversation() async {
        defer { done() }
        engine.list([
            StubEngine.session("ses_a", title: "ses_a", directory: folder),
            StubEngine.session("ses_timer", title: "Timer cycle", directory: folder),
            StubEngine.session("ses_find", title: "Find the timer", directory: folder, extra: ["parentID": "ses_timer"]),
            StubEngine.session("ses_deep", title: "Read the slider", directory: folder, extra: ["parentID": "ses_find"]),
        ])
        await app.workspace.refresh()
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_timer"))

        tabs.openInPlace("ses_find")
        #expect(keys == ["ses_a", "ses_find"], "in its conversation's tab")
        #expect(tabs.selection == .session("ses_find"))
        tabs.openInPlace("ses_deep")
        #expect(keys == ["ses_a", "ses_deep"], "its own subagent, in its place")
        tabs.openInPlace("ses_find")
        #expect(keys == ["ses_a", "ses_find"], "back up a step")

        // The conversation picked in the sidebar comes back in that tab.
        tabs.open(.session("ses_timer"))
        #expect(keys == ["ses_a", "ses_timer"])
        #expect(tabs.selection == .session("ses_timer"))
    }

    // A review's part reads in a session of its own under the conversation: never listed (its
    // review shows it), it opens from the review's card in the conversation's place, as a
    // subagent does, with the way back to the conversation.
    @Test func aReviewsPartOpensInPlaceOfItsConversationButIsNeverListed() async {
        defer { done() }
        engine.list([
            StubEngine.session("ses_timer", title: "Timer cycle", directory: folder),
            StubEngine.session("ses_part", title: "Review · part 2 of 4", directory: folder,
                               extra: ["parentID": "ses_timer", "metadata": ["kuvo": ["reviewPart": ["review": "rev_1", "part": 2, "of": 4]]]]),
        ])
        await app.workspace.refresh()
        #expect(app.workspace.subSessions["ses_timer"]?.map(\.id) ?? [] == [], "not one of its subagents")
        tabs.open(.session("ses_timer"))

        app.workspace.rememberReviewPart("ses_part", of: "ses_timer")
        tabs.openInPlace("ses_part")
        #expect(keys == ["ses_part"], "in its conversation's tab")
        #expect(app.workspace.parent(of: "ses_part") == "ses_timer", "its way back")
        tabs.openInPlace("ses_timer")
        #expect(keys == ["ses_timer"])
    }

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

    /// A tab picked in the tab bar is the one you work in, however you were working in the sidebar
    /// or the panel before: its card looks it, and its composer has the keyboard.
    @Test func aTabPickedInTheTabBarIsTheOneYouWorkIn() async {
        defer { done() }
        await sessions(["ses_a", "ses_b"])
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_b"))
        for elsewhere in [WindowTabs.Pane.sessions, .changes] {
            tabs.focus = elsewhere
            let asked = app.workspace.model(for: "ses_a")?.composerFocus
            tabs.pick(.session("ses_a"))
            #expect(tabs.selection == .session("ses_a"))
            #expect(tabs.focus == .conversation, "after working in \(elsewhere)")
            // Its composer takes the keyboard, so typing goes where the window shows you working.
            #expect(app.workspace.model(for: "ses_a")?.composerFocus != asked)
            tabs.pick(.session("ses_b"))
        }
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

    /// An agent's start_session opens nothing: the window stays as it was, wherever the agent that
    /// started it is, and the new session waits under its conversation in the sidebar.
    @Test func anAgentsNewSessionLeavesTheWindowAsItWas() async throws {
        defer { done() }
        await sessions(["ses_a", "ses_b"])
        tabs.open(.session("ses_a"))
        let now = Date.now.timeIntervalSince1970 * 1000
        for (id, starter) in [("ses_helper", "ses_a"), ("ses_other", "ses_b")] {
            engine.on("GET", "/api/session/\(id)", json: ["data": StubEngine.session(id, directory: folder, created: now, extra: ["metadata": ["kuvo": ["startedBy": starter, "beside": true]]])])
            app.workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.created", "created": 1, "data": ["sessionID": id]])))
            await app.workspace.reloading[id]?.value
        }
        #expect(app.workspace.session("ses_helper") != nil, "it's there, to open from the sidebar")
        #expect(tabs.pairs.isEmpty, "nothing beside the conversation")
        #expect(keys == ["ses_a"], "no tab of its own either")
        #expect(tabs.selection == .session("ses_a"))
    }

    /// A session opened from the sidebar (or ⌘K, a notification, a link) is the one you get, by
    /// itself: one beside another conversation comes out of that pair into a tab of its own, unless
    /// the pair is in view, where it only takes the keyboard.
    @Test func aSessionBesideAnotherOpensByItself() async {
        defer { done() }
        await sessions(["ses_a", "ses_b", "ses_c"])
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_b")
        tabs.open(.session("ses_c"))

        tabs.open(.session("ses_b"))
        #expect(tabs.selection == .session("ses_b"), "the session itself, not the conversation it was beside")
        #expect(tabs.pairs.isEmpty)
        #expect(keys == ["ses_a", "ses_b", "ses_c"], "in a tab of its own, next to the one it was beside")

        // In view beside the conversation you're in: it stays there, and you work in it.
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_b")
        tabs.open(.session("ses_b"))
        #expect(tabs.pairs[.session("ses_a")] == "ses_b")
        #expect(tabs.selection == .session("ses_a"))
        #expect(tabs.focus == .split)
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

    /// New Project open with something typed in it stays, when a shortcut or a notification asks
    /// for the popup again; once it's closed, the next one opens.
    @Test func anOpenProjectPopupIsntReplaced() {
        defer { done() }
        let typing = ProjectEditorRequest(project: nil, folders: ["/tmp/kuvo-tests-typed"])
        tabs.openProjectEditor(typing)
        tabs.openProjectEditor(ProjectEditorRequest(project: nil))
        #expect(tabs.projectEditor?.id == typing.id, "the popup being typed in stays")
        #expect(tabs.projectEditor?.folders == ["/tmp/kuvo-tests-typed"])

        tabs.projectEditor = nil
        let next = ProjectEditorRequest(project: nil, focusesRun: true)
        tabs.openProjectEditor(next)
        #expect(tabs.projectEditor?.id == next.id, "closed, the next one opens")
    }

    /// Two new sessions written at once, and a terminal tab: what you open in the panel beside
    /// one stays beside it, and a terminal tab's panel closes with the tab.
    @Test func eachNewSessionAndTerminalTabHasAPanelOfItsOwn() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "KuvoCodeTests-panels-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        defer { done(); try? FileManager.default.removeItem(atPath: folder) }
        let notes = URL(filePath: folder + "/a/notes.md"), log = URL(filePath: folder + "/build.log")
        tabs.newSession(in: folder + "/a", conversation: true)
        panelFollows()
        app.utilities.open(notes)
        tabs.newSession(in: folder + "/b", conversation: true)
        panelFollows()
        #expect(!app.utilities.visibleTabs.contains { $0.kind == .file(notes) }, "the other new session's file stays beside it")
        tabs.openTerminalTab(command: nil, in: folder)
        let terminal = try #require(tabs.selection)
        panelFollows()
        #expect(!app.utilities.visibleTabs.contains { $0.kind == .file(notes) })
        app.utilities.open(log)
        tabs.close(terminal)
        panelFollows()
        #expect(!app.utilities.tabs.contains { $0.kind == .file(log) }, "its panel closed with it")
        tabs.open(.draft(folder + "/a"))
        panelFollows()
        #expect(app.utilities.visibleTabs.contains { $0.kind == .file(notes) }, "back to the first, its file is there")
    }

    /// Text selected in a terminal tab of the window, Add to Message from its right-click menu: a
    /// new session in the terminal's folder, with the text in its message.
    @Test func addToMessageInATerminalTabStartsASessionWithTheSelection() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "KuvoCodeTests-terminal-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        tabs.openTerminalTab(command: nil, in: folder)
        let terminalTab = try #require(tabs.selection)
        defer { tabs.close(terminalTab); done(); try? FileManager.default.removeItem(atPath: folder) }
        let terminal = try #require(app.mainTerminals.entry(terminalTab.text)?.session)
        terminal.view.feed(text: "make: *** [build] Error 1")
        terminal.view.selectAll(nil)
        let menu = try #require(terminal.view.menu)
        terminal.menuNeedsUpdate(menu)
        menu.performActionForItem(at: menu.indexOfItem(withTitle: "Add to Message"))
        let draft = try #require(tabs.selection)
        #expect(draft != terminalTab, "a session to write it in")
        #expect(Drafts.shared[draft.text].text.contains("make: *** [build] Error 1"))
        Drafts.shared[draft.text] = Drafts.Draft()
    }
}
