import AppKit
import OpenCodeKit
import SwiftUI

/// Settings, in the main window in place of the sessions: a sidebar of pages in groups, with a
/// search field, on the window's glass where the sessions' sidebar was, and the open page in a
/// card beside it, under its title, the way a session shows. Each computer (this Mac, each
/// machine) has its own settings: the sidebar pages through them as the sessions' does, and each
/// tab is a page of one of them.
struct SettingsView: View {
    /// The sessions' sidebar width, so the window keeps its shape.
    var sidebarWidth: CGFloat = 280
    /// How narrow and wide the sidebar can be dragged, and what to keep: the sessions' sidebar
    /// width, the same one.
    var sidebarRange: ClosedRange<Double> = 220...440
    var resizeSidebar: (Double) -> Void = { _ in }
    /// Room above the sidebar's first row for the window's buttons, when they sit there.
    var topInset: CGFloat = 0
    /// Back to the sessions.
    let close: () -> Void

    @State private var search = ""
    /// Each tab's way back from what its page opened in its place.
    @State private var navigators = SettingsNavigators()
    @Environment(\.colorScheme) private var scheme
    @Environment(AppModel.self) private var app

    private var tabs: SettingsTabs { app.settingsTabs }

    var body: some View {
        HStack(spacing: 0) {
            // A tab with an editor open keeps it, and what's typed in it.
            SettingsSidebar(page: tabs.page, box: tabs.box, search: $search) { page, box in
                withAnimation(.ui) { tabs.show(page, on: box) { navigators[$0]?.detail != nil } }
            } openInNewTab: { page, box in
                withAnimation(.ui) { tabs.show(page, on: box, inNewTab: true) }
            } preview: { page, box in
                withAnimation(.ui) { tabs.preview(page, on: box) { navigators[$0]?.detail != nil } }
            }
                .padding(.top, topInset)
                .frame(width: sidebarWidth)
            PaneResizer(width: Binding(get: { sidebarWidth }, set: resizeSidebar), range: sidebarRange, side: .leading)
            // Every tab, kept as it is while another is in view (where you'd scrolled to, what
            // you'd typed, a page you're signing in on), as a browser keeps its tabs.
            ZStack {
                ForEach(tabs.tabs) { tab in
                    let isShown = tab.id == tabs.selectedID
                    Group {
                        switch tab.kind {
                        case .page(let page):
                            let navigator = navigators[tab.id, page, tab.box]
                            VStack(alignment: .leading, spacing: 0) {
                                SettingsPageHeader(page: page, box: tab.box, navigator: navigator)
                                BoxPage(page: page, box: tab.box)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                                    .environment(\.settingsNavigator, navigator)
                            }
                            .frame(maxWidth: SettingsMetrics.columnWidth)
                            .modifier(SettingsColumnInset())
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .id("\(page.rawValue)@\(tab.box.id)")
                        case .site(let id):
                            // A site you're signing in to: the whole card is its.
                            if let site = tabs.site(id) {
                                SiteSignInPage(site: site) {
                                    withAnimation(.ui) { tabs.close(tab.id, machines: app.machines) }
                                }
                            }
                        }
                    }
                    .opacity(isShown ? 1 : 0)
                    .allowsHitTesting(isShown)
                    // Nor keys: Return is for the editor in view, not one in another tab.
                    .disabled(!isShown)
                    .accessibilityHidden(!isShown)
                }
            }
            // Its own width whatever a page asks for: a page wider than the window is cut off
            // rather than pushing the sidebar out of the window.
            .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
            // On a solid card, not the glass: text in its own colors. Vibrant (as the window's
            // material makes it), black text came out a washed-out gray on white.
            .environment(\.backgroundMaterial, nil)
            .background(WindowXReader { tabs.contentX = $0 })
            // Doing something in the page in view keeps its tab (see `SettingsTabs`).
            .background(InteractionWatcher { tabs.keepSelected() })
            .background(Surface.cardFill(scheme, focused: true), in: .rect(cornerRadius: Metrics.cardRadius))
            .clipShape(.rect(cornerRadius: Metrics.cardRadius))
            .specularRim(RoundedRectangle(cornerRadius: Metrics.cardRadius))
            .shadow(color: .black.opacity(scheme == .dark ? 0.3 : 0.06), radius: 6, y: 1)
        }
        // Escape goes back: to the page, from what it opened in its place; else to the sessions.
        .background {
            Button("Back to Sessions") {
                if navigators[tabs.selectedID]?.back() != true { close() }
            }
                .keyboardShortcut(.escape, modifiers: [])
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
        .onAppear { Analytics.shared.track("settings_opened", ["tab": tabs.page.rawValue]) }
        // A closed tab's way back goes with it.
        .onChange(of: tabs.tabs.map(\.id)) { _, ids in navigators.keep(ids) }
    }
}

/// Each Settings tab's navigator, made the first time the tab's drawn.
private final class SettingsNavigators {
    private var byTab: [String: (page: SettingsPage, box: SidebarBox, navigator: SettingsNavigator)] = [:]

