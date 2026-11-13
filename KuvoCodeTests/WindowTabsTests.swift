import AppKit
import ClientDesign
import Foundation
import KuvoLink
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

    /// `ses_engine` carried on with the coding agents as `ses_agent` by its box (its part:
    /// MoveToAgentsTests), which the bridge then has.
    private func carriedByItsBox() {
        bridge.on("GET", "/api/session/ses_agent", json: ["data": StubEngine.session("ses_agent", title: "Settings", directory: folder)])
        let carried = try! JSONSerialization.data(withJSONObject: ["session": "ses_agent"])
        app.workspace.boxes = { box in
            BoxClient(box: box, transport: LocalBox { request in
                AsyncThrowingStream { continuation in
                    let carries = request.method == "POST" && request.path == "kuvo/sessions/ses_engine/agents"
                    continuation.yield(.head(status: carries ? 200 : 404, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(carries ? carried : Data("{}".utf8)))
                    continuation.finish()
                }
            })
        }
    }

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

    /// A conversation opened from inside another (a bot's session from its bot, a session's
    /// subagent from it, a bot's conversation from a group chat) opens in its place, in its tab,
    /// with the way back to it; Back goes a step at a time, one it came through opened again is
    /// gone back to rather than round again, and one picked in the sidebar starts fresh. Opened
    /// from anywhere but the tab in view, it's a tab of its own, with no way back.
    @Test func aConversationOpenedFromAnotherGoesBackAStepAtATime() async {
        defer { done() }
        engine.list([
            StubEngine.session("ses_bot", title: "Foreman", directory: folder),
            StubEngine.session("ses_work", title: "Timer cycle", directory: folder),
            StubEngine.session("ses_other", title: "Settings page", directory: folder),
            StubEngine.session("ses_find", title: "Find the timer", directory: folder, extra: ["parentID": "ses_work"]),
        ])
        await app.workspace.refresh()
        tabs.open(.session("ses_other"))
        tabs.open(.session("ses_bot"))

        tabs.go(to: .session("ses_work"), from: .session("ses_bot"))
        #expect(keys == ["ses_other", "ses_work"], "in the bot's tab")
        #expect(tabs.back(of: .session("ses_work")) == .session("ses_bot"))
        tabs.go(to: .session("ses_find"), from: .session("ses_work"))
        #expect(keys == ["ses_other", "ses_find"])
        #expect(tabs.back(of: .session("ses_find")) == .session("ses_work"))
        #expect(tabs.isKept(.session("ses_bot")) && tabs.isKept(.session("ses_work")), "kept made, to be where you were")

        tabs.goBack()
        #expect(keys == ["ses_other", "ses_work"])
        #expect(tabs.back(of: .session("ses_work")) == .session("ses_bot"))
        tabs.goBack()
        #expect(keys == ["ses_other", "ses_bot"])
        #expect(tabs.selection == .session("ses_bot"))
        #expect(tabs.back(of: .session("ses_bot")) == nil, "back at the start")
        #expect(!tabs.isKept(.session("ses_work")))

        // The bot opened again from the subagent: back to it, not round again.
        tabs.go(to: .session("ses_work"), from: .session("ses_bot"))
        tabs.go(to: .session("ses_find"), from: .session("ses_work"))
        tabs.go(to: .session("ses_bot"), from: .session("ses_find"))
        #expect(keys == ["ses_other", "ses_bot"])
        #expect(tabs.back(of: .session("ses_bot")) == nil)

        // Picked in the sidebar: no way back.
        tabs.go(to: .session("ses_work"), from: .session("ses_bot"))
        tabs.choose(.session("ses_work"))
        #expect(tabs.back(of: .session("ses_work")) == nil)

        // From a group chat, and back to it.
        tabs.open(.group("grp_crew"))
        tabs.go(to: .session("ses_bot"), from: .group("grp_crew"))
        #expect(keys == ["ses_other", "ses_work", "ses_bot"])
        #expect(tabs.back(of: .session("ses_bot")) == .group("grp_crew"))
        tabs.goBack()
        #expect(tabs.selection == .group("grp_crew"))

        // From a conversation that isn't the tab in view: a tab of its own, with no way back.
        tabs.go(to: .session("ses_other"), from: .session("ses_work"))
        #expect(tabs.selection == .session("ses_other"))
        #expect(keys == ["ses_other", "ses_work", "group:grp_crew"], "nothing in another's place")
        #expect(tabs.back(of: .session("ses_other")) == nil)
    }

    /// Opened from another conversation, one that had a tab of its own takes the place of the one
    /// in view: its old tab goes, the session beside it there keeping that tab rather than going
    /// with it. A conversation on the way back that's deleted leaves the way back.
    @Test func aConversationOpenedFromAnotherLeavesNothingBehind() async throws {
        defer { done() }
        await sessions(["ses_bot", "ses_work", "ses_side"])
        engine.on("DELETE", "/api/session/ses_bot", json: [:])
        tabs.open(.session("ses_work"))
        tabs.openBeside("ses_side")
        tabs.open(.session("ses_bot"))
        #expect(keys == ["ses_work", "ses_bot"])

        tabs.go(to: .session("ses_work"), from: .session("ses_bot"))
        #expect(keys == ["ses_side", "ses_work"], "one tab of it, and the session that was beside it kept")
        #expect(tabs.selection == .session("ses_work"))
        #expect(tabs.splitModel == nil)
        #expect(tabs.back(of: .session("ses_work")) == .session("ses_bot"))

        try await app.workspace.delete("ses_bot")
        // (As the window does when the list changes.)
        tabs.dropClosed()
        #expect(tabs.back(of: .session("ses_work")) == nil, "no way back to a conversation that's gone")
        #expect(!tabs.isKept(.session("ses_bot")))
    }

    /// Back to a conversation that's beside another tab since takes it out of that split (never
    /// in a tab and beside one at once); a split swapped keeps its way back with the tab, past the
    /// conversation now in front.
    @Test func backAcrossASplit() async {
        defer { done() }
        await sessions(["ses_bot", "ses_work", "ses_c"])
        tabs.open(.session("ses_c"))
        tabs.open(.session("ses_bot"))
        tabs.go(to: .session("ses_work"), from: .session("ses_bot"))
        tabs.open(.session("ses_c"))
        tabs.openBeside("ses_bot")
        tabs.open(.session("ses_work"))
        #expect(keys == ["ses_c", "ses_work"])

        tabs.goBack()
        #expect(keys == ["ses_c", "ses_bot"])
        #expect(tabs.selection == .session("ses_bot"))
        #expect(tabs.splitModel == nil)
        #expect(!tabs.isOpen(.session("ses_work")))
        tabs.open(.session("ses_c"))
        #expect(tabs.splitModel == nil, "out of the split it was in")

        // The split swapped: the way back goes with the tab.
        tabs.open(.session("ses_bot"))
        tabs.go(to: .session("ses_work"), from: .session("ses_bot"))
        tabs.openBeside("ses_c")
        tabs.swapSplit()
        #expect(tabs.selection == .session("ses_c"))
        #expect(tabs.back(of: .session("ses_c")) == .session("ses_bot"))
        // Swapped with the conversation it came from: none back to itself.
        tabs.goBack()
        tabs.closeBeside(.session("ses_bot"))
        tabs.go(to: .session("ses_work"), from: .session("ses_bot"))
        tabs.openBeside("ses_bot")
        tabs.swapSplit()
        #expect(tabs.selection == .session("ses_bot"))
        #expect(tabs.back(of: .session("ses_bot")) == nil)
    }

    /// ⌘-click on an Open (or its menu's Open in New Tab) opens the conversation in a tab of its
    /// own next to the one in view, with no way back, the one it was opened from staying in its
    /// tab; a plain click opens it in place. View › Back (⌘[) is there while the tab in view has a
    /// way back and nothing covers it.
    @Test func commandClickOpensANewTabAndBackIsInTheMenuWhileThereIsOne() async {
        defer { done() }
        await sessions(["ses_bot", "ses_work"])
        func click(_ flags: NSEvent.ModifierFlags) -> NSEvent? {
            NSEvent.mouseEvent(with: .leftMouseUp, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)
        }
        #expect(AppModel.wantsNewTab(click(.command)))
        #expect(!AppModel.wantsNewTab(click([])))
        #expect(!AppModel.wantsNewTab(click(.option)))
        #expect(!AppModel.wantsNewTab(nil))

        tabs.open(.session("ses_bot"))
        #expect(!tabs.canGoBack)
        app.open(.session("ses_work"), from: .session("ses_bot"), newTab: true)
        #expect(keys == ["ses_bot", "ses_work"], "a tab of its own, next to the bot's")
        #expect(tabs.selection == .session("ses_work"))
        #expect(tabs.back(of: .session("ses_work")) == nil)
        #expect(!tabs.canGoBack)

        tabs.pick(.session("ses_bot"))
        app.open(.session("ses_work"), from: .session("ses_bot"), newTab: false)
        #expect(keys == ["ses_work"], "a plain click: in the bot's place")
        #expect(tabs.canGoBack)
        tabs.openBotEditor(bot: nil)
        #expect(!tabs.canGoBack, "not under an editor")
        tabs.botEditor = nil
        app.showsSettings = true
        #expect(!tabs.canGoBack, "nor under Settings")
        app.showsSettings = false
        tabs.goBack()
        #expect(tabs.selection == .session("ses_bot"))
        #expect(!tabs.canGoBack)
    }

    /// A conversation deleted while one of its subagents shows in its tab (its own subagent's
    /// too): the tab goes with it, rather than showing a subagent of a conversation that's gone.
    @Test func deletingAConversationClosesItsSubagentsTab() async throws {
        defer { done() }
        engine.list([
            StubEngine.session("ses_a", title: "ses_a", directory: folder),
            StubEngine.session("ses_timer", title: "Timer cycle", directory: folder),
            StubEngine.session("ses_find", title: "Find the timer", directory: folder, extra: ["parentID": "ses_timer"]),
            StubEngine.session("ses_deep", title: "Read the slider", directory: folder, extra: ["parentID": "ses_find"]),
        ])
        engine.on("DELETE", "/api/session/ses_timer", json: [:])
        await app.workspace.refresh()
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_timer"))
        tabs.openInPlace("ses_find")
        tabs.openInPlace("ses_deep")
        #expect(keys == ["ses_a", "ses_deep"])

        try await app.workspace.delete("ses_timer")
        // (As the window does when the list changes.)
        tabs.dropClosed()
        #expect(keys == ["ses_a"])
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

    // MARK: New bots and group chats

    /// New Bot (from the sidebar, the menu or a shared bot's file) and New Group Chat start on the
    /// computer whose page the sidebar shows, as if picked under Lives On; on This Mac's page, or
    /// once that page's machine is gone, on this Mac. Editing one keeps it where it is.
    @Test func newBotsAndGroupChatsStartOnTheComputerInView() throws {
        defer {
            done()
            UserDefaults.standard.removeObject(forKey: SidebarBox.inViewKey)
            try? FileManager.default.removeItem(at: Machines.file)
        }
        let machine = app.machines.add("lokum").machine.id
        UserDefaults.standard.set(machine, forKey: SidebarBox.inViewKey)
        tabs.openBotEditor(bot: nil)
        #expect(tabs.botEditor?.machine == machine)
        let recipe = try JSONDecoder().decode(BotRecipe.self, from: Data(#"{"kind":"kuvo-bot","version":1,"name":"Scout","job":"Finds things","instructions":"Finds things.","look":{"color":"mint","shape":"round","face":"calm"}}"#.utf8))
        tabs.openBotEditor(bot: nil, recipe: recipe)
        #expect(tabs.botEditor?.machine == machine && tabs.botEditor?.recipe == recipe, "a shared bot too")
        tabs.openGroupEditor(group: nil)
        #expect(tabs.groupEditor?.machine == machine)

        UserDefaults.standard.set("mac", forKey: SidebarBox.inViewKey)
        tabs.openBotEditor(bot: nil)
        #expect(tabs.botEditor != nil && tabs.botEditor?.machine == nil, "This Mac's page")
        UserDefaults.standard.set("hetzner", forKey: SidebarBox.inViewKey)
        tabs.openGroupEditor(group: nil)
        #expect(tabs.groupEditor != nil && tabs.groupEditor?.machine == nil, "a machine that's gone")
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

    // MARK: The panel always has a tab

    /// A bot on this Mac, as its box lists it.
    private func listBot(session: String) {
        let look = BotLook(color: .sky, shape: .round, face: .happy)
        app.bots.take([ListedBot(id: "bot_ada", session: session, name: "Ada", look: look, folder: "/bots/bot_ada")], from: BoxClient.mac)
    }

    private func forgetBots() {
        try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: "bots.json"))
    }

    /// A bot's conversation that comes back with the window at launch, before this Mac's sessions
    /// are read: its panel has its tab from the first, and still does once they're read. It lost
    /// it there, leaving only the tab bar's + and expand arrows in the middle of the panel.
    @Test func aBotsConversationBackAtLaunchKeepsItsPanelsTab() async {
        defer { done(); forgetBots() }
        listBot(session: "ses_bot")
        tabs.restore(WindowTabs.Saved(tabs: [.session("ses_bot")], selection: .session("ses_bot"), showsPanel: true).text, older: .init())
        panelFollows()
        #expect(app.utilities.visibleTabs.count == 1)

        await sessions(["ses_bot"])
        for start in app.startMachines() { await start.value }
        panelFollows()
        #expect(app.utilities.selected?.kind == .changes, "the tab it opened on")
        #expect(app.utilities.visibleTabs.count == 1)
        #expect(app.utilities.panelKey == "bot_ada", "the bot's panel, as any time after")
    }

    /// A conversation in view that turns out to be a bot's (its box listed it just now): its panel
    /// is the bot's from then on, with the tabs you had, on the one you were looking at.
    @Test func aConversationFoundToBeABotsKeepsItsTabs() async {
        defer { done(); forgetBots() }
        await sessions(["ses_bot"])
        tabs.open(.session("ses_bot"))
        panelFollows()
        let notes = URL(filePath: folder + "/notes.md")
        app.utilities.open(notes)
        let tabsBefore = app.utilities.visibleTabs.map(\.id)
        // What tells the window to look again.
        let told = Told()
        withObservationTracking { _ = tabs.inView } onChange: { told.now = true }

        listBot(session: "ses_bot")
        #expect(told.now, "the window hears of it")
        panelFollows()
        #expect(app.utilities.panelKey == "bot_ada")
        #expect(app.utilities.visibleTabs.map(\.id) == tabsBefore, "the same tabs")
        #expect(app.utilities.selected?.kind == .file(notes), "on the one in view")
    }

    /// A bot carried on in a new session (a coding agent's model): its box lists the new one while
    /// the old one is still in view, then the new one takes its place and the old one is deleted.
    /// Its tabs were its all along: they're there, on the one you were looking at.
    @Test func aBotCarriedOnInANewSessionKeepsItsTabs() async {
        defer { done(); forgetBots() }
        app.followSessions()
        listBot(session: "ses_old")
        await sessions(["ses_old", "ses_new"])
        tabs.open(.session("ses_old"))
        panelFollows()
        let notes = URL(filePath: folder + "/notes.md")
        app.utilities.open(notes)

        listBot(session: "ses_new")
        panelFollows()
        _ = tabs.swap(from: "ses_old", to: "ses_new")
        panelFollows()
        app.workspace.drop("ses_old")
        panelFollows()
        #expect(app.utilities.panelKey == "bot_ada")
        #expect(app.utilities.selected?.kind == .file(notes))
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

    /// A conversation that finishes under Settings, a bot's or group chat's editor, or the
    /// expanded panel isn't seen: it stays new in the sidebar, the tab and the Dock until you look
    /// at it again.
    @Test func aConversationCoveredUpIsntSeen() async {
        defer {
            app.showsSettings = false
            done()
        }
        await sessions(["ses_a"])
        tabs.open(.session("ses_a"))
        #expect(tabs.sessionsSeen == ["ses_a"])

        app.showsSettings = true
        #expect(tabs.sessionsSeen.isEmpty, "under Settings")
        app.showsSettings = false
        tabs.openBotEditor(bot: nil)
        #expect(tabs.sessionsSeen.isEmpty, "under a new bot's editor")
        tabs.botEditor = nil
        tabs.showPanel()
        tabs.panelExpanded = true
        #expect(tabs.sessionsSeen.isEmpty, "under the expanded panel")
        tabs.panelExpanded = false
        #expect(tabs.sessionsSeen == ["ses_a"], "and seen again once uncovered")
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
        carriedByItsBox()
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
        carriedByItsBox()
        tabs.open(.session("ses_a"))
        tabs.openBeside("ses_engine")

        try await app.workspace.moveToAgents("ses_engine", model: ModelRef(id: "sonnet", providerID: "claude-code"))

        #expect(keys == ["ses_a"])
        #expect(tabs.pairs[.session("ses_a")] == "ses_agent")
        #expect(tabs.workedBesideID == "ses_agent", "you go on working in it")
    }

    /// Moved to the coding agents from your iPhone (its box carried it) while it's in a tab here
    /// with something you were writing: the new one takes its tab, and what you wrote goes with it.
    @Test func aSessionMovedFromAPhoneTakesItsTabAndWhatYouWrote() async throws {
        defer {
            done()
            Drafts.shared.remove("ses_engine")
            Drafts.shared.remove("ses_agent")
        }
        // As the app has it (AppModel.startMachines).
        app.followSessions()
        await sessions(["ses_a", "ses_engine"])
        tabs.open(.session("ses_a"))
        tabs.open(.session("ses_engine"))
        Drafts.shared["ses_engine"] = Drafts.Draft(text: "and a font size")
        bridge.list([StubEngine.session("ses_agent", title: "Settings", directory: folder, extra: ["metadata": ["kuvoAgent": "claude"]])])

        // As its box leaves it, read again here.
        await sessions(["ses_a", "ses_engine"], extra: ["ses_engine": ["metadata": ["kuvo.archived": true, "kuvo.carriedTo": "ses_agent"]]])

        try await until { keys == ["ses_a", "ses_agent"] }
        #expect(tabs.selection == .session("ses_agent"))
        #expect(Drafts.shared["ses_agent"].text == "and a font size")
        #expect(Drafts.shared["ses_engine"].isEmpty, "not also left in the archived one")
    }

    /// One with no tab opens in one, as any session does.
    @Test func aSessionMovedWithoutATabOpens() async throws {
        defer { done() }
        await sessions(["ses_engine"])
        engine.conversation("ses_engine", [])
        engine.on("GET", "/api/session/ses_engine", json: ["data": StubEngine.session("ses_engine", directory: folder)])
        carriedByItsBox()

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

    @Test func retiredTerminalTabsAreNotRestored() {
        defer { done() }
        let saved = WindowTabs.Saved(tabs: [.session("terminal:old"), .session("ses_a")], selection: .session("terminal:old"),
                                     pairs: [.init(tab: .session("ses_a"), beside: "terminal:beside")]).text
        tabs.restore(saved, older: .init())
        #expect(tabs.keys == [.session("ses_a")])
        #expect(tabs.selection == .session("ses_a"))
        #expect(tabs.pairs.isEmpty)
        let older = AppModel()
        older.tabs.restore("", older: .init(tabs: "terminal:old\nses_a", selection: "terminal:old"))
        #expect(older.tabs.keys == [.session("ses_a")])
        #expect(older.tabs.selection == .session("ses_a"))
    }

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

    /// The sidebar hidden stays hidden at the next launch, kept with the tabs; one hidden while
    /// it was kept apart (in scene storage of its own) too.
    @Test func theHiddenSidebarStaysHiddenAtTheNextLaunch() {
        let app = AppModel()
        app.tabs.showSidebar(false)
        let next = AppModel()
        next.tabs.restore(app.tabs.saved, older: .init())
        #expect(!next.tabs.showsSidebar)

        let kept = AppModel()
        kept.tabs.restore(WindowTabs.Saved(tabs: [.session("ses_a")]).text, older: .init(showsSidebar: false))
        #expect(!kept.tabs.showsSidebar, "kept the older way")
        let shown = AppModel()
        shown.tabs.restore(WindowTabs.Saved(tabs: [.session("ses_a")], showsSidebar: true).text, older: .init(showsSidebar: false))
        #expect(shown.tabs.showsSidebar)
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

    /// The window's store keeps the project popup (it outlives the window's views): New Project
    /// open with something typed in it stays when a shortcut or a notification asks for the popup
    /// again, and once it's closed, the next one opens.
    @Test func theWindowKeepsTheProjectPopupBeingTypedIn() {
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

    /// Each new session keeps its own panel files.
    @Test func eachNewSessionHasAPanelOfItsOwn() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "KuvoCodeTests-panels-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        defer { done(); try? FileManager.default.removeItem(atPath: folder) }
        let notes = URL(filePath: folder + "/a/notes.md")
        tabs.newSession(in: folder + "/a")
        panelFollows()
        app.utilities.open(notes)
        tabs.newSession(in: folder + "/b")
        panelFollows()
        #expect(!app.utilities.visibleTabs.contains { $0.kind == .file(notes) }, "the other new session's file stays beside it")
        tabs.open(.draft(folder + "/a"))
        panelFollows()
        #expect(app.utilities.visibleTabs.contains { $0.kind == .file(notes) }, "back to the first, its file is there")
    }

}

/// Whether an observed value told of a change.
private nonisolated final class Told: @unchecked Sendable {
    var now = false
}
