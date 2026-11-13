import Foundation
import Testing
@testable import KuvoCode

/// The side panel's tabs: each conversation has its own, the panel always has one, closing the
/// window starts every panel over with a single start tab, and a conversation's tab you chose is
/// the one you find when you come back to it. (Starts with Changes, the default for a test's own
/// settings.)
@MainActor
@Suite struct PanelTabsTests {
    let panel = Utilities()

    init() { TestEnvironment.prepare() }

    private var startTabs: [Utilities.Tab] { panel.visibleTabs.filter { $0.kind == .changes } }

    /// Closing the window while a machine's conversation is in view: one start tab, not two.
    @Test func closingTheWindowOnAMachinesConversationLeavesOneStartTab() {
        panel.inView = .init(session: "ses_remote", place: "my-server")
        panel.closeAll()
        #expect(panel.tabs.filter { $0.kind == .changes && $0.owner == panel.panelKey }.count == 1)
        panel.inView.place = nil
        #expect(startTabs.count == 1)
    }

    @Test func closingTheWindowLeavesOneStartTab() {
        panel.inView = .init(session: "ses_a")
        panel.closeAll()
        #expect(startTabs.count == 1)
    }

    /// Each conversation its own panel, on the tab you left it on.
    @Test func eachConversationKeepsItsTab() {
        panel.inView = .init(session: "ses_a")
        let changes = panel.selection
        panel.showChanges()
        panel.inView = .init(session: "ses_b")
        #expect(startTabs.count == 1)
        #expect(panel.selection != changes)
        panel.inView = .init(session: "ses_a")
        #expect(panel.selection == changes)
    }

    /// The panel always has a tab: closing the last one leaves one in its place.
    @Test func closingTheLastTabLeavesOne() throws {
        panel.inView = .init(session: "ses_a")
        let only = try #require(panel.visibleTabs.first)
        panel.close(only.id)
        #expect(panel.visibleTabs.count == 1)
    }

    /// A group chat showing only a bot's tab (you closed its own), when that bot leaves: the panel
    /// starts over rather than having nothing to show.
    @Test func aGroupChatsPanelStartsOverWhenItsLastBotsTabGoes() throws {
        panel.inView = .init(group: "group:grp_team", bots: ["bot_a"])
        let own = panel.visibleTabs
        panel.newBrowser(owner: "bot_a")
        for tab in own { panel.close(tab.id) }
        #expect(panel.visibleTabs.map(\.owner) == ["bot_a"])
        panel.inView = .init(group: "group:grp_team")
        #expect(panel.selected?.owner == "group:grp_team")
    }

    /// The same, when the bot is deleted: its tab goes first, then it leaves the chat.
    @Test func aGroupChatsPanelStartsOverWhenItsLastBotIsDeleted() throws {
        panel.inView = .init(group: "group:grp_team", bots: ["bot_a"])
        let own = panel.visibleTabs
        panel.newBrowser(owner: "bot_a")
        for tab in own { panel.close(tab.id) }
        panel.closeTabs(of: "bot_a")
        panel.inView = .init(group: "group:grp_team")
        #expect(panel.selected?.owner == "group:grp_team")
    }

    /// A machine's unclaimed page that was all a panel had, taken by another conversation's agent:
    /// the panel starts over.
    @Test func aPanelStartsOverWhenAnAgentTakesTheMachinePageItShowed() throws {
        panel.inView = .init(session: "ses_a", place: "lab")
        let own = panel.visibleTabs
        panel.syncMachinePages("lab", [.init(id: "page_1", title: "Docs", url: "https://example.com")])
        for tab in own { panel.close(tab.id) }
        #expect(panel.visibleTabs.map(\.owner) == [Utilities.unclaimed])
        panel.machinePageActive("lab", page: "page_1", byAgent: true, session: "ses_b")
        #expect(panel.selected?.owner == "ses_a")
    }