    /// The tab's navigator, for the page it's on: a tab that searching moves to another page (or
    /// another computer's) starts afresh, as its page does, with no way back to what the last page
    /// had open.
    subscript(tab: String, page: SettingsPage, box: SidebarBox) -> SettingsNavigator {
        if let kept = byTab[tab], kept.page == page, kept.box == box { return kept.navigator }
        let navigator = SettingsNavigator()
        byTab[tab] = (page, box, navigator)
        return navigator
    }

    /// The tab's navigator, once it's been drawn.
    subscript(tab: String) -> SettingsNavigator? {
        byTab[tab]?.navigator
    }

    func keep(_ tabs: [String]) {
        byTab = byTab.filter { tabs.contains($0.key) }
    }
}

/// The title bar's way back from Settings to the sessions.
struct SettingsBackButton: View {
    let close: () -> Void

    var body: some View {
        Button(action: close) {
            Image(systemName: "chevron.backward")
                .font(.system(size: 14, weight: .medium))
        }
        .buttonStyle(IconButtonStyle(width: 28, height: 28, cornerRadius: 7))
        .accessibilityLabel("Back to Sessions")
        .help("Back to Sessions (Esc)")
    }
}

/// A page of Settings: where it sits in the sidebar, what it's called, and what it shows.
enum SettingsPage: String, CaseIterable, Identifiable {
    /// The open page, in UserDefaults; its values are the pages' raw values.
    static let storageKey = "settings.tab"

    case general, appearance, notifications, shortcuts, phone
    case accounts, auto, usage
    case agents, permissions, commands, skills, integrations, mcp, engine
    case git, worktrees, machines
    case panel, browser, passwords
    case privacy, storage, archived

    var id: String { rawValue }

    /// The pages Settings lists: Phone only while the phone link is switched on.
    static var shown: [SettingsPage] {
        allCases.filter { $0 != .phone || PhoneLink.isEnabled }
    }

    /// The pages each computer has of its own, a machine as this Mac: its engine's settings, its
    /// accounts and its models. The rest are the app's, on this Mac.
    static let boxPages: [SettingsPage] = [.accounts, .auto, .agents, .permissions, .commands, .skills, .integrations, .mcp, .engine, .worktrees]

    /// The pages Settings lists for `box`.
    static func shown(on box: SidebarBox) -> [SettingsPage] {
        box.machine == nil ? shown : shown.filter(boxPages.contains)
    }

    func isShown(on box: SidebarBox) -> Bool {
        Self.shown(on: box).contains(self)
    }

    enum Group: String, CaseIterable {
        case app = "Application"
        case models = "Models & Providers"
        case agent = "Agents & Tools"
        case projects = "Projects"
        case panel = "Side Panel"
        case data = "Privacy & Data"
    }

    var group: Group {
        switch self {
        case .general, .appearance, .notifications, .shortcuts, .phone: .app
        case .accounts, .auto, .usage: .models
        case .agents, .permissions, .commands, .skills, .integrations, .mcp, .engine: .agent
        case .git, .worktrees, .machines: .projects
        case .panel, .browser, .passwords: .panel
        case .privacy, .storage, .archived: .data
        }
    }

