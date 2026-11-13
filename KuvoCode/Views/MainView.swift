import ClientDesign
import ClientNews
import OpenCodeKit
import KuvoVoice
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
    /// Where the sidebar was kept before it was kept with the tabs.
    @SceneStorage("showsSidebar") private var olderShowsSidebar = true
    private var showsSidebar: Bool { tabs.showsSidebar }
    /// The row at the top: the project, its branch and the tabs. Hidden, sessions are switched
    /// from the sidebar or ⌘K.
    @AppStorage(TabBar.showsKey) private var showsTabBar = TabBar.showsByDefault
    /// The window is being resized.
    @State private var window = WindowStateReader.State()
    /// What had the keyboard last in each half of the conversation, to give it back to.
    @State private var keyboardReturn = KeyboardReturn()
    /// Goes up for ⌘F in the group chat in view.
    @State private var groupFind = 0
    @AppStorage("sessionsWidth") private var sessionsWidth = 280.0
    @AppStorage("changesWidth") private var changesWidth = 420.0
    @AppStorage(Notifier.badgeKey) private var showsBadge = true
    /// Open Quickly's palette is showing.
    @State private var showsOpenQuickly = false
    /// The command palette (⌘K) is showing.
    @State private var showsPalette = false
    /// The folder whose Branch Backups are showing, from the Session menu.
    @State private var backupsFolder: String?
    /// Terminals open as tabs, standing in for a conversation.
    private var terminals: MainTerminals { app.mainTerminals }
    /// A tab's session being renamed, and the title being typed.
    @State private var renaming: Session?
    /// The session last in the middle card, kept made (out of sight) under another tab's card, a
    /// draft's, a group chat's or a terminal's: going back to a session finds the conversations
    /// it keeps, and its composer, as they were, rather than making them all again.
    @State private var keptSession: String?
    /// The group chat last in view, kept made under another card while a tab's way back goes
    /// through it (`keptGroup`).
    @State private var keptGroupID: String?
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
        // Its sub-sessions' too: one that finishes while you watch is seen.
        sessionsInView.flatMap { id in [(workspace.session(id) ?? workspace.subSession(id))?.time.idle] + (workspace.subSessions[id] ?? []).map(\.time.idle) }
    }

    /// The sessions on screen count as seen (not those Settings or an editor covers).
    private func markViewed() {
        for id in tabs.sessionsSeen { workspace.markViewed(id) }
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
        // Laid out by a view of their own, which is all that reads the panel's and the cards'
        // widths: the panel coming and going lays the cards out again without making them again.
        WindowCards(
            tabs: tabs,
            sessionsWidth: $sessionsWidth,
            changesWidth: $changesWidth,
            splitWidth: $splitWidth,
            showsSidebar: showsSidebar,
            showsTabBar: showsTabBar,
            showsSettings: app.showsSettings,
            mainPaneMoved: { mainPaneX = $0 },
            sessions: sessionsCard,
            conversation: conversationCard,
            split: splitModel.map(splitCard),
            panel: utilitiesPane
        ) { sidebarWidth, sidebarRange in
            SettingsView(
                sidebarWidth: sidebarWidth,
                sidebarRange: sidebarRange,
                resizeSidebar: { sessionsWidth = $0 },
                topInset: keepsTitleBar ? 0 : Metrics.windowControlsHeight,
                close: closeSettings
            )
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
        .animation(.ui, value: app.showsSettings)
        // Typing mustn't go on into a composer or terminal that Settings now hide; once they're
        // put away, it goes back to the conversation.
        .onChange(of: app.showsSettings) { _, shows in
            if shows { NSApp.mainWindow?.makeFirstResponder(nil) } else { returnKeyboard() }
            // Leaving Settings closes the sites you were signing in to.
            if !shows { app.settingsTabs.closeSites(machines: app.machines) }
        }
        // The agent started browsing: show it. The panel's open already, in the conversation it
        // was for (by now maybe another's in view): room is made for it.
        .onChange(of: utilities.revealRequest) { withAnimation(.ui) { tabs.keep(.changes) } }
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
        .overContentCard {
            if catalog.isSlow {
                SlowEngineNotice()
                    .fixedSize()
                    .centeredOnContentCard()
                    .padding(.top, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.ui, value: catalog.isSlow)
        .overContentCard {
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
                    .centeredOnContentCard()
                    .padding(.top, 80)
                }
                .transition(.opacity)
            }
        }
        .animation(.ui, value: showsOpenQuickly)
        .overContentCard {
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
                    .centeredOnContentCard()
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
        .branchBackupsSheet(isPresented: Binding(get: { backupsFolder != nil }, set: { if !$0 { backupsFolder = nil } }), folder: backupsFolder ?? "")
        // Escape stops the agent also when the composer doesn't have the keyboard.
        .background(EscapeToStop(canStop: actions.canStop && !app.showsSettings, stop: actions.stop))
        // Viewed only while you're here: finished while you're in another app, it waits for you
        // on the Dock icon, and counts as seen when you come back. The session beside the tab's
        // is in view too.
        .onChange(of: idlesInView) { if NSApp.isActive { markViewed() } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in markViewed() }
        // What follows the panel and the sidebar coming and going, and the sessions in view.
        .background {
            PaneFollower(tabs: tabs, utilities: utilities, contentWidth: contentWidth, returnKeyboard: returnKeyboard, markViewed: markViewed) {
                savedTabs = $0
                tabs.keep()
            }
        }
        .onChange(of: room, initial: true) { _, room in tabs.room = room }
        // New Project and Edit Project: a popup over whatever's in the window.
        .sheet(item: Binding { tabs.projectEditor } set: { tabs.projectEditor = $0 }) { projectSheet($0) }
        // The window's store outlives it: a window closed with the popup up doesn't bring it back.
        .onDisappear { tabs.projectEditor = nil }
        // Help › Report a Problem…: a new issue on GitHub, filled in.
        .sheet(isPresented: Binding { app.showsProblemReport } set: { app.showsProblemReport = $0 }) {
            ReportProblemSheet { app.showsProblemReport = false }
        }
        // What's New: once after an update (not while the first launch is under way), and from Help.
        .sheet(item: Binding { app.onboarding.isActive ? nil : app.whatsNew } set: { app.whatsNew = $0 }) { release in
            WhatsNewSheet(release: release) { app.whatsNew = nil }
        }
        .task { app.whatsNewAfterLaunch() }
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
            let primary = workspace.saveProject(primary, settings: settings, shown: Set(tabs.keys.compactMap(\.sessionID)))
            if request.project == nil { tabs.newSession(in: primary) }
        } close: {
            tabs.projectEditor = nil
        }
    }

    var body: some View {
        followingSessions
        // Behind the voice field, out of VoiceOver's reach while it listens (as under a sheet).
        .accessibilityHidden(app.dictation.voice != nil && app.dictation.style == .field)
        // Voice input in the voice field: over all of it.
        .overlay { VoiceFieldCover() }
        .animation(.ui, value: app.dictation.voice == nil)
        .task(id: activeDirectory) {
            if let activeDirectory { await workspace.loadBranch(for: activeDirectory) }
        }
        .onChange(of: workspace.sessions.map(\.id)) { tabs.dropClosed() }
        .onChange(of: groups.list.map(\.id)) { tabs.dropClosed() }
        // A terminal ended for you (its machine removed): its tab goes.
        .onChange(of: terminals.entries.count) { tabs.dropClosed() }
        .onChange(of: workspace.isLoaded) {
            // The list arrives just before loading counts as done, so check it again here.
            tabs.dropClosed()
            tabs.startIfEmpty()
        }
        // And once this Mac's box has said where its sessions go, which may come after.
        .onChange(of: workspace.isListed(BoxClient.thisMac)) { tabs.startIfEmpty() }
        .onAppear {
            // The sidebar as the window left it, from the start, not sliding there.
            var restoring = Transaction()
            restoring.disablesAnimations = true
            withTransaction(restoring) {
                tabs.restore(savedTabs, older: .init(tabs: olderTabs, selection: olderSelection, pairs: olderPairs, showsPanel: olderShowsPanel, showsSidebar: olderShowsSidebar))
            }
            (olderTabs, olderSelection, olderPairs, olderShowsPanel) = ("", nil, "", false)
            // Opened again after the window closed: the terminals went with it.
            tabs.dropClosed()
            tabs.startIfEmpty()
            // What changed while the window was away, kept too.
            savedTabs = tabs.saved
            tabs.keep()
        }
        .onChange(of: workspace.waitingCount, initial: true) { Notifier.shared.setBadge(workspace.waitingCount) }
        .onChange(of: showsBadge) { Notifier.shared.setBadge(workspace.waitingCount) }
        // Another tab: a rename in the last one's header ends, keeping what was typed.
        .onChange(of: selection) { _, key in if renaming?.id != key?.sessionID { renaming = nil } }
        // A tab of a sub-session's, as the app opens again: whose it is, so it shows as one.
        .task(id: sessionID) { if let sessionID { await workspace.findParent(of: sessionID) } }
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
                         openBeside: tabs.besideOpener, closeBeside: { tabs.closeBeside(TabKey($0)) }, closeBesideTab: { tabs.closeBesideTab(TabKey($0)) },
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

    /// Something over the cards (the command palette, Open Quickly, a picture looked at closer):
    /// clicks and the keyboard there are its, not the card's under it.
    private var overlayShown: Bool { showsPalette || showsOpenQuickly || ImageViewer.shared.request != nil }

    /// The tab strip's selection, by the tabs' written keys.
    private var tabSelection: Binding<String?> {
        Binding(get: { tabs.selection?.text }, set: { key in
            if let key { tabs.pick(TabKey(key)) } else { tabs.selection = nil }
        })
    }

    private func tabItem(for key: TabKey) -> TabItem? {
        let id = key.text
        switch key {
        case .draft(let directory):
            return TabItem(id: id, title: Workspace.isChat(directory) ? "New Chat" : "New Session", logo: nil, status: .idle)
        case .terminal:
            guard let entry = terminals.entry(id) else { return nil }
            return TabItem(id: id, title: entry.session.title, logo: nil, status: .idle, symbol: "apple.terminal")
        case .group(let group):
            guard let group = groups.group(group) else { return nil }
            let status: TabItem.Status = groups.isDiscussing(group.id) ? .working : groups.isUnread(group) && groupID != group.id ? .unread : .idle
            return TabItem(id: id, title: group.name, logo: nil, group: faces(of: group), status: status)
        case .session(let sessionID):
            if workspace.waitingMachine(for: sessionID) != nil {
                return TabItem(id: id, title: workspace.remoteTitle(sessionID) ?? "Session", logo: nil, status: .idle)
            }
            // A sub-session: its task, with the sign of one.
            if workspace.session(sessionID) == nil, let sub = workspace.subSession(sessionID) {
                return TabItem(id: id, title: SubagentTask.title(sub.title ?? ""), logo: nil, status: status(of: sub), symbol: "arrow.turn.down.right")
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
        if let id = groupID, let speaker = groups.speaker(in: id) { return [speaker] }
        return []
    }

    /// A group chat's bots, the one talking at work.
    private func faces(of group: BotGroup) -> [GroupAvatar.Face] {
        let speaker = groups.speaker(in: group.id)
        return group.members.compactMap { id in
            bots.bot(id).map { GroupAvatar.Face(look: $0.look, mood: $0.id == speaker ? .working : .idle) }
        }
    }

    private func logo(for ref: ModelRef?, in folder: String? = nil) -> String? {
        guard let ref else { return nil }
        return catalog(for: folder).model(ref)?.makerLogoID ?? ref.providerID
    }

    /// The sidebar row's own mark (`statusMark`), but news in view isn't news.
    private func status(of session: Session) -> TabItem.Status {
        switch statusMark(of: session, isNew: session.isUnread && !sessionsInView.contains(session.id), workspace: workspace, app: app) {
        case .needsYou: .waiting
        case .working: .working
        case .subagents: .subagents
        case .failed: .failed
        case .new: .unread
        case .offline: .offline
        default: .idle
        }
    }

    // MARK: Cards

    private var sessionsCard: some View {
        // No card of its own: the sessions sit on the window's glass.
        Card(title: "Sessions", isFocused: focus == .sessions, showsHeader: false, showsSurface: false) {
            EmptyView()
        } content: {
            SidebarView(stagedBots: stagedBots)
                .equatable()
            // Room for the window's buttons above the first row, when they sit here.
            .padding(.top, showsTabBar ? 0 : Metrics.windowControlsHeight)
        }
        .overlay(alignment: .top) {
            if !showsTabBar { WindowDragArea().frame(height: Metrics.windowControlsHeight) }
        }
        // Only the keyboard in it (its search, a rename) makes it the card you work in: a click
        // in it picks what you work in elsewhere.
        .onCardKeyboard(isOn: !overlayShown) { tabs.focus = .sessions }
        .background(KeyboardPlace(pane: .sessions, places: keyboardReturn))
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
        return Card(title: bot?.name ?? model.session.title ?? "New Session", detail: bot == nil ? workspace.projectName(of: model.session) : nil, isFocused: focus == .split, rename: bot == nil ? rename(model.session) : nil) {
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
        }
        .onTitle(bot.map { "Edit \($0.name)" }, bot.map { bot in { tabs.openBotEditor(bot: bot) } })
        .environment(catalog(for: directory))
        .id("split-" + id)
        .onCardClick(isOn: !overlayShown, keyboard: { keyboardReturn.remember($0, in: .split) }) { tabs.focus = .split }
    }

    /// The middle card: the session's in view, or another tab's over the session's last in view
    /// (and a group chat's a tab goes back to), kept made underneath.
    @ViewBuilder private var conversationCard: some View {
        let inView = sessionInView
        let groupInView = groupInView
        ZStack {
            if let model = inView ?? keptModel {
                sessionCard(model, kept: inView == nil)
                    .modifier(KeptOutOfSight(isKept: inView == nil))
            }
            if let group = groupInView ?? keptGroup {
                groupCard(group)
                    .modifier(KeptOutOfSight(isKept: groupInView == nil))
            }
            if inView == nil && groupInView == nil { otherCard }
        }
        // Named here, for the card in view: a kept one under it isn't asked.
        .navigationTitle(windowTitle(inView))
        .onChange(of: inView?.id, initial: true) { _, id in if let id { keptSession = id } }
        .onChange(of: groupInView?.id, initial: true) { _, id in if let id { keptGroupID = id } }
        .onCardClick(isOn: !overlayShown, keyboard: { keyboardReturn.remember($0, in: .conversation) }) { tabs.focus = .conversation }
    }

    /// The session kept made under another tab's card, while its tab is open or a tab's way back
    /// goes through it, and not beside the tab in view (where it's made already).
    private var keptModel: SessionModel? {
        guard let id = keptSession, id != besideID, tabs.isKept(.session(id)) else { return nil }
        return workspace.model(for: id)
    }

    /// The group chat in view, unless an editor or a terminal's card is over it.
    private var groupInView: BotGroup? {
        guard tabs.groupEditor == nil, tabs.botEditor == nil else { return nil }
        if let key = selection, terminals.entry(key.text) != nil { return nil }
        return groupID.flatMap { groups.group($0) }
    }

    /// The group chat kept made under another card while a tab's way back goes through it, to be
    /// where you were reading when you're back.
    private var keptGroup: BotGroup? {
        guard let id = keptGroupID, tabs.isOnWayBack(.group(id)) else { return nil }
        return groups.group(id)
    }

    /// A group chat's card, in view or kept (`keptGroup`).
    private func groupCard(_ group: BotGroup) -> some View {
        Card(title: group.name, detail: groupDetail(group), isFocused: focus == .conversation) {
            GroupAvatar(faces: faces(of: group), size: 20)
        } actions: {
            // What its bots made, in a popover over the chat.
            MadeButton(place: .group(group, box: groups.machine(of: group.id) ?? BoxClient.mac))
            Button("Edit Group Chat", systemImage: "slider.horizontal.3") { tabs.openGroupEditor(group: group) }
                .help("Edit Group Chat: its name, bots and lead")
                .disabled(app.moves.isMoving(group.id))
            Button("Close Tab", systemImage: "xmark") { tabs.close(.group(group.id)) }
                .help("Close Tab")
        } content: {
            VStack(spacing: 0) {
                // Opened from another conversation: the way back to it, as a subagent's.
                if let back = tabs.back(of: .group(group.id)) {
                    BackBar(to: app.backName(back)) { tabs.goBack() }
                }
                GroupChatView(group: group, findRequest: groupFind, focusRequest: tabs.groupFocus)
            }
        }
        .onTitle("Edit Group Chat", app.moves.isMoving(group.id) ? nil : { tabs.openGroupEditor(group: group) })
        .id(TabKey.group(group.id))
    }

    /// The session whose card the tab in view shows, if that's what it shows: not with an editor
    /// over it, nor for a terminal's, a group chat's or a subagent's conversation.
    private var sessionInView: SessionModel? {
        guard tabs.groupEditor == nil, tabs.botEditor == nil else { return nil }
        if let key = selection, terminals.entry(key.text) != nil { return nil }
        if let id = groupID, groups.group(id) != nil { return nil }
        guard let id = sessionID, workspace.session(id) != nil || workspace.parent(of: id) == nil else { return nil }
        return workspace.model(for: id)
    }

    /// The window's title: the session's in view, a new session's, or Kuvo Code's own.
    private func windowTitle(_ inView: SessionModel?) -> String {
        if let inView { return inView.session.title ?? "New Session" }
        guard tabs.groupEditor == nil, tabs.botEditor == nil, let directory = draftDirectory, machine(for: directory)?.isReady ?? true else { return AppInfo.name }
        return "New Session"
    }

    /// A session's card, in view or kept (`keptSession`).
    @ViewBuilder private func sessionCard(_ model: SessionModel, kept: Bool) -> some View {
        let id = model.id
        let directory = model.session.location.directory
        let machine = machine(for: directory)
        let bot = bots.bot(forSession: id)
        // A bot's card has its name only: its avatar shows where it lives.
        Card(title: bot?.name ?? model.session.title ?? "New Session", detail: bot == nil ? workspace.projectName(of: model.session) : nil, isFocused: focus == .conversation, rename: bot == nil ? rename(model.session) : nil) {
            if let bot {
                // Still: in view, the bot moves in its conversation.
                BotAvatar(look: bot.look, size: 18, mood: bots.mood(of: bot, in: workspace), animates: false)
                    .overlay(alignment: .bottomTrailing) {
                        if let machine = bot.machine { MachineBadge(machine: machine, size: 10).offset(x: 3, y: 3) }
                    }
            } else if let logo = logo(for: model.session.model, in: directory) { ProviderLogo(id: logo, size: 14) } else { Image(systemName: "bubble.left") }
        } actions: {
            // What it made, in a popover over the conversation: a bot's Shelf, or a
            // session's outputs besides code (its Changes are in the panel).
            MadeButton(place: bot.map { .bot($0) } ?? .session(id, box: Workspace.box(of: directory)))
            if let bot {
                Button("Edit Bot", systemImage: "slider.horizontal.3") { tabs.openBotEditor(bot: bot) }
                    .help("Edit Bot: its look, job, wake-ups and memory")
            }
            if workspace.isInChats(model.session) {
                MoveToProjectButton(sessionID: id)
            }
            // Its feed down for now: a quiet mark only, not an outage (that's the bar over the
            // composer, once KuvoClient's `Reach` says it's out of reach).
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
            VStack(spacing: 0) {
                // Opened from another conversation: the way back to it, as a subagent's.
                if let back = tabs.back(of: .session(id)) {
                    BackBar(to: app.backName(back)) { tabs.goBack() }
                }
                SessionView(model: model)
                    .environment(\.bot, bot)
                    .environment(\.takesCardKeys, !kept && !(focus == .split && besideID != nil))
                    // Typing here is working here, however the keyboard got here.
                    .environment(\.composerFocused) { tabs.focus = .conversation }
            }
        }
        .onTitle(bot.map { "Edit \($0.name)" }, bot.map { bot in { tabs.openBotEditor(bot: bot) } })
        .environment(catalog(for: directory))
    }

    /// Any other tab's card: an editor, a terminal, a subagent's conversation, a session waiting
    /// for its machine, a new session, or the welcome (a group chat's is `groupCard`).
    @ViewBuilder private var otherCard: some View {
        Group {
            if let request = tabs.groupEditor {
                Card(title: request.group.map { "Edit \($0.name)" } ?? "New Group Chat", isFocused: focus == .conversation) {
                    if let group = request.group { GroupAvatar(faces: faces(of: group), size: 20) } else { Image(systemName: "person.2") }
                } actions: {
                    Button("Close", systemImage: "xmark") { withAnimation(.ui) { tabs.groupEditor = nil } }
                        .help("Close")
                } content: {
                    GroupEditor(group: request.group, machine: request.machine, newBot: { tabs.openBotEditor(bot: nil) }) {
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
                    BotEditor(bot: request.bot, recipe: request.recipe, machine: request.machine) {
                        // This editor's, not one opened since (a delete that took a while).
                        if tabs.botEditor?.id == request.id { withAnimation(.ui) { tabs.botEditor = nil } }
                    } created: { bot in
                        // Its tab opens in place of this editor, not of one opened since.
                        if tabs.botEditor?.id == request.id { tabs.open(.session(bot.sessionID)) }
                    }
                }
                .id(request.id)
            } else if let key = selection, let entry = terminals.entry(key.text) {
                Card(title: entry.session.title, detail: workspace.projectName(entry.directory), isFocused: focus == .conversation) {
                    Image(systemName: "apple.terminal")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { tabs.close(key) }
                        .help("Close Tab")
                } content: {
                    TerminalHost(session: entry.session)
                }
                .id(key)
            } else if let id = sessionID, workspace.session(id) == nil, let parent = workspace.parent(of: id) {
                // A sub-session: the conversation of a subagent its session's agent started.
                let root = workspace.session(workspace.root(of: id))
                Card(title: SubagentTask.title(workspace.subSession(id)?.title ?? workspace.subagentTitle(id) ?? ""), detail: root.map { workspace.projectName(of: $0) }, isFocused: focus == .conversation) {
                    Image(systemName: "arrow.turn.down.right")
                } actions: {
                    Button("Close Tab", systemImage: "xmark") { tabs.close(.session(id)) }
                        .help("Close Tab")
                } content: {
                    SubagentPane(id: id, folder: root?.location.directory ?? workspace.subSession(id)?.location.directory ?? "", parent: parent)
                }
                .onAppear { workspace.rememberOpened(id) }
                .id(id)
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
                        // (Kept by the new-session composer until it's gone.)
                        workspace.model(for: session.id)?.submit(text, files: files, for: catalog.model(session.model), queue: false, commands: catalog.commands(in: directory), keptElsewhere: true)
                    }
                }
                .environment(catalog)
                .id(directory)
            } else {
                Card(title: AppInfo.name, isFocused: focus == .conversation) {
                    AppLogo(size: 16)
                } content: {
                    // The welcome only once the sessions are read and none opened: until then
                    // the latest may still open here, and the welcome would flash first.
                    if workspace.isLoaded {
                        WelcomeView(openFolder: openFolder, newChat: { tabs.newChat() }, showProviders: { app.openSettings(.accounts) })
                    } else {
                        Color.clear
                            .accessibilityHidden(true)
                    }
                }
            }
        }
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

    /// The keyboard back in the conversation you work in (the session beside, in a split), when
    /// the card `leaving` had it or nothing has it: to what had it there last, or else its
    /// composer. Where it is is read now, while what's leaving is still in place; it moves after
    /// SwiftUI's update.
    private func returnKeyboard(leaving: WindowTabs.Pane? = nil) {
        let had = leaving.map(keyboardReturn.isIn) ?? false
        // The card you work in is one on screen: the one going leaves you in the conversation, or
        // the expanded panel over it.
        if let leaving, tabs.focus == leaving { tabs.focus = showsPanel && panelExpanded ? .changes : tabs.activeHalf }
        DispatchQueue.main.async {
            guard !app.showsSettings, !(showsPanel && panelExpanded), had || keyboardReturn.isNowhere else { return }
            if !keyboardReturn.handBack(to: tabs.activeHalf) { tabs.focusComposer() }
        }
    }

    /// The panel's and the sidebar's buttons, which show what's on screen.
    private var panelToggle: PaneSwitch { PaneSwitch(isOn: { panelOnScreen }, set: { tabs.showPanel($0) }) }
    /// Room kept free in the title bar while the window is dragged narrower: its width reaches
    /// the tabs a pass late, and a strip wider than the room left would be put away in the
    /// toolbar's overflow and back, again and again.
    private var resizeRoom: CGFloat { window.isResizing ? 72 : 0 }

    private var sidebarToggle: PaneSwitch { PaneSwitch(isOn: { sidebarOnScreen }, set: { tabs.showSidebar($0) }) }

    private var utilitiesPane: some View {
        // The panel of the session you work in (the one beside, as its panel is then): its changes,
        // files and terminals.
        UtilitiesPane(
            utilities: utilities,
            directory: focusedDirectory,
            folders: focusedDirectory.map { [$0] + workspace.extraFolders($0) } ?? [],
            model: focusedModel,
            environment: app.shellEnvironment,
            isExpanded: PaneSwitch(isOn: { tabs.panelExpanded }, set: { tabs.panelExpanded = $0 }),
            isFocused: focus == .changes
        )
        .environment(catalog(for: focusedDirectory))
        .onCardClick(isOn: !overlayShown) { tabs.focus = .changes }
        .background(KeyboardPlace(pane: .changes, places: keyboardReturn))
    }

    /// Opens the panel on a tool.
    private func showInPanel(_ open: () -> Void) {
        withAnimation(.ui) {
            open()
            tabs.showPanel()
            app.showsSettings = false
        }
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
    /// open, it closes the window, as it does in browsers.
    private func closeAnyTab() {
        if app.showsSettings {
            if app.settingsTabs.tabs.count > 1 {
                withAnimation(.ui) { app.settingsTabs.close(app.settingsTabs.selectedID, machines: app.machines) }
            } else {
                closeSettings()
            }
        } else if !tabs.closeInView() {
            NSApp.keyWindow?.performClose(nil)
        }
    }

    // MARK: Actions

    private var actions: SessionActions {
        let model = focusedModel
        return SessionActions(
            hasSession: model != nil,
            hasProject: focusedProject != nil,
            panelHasProject: utilities.hasProject,
            canStop: model?.isRunning == true,
            canReopenTab: tabs.canReopenTab,
            canGoBack: tabs.canGoBack,
            goBack: tabs.goBack,
            newSession: { tabs.newSession(in: nil) },
            newTerminalTab: { tabs.openTerminalTab(command: nil) },
            openFolder: openFolder,
            newProject: { tabs.openProjectEditor(ProjectEditorRequest(project: nil)) },
            newBot: { tabs.openBotEditor(bot: nil) },
            importBot: { if let recipe = BotRecipe.pick() { tabs.openBotEditor(bot: nil, recipe: recipe) } },
            newGroup: { tabs.openGroupEditor(group: nil) },
            newChat: { tabs.newChat() },
            stop: { model?.stop() },
            isPlanning: model?.session.agent == "plan",
            togglePlan: { model?.togglePlan() },
            showDecisions: model?.decisionsToShow,
            branchBackups: { if let model { backupsFolder = model.session.location.directory } },
            togglePanel: { withAnimation(.ui) { tabs.showPanel(!panelOnScreen) } },
            showChanges: { showInPanel { utilities.showChanges() } },
            showFiles: { showInPanel { utilities.showFiles() } },
            showWorkQueue: { showInPanel { utilities.showWorkQueue() } },
            newTerminal: { showInPanel { utilities.newTerminal(in: focusedDirectory, environment: app.shellEnvironment) } },
            run: runProject,
            newBrowser: { showInPanel { utilities.newBrowser() } },
            toggleSidebar: { withAnimation(.ui) { tabs.showSidebar(!sidebarOnScreen) } },
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
            PaletteItem(id: "session:" + session.id, kind: .session, title: session.title ?? "New Session", detail: workspace.projectName(of: session),
                        symbol: workspace.worktrees[session.location.directory] == nil ? "bubble.left" : "arrow.triangle.branch") {
                tabs.open(.session(session.id))
                // As from the sidebar: no way back.
                tabs.startFresh(.session(session.id))
            }
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
            add("Run", "play", "⌘R", detail: runCommand, actions.run)
        }
        add("New Terminal", "apple.terminal", "⌃⇧`", actions.newTerminalTab)
        add("New Terminal in Panel", "terminal", "⌃`", actions.newTerminal)
        add("New Browser Tab", "globe", "⌥⌘B", actions.newBrowser)
        add("Show Changes", "plusminus", "⌥⌘I", actions.showChanges)
        add("Show Work Queue", "checklist", "⌥⌘U", actions.showWorkQueue)
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
                tabs.openProjectEditor(ProjectEditorRequest(project: workspace.projects.first { $0.directory == primary } ?? Workspace.Project(directory: primary, sessions: [], settings: workspace.settings[primary] ?? .init())))
            }
        }
        if let model = focusedModel {
            add(model.session.agent == "plan" ? "Leave Plan Mode" : "Plan Mode", "list.bullet.clipboard", "⌥⌘2", actions.togglePlan)
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
            tabs.openProjectEditor(ProjectEditorRequest(project: project, focusesRun: true))
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
            showSidebar: { tabs.showSidebar($0) },
            showPalette: { showsPalette = true },
            openQuickly: {
                showsPalette = false
                showsOpenQuickly = true
            },
            renameInView: { if let session = activeModel?.session { renaming = session } },
            runProject: { runProject() },
            newProject: { tabs.openProjectEditor(ProjectEditorRequest(project: nil, folders: $0)) }
        )
    }
    #endif
}

/// The window's cards, laid out for the room it has: the sidebar, the conversation, the session
/// beside it and the panel, with the gaps between them to resize them by, and Settings in their
/// place while they show. The cards come made; this lays them out. It's the one view that reads
/// which of them show and how wide, so showing or hiding the panel lays them out again without
/// the window's view (and every card in it) being worked out again: that took the first frame of
/// each slide.
private struct WindowCards<Sessions: View, Conversation: View, Split: View, Panel: View, Settings: View>: View {
    let tabs: WindowTabs
    @Binding var sessionsWidth: Double
    @Binding var changesWidth: Double
    @Binding var splitWidth: Double
    let showsSidebar: Bool
    let showsTabBar: Bool
    let showsSettings: Bool
    /// Where the conversation's card starts in the window, as it moves.
    let mainPaneMoved: (CGFloat) -> Void
    let sessions: Sessions
    let conversation: Conversation
    /// The session beside the tab's, when it has one.
    let split: Split?
    let panel: Panel
    /// Settings, given the sidebar's width and how wide it may be dragged.
    @ViewBuilder let settings: (Double, ClosedRange<Double>) -> Settings
    /// The room the conversation and the panel share: what the panel takes, expanded.
    @State private var mainAreaWidth: CGFloat = 0
    /// The panel has shown, and is kept from then on.
    @State private var panelMade = false
    /// How wide the panel was last shown: kept, hidden.
    @State private var panelWidth: CGFloat = 0

    var body: some View {
        // Cards are sized from the room the window actually has, so they never spill
        // past its edges. The gaps between them are drag handles for resizing.
        GeometryReader { proxy in
            // Expanded, the panel grows over the conversation, which keeps its room (and its
            // layout) underneath for when it comes back.
            let layout = tabs.layout(available: proxy.size.width)
            let expands = tabs.showsPanel && tabs.panelExpanded
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
                // Which cards show, for what's centered on the conversation to slide with it.
                let cardsShown = [layout.sessions != nil, layout.split != nil, layout.changes != nil, expands]
                ZStack(alignment: .trailing) {
                    HStack(spacing: 0) {
                        conversation
                            .frame(maxWidth: .infinity)
                            // Another session shows at once, as the tab moves to it: animated, the
                            // last one faded out row by row under the new one, both drawn meanwhile.
                            .transaction(value: tabs.selection) { $0.animation = nil }
                            .environment(\.windowControlsInset, controlsInset)
                            // With the tab bar hidden, the panel button sits over the rightmost card.
                            .environment(\.windowControlsTrailingInset, !showsTabBar && layout.changes == nil && layout.split == nil ? 36 : 0)
                            .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .global).minX }) { mainPaneMoved($0) }
                            .contentCard(layout: cardsShown)
                            // Under the expanded panel: out of reach, keys too (a card's Return
                            // or Esc), until it's back.
                            .disabled(expands)
                            .allowsHitTesting(!expands)
                            .accessibilityHidden(expands)
                        // Split view: another session beside it, sized like the side cards.
                        if let width = layout.split, let split {
                            PaneResizer(
                                width: Binding(get: { width }, set: { splitWidth = $0 }),
                                range: PaneLayout.splitRange.lowerBound...max(PaneLayout.splitRange.lowerBound, layout.splitMax),
                                side: .trailing
                            )
                            .allowsHitTesting(!expands)
                            split
                                .frame(width: width)
                                .contentCard(layout: cardsShown)
                                .environment(\.windowControlsTrailingInset, !showsTabBar && layout.changes == nil ? 36 : 0)
                                .transaction(value: tabs.showsPanel) { $0.animation = nil }
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
                    // Made the first time it shows, then kept while it's hidden, out past the
                    // window's right edge, as the sidebar is: showing it again only slides it in.
                    // Made again each time, it (and the tab in it) took half of the slide's first
                    // frame. What it shows stops its work meanwhile (`isPanelShown`).
                    let shown = tabs.showsPanel && (layout.changes != nil || expands)
                    if shown || panelMade {
                        // Going, as it was: a terminal or a page in it isn't laid out again for
                        // another width as it slides away.
                        let width = shown ? (expands ? mainAreaWidth : layout.changes ?? mainAreaWidth) : panelWidth
                        panel
                            .frame(width: width)
                            .onGeometryChange(for: CGFloat.self, of: \.size.width) { if shown { panelWidth = $0 } }
                            .contentCard(expands ? .expandedPanel : nil, layout: cardsShown)
                            .environment(\.windowControlsInset, tabs.panelExpanded ? controlsInset : 0)
                            .environment(\.windowControlsTrailingInset, showsTabBar ? 0 : 36)
                            .environment(\.isPanelShown, shown)
                            .offset(x: shown ? 0 : width + Metrics.paneGap * 2)
                            .opacity(shown ? 1 : 0)
                            .allowsHitTesting(shown)
                            .disabled(!shown)
                            .accessibilityHidden(!shown)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                            .onAppear { panelMade = true }
                    }
                }
            }
            // Made once and kept while it's hidden, out past the window's left edge: showing it
            // again only slides it in. Made again each time, it (and each of its bots) took the
            // first tenth of a second of the slide.
            .overlay(alignment: .topLeading) {
                let shown = layout.sessions != nil
                let width = layout.sessions ?? sessionsWidth
                sessions
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
            .environment(\.isConversationShown, !showsSettings)
            .opacity(showsSettings ? 0 : 1)
            .allowsHitTesting(!showsSettings)
            .disabled(showsSettings)
            .accessibilityHidden(showsSettings)
            .overlay {
                if showsSettings {
                    let widest = max(PaneLayout.sessionsRange.lowerBound, min(PaneLayout.sessionsRange.upperBound, proxy.size.width * 0.4))
                    settings(min(max(layout.sessions ?? sessionsWidth, PaneLayout.sessionsRange.lowerBound), widest), PaneLayout.sessionsRange.lowerBound...widest)
                        .transition(.opacity)
                }
            }
        }
        // Opened or closed, it slides; open or closed in the conversation you switch to, it's
        // there at once, as the conversation is.
        .animation(.ui, value: tabs.panelTurns)
        .animation(.ui, value: tabs.panelExpanded)
    }
}

/// A card kept made under the one in view: out of sight, out of reach of the pointer, the
/// keyboard and VoiceOver, and out of sight to its conversations (whose rows would otherwise still
/// follow the pointer) and its composer.
private struct KeptOutOfSight: ViewModifier {
    let isKept: Bool
    @Environment(\.isConversationShown) private var isShown
    /// The size it had in view, which it keeps while kept: resizing the window (or the panel
    /// coming and going) lays out only the card in view, as SessionView's hidden ones do.
    @State private var size: CGSize?

    func body(content: Content) -> some View {
        content
            .frame(width: isKept ? size?.width : nil, height: isKept ? size?.height : nil)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { if !isKept { size = $0 } }
            // However big that was, the card is the size it's given.
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
            .environment(\.isConversationShown, isShown && !isKept)
            .environment(\.isKeptOutOfSight, isKept)
            .opacity(isKept ? 0 : 1)
            .allowsHitTesting(!isKept)
            .disabled(isKept)
            .accessibilityHidden(isKept)
    }
}

extension EnvironmentValues {
    /// The card is kept made under another tab's (`KeptOutOfSight`): as good as gone, until its
    /// tab is back.
    @Entry var isKeptOutOfSight = false
}

extension View {
    /// A popover, sheet or dialog shown from a card that's then kept out of sight closes, rather
    /// than staying over another tab's card for one you can't see.
    func closesWhenKept(_ isPresented: Binding<Bool>) -> some View {
        modifier(ClosesWhenKept(isPresented: isPresented))
    }
}

private struct ClosesWhenKept: ViewModifier {
    @Binding var isPresented: Bool
    @Environment(\.isKeptOutOfSight) private var isKept

    func body(content: Content) -> some View {
        content.onChange(of: isKept) { _, kept in if kept, isPresented { isPresented = false } }
    }
}

/// What follows the panel and the sidebar coming and going, and the sessions in view: in a view
/// of its own, for the window's view not to read them (see `WindowCards`).
private struct PaneFollower: View {
    let tabs: WindowTabs
    let utilities: Utilities
    let contentWidth: CGFloat
    let returnKeyboard: (WindowTabs.Pane?) -> Void
    let markViewed: () -> Void
    /// Keeps the tabs (and whether the panel shows) with the scene, as they change.
    let save: (String) -> Void

    var body: some View {
        let layout = tabs.layout(available: contentWidth)
        Color.clear
            // Nor into the conversation the expanded panel covers (its composer, if it had the
            // keyboard; the panel's own terminal or page keeps it).
            .onChange(of: tabs.showsPanel && tabs.panelExpanded) { _, expanded in
                guard expanded else { return returnKeyboard(nil) }
                guard let window = NSApp.mainWindow, let editor = window.firstResponder as? NSTextView,
                      editor.isFieldEditor || editor is MessageTextView else { return }
                window.makeFirstResponder(nil)
            }
            // The panel or the sidebar going takes the keyboard with it, if either had it: it goes
            // back to the conversation. One coming in leaves it where it is.
            .onChange(of: tabs.showsPanel && (tabs.panelExpanded || layout.changes != nil)) { _, shown in if !shown { returnKeyboard(.changes) } }
            .onChange(of: layout.sessions != nil) { _, shown in if !shown { returnKeyboard(.sessions) } }
            // Viewed only while you're here: finished while you're in another app, it waits for you
            // on the Dock icon, and counts as seen when you come back. The session beside the tab's
            // is in view too.
            .onChange(of: tabs.sessionsSeen) { if NSApp.isActive { markViewed() } }
            // The panel follows what's in view, all at once: the conversations, the half you work in,
            // its place, and the bots in view.
            .onChange(of: tabs.inView, initial: true) { _, inView in utilities.inView = inView }
            .onChange(of: tabs.snapshot) { _, saved in save(saved.text) }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
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
    /// The machine a new one starts on; nil for this Mac.
    var machine: String?
}

struct GroupEditorRequest: Identifiable {
    let id = UUID()
    let group: BotGroup?
    /// The machine a new one starts on; nil for this Mac.
    var machine: String?
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

/// What had the keyboard last in the conversation and in the session beside it (a composer, a
/// terminal tab, a field), to give it back to when what took it goes: the panel or the sidebar
/// closing, Settings put away. And where the panel's and the sidebar's cards are, to tell whether
/// the one going has it.
@MainActor private final class KeyboardReturn {
    private weak var conversation: NSView?
    private weak var split: NSView?
    private var places: [WindowTabs.Pane: Weak] = [:]

    private struct Weak { weak var view: NSView? }

    func remember(_ view: NSView, in pane: WindowTabs.Pane) {
        if pane == .split { split = view } else { conversation = view }
    }

    func place(_ view: NSView, of pane: WindowTabs.Pane) {
        places[pane] = Weak(view: view)
    }

    /// Whether the keyboard is in `pane`'s card.
    func isIn(_ pane: WindowTabs.Pane) -> Bool {
        guard let place = places[pane]?.view, let view = place.window?.firstResponder as? NSView else { return false }
        return view.isInCard(place)
    }

    /// Whether nothing in the window has the keyboard.
    var isNowhere: Bool {
        guard let window = (conversation ?? split)?.window ?? places.values.lazy.compactMap({ $0.view?.window }).first else { return false }
        guard let view = window.firstResponder as? NSView else { return true }
        return view.window !== window || view === window.contentView?.superview
    }

    /// Gives the keyboard back to what had it last in `pane`, if that's still there to type in.
    func handBack(to pane: WindowTabs.Pane) -> Bool {
        guard let view = pane == .split ? split : conversation, let window = view.window,
              !view.isHiddenOrHasHiddenAncestor, !view.visibleRect.isEmpty else { return false }
        return window.firstResponder === view || window.makeFirstResponder(view)
    }
}

/// Where a card is, for `KeyboardReturn` to tell whether the keyboard is in it.
private struct KeyboardPlace: NSViewRepresentable {
    let pane: WindowTabs.Pane
    let places: KeyboardReturn

    func makeNSView(context: Context) -> Place { Place() }

    func updateNSView(_ view: Place, context: Context) {
        places.place(view, of: pane)
    }

    final class Place: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