    /// A conversation found to belong in a panel that has its own Changes tab (a subagent opened
    /// before it was known to be one): one Changes tab there, and its other tabs alongside.
    @Test func aPanelFoundToBeAnothersHasOneChangesTab() {
        panel.inView = .init(session: "ses_root", panel: "ses_root")
        panel.inView = .init(session: "ses_sub", panel: "ses_sub")
        panel.open(a)
        panel.panelOf = { _ in "ses_root" }
        panel.inView = .init(session: "ses_sub", panel: "ses_root")
        #expect(startTabs.count == 1)
        #expect(panel.visibleTabs.contains { $0.kind == .file(a) })
    }

    /// A subagent of a subagent: the sessions above it arrive one at a time, so its panel is
    /// found to be another's twice over, and its tabs follow both times.
    @Test func aPanelFoundToBeAnothersInTwoStepsKeepsItsTabs() {
        panel.inView = .init(session: "ses_deep", panel: "ses_deep")
        panel.open(a)
        panel.panelOf = { $0 == "ses_deep" ? "ses_find" : $0 }
        panel.inView = .init(session: "ses_deep", panel: "ses_find")
        #expect(panel.visibleTabs.contains { $0.kind == .file(a) })
        panel.panelOf = { _ in "ses_root" }
        panel.inView = .init(session: "ses_deep", panel: "ses_root")
        #expect(panel.visibleTabs.contains { $0.kind == .file(a) })
    }

    /// A group chat has no project: its panel opens on a new tab (browser and tools), never on a
    /// Changes tab saying "No Project", and Show Changes and Show Files don't add one there.
    @Test func aGroupChatsPanelHasNoChangesOrFiles() {
        panel.inView = .init(group: "group:grp_team")
        #expect(!panel.visibleTabs.isEmpty)
        #expect(!panel.visibleTabs.contains { $0.kind == .changes || $0.kind == .file(nil) })
        panel.showChanges()
        panel.showFiles()
        #expect(!panel.visibleTabs.contains { $0.kind == .changes || $0.kind == .file(nil) })
        // A session's panel still opens on Changes.
        panel.inView = .init(session: "ses_a")
        #expect(startTabs.count == 1)
    }

    // MARK: Files

    private let a = URL(filePath: "/tmp/project/a.swift"), b = URL(filePath: "/tmp/project/b.swift")

    /// A file opens in the file tab in view, and one already open is shown, not opened twice.
    @Test func filesOpenInTheFileTab() {
        panel.inView = .init(session: "ses_a")
        panel.open(a)
        panel.open(b)
        #expect(panel.visibleTabs.filter { if case .file = $0.kind { true } else { false } }.count == 1)
        panel.show(b)
        #expect(panel.selected?.kind == .file(b))
        panel.showFiles()
        panel.show(a, isFolder: false)
        #expect(panel.visibleTabs.filter { $0.kind == .file(a) }.count == 1)
        #expect(panel.selected?.kind == .file(a))
    }

    /// A machine's file open in the panel isn't watched: clicking it again (in the tree, in a
    /// reply) reads it again, so what the agent changed since shows.
    @Test func aFileOpenedAgainIsReadAgain() {
        panel.inView = .init(session: "ses_a")
        let file = RemoteFolder.url("ssh://lab/home/ada/web/app.ts")
        panel.open(file)
        let read = panel.fileShown
        panel.open(file)
        #expect(panel.fileShown > read)
        #expect(panel.visibleTabs.filter { $0.kind == .file(file) }.count == 1)
    }

    /// Closing the tab you're on: the one that took its place is selected.
    @Test func closingTheSelectedTabSelectsItsNeighbor() throws {
        panel.inView = .init(session: "ses_a")
        panel.showFiles()
        panel.show(a, isFolder: false)
        let tabs = panel.visibleTabs
        #expect(tabs.count == 3)
        panel.choose(tabs[1].id)
        panel.close(tabs[1].id)
        #expect(panel.selection == tabs[2].id)
    }

    /// A conversation deleted: its tabs go, and no other's.
    @Test func aDeletedConversationsTabsGo() {
        panel.inView = .init(session: "ses_a")
        panel.open(a)
        panel.inView = .init(session: "ses_b")
        panel.open(b)
        panel.closeTabs(of: panel.panelKey)
        #expect(!panel.tabs.contains { $0.kind == .file(b) })
        #expect(panel.tabs.contains { $0.kind == .file(a) })
    }