    var title: String {
        switch self {
        case .general: "General"
        case .appearance: "Appearance"
        case .notifications: "Notifications"
        case .phone: "Phone"
        case .shortcuts: "Keyboard Shortcuts"
        case .privacy: "Privacy"
        case .storage: "Storage"
        case .accounts: "Accounts"
        case .auto: "Custom Auto"
        case .usage: "Usage"
        case .agents: "Agents"
        case .permissions: "Permissions"
        case .commands: "Commands"
        case .skills: "Skills"
        case .integrations: "Integrations"
        case .mcp: "MCP Servers"
        case .engine: "Engine"
        case .git: "Git"
        case .worktrees: "Worktrees"
        case .archived: "Archived Sessions"
        case .machines: "Machines"
        case .panel: "Panel"
        case .browser: "Browser"
        case .passwords: "Passwords"
        }
    }

    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .appearance: "paintpalette"
        case .notifications: "bell"
        case .phone: "iphone"
        case .shortcuts: "command"
        case .privacy: "hand.raised"
        case .storage: "internaldrive"
        case .accounts: "person.crop.circle"
        case .auto: "list.number"
        case .usage: "gauge.with.dots.needle.50percent"
        case .agents: "person.2"
        case .permissions: "checkmark.shield"
        case .commands: "slash.circle"
        case .skills: "graduationcap"
        case .integrations: "square.grid.3x3.square"
        case .mcp: "puzzlepiece.extension"
        case .engine: "cpu"
        case .git: "arrow.triangle.branch"
        case .worktrees: "square.stack.3d.up"
        case .archived: "archivebox"
        case .machines: "server.rack"
        case .panel: "sidebar.right"
        case .browser: "safari"
        case .passwords: "key"
        }
    }

    /// The line under the page's title.
    var subtitle: String? {
        switch self {
        case .general: nil
        case .appearance: "How Kuvo Code looks, and how conversations read."
        case .notifications: "What Kuvo Code tells you while you're in another app."
        case .phone: "Your sessions on your iPhone, from anywhere."
        case .shortcuts: "Every keyboard shortcut in Kuvo Code."
        case .privacy: "What Kuvo Code shares, and what stays on this Mac."
        case .storage: "What Kuvo Code keeps on this Mac."
        case .accounts: "Model providers you use, with a subscription or an API key."
        case .auto: "Models to switch through when one reaches a usage limit."
        case .usage: nil
        case .agents: "The agents you pick in the composer, and their subagents."
        case .permissions: "What the agent may do without asking first."
        case .commands: "Prompts you run by typing / and their name."
        case .skills: "Instructions and scripts the agent loads when a task calls for them."
        case .integrations: "Your mail, calendar, chats and tools, for agents and bots."
        case .mcp: "Programs and services that give the agent more tools."
        case .engine: nil
        case .git: "Branches, commits and pull requests made from Kuvo Code."
        case .worktrees: "Folders of their own for sessions that work on a branch."
        case .archived: "Sessions you put away: still searchable, out of the sidebar."
        case .machines: "Linux servers whose sessions run there, over SSH."
        case .panel: "What the side panel starts with, and its new tab page."
        case .browser: "The panel's browser: search, history and website data."
        case .passwords: "Sign-ins the panel's browser saved, in your Keychain."
        }
    }

    /// More words search finds the page by.
    var keywords: String {
        switch self {
        case .general: "tab bar updates editor open files with startup"
        case .appearance: "dark light mode theme accent color font text size glass solid window sidebar computers machines switch dock swipe"
        case .notifications: "alerts sound dock badge"
        case .phone: "iphone mobile pair qr relay companion"
        case .shortcuts: "keys keyboard hotkeys"
        case .privacy: "analytics anonymous usage data"
        case .storage: "disk space size clean up delete old sessions logs cache"
        case .accounts: "providers sign in api key login models openai anthropic copilot"
        case .auto: "auto fallback failover rate usage limit order chain switch models lists presets"
        case .usage: "limits spend menu bar plan"
        case .agents: "modes build plan subagents default model title"
        case .permissions: "allow ask deny approve rules"
        case .commands: "slash prompts"
        case .skills: "skills github library"
        case .integrations: "integrations gmail calendar slack github discord telegram mail chat social"
        case .mcp: "servers tools model context protocol"
        case .engine: "opencode shell web search plugins summarize formatter limits settings file"
        case .git: "branch prefix commit message pull request pr"
        case .worktrees: "worktree branches folders"
        case .archived: "archive restore unarchive delete"
        case .machines: "remote ssh server vps linux"
        case .panel: "side panel new tab page tools suggestions"
        case .browser: "search engine history cookies website data sites"
        case .passwords: "logins sign in keychain autofill"
        }
    }

    func matches(_ query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return true }
        return "\(title) \(subtitle ?? "") \(keywords)".localizedCaseInsensitiveContains(query)
    }

    @MainActor @ViewBuilder var content: some View {
        switch self {
        case .general: GeneralSettings()
        case .appearance: AppearanceSettings()
        case .notifications: NotificationSettings()
        case .phone: PhoneSettings()
        case .shortcuts: ShortcutsSettings()
        case .privacy: PrivacySettings()
        case .storage: StorageSettings()
        case .accounts: ProvidersView()
        case .auto: AutoSettings()
        case .usage: UsageSettings()
        case .agents: AgentsSettings()
        case .permissions: PermissionsSettings()
        case .commands: CommandsSettings()
        case .skills: SkillsSettings()
        case .integrations: IntegrationsSettings()
        case .mcp: MCPSettings()
        case .engine: EngineSettings()
        case .git: GitSettings()
        case .worktrees: WorktreesSettings()
        case .archived: ArchivedSessionsSettings()
        case .machines: MachinesSettings()
        case .panel: PanelSettingsView()
        case .browser: BrowserSettings()
        case .passwords: PasswordsSettings()
        }
    }
}

