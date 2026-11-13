import Foundation
import Testing
@testable import KuvoCode

/// Settings' tabs, as VS Code's (K1): a page you open comes in the preview tab, which the next
/// page takes the place of; doing something in a page keeps its tab, and the next page gets one
/// of its own; a page that's open already comes forward; ⌘-click opens one more, kept; a page with
/// something open in it (an editor, with what you typed) isn't replaced. The tabs, the page in
/// view and which is the preview are there the next time Settings opens. Each computer has its
/// own settings: a machine's page is a tab of its own, beside this Mac's, and goes when the
/// machine does; the app's own pages are this Mac's.
@MainActor
@Suite(.serialized) struct SettingsTabsTests {
    init() {
        TestEnvironment.prepare()
        for key in ["settings.tabs", "settings.previewTab", "settings.selectedTab", SettingsPage.storageKey] { UserDefaults.standard.removeObject(forKey: key) }
        // Tabs are for the tab bar, which you turn on.
        UserDefaults.standard.set(true, forKey: TabBar.showsKey)
    }

    /// Without the tab bar (as it starts), Settings shows one page at a time: each page you open
    /// takes the place of the one in view, ⌘-click included.
    @Test func withoutTheTabBarOnePageAtATime() {
        UserDefaults.standard.removeObject(forKey: TabBar.showsKey)
        defer { UserDefaults.standard.set(true, forKey: TabBar.showsKey) }
        let tabs = SettingsTabs()
        tabs.show(.accounts)
        tabs.keepSelected()
        tabs.show(.machines)
        #expect(pages(tabs) == [.machines], "even after you worked in a page")
        tabs.show(.git, inNewTab: true)
        #expect(pages(tabs) == [.git])
        #expect(tabs.page == .git)
    }

    private func pages(_ tabs: SettingsTabs) -> [SettingsPage?] { tabs.tabs.map(\.page) }

    /// This Mac's pages follow its box (#333): attached to the box already here, the tabs it had on
    /// this Mac are that box's, and a page opened with no computer given (General, ⌘,) is too,
    /// with this Mac's own pages still listed there; they're kept as this Mac's for the next time.
    @Test func thisMacsTabsFollowItsBox() {
        let tabs = SettingsTabs()
        tabs.show(.accounts)
        tabs.keepSelected()
        tabs.thisMac = .attached
        #expect(tabs.box == .attached && tabs.tabs.allSatisfy { $0.box == .attached })
        tabs.show(.general)
        #expect(tabs.page == .general && tabs.box == .attached, "the app's own pages are this Mac's, on its box")
        #expect(SettingsPage.shown(on: .attached).contains(.machines) && SettingsPage.shown(on: .attached).contains(.accounts))
        #expect(!SettingsPage.shown(on: .machine("devbox")).contains(.general), "a machine has its box's pages only")
        let again = SettingsTabs()
        #expect(pages(again) == [.accounts, .general] && again.tabs.allSatisfy { $0.box == .mac }, "kept as this Mac's")
    }

    @Test func pagesTakeThePreviewTabUntilYouWorkInOne() {
        let tabs = SettingsTabs()
        #expect(pages(tabs) == [.general], "the first time: General, only looked at")

        tabs.show(.accounts)
        #expect(pages(tabs) == [.accounts], "it takes the preview tab's place")

        tabs.keepSelected()  // You connected an account there.
        tabs.show(.machines)
        #expect(pages(tabs) == [.accounts, .machines], "the one you worked in stays; the next gets a tab beside it")
        tabs.show(.git)
        #expect(pages(tabs) == [.accounts, .git])

        tabs.show(.accounts)
        #expect(pages(tabs) == [.accounts, .git], "an open page comes forward, no second tab")
        #expect(tabs.page == .accounts)

        tabs.show(.accounts, inNewTab: true)
        #expect(pages(tabs) == [.accounts, .accounts, .git], "⌘-click opens one more, beside the one in view")
    }

    /// An editor open in the preview tab, with what you typed: the next page doesn't take its place.
    @Test func aPageWithAnEditorOpenIsntReplaced() {
        let tabs = SettingsTabs()
        tabs.show(.agents)
        tabs.show(.commands, isBusy: { _ in true })
        #expect(pages(tabs) == [.agents, .commands])
    }