    /// The tabs you opened while writing a new session's first message are the session's.
    @Test func aNewSessionKeepsItsDraftsTabs() {
        panel.inView = .init(session: nil, draft: "draft:/p")
        panel.open(a)
        let chosen = panel.selection
        panel.adoptDraft("draft:/p", as: "ses_new")
        panel.inView = .init(session: "ses_new")
        #expect(panel.visibleTabs.contains { $0.kind == .file(a) })
        #expect(panel.selection == chosen)
    }

    /// Each new session's draft has a panel of its own: a
    /// terminal opened writing one in project A doesn't show beside one for project B, nor go to
    /// B's session once that's sent.
    @Test func eachDraftHasItsOwnPanel() {
        panel.inView = .init(session: nil, draft: "draft:/a")
        panel.open(a)
        panel.inView = .init(session: nil, draft: "draft:/b")
        #expect(!panel.visibleTabs.contains { $0.kind == .file(a) })
        panel.open(b)
        panel.adoptDraft("draft:/b", as: "ses_b")
        panel.inView = .init(session: "ses_b")
        #expect(panel.visibleTabs.contains { $0.kind == .file(b) })
        #expect(!panel.visibleTabs.contains { $0.kind == .file(a) })
        panel.inView = .init(session: nil, draft: "draft:/a")
        #expect(panel.visibleTabs.contains { $0.kind == .file(a) }, "still A's draft's")
    }

    /// Run again after the draft became its session, or the conversation moved on to another
    /// (the coding agents): the command starts over in the same terminal, not a second copy of it
    /// beside the first (a dev server then finding its port taken).
    @Test func runAgainAfterADraftIsSentOrMovesUsesTheSameTerminal() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "KuvoCodeTests-run-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer {
            panel.closeAll()
            try? FileManager.default.removeItem(at: folder)
        }
        let shell = ["SHELL": "/bin/sh"]
        let terminals = { self.panel.visibleTabs.filter { $0.kind == .terminal }.count }
        panel.inView = .init(session: nil, draft: "draft:\(folder.path)")
        panel.run("true", in: folder.path, environment: shell)
        panel.adoptDraft("draft:\(folder.path)", as: "ses_a")
        panel.inView = .init(session: "ses_a")
        panel.run("true", in: folder.path, environment: shell)
        #expect(terminals() == 1)

        panel.handOver(from: "ses_a", to: "ses_b")
        panel.inView = .init(session: "ses_b")
        panel.run("true", in: folder.path, environment: shell)
        #expect(terminals() == 1)
    }

    /// Run's terminal is named for its command until what runs names itself, as a project's own
    /// terminal is, not for its folder.
    @Test func runsTerminalIsNamedForItsCommand() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "KuvoCodeTests-run-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer {
            panel.closeAll()
            try? FileManager.default.removeItem(at: folder)
        }
        panel.inView = .init(session: "ses_a")
        panel.run("PORT=3000 sleep 60", in: folder.path, environment: ["SHELL": "/bin/sh"])
        let run = try #require(panel.visibleTabs.first { $0.kind == .terminal })
        #expect(panel.terminals[run.id]?.title == "sleep")
    }

    /// A file a bot showed in a group chat, then another opened from the tree beside it, in a
    /// folder there: the tree stays on the first file's folder, so you can go back up.
    @Test func aGroupChatsFileKeepsItsFolderAsYouBrowse() {
        panel.inView = .init(group: "group:grp_team")
        panel.show(URL(filePath: "/tmp/kuvo-tests-group-files/notes.md"), isFolder: false)
        panel.open(URL(filePath: "/tmp/kuvo-tests-group-files/docs/plan.md"))
        #expect(panel.selected?.kind == .file(URL(filePath: "/tmp/kuvo-tests-group-files/docs/plan.md")))
        #expect(panel.selected?.folder == "/tmp/kuvo-tests-group-files")
    }
}
