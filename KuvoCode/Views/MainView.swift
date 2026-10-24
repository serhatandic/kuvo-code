import OpenCodeKit
import SwiftUI

/// The workspace, laid out like Rex: open sessions as tabs in the title bar, and
/// cards floating on the window's glass (sessions, the conversation, changes).
struct MainView: View {
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    @Environment(Workspace.self) private var workspace
    @Environment(Bots.self) private var bots
    @Environment(GroupChats.self) private var groups

    /// The tabs, the one in view, the split, the panel shown or expanded, the editor in the main
    /// card: the window's, in a store of their own, which keeps them with this scene.
    private var tabs: WindowTabs { app.tabs }
    /// What the tabs were, kept with the scene for the next launch (`WindowTabs.saved`).
    @SceneStorage("windowTabs") private var savedTabs = ""
    /// How they were kept before, read once to bring them over.
    @SceneStorage("tabs") private var olderTabs = ""
    @SceneStorage("selection") private var olderSelection: String?
    @SceneStorage("splitPairs") private var olderPairs = ""
    @SceneStorage("showsPanel") private var olderShowsPanel = false
    @SceneStorage("showsSidebar") private var showsSidebar = true
    /// The row at the top: the project, its branch and the tabs. Hidden, sessions are switched
    /// from the sidebar or ⌘K.
    @AppStorage(TabBar.showsKey) private var showsTabBar = TabBar.showsByDefault
    /// The window is being resized.
    @State private var window = WindowStateReader.State()
    /// Goes up for ⌘F in the group chat in view.
    @State private var groupFind = 0
    /// The room the conversation and the panel share: what the panel takes, expanded.
    @State private var mainAreaWidth: CGFloat = 0
    @AppStorage("sessionsWidth") private var sessionsWidth = 280.0
    @AppStorage("changesWidth") private var changesWidth = 420.0
    @AppStorage(Notifier.badgeKey) private var showsBadge = true
    /// New Project or Edit Project, in a popup while it's open.
    @State private var projectEditor: ProjectEditorRequest?
    /// Open Quickly's palette is showing.
    @State private var showsOpenQuickly = false
    /// The command palette (⌘K) is showing.
    @State private var showsPalette = false
    /// Terminals open as tabs, standing in for a conversation.
    private var terminals: MainTerminals { app.mainTerminals }
    /// A tab's session being renamed, and the title being typed.
    @State private var renaming: Session?
    /// The window's content width; the title bar is sized from it.
    @State private var contentWidth: CGFloat = 1200
    /// Where the middle card starts and where the title bar's items start, in the window: the
    /// tabs line up with the card.
    @State private var mainPaneX: CGFloat = 0
    @State private var titleBarX: CGFloat = 0
    @State private var settingsBarX: CGFloat = 0
    @AppStorage("splitWidth") private var splitWidth = 560.0

    private var utilities: Utilities { app.utilities }
    private var selection: TabKey? { tabs.selection }
    private var focus: WindowTabs.Pane { tabs.focus }
    private var showsPanel: Bool { tabs.showsPanel }
    private var panelExpanded: Bool { tabs.panelExpanded }
    private var sessionID: String? { tabs.sessionID }
    private var groupID: String? { tabs.groupID }
    private var draftDirectory: String? { tabs.draftDirectory }
    private var activeModel: SessionModel? { tabs.activeModel }
    private var focusedModel: SessionModel? { tabs.focusedModel }
    private var splitModel: SessionModel? { tabs.splitModel }
    private var besideID: String? { tabs.besideID }
    private var sessionsInView: [String] { tabs.sessionsInView }
    private var activeDirectory: String? { tabs.activeDirectory }
    private var focusedDirectory: String? { tabs.focusedDirectory }
    /// The active tab's folder, and the focused session's, when they're a project's: not the chats'
    /// folder or a bot's own.
    private var activeProject: String? { WindowTabs.project(activeDirectory) }
    private var focusedProject: String? { WindowTabs.project(focusedDirectory) }

    /// When the sessions on screen last finished.
    private var idlesInView: [Milliseconds?] {
        sessionsInView.map { workspace.session($0)?.time.idle }
    }

    /// The sessions on screen count as seen.
    private func markViewed() {
        for id in sessionsInView { workspace.markViewed(id) }
    }

    /// A bot's workspace: the folder of its own it works in when it has no project.
    private func isBotsOwnFolder(_ directory: String) -> Bool {
        bots.list.contains { $0.project == nil && $0.directory == directory }
    }

    /// The machine a folder is on, for a project there; nil for this Mac's.
    private func machine(for folder: String?) -> MachineEngine? {
        app.machines.engine(folder.flatMap(RemoteFolder.machine(of:)))
    }

    /// The agents, commands and models of the engine a folder's sessions run on.
    private func catalog(for folder: String?) -> Catalog {
        machine(for: folder)?.catalog ?? catalog
    }

    /// How wide the window and its cards are, for the tabs to lay them out.
    private var room: WindowTabs.Room {
        WindowTabs.Room(width: contentWidth, sessions: showsSidebar ? sessionsWidth : nil, changes: changesWidth, split: splitWidth)
    }