/// The pages, by group, with a search field that finds them on every computer: drawn like the
/// sessions' sidebar it stands in for, its rows lined up under the window's buttons. With
/// machines, each computer's pages are a page of the sidebar of their own, switched as the
/// sessions' are, and the one in view follows the tab in view.
private struct SettingsSidebar: View {
    /// The page in view, and the computer it's about.
    let page: SettingsPage
    let box: SidebarBox
    @Binding var search: String
    let open: (SettingsPage, SidebarBox) -> Void
    /// ⌘-click, or Open in New Tab: the page in one more tab, even with one open already.
    let openInNewTab: (SettingsPage, SidebarBox) -> Void
    /// What searching finds first, in the tab searching keeps for it.
    let preview: (SettingsPage, SidebarBox) -> Void
    @Environment(AppModel.self) private var app
    @AppStorage(TabBar.showsKey) private var showsTabBar = TabBar.showsByDefault
    /// The computer whose pages are in view: the tab's, until you switch to another.
    @State private var shownBox = SidebarBox.mac

    private var boxes: [SidebarBox] { app.boxes }

    private var shownBinding: Binding<SidebarBox> {
        Binding { boxes.contains(shownBox) ? shownBox : .mac } set: { shownBox = $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Settings")
                .font(.system(size: 20, weight: .bold))
                .padding(.horizontal, 10)
                .frame(height: SidebarMetrics.rowHeight)
            SidebarSearchRow(text: $search)
            if boxes.count > 1, search.isEmpty {
                BoxSwitchLine(boxes: boxes, selected: shownBinding)
                    .padding(.top, 8)
            }
            if !search.isEmpty {
                ScrollView {
                    results
                        .padding(.bottom, 12)
                }
                .scrollIndicators(.never)
                .fadingScrollEdges()
            } else if boxes.count > 1 {
                BoxPager(boxes: boxes, selected: shownBinding) { box in
                    pages(of: box)
                }
            } else {
                pages(of: .mac)
            }
        }
        .padding(.top, 10)
        // A tab on another computer: its pages slide in, so what's in view has its row in sight.
        .onChange(of: box, initial: true) { old, box in
            guard box != shownBox else { return }
            if old == box { shownBox = box } else { withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { shownBox = box } }
        }
        // Searching opens the first page it finds: on the computer in view, if it has one.
        .onChange(of: search) {
            guard !search.isEmpty else { return }
            let found = boxes.map { ($0, SettingsPage.shown(on: $0).filter { $0.matches(search) }) }
            let here = found.first { $0.0 == shownBox && !$0.1.isEmpty } ?? found.first { !$0.1.isEmpty }
            if let (box, pages) = here, !(box == self.box && pages.contains(page)), let first = pages.first { preview(first, box) }
        }
    }

