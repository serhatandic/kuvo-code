import OpenCodeKit
import os
import SwiftUI

/// The workspace, laid out like Rex: open sessions as tabs in the title bar, and
/// cards floating on the window's glass (sessions, the conversation, changes).
struct MainView: View {
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    @Environment(Workspace.self) private var workspace
    @Environment(Bots.self) private var bots
    @Environment(GroupChats.self) private var groups

    /// Open tabs, in order: session IDs, or `draft:<folder>` for a new session
    /// that doesn't exist on the server until its first message.
    @SceneStorage("tabs") private var tabStorage = ""
    /// The active tab.
    @SceneStorage("selection") private var selection: String?
    @SceneStorage("showsSidebar") private var showsSidebar = true
    /// The row at the top: the project, its branch and the tabs. Hidden, sessions are switched
    /// from the sidebar or ⌘K.
    @AppStorage(TabBar.showsKey) private var showsTabBar = TabBar.showsByDefault
    /// The window is being resized.
    @State private var window = WindowStateReader.State()
    @SceneStorage("showsPanel") private var showsPanel = false
    /// The panel over the conversation, for room.
    /// Goes up for ⌘F in the group chat in view.
    @State private var groupFind = 0
    @State private var panelExpanded = false
    /// Out of room, the side cards give way in this order: the one opened last stays. A split you
    /// didn't just open (one restored, or met again on its tab) goes first.
    @State private var givesWay: [PaneLayout.Pane] = [.split, .changes, .sessions]
    /// The tab whose split you opened (or swapped) last: there it keeps its place in `givesWay`;
    /// another tab's, met again, gives way first.
    @State private var keptSplit: String?
    /// The room the conversation and the panel share: what the panel takes, expanded.
    @State private var mainAreaWidth: CGFloat = 0
    @AppStorage("sessionsWidth") private var sessionsWidth = 280.0
    @AppStorage("changesWidth") private var changesWidth = 420.0
    @AppStorage(Notifier.badgeKey) private var showsBadge = true
    /// New Project or Edit Project, in a popup while it's open.
    @State private var projectEditor: ProjectEditorRequest?
    /// Making or changing a bot, in the main card while it's open.
    @State private var botEditor: BotEditorRequest?
    /// Making or changing a group chat, the same way.
    @State private var groupEditor: GroupEditorRequest?
    @State private var focus = Pane.conversation
    /// The half of the conversation you worked in last (a click in the panel or the sidebar
    /// isn't working in either): a tab you pick in the panel is its agent's.
    @State private var lastHalf = Pane.conversation
    /// Tabs you closed, last one last, with where they were: ⇧⌘T opens them again.
    @State private var closedTabs: [ClosedTab] = []
    /// Goes up to put the cursor in a new session's composer.
    @State private var draftFocus = 0
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

    enum Pane { case sessions, conversation, split, changes }

    /// Split views, as pairs: a tab and the session beside it, kept with the tab as a browser's split
    /// tabs are, one "<tab>=<session>" a line. Choosing another tab shows it alone; the pair comes
    /// back with its tab. Kept with the window's tabs, so the two never disagree.
    @SceneStorage("splitPairs") private var splitStorage = ""