    /// The cards, the title bar and what shows over them.
    private var windowContent: some View {
        // Cards are sized from the room the window actually has, so they never spill
        // past its edges. The gaps between them are drag handles for resizing.
        GeometryReader { proxy in
            // Expanded, the panel grows over the conversation, which keeps its room (and its
            // layout) underneath for when it comes back.
            let layout = paneLayout(available: proxy.size.width)
            let expands = showsPanel && panelExpanded
            HStack(spacing: 0) {
                // The sidebar's room, with the gap after it; the sidebar itself is over it
                // (below). Growing and shrinking with the slide, so the conversation makes room
                // as the sidebar comes in, rather than all at once ahead of it.
                Color.clear
                    .frame(width: layout.sessions.map { $0 + Metrics.paneGap } ?? 0)
                    .overlay(alignment: .trailing) {
                        if let width = layout.sessions {
                            PaneResizer(
                                width: Binding(get: { width }, set: { sessionsWidth = $0 }),
                                range: PaneLayout.sessionsRange.lowerBound...max(PaneLayout.sessionsRange.lowerBound, layout.sessionsMax),
                                side: .leading
                            )
                        }
                    }
                // With the tab bar hidden and no sidebar, the window's buttons and the sidebar
                // button sit over this card's header.
                let controlsInset: CGFloat = !showsTabBar && layout.sessions == nil ? 124 : 0
                ZStack(alignment: .trailing) {
                    HStack(spacing: 0) {
                        conversationCard
                            .frame(maxWidth: .infinity)
                            // Another session shows at once, as the tab moves to it: animated, the
                            // last one faded out row by row under the new one, both drawn meanwhile.
                            .transaction(value: selection) { $0.animation = nil }
                            .environment(\.windowControlsInset, controlsInset)
                            // With the tab bar hidden, the panel button sits over the rightmost card.
                            .environment(\.windowControlsTrailingInset, !showsTabBar && layout.changes == nil && layout.split == nil ? 36 : 0)
                            .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minX }) { mainPaneX = $0 }
                            // Under the expanded panel: out of reach, keys too (a card's Return
                            // or Esc), until it's back.
                            .disabled(expands)
                            .allowsHitTesting(!expands)
                            .accessibilityHidden(expands)
                        // Split view: another session beside it, sized like the side cards.
                        if let width = layout.split, let model = splitModel {
                            PaneResizer(
                                width: Binding(get: { width }, set: { splitWidth = $0 }),
                                range: PaneLayout.splitRange.lowerBound...max(PaneLayout.splitRange.lowerBound, layout.splitMax),
                                side: .trailing
                            )
                            .allowsHitTesting(!expands)
                            splitCard(model)
                                .frame(width: width)
                                .environment(\.windowControlsTrailingInset, !showsTabBar && layout.changes == nil ? 36 : 0)
                                .transaction(value: showsPanel) { $0.animation = nil }
                                .transaction(value: showsSidebar) { $0.animation = nil }
                                .disabled(expands)
                                .allowsHitTesting(!expands)
                                .accessibilityHidden(expands)
                                .transition(.move(edge: .trailing).combined(with: .opacity))
                        }
                        // The panel's room, with the gap before it; the panel itself is over it, so
                        // expanding only makes it wider, the one card it is. Growing and shrinking
                        // with the panel's slide, as the sidebar's does, so the conversation makes
                        // room as the panel comes in rather than ahead of it.
                        Color.clear
                            .frame(width: layout.changes.map { $0 + Metrics.paneGap } ?? 0)
                            .overlay(alignment: .leading) {
                                if let width = layout.changes {
                                    PaneResizer(
                                        width: Binding(get: { width }, set: { changesWidth = $0 }),
                                        range: PaneLayout.changesRange.lowerBound...max(PaneLayout.changesRange.lowerBound, layout.changesMax),
                                        side: .trailing
                                    )
                                    .allowsHitTesting(!expands)
                                }
                            }
                    }
                    .onGeometryChange(for: CGFloat.self, of: \.size.width) { mainAreaWidth = $0 }
                    if showsPanel, layout.changes != nil || expands {
                        utilitiesPane
                            .frame(width: expands ? mainAreaWidth : layout.changes ?? mainAreaWidth)
                            .environment(\.windowControlsInset, expands ? controlsInset : 0)
                            .environment(\.windowControlsTrailingInset, showsTabBar ? 0 : 36)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                }
            }
            // Made once and kept while it's hidden, out past the window's left edge: showing it
            // again only slides it in. Made again each time, it (and each of its bots) took the
            // first tenth of a second of the slide.
            .overlay(alignment: .topLeading) {
                let shown = layout.sessions != nil
                let width = layout.sessions ?? sessionsWidth
                sessionsCard
                    .frame(width: width)
                    .offset(x: shown ? 0 : -(width + Metrics.paneGap * 2))
                    .opacity(shown ? 1 : 0)
                    .allowsHitTesting(shown)
                    .disabled(!shown)
                    .accessibilityHidden(!shown)
            }
            // Settings take the window's place. The sessions stay underneath, hidden and out of
            // reach, so the panel's terminals and pages carry on and everything is where it was.
            // Out of sight to the conversations too, whose rows (each a view of its own) would
            // otherwise still follow the pointer and set it, under Settings' controls.
            .environment(\.isConversationShown, !app.showsSettings)
            .opacity(app.showsSettings ? 0 : 1)
            .allowsHitTesting(!app.showsSettings)
            .disabled(app.showsSettings)
            .accessibilityHidden(app.showsSettings)
            .overlay {
                if app.showsSettings {
                    let widest = max(PaneLayout.sessionsRange.lowerBound, min(PaneLayout.sessionsRange.upperBound, proxy.size.width * 0.4))
                    SettingsView(
                        sidebarWidth: min(max(layout.sessions ?? sessionsWidth, PaneLayout.sessionsRange.lowerBound), widest),
                        sidebarRange: PaneLayout.sessionsRange.lowerBound...widest,
                        resizeSidebar: { sessionsWidth = $0 },
                        topInset: keepsTitleBar ? 0 : Metrics.windowControlsHeight,
                        close: closeSettings
                    )
                    .transition(.opacity)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { contentWidth = $0 }
        .padding(.horizontal, Metrics.paneGap)
        .padding(.bottom, Metrics.paneGap)
        // Without the tab bar, the cards reach up into the title bar; the window's buttons sit
        // at the top of the sidebar.
        .padding(.top, keepsTitleBar ? 0 : Metrics.paneGap)
        // The gaps around the cards move the window, as a title bar does.
        .background { WindowGapDragArea() }
        .ignoresSafeArea(.container, edges: keepsTitleBar ? [] : .top)
        // Without the tab bar, the panel's button stays at the top right, on the rightmost card's
        // header row, so the panel can still be found.
        .overlay(alignment: .topTrailing) {
            if !showsTabBar && !app.showsSettings {
                PanelToggle(showsPanel: panelToggle)
                    .padding(.top, Metrics.paneGap + (Metrics.cardHeaderHeight - 28) / 2)
                    .padding(.trailing, Metrics.paneGap + 6)
                    .ignoresSafeArea(.container, edges: .top)
            }
        }
        .animation(.ui, value: showsSidebar)
        .animation(.ui, value: showsPanel)
        .animation(.ui, value: panelExpanded)
        .animation(.ui, value: app.showsSettings)
        // Typing mustn't go on into a composer or terminal that Settings now hide.
        .onChange(of: app.showsSettings) { _, shows in
            if shows { NSApp.mainWindow?.makeFirstResponder(nil) }
            // Leaving Settings closes the sites you were signing in to.
            if !shows { app.settingsTabs.closeSites(machines: app.machines) }
        }
        // Nor into the conversation the expanded panel covers (its composer, if it had the
        // keyboard; the panel's own terminal or page keeps it).
        .onChange(of: showsPanel && panelExpanded) { _, expanded in
            guard expanded, let window = NSApp.mainWindow, let editor = window.firstResponder as? NSTextView, editor.isFieldEditor else { return }
            window.makeFirstResponder(nil)
        }
        // The agent started browsing: show it.
        .onChange(of: utilities.revealRequest) { withAnimation(.ui) { tabs.showPanel() } }
        // Hiding the tab bar takes the whole row away and the cards reach the top. The sidebar
        // button stays, so the window's buttons keep a toolbar's height, centered on the cards'
        // header row, and the sidebar is a click away. The panel is still ⌥⌘0, and sessions ⌘K.
        .toolbar {
            if app.showsSettings && showsTabBar {
                // In Settings, the title bar has the way back, and the tabs once you sign in to a
                // site: the page's, then each site's, from where the page's card starts.
                ToolbarItem(placement: .navigation) { settingsTitleBar }
                .sharedBackgroundVisibility(.hidden)
            } else if app.showsSettings {
                // Without the tab bar, only the way back, beside the window's buttons.
                ToolbarItem(placement: .navigation) { SettingsBackButton(close: closeSettings) }
                    .sharedBackgroundVisibility(.hidden)
            } else if showsTabBar {
                titleBar
            } else {
                ToolbarItem(placement: .navigation) { SidebarToggle(showsSidebar: sidebarToggle) }
                    .sharedBackgroundVisibility(.hidden)
            }
        }
        .toolbar(removing: .title)
        // Being resized (for the tabs' room), and kept out of full screen (see `WindowStateReader`).
        .background(WindowStateReader { window = $0 })
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        .iconOnlyToolbar()
        .overlay(alignment: .top) {
            if catalog.isSlow {
                SlowEngineNotice()
                    .padding(.top, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.ui, value: catalog.isSlow)
        .overlay(alignment: .top) {
            if showsOpenQuickly, let directory = focusedDirectory {
                ZStack(alignment: .top) {
                    // A click outside closes it.
                    Color.black.opacity(0.001)
                        .onTapGesture { showsOpenQuickly = false }
                    OpenQuickly(roots: [directory] + workspace.extraFolders(directory)) { url in
                        showsOpenQuickly = false
                        Analytics.shared.track("open_quickly_used")
                        showInPanel { utilities.show(url) }
                    } dismiss: {
                        showsOpenQuickly = false
                    }
                    .padding(.top, 80)
                }
                .transition(.opacity)
            }
        }
        .animation(.ui, value: showsOpenQuickly)
        .overlay(alignment: .top) {
            if showsPalette {
                ZStack(alignment: .top) {
                    Color.black.opacity(0.001)
                        .onTapGesture { showsPalette = false }
                    CommandPalette(
                        initialQuery: DemoPalette.query,
                        actions: paletteActions,
                        sessions: paletteSessions,
                        roots: focusedDirectory.map { [$0] + workspace.extraFolders($0) } ?? [],
                        openFile: { url in showInPanel { utilities.show(url) } },
                        dismiss: { showsPalette = false }
                    )
                    .padding(.top, 80)
                }
                .transition(.opacity)
            }
        }
        .animation(.ui, value: showsPalette)
    }

    /// The window, following the sessions in view.
    private var followingSessions: some View {
        windowContent
        .focusedSceneValue(\.sessionActions, actions)
        // Escape stops the agent also when the composer doesn't have the keyboard.
        .background(EscapeToStop(canStop: actions.canStop && !app.showsSettings, stop: actions.stop))
        // Viewed only while you're here: finished while you're in another app, it waits for you
        // on the Dock icon, and counts as seen when you come back. The session beside the tab's
        // is in view too.
        .onChange(of: sessionsInView) { if NSApp.isActive { markViewed() } }
        .onChange(of: idlesInView) { if NSApp.isActive { markViewed() } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in markViewed() }
        // The panel follows what's in view, all at once: the conversations, the half you work in,
        // its place, and the bots in view.
        .onChange(of: tabs.inView, initial: true) { _, inView in utilities.inView = inView }
        .onChange(of: room, initial: true) { _, room in tabs.room = room }
        // New Project and Edit Project: a popup over whatever's in the window.
        .sheet(item: $projectEditor) { projectSheet($0) }
    }

    private func projectSheet(_ request: ProjectEditorRequest) -> some View {
        ProjectEditor(project: request.project, folders: request.folders, focusesRun: request.focusesRun) { primary, settings in
            var settings = settings
            // A new project on a folder that's one already adds to what it has.
            if request.project == nil, let existing = workspace.settings[workspace.folderPath(primary)] {
                func given(_ text: String?) -> String? { text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? text : nil }
                settings.name = given(settings.name) ?? existing.name
                settings.folders = existing.folders + settings.folders.filter { !existing.folders.contains($0) }
                settings.run = given(settings.run) ?? existing.run
                settings.terminal = given(settings.terminal) ?? existing.terminal
            }
            let primary = workspace.saveProject(primary, settings: settings)
            if request.project == nil { tabs.newSession(in: primary) }
        } close: {
            projectEditor = nil
        }
    }

    var body: some View {
        followingSessions
        .task(id: activeDirectory) {
            if let activeDirectory { await workspace.loadBranch(for: activeDirectory) }
        }
        .onChange(of: workspace.sessions.map(\.id)) { tabs.dropClosed() }
        .onChange(of: groups.list.map(\.id)) { tabs.dropClosed() }
        .onChange(of: workspace.isLoaded) {
            // The list arrives just before loading counts as done, so check it again here.
            tabs.dropClosed()
            tabs.startIfEmpty()
        }
        .onAppear {
            tabs.restore(savedTabs, older: .init(tabs: olderTabs, selection: olderSelection, pairs: olderPairs, showsPanel: olderShowsPanel))
            (olderTabs, olderSelection, olderPairs, olderShowsPanel) = ("", nil, "", false)
            // Opened again after the window closed: the terminals went with it.
            tabs.dropClosed()
            tabs.startIfEmpty()
            // What changed while the window was away, kept too.
            savedTabs = tabs.saved
        }
        .onChange(of: tabs.snapshot) { _, saved in savedTabs = saved.text }
        .onChange(of: workspace.waitingCount, initial: true) { Notifier.shared.setBadge(workspace.waitingCount) }
        .onChange(of: showsBadge) { Notifier.shared.setBadge(workspace.waitingCount) }
        // Another tab: a rename in the last one's header ends, keeping what was typed.
        .onChange(of: selection) { _, key in if renaming?.id != key?.sessionID { renaming = nil } }
        #if DEBUG
        .task(id: workspace.isLoaded) { await DemoDirector.run(app: app, window: demoWindow) }
        #endif
    }

    // MARK: Title bar

    @ToolbarContentBuilder private var titleBar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            titleRow
                // A width from the window (minus the traffic lights and the buttons on the right), so a
                // narrow window squeezes the tabs instead of pushing them into a » menu.
                .frame(width: max(240, contentWidth - (runCommand(of: activeProject) == nil ? 150 : 190) - resizeRoom), alignment: .leading)
                // Its empty parts are the title bar's: they drag the window, and a double-click zooms it.
                .background { WindowDragArea() }
                .modifier(UnderImageViewer())
        }
        .sharedBackgroundVisibility(.hidden)

        if runCommand(of: activeProject) != nil {
            ToolbarItem(placement: .primaryAction) { runButton }
                .sharedBackgroundVisibility(.hidden)
        }

        ToolbarItem(placement: .primaryAction) { PanelToggle(showsPanel: panelToggle).modifier(UnderImageViewer()) }
            .sharedBackgroundVisibility(.hidden)
    }

    /// The title bar's project and tabs: in the toolbar, or in full screen in a row of the
    /// window's own.
    private var titleRow: some View {
        HStack(spacing: 0) {
            ProjectIdentity(
                // A bot in a folder of its own has no project to name (its card names it).
                name: activeDirectory.flatMap { directory in isBotsOwnFolder(directory) ? nil : workspace.projectName(directory) },
                branch: activeDirectory.flatMap { directory in isBotsOwnFolder(directory) ? nil : workspace.branches[directory] },
                directory: activeDirectory,
                isWorktree: activeDirectory.map { workspace.worktrees[$0] != nil } ?? false,
                environment: app.shellEnvironment,
                showsSidebar: sidebarToggle
            ) {
                if let activeDirectory { Task { await workspace.loadBranch(for: activeDirectory) } }
            }
            // Up to the middle card, so the tabs start where it does; without the sidebar
            // there's no room for that, and the tabs follow the project.
            .frame(width: identityWidth, alignment: .leading)
            .padding(.trailing, identityWidth == nil ? 16 : 0)
            if !tabItems.isEmpty {
                TabStrip(tabs: tabItems, selection: tabSelection, close: { tabs.close(TabKey($0)) }, closeAll: { tabs.closeAll(except: $0.map(TabKey.init)) },
                         openBeside: besideOpener, closeBeside: { tabs.closeBeside(TabKey($0)) }, closeBesideTab: { tabs.closeBesideTab(TabKey($0)) },
                         swapBeside: { tabs.swapBeside(TabKey($0)) }) { id in
                    guard let session = workspace.session(id) else { return }
                    // Renamed in its card's header: its tab comes forward for it.
                    tabs.selection = .session(id)
                    renaming = session
                }
            }
        }
        .background(WindowXReader { titleBarX = $0 })
    }

    @ViewBuilder private var runButton: some View {
        if let tabsRun = runCommand(of: activeProject) {
            Button { runProject(activeProject) } label: {
                Image(systemName: "play.fill")
                    .font(.system(size: 13))
            }
            .buttonStyle(IconButtonStyle(width: 28, height: 28, cornerRadius: 7))
            .accessibilityLabel("Run")
            .help("Run \(tabsRun)" + (focusedProject == activeProject ? " (⌘R)" : ""))
            .modifier(UnderImageViewer())
        }
    }

    /// The project's width in the title bar: up to the middle card, when the sidebar leaves
    /// enough room for it.
    private var identityWidth: CGFloat? {
        let room = mainPaneX - titleBarX
        return showsSidebar && titleBarX > 0 && room >= 150 ? room : nil
    }

    private var tabItems: [TabItem] {
        tabs.keys.compactMap { key in
            guard var item = tabItem(for: key) else { return nil }
            if let beside = tabs.pairs[key], let other = tabItem(for: .session(beside)) { item.companion = [other] }
            return item
        }
    }

    /// The tab strip's selection, by the tabs' written keys.
    private var tabSelection: Binding<String?> {
        Binding(get: { tabs.selection?.text }, set: { tabs.selection = $0.map(TabKey.init) })
    }

    private func tabItem(for key: TabKey) -> TabItem? {
        let id = key.text
        switch key {
        case .draft(let directory):
            return TabItem(id: id, title: Workspace.isChat(directory) ? "New Chat" : "New Session", logo: nil, status: .idle)
        case .terminal:
            guard let entry = terminals.entry(id) else { return nil }
            return TabItem(id: id, title: entry.session.title == "Terminal" ? entry.label : entry.session.title, logo: nil, status: .idle, symbol: "apple.terminal")
        case .group(let group):
            guard let group = groups.group(group) else { return nil }
            let status: TabItem.Status = groups.discussing.contains(group.id) ? .working : groups.isUnread(group) && groupID != group.id ? .unread : .idle
            return TabItem(id: id, title: group.name, logo: nil, group: faces(of: group), status: status)
        case .session(let sessionID):
            if workspace.waitingMachine(for: sessionID) != nil {
                return TabItem(id: id, title: workspace.remoteTitle(sessionID) ?? "Session", logo: nil, status: .idle)
            }
            guard let session = workspace.session(sessionID) else { return nil }
            if let bot = bots.bot(forSession: sessionID) {
                return TabItem(id: id, title: bot.name, logo: nil, bot: bot.look, botMood: bots.mood(of: bot, in: workspace), status: status(of: session))
            }
            return TabItem(id: id, title: session.title ?? "New Session", logo: logo(for: session.model, in: session.location.directory), status: status(of: session))
        }
    }

    /// Bots moving in the main card (working in their conversation, talking in a group chat, being
    /// edited): their sidebar rows hold still meanwhile, so each moves in one place at a time.
    /// An idle bot whose conversation is open moves in the sidebar, as nothing in its conversation does.
    private var stagedBots: Set<String> {
        if let request = tabs.botEditor { return Set([request.bot?.id].compactMap(\.self)) }
        if tabs.groupEditor != nil { return [] }
        if let id = sessionID, let bot = bots.bot(forSession: id), workspace.running.contains(id) { return [bot.id] }
        if let id = groupID, let speaker = groups.speaking[id] { return [speaker] }
        return []
    }

    /// A group chat's bots, the one talking at work.
    private func faces(of group: BotGroup) -> [GroupAvatar.Face] {
        let speaker = groups.speaking[group.id]
        return group.members.compactMap { id in
            bots.bot(id).map { GroupAvatar.Face(look: $0.look, mood: $0.id == speaker ? .working : .idle) }
        }
    }

    private func logo(for ref: ModelRef?, in folder: String? = nil) -> String? {
        guard let ref else { return nil }
        return catalog(for: folder).model(ref)?.makerLogoID ?? ref.providerID
    }

    private func status(of session: Session) -> TabItem.Status {
        if workspace.needsAttention(session.id) { return .waiting }
        if workspace.isWorking(session.id) { return .working }
        if session.outcome == .failed { return .failed }
        if session.isUnread, !sessionsInView.contains(session.id) { return .unread }
        return .idle
    }

    // MARK: Cards

    private var sessionsCard: some View {
        // No card of its own: the sessions sit on the window's glass.
        Card(title: "Sessions", isFocused: focus == .sessions, showsHeader: false, showsSurface: false) {
            EmptyView()
        } content: {
            SidebarView(
                selection: Binding(get: { selection?.text }, set: { id in if let id { tabs.open(TabKey(id)) } }),
                newSession: { tabs.newSession(in: $0) },
                newProject: { openProjectEditor(ProjectEditorRequest(project: nil)) },
                editProject: { openProjectEditor(ProjectEditorRequest(project: $0)) },
                showProviders: { app.openSettings(.accounts) },
                newBot: { tabs.openBotEditor(bot: nil) },
                editBot: { tabs.openBotEditor(bot: $0) },
                newGroup: { tabs.openGroupEditor(group: nil) },
                editGroup: { tabs.openGroupEditor(group: $0) },
                newConversation: { tabs.open(.draft($0)) },
                closeTerminal: { tabs.close(TabKey($0)) },
                stagedBots: stagedBots,
                openBeside: besideOpener
            )
            // Room for the window's buttons above the first row, when they sit here.
            .padding(.top, showsTabBar ? 0 : Metrics.windowControlsHeight)
        }
        .overlay(alignment: .top) {
            if !showsTabBar { WindowDragArea().frame(height: Metrics.windowControlsHeight) }
        }
        .simultaneousGesture(TapGesture().onEnded { tabs.focus = .sessions })
    }

    /// The session's title, renamed in its card's header, while it's the one being renamed.
    private func rename(_ session: Session) -> CardRename? {
        guard renaming?.id == session.id else { return nil }
        // Each ends only its own rename: one started on another session meanwhile stays.
        return CardRename(original: session.title ?? "") { title in
            Task { await workspace.rename(session.id, to: title) }
            if renaming?.id == session.id { renaming = nil }
        } cancel: {
            if renaming?.id == session.id { renaming = nil }
        }
    }

    /// The session beside the one in view: the same as its own card, with a way to swap the two
    /// and to close the split.
    private func splitCard(_ model: SessionModel) -> some View {
        let id = model.id
        let directory = model.session.location.directory
        let bot = bots.bot(forSession: id)
        return Card(title: bot?.name ?? model.session.title ?? "New Session", detail: bot == nil ? workspace.projectName(directory) : nil, isFocused: focus == .split, rename: bot == nil ? rename(model.session) : nil) {
            if let bot {
                BotAvatar(look: bot.look, size: 18, mood: bots.mood(of: bot, in: workspace), animates: false)
            } else if let logo = logo(for: model.session.model, in: directory) { ProviderLogo(id: logo, size: 14) } else { Image(systemName: "bubble.left") }
        } actions: {
            ContextGauge(model: model)
            Button("Swap", systemImage: "arrow.left.arrow.right") { tabs.swapSplit() }
                .help("Swap the two sessions")
            Button("Close Split View", systemImage: "xmark") { if let selection { tabs.closeBeside(selection) } }
                .help("Close Split View")
        } content: {
            SessionView(model: model)
                .environment(\.bot, bot)
                // Return and Esc answer its cards once you've clicked or typed into it.
                .environment(\.takesCardKeys, focus == .split)
                .environment(\.composerFocused) { tabs.focus = .split }
                .largeWidgetHost()
        }
        .onTitle(bot.map { "Edit \($0.name)" }, bot.map { bot in { tabs.openBotEditor(bot: bot) } })
        .environment(catalog(for: directory))
        .id("split-" + id)
        .simultaneousGesture(TapGesture().onEnded { tabs.focus = .split })
    }

    /// Open Beside, while a session can open beside the tab in view: it's a session's (not a
    /// draft or a group chat).
    private var besideOpener: ((String) -> Void)? {
        guard let sessionID, workspace.session(sessionID) != nil else { return nil }
        return { tabs.openBeside($0) }
    }

    @ViewBuilder private var conversationCard: some View {
        Group {
            if let request = tabs.groupEditor {
                Card(title: request.group.map { "Edit \($0.name)" } ?? "New Group Chat", isFocused: focus == .conversation) {
                    if let group = request.group { GroupAvatar(faces: faces(of: group), size: 20) } else { Image(systemName: "person.2") }
                } actions: {
                    Button("Close", systemImage: "xmark") { withAnimation(.ui) { tabs.groupEditor = nil } }
                        .help("Close")
                } content: {
                    GroupEditor(group: request.group, newBot: { tabs.openBotEditor(bot: nil) }) {
                        withAnimation(.ui) { tabs.groupEditor = nil }
                    } created: { group in
                        tabs.open(.group(group.id))
                    }
                }
                .id(request.id)
            } else if let request = tabs.botEditor {
                Card(title: request.bot.map { "Edit \($0.name)" } ?? "New Bot", isFocused: focus == .conversation) {
                    if let bot = request.bot { BotAvatar(look: bot.look, size: 18, animates: false) } else { Image(systemName: "face.smiling") }
                } actions: {
                    Button("Close", systemImage: "xmark") { withAnimation(.ui) { tabs.botEditor = nil } }
                        .help("Close")
                } content: {
                    BotEditor(bot: request.bot, recipe: request.recipe) {
                        // This editor's, not one opened since (a delete that took a while).
                        if tabs.botEditor?.id == request.id { withAnimation(.ui) { tabs.botEditor = nil } }
                    } created: { bot in
                        // Its tab opens in place of this editor, not of one opened since.
                        if tabs.botEditor?.id == request.id { tabs.open(.session(bot.sessionID)) }
                    }
                }
                .id(request.id)
            } else if let key = selection, let entry = terminals.entry(key.text) {
                Card(title: entry.session.title == "Terminal" ? entry.label : entry.session.title, detail: workspace.projectName(entry.directory), isFocused: focus == .conversation) {
                    Image(systemName: "apple.terminal")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { tabs.close(key) }
                        .help("Close Tab")
                } content: {
                    TerminalHost(session: entry.session)
                }
                .id(key)
            } else if let id = groupID, let group = groups.group(id) {
                Card(title: group.name, detail: groupDetail(group), isFocused: focus == .conversation) {
                    GroupAvatar(faces: faces(of: group), size: 20)
                } actions: {
                    Button("Edit Group Chat", systemImage: "slider.horizontal.3") { tabs.openGroupEditor(group: group) }
                        .help("Edit Group Chat: its name, bots and lead")
                        .disabled(app.moves.isMoving(group.id))
                    Button("Close Tab", systemImage: "xmark") { tabs.close(.group(id)) }
                        .help("Close Tab")
                } content: {
                    GroupChatView(group: group, findRequest: groupFind)
                        .largeWidgetHost()
                }
                .onTitle("Edit Group Chat", app.moves.isMoving(group.id) ? nil : { tabs.openGroupEditor(group: group) })
                .id(TabKey.group(id))
            } else if let id = sessionID, let model = workspace.model(for: id) {
                let directory = model.session.location.directory
                let machine = machine(for: directory)
                let bot = bots.bot(forSession: id)
                // A bot's card has its name only: its avatar shows where it lives.
                Card(title: bot?.name ?? model.session.title ?? "New Session", detail: bot == nil ? workspace.projectName(directory) : nil, isFocused: focus == .conversation, rename: bot == nil ? rename(model.session) : nil) {
                    if let bot {
                        // Still: in view, the bot moves in its conversation.
                        BotAvatar(look: bot.look, size: 18, mood: bots.mood(of: bot, in: workspace), animates: false)
                            .overlay(alignment: .bottomTrailing) {
                                if let machine = bot.machine { MachineBadge(machine: machine, size: 10).offset(x: 3, y: 3) }
                            }
                    } else if let logo = logo(for: model.session.model, in: directory) { ProviderLogo(id: logo, size: 14) } else { Image(systemName: "bubble.left") }
                } actions: {
                    if let bot {
                        Button("Edit Bot", systemImage: "slider.horizontal.3") { tabs.openBotEditor(bot: bot) }
                            .help("Edit Bot: its look, job, wake-ups and memory")
                    }
                    if Workspace.isChat(directory) {
                        MoveToProjectButton(sessionID: id)
                    }
                    if !(machine?.isLive ?? app.isLive) {
                        Image(systemName: "bolt.horizontal.circle")
                            .foregroundStyle(.orange)
                            .help(machine.map { "Reconnecting to \($0.machine.name)…" } ?? "Reconnecting to the engine…")
                    }
                    ContextGauge(model: model)
                        .disabled(machine.map { !$0.isReady || !$0.isLive } ?? false)
                    Button("Close Tab", systemImage: "xmark") { tabs.close(.session(id)) }
                        .help("Close Tab")
                } content: {
                    SessionView(model: model)
                        .environment(\.bot, bot)
                        .environment(\.takesCardKeys, !(focus == .split && besideID != nil))
                        // Typing here is working here, however the keyboard got here.
                        .environment(\.composerFocused) { tabs.focus = .conversation }
                        .largeWidgetHost()
                }
                .onTitle(bot.map { "Edit \($0.name)" }, bot.map { bot in { tabs.openBotEditor(bot: bot) } })
                .environment(catalog(for: directory))
            } else if let id = sessionID, let engine = app.machines.engine(workspace.waitingMachine(for: id)) {
                Card(title: workspace.remoteTitle(id) ?? "Session", detail: engine.machine.name, isFocused: focus == .conversation) {
                    Image(systemName: "server.rack")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { tabs.close(.session(id)) }
                        .help("Close Tab")
                } content: {
                    MachineWaitingView(engine: engine)
                }
                .id(id)
            } else if let directory = draftDirectory, let engine = machine(for: directory), !engine.isReady {
                Card(title: "New Session", detail: workspace.projectName(directory), isFocused: focus == .conversation) {
                    Image(systemName: "square.and.pencil")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { tabs.close(.draft(directory)) }
                        .help("Close Tab")
                } content: {
                    MachineWaitingView(engine: engine)
                }
                .id(directory)
            } else if let directory = draftDirectory {
                let catalog = catalog(for: directory)
                let isChat = Workspace.isChat(directory)
                Card(title: isChat ? "New Chat" : "New Session", detail: isChat ? nil : workspace.projectName(directory), isFocused: focus == .conversation) {
                    Image(systemName: "square.and.pencil")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { tabs.close(.draft(directory)) }
                        .help("Close Tab")
                } content: {
                    DraftSessionView(directory: directory, focusRequest: tabs.draftFocus) { session, text, files in
                        tabs.draftSent(.draft(directory), as: session.id)
                        workspace.model(for: session.id)?.submit(text, files: files, for: catalog.model(session.model), queue: false, commands: catalog.commands(in: directory))
                    }
                }
                .environment(catalog)
                .id(directory)
            } else {
                Card(title: AppInfo.name, isFocused: focus == .conversation) {
                    AppLogo(size: 16)
                } content: {
                    WelcomeView(openFolder: openFolder, newChat: { tabs.newSession(in: Workspace.chatsFolder) }, showProviders: { app.openSettings(.accounts) })
                }
            }
        }
        .simultaneousGesture(TapGesture().onEnded { tabs.focus = .conversation })
        // What you open last keeps its place when the window is short of room (a split, from
        // Open Beside: coming back to a tab that has one isn't opening it).
        .onChange(of: showsSidebar) { _, shows in if shows { tabs.keep(.sessions) } }
    }

    private func paneLayout(available: Double) -> PaneLayout {
        tabs.layout(available: available)
    }

    /// Whether the panel and the sidebar are on screen: wanted, and with room for them.
    private var panelOnScreen: Bool {
        showsPanel && (panelExpanded || paneLayout(available: contentWidth).changes != nil)
    }

    private var sidebarOnScreen: Bool {
        showsSidebar && paneLayout(available: contentWidth).sessions != nil
    }

    /// Showing one that's wanted but out of room makes room for it, as the one opened last.
    private func showSidebar(_ shows: Bool) {
        showsSidebar = shows
        if shows { tabs.keep(.sessions) }
    }

    /// The panel's and the sidebar's buttons, which show what's on screen.
    private var panelToggle: Binding<Bool> { Binding(get: { panelOnScreen }, set: { tabs.showPanel($0) }) }
    /// Room kept free in the title bar while the window is dragged narrower: its width reaches
    /// the tabs a pass late, and a strip wider than the room left would be put away in the
    /// toolbar's overflow and back, again and again.
    private var resizeRoom: CGFloat { window.isResizing ? 72 : 0 }

    private var sidebarToggle: Binding<Bool> { Binding(get: { sidebarOnScreen }, set: { showSidebar($0) }) }

    private var utilitiesPane: some View {
        // The panel of the session you work in (the one beside, as its panel is then): its changes,
        // files and terminals.
        UtilitiesPane(
            utilities: utilities,
            directory: focusedDirectory,
            folders: focusedDirectory.map { [$0] + workspace.extraFolders($0) } ?? [],
            model: focusedModel,
            environment: app.shellEnvironment,
            isExpanded: Binding(get: { tabs.panelExpanded }, set: { tabs.panelExpanded = $0 }),
            isFocused: focus == .changes
        )
        .environment(catalog(for: focusedDirectory))
        .simultaneousGesture(TapGesture().onEnded { tabs.focus = .changes })
    }

    /// Opens the panel on a tool.
    private func showInPanel(_ open: () -> Void) {
        withAnimation(.ui) {
            open()
            tabs.showPanel()
            app.showsSettings = false
        }
    }

    /// Makes a project, or changes one, in a popup over what's in the window. One open already
    /// stays, with what's typed in it: a shortcut or a session opened from a notification
    /// doesn't take its place.
    private func openProjectEditor(_ request: ProjectEditorRequest) {
        guard projectEditor == nil else { return }
        projectEditor = request
    }

    /// Under a group chat's name: who's in it.
    private func groupDetail(_ group: BotGroup) -> String? {
        let names = group.members.compactMap { bots.bot($0)?.name }
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    /// Settings' tabs: its pages (a machine's by its name), and the sites you're signing in to;
    /// the last one left stays.
    private var settingsTabItems: [TabItem] {
        let tabs = app.settingsTabs
        let closes = tabs.tabs.count > 1
        return tabs.tabs.compactMap { tab -> TabItem? in
            switch tab.kind {
            case .page(let page):
                let title = tab.box.machine == nil ? page.title : "\(page.title) · \(app.name(of: tab.box))"
                return TabItem(id: tab.id, title: title, logo: nil, status: .idle, symbol: page.symbol, closes: closes, isPreview: tab.id == tabs.previewTab)
            case .site(let id):
                guard let site = tabs.site(id) else { return nil }
                return TabItem(id: tab.id, title: site.service.title, logo: nil, status: .idle, symbol: site.service.symbol, closes: closes)
            }
        }
    }

    private var settingsTabSelection: Binding<String?> {
        Binding(get: { app.settingsTabs.selectedID }, set: { id in
            guard let id else { return }
            withAnimation(.ui) { app.settingsTabs.select(id) }
        })
    }

    /// The title bar keeps its row with the tab bar; without it, the cards reach the top, in
    /// Settings too (one page at a time, then).
    private var keepsTitleBar: Bool {
        showsTabBar
    }

    /// In Settings, the title bar has the way back, and Settings' tabs, from where the page's
    /// card starts.
    private var settingsTitleBar: some View {
        HStack(spacing: 0) {
            SettingsBackButton(close: closeSettings)
            Color.clear.frame(width: max(8, app.settingsTabs.contentX - settingsBarX - 28))
            TabStrip(tabs: settingsTabItems, selection: settingsTabSelection, close: { id in
                withAnimation(.ui) { app.settingsTabs.close(id, machines: app.machines) }
            }, closeAll: { except in
                withAnimation(.ui) { app.settingsTabs.closeOthers(than: except, machines: app.machines) }
            })
        }
        .background(WindowXReader { settingsBarX = $0 })
        // Its buttons each by their own name, not all by the first one's.
        .accessibilityElement(children: .contain)
        // Room from the window, as the sessions' tabs have, so titles aren't squeezed.
        .frame(width: max(240, contentWidth - 150 - resizeRoom), alignment: .leading)
        // Its empty parts are the title bar's: they drag the window, and a double-click zooms it.
        .background { WindowDragArea() }
        .animation(.ui, value: app.settingsTabs.tabs.map(\.id))
    }

    /// Back from Settings to the sessions, as they were.
    private func closeSettings() {
        withAnimation(.ui) { app.showsSettings = false }
    }

    // MARK: Tabs

    /// Settings' tabs while Settings shows, else the sessions'.
    private func cycleAnyTabs(by offset: Int) {
        if app.showsSettings { withAnimation(.ui) { app.settingsTabs.cycle(by: offset) } } else { tabs.cycle(by: offset) }
    }

    /// ⌘W: in Settings, closes its tab, and with one left goes back to the sessions. With no tab
    /// left, it closes the window, as it does in browsers.
    private func closeAnyTab() {
        if app.showsSettings {
            if app.settingsTabs.tabs.count > 1 {
                withAnimation(.ui) { app.settingsTabs.close(app.settingsTabs.selectedID, machines: app.machines) }
            } else {
                closeSettings()
            }
        } else if let selection {
            tabs.close(selection)
        } else {
            NSApp.keyWindow?.performClose(nil)
        }
    }

    // MARK: Actions

    private var actions: SessionActions {
        let model = focusedModel
        return SessionActions(
            hasSession: model != nil,
            hasProject: focusedProject != nil,
            canStop: model?.isRunning == true,
            canReopenTab: tabs.canReopenTab,
            newSession: { tabs.newSession(in: nil) },
            newTerminalTab: { tabs.openTerminalTab(command: nil) },
            openFolder: openFolder,
            newProject: { openProjectEditor(ProjectEditorRequest(project: nil)) },
            newBot: { tabs.openBotEditor(bot: nil) },
            importBot: { if let recipe = BotRecipe.pick() { tabs.openBotEditor(bot: nil, recipe: recipe) } },
            newGroup: { tabs.openGroupEditor(group: nil) },
            newChat: { tabs.newSession(in: Workspace.chatsFolder) },
            stop: { model?.stop() },
            selectAgent: { model?.selectAgent($0) },
            togglePanel: { withAnimation(.ui) { tabs.showPanel(!panelOnScreen) } },
            showChanges: { showInPanel { utilities.showChanges() } },
            showFiles: { showInPanel { utilities.showFiles() } },
            newTerminal: { showInPanel { utilities.newTerminal(in: focusedDirectory, environment: app.shellEnvironment) } },
            run: runProject,
            newBrowser: { showInPanel { utilities.newBrowser() } },
            toggleSidebar: { withAnimation(.ui) { showSidebar(!sidebarOnScreen) } },
            nextTab: { cycleAnyTabs(by: 1) },
            previousTab: { cycleAnyTabs(by: -1) },
            closeTab: closeAnyTab,
            reopenTab: tabs.reopenClosedTab,
            find: {
                if let model { model.showFind() } else if groupID != nil { groupFind += 1 }
            },
            showTab: { number in
                if app.showsSettings {
                    withAnimation(.ui) { app.settingsTabs.show(number: number) }
                    return
                }
                tabs.show(number: number)
            },
            showProviders: { app.openSettings(.accounts) },
            openQuickly: {
                showsPalette = false
                showsOpenQuickly = true
            },
            commandPalette: {
                showsOpenQuickly = false
                showsPalette.toggle()
            }
        )
    }

    // MARK: Command palette

    /// Every session and chat not put away, the latest first, with its project.
    private var paletteSessions: [PaletteItem] {
        (workspace.projects.flatMap(\.sessions) + workspace.chats).sorted { $0.time.updated > $1.time.updated }.map { session in
            PaletteItem(id: "session:" + session.id, kind: .session, title: session.title ?? "New Session", detail: workspace.projectName(session.location.directory),
                        symbol: workspace.worktrees[session.location.directory] == nil ? "bubble.left" : "arrow.triangle.branch") { tabs.open(.session(session.id)) }
        }
    }

    /// What the menus do, with their shortcuts, and each Settings tab. The usual ones first.
    private var paletteActions: [PaletteItem] {
        let actions = actions
        var items: [PaletteItem] = []
        func add(_ title: String, _ symbol: String, _ shortcut: String? = nil, detail: String? = nil, _ run: @escaping () -> Void) {
            items.append(PaletteItem(id: "action:" + title, kind: .action, title: title, detail: detail, symbol: symbol, shortcut: shortcut, run: run))
        }
        add("New Session", "square.and.pencil", "⌘N", actions.newSession)
        if actions.hasProject {
            add("Run", "play.fill", "⌘R", detail: runCommand, actions.run)
        }
        add("New Terminal", "terminal", "⌃`", actions.newTerminal)
        add("New Terminal Tab", "apple.terminal", "⌃⇧`", actions.newTerminalTab)
        add("New Browser Tab", "globe", "⌥⌘B", actions.newBrowser)
        add("Show Changes", "plusminus", "⌥⌘I", actions.showChanges)
        if actions.hasProject {
            add("Open Quickly…", "doc.text.magnifyingglass", "⇧⌘O", actions.openQuickly)
        }
        add("Accounts…", "person.crop.circle", "⇧⌘K", actions.showProviders)
        add("Show Files", "folder", "⌥⌘F", actions.showFiles)
        add(panelOnScreen ? "Hide Panel" : "Show Panel", "sidebar.right", "⌥⌘0", actions.togglePanel)
        add(sidebarOnScreen ? "Hide Sessions" : "Show Sessions", "sidebar.left", "⌘0", actions.toggleSidebar)
        add(showsTabBar ? "Hide Tab Bar" : "Show Tab Bar", "rectangle.topthird.inset.filled", "⌥⌘T") { showsTabBar.toggle() }
        add("New Project…", "folder.badge.plus", "⇧⌘N", actions.newProject)
        add("New Bot…", "face.smiling", nil) { tabs.openBotEditor(bot: nil) }
        add("Open Folder…", "folder", "⌘O", actions.openFolder)
        if let directory = focusedProject {
            let primary = workspace.projectDirectory(directory)
            add("Edit Project…", "slider.horizontal.3", detail: workspace.projectName(primary)) {
                openProjectEditor(ProjectEditorRequest(project: workspace.projects.first { $0.directory == primary } ?? Workspace.Project(directory: primary, sessions: [], settings: workspace.settings[primary] ?? .init())))
            }
        }
        if let model = focusedModel {
            add("Build Mode", "hammer", "⌥⌘1") { actions.selectAgent("build") }
            add("Plan Mode", "list.bullet.clipboard", "⌥⌘2") { actions.selectAgent("plan") }
            add("Find in Conversation…", "magnifyingglass", "⌘F", actions.find)
            // A bot is renamed in Edit Bot.
            if bots.bot(forSession: model.id) == nil {
                add("Rename Session…", "pencil") {
                    renaming = model.session
                }
            }
        }
        if actions.canReopenTab {
            add("Reopen Closed Tab", "arrow.uturn.backward", "⇧⌘T", actions.reopenTab)
        }
        for page in SettingsPage.shown {
            add("Settings › \(page.title)", page.symbol, page == .general ? "⌘," : nil) { app.openSettings(page) }
        }
        return items
    }

    /// The run command of the project of the session you work in, if it has one.
    private var runCommand: String? { runCommand(of: focusedProject) }

    private func runCommand(of project: String?) -> String? {
        project.flatMap { workspace.settings[workspace.projectDirectory($0)]?.run }
    }

    /// Runs the project's run command in a terminal, in the session's folder (its worktree, if it
    /// has one): the session you work in, or the tab's for the title bar's button, beside its name.
    /// Without a command yet, Edit Project opens to set one.
    private func runProject() { runProject(focusedProject) }

    private func runProject(_ project: String?) {
        guard let directory = project else { return }
        guard let command = runCommand(of: directory) else {
            let primary = workspace.projectDirectory(directory)
            let project = workspace.projects.first { $0.directory == primary } ?? Workspace.Project(directory: primary, sessions: [], settings: workspace.settings[primary] ?? .init())
            openProjectEditor(ProjectEditorRequest(project: project, focusesRun: true))
            return
        }
        showInPanel { utilities.run(command, in: directory, environment: app.shellEnvironment) }
    }

    private func openFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Open"
        panel.message = "Choose a project folder for the agent to work in."
        Analytics.shared.onboardingStep("pick_project")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        tabs.newSession(in: workspace.addFolder(url.path))
    }

    #if DEBUG
    /// What the demo director may do here (KUVO_DEMO_*), as the window's own controls do it.
    private var demoWindow: DemoWindow {
        DemoWindow(
            showsSidebar: { showsSidebar },
            showSidebar: { showSidebar($0) },
            showPalette: { showsPalette = true },
            renameInView: { if let session = activeModel?.session { renaming = session } },
            runProject: { runProject() },
            newProject: { openProjectEditor(ProjectEditorRequest(project: nil, folders: $0)) }
        )
    }
    #endif
}

/// How wide each card gets in the room the window has. The conversation always
/// keeps its minimum; when space runs out, Changes shrinks first, then Sessions,
/// then Changes hides, then Sessions. Widen the window and they come back.
struct PaneLayout {
    static let sessionsRange = 220.0...440.0
    static let changesRange = 300.0...900.0
    static let splitRange = 380.0...1200.0
    static let conversationMinimum = 380.0

    /// Widths of the side cards and the split; nil when hidden (by choice, or for lack of room).
    let sessions: Double?
    let changes: Double?
    let split: Double?
    /// How wide each may be dragged right now.
    let sessionsMax: Double
    let changesMax: Double
    let splitMax: Double

    enum Pane { case sessions, changes, split }

    /// `givesWay`: out of room, the side cards go in this order.
    init(available: Double, sessions wanted: Double?, changes wantedChanges: Double?, split wantedSplit: Double? = nil, givesWay: [Pane] = [.split, .changes, .sessions]) {
        let gap = Double(Metrics.paneGap)
        var sessions = wanted.map { min(max($0, Self.sessionsRange.lowerBound), Self.sessionsRange.upperBound) }
        var changes = wantedChanges.map { min(max($0, Self.changesRange.lowerBound), Self.changesRange.upperBound) }
        var split = wantedSplit.map { min(max($0, Self.splitRange.lowerBound), Self.splitRange.upperBound) }
        func overflow(smallest: Bool = false) -> Double {
            let widths = [
                sessions.map { smallest ? Self.sessionsRange.lowerBound : $0 },
                changes.map { smallest ? Self.changesRange.lowerBound : $0 },
                split.map { smallest ? Self.splitRange.lowerBound : $0 },
            ]
            return widths.compactMap { $0.map { $0 + gap } }.reduce(0, +) + Self.conversationMinimum - available
        }
        // Out of room: those that wouldn't fit even at their smallest go, in `givesWay`'s order;
        // then the rest shrink as far as they must, the panel first and the split last.
        let wantedWidths = (sessions: sessions, changes: changes, split: split)
        var dropped: [Pane] = []
        for pane in givesWay where overflow(smallest: true) > 0 {
            switch pane {
            case .sessions: sessions = nil
            case .changes: changes = nil
            case .split: split = nil
            }
            dropped.append(pane)
        }
        // One that went early comes back if a later one's going left room for it, the last to
        // go first.
        for pane in dropped.reversed() {
            switch pane {
            case .sessions: sessions = wantedWidths.sessions
            case .changes: changes = wantedWidths.changes
            case .split: split = wantedWidths.split
            }
            guard overflow(smallest: true) > 0 else { continue }
            switch pane {
            case .sessions: sessions = nil
            case .changes: changes = nil
            case .split: split = nil
            }
        }
        if let width = changes, overflow() > 0 { changes = max(Self.changesRange.lowerBound, width - overflow()) }
        if let width = sessions, overflow() > 0 { sessions = max(Self.sessionsRange.lowerBound, width - overflow()) }
        if let width = split, overflow() > 0 { split = max(Self.splitRange.lowerBound, width - overflow()) }
        self.sessions = sessions
        self.changes = changes
        self.split = split
        let room = available - Self.conversationMinimum
        sessionsMax = min(Self.sessionsRange.upperBound, room - gap - (changes.map { $0 + gap } ?? 0) - (split.map { $0 + gap } ?? 0))
        changesMax = min(Self.changesRange.upperBound, room - gap - (sessions.map { $0 + gap } ?? 0) - (split.map { $0 + gap } ?? 0))
        splitMax = min(Self.splitRange.upperBound, room - gap - (sessions.map { $0 + gap } ?? 0) - (changes.map { $0 + gap } ?? 0))
    }
}

/// The engine is taking a while, most often because macOS is asking whether it may
/// read a folder (Claude skills or a project on the Desktop, say) and waiting for an answer.
private struct SlowEngineNotice: View {
    var body: some View {
        HStack(spacing: 10) {
            Spinner(size: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text("Still loading your accounts and models…")
                    .font(.callout.weight(.medium))
                Text("If macOS is asking for access to a folder, answer that dialog.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .glassEffect(.regular, in: .capsule)
    }
}

/// Which project sheet to show: New Project, or Edit Project for `project`.
/// The bot editor: a new bot, or changing `bot`.
/// A chat's way into one of this Mac's projects, in its header.
private struct MoveToProjectButton: View {
    let sessionID: String
    @Environment(Workspace.self) private var workspace

    var body: some View {
        NativeMenuButton(opensBelow: true) {
            let menu = NSMenu()
            // The projects on its computer (a chat moved to a machine, that machine's).
            let machine = workspace.session(sessionID).flatMap { RemoteFolder.machine(of: $0.location.directory) }
            let projects = workspace.projects.filter { RemoteFolder.machine(of: $0.directory) == machine }
            menu.addItem(.sectionHeader(title: "Move to Project"))
            for project in projects {
                menu.addItem(ActionItem(project.name, image: NSImage(systemSymbolName: "folder", accessibilityDescription: nil)) { move(to: project.directory) })
            }
            if projects.isEmpty {
                let none = NSMenuItem(title: machine.map { "No projects on \($0)" } ?? "No projects on this Mac", action: nil, keyEquivalent: "")
                none.isEnabled = false
                menu.addItem(none)
            }
            return menu
        } label: {
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 13))
                .frame(width: 26, height: 24)
                .hoverHighlight(in: RoundedRectangle(cornerRadius: 6), mutesInk: true)
        }
        .help("Move to Project: carry this chat into one of your projects")
        .accessibilityLabel("Move to Project")
    }

    private func move(to directory: String) {
        Task {
            do {
                try await workspace.move(sessionID, toProject: directory)
            } catch {
                Modal.show(error)
            }
        }
    }
}

struct BotEditorRequest: Identifiable {
    let id = UUID()
    let bot: Bot?
    /// A shared bot a new one starts from.
    var recipe: BotRecipe?
}

struct GroupEditorRequest: Identifiable {
    let id = UUID()
    let group: BotGroup?
}

struct ProjectEditorRequest: Identifiable {
    let id = UUID()
    let project: Workspace.Project?
    /// Folders a new project starts with.
    var folders: [String] = []
    /// Puts the cursor in the run command, for Run without one.
    var focusesRun = false
}

/// The app's icon, the `>_` mark, as the system renders it (glass and all).
struct AppLogo: View {
    let size: CGFloat

    var body: some View {
        Image(nsImage: NSApp.applicationIconImage)
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Shown before there's any project.
struct WelcomeView: View {
    @Environment(Catalog.self) private var catalog
    let openFolder: () -> Void
    let newChat: () -> Void
    let showProviders: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            AppLogo(size: 76)
            Text("Welcome to \(AppInfo.name)")
                .font(.largeTitle.weight(.semibold))
            Text("Open a project folder and tell the agent what to build.\nIt can read, edit and run things there.")
                .font(.title3)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 12) {
                Button("Open Folder…", systemImage: "folder", action: openFolder)
                    .buttonStyle(.glassProminent)
                Button("Start a Chat", systemImage: "bubble.left", action: newChat)
                    .buttonStyle(.glass)
                    .help("A conversation of no project (⌥⌘N)")
                Button(catalog.connectedProviders.isEmpty ? "Connect an Account…" : "Accounts…", systemImage: "person.crop.circle.badge.plus", action: showProviders)
                    .buttonStyle(.glass)
            }
            .controlSize(.extraLarge)
            .padding(.top, 8)
            if catalog.connectedProviders.isEmpty {
                Text("Free models work without an account.")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { Analytics.shared.onboardingStep("welcome") }
    }
}
