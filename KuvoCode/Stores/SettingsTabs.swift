import Foundation

/// Settings' tabs, in the title bar, as the sessions have theirs: each a page of Settings on one
/// computer (this Mac, or a machine: each has its own settings), or a site you're signing in to
/// for the agent (Settings › Integrations). A page you open comes in the
/// preview tab, as VS Code's: the one you haven't done anything in yet, which the next page you
/// open takes the place of; doing something in it (a click, typing) keeps it, and the next page
/// gets a tab of its own. A page that's open already has its tab come forward; ⌘-click, or Open
/// in New Tab, opens one more, kept, even then.
/// The pages' tabs are kept for the next time; the sites' close when you leave Settings.
@MainActor
@Observable
final class SettingsTabs {
    /// Signing in to a service on its site: where (this Mac or a machine), and its pages there.
    @MainActor
    @Observable
    final class Site {
        let service: Integrations.Service
        /// "" for this Mac, else a machine's ID.
        var place = ""
        /// Its tabs on this Mac.
        let pages = SignInPages()
        /// The page shown on each machine, by machine.
        var machinePages: [String: String] = [:]
        /// The pages under it, by machine, when a page opened another (a sign-in's popup): the
        /// one to go back to when it closes.
        var machineOpeners: [String: [String]] = [:]
        var opening: String?

        /// A machine's pages changed: a window the page in view opened comes forward, as a
        /// browser shows it, and one that closed gives way to the page that opened it.
        func follow(_ pages: [MachineBrowser.Page], on machine: String) {
            guard let shown = machinePages[machine] else { return }
            let open = Set(pages.map(\.id))
            if let popup = pages.last(where: { $0.opener == shown }) {
                machineOpeners[machine, default: []].append(shown)
                machinePages[machine] = popup.id
            } else if !open.contains(shown), let back = machineOpeners[machine]?.last(where: open.contains) {
                machineOpeners[machine]?.removeAll { $0 == back || !open.contains($0) }
                machinePages[machine] = back
            }
        }

        init(service: Integrations.Service) {
            self.service = service
        }
    }

    struct Tab: Identifiable, Equatable {
        enum Kind: Equatable {
            case page(SettingsPage)
            /// A site, by its service.
            case site(String)
        }

        let id: String
        var kind: Kind
        /// The computer it's about: this Mac, or a machine, with its own settings.
        var box: SidebarBox = .mac

        var page: SettingsPage? {
            if case .page(let page) = kind { return page }
            return nil
        }

        func shows(_ page: SettingsPage, on box: SidebarBox) -> Bool {
            self.page == page && self.box == box
        }
    }

    private(set) var tabs: [Tab] = []
    private(set) var selectedID = ""
    private var sites: [String: Site] = [:]
    /// Where the page's card starts in the window, for the tabs to start there too.
    var contentX: CGFloat = 0
    /// The page tab you were on last, for the sidebar while a site's tab is in view.
    private var lastPageTab = ""
    /// The preview tab: the page you opened last, if you haven't done anything in it, which the
    /// next page you open (or searching finds) takes the place of.
    private(set) var previewTab: String?

    /// The pages' tabs, for the next time: `[{"page": …, "box": …}]` (before boxes, the pages'
    /// names between commas).
    private static let tabsKey = "settings.tabs"
    /// Which of the pages' tabs is the preview tab, for the next time: its place among them (before
    /// boxes, its page and which of that page's tabs it was, "general#1").
    private static let previewKey = "settings.previewTab"
    /// Which of them is in view: its place among them (before boxes, its page, in `storageKey`).
    private static let selectedKey = "settings.selectedTab"

    private struct Saved: Codable {
        var page: String
        var box: String?
    }