    /// One computer's pages, by group.
    private func pages(of box: SidebarBox) -> some View {
        ScrollViewReader { reader in
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    if boxes.count > 1 { BoxHeading(box: box) }
                    let pages = SettingsPage.shown(on: box)
                    ForEach(SettingsPage.Group.allCases, id: \.self) { group in
                        let members = pages.filter { $0.group == group }
                        if !members.isEmpty {
                            groupTitle(group.rawValue, first: group == pages.first?.group)
                            ForEach(members) { page in
                                row(page, on: box)
                            }
                        }
                    }
                }
                .padding(.bottom, 12)
            }
            .scrollIndicators(.never)
            .fadingScrollEdges()
            // The page in view is always in sight: opened from elsewhere (a link, ⌘K), or as
            // Settings open on it.
            .onChange(of: page, initial: true) { _, page in
                guard box == self.box else { return }
                Task {
                    await Task.yield()
                    withAnimation(.ui) { reader.scrollTo(page) }
                }
            }
        }
    }

    /// What searching finds, on each computer.
    @ViewBuilder private var results: some View {
        let found = boxes.map { box in (box, SettingsPage.shown(on: box).filter { $0.matches(search) }) }.filter { !$0.1.isEmpty }
        VStack(alignment: .leading, spacing: 1) {
            if found.isEmpty {
                Text("No Results")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
            }
            ForEach(found, id: \.0) { box, pages in
                if boxes.count > 1 { groupTitle(app.name(of: box), first: box == found.first?.0) }
                ForEach(pages) { page in
                    row(page, on: box)
                }
            }
        }
    }

    private func groupTitle(_ title: String, first: Bool) -> some View {
        Text(title)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .frame(height: 22)
            .padding(.leading, 10)
            .padding(.top, first ? 8 : 16)
            .padding(.bottom, 4)
    }

    private func row(_ page: SettingsPage, on box: SidebarBox) -> some View {
        Button {
            if NSEvent.modifierFlags.contains(.command) { openInNewTab(page, box) } else { open(page, box) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: page.symbol)
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: SidebarMetrics.iconWidth)
                Text(page.title)
                    .font(.system(size: 14))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: SidebarMetrics.rowHeight)
            .modifier(RowHighlight(isSelected: page == self.page && box == self.box))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .contextMenu {
            // Without the tab bar, one page at a time.
            if showsTabBar {
                Button("Open in New Tab") { openInNewTab(page, box) }
            }
        }
        .id(page)
    }
}

/// A page's title, large, and the line under it; or, for something the page opened in its
/// place, its name under the way back to the page.
private struct SettingsPageHeader: View {
    let page: SettingsPage
    let box: SidebarBox
    let navigator: SettingsNavigator
    @Environment(\.settingsInset) private var inset
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // With machines, whose settings these are: each computer has its own.
            if app.boxes.count > 1, navigator.detail == nil, SettingsPage.boxPages.contains(page) {
                Label(app.name(of: box), systemImage: box.symbol)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let detail = navigator.detail {
                Button {
                    navigator.back()
                } label: {
                    Label(page.title, systemImage: "chevron.backward")
                        .font(.system(size: 14, weight: .medium))
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .help("Back to \(page.title) (Esc)")
                if let title = detail.title {
                    Text(title)
                        .font(.system(size: 26, weight: .bold))
                        .lineLimit(2)
                        .transition(.opacity)
                }
            } else {
                Text(page.title)
                    .font(.system(size: 26, weight: .bold))
                if let subtitle = page.subtitle {
                    Text(subtitle)
                        .settingsText()
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, inset)
        .padding(.top, 26)
        .padding(.bottom, 4)
    }
}

/// A page of one computer's settings: with its settings, models, engine and coding agents in
/// the environment. A machine's are read from it as its page opens; until then, or while it
/// can't be reached, the page says so, with the way to connect it or start its engine.
private struct BoxPage: View {
    let page: SettingsPage
    let box: SidebarBox
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if let machine = box.machine {
                if let engine = app.machines.engine(machine) {
                    if engine.config.isLoaded {
                        content
                    } else {
                        Unread(engine: engine)
                    }
                } else {
                    ContentUnavailableView("This Machine Was Removed", systemImage: "server.rack")
                }
            } else {
                content
            }
        }
    }