    private var splitPairs: [String: String] {
        get {
            Dictionary(splitStorage.split(separator: "\n").compactMap { line in
                let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
                return parts.count == 2 ? (parts[0], parts[1]) : nil
            }, uniquingKeysWith: { first, _ in first })
        }
        nonmutating set {
            splitStorage = newValue.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "\n")
        }
    }

    /// The session beside the tab in view, or empty.
    private var splitSession: String { selection.flatMap { splitPairs[$0] } ?? "" }
    @AppStorage("splitWidth") private var splitWidth = 560.0

    struct ClosedTab {
        var key: String
        var index: Int
        /// The session that was beside it, back with it.
        var beside: String?
        /// The tab it was beside, which it goes back beside if it still can.
        var besideOf: String?
    }

    private var tabs: [String] {
        get { tabStorage.split(separator: "\n").map(String.init) }
        nonmutating set { tabStorage = newValue.joined(separator: "\n") }
    }

    private var utilities: Utilities { app.utilities }

    private var sessionID: String? {
        selection.flatMap { SidebarView.draftDirectory(from: $0) == nil && BotGroups.groupID(fromTab: $0) == nil && !MainTerminals.isTerminal($0) ? $0 : nil }
    }

    /// The group chat in view.
    private var groupID: String? {
        selection.flatMap(BotGroups.groupID(fromTab:))
    }

    /// The browser tabs of the bots on this Mac in view, a bot's or a group chat's, beside yours.
    private func showBotTabs() {
        let inView = groupID.flatMap { groups.group($0)?.members.compactMap { bots.bot($0) } } ?? [bots.bot(forSession: sessionID)].compactMap { $0 }
        utilities.botsInView = Set(inView.filter { $0.machine == nil }.map(\.id))
        // Its bots' seats are in view too: what they show you opens.
        utilities.groupInView = groupID.map(BotGroups.tabKey)
    }

    private var draftDirectory: String? {
        selection.flatMap(SidebarView.draftDirectory(from:))
    }

    private var activeModel: SessionModel? {
        sessionID.flatMap(workspace.model(for:))
    }

    /// The session you're working in: the one beside, once you've clicked into it (and while you
    /// use the panel or the sidebar after, as the panel stays its). The menus' commands (Stop,
    /// Find, the modes) go to it.
    private var focusedModel: SessionModel? {
        worksBeside ? splitModel : activeModel
    }

    /// The last half you worked in is the one beside: the panel is its, and the commands go to it.
    /// It stays so while the expanded panel covers it (the panel is still its), not once it gave
    /// way for want of room.
    private var worksBeside: Bool {
        lastHalf == .split && splitModel != nil && paneLayout(available: contentWidth).split != nil
    }

    /// The session beside you work in, if you do.
    private var workedBesideID: String? {
        worksBeside ? splitModel?.id : nil
    }

    /// The sessions on screen: the tab's, and the one beside it.
    private var sessionsInView: [String] {
        [sessionID, besideID].compactMap(\.self)
    }

    /// The session beside the tab's, while it shows: with room for it in the window, and not under
    /// the expanded panel. One that gave way is out of view: not read, nor working there.
    private var besideID: String? {
        guard let splitModel, paneLayout(available: contentWidth).split != nil, !(showsPanel && panelExpanded) else { return nil }
        return splitModel.id
    }

    /// When the sessions on screen last finished.
    private var idlesInView: [Milliseconds?] {
        sessionsInView.map { workspace.session($0)?.time.idle }
    }

    /// The sessions on screen count as seen.
    private func markViewed() {
        for id in sessionsInView { workspace.markViewed(id) }
    }

    /// The active tab's project folder.
    private var activeDirectory: String? {
        activeModel?.session.location.directory ?? draftDirectory ?? selection.flatMap { terminals.entry($0)?.directory }
    }

    /// The active tab's folder when it's a project's: not the chats' folder or a bot's own.
    private var activeProject: String? {
        activeDirectory.flatMap { Workspace.isChat($0) || Workspace.isBotFolder($0) ? nil : $0 }
    }

    /// The folder of the session you're working in: the one beside, once you've clicked into it.
    /// Run, a new terminal and Open Quickly go there, as Stop goes to its session.
    private var focusedDirectory: String? {
        worksBeside ? splitModel?.session.location.directory ?? activeDirectory : activeDirectory
    }

    /// The focused session's folder when it's a project's.
    private var focusedProject: String? {
        focusedDirectory.flatMap { Workspace.isChat($0) || Workspace.isBotFolder($0) ? nil : $0 }
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
        .onChange(of: utilities.revealRequest) { withAnimation(.ui) { showPanel() } }
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
                        initialQuery: Self.demoPaletteQuery,
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
        // The panel's browser is that of the place the session in view runs: this Mac's, or its
        // machine's.
        .onChange(of: focusedDirectory, initial: true) { _, directory in
            utilities.place = directory.flatMap(RemoteFolder.machine(of:))
        }
        // Its agent's browsing brings pages forward; others' stay where they are.
        .onChange(of: sessionID, initial: true) { _, id in
            utilities.sessionInView = id
            showBotTabs()
        }
        // The one beside it shows you files in the panel too.
        .onChange(of: besideID, initial: true) { _, id in utilities.besideInView = id }
        // Another tab: you're back in its own conversation, not the one beside the last (whatever
        // had the keyboard: the panel or the sidebar keep the last half otherwise).
        .onChange(of: selection) {
            if focus == .split { focus = .conversation }
            lastHalf = .conversation
        }
        // Another session beside: you work in the tab's until you click into it.
        .onChange(of: splitModel?.id) { lastHalf = .conversation }
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
            if request.project == nil { newSession(in: primary) }
        } close: {
            projectEditor = nil
        }
    }

    var body: some View {
        followingSessions
        // A tab you pick is the agent's of the half you work in.
        .onChange(of: focus) { _, pane in if pane == .conversation || pane == .split { lastHalf = pane } }
        .onChange(of: workedBesideID, initial: true) { _, id in
            utilities.workedBeside = id
            utilities.worksBeside = id != nil
        }
        .onChange(of: groupID) { showBotTabs() }
        .onChange(of: groupID.flatMap { groups.group($0)?.members } ?? []) { showBotTabs() }
        .task(id: activeDirectory) {
            if let activeDirectory { await workspace.loadBranch(for: activeDirectory) }
        }
        .onChange(of: workspace.sessions.map(\.id)) { _, ids in dropClosedSessions(ids) }
        .onChange(of: groups.list.map(\.id)) { dropClosedSessions(workspace.sessions.map(\.id)) }
        .onChange(of: workspace.isLoaded) {
            // The list arrives just before loading counts as done, so check it again here.
            dropClosedSessions(workspace.sessions.map(\.id))
            startIfEmpty()
        }
        .onAppear(perform: startIfEmpty)
        .onAppear { Notifier.shared.open = { openTab($0) } }
        .onAppear { utilities.addToMessage = { addToMessage($0) } }
        .onAppear { utilities.attachToMessage = { attachToMessage($0) } }
        .onChange(of: workspace.requestedTab) { _, id in
            guard let id else { return }
            openTab(id)
            workspace.requestedTab = nil
        }
        .onChange(of: workspace.swappedTab) { _, swap in
            // Only the window the session's tab is in (another window leaves it).
            guard let swap, tabs.contains(swap.from) || splitPairs.values.contains(swap.from) else { return }
            workspace.swappedTab = nil
            swapTab(swap.from, with: swap.to)
        }
        // From outside the window: a folder opened with Kuvo Code, or the Dock menu.
        .onChange(of: app.request, initial: true) { _, request in
            guard let request else { return }
            app.request = nil
            switch request {
            case .folder(let path):
                newSession(in: workspace.addFolder(path))
            case .session(let id):
                openTab(id)
            case .newSession:
                newSession(in: nil)
            case .bot(let recipe):
                openBotEditor(bot: nil, recipe: recipe)
            }
        }
        .onChange(of: workspace.waitingCount, initial: true) { Notifier.shared.setBadge(workspace.waitingCount) }
        .onChange(of: showsBadge) { Notifier.shared.setBadge(workspace.waitingCount) }
        // Another tab: a rename in the last one's header ends, keeping what was typed.
        .onChange(of: selection) { _, id in if renaming?.id != id { renaming = nil } }
        #if DEBUG
        .task(id: workspace.isLoaded) { await runDemoIfAsked() }
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
                TabStrip(tabs: tabItems, selection: $selection, close: { closeTab($0) }, closeAll: closeTabs(except:), openBeside: besideOpener, closeBeside: closeBeside, closeBesideTab: closeBesideTab, swapBeside: swapBeside) { id in
                    guard let session = workspace.session(id) else { return }
                    // Renamed in its card's header: its tab comes forward for it.
                    selection = id
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
        let pairs = splitPairs
        return tabs.compactMap { key in
            guard var item = tabItem(for: key) else { return nil }
            if let beside = pairs[key], let other = tabItem(for: beside) { item.companion = [other] }
            return item
        }
    }

    private func tabItem(for key: String) -> TabItem? {
        do {
            if let directory = SidebarView.draftDirectory(from: key) {
                return TabItem(id: key, title: Workspace.isChat(directory) ? "New Chat" : "New Session", logo: nil, status: .idle)
            }
            if let entry = terminals.entry(key) {
                return TabItem(id: key, title: entry.session.title == "Terminal" ? entry.label : entry.session.title, logo: nil, status: .idle, symbol: "apple.terminal")
            }
            if workspace.waitingMachine(for: key) != nil {
                return TabItem(id: key, title: workspace.remoteTitle(key) ?? "Session", logo: nil, status: .idle)
            }
            if let id = BotGroups.groupID(fromTab: key) {
                guard let group = groups.group(id) else { return nil }
                let status: TabItem.Status = groups.discussing.contains(id) ? .working : groups.isUnread(group) && groupID != id ? .unread : .idle
                return TabItem(id: key, title: group.name, logo: nil, group: faces(of: group), status: status)
            }
            guard let session = workspace.session(key) else { return nil }
            if let bot = bots.bot(forSession: key) {
                return TabItem(id: key, title: bot.name, logo: nil, bot: bot.look, botMood: bots.mood(of: bot, in: workspace), status: status(of: session))
            }
            return TabItem(id: key, title: session.title ?? "New Session", logo: logo(for: session.model, in: session.location.directory), status: status(of: session))
        }
    }

    /// Bots moving in the main card (working in their conversation, talking in a group chat, being
    /// edited): their sidebar rows hold still meanwhile, so each moves in one place at a time.
    /// An idle bot whose conversation is open moves in the sidebar, as nothing in its conversation does.
    private var stagedBots: Set<String> {
        if let request = botEditor { return Set([request.bot?.id].compactMap(\.self)) }
        if groupEditor != nil { return [] }
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
                selection: Binding(get: { selection }, set: { id in if let id { openTab(id) } }),
                newSession: { newSession(in: $0) },
                newProject: { openProjectEditor(ProjectEditorRequest(project: nil)) },
                editProject: { openProjectEditor(ProjectEditorRequest(project: $0)) },
                showProviders: { app.openSettings(.accounts) },
                newBot: { openBotEditor(bot: nil) },
                editBot: { openBotEditor(bot: $0) },
                newGroup: { openGroupEditor(group: nil) },
                editGroup: { openGroupEditor(group: $0) },
                newConversation: { openTab(SidebarView.draftTag($0)) },
                closeTerminal: { closeTab($0) },
                stagedBots: stagedBots,
                openBeside: besideOpener
            )
            // Room for the window's buttons above the first row, when they sit here.
            .padding(.top, showsTabBar ? 0 : Metrics.windowControlsHeight)
        }
        .overlay(alignment: .top) {
            if !showsTabBar { WindowDragArea().frame(height: Metrics.windowControlsHeight) }
        }
        .simultaneousGesture(TapGesture().onEnded { focus = .sessions })
    }

    /// The session in split view, while it's another than the one in view.
    private var splitModel: SessionModel? {
        guard !splitSession.isEmpty, splitSession != sessionID, workspace.session(splitSession) != nil else { return nil }
        return workspace.model(for: splitSession)
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
            Button("Swap", systemImage: "arrow.left.arrow.right") { swapSplit() }
                .help("Swap the two sessions")
            Button("Close Split View", systemImage: "xmark") { if let selection { closeBeside(selection) } }
                .help("Close Split View")
        } content: {
            SessionView(model: model)
                .environment(\.bot, bot)
                // Return and Esc answer its cards once you've clicked or typed into it.
                .environment(\.takesCardKeys, focus == .split)
                .environment(\.composerFocused) { focus = .split }
                .largeWidgetHost()
        }
        .onTitle(bot.map { "Edit \($0.name)" }, bot.map { bot in { openBotEditor(bot: bot) } })
        .environment(catalog(for: directory))
        .id("split-" + id)
        .simultaneousGesture(TapGesture().onEnded { focus = .split })
    }

    /// Open Beside, while a session can open beside the tab in view: it's a session's (not a
    /// draft or a group chat).
    private var besideOpener: ((String) -> Void)? {
        guard let sessionID, workspace.session(sessionID) != nil else { return nil }
        return { openBeside($0) }
    }

    /// Shows `id` beside the tab in view, the two as one tab. Its own tab, if it had one, goes into
    /// the pair; one beside before gets its tab back, next to it.
    private func openBeside(_ id: String) {
        guard let main = selection, main != id, workspace.session(main) != nil, workspace.session(id) != nil else { return }
        var pairs = splitPairs
        var tabs = tabs
        // It's in no other pair, nor has one of its own.
        if let other = pairs.removeValue(forKey: id), !tabs.contains(other) { tabs.insert(other, at: (tabs.firstIndex(of: id) ?? tabs.count - 1) + 1) }
        for (key, value) in pairs where value == id { pairs[key] = nil }
        if let previous = pairs[main], !tabs.contains(previous) { tabs.insert(previous, at: (tabs.firstIndex(of: main) ?? tabs.count - 1) + 1) }
        tabs.removeAll { $0 == id }
        pairs[main] = id
        withAnimation(.ui) {
            self.tabs = tabs
            splitPairs = pairs
            keep(.split)
            keptSplit = main
        }
        // Its composer takes the keyboard, if there's room for it: the menus' commands go to it.
        if paneLayout(available: contentWidth).split != nil { focus = .split }
    }

    /// Close Split View: the two go back to tabs of their own, the one beside next to `tab`.
    private func closeBeside(_ tab: String) {
        guard let beside = splitPairs[tab] else { return }
        var tabs = tabs
        if !tabs.contains(beside) { tabs.insert(beside, at: (tabs.firstIndex(of: tab) ?? tabs.count - 1) + 1) }
        withAnimation(.ui) {
            self.tabs = tabs
            splitPairs[tab] = nil
        }
    }

    /// Closes the session beside `tab`'s (its half of the tab): ⇧⌘T brings it back beside it.
    private func closeBesideTab(_ tab: String) {
        guard let beside = splitPairs[tab] else { return }
        Analytics.shared.sessionEnded(beside)
        rememberClosed([ClosedTab(key: beside, index: (tabs.firstIndex(of: tab) ?? tabs.count - 1) + 1, besideOf: tab)])
        withAnimation(.ui) { splitPairs[tab] = nil }
    }

    /// The two in `tab`'s pair trade places, the tab staying where it is.
    private func swapBeside(_ tab: String) {
        guard let other = splitPairs[tab] else { return }
        var pairs = splitPairs
        pairs[tab] = nil
        pairs[other] = tab
        // One tab for the two: a tab of its own it had goes.
        var tabs = tabs.filter { $0 != other }
        if let index = tabs.firstIndex(of: tab) { tabs[index] = other }
        self.tabs = tabs
        splitPairs = pairs
        if keptSplit == tab { keptSplit = other }
        if selection == tab { selection = other }
    }

    private func swapSplit() {
        if let selection { swapBeside(selection) }
    }

    @ViewBuilder private var conversationCard: some View {
        Group {
            if let request = groupEditor {
                Card(title: request.group.map { "Edit \($0.name)" } ?? "New Group Chat", isFocused: focus == .conversation) {
                    if let group = request.group { GroupAvatar(faces: faces(of: group), size: 20) } else { Image(systemName: "person.2") }
                } actions: {
                    Button("Close", systemImage: "xmark") { withAnimation(.ui) { groupEditor = nil } }
                        .help("Close")
                } content: {
                    GroupEditor(group: request.group, newBot: { openBotEditor(bot: nil) }) {
                        withAnimation(.ui) { groupEditor = nil }
                    } created: { group in
                        openTab(BotGroups.tabKey(group.id))
                    }
                }
                .id(request.id)
            } else if let request = botEditor {
                Card(title: request.bot.map { "Edit \($0.name)" } ?? "New Bot", isFocused: focus == .conversation) {
                    if let bot = request.bot { BotAvatar(look: bot.look, size: 18, animates: false) } else { Image(systemName: "face.smiling") }
                } actions: {
                    Button("Close", systemImage: "xmark") { withAnimation(.ui) { botEditor = nil } }
                        .help("Close")
                } content: {
                    BotEditor(bot: request.bot, recipe: request.recipe) {
                        // This editor's, not one opened since (a delete that took a while).
                        if botEditor?.id == request.id { withAnimation(.ui) { botEditor = nil } }
                    } created: { bot in
                        // Its tab opens in place of this editor, not of one opened since.
                        if botEditor?.id == request.id { openTab(bot.sessionID) }
                    }
                }
                .id(request.id)
            } else if let key = selection, let entry = terminals.entry(key) {
                Card(title: entry.session.title == "Terminal" ? entry.label : entry.session.title, detail: workspace.projectName(entry.directory), isFocused: focus == .conversation) {
                    Image(systemName: "apple.terminal")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { closeTab(key) }
                        .help("Close Tab")
                } content: {
                    TerminalHost(session: entry.session)
                }
                .id(key)
            } else if let id = groupID, let group = groups.group(id) {
                Card(title: group.name, detail: groupDetail(group), isFocused: focus == .conversation) {
                    GroupAvatar(faces: faces(of: group), size: 20)
                } actions: {
                    Button("Edit Group Chat", systemImage: "slider.horizontal.3") { openGroupEditor(group: group) }
                        .help("Edit Group Chat: its name, bots and lead")
                        .disabled(app.moves.isMoving(group.id))
                    Button("Close Tab", systemImage: "xmark") { closeTab(BotGroups.tabKey(id)) }
                        .help("Close Tab")
                } content: {
                    GroupChatView(group: group, findRequest: groupFind)
                        .largeWidgetHost()
                }
                .onTitle("Edit Group Chat", app.moves.isMoving(group.id) ? nil : { openGroupEditor(group: group) })
                .id(BotGroups.tabKey(id))
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
                        Button("Edit Bot", systemImage: "slider.horizontal.3") { openBotEditor(bot: bot) }
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
                    Button("Close Tab", systemImage: "xmark") { closeTab(id) }
                        .help("Close Tab")
                } content: {
                    SessionView(model: model)
                        .environment(\.bot, bot)
                        .environment(\.takesCardKeys, !(focus == .split && besideID != nil))
                        // Typing here is working here, however the keyboard got here.
                        .environment(\.composerFocused) { focus = .conversation }
                        .largeWidgetHost()
                }
                .onTitle(bot.map { "Edit \($0.name)" }, bot.map { bot in { openBotEditor(bot: bot) } })
                .environment(catalog(for: directory))
            } else if let id = sessionID, let engine = app.machines.engine(workspace.waitingMachine(for: id)) {
                Card(title: workspace.remoteTitle(id) ?? "Session", detail: engine.machine.name, isFocused: focus == .conversation) {
                    Image(systemName: "server.rack")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { closeTab(id) }
                        .help("Close Tab")
                } content: {
                    MachineWaitingView(engine: engine)
                }
                .id(id)
            } else if let directory = draftDirectory, let engine = machine(for: directory), !engine.isReady {
                Card(title: "New Session", detail: workspace.projectName(directory), isFocused: focus == .conversation) {
                    Image(systemName: "square.and.pencil")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { closeTab(SidebarView.draftTag(directory)) }
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
                    Button("Close Tab", systemImage: "xmark") { closeTab(SidebarView.draftTag(directory)) }
                        .help("Close Tab")
                } content: {
                    DraftSessionView(directory: directory, focusRequest: draftFocus) { session, text, files in
                        // The first takes the draft's tab and stays in view; more attempts open at the end.
                        let draft = SidebarView.draftTag(directory)
                        if tabs.contains(draft) {
                            utilities.adoptDraft(as: session.id)
                            replaceTab(draft, with: session.id)
                        } else if !tabs.contains(session.id) {
                            tabs.append(session.id)
                        }
                        workspace.model(for: session.id)?.submit(text, files: files, for: catalog.model(session.model), queue: false, commands: catalog.commands(in: directory))
                    }
                }
                .environment(catalog)
                .id(directory)
            } else {
                Card(title: AppInfo.name, isFocused: focus == .conversation) {
                    AppLogo(size: 16)
                } content: {
                    WelcomeView(openFolder: openFolder, newChat: { newSession(in: Workspace.chatsFolder) }, showProviders: { app.openSettings(.accounts) })
                }
            }
        }
        .simultaneousGesture(TapGesture().onEnded { focus = .conversation })
        // What you open last keeps its place when the window is short of room (a split, from
        // Open Beside: coming back to a tab that has one isn't opening it).
        .onChange(of: showsSidebar) { _, shows in if shows { keep(.sessions) } }
        .onChange(of: showsPanel) { _, shows in if shows { keep(.changes) } }
        // A session an agent started: beside the conversation that started it, if that's the one
        // in view; otherwise (or asked to) in a tab of its own, for you to find.
        .onChange(of: workspace.besideRequest) { _, request in
            guard let request else { return }
            workspace.besideRequest = nil
            if request.beside, request.startedBy == sessionID {
                openBeside(request.session)
            } else if !tabs.contains(request.session), !splitPairs.values.contains(request.session) {
                tabs.append(request.session)
            }
        }
    }

    private func paneLayout(available: Double) -> PaneLayout {
        PaneLayout(
            available: available,
            sessions: showsSidebar ? sessionsWidth : nil,
            changes: showsPanel ? changesWidth : nil,
            split: splitModel == nil ? nil : splitWidth,
            givesWay: selection != nil && selection == keptSplit ? givesWay : [.split] + givesWay.filter { $0 != .split }
        )
    }

    /// Whether the panel and the sidebar are on screen: wanted, and with room for them.
    private var panelOnScreen: Bool {
        showsPanel && (panelExpanded || paneLayout(available: contentWidth).changes != nil)
    }

    private var sidebarOnScreen: Bool {
        showsSidebar && paneLayout(available: contentWidth).sessions != nil
    }

    /// Showing one that's wanted but out of room makes room for it, as the one opened last.
    private func showPanel(_ shows: Bool = true) {
        showsPanel = shows
        if shows { keep(.changes) }
    }

    private func showSidebar(_ shows: Bool) {
        showsSidebar = shows
        if shows { keep(.sessions) }
    }

    /// The panel's and the sidebar's buttons, which show what's on screen.
    private var panelToggle: Binding<Bool> { Binding(get: { panelOnScreen }, set: { showPanel($0) }) }
    /// Room kept free in the title bar while the window is dragged narrower: its width reaches
    /// the tabs a pass late, and a strip wider than the room left would be put away in the
    /// toolbar's overflow and back, again and again.
    private var resizeRoom: CGFloat { window.isResizing ? 72 : 0 }

    private var sidebarToggle: Binding<Bool> { Binding(get: { sidebarOnScreen }, set: { showSidebar($0) }) }

    private func keep(_ pane: PaneLayout.Pane) {
        givesWay.removeAll { $0 == pane }
        givesWay.append(pane)
    }

    private var utilitiesPane: some View {
        // The panel of the session you work in (the one beside, as its panel is then): its changes,
        // files and terminals.
        UtilitiesPane(
            utilities: utilities,
            directory: focusedDirectory,
            folders: focusedDirectory.map { [$0] + workspace.extraFolders($0) } ?? [],
            model: focusedModel,
            environment: app.shellEnvironment,
            isExpanded: $panelExpanded,
            isFocused: focus == .changes
        )
        .environment(catalog(for: focusedDirectory))
        .simultaneousGesture(TapGesture().onEnded { focus = .changes })
    }

    /// Opens the panel on a tool.
    private func showInPanel(_ open: () -> Void) {
        withAnimation(.ui) {
            open()
            showPanel()
            app.showsSettings = false
        }
    }

    /// Makes a bot (from a shared one's `recipe`, if given), or changes `bot`, in the main card.
    private func openBotEditor(bot: Bot?, recipe: BotRecipe? = nil) {
        withAnimation(.ui) {
            panelExpanded = false
            app.showsSettings = false
            groupEditor = nil
            botEditor = BotEditorRequest(bot: bot, recipe: recipe)
        }
        focus = .conversation
    }

    /// Makes a project, or changes one, in a popup over what's in the window. One open already
    /// stays, with what's typed in it: a shortcut or a session opened from a notification
    /// doesn't take its place.
    private func openProjectEditor(_ request: ProjectEditorRequest) {
        guard projectEditor == nil else { return }
        projectEditor = request
    }

    /// Makes a group chat, or changes `group`, in the main card.
    private func openGroupEditor(group: BotGroup?) {
        withAnimation(.ui) {
            panelExpanded = false
            app.showsSettings = false
            botEditor = nil
            groupEditor = GroupEditorRequest(group: group)
        }
        focus = .conversation
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

    /// A page of Settings as the demo variables name it: `permissions`, or `permissions@<machine>`.
    private static func demoPage(_ text: String) -> (SettingsPage?, SidebarBox) {
        let parts = text.split(separator: "@", maxSplits: 1).map(String.init)
        return (SettingsPage(rawValue: parts[0]), parts.count > 1 ? .machine(parts[1]) : .mac)
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

    /// Shows a session or draft, opening a tab for it next to the current one if needed.
    private func openTab(_ key: String) {
        // The session beside a tab: that tab, with it beside.
        let key = splitPairs.first { $0.value == key && tabs.contains($0.key) }?.key ?? key
        var tabs = tabs
        if !tabs.contains(key) {
            let index = selection.flatMap { tabs.firstIndex(of: $0) }.map { $0 + 1 } ?? tabs.count
            tabs.insert(key, at: index)
            self.tabs = tabs
        }
        withAnimation(.ui) {
            selection = key
            focus = .conversation
            app.showsSettings = false
            botEditor = nil
            groupEditor = nil
        }
    }

    /// Closes a tab; one you close (rather than a deleted session's) can be reopened.
    private func closeTab(_ key: String, remember: Bool = true) {
        var tabs = tabs
        guard let index = tabs.firstIndex(of: key) else { return }
        tabs.remove(at: index)
        Analytics.shared.sessionEnded(key)
        let beside = splitPairs[key]
        if let beside {
            Analytics.shared.sessionEnded(beside)
            splitPairs[key] = nil
        }
        if remember && !MainTerminals.isTerminal(key) { rememberClosed([ClosedTab(key: key, index: index, beside: beside)]) }
        terminals.close(key)
        withAnimation(.ui) {
            self.tabs = tabs
            if selection == key {
                selection = tabs.indices.contains(index) ? tabs[index] : tabs.last
            }
        }
    }

    /// Closes every tab but `key`, or all of them when it's nil.
    private func closeTabs(except key: String?) {
        // Reopened last first, so the leftmost comes back last.
        let pairs = splitPairs
        rememberClosed(tabs.enumerated().filter { $0.element != key && !MainTerminals.isTerminal($0.element) }.map { ClosedTab(key: $0.element, index: $0.offset, beside: pairs[$0.element]) }.reversed())
        for closed in tabs where closed != key {
            Analytics.shared.sessionEnded(closed)
            terminals.close(closed)
            if let beside = splitPairs[closed] { Analytics.shared.sessionEnded(beside) }
        }
        withAnimation(.ui) {
            tabs = tabs.filter { $0 == key }
            splitPairs = splitPairs.filter { $0.key == key }
            selection = key
        }
    }

    private func rememberClosed(_ closed: [ClosedTab]) {
        closedTabs.append(contentsOf: closed)
        if closedTabs.count > 50 { closedTabs.removeFirst(closedTabs.count - 50) }
    }

    /// In a tab, or beside one.
    private func isOpen(_ key: String) -> Bool {
        tabs.contains(key) || splitPairs.values.contains(key)
    }

    /// Not open again already, and not a session deleted since.
    private func canReopen(_ closed: ClosedTab) -> Bool {
        !isOpen(closed.key) && (SidebarView.draftDirectory(from: closed.key) != nil || workspace.session(closed.key) != nil
            || groups.group(BotGroups.groupID(fromTab: closed.key)) != nil)
    }

    /// Opens the tab closed last, where it was, skipping sessions deleted since. A pair comes back
    /// as a pair, and a session closed from beside a tab goes back beside it.
    private func reopenClosedTab() {
        while let closed = closedTabs.popLast() {
            guard canReopen(closed) else { continue }
            var tabs = tabs
            var pairs = splitPairs
            let shown: String
            if let partner = closed.besideOf, tabs.contains(partner), pairs[partner] == nil {
                pairs[partner] = closed.key
                shown = partner
            } else {
                tabs.insert(closed.key, at: min(closed.index, tabs.count))
                if let beside = closed.beside, !isOpen(beside), workspace.session(beside) != nil { pairs[closed.key] = beside }
                shown = closed.key
            }
            withAnimation(.ui) {
                self.tabs = tabs
                splitPairs = pairs
                selection = shown
                focus = .conversation
            }
            return
        }
    }

    /// Where the panel's Add to Message goes: the session you work in, the one beside once you've
    /// clicked into it (the panel is its), else the tab's.
    private var messageTarget: String? { workedBesideID ?? selection }

    /// Adds a file's lines ("@src/App.swift:12-20") or a terminal's output to what's in the
    /// composer of the session you work in, and puts the cursor there.
    private func addToMessage(_ addition: String) {
        composerForAdding()
        guard let key = messageTarget else { return }
        var text = Drafts.shared[key].text
        let isBlock = addition.hasPrefix("```")
        if !text.isEmpty {
            if isBlock { if !text.hasSuffix("\n") { text += "\n" } } else if !(text.last?.isWhitespace ?? true) { text += " " }
        }
        Drafts.shared[key].text = text + addition + (isBlock ? "\n" : " ")
        if SidebarView.draftDirectory(from: key) != nil { draftFocus += 1 } else { workspace.model(for: key)?.focusComposer() }
        focus = worksBeside ? .split : .conversation
    }

    /// Attaches files to the message in the composer of the session you work in, and puts the
    /// cursor there.
    private func attachToMessage(_ files: [URL]) {
        composerForAdding()
        guard let key = messageTarget else { return }
        Drafts.shared[key].files += files.filter { !Drafts.shared[key].files.contains($0) }
        if SidebarView.draftDirectory(from: key) != nil { draftFocus += 1 } else { workspace.model(for: key)?.focusComposer() }
        focus = worksBeside ? .split : .conversation
    }

    /// With no composer in view to add to (no tab open, or a terminal's): a new conversation, in
    /// the terminal's folder if one's in view, never a terminal (which would start the project's
    /// command, and not have the text).
    private func composerForAdding() {
        guard selection == nil || messageTarget.map(MainTerminals.isTerminal) == true else { return }
        newSession(in: selection.flatMap { terminals.entry($0)?.directory }, conversation: true)
    }

    /// A session that carries on in another: the new one takes its tab (or its place beside
    /// one), and is shown.
    private func swapTab(_ old: String, with id: String) {
        if let tab = splitPairs.first(where: { $0.value == old })?.key {
            splitPairs[tab] = id
            openTab(id)
            return
        }
        guard tabs.contains(old) else { return openTab(id) }
        if let beside = splitPairs[old] {
            splitPairs[old] = nil
            splitPairs[id] = beside
        }
        replaceTab(old, with: id)
    }

    /// A draft became a real session: it keeps its place in the tab strip.
    private func replaceTab(_ key: String, with id: String) {
        var tabs = tabs
        if let index = tabs.firstIndex(of: key) { tabs[index] = id } else { tabs.append(id) }
        self.tabs = tabs
        selection = id
    }

    /// Settings' tabs while Settings shows, else the sessions'.
    private func cycleAnyTabs(by offset: Int) {
        if app.showsSettings { withAnimation(.ui) { app.settingsTabs.cycle(by: offset) } } else { cycleTabs(by: offset) }
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
            closeTab(selection)
        } else {
            NSApp.keyWindow?.performClose(nil)
        }
    }

    private func cycleTabs(by offset: Int) {
        let tabs = tabs
        guard !tabs.isEmpty else { return }
        let index = selection.flatMap { tabs.firstIndex(of: $0) } ?? 0
        withAnimation(.ui) { selection = tabs[(index + offset + tabs.count) % tabs.count] }
    }

    /// Deleted sessions lose their tabs; the one beside a deleted tab's session takes its tab.
    /// Pairs whose tab or session beside is gone end.
    private func dropClosedSessions(_ ids: [String]) {
        guard workspace.isLoaded else { return }
        let known = Set(ids)
        // A machine's sessions wait for it to connect.
        func isGone(_ key: String) -> Bool { !known.contains(key) && workspace.waitingMachine(for: key) == nil }
        for key in tabs where SidebarView.draftDirectory(from: key) == nil && isGone(key) {
            // A terminal's tab stays while its shell runs; one restored at launch has none.
            if MainTerminals.isTerminal(key) {
                if terminals.entry(key) != nil { continue }
                closeTab(key, remember: false)
                continue
            }
            // A group chat's tab stays as long as the chat does.
            if let id = BotGroups.groupID(fromTab: key), groups.group(id) != nil { continue }
            if let beside = splitPairs[key], !isGone(beside), !tabs.contains(beside) {
                splitPairs[key] = nil
                var tabs = tabs
                if let index = tabs.firstIndex(of: key) { tabs[index] = beside }
                self.tabs = tabs
                if selection == key { selection = beside }
                continue
            }
            closeTab(key, remember: false)
        }
        let open = Set(tabs)
        let pairs = splitPairs.filter { open.contains($0.key) && !open.contains($0.value) && !isGone($0.value) }
        if pairs != splitPairs { splitPairs = pairs }
        // A selection that isn't one of the tabs (its session went while the app was closed)
        // shows nothing; show the last tab instead.
        if let selection, !tabs.contains(selection) { self.selection = tabs.last }
    }

    // MARK: Actions

    private var actions: SessionActions {
        let model = focusedModel
        return SessionActions(
            hasSession: model != nil,
            hasProject: focusedProject != nil,
            canStop: model?.isRunning == true,
            canReopenTab: closedTabs.contains(where: canReopen),
            newSession: { newSession(in: nil) },
            newTerminalTab: { openTerminalTab(command: nil) },
            openFolder: openFolder,
            newProject: { openProjectEditor(ProjectEditorRequest(project: nil)) },
            newBot: { openBotEditor(bot: nil) },
            importBot: { if let recipe = BotRecipe.pick() { openBotEditor(bot: nil, recipe: recipe) } },
            newGroup: { openGroupEditor(group: nil) },
            newChat: { newSession(in: Workspace.chatsFolder) },
            stop: { model?.stop() },
            selectAgent: { model?.selectAgent($0) },
            togglePanel: { withAnimation(.ui) { showPanel(!panelOnScreen) } },
            showChanges: { showInPanel { utilities.showChanges() } },
            showFiles: { showInPanel { utilities.showFiles() } },
            newTerminal: { showInPanel { utilities.newTerminal(in: focusedDirectory, environment: app.shellEnvironment) } },
            run: runProject,
            newBrowser: { showInPanel { utilities.newBrowser() } },
            toggleSidebar: { withAnimation(.ui) { showSidebar(!sidebarOnScreen) } },
            nextTab: { cycleAnyTabs(by: 1) },
            previousTab: { cycleAnyTabs(by: -1) },
            closeTab: closeAnyTab,
            reopenTab: reopenClosedTab,
            find: {
                if let model { model.showFind() } else if selection.flatMap(BotGroups.groupID(fromTab:)) != nil { groupFind += 1 }
            },
            showTab: { number in
                if app.showsSettings {
                    withAnimation(.ui) { app.settingsTabs.show(number: number) }
                    return
                }
                let tabs = tabs
                guard !tabs.isEmpty else { return }
                let index = number == 9 ? tabs.count - 1 : number - 1
                if tabs.indices.contains(index) { openTab(tabs[index]) }
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

    #if DEBUG
    private static let demoPaletteQuery = ProcessInfo.processInfo.environment["KUVO_DEMO_PALETTE"] ?? ""
    #else
    private static let demoPaletteQuery = ""
    #endif

    /// Every session and chat not put away, the latest first, with its project.
    private var paletteSessions: [PaletteItem] {
        (workspace.projects.flatMap(\.sessions) + workspace.chats).sorted { $0.time.updated > $1.time.updated }.map { session in
            PaletteItem(id: "session:" + session.id, kind: .session, title: session.title ?? "New Session", detail: workspace.projectName(session.location.directory),
                        symbol: workspace.worktrees[session.location.directory] == nil ? "bubble.left" : "arrow.triangle.branch") { openTab(session.id) }
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
        add("New Bot…", "face.smiling", nil) { openBotEditor(bot: nil) }
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

    /// Starts a draft in `directory`, or in the current project (a worktree's, for a session in one).
    /// A new session in `directory`, or the project in view, or the latest one; with no project
    /// at all, a chat. A bot's own folder isn't a project: from its conversation, the latest one.
    /// `conversation`: one, even in a project whose sessions open its terminal command.
    private func newSession(in directory: String?, conversation: Bool = false) {
        let inView = activeDirectory.map(workspace.projectDirectory).flatMap { Workspace.isBotFolder($0) ? nil : $0 }
        let directory = directory ?? inView ?? workspace.projects.first?.directory ?? Workspace.chatsFolder
        // A project that has a terminal command for its sessions opens that, not a conversation.
        if !conversation, let command = workspace.settings[workspace.projectDirectory(directory)]?.terminal {
            openTerminalTab(command: command, in: directory)
            return
        }
        openTab(SidebarView.draftTag(directory))
    }

    /// A terminal as a tab, in the folder of the tab in view (or the one given), typing `command`
    /// in it. Without one, a plain shell: where you start `omp` or any agent yourself.
    private func openTerminalTab(command: String?, in directory: String? = nil) {
        // A project's folder, not a bot's own or the chats' (their agents work there).
        let directory = directory ?? activeProject ?? NSHomeDirectory()
        Analytics.shared.track("terminal_tab_opened", ["kind": command == nil ? "shell" : "project"])
        openTab(terminals.open(in: directory, command: command, environment: app.shellEnvironment))
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
        newSession(in: workspace.addFolder(url.path))
    }

    /// With nothing open, pick up where the user left off.
    private func startIfEmpty() {
        guard workspace.isLoaded, tabs.isEmpty, let latest = workspace.projects.first?.sessions.first else { return }
        openTab(latest.id)
    }

    #if DEBUG
    /// The comment and prompt go in once, however often the view reappears.
    private static var ranDemo = false

    /// For trying the app without clicking: KUVO_DEMO_FOLDER opens a project, and
    /// KUVO_DEMO_PROMPT (with KUVO_DEMO_MODEL as "provider/model") starts a session with it.
    /// KUVO_DEMO_PROVIDERS opens Accounts, on that provider's sign-in if it names one.
    /// KUVO_DEMO_APPEARANCE=light|dark forces an appearance. KUVO_DEMO_WINDOW sets the window size.
    /// KUVO_DEMO_COMMENT adds a review comment.
    private func runDemoIfAsked() async {
        let environment = ProcessInfo.processInfo.environment
        // Launched from Terminal for screenshots, the window would otherwise stay inactive.
        // KUVO_DEMO_BACKGROUND leaves the copy behind other apps, so it doesn't take the keyboard.
        if environment.keys.contains(where: { $0.hasPrefix("KUVO_DEMO_") }), environment["KUVO_DEMO_BACKGROUND"] == nil { NSApp.activate() }
        if AppInfo.staysInBackground {
            // Behind every other window, not just the one in front: when you close or hide that,
            // macOS brings forward the app whose window is next.
            Task {
                for _ in 0..<3 {
                    for window in NSApp.windows where window.isVisible { window.orderBack(nil) }
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
        switch environment["KUVO_DEMO_APPEARANCE"] {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: break
        }
        if environment["KUVO_DEMO_CHANGES"] != nil { showPanel() }
        // KUVO_DEMO_PALETTE=<text>: the command palette, with that typed in it.
        if workspace.isLoaded, environment["KUVO_DEMO_PALETTE"] != nil { showsPalette = true }
        // KUVO_DEMO_RENAME=header: the session in view, renamed in its card's header.
        if workspace.isLoaded, environment["KUVO_DEMO_RENAME"] == "header", let session = activeModel?.session { renaming = session }
        // KUVO_DEMO_WINDOW=WIDTHxHEIGHT resizes the window, for checking narrow layouts;
        // KUVO_DEMO_OFFSCREEN puts it past the screen's edge, where the pointer can't hover over it.
        if let size = environment["KUVO_DEMO_WINDOW"]?.split(separator: "x").compactMap({ Double($0) }), size.count == 2,
           let window = NSApp.windows.first(where: \.isVisible) {
            var frame = window.frame
            frame.size = CGSize(width: size[0], height: size[1])
            if environment["KUVO_DEMO_OFFSCREEN"] != nil, let screen = window.screen ?? NSScreen.main {
                frame.origin = CGPoint(x: screen.frame.maxX + 40, y: screen.frame.minY)
            }
            window.setFrame(frame, display: true, animate: false)
            // Again once window restoration has settled.
            try? await Task.sleep(for: .seconds(1))
            window.setFrame(frame, display: true, animate: false)
        }
        if workspace.isLoaded, environment["KUVO_DEMO_PROVIDERS"] != nil { app.openSettings(.accounts) }
        // KUVO_DEMO_NEW_PROJECT=<folder>,<folder>: the New Project sheet with these folders.
        if workspace.isLoaded, let list = environment["KUVO_DEMO_NEW_PROJECT"] {
            openProjectEditor(ProjectEditorRequest(project: nil, folders: list.split(separator: ",").map(String.init)))
        }
        // KUVO_DEMO_SETTINGS=<page>[@<machine>] opens Settings on that page, by its SettingsPage
        // name: general, appearance, storage, accounts, agents, mcp, git, browser, passwords and so
        // on; with a machine, that machine's.
        if workspace.isLoaded, let tab = environment["KUVO_DEMO_SETTINGS"] {
            let (page, box) = Self.demoPage(tab)
            app.openSettings(page, on: box)
        }
        guard workspace.isLoaded, !Self.ranDemo else { return }
        Self.ranDemo = true
        // KUVO_DEMO_SETTINGS_TABS=<pages>: those pages too, each in a tab of its own, comma-separated;
        // the first page (KUVO_DEMO_SETTINGS) stays in view.
        if let pages = environment["KUVO_DEMO_SETTINGS_TABS"] {
            let shown = app.settingsTabs.selectedID
            for (page, box) in pages.split(separator: ",").map({ Self.demoPage(String($0)) }) {
                if let page { app.settingsTabs.show(page, on: box, inNewTab: true) }
            }
            app.settingsTabs.select(shown)
        }
        // KUVO_DEMO_WELCOME: no tabs, so the welcome card shows.
        if environment["KUVO_DEMO_WELCOME"] != nil {
            tabs = []
            selection = nil
        }
        // The folder's new session first, so the panel's tools open in it.
        if let folder = environment["KUVO_DEMO_FOLDER"], environment["KUVO_DEMO_PROMPT"] == nil, environment["KUVO_DEMO_REPLAY"] == nil { newSession(in: folder) }
        // KUVO_DEMO_PANEL: tools to open in the panel, comma-separated: terminal,
        // browser=<address>, machine=<machine>[=<address>] (a tab in its browser, with a session
        // there in view), files, file=<path>, changes, run (the project's run command), expand.
        for item in (environment["KUVO_DEMO_PANEL"] ?? "").split(separator: ",").map(String.init) {
            let parts = item.split(separator: "=", maxSplits: 1).map(String.init)
            switch parts.first {
            case "terminal": utilities.newTerminal(in: focusedDirectory, environment: app.shellEnvironment)
            case "browser": utilities.newBrowser(parts.count > 1 ? parts[1] : nil)
            case "machine" where parts.count > 1:
                let rest = parts[1].split(separator: "=", maxSplits: 1).map(String.init)
                // Once a session there is in view, so the tab shows.
                Task {
                    for _ in 0..<60 where utilities.place != rest[0] { try? await Task.sleep(for: .milliseconds(500)) }
                    utilities.newMachinePage(rest[0], address: rest.count > 1 ? rest[1] : nil)
                }
            case "files": utilities.showFiles()
            case "file" where parts.count > 1:
                // Once the conversation is in view, so the tab is its panel's.
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    utilities.show(RemoteFolder.url(parts[1]))
                }
            case "changes": utilities.showChanges()
            case "run": runProject()
            case "expand": panelExpanded = true
            // toggle=<seconds>: expands and collapses it a few times, that far apart.
            case "toggle" where parts.count > 1:
                let wait = Double(parts[1]) ?? 3
                Task {
                    for _ in 0..<4 {
                        try? await Task.sleep(for: .seconds(wait))
                        withAnimation(.ui) { panelExpanded.toggle() }
                    }
                }
            default: continue
            }
            showPanel()
        }
        // KUVO_DEMO_IMPORT_BOT=<path>: New Bot, from that shared bot's file.
        if let path = environment["KUVO_DEMO_IMPORT_BOT"], let data = FileManager.default.contents(atPath: path),
           let recipe = try? JSONDecoder().decode(BotRecipe.self, from: data) {
            openBotEditor(bot: nil, recipe: recipe)
        }
        // KUVO_DEMO_CHAT=<message>: a new chat, with this message sent; KUVO_DEMO_MOVE_CHAT=<folder>
        // then moves the newest chat into that project.
        if let message = environment["KUVO_DEMO_CHAT"] {
            Task {
                while app.api == nil { try? await Task.sleep(for: .seconds(1)) }
                guard let session = try? await workspace.createSession(in: Workspace.chatsFolder, model: nil, agent: nil) else { return }
                openTab(session.id)
                workspace.model(for: session.id)?.submit(message, files: [], for: nil, queue: false, commands: [])
            }
        }
        if let folder = environment["KUVO_DEMO_MOVE_CHAT"] {
            Task {
                while !workspace.isLoaded { try? await Task.sleep(for: .seconds(1)) }
                // With KUVO_DEMO_CHAT, after its reply, while it's open.
                try? await Task.sleep(for: .seconds(environment["KUVO_DEMO_CHAT"] == nil ? 3 : 16))
                let log = Logger(subsystem: "run.kuvo.code", category: "demo")
                guard let chat = workspace.chats.first else { return log.error("KUVO_DEMO_MOVE_CHAT: no chat") }
                do {
                    try await workspace.move(chat.id, toProject: folder)
                    openTab(chat.id)
                } catch {
                    log.error("KUVO_DEMO_MOVE_CHAT failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
        // KUVO_DEMO_UNDO_RESEND=<seconds>: in the session in view, undoes its last message, then
        // sends it again after that many seconds.
        if let wait = environment["KUVO_DEMO_UNDO_RESEND"].flatMap(Double.init) {
            Task {
                try? await Task.sleep(for: .seconds(6))
                guard let id = sessionID, let model = workspace.model(for: id) else { return }
                if !model.isLoaded { await model.load() }
                guard let last = model.transcript.messages.last(where: { if case .user = $0 { true } else { false } }), case .user(let user) = last else { return }
                model.undo(from: user)
                try? await Task.sleep(for: .seconds(wait))
                model.submit(model.draftText, files: model.draftFiles, for: nil, queue: false, commands: [])
                model.draftText = ""
                model.draftFiles = []
            }
        }
        // KUVO_DEMO_MACHINE_BROWSING=<machine>|<seconds>: as if an agent on that machine started
        // using its browser that long after launch, through the same event the engine sends.
        if let value = environment["KUVO_DEMO_MACHINE_BROWSING"] {
            let parts = value.split(separator: "|").map(String.init)
            Task { [workspace] in
                try? await Task.sleep(for: .seconds(parts.count > 1 ? Double(parts[1]) ?? 3 : 3))
                let json = #"{"id":"evt_demo","type":"session.tool.input.started","data":{"sessionID":"ses_demo","assistantMessageID":"msg_demo","id":"call_demo","name":"kuvo-browser_browser_navigate"}}"#
                if let event = try? ServerEvent(json: Data(json.utf8)) { workspace.handle(event, machine: parts[0]) }
            }
        }
        // KUVO_DEMO_ASKING[=<title>]: every few seconds, as if the agent of the session in view (the
        // one with that title, once it shows) started asking in its browser; the ask itself comes
        // from calling the browser's tools.
        if let title = environment["KUVO_DEMO_ASKING"] {
            Task { [workspace] in
                var opened = false
                while true {
                    try? await Task.sleep(for: .seconds(5))
                    if !opened, !["", "1"].contains(title), let session = workspace.sessions.first(where: { $0.title == title }) {
                        openTab(session.id)
                        opened = true
                    }
                    guard let id = sessionID, let session = workspace.session(id) else { continue }
                    workspace.onBrowserAsk?(id, RemoteFolder.machine(of: session.location.directory))
                }
            }
        }
        // KUVO_DEMO_CYCLE_TABS=<seconds>: goes to the next session tab every so often, a few times.
        if let wait = environment["KUVO_DEMO_CYCLE_TABS"].flatMap(Double.init) {
            Task {
                for _ in 0..<4 {
                    try? await Task.sleep(for: .seconds(wait))
                    cycleTabs(by: 1)
                }
            }
        }
        Task { await PerfLayers.run() }
        // KUVO_PERF_SWITCH=<n>: ten seconds after launch, goes to the next session tab n times,
        // a second and a half apart, and writes how the main thread kept up to KUVO_PERF_LOG.
        if let count = environment["KUVO_PERF_SWITCH"].flatMap(Int.init) {
            Task {
                try? await Task.sleep(for: .seconds(10))
                // KUVO_PERF_SWITCH_CHECK: each tab's session with a draft of its own, and after each
                // switch, whether the composer shows it, and takes what's typed there.
                let check = environment["KUVO_PERF_SWITCH_CHECK"] != nil
                if check { for (index, tab) in tabs.enumerated() { workspace.model(for: tab)?.draftText = "draft \(index)" } }
                var wrong: [String] = []
                let meter = PerfMeter()
                meter.start()
                // KUVO_PERF_SWITCH_BY=<steps>: tabs to go by, in turn ("1,1,-1,-1": back and forth
                // among three), rather than always the next.
                let by = environment["KUVO_PERF_SWITCH_BY"].map { $0.split(separator: ",").compactMap { Int($0) } } ?? [1]
                for step in 0..<count {
                    cycleTabs(by: by[step % by.count])
                    try? await Task.sleep(for: .milliseconds(1500))
                    if check, let id = selection, let model = workspace.model(for: id),
                       let editor = NSApp.windows.lazy.compactMap({ $0.firstResponder as? NSTextView }).first(where: \.isFieldEditor) {
                        if editor.string != model.draftText { wrong.append("step \(step): shows \"\(editor.string)\", draft \"\(model.draftText)\"") }
                        editor.insertText("+", replacementRange: NSRange(location: (editor.string as NSString).length, length: 0))
                        try? await Task.sleep(for: .milliseconds(100))
                        if !model.draftText.hasSuffix("+") { wrong.append("step \(step): typed, draft \"\(model.draftText)\"") }
                    } else if check {
                        wrong.append("step \(step): no field editor")
                    }
                }
                let line = "switch x\(count) among \(tabs.count) tabs: " + meter.stop() + (check ? "; check: " + (wrong.isEmpty ? "all right" : wrong.prefix(6).joined(separator: "; ")) : "") + "\n"
                if let file = environment["KUVO_PERF_STALLS"] { try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
                if let file = environment["KUVO_PERF_LOG"] {
                    if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Data(line.utf8)) }
                }
            }
        }
        // KUVO_PERF_TOGGLE=<n>: ten seconds after launch, the sidebar hidden and shown n times, then
        // the panel, as their buttons do, a second apart; how the main thread kept up with the
        // slides goes to KUVO_PERF_LOG.
        if let count = environment["KUVO_PERF_TOGGLE"].flatMap(Int.init) {
            Task {
                try? await Task.sleep(for: .seconds(10))
                func log(_ line: String) {
                    guard let file = environment["KUVO_PERF_LOG"] else { return }
                    if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Data(line.utf8)) }
                }
                let sidebar = PerfMeter()
                sidebar.start()
                // KUVO_PERF_TOGGLE_ONLY=panel: the panel alone (and its profile alone).
                let panelOnly = environment["KUVO_PERF_TOGGLE_ONLY"] == "panel"
                for _ in 0..<(panelOnly ? 0 : count * 2) {
                    withAnimation(.ui) { showSidebar(!showsSidebar) }
                    try? await Task.sleep(for: .seconds(1))
                }
                if !panelOnly {
                    log("toggle sidebar x\(count * 2): " + sidebar.stop() + "\n")
                    if let file = environment["KUVO_PERF_STALLS"] { try? sidebar.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
                }
                let panel = PerfMeter()
                panel.start()
                for _ in 0..<(count * 2) {
                    withAnimation(.ui) { showPanel(!showsPanel) }
                    try? await Task.sleep(for: .seconds(1))
                }
                log("toggle panel x\(count * 2): " + panel.stop() + "\n")
                if let file = environment["KUVO_PERF_STALLS"] { try? panel.stallReport().write(toFile: file + ".panel", atomically: true, encoding: .utf8) }
            }
        }
        // KUVO_PERF_SIDEBAR=<n>: ten seconds after launch, the sidebar scrolled down and back up,
        // n frames each way, as a trackpad does; then ten seconds left alone. How the main thread
        // kept up with each goes to KUVO_PERF_LOG.
        if let count = environment["KUVO_PERF_SIDEBAR"].flatMap(Int.init) {
            Task {
                try? await Task.sleep(for: .seconds(10))
                func scrollViews(in view: NSView) -> [NSScrollView] { ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews) }
                guard let window = NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }), let content = window.contentView,
                      let sidebar = scrollViews(in: content).first(where: { $0.convert($0.bounds, to: nil).minX < 60 && $0.frame.height > 200 }) else { return }
                func log(_ line: String) {
                    guard let file = environment["KUVO_PERF_LOG"] else { return }
                    if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Data(line.utf8)) }
                }
                let meter = PerfMeter()
                meter.start()
                let range = max(0, (sidebar.documentView?.frame.height ?? 0) - sidebar.contentView.bounds.height)
                // KUVO_PERF_SIDEBAR_WHEEL: by a trackpad's events (began, changed, ended), as you
                // scroll, so SwiftUI knows it's being scrolled; otherwise moved there directly.
                let wheel = environment["KUVO_PERF_SIDEBAR_WHEEL"] != nil
                func send(_ delta: CGFloat, phase: CGScrollPhase) {
                    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else { return }
                    event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
                    event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                    if let ns = NSEvent(cgEvent: event) { sidebar.scrollWheel(with: ns) }
                }
                for step in 0..<(count * 2) {
                    let done = Double(step < count ? step + 1 : count * 2 - step - 1) / Double(count)
                    if wheel {
                        let delta = (step < count ? -1.0 : 1.0) * range / Double(count)
                        send(delta, phase: step == 0 || step == count ? .began : .changed)
                        if step == count - 1 || step == count * 2 - 1 { send(0, phase: .ended) }
                    } else {
                        let clip = sidebar.contentView
                        clip.scroll(to: NSPoint(x: 0, y: range * done))
                        sidebar.reflectScrolledClipView(clip)
                    }
                    try? await Task.sleep(for: .milliseconds(16))
                }
                log("sidebar scroll x\(count * 2) over \(Int(range)) pt: " + meter.stop() + "\n")
                // KUVO_PERF_SIDEBAR_IDLE=0: not the idle part (whose profile would replace this one's).
                guard environment["KUVO_PERF_SIDEBAR_IDLE"] != "0" else { log("sidebar idle skipped\n"); return }
                let idle = PerfMeter()
                idle.start()
                try? await Task.sleep(for: .seconds(10))
                log("sidebar idle 10 s: " + idle.stop() + "\n")
            }
        }
        // KUVO_PERF_RESIZE=<n>: ten seconds after launch, goes through the next three session tabs
        // and back, then makes the window narrower and wider again, n frames each way, and writes
        // how the main thread kept up to KUVO_PERF_LOG.
        if let count = environment["KUVO_PERF_RESIZE"].flatMap(Int.init) {
            Task {
                try? await Task.sleep(for: .seconds(10))
                for by in [1, 1, 1, -3] {
                    cycleTabs(by: by)
                    try? await Task.sleep(for: .milliseconds(1500))
                }
                guard let window = NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }) else { return }
                let start = window.frame
                let meter = PerfMeter()
                meter.start()
                for step in 0..<(count * 2) {
                    let done = Double(step < count ? step + 1 : count * 2 - step - 1) / Double(count)
                    var frame = start
                    frame.size.width = start.width - 400 * done
                    window.setFrame(frame, display: true)
                    try? await Task.sleep(for: .milliseconds(16))
                }
                let line = "resize x\(count * 2): " + meter.stop() + "\n"
                if let file = environment["KUVO_PERF_STALLS"] { try? meter.stallReport().write(toFile: file, atomically: true, encoding: .utf8) }
                if let file = environment["KUVO_PERF_LOG"] {
                    if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Data(line.utf8)) }
                }
            }
        }
        // KUVO_PERF_TYPE=<n>: ten seconds after launch, types n characters into the composer, one
        // every 60 ms, and writes how the main thread kept up (and the longest a character took to
        // be handled) to KUVO_PERF_LOG.
        if let count = environment["KUVO_PERF_TYPE"].flatMap(Int.init) {
            Task {
                try? await Task.sleep(for: .seconds(10))
                guard let editor = NSApp.windows.lazy.compactMap({ $0.firstResponder as? NSTextView }).first(where: \.isFieldEditor) else { return }
                let meter = PerfMeter()
                meter.start()
                var longest = 0.0
                let words = Array("the quick brown fox jumps over the lazy dog and keeps on running ")
                for index in 0..<count {
                    let started = CACurrentMediaTime()
                    editor.insertText(String(words[index % words.count]), replacementRange: NSRange(location: (editor.string as NSString).length, length: 0))
                    // Until the run loop has handled it and drawn.
                    await Task.yield()
                    longest = max(longest, (CACurrentMediaTime() - started) * 1000)
                    try? await Task.sleep(for: .milliseconds(60))
                }
                let line = String(format: "type x%d: longest %.0f ms; ", count, longest) + meter.stop() + "\n"
                if let file = environment["KUVO_PERF_LOG"] {
                    if let handle = FileHandle(forWritingAtPath: file) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: file, contents: Data(line.utf8)) }
                }
            }
        }
        // KUVO_DEMO_REOPEN_WINDOW=<seconds>: closes the window after that long, and opens it again.
        if let wait = environment["KUVO_DEMO_REOPEN_WINDOW"].flatMap(Double.init) {
            Task { [app] in
                try? await Task.sleep(for: .seconds(wait))
                NSApp.windows.first { $0.isVisible && $0.canBecomeMain }?.performClose(nil)
                try? await Task.sleep(for: .seconds(2))
                app.openMainWindow?()
            }
        }
        // KUVO_DEMO_TOGGLE_PANEL=<seconds>: shows and hides the panel every so often, a few times.
        if let every = environment["KUVO_DEMO_TOGGLE_PANEL"].flatMap(Double.init) {
            Task {
                for _ in 0..<6 {
                    try? await Task.sleep(for: .seconds(every))
                    withAnimation(.ui) { showsPanel.toggle() }
                }
            }
        }
        // KUVO_DEMO_VIEW_IMAGE=<path>,…: those pictures in the image viewer.
        if let paths = environment["KUVO_DEMO_VIEW_IMAGE"] {
            ImageViewer.shared.show(paths.split(separator: ",").map { AttachmentItem.local(URL(filePath: String($0))) })
        }
        // KUVO_DEMO_NEW_BOT: the New Bot sheet.
        if environment["KUVO_DEMO_NEW_BOT"] != nil { openBotEditor(bot: nil) }
        // In a task of its own: SwiftUI cancels and restarts this view's task while the
        // window settles, which would cut the session's creation short.
        Task { await runDemoSession(environment) }
        Task { await runDemoBot(environment) }
        Task { await runDemoGroup(environment) }
    }

    /// KUVO_DEMO_GROUP=<name>|<bot>,<bot>,…[|<message>] makes that group chat of those bots unless
    /// one has the name, opens it, and sends it the message; KUVO_DEMO_EDIT_GROUP opens its editor,
    /// and KUVO_DEMO_MOVE_GROUP=<machine> moves it there first.
    private func runDemoGroup(_ environment: [String: String]) async {
        if environment["KUVO_DEMO_NEW_GROUP"] != nil { openGroupEditor(group: nil) }
        guard let spec = environment["KUVO_DEMO_GROUP"] else { return }
        let parts = spec.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard let name = parts.first, !name.isEmpty else { return }
        let members = (parts.count > 1 ? parts[1] : "").split(separator: ",").compactMap { member in
            bots.list.first { $0.name == member.trimmingCharacters(in: .whitespaces) }?.id
        }
        let group = groups.list.first { $0.name == name } ?? groups.create(name: name, members: members)
        openTab(BotGroups.tabKey(group.id))
        if environment["KUVO_DEMO_EDIT_GROUP"] != nil { openGroupEditor(group: group) }
        // KUVO_DEMO_GROUP_UNDO=<seconds>: then undoes from your last message there, into the composer.
        if let wait = environment["KUVO_DEMO_GROUP_UNDO"].flatMap(Double.init) {
            try? await Task.sleep(for: .seconds(wait))
            if let last = groups.messages(in: group.id).last(where: { $0.author == nil && $0.kind != .note }),
               let text = await groups.undo(from: last.id, in: group.id) {
                Drafts.shared[BotGroups.tabKey(group.id)].text = text
            }
        }
        // KUVO_DEMO_MOVE_GROUP=<machine>: then it moves there (once the machines it moves between run
        // group chats), or to this Mac when empty, before its message goes.
        if let place = environment["KUVO_DEMO_MOVE_GROUP"], groups.machine(of: group.id) != (place.isEmpty ? nil : place) {
            let machine = place.isEmpty ? nil : place
            let ends = [machine, groups.machine(of: group.id)].compactMap { $0 }
            for _ in 0..<180 where !ends.allSatisfy(app.machineGroups.running.contains) { try? await Task.sleep(for: .seconds(1)) }
            do {
                try await app.moves.move(group: group.id, to: machine)
                print("KUVO_DEMO_MOVE_GROUP moved \(group.name)")
            } catch {
                print("KUVO_DEMO_MOVE_GROUP failed: \(error.localizedDescription)")
            }
        }
        guard parts.count > 2, !parts[2].isEmpty else { return }
        while app.api == nil { try? await Task.sleep(for: .seconds(1)) }
        // One on a machine: once it's reached there, as its composer waits.
        for _ in 0..<180 where groups.unreachable(group.id) != nil { try? await Task.sleep(for: .seconds(1)) }
        try? await Task.sleep(for: .seconds(2))
        groups.send(parts[2], to: group.id)
        // KUVO_DEMO_GROUP_LATER=<seconds>|<message>: another message, sent while they talk.
        let later = (environment["KUVO_DEMO_GROUP_LATER"] ?? "").split(separator: "|", maxSplits: 1).map(String.init)
        if later.count == 2, let seconds = Double(later[0]) {
            try? await Task.sleep(for: .seconds(seconds))
            groups.send(later[1], to: group.id)
        }
    }

    /// KUVO_DEMO_BOT=<name>|<job>|<instructions>[|<machine>[|<project>]] makes that bot unless one has the
    /// name (on KUVO_DEMO_BOT_MODEL=<provider>/<model>, if given), and opens it;
    /// KUVO_DEMO_BOT_PROMPT then gives it a task, and KUVO_DEMO_EDIT_BOT opens its Edit Bot sheet.
    private func runDemoBot(_ environment: [String: String]) async {
        guard let spec = environment["KUVO_DEMO_BOT"] else { return }
        let parts = spec.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard let name = parts.first, !name.isEmpty else { return }
        var bot = bots.list.first { $0.name == name }
        if bot == nil {
            let machine = parts.count > 3 && !parts[3].isEmpty ? parts[3] : nil
            if let machine, let engine = app.machines.engine(machine) {
                while !engine.isReady { try? await Task.sleep(for: .seconds(1)) }
            }
            do {
                // Its job, as it would have written it in its memory.
                let job = (line: parts.count > 1 ? parts[1] : "", details: parts.count > 2 ? parts[2] : "")
                let model = environment["KUVO_DEMO_BOT_MODEL"].flatMap { spec -> ModelRef? in
                    guard let slash = spec.firstIndex(of: "/") else { return nil }
                    return ModelRef(id: String(spec[spec.index(after: slash)...]), providerID: String(spec[..<slash]))
                }
                // (The coding agents' list first, for a model of theirs.)
                if OutsideAgents.runsInBridge(model?.providerID) {
                    while workspace.agents(forFolder: machine.map { RemoteFolder.folder("/", on: $0) } ?? "/")?.api == nil { try? await Task.sleep(for: .seconds(1)) }
                }
                bot = try await bots.create(name: name, job: job.line.isEmpty && job.details.isEmpty ? nil : job,
                                            look: .random(), model: model, machine: machine, project: parts.count > 4 && !parts[4].isEmpty ? parts[4] : nil)
            } catch {
                print("KUVO_DEMO_BOT failed: \(error.localizedDescription)")
                return
            }
        }
        guard let bot else { return }
        openTab(bot.sessionID)
        // KUVO_DEMO_EDIT_BOT: its Edit Bot sheet, open.
        if environment["KUVO_DEMO_EDIT_BOT"] != nil { openBotEditor(bot: bot) }
        // KUVO_DEMO_REPLY: a reply sent as a notification's Reply sends it.
        if let reply = environment["KUVO_DEMO_REPLY"] { await workspace.send(reply, to: bot.sessionID) }
        if let prompt = environment["KUVO_DEMO_BOT_PROMPT"], let model = workspace.model(for: bot.sessionID) {
            try? await Task.sleep(for: .seconds(1))
            model.submit(prompt, files: [], for: nil, queue: false, commands: [])
        }
        // KUVO_DEMO_MOVE_BOT=<machine, or nothing for this Mac>: once it's done, it moves there.
        if let place = environment["KUVO_DEMO_MOVE_BOT"] {
            let machine = place.isEmpty ? nil : place
            if let machine, let engine = app.machines.engine(machine) {
                while !engine.isReady { try? await Task.sleep(for: .seconds(1)) }
            }
            try? await Task.sleep(for: .seconds(3))
            while workspace.isWorking(bot.sessionID) { try? await Task.sleep(for: .seconds(2)) }
            do {
                try await app.moves.move(bot: bot.id, to: machine)
                print("KUVO_DEMO_MOVE_BOT moved \(bot.name)")
            } catch {
                print("KUVO_DEMO_MOVE_BOT failed: \(error.localizedDescription)")
            }
        }
    }

    private func runDemoSession(_ environment: [String: String]) async {
        // KUVO_DEMO_SHOW_IN_PANEL=<path>|<folder or file>: as if the agent of the session in view
        // showed that in the panel (its show_in_panel tool), once it's been connected a while.
        if let spec = environment["KUVO_DEMO_SHOW_IN_PANEL"] {
            let parts = spec.split(separator: "|").map(String.init)
            Task { [workspace] in
                try? await Task.sleep(for: .seconds(18))
                guard let id = sessionID, let session = workspace.session(id), parts.count == 2 else { return }
                let machine = RemoteFolder.machine(of: session.location.directory)
                let said = BrowserTools.shown(parts[0], isFolder: parts[1] == "folder", inView: true)
                for (type, data) in [
                    ("session.tool.input.started", #""name":"kuvo-browser_show_in_panel""#),
                    ("session.tool.called", #""input":{"path":\#(String(decoding: try! JSONEncoder().encode(parts[0]), as: UTF8.self))}"#),
                    ("session.tool.success", #""content":[{"type":"text","text":\#(String(decoding: try! JSONEncoder().encode(said), as: UTF8.self))}]"#),
                ] {
                    let json = #"{"id":"evt_demo","type":"\#(type)","data":{"sessionID":"\#(id)","assistantMessageID":"msg_demo","id":"call_show",\#(data)}}"#
                    if let event = try? ServerEvent(json: Data(json.utf8)) { workspace.handle(event, machine: machine) }
                }
            }
        }
        // KUVO_DEMO_SESSION=<id>: that session's tab, in view (one on a machine waits for it).
        if let id = environment["KUVO_DEMO_SESSION"] {
            openTab(id)
            // KUVO_DEMO_FIND=<words>: Find in it, looking for those (once it's read, on a machine).
            if let words = environment["KUVO_DEMO_FIND"] {
                Task { [workspace] in
                    for _ in 0..<60 {
                        if let model = workspace.model(for: id), model.isLoaded {
                            try? await Task.sleep(for: .seconds(1))
                            model.showFind(words)
                            return
                        }
                        try? await Task.sleep(for: .milliseconds(500))
                    }
                }
            }
            // KUVO_DEMO_WAITING=<text>|<text>…: those as messages waiting in its queue (not sent);
            // a text of "<words>@<picture path>" has that picture attached.
            if let waiting = environment["KUVO_DEMO_WAITING"] {
                Task { [workspace] in
                    for _ in 0..<60 {
                        if let model = workspace.model(for: id), model.isLoaded {
                            model.showWaiting(waiting.split(separator: "|").enumerated().map { index, entry in
                                let parts = entry.split(separator: "@", maxSplits: 1).map(String.init)
                                return Transcript.Pending(id: "msg_demo_waiting_\(index)", text: parts[0], delivery: .queue, isLocal: false,
                                                          files: parts.count > 1 ? [URL(filePath: parts[1])] : [])
                            })
                            return
                        }
                        try? await Task.sleep(for: .milliseconds(500))
                    }
                }
            }
            // KUVO_DEMO_QUOTES=<n>: that many quotes to answer in its composer.
            if let count = Int(environment["KUVO_DEMO_QUOTES"] ?? "") {
                Drafts.shared[id].quotes = []
                for index in 1...max(count, 1) {
                    let text = "Point \(index): " + String(repeating: "a quoted line from the agent's reply ", count: index % 3 + 1)
                    if let model = workspace.model(for: id) { model.addQuote(text, how: "demo") } else { Drafts.shared.addQuote(text, to: id) }
                }
            }
        }
        // KUVO_DEMO_TABS: the project's sessions as tabs (KUVO_DEMO_TAB_COUNT=<n>: its latest n),
        // the one in view staying in view.
        if environment["KUVO_DEMO_TABS"] != nil,
           let project = workspace.projects.first(where: { $0.directory == activeDirectory }) ?? workspace.projects.first {
            let current = selection
            let count = environment["KUVO_DEMO_TAB_COUNT"].flatMap(Int.init) ?? .max
            for session in project.sessions.prefix(count).reversed() where !tabs.contains(session.id) { openTab(session.id) }
            if let current { openTab(current) }
        }
        // KUVO_DEMO_COMMENT=<path in the project>:<line>:<text> adds a review comment to the
        // session in view, on that line of the changes.
        if let spec = environment["KUVO_DEMO_COMMENT"], let directory = activeDirectory {
            let parts = spec.split(separator: ":", maxSplits: 2).map(String.init)
            try? await Task.sleep(for: .seconds(2))
            if parts.count == 3, let line = Int(parts[1]), let selection, let model = workspace.model(for: selection),
               let text = try? String(contentsOfFile: directory + "/" + parts[0], encoding: .utf8) {
                let lines = text.components(separatedBy: "\n")
                let snippet = lines.indices.contains(line - 1) ? lines[line - 1].trimmingCharacters(in: .whitespaces) : ""
                model.reviewComments.append(ReviewComment(file: parts[0], line: line, side: .new, snippet: snippet, text: parts[2]))
            }
        }
        guard let folder = environment["KUVO_DEMO_FOLDER"] else { return }
        // KUVO_DEMO_REPLAY=<file>: a recorded run, played into a new session there (see PerfReplay).
        if let file = environment["KUVO_DEMO_REPLAY"] {
            let catalog = catalog(for: folder)
            guard let session = try? await workspace.createSession(in: folder, model: catalog.defaultModel?.ref, agent: nil) else { return }
            openTab(session.id)
            for _ in 0..<40 where workspace.model(for: session.id)?.isLoaded != true { try? await Task.sleep(for: .milliseconds(250)) }
            try? await Task.sleep(for: .seconds(2))
            await PerfReplay.play(file, into: session.id, workspace: workspace)
            return
        }
        // KUVO_DEMO_DRAFT: a message typed, not sent, in the new session's composer.
        if let draft = environment["KUVO_DEMO_DRAFT"] { Drafts.shared[SidebarView.draftTag(folder)].text = draft }
        // KUVO_DEMO_DRAFT_FILES: comma-separated paths, attached there, not sent.
        if let files = environment["KUVO_DEMO_DRAFT_FILES"] {
            Drafts.shared[SidebarView.draftTag(folder)].files = files.split(separator: ",").map { URL(filePath: String($0)) }
        }
        guard let prompt = environment["KUVO_DEMO_PROMPT"] else { return newSession(in: folder) }
        let parts = environment["KUVO_DEMO_MODEL"]?.split(separator: "/", maxSplits: 1).map(String.init)
        let model = parts.flatMap { $0.count == 2 ? ModelRef(id: $0[1], providerID: $0[0]) : nil }
        // Like a new session from the UI: the chosen model, or the default one. KUVO_DEMO_WORKTREE
        // gives it a worktree of its own.
        // A folder on a machine: once the machine is connected and its models are known.
        if let engine = machine(for: folder) {
            for _ in 0..<240 where !engine.isReady || engine.catalog.defaultModel == nil { try? await Task.sleep(for: .milliseconds(250)) }
        }
        let catalog = catalog(for: folder)
        guard let session = try? await workspace.createSession(in: folder, model: model ?? catalog.defaultModel?.ref, agent: catalog.startingAgent(chosen: EngineConfig.of(catalog.machine)?.value(at: ["default_agent"])?.string), worktree: environment["KUVO_DEMO_WORKTREE"] != nil) else { return }
        openTab(session.id)
        // KUVO_DEMO_FILES: comma-separated paths to attach.
        let files = environment["KUVO_DEMO_FILES"]?.split(separator: ",").map { URL(filePath: String($0)) } ?? []
        // As the composer sends it: "/" runs a command, "!" a shell command.
        workspace.model(for: session.id)?.submit(prompt, files: files, for: catalog.model(session.model), queue: false, commands: catalog.commands(in: folder))
        // KUVO_DEMO_QUEUE: messages separated by "|", queued once the agent is working.
        guard let queue = environment["KUVO_DEMO_QUEUE"], let model = workspace.model(for: session.id) else { return }
        for _ in 0..<40 where !model.isRunning { try? await Task.sleep(for: .milliseconds(250)) }
        for message in queue.split(separator: "|") {
            model.submit(String(message), files: [], for: catalog.model(session.model), queue: true, commands: catalog.commands(in: folder))
        }
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
