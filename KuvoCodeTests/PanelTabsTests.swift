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
        panel.inView = .init(session: nil)
        panel.open(a)
        let chosen = panel.selection
        panel.adoptDraft(as: "ses_new")
        panel.inView = .init(session: "ses_new")
        #expect(panel.visibleTabs.contains { $0.kind == .file(a) })
        #expect(panel.selection == chosen)
    }
}