    private var content: some View {
        page.content
            .environment(\.settingsBox, box)
            .environment(app.catalog(for: box))
            .environment(\.agentsBridge, box.machine == nil ? nil : app.agents(for: box))
            // With other computers: a change here can be made there too. (Above the page's foot,
            // which scrolls up from under it.)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if app.boxes.count > 1 { AlsoApplyBar(box: box) }
            }
    }

    /// A machine's settings, not read yet: read now, or why they can't be.
    private struct Unread: View {
        let engine: MachineEngine
        @Environment(AppModel.self) private var app

        var body: some View {
            VStack(spacing: 14) {
                if let problem = engine.config.problem {
                    Image(systemName: "server.rack")
                        .font(.system(size: 28))
                        .foregroundStyle(.secondary)
                    Text("\(engine.machine.name)’s settings can’t be read")
                        .font(.system(size: 15, weight: .semibold))
                    Text(problem)
                        .settingsText()
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 420)
                    HStack(spacing: 10) {
                        Button("Try Again") { engine.config.reload() }
                        if !engine.isReady, !engine.connection.isUnderWay {
                            Button(engine.isStopped ? "Start" : "Connect") { app.connectOrStart(engine) }
                        }
                    }
                } else {
                    Spinner()
                    Text("Reading \(engine.machine.name)’s settings…")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.bottom, 60)
            // Read as the page opens, and again once it's reached.
            .task(id: engine.isReady) {
                if !engine.config.isLoaded, engine.config.problem == nil || engine.isReady { engine.config.reload() }
            }
        }
    }
}

/// After you change something on one computer's page, with others to change too: the way to
/// make the same change on them ("Also Apply to…"), quiet, at the page's foot, until you're done
/// with it. Each computer keeps its own settings, and this is the one way a change goes to another.
private struct AlsoApplyBar: View {
    let box: SidebarBox
    @Environment(AppModel.self) private var app
    /// The changes already dealt with (or made before the page opened), by the last one's number.
    @State private var seen: Int?
    @State private var applying: String?
    @State private var applied: String?
    @State private var failure: String?

    private var config: EngineConfig { app.config(for: box) }
    private var fresh: [EngineConfig.Change] { config.changes.filter { $0.id > (seen ?? .max) } }
    private var others: [SidebarBox] { app.boxes.filter { $0 != box } }

    var body: some View {
        // Always there (with nothing in it, no room), so it notes what was there as it opened.
        VStack(spacing: 0) {
            if applied != nil || applying != nil || failure != nil || !AlsoApply.net(fresh).isEmpty {
                HStack(spacing: 12) {
                    if let applying {
                        Spinner(size: 13)
                        Text("Applying to \(applying)…")
                            .font(.system(size: 13))
                    } else if let applied {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text("Also applied on \(applied)")
                            .font(.system(size: 13))
                    } else {
                        Image(systemName: box.symbol)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Changed on \(app.name(of: box)) only")
                                .font(.system(size: 13, weight: .medium))
                                .lineLimit(1)
                            Text(failure ?? "Each computer keeps its own settings.")
                                .font(.system(size: 12))
                                .foregroundStyle(failure == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red))
                                .lineLimit(2)
                        }
                        Spacer(minLength: 8)
                        Menu("Also Apply to…") {
                            ForEach(others) { other in
                                Button { apply(to: [other]) } label: {
                                    Label(app.name(of: other), systemImage: other.symbol)
                                }
                            }
                            if others.count > 1 {
                                Divider()
                                Button("Every Computer") { apply(to: others) }
                            }
                        }
                        .fixedSize()
                        Button("Done") { withAnimation(.ui) { dismiss() } }
                    }
                }
                .padding(.leading, 16)
                .padding(.trailing, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: 560)
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.ui, value: fresh.map(\.id))
        .animation(.ui, value: applied)
        .onAppear {
            if seen == nil { seen = config.changes.last?.id ?? 0 }
            #if DEBUG
            // KUVO_DEMO_ALSO_APPLY: a change on this page, as if made (nothing's saved).
            if ProcessInfo.processInfo.environment["KUVO_DEMO_ALSO_APPLY"] != nil, fresh.isEmpty {
                config.noteForDemo(["snapshots"], to: .bool(config.value(at: ["snapshots"])?.bool == false))
            }
            #endif
        }
    }

    private func dismiss() {
        seen = config.changes.last?.id ?? seen
        failure = nil
    }

    private func apply(to targets: [SidebarBox]) {
        let changes = fresh
        guard let last = changes.last?.id else { return }
        failure = nil
        Task {
            var done: [String] = []
            for target in targets {
                let name = app.name(of: target)
                applying = name
                do {
                    try await AlsoApply.apply(changes, from: box, to: target, app: app)
                    done.append(name)
                } catch {
                    failure = "Not applied on \(name): \(error.localizedDescription)"
                }
            }
            applying = nil
            Analytics.shared.track("settings_also_applied", ["computers": done.count])
            guard failure == nil else { return }
            seen = max(seen ?? 0, last)
            applied = done.joined(separator: ", ")
            try? await Task.sleep(for: .seconds(2.5))
            withAnimation(.ui) { applied = nil }
        }
    }
}