    init() {
        let defaults = UserDefaults.standard
        // Only pages Settings still lists (Phone goes while the phone link is off), each where it
        // can be (a machine's own pages on a machine).
        let text = defaults.string(forKey: Self.tabsKey) ?? ""
        let saved: [(page: SettingsPage, box: SidebarBox)] = if text.hasPrefix("[") {
            ((try? JSONDecoder().decode([Saved].self, from: Data(text.utf8))) ?? []).compactMap { saved in
                SettingsPage(rawValue: saved.page).map { ($0, saved.box.map(SidebarBox.init(id:)) ?? .mac) }
            }
        } else {
            text.split(separator: ",").compactMap { SettingsPage(rawValue: String($0)) }.map { ($0, .mac) }
        }
        let kept = saved.filter { $0.page.isShown(on: $0.box) }
        let current = defaults.string(forKey: SettingsPage.storageKey).flatMap(SettingsPage.init).flatMap { SettingsPage.shown.contains($0) ? $0 : nil } ?? kept.first?.page ?? .general
        tabs = (kept.isEmpty ? [(current, .mac)] : kept).map { Tab(id: UUID().uuidString, kind: .page($0.page), box: $0.box) }
        let place = defaults.object(forKey: Self.selectedKey) as? Int
        let selected = place.flatMap { tabs.indices.contains($0) && kept.count == saved.count ? tabs[$0] : nil } ?? tabs.first { $0.shows(current, on: .mac) } ?? tabs[0]
        selectedID = selected.id
        lastPageTab = selected.id
        // The first time, the page Settings opens on is one you've only looked at.
        if kept.isEmpty {
            previewTab = selected.id
        } else if let index = defaults.object(forKey: Self.previewKey) as? Int {
            if tabs.indices.contains(index), kept.count == saved.count { previewTab = tabs[index].id }
        } else if let older = defaults.string(forKey: Self.previewKey) {
            let parts = older.split(separator: "#", maxSplits: 1)
            let same = tabs.filter { $0.page == SettingsPage(rawValue: String(parts[0])) }
            let index = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
            if index < same.count { previewTab = same[index].id }
        }
    }

    var selected: Tab? { tabs.first { $0.id == selectedID } }

    /// The site of the tab in view, if it's a site's.
    var selectedSite: Site? {
        guard case .site(let id) = selected?.kind else { return nil }
        return sites[id]
    }

    func site(_ id: String) -> Site? { sites[id] }

    /// The page the sidebar shows: the one in view, or the one you were on before a site's tab.
    var page: SettingsPage {
        pageTab?.page ?? .general
    }

    /// The computer that page is about.
    var box: SidebarBox {
        pageTab?.box ?? .mac
    }

    private var pageTab: Tab? {
        selected?.page != nil ? selected : tabs.first { $0.id == lastPageTab } ?? tabs.first { $0.page != nil }
    }

    func select(_ id: String) {
        guard let tab = tabs.first(where: { $0.id == id }) else { return }
        selectedID = id
        if tab.page != nil { lastPageTab = id }
        save()
    }

    /// Shows `page` on `box`: its tab, if it's open; else in the preview tab, unless `isBusy` says
    /// it has something open in its page's place (an editor, with what you typed), which stays;
    /// else in a new preview tab, beside the one in view. `inNewTab` (⌘-click) opens one more,
    /// kept. Without the tab bar, there's one page at a time: `page` takes the place of the one in
    /// view. A page a machine doesn't have (one of the app's own) is this Mac's.
    func show(_ page: SettingsPage, on box: SidebarBox = .mac, inNewTab: Bool = false, isBusy: (String) -> Bool = { _ in false }) {
        let box = page.isShown(on: box) ? box : .mac
        if !TabBar.isShown {
            replace(with: page, on: box)
        } else if inNewTab {
            insert(Tab(id: UUID().uuidString, kind: .page(page), box: box))
        } else {
            preview(page, on: box, isBusy: isBusy)
        }
        Analytics.shared.track("settings_opened", ["tab": page.rawValue, "machine": box.machine != nil])
    }

    /// `page` as `show` has it, without counting it as opened: what searching finds first.
    func preview(_ page: SettingsPage, on box: SidebarBox = .mac, isBusy: (String) -> Bool = { _ in false }) {
        let box = page.isShown(on: box) ? box : .mac
        if !TabBar.isShown {
            replace(with: page, on: box)
        } else if let open = tabs.first(where: { $0.shows(page, on: box) }) {
            select(open.id)
        } else if let id = previewTab, !isBusy(id), let index = tabs.firstIndex(where: { $0.id == id && $0.page != nil }) {
            tabs[index].kind = .page(page)
            tabs[index].box = box
            select(id)
        } else {
            insert(Tab(id: UUID().uuidString, kind: .page(page), box: box))
            previewTab = selectedID
            save()
        }
    }

    /// `page` in the tab in view, or in the page's tab when a site's is in view.
    private func replace(with page: SettingsPage, on box: SidebarBox) {
        if let open = tabs.first(where: { $0.shows(page, on: box) }) {
            select(open.id)
        } else if let index = tabs.firstIndex(where: { $0.id == (selected?.page != nil ? selectedID : lastPageTab) }) {
            tabs[index].kind = .page(page)
            tabs[index].box = box
            select(tabs[index].id)
        } else {
            insert(Tab(id: UUID().uuidString, kind: .page(page), box: box))
        }
    }