    @Test func theyreThereTheNextTime() {
        let tabs = SettingsTabs()
        tabs.show(.accounts)
        tabs.keepSelected()
        tabs.show(.panel)
        tabs.show(.storage)
        let again = SettingsTabs()
        #expect(pages(again) == [.accounts, .storage])
        #expect(again.page == .storage, "on the page you were on")
        again.show(.browser)
        #expect(pages(again) == [.accounts, .browser], "and Storage was still only a preview")
    }

    @Test func closingLeavesOneAndShowsItsNeighbor() throws {
        let tabs = SettingsTabs()
        tabs.show(.accounts)
        tabs.keepSelected()
        tabs.show(.machines)
        tabs.keepSelected()
        tabs.show(.git)
        tabs.keepSelected()
        tabs.select(try #require(tabs.tabs.first { $0.page == .machines }).id)
        let machines = Machines()
        tabs.close(tabs.selectedID, machines: machines)
        #expect(pages(tabs) == [.accounts, .git])
        #expect(tabs.page == .git, "the neighbor, as browsers do")
        tabs.closeOthers(than: nil, machines: machines)
        #expect(tabs.tabs.count == 1, "one is always left")
    }

    private func places(_ tabs: SettingsTabs) -> [String] {
        tabs.tabs.map { "\($0.page?.rawValue ?? "site")@\($0.box.id)" }
    }

    @Test func aMachinesPageIsATabOfItsOwnBesideThisMacs() {
        let tabs = SettingsTabs()
        tabs.show(.permissions)
        tabs.keepSelected()
        tabs.show(.permissions, on: .machine("me@lab"))
        #expect(places(tabs) == ["permissions@mac", "permissions@me@lab"], "the same page, each computer's")
        #expect(tabs.page == .permissions && tabs.box == .machine("me@lab"))
        tabs.keepSelected()
        tabs.show(.permissions)
        #expect(tabs.box == .mac, "this Mac's comes forward, no second tab")
        #expect(tabs.tabs.count == 2)

        // A page only this Mac has (the app's own) asked for on a machine: this Mac's.
        tabs.show(.appearance, on: .machine("me@lab"))
        #expect(tabs.page == .appearance && tabs.box == .mac)
    }

    @Test func theyComeBackWithTheirComputers() {
        let tabs = SettingsTabs()
        tabs.show(.agents, on: .machine("lab"))
        tabs.keepSelected()
        tabs.show(.engine)
        tabs.keepSelected()
        tabs.show(.mcp, on: .machine("lab"))
        tabs.select(tabs.tabs[1].id)
        let again = SettingsTabs()
        #expect(places(again) == ["agents@lab", "engine@mac", "mcp@lab"])
        #expect(again.page == .engine && again.box == .mac, "on the tab you were on")
        again.show(.commands, on: .machine("lab"))
        #expect(places(again) == ["agents@lab", "engine@mac", "commands@lab"], "and the last was still only a preview")
    }

    /// As an older version kept them: the pages' names, between commas.
    @Test func tabsKeptBeforeComputersHadTheirOwnStillOpen() {
        UserDefaults.standard.set("accounts,storage", forKey: "settings.tabs")
        UserDefaults.standard.set(SettingsPage.storage.rawValue, forKey: SettingsPage.storageKey)
        UserDefaults.standard.set("storage#0", forKey: "settings.previewTab")
        let tabs = SettingsTabs()
        #expect(places(tabs) == ["accounts@mac", "storage@mac"])
        #expect(tabs.page == .storage)
        tabs.show(.browser)
        #expect(places(tabs) == ["accounts@mac", "browser@mac"], "Storage was only a preview")
    }

    @Test func aMachineRemovedTakesItsTabs() {
        let tabs = SettingsTabs()
        tabs.show(.agents, on: .machine("lab"))
        tabs.keepSelected()
        tabs.show(.permissions, on: .machine("other"))
        tabs.keepSelected()
        let machines = Machines()
        tabs.closeTabs(notOn: ["other"], machines: machines)
        #expect(places(tabs) == ["permissions@other"])
        tabs.closeTabs(notOn: [], machines: machines)
        #expect(places(tabs) == ["machines@mac"], "one of this Mac's takes the last one's place")
    }
}