enum SettingsMetrics {
    /// Where a page's title and groups start from the card's column edge.
    static let inset: CGFloat = 32
    /// The widest a page's groups grow; wider windows center the column in the card.
    static let groupsWidth: CGFloat = 860
    /// A page's width at most: its groups and the margins either side.
    static let columnWidth: CGFloat = groupsWidth + 2 * inset

    /// Room between one section and the next.
    static let sectionSpacing: CGFloat = 26
    /// Inside a group: rows' room at the sides, above and below, and their height at least.
    static let rowPadding: CGFloat = 14
    static let rowVerticalPadding: CGFloat = 10
    static let rowHeight: CGFloat = 44
    static let groupRadius: CGFloat = 8

    /// Secondary and tertiary text in Settings, a step brighter than the system's: descriptions
    /// read at 4.5:1 or better on a group in either mode.
    static func secondaryInk(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .white.opacity(0.64) : .black.opacity(0.6)
    }

    static func tertiaryInk(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .white.opacity(0.44) : .black.opacity(0.42)
    }

    /// A group's fill: a quiet step off the card, not a card of its own.
    static func groupFill(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .white.opacity(0.04) : Surface.slate.opacity(0.035)
    }

    /// The margin at a page's width: a little less in a narrow window.
    static func inset(forWidth width: CGFloat) -> CGFloat {
        width < 560 ? 20 : inset
    }
}

extension EnvironmentValues {
    /// Where a Settings page's title and groups start, for the page's width.
    @Entry var settingsInset = SettingsMetrics.inset
}

/// Gives a page the inset its title (and anything else that lines up with the groups) uses at
/// its width, so a narrow window keeps the title over the groups.
private struct SettingsColumnInset: ViewModifier {
    @State private var width = SettingsMetrics.columnWidth

    func body(content: Content) -> some View {
        content
            .environment(\.settingsInset, SettingsMetrics.inset(forWidth: width))
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

/// Calls `onInteraction` when you do something in its frame: a click (the left button or the
/// right), or a key typed with the focus there. Scrolling and shortcuts (⌘, ⌃) don't count, nor do
/// keys that move around (Tab, Escape, the arrows, Page Up and Down, Home and End).
struct InteractionWatcher: NSViewRepresentable {
    let onInteraction: () -> Void

    func makeNSView(context: Context) -> WatcherView {
        let view = WatcherView()
        view.onInteraction = onInteraction
        return view
    }

    func updateNSView(_ view: WatcherView, context: Context) {
        view.onInteraction = onInteraction
    }

    static func dismantleNSView(_ view: WatcherView, coordinator: ()) {
        view.stop()
    }

    final class WatcherView: NSView {
        var onInteraction: () -> Void = {}
        private var monitor: Any?
        private static let movingKeys: Set<UInt16> = [48, 53, 115, 116, 119, 121, 123, 124, 125, 126]

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { [weak self] event in
                if let self, self.counts(event) { self.onInteraction() }
                return event
            }
        }

        func stop() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }

        private func counts(_ event: NSEvent) -> Bool {
            guard let window, event.window === window, !isHiddenOrHasHiddenAncestor else { return false }
            if event.type == .keyDown {
                guard event.modifierFlags.isDisjoint(with: [.command, .control]), !Self.movingKeys.contains(event.keyCode),
                      let focused = window.firstResponder as? NSView, focused !== window.contentView else { return false }
                return bounds.contains(convert(NSPoint(x: focused.bounds.midX, y: focused.bounds.midY), from: focused))
            }
            return bounds.contains(convert(event.locationInWindow, from: nil))
        }
    }
}