    /// The tabs of machines that aren't added any more close (one of this Mac's takes the place
    /// of the last).
    func closeTabs(notOn added: Set<String>, machines: Machines) {
        let gone = tabs.filter { $0.box.machine.map { !added.contains($0) } ?? false }
        guard !gone.isEmpty else { return }
        if gone.count == tabs.count { insert(Tab(id: UUID().uuidString, kind: .page(.machines))) }
        for tab in gone { close(tab.id, machines: machines) }
    }

    /// Something was done in the tab in view (a click, typing): it's no longer a preview, and
    /// stays when you open another page.
    func keepSelected() {
        guard previewTab == selectedID else { return }
        previewTab = nil
        save()
    }

    /// Signs in to `service` in a tab of its own (the one there is, if it's open), in the browser
    /// of the computer `box` is.
    func open(_ service: Integrations.Service, on box: SidebarBox = .mac) {
        if let tab = tabs.first(where: { $0.kind == .site(service.id) }) {
            sites[service.id]?.place = box.machine ?? ""
            select(tab.id)
            return
        }
        let site = Site(service: service)
        site.place = box.machine ?? ""
        site.pages.open(service.site)
        sites[service.id] = site
        insert(Tab(id: UUID().uuidString, kind: .site(service.id)))
    }

    /// After the tab in view, and in view.
    private func insert(_ tab: Tab) {
        let index = tabs.firstIndex { $0.id == selectedID }.map { $0 + 1 } ?? tabs.count
        tabs.insert(tab, at: index)
        select(tab.id)
    }

    /// Closes a tab (a site's with its pages, here and on the machines); one is always left.
    func close(_ id: String, machines: Machines) {
        guard tabs.count > 1, let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        let tab = tabs.remove(at: index)
        if previewTab == id { previewTab = nil }
        if case .site(let service) = tab.kind, let site = sites.removeValue(forKey: service) {
            for (machine, page) in site.machinePages { machines.engine(machine)?.browser.close(page) }
            site.pages.closeAll()
        }
        if selectedID == id {
            // The page you were on, if a site's tab closes; otherwise the neighbor, as browsers do.
            let back = tab.page == nil ? tabs.first { $0.id == lastPageTab } : nil
            select((back ?? tabs[min(index, tabs.count - 1)]).id)
        }
        if lastPageTab == id { lastPageTab = tabs.first { $0.page != nil }?.id ?? "" }
        save()
    }

    func closeOthers(than id: String?, machines: Machines) {
        for tab in tabs where tab.id != id { close(tab.id, machines: machines) }
    }

    /// Leaving Settings: the sites you were signing in to close.
    func closeSites(machines: Machines) {
        if !tabs.contains(where: { $0.page != nil }) { insert(Tab(id: UUID().uuidString, kind: .page(page), box: box)) }
        for tab in tabs where tab.page == nil { close(tab.id, machines: machines) }
    }

    func cycle(by offset: Int) {
        guard let index = tabs.firstIndex(where: { $0.id == selectedID }) else { return }
        select(tabs[(index + offset + tabs.count) % tabs.count].id)
    }

    /// ⌘1 to ⌘8 show that tab, ⌘9 the last.
    func show(number: Int) {
        let index = number == 9 ? tabs.count - 1 : number - 1
        if tabs.indices.contains(index) { select(tabs[index].id) }
    }

    /// The pages' tabs, for the next time, with the one in view and the preview, and the page in
    /// view, as Settings has always kept it.
    private func save() {
        let defaults = UserDefaults.standard
        let pages = tabs.filter { $0.page != nil }
        let saved = pages.compactMap { tab in tab.page.map { Saved(page: $0.rawValue, box: tab.box.machine) } }
        defaults.set((try? JSONEncoder().encode(saved)).map { String(decoding: $0, as: UTF8.self) } ?? "", forKey: Self.tabsKey)
        defaults.set(page.rawValue, forKey: SettingsPage.storageKey)
        defaults.set(pages.firstIndex { $0.id == pageTab?.id }, forKey: Self.selectedKey)
        defaults.set(pages.firstIndex { $0.id == previewTab }, forKey: Self.previewKey)
    }
}
