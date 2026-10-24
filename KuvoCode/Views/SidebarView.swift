import OpenCodeKit
import SwiftUI
import UsageKit
import UniformTypeIdentifiers

/// New Session on top, then projects (each a folder that opens to its sessions), then
/// the most recent sessions across projects, and the connected accounts at the bottom.
/// Rows are flat: a soft fill under the pointer, accent glass under the open session.
struct SidebarView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app

    @Binding var selection: String?
    let newSession: (String?) -> Void
    let newProject: () -> Void
    let editProject: (Workspace.Project) -> Void
    let showProviders: () -> Void
    let newBot: () -> Void
    let editBot: (Bot) -> Void
    let newGroup: () -> Void
    let editGroup: (BotGroup) -> Void
    /// A conversation in the project, where its new sessions open a terminal instead.
    let newConversation: (String) -> Void
    /// Ends a terminal tab.
    let closeTerminal: (String) -> Void
    /// Bots moving in the main card; their rows hold still.
    var stagedBots: Set<String> = []
    /// Shows a session beside the one in view (split view).
    var openBeside: ((String) -> Void)?
    @Environment(Bots.self) private var bots
    @Environment(GroupChats.self) private var groups
    /// The group chat waiting for the user to confirm its deletion.
    @State private var deletingGroup: BotGroup?

    /// Folders the user closed, by path (newline-separated).
    @AppStorage("collapsedProjects") private var collapsedStorage = ""
    /// Sections the user folded away: "pinned", "bots", "chats", "projects", "recents" (newline-separated).
    @AppStorage("collapsedSections") private var foldedStorage = ""
    /// The box in view, by id ("mac", or a machine's), each a page of its own.
    @AppStorage("sidebarBox") private var boxID = "mac"
    /// Projects showing all their sessions instead of the latest few.
    @State private var showsAll: Set<String> = []
    /// Where sessions were picked from. A session shows in its project and in Recents; only
    /// the row you clicked is highlighted (both open the same tab). The one you leave keeps its
    /// place until the selection has moved, so its highlight doesn't jump to its project first.
    @State private var pickedIn: [String: Place] = [:]
    /// A session being renamed, in its row where Rename was chosen.
    @State private var renaming: RenameTarget?
    /// The session waiting for the user to confirm its deletion.
    @State private var deleting: Session?
    /// A session in a worktree being archived, while the user decides about its worktree.
    @State private var archiving: Session?
    /// The worktree of the session being archived or deleted has changes that aren't committed.
    @State private var worktreeIsDirty = false

    private enum Place { case pinned, project, chats, recents }

    private struct RenameTarget: Equatable {
        let id: String
        let place: Place
    }
    /// Sessions whose title or project has this, instead of the usual lists.
    @State private var search = ""
    /// Sessions whose conversations have the search, with the words around it.
    @State private var conversationResults: [(session: Session, snippet: String)] = []
    @State private var isSearchingConversations = false

    /// A project lists this many sessions until you ask for the rest.
    private static let sessionsPerProject = 5
    private static let recentCount = 8

    /// The selection tag of a project's not-yet-sent new session.
    static func draftTag(_ directory: String) -> String { TabKey.draft(directory).text }

    static func draftDirectory(from tag: String) -> String? {
        TabKey(tag).draftFolder
    }

    var body: some View {
        VStack(spacing: 0) {
            // Above the boxes' pages: a new session on the box in view, and a search of them all.
            VStack(alignment: .leading, spacing: 1) {
                SidebarRow(isSelected: false, action: newSessionHere) {
                    Image(systemName: "square.and.pencil")
                } title: {
                    Text("New Session")
                }
                .help("New Session (⌘N)")

                SidebarSearchRow(text: $search)

                if boxes.count > 1, search.isEmpty {
                    BoxSwitchLine(boxes: boxes, selected: boxBinding)
                        .padding(.top, 8)
                }

            }
            .padding(.top, 10)

            if !search.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        searchResults
                    }
                    .padding(.vertical, 10)
                }
                .scrollIndicators(.never)
                .fadingScrollEdges()
            } else {
                BoxPager(boxes: boxes, selected: boxBinding) { box in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 1) {
                            page(box)
                        }
                        // No inset of its own: on the glass, the window's 8pt gap is the sidebar's
                        // edge, as it is the cards', and the rows' icons line up under the window's
                        // buttons.
                        .padding(.vertical, 10)
                    }
                    .scrollIndicators(.never)
                    .fadingScrollEdges()
                }
            }

            if !Analytics.shared.noticeShown {
                AnalyticsNotice()
                    .padding(.bottom, 10)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            // Barely there, and fading out at both ends: it sets the accounts apart without
            // drawing a rule across the glass.
            Rectangle()
                .fill(LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .primary.opacity(0.07), location: 0.2),
                        .init(color: .primary.opacity(0.07), location: 0.8),
                        .init(color: .clear, location: 1),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                ))
                .frame(height: 1)
            // Its bottom on the cards' bottom edge.
            AccountsRow(showProviders: showProviders)
                .padding(.top, 6)
        }
        // Rows mark what's on a machine only in search results, which cover every computer.
        .environment(\.marksMachines, !search.isEmpty)
        #if DEBUG
        // KUVO_DEMO_BOX: the box in view (`mac`, or a machine's name), once what was open has
        // opened (it brings its own box first).
        .task {
            guard let wanted = ProcessInfo.processInfo.environment["KUVO_DEMO_BOX"] else { return }
            try? await Task.sleep(for: .seconds(5))
            if let box = boxes.first(where: { $0.id == wanted || boxName($0) == wanted }) {
                withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { boxID = box.id }
            }
        }
        // KUVO_DEMO_SEARCH: text in the sidebar's search field.
        .onAppear { if let text = ProcessInfo.processInfo.environment["KUVO_DEMO_SEARCH"] { search = text } }
        // KUVO_DEMO_RENAME=sidebar: the session in view, renamed in its row.
        .task {
            guard ProcessInfo.processInfo.environment["KUVO_DEMO_RENAME"] == "sidebar" else { return }
            try? await Task.sleep(for: .seconds(2))
            if let selection, let session = workspace.session(selection) {
                renaming = RenameTarget(id: selection, place: Workspace.isChat(session.location.directory) ? .chats : .project)
            }
        }
        #endif
        // Only the open session's place is remembered; picked elsewhere, it shows in its project.
        .onChange(of: selection) { pickedIn = pickedIn.filter { $0.key == selection } }
        // A tab on another box: its page slides in, so what's in view has its row in sight.
        .onChange(of: selection) { _, tag in
            guard let tag, let shown = box(of: tag), shown != box, boxes.contains(shown) else { return }
            withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { boxID = shown.id }
        }
        // Another session picked: a rename in another row ends, keeping what was typed.
        .onChange(of: selection) { if renaming?.id != selection { renaming = nil } }
        // Titles match as you type; conversations once you pause.
        // Again once the sessions are in: a search typed while they load found none.
        .task(id: "\(search)\n\(workspace.isLoaded)") {
            let query = search.trimmingCharacters(in: .whitespaces)
            guard query.count >= 3 else {
                conversationResults = []
                isSearchingConversations = false
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            isSearchingConversations = true
            let found = await workspace.searchConversations(query)
            guard !Task.isCancelled else { return }
            conversationResults = found
            isSearchingConversations = false
            Analytics.shared.track("conversations_searched", ["found": min(found.count, 20)])
        }
        .alert("Delete \(deletingGroup?.name ?? "This Group Chat")?", isPresented: Binding(get: { deletingGroup != nil }, set: { if !$0 { deletingGroup = nil } })) {
            Button("Delete", role: .destructive) {
                if let group = deletingGroup { Task { await groups.delete(group) } }
                deletingGroup = nil
            }
            Button("Cancel", role: .cancel) { deletingGroup = nil }
        } message: {
            Text("Its messages are deleted, and its bots stop remembering it. This can’t be undone.")
        }
        .alert(
            deleting.flatMap(\.title).map { "Delete “\($0)”?" } ?? "Delete This Session?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
        ) {
            if let session = deleting, hasOwnWorktree(session) {
                Button("Delete and Remove Worktree", role: .destructive) { delete(session, removingWorktree: true) }
                Button("Delete Session Only") { delete(session, removingWorktree: false) }
            } else {
                Button("Delete", role: .destructive) { if let session = deleting { delete(session, removingWorktree: false) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let session = deleting, hasOwnWorktree(session) {
                Text("The session and its transcript will be deleted. This can't be undone. " + worktreeNote(session))
            } else {
                Text("The session and its transcript will be deleted. This can't be undone.")
            }
        }
        .alert("Remove Its Worktree Too?", isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } })) {
            if let session = archiving {
                Button("Archive and Remove Worktree", role: worktreeIsDirty ? .destructive : nil) { archive(session, removingWorktree: true) }
                Button("Archive Only") { archive(session, removingWorktree: false) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let session = archiving { Text(worktreeNote(session)) }
        }
    }

    // MARK: Boxes

    /// How the boxes are switched besides the swipe (Settings › Appearance).

    /// This Mac, then your machines, each a page of its own.
    private var boxes: [SidebarBox] { app.boxes }

    /// The box in view: the one last picked, while it's still there.
    private var box: SidebarBox {
        let picked = SidebarBox(id: boxID)
        return boxes.contains(picked) ? picked : .mac
    }

    private var boxBinding: Binding<SidebarBox> {
        Binding { box } set: { boxID = $0.id }
    }

    private func boxName(_ box: SidebarBox) -> String { app.name(of: box) }

    /// The box what's in view (a tab: a session, a bot, a group chat, a draft, a terminal) is on;
    /// nil for what's on none.
    private func box(of tag: String) -> SidebarBox? {
        if let directory = Self.draftDirectory(from: tag) { return SidebarBox(directory: directory) }
        if let session = workspace.session(tag) { return SidebarBox(directory: session.location.directory) }
        if let bot = bots.list.first(where: { $0.sessionID == tag }) { return SidebarBox(machine: bot.machine) }
        if let group = groups.list.first(where: { BotGroups.tabKey($0.id) == tag }) { return SidebarBox(machine: groups.machine(of: group.id)) }
        if let terminal = app.mainTerminals.opened.first(where: { $0.key == tag }) { return SidebarBox(directory: terminal.entry.directory) }
        return nil
    }

    /// One box's page: what's on that computer.
    @ViewBuilder private func page(_ box: SidebarBox) -> some View {
        if boxes.count > 1 { BoxHeading(box: box) }
        let pinned = pinned(on: box)
        if !pinned.isEmpty {
            SectionHeader(title: "Pinned", isFolded: folded("pinned")) { EmptyView() }
            if !isFolded("pinned") {
                ForEach(pinned) { session in
                    sessionRow(session, in: .pinned)
                }
            }
        }
        botsSection(box)
        chatsSection(box)
        let loose = terminals(in: nil).filter { SidebarBox(directory: $0.entry.directory) == box }
        if !loose.isEmpty {
            SectionHeader(title: "Terminals") { EmptyView() }
            terminalRows(loose, indented: false)
        }
        let projects = workspace.projects.filter { SidebarBox(directory: $0.directory) == box }
        SectionHeader(title: "Projects", isFolded: folded("projects")) {
            Button(action: newProject) {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
            }
            .buttonStyle(IconButtonStyle(width: 22, height: 22))
            .help("New Project… (⇧⌘N)")
            .accessibilityLabel("New Project")
        }
        if !isFolded("projects") {
            if workspace.isLoaded && projects.isEmpty {
                Text(box.machine == nil ? "Open a folder for the agent to work in." : "Open a folder on \(boxName(box)) for the agent to work in.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
            }
            ForEach(projects) { project in
                projectSection(project)
            }
        }
        let recents = recents(on: box)
        if !recents.isEmpty {
            SectionHeader(title: "Recents", isFolded: folded("recents")) { EmptyView() }
            if !isFolded("recents") {
                ForEach(recents) { session in
                    sessionRow(session, in: .recents)
                }
            }
        }
    }

    /// A page's name, where the dock shows none (the track names them), and for a machine that
    /// isn't connected, where it is and the way back.
    /// Bots, and the group chats they're in, on `box`.
    @ViewBuilder private func botsSection(_ box: SidebarBox) -> some View {
        let botsHere = bots.list.filter { SidebarBox(machine: $0.machine) == box }
        let groupsHere = groups.list.filter { SidebarBox(machine: groups.machine(of: $0.id)) == box }
        SectionHeader(title: "Bots", isFolded: folded("bots")) {
            // With bots enough for one, a group chat is made from here too.
            if bots.list.count >= 2 {
                NativeMenuButton(opensBelow: true) {
                    let menu = NSMenu()
                    menu.addItem(ActionItem("New Bot…", image: NSImage(systemSymbolName: "face.smiling", accessibilityDescription: nil)) { newBot() })
                    menu.addItem(ActionItem("New Group Chat…", image: NSImage(systemSymbolName: "person.2", accessibilityDescription: nil)) { newGroup() })
                    return menu
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 22, height: 22)
                        .hoverHighlight(in: RoundedRectangle(cornerRadius: 6), mutesInk: true)
                }
                .help("New Bot or Group Chat")
                .accessibilityLabel("New Bot or Group Chat")
            } else {
                Button(action: newBot) {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(IconButtonStyle(width: 22, height: 22))
                .help("New Bot…")
                .accessibilityLabel("New Bot")
            }
        }
        if !isFolded("bots") {
            if botsHere.isEmpty {
                SidebarRow(isSelected: false, action: newBot) {
                    Image(systemName: "plus.circle")
                } title: {
                    Text("Make a Bot")
                        .foregroundStyle(.secondary)
                }
                .help("A teammate with one job, that keeps working while you're away")
            }
            ForEach(botsHere) { bot in
                BotRow(bot: bot, isSelected: selection == bot.sessionID, animates: !stagedBots.contains(bot.id)) {
                    selection = bot.sessionID
                }
                .contextMenu {
                    Button("Edit Bot…") { editBot(bot) }
                        .disabled(app.moves.isMoving(bot.id))
                    MoveToComputerMenu(thing: .bot(bot))
                }
            }
            // Group chats, under the bots they're with.
            ForEach(groupsHere) { group in
                let key = BotGroups.tabKey(group.id)
                GroupRow(group: group, isSelected: selection == key) {
                    selection = key
                }
                .contextMenu {
                    Button("Edit Group Chat…") { editGroup(group) }
                        .disabled(app.moves.isMoving(group.id))
                    MoveToComputerMenu(thing: .group(group))
                    Divider()
                    Button("Delete Group Chat…", role: .destructive) { deletingGroup = group }
                        .disabled(app.moves.isMoving(group.id))
                }
            }
        }
    }

    /// Sessions, and conversations' words, that have the search, on every box.
    @ViewBuilder private var searchResults: some View {
        // Not those already found by name, nor one deleted since the search.
        let inConversations = conversationResults.filter { found in !results.contains { $0.id == found.session.id } && workspace.session(found.session.id) != nil }
        if !results.isEmpty || inConversations.isEmpty {
            SectionHeader(title: "Results") { EmptyView() }
        }
        if results.isEmpty && inConversations.isEmpty && !isSearchingConversations {
            Text("No sessions match.")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
        }
        ForEach(results) { session in
            sessionRow(session, in: .recents)
        }
        if !inConversations.isEmpty || isSearchingConversations {
            SectionHeader(title: "In Conversations") {
                if isSearchingConversations { Spinner(size: 11).padding(.trailing, 6) }
            }
            ForEach(inConversations, id: \.session.id) { found in
                ConversationResultRow(title: found.session.title ?? "New Session", snippet: found.snippet, isSelected: selection == found.session.id) {
                    selection = found.session.id
                    workspace.model(for: found.session.id)?.showFind(search.trimmingCharacters(in: .whitespaces))
                }
                .contextMenu { menu(for: found.session) }
            }
        }
    }

    /// A new session on the box in view: on this Mac, in the project in view, as ⌘N; on a machine,
    /// in its first project, or a chat there when it has none.
    private func newSessionHere() {
        guard let machine = box.machine else { return newSession(nil) }
        if let project = workspace.projects.first(where: { SidebarBox(directory: $0.directory) == box }) { return newSession(project.directory) }
        newChat(on: machine)
    }

    /// A new chat on `machine`, in Kuvo Code's chats folder there (`Moves`): found over SSH the
    /// first time.
    private func newChat(on machine: String) {
        Task {
            guard let home = try? await app.moves.transport.home(on: machine) else { return }
            newSession(RemoteFolder.folder(home.chats, on: machine))
        }
    }

    // MARK: Worktrees

    /// In a worktree no other session is working in.
    private func hasOwnWorktree(_ session: Session) -> Bool {
        workspace.worktrees[session.location.directory] != nil && !workspace.worktreeIsShared(session.location.directory, besides: session.id)
    }

    private func worktreeNote(_ session: Session) -> String {
        let branch = workspace.worktrees[session.location.directory]?.branch ?? "its branch"
        return "Its worktree is a copy of the project on \(branch). Removing it keeps the branch and its commits (a branch that's merged already goes, its commits kept where it was merged)"
            + (worktreeIsDirty ? ", but throws away the changes that aren't committed." : ".")
    }

    /// Asks about the worktree first when the session has one of its own.
    private func confirm(_ session: Session, then ask: @escaping (Session) -> Void) {
        guard hasOwnWorktree(session) else { return ask(session) }
        let directory = session.location.directory
        Task {
            worktreeIsDirty = await Task.detached { Git.hasUncommittedChanges(in: directory, includingHidden: true) }.value
            ask(session)
        }
    }

    private func archive(_ session: Session, removingWorktree: Bool) {
        let discarding = worktreeIsDirty
        Task {
            // A worktree that stays keeps its session in the list too.
            if removingWorktree, !(await removeWorktree(of: session, discarding: discarding)) { return }
            await workspace.setArchived(session.id, true)
        }
    }

    private func delete(_ session: Session, removingWorktree: Bool) {
        if selection == session.id { selection = nil }
        let discarding = worktreeIsDirty
        Task {
            // Deleted either way, as you asked; a worktree that stays shows in Settings › Worktrees.
            if removingWorktree { await removeWorktree(of: session, discarding: discarding) }
            await workspace.delete(session.id)
        }
    }

    /// Whether it went; why not, if not, in an alert. `discarding`: you were told its changes that
    /// aren't committed go.
    @discardableResult
    private func removeWorktree(of session: Session, discarding: Bool) async -> Bool {
        do {
            try await workspace.removeWorktree(session.location.directory, discardingChanges: discarding)
            return true
        } catch {
            Modal.show(error)
            return false
        }
    }

    // MARK: Projects

    @ViewBuilder private func projectSection(_ project: Workspace.Project) -> some View {
        let isOpen = !collapsed.contains(project.directory)
        ProjectRow(project: project, isOpen: isOpen) {
            withAnimation(.ui) { toggle(project.directory) }
        } newSession: {
            newSession(project.directory)
        }
        .contextMenu {
            Button("New Session") { newSession(project.directory) }
            if workspace.settings[project.directory]?.terminal != nil {
                // Its sessions open a terminal; this still starts a conversation.
                Button("New Conversation") { newConversation(project.directory) }
            }
            Button("Edit Project…") { editProject(project) }
            if let engine = app.machines.engine(RemoteFolder.machine(of: project.directory)) {
                if !engine.isReady {
                    Divider()
                    Button(engine.isStopped ? "Start \(engine.machine.name)" : "Connect to \(engine.machine.name)") { app.connectOrStart(engine) }
                }
            } else {
                Divider()
                OpenInMenu(folder: URL(filePath: project.directory))
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting(project.allFolders.map { URL(filePath: $0) }) }
            }
            if project.sessions.isEmpty {
                Divider()
                Button("Remove from Sidebar") { workspace.removeFolder(project.directory) }
            }
        }
        if isOpen {
            if selection == Self.draftTag(project.directory) {
                SidebarRow(isSelected: true, indented: true, action: {}) {
                    EmptyView()
                } title: {
                    Text("New Session")
                }
            }
            terminalRows(terminals(in: project.directory), indented: true)
            let all = showsAll.contains(project.directory)
            ForEach(all ? project.sessions : Array(project.sessions.prefix(Self.sessionsPerProject))) { session in
                sessionRow(session, in: .project)
            }
            if project.sessions.count > Self.sessionsPerProject {
                SidebarRow(isSelected: false, indented: true, action: {
                    withAnimation(.ui) {
                        if all { showsAll.remove(project.directory) } else { showsAll.insert(project.directory) }
                    }
                }) {
                    EmptyView()
                } title: {
                    Text(all ? "Show Less" : "Show \(project.sessions.count - Self.sessionsPerProject) More")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// The terminal tabs of the project at `directory`, or (nil) of no project, each a row that
    /// shows it, so one is never out of reach with the tab bar hidden.
    private func terminals(in directory: String?) -> [(key: String, entry: MainTerminals.Entry)] {
        let known = Set(workspace.projects.map(\.directory))
        return app.mainTerminals.opened.filter { terminal in
            let project = workspace.projectDirectory(terminal.entry.directory)
            return directory.map { project == $0 } ?? !known.contains(project)
        }
    }

    @ViewBuilder private func terminalRows(_ terminals: [(key: String, entry: MainTerminals.Entry)], indented: Bool) -> some View {
        ForEach(terminals, id: \.key) { terminal in
            TerminalRow(
                title: terminal.entry.session.title == "Terminal" ? terminal.entry.label : terminal.entry.session.title,
                isSelected: selection == terminal.key,
                indented: indented,
                action: { selection = terminal.key },
                end: { closeTerminal(terminal.key) }
            )
        }
    }

    /// Conversations of no project on `box`: a row for each, the newest few until you ask for the
    /// rest.
    @ViewBuilder private func chatsSection(_ box: SidebarBox) -> some View {
        let chats = workspace.chats.filter { SidebarBox(directory: $0.location.directory) == box }
        let isDraft = selection.flatMap(Self.draftDirectory).map { Workspace.isChat($0) && SidebarBox(directory: $0) == box } ?? false
        let more = box.machine.map { "chats:" + $0 } ?? Workspace.chatsFolder
        let newChat = { if let machine = box.machine { self.newChat(on: machine) } else { newSession(Workspace.chatsFolder) } }
        SectionHeader(title: "Chats", isFolded: folded("chats")) {
            Button { newChat() } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .semibold))
            }
            .buttonStyle(IconButtonStyle(width: 22, height: 22))
            .help("New Chat (⌥⌘N)")
            .accessibilityLabel("New Chat")
        }
        if !isFolded("chats") {
            if isDraft {
                SidebarRow(isSelected: true, action: {}) {
                    EmptyView()
                } title: {
                    Text("New Chat")
                }
            } else if chats.isEmpty {
                SidebarRow(isSelected: false, action: newChat) {
                    Image(systemName: "plus.circle")
                } title: {
                    Text("Start a Chat")
                        .foregroundStyle(.secondary)
                }
                .help("A conversation of no project. You can move it into one later.")
            }
            let all = showsAll.contains(more)
            ForEach(all ? chats : Array(chats.prefix(Self.sessionsPerProject))) { session in
                sessionRow(session, in: .chats)
            }
            if chats.count > Self.sessionsPerProject {
                SidebarRow(isSelected: false, action: {
                    withAnimation(.ui) {
                        if all { showsAll.remove(more) } else { showsAll.insert(more) }
                    }
                }) {
                    EmptyView()
                } title: {
                    Text(all ? "Show Less" : "Show \(chats.count - Self.sessionsPerProject) More")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func isFolded(_ section: String) -> Bool {
        foldedStorage.split(separator: "\n").contains { $0 == section }
    }

    /// Whether a section is folded away, to show and change from its heading.
    private func folded(_ section: String) -> Binding<Bool> {
        Binding {
            isFolded(section)
        } set: { fold in
            var sections = Set(foldedStorage.split(separator: "\n").map(String.init))
            if fold { sections.insert(section) } else { sections.remove(section) }
            foldedStorage = sections.sorted().joined(separator: "\n")
        }
    }

    private var collapsed: Set<String> {
        Set(collapsedStorage.split(separator: "\n").map(String.init))
    }

    private func toggle(_ directory: String) {
        var folders = collapsed
        if folders.contains(directory) { folders.remove(directory) } else { folders.insert(directory) }
        collapsedStorage = folders.sorted().joined(separator: "\n")
    }

    // MARK: Sessions

    /// Sessions whose title or project name has the search, newest first; archived ones too.
    private var results: [Session] {
        let query = search.trimmingCharacters(in: .whitespaces)
        return workspace.sessions.filter { session in
            workspace.projectName(session.location.directory).localizedStandardContains(query)
                || (session.title ?? "New Session").localizedStandardContains(query)
        }
        .sorted { $0.time.updated > $1.time.updated }
    }

    /// `box`'s latest; pinned ones are already at the top.
    private func recents(on box: SidebarBox) -> [Session] {
        Array((workspace.projects.flatMap(\.sessions) + workspace.chats).filter { !Workspace.isPinned($0) && SidebarBox(directory: $0.location.directory) == box }
            .sorted { $0.time.updated > $1.time.updated }.prefix(Self.recentCount))
    }

    private func pinned(on box: SidebarBox) -> [Session] {
        (workspace.projects.flatMap(\.sessions) + workspace.chats).filter { Workspace.isPinned($0) && SidebarBox(directory: $0.location.directory) == box }
            .sorted { $0.time.updated > $1.time.updated }
    }

    /// Highlighted where it was picked; picked elsewhere (a tab, a new session), in its project.
    private func isHighlighted(_ session: Session, in place: Place) -> Bool {
        guard selection == session.id else { return false }
        if let picked = pickedIn[session.id] { return picked == place }
        return place == (Workspace.isChat(session.location.directory) ? .chats : .project)
    }

    private func sessionRow(_ session: Session, in place: Place) -> some View {
        SidebarRow(isSelected: isHighlighted(session, in: place), indented: place == .project, isEditing: renaming == RenameTarget(id: session.id, place: place), action: {
            pickedIn[session.id] = place
            selection = session.id
        }) {
            EmptyView()
        } title: {
            if renaming == RenameTarget(id: session.id, place: place) {
                // Each ends only its own rename: one started on another row meanwhile stays.
                let target = RenameTarget(id: session.id, place: place)
                InlineTitleField(original: session.title ?? "") { title in
                    Task { await workspace.rename(session.id, to: title) }
                    if renaming == target { renaming = nil }
                } cancel: {
                    if renaming == target { renaming = nil }
                }
            } else {
                Text(session.title ?? "New Session")
                    .fontWeight(session.isUnread ? .semibold : .regular)
                    .foregroundStyle(Workspace.isArchived(session) ? .secondary : .primary)
            }
        } accessory: {
            if Workspace.isArchived(session) {
                Text("Archived")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            } else {
                HStack(spacing: 6) {
                    if let destination = app.moves.underWay[session.id] {
                        Spinner(size: 12)
                            .help("Moving to \(destination ?? "this Mac")…")
                    } else if !search.isEmpty, Workspace.isChat(session.location.directory), let machine = RemoteFolder.machine(of: session.location.directory) {
                        Image(systemName: "server.rack")
                            .font(.system(size: 10))
                            .foregroundStyle(.tertiary)
                            .help("On \(machine)")
                    }
                    if let tree = workspace.worktrees[session.location.directory] {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                            .help("Works in a worktree, on \(tree.branch)")
                    }
                    SessionStatus(session: session)
                }
            }
        }
        .contextMenu { menu(for: session, in: place) }
    }

    /// Saves the conversation as a Markdown file where you choose.
    private func export(_ session: Session) async {
        do {
            guard let text = try await workspace.markdown(of: session.id) else { return }
            let panel = NSSavePanel()
            panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
            panel.nameFieldStringValue = (session.title ?? "Conversation").replacingOccurrences(of: "/", with: "-") + ".md"
            guard await Modal.run({ panel.runModal() }) == .OK, let url = panel.url else { return }
            try text.write(to: url, atomically: true, encoding: .utf8)
            Analytics.shared.track("session_exported", ["how": "file"])
        } catch {
            Modal.show(error)
        }
    }

    /// `place`: where the row is, for renaming it there; nil for a row that can't show it (a
    /// conversation search result).
    @ViewBuilder private func menu(for session: Session, in place: Place? = nil) -> some View {
        // A bot's own conversation (found by a search): the bot's menu. Deleting, archiving or
        // renaming it as a session would leave the bot without its conversation.
        if let bot = bots.list.first(where: { $0.sessionID == session.id }) {
            Button("Edit Bot…") { editBot(bot) }
        } else if let engine = app.machines.engine(workspace.waitingMachine(for: session.id)) {
            // On a machine that's away, the session is as last seen: what it does waits for it.
            Text(engine.isStopped ? "\(engine.machine.name)’s engine is stopped" : "\(engine.machine.name) isn’t connected")
            switch engine.state {
            case .starting, .downloading: Text("Connecting…")
            default: Button(engine.isStopped ? "Start" : "Connect Now") { app.reconnectNow(engine) }
            }
        } else {
            liveMenu(for: session, in: place)
        }
    }

    @ViewBuilder private func liveMenu(for session: Session, in place: Place?) -> some View {
        if !Workspace.isArchived(session) {
            if Workspace.isPinned(session) {
                Button("Unpin") { Task { await workspace.setPinned(session.id, false) } }
            } else {
                Button("Pin") { Task { await workspace.setPinned(session.id, true) } }
            }
        }
        if let openBeside, session.id != selection {
            Button("Open Beside") { openBeside(session.id) }
        }
        // Moving to another computer: what would change it waits until it's there.
        let moving = app.moves.isMoving(session.id)
        if let place {
            Button("Rename…") {
                renaming = RenameTarget(id: session.id, place: place)
            }
            .disabled(moving)
        }
        if Workspace.isChat(session.location.directory) {
            MoveToProjectMenu(session: session)
                .disabled(moving)
            MoveToComputerMenu(thing: .chat(session))
        } else if !RemoteFolder.isRemote(session.location.directory) {
            Button("Show in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: session.location.directory) }
        }
        Divider()
        Button("Copy as Markdown") {
            Task {
                do {
                    guard let text = try await workspace.markdown(of: session.id) else { return }
                    Clipboard.copy(text)
                    Analytics.shared.track("session_exported", ["how": "copy"])
                } catch {
                    Modal.show(error)
                }
            }
        }
        Button("Export as Markdown…") { Task { await export(session) } }
        Divider()
        if Workspace.isArchived(session) {
            Button("Unarchive") { Task { await workspace.setArchived(session.id, false) } }
        } else {
            Button("Archive") {
                if hasOwnWorktree(session) { confirm(session) { archiving = $0 } } else { Task { await workspace.setArchived(session.id, true) } }
            }
            .disabled(moving)
        }
        Button("Delete…", role: .destructive) { confirm(session) { deleting = $0 } }
            .disabled(moving)
    }
}

// MARK: - Rows

/// The developer apps on this Mac that open a folder: editors, terminals, git apps, then the
/// Finder. (The system's own list for folders is mostly archivers and readers.)
private struct OpenInMenu: View {
    let folder: URL

    /// By bundle identifier, in the order they're listed.
    private static let apps = [
        "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf", "dev.zed.Zed",
        "com.apple.dt.Xcode", "com.panic.Nova", "com.sublimetext.4", "com.barebones.bbedit",
        "com.jetbrains.intellij", "com.jetbrains.intellij.ce", "com.jetbrains.WebStorm", "com.jetbrains.pycharm",
        "com.jetbrains.pycharm.ce", "com.jetbrains.goland", "com.jetbrains.rider", "com.google.android.studio",
        "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp-Stable",
        "com.DanPristupov.Fork", "com.fournova.Tower3", "com.github.GitHubClient", "com.torusknot.SourceTreeNotMAS",
        "com.apple.finder",
    ]

    var body: some View {
        let workspace = NSWorkspace.shared
        let installed = Self.apps.compactMap { workspace.urlForApplication(withBundleIdentifier: $0) }
        Menu("Open In") {
            ForEach(installed, id: \.self) { app in
                Button {
                    workspace.open([folder], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
                } label: {
                    Label {
                        Text(FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: ""))
                    } icon: {
                        Image(nsImage: workspace.icon(forFile: app.path))
                    }
                }
            }
        }
    }
}

/// A session found by what was said in it: its title, and the words around the match.
private struct ConversationResultRow: View {
    let title: String
    let snippet: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14))
                Text(snippet)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .modifier(RowHighlight(isSelected: isSelected))
        }
        .buttonStyle(.plain)
        .clickablePointer()
    }
}

/// Finding a session (or a Settings page): a quiet field shaped like a row, set into the glass
/// like a well so it doesn't read as a selected row; cleared with its button or Escape.
struct SidebarSearchRow: View {
    @Binding var text: String
    @FocusState private var isFocused: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(width: SidebarMetrics.iconWidth)
            TextField("Search", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .focused($isFocused)
                .onExitCommand { text = "" }
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(ClearFieldButtonStyle())
                .help("Clear")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: SidebarMetrics.rowHeight)
        // Sunken, without a border of its own; a touch deeper while you type in it.
        .background((scheme == .dark ? Color.black : Surface.slate).opacity(isFocused ? 0.05 : 0), in: .rect(cornerRadius: 8))
        .background(Surface.well(scheme), in: .rect(cornerRadius: 8))
        .contentShape(.rect)
        .onTapGesture { isFocused = true }
        .padding(.vertical, 4)
    }
}

enum SidebarMetrics {
    static let rowHeight: CGFloat = 32
    static let iconWidth: CGFloat = 18
}

/// A row's highlight: accent glass under the open session, so it stands apart from the
/// chrome around it, and a soft neutral fill under the pointer on the others. Neither
/// moves or resizes the row.
struct RowHighlight: ViewModifier {
    let isSelected: Bool
    @State private var isHovering = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 8)
        content
            .background(isHovering && !isSelected ? Color.primary.opacity(0.06) : .clear, in: shape)
            .accentGlass(shape, isOn: isSelected)
            .contentShape(shape)
            .onHover { isHovering = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovering)
    }
}

/// One line in the sidebar: an optional icon, a title, an optional trailing accessory.
/// Indented rows line their titles up with the project names above them.
private struct SidebarRow<Icon: View, Title: View, Accessory: View>: View {
    var isSelected: Bool
    var indented = false
    /// Its title is being typed (renamed): not a button meanwhile, so the field takes the keys.
    var isEditing = false
    let action: () -> Void
    @ViewBuilder var icon: () -> Icon
    @ViewBuilder var title: () -> Title
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        if isEditing {
            row
        } else {
            Button(action: action) { row }
                .buttonStyle(.plain)
                .clickablePointer()
        }
    }

    private var row: some View {
        HStack(spacing: 10) {
            if Icon.self != EmptyView.self {
                icon()
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: SidebarMetrics.iconWidth)
            } else if indented {
                Color.clear.frame(width: SidebarMetrics.iconWidth, height: 1)
            }
            title()
                .font(.system(size: 14))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
            accessory()
        }
        .padding(.horizontal, 10)
        .frame(height: SidebarMetrics.rowHeight)
        .modifier(RowHighlight(isSelected: isSelected))
    }
}

extension SidebarRow where Accessory == EmptyView {
    init(isSelected: Bool, indented: Bool = false, action: @escaping () -> Void, @ViewBuilder icon: @escaping () -> Icon, @ViewBuilder title: @escaping () -> Title) {
        self.init(isSelected: isSelected, indented: indented, action: action, icon: icon, title: title, accessory: { EmptyView() })
    }
}

/// A project: its folder (open or closed) and name. Clicking opens or closes it; the
/// compose button for a new session in it shows under the pointer, in place.
private struct ProjectRow: View {
    let project: Workspace.Project
    let isOpen: Bool
    let toggle: () -> Void
    let newSession: () -> Void
    @State private var isHovering = false
    @Environment(AppModel.self) private var app

    @Environment(\.marksMachines) private var marksMachines

    /// The machine the project is on, when it's not this Mac.
    private var machine: MachineEngine? {
        app.machines.engine(RemoteFolder.machine(of: project.directory))
    }

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 10) {
                FolderIcon(isOpen: isOpen)
                    .foregroundStyle(.secondary)
                    .frame(width: SidebarMetrics.iconWidth)
                Text(project.name)
                    .font(.system(size: 14))
                    .lineLimit(1)
                    .layoutPriority(1)
                if let machine, marksMachines {
                    MachineLabel(engine: machine)
                }
                Spacer(minLength: 6)
                // Room for the compose button, so a long name never runs under it.
                Color.clear.frame(width: 22, height: 1)
            }
            .padding(.horizontal, 10)
            .frame(height: SidebarMetrics.rowHeight)
            .hoverHighlight(selected: false)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .overlay(alignment: .trailing) {
            Button(action: newSession) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 13, weight: .medium))
            }
            .buttonStyle(IconButtonStyle(width: 26, height: 24))
            .padding(.trailing, 4)
            .opacity(isHovering ? 1 : 0)
            .help("New Session in \(project.name)")
        }
        .onHover { isHovering = $0 }
        .help(project.allFolders.map { folder in
            RemoteFolder.parse(folder).map { "\($0.machine):\($0.path)" } ?? (folder as NSString).abbreviatingWithTildeInPath
        }.joined(separator: "\n"))
    }
}

/// A terminal tab in the sidebar: its name, with a way to end it under the pointer.
private struct TerminalRow: View {
    let title: String
    let isSelected: Bool
    let indented: Bool
    let action: () -> Void
    let end: () -> Void
    @State private var isHovering = false

    var body: some View {
        SidebarRow(isSelected: isSelected, indented: indented, action: action) {
            EmptyView()
        } title: {
            HStack(spacing: 6) {
                Image(systemName: "apple.terminal")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(title)
            }
        }
        .overlay(alignment: .trailing) {
            Button(action: end) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
            }
            .buttonStyle(IconButtonStyle(width: 22, height: 22))
            .padding(.trailing, 4)
            .opacity(isHovering ? 1 : 0)
            .help("End Terminal")
            .accessibilityLabel("End Terminal")
        }
        .onHover { isHovering = $0 }
        .contextMenu { Button("End Terminal", action: end) }
    }
}

/// Which machine a project is on, small after its name, with a dot when it isn't connected.
private struct MachineLabel: View {
    let engine: MachineEngine

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "server.rack")
                .font(.system(size: 9, weight: .semibold))
            Text(engine.machine.name)
                .lineLimit(1)
            MachineIndicator(connection: engine.connection, size: 6, quiet: true)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.secondary)
        .help(engine.statusText)
    }
}

/// A group chat: its bots, its name, and who's talking or what was said last.
private struct GroupRow: View {
    let group: BotGroup
    let isSelected: Bool
    let action: () -> Void
    @Environment(\.marksMachines) private var marksMachines
    @Environment(Bots.self) private var bots
    @Environment(GroupChats.self) private var groups
    @Environment(AppModel.self) private var app

    var body: some View {
        let speaker = groups.speaking[group.id].flatMap { bots.bot($0) }
        let isUnread = groups.isUnread(group) && !isSelected
        let machine = groups.machine(of: group.id)
        FaceRow(title: group.name, isUnread: isUnread, isSelected: isSelected, action: action) {
            GroupAvatar(faces: group.members.compactMap { id in
                bots.bot(id).map { GroupAvatar.Face(look: $0.look, mood: $0.id == speaker?.id ? .working : .idle) }
            }, size: 28)
        } subtitle: {
            if let destination = app.moves.underWay[group.id] {
                ShimmerText(text: "Moving to \(destination.flatMap { place in app.machines.engine(place)?.machine.name ?? place } ?? "this Mac")…")
            } else if let speaker {
                ShimmerText(text: "\(speaker.name) is thinking…")
            } else if groups.discussing.contains(group.id) {
                ShimmerText(text: "Talking it over…")
            } else {
                Text(lastLine)
            }
        } trailing: {
            HStack(spacing: 6) {
                // One that lives on a machine, which talks there while this Mac is off.
                if let machine, marksMachines {
                    Image(systemName: "server.rack")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .help("Lives on \(app.machines.engine(machine)?.machine.name ?? machine)")
                }
                if isUnread {
                    Circle().fill(.tint).frame(width: 7, height: 7)
                        .help("New messages")
                }
            }
        }
    }

    /// "Mira: Let's ship on Friday", or who's in it before anything's been said.
    private var lastLine: String {
        if let last = groups.messages(in: group.id).last(where: { $0.kind != .note }) {
            let who = last.kind == .meeting ? "Meeting" : last.author.map { bots.bot($0)?.name ?? "A bot" } ?? "You"
            // Plain words: no Markdown marks, all on one line.
            return who + ": " + last.text.filter { !"*`#>".contains($0) }.split(whereSeparator: \.isNewline).joined(separator: " ")
        }
        return group.members.compactMap { bots.bot($0)?.name }.joined(separator: ", ")
    }
}

/// A bot's row or a group chat's, in the sidebar: its face, its name over a line of what it's
/// doing (in bold while there's something you haven't read), and its status at the end.
private struct FaceRow<Face: View, Subtitle: View, Trailing: View>: View {
    let title: String
    let isUnread: Bool
    let isSelected: Bool
    let action: () -> Void
    @ViewBuilder let face: Face
    @ViewBuilder let subtitle: Subtitle
    @ViewBuilder let trailing: Trailing

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                face
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 14))
                        .fontWeight(isUnread ? .semibold : .regular)
                    subtitle
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                Spacer(minLength: 6)
                trailing
            }
            .padding(.horizontal, 10)
            .frame(height: 46)
            .modifier(RowHighlight(isSelected: isSelected))
        }
        .buttonStyle(.plain)
        .clickablePointer()
    }
}

/// A bot: its face, its name, and what it's doing or waiting for.
private struct BotRow: View {
    let bot: Bot
    let isSelected: Bool
    var animates = true
    let action: () -> Void
    @Environment(Workspace.self) private var workspace
    @Environment(Bots.self) private var bots
    @Environment(AppModel.self) private var app
    @Environment(\.marksMachines) private var marksMachines
    @State private var isHovering = false

    private var session: Session? { workspace.session(bot.sessionID) }

    var body: some View {
        FaceRow(title: bot.name, isUnread: session?.isUnread == true, isSelected: isSelected, action: action) {
            BotAvatar(look: bot.look, size: 28, mood: bots.mood(of: bot, in: workspace), noticed: isHovering, animates: animates)
                .overlay(alignment: .bottomTrailing) {
                    if let machine = bot.machine, marksMachines { MachineBadge(machine: machine).offset(x: 4, y: 3) }
                }
        } subtitle: {
            status
        } trailing: {
            if let session {
                SessionStatus(session: session)
            }
        }
        .onHover { isHovering = $0 }
        // Read again whenever it's done some work: it may have scheduled a wake-up.
        .task(id: session?.time.updated) {
            await app.wakeUps.read(bot.wakeOwner)
            if hasNews { await workspace.loadReplyPreview(bot.sessionID) }
        }
    }

    /// It said something you haven't read.
    private var hasNews: Bool { bots.mood(of: bot, in: workspace) == .news }

    /// What it's up to: working, waiting for you, what it said that you haven't read, when it
    /// wakes next, or its job. What it's set to do (wake up, watch) and how it's set (paused)
    /// stand apart from what it said, with their sign.
    @ViewBuilder private var status: some View {
        if let destination = app.moves.underWay[bot.id] {
            ShimmerText(text: "Moving to \(destination ?? "this Mac")…")
        } else if workspace.needsAttention(bot.sessionID) {
            Text("Needs you")
                .foregroundStyle(.orange)
        } else if workspace.running.contains(bot.sessionID) {
            ShimmerText(text: "Working…")
        } else if case let helpers = workspace.helpersAtWork(in: bot.sessionID), helpers > 0 {
            ShimmerText(text: helpers == 1 ? "Working on a task…" : "Working on \(helpers) tasks…")
        } else if let machine = bot.machine, app.machines.engine(machine)?.isReady != true {
            Text("On \(machine), not connected")
        } else if hasNews, let reply = workspace.replyPreviews[bot.sessionID] {
            Text(reply)
        } else if bots.paused.contains(bot.id) {
            BotState(systemImage: "pause.circle", isSet: false) { Text("Paused") }
        } else if let wakes = bots.wakes[bot.id], !wakes.isEmpty {
            // Kept current: "in 2 minutes", then, once it's due and on its way, "Waking up…".
            TimelineView(.periodic(from: .now, by: 5)) { context in
                BotState(systemImage: "alarm") {
                    if let next = wakes.first(where: { $0.due > context.date }) {
                        Text("Wakes " + next.due.formatted(Date.RelativeFormatStyle(presentation: .named, unitsStyle: .wide)))
                    } else {
                        ShimmerText(text: "Waking up…")
                    }
                }
            }
        } else if let watching = bots.watches[bot.id], !watching.isEmpty {
            BotState(systemImage: "eye") { Text(watching.count == 1 ? "Watching" : "Watching \(watching.count) things") }
        } else {
            // No job yet: it asks for one, until your message gives it.
            Text(bot.job.isEmpty ? EmptyConversationView.purposeQuestion : bot.job)
        }
    }
}

/// A bot's state in its row, rather than something it said: its sign before it, and, for what
/// it's set to do (wake up, watch), the accent.
private struct BotState<Content: View>: View {
    let systemImage: String
    /// It's set to do something: in the accent. Paused, in the row's grey.
    var isSet = true
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .semibold))
            content
        }
        .fontWeight(.medium)
        .foregroundStyle(isSet ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
    }
}

/// "Projects", "Recents": a quiet heading, with room for a trailing button.
private struct SectionHeader<Trailing: View>: View {
    let title: String
    /// Folded away, its rows hidden: a click on the heading folds or unfolds it. Nil for one that
    /// doesn't fold.
    var isFolded: Binding<Bool>?
    @ViewBuilder var trailing: () -> Trailing
    @State private var isHovering = false

    var body: some View {
        HStack(spacing: 0) {
            if let isFolded {
                Button {
                    withAnimation(.ui) { isFolded.wrappedValue.toggle() }
                } label: {
                    HStack(spacing: 5) {
                        label
                        // A chevron under the pointer, and while folded, so it's clear it opens.
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isFolded.wrappedValue ? -90 : 0))
                            .opacity(isHovering || isFolded.wrappedValue ? 1 : 0)
                            .accessibilityHidden(true)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .help(isFolded.wrappedValue ? "Show \(title)" : "Hide \(title)")
                .accessibilityValue(isFolded.wrappedValue ? "Collapsed" : "Expanded")
            } else {
                label
            }
            Spacer()
            trailing()
        }
        .frame(height: 22)
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.top, 16)
        .padding(.bottom, 4)
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
    }

    private var label: some View {
        Text(title)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.secondary)
    }
}

/// "Move to Project ›": a chat's way into one of the projects on its computer.
private struct MoveToProjectMenu: View {
    let session: Session
    @Environment(Workspace.self) private var workspace

    var body: some View {
        let machine = RemoteFolder.machine(of: session.location.directory)
        let projects = workspace.projects.filter { RemoteFolder.machine(of: $0.directory) == machine }
        Menu("Move to Project") {
            ForEach(projects) { project in
                Button(project.name) { move(to: project.directory) }
            }
            if projects.isEmpty {
                Text(machine.map { "No projects on \($0)" } ?? "No projects on this Mac")
            }
        }
    }

    private func move(to directory: String) {
        Task {
            do {
                try await workspace.move(session.id, toProject: directory)
            } catch {
                Modal.show(error)
            }
        }
    }
}

/// "Move to Computer ›": a bot's or chat's way to this Mac or another of your machines, where it
/// carries on (`Moves`). Asked first, as the original goes to the trash where it was.
private struct MoveToComputerMenu: View {
    enum Thing {
        case bot(Bot)
        case chat(Session)
        case group(BotGroup)
    }

    let thing: Thing
    @Environment(AppModel.self) private var app

    private var id: String {
        switch thing {
        case .bot(let bot): bot.id
        case .chat(let session): session.id
        case .group(let group): group.id
        }
    }

    private var here: String? {
        switch thing {
        case .bot(let bot): bot.machine
        case .chat(let session): RemoteFolder.machine(of: session.location.directory)
        case .group(let group): app.chats.machine(of: group.id)
        }
    }

    /// Where a group chat can go: from a machine, this Mac; from this Mac, the machine its bots
    /// all live on, if they do.
    private func groupPlaces(_ group: BotGroup) -> [String?] {
        if here != nil { return [nil] }
        let homes = Set(group.members.compactMap { app.bots.bot($0) }.map(\.machine))
        guard homes.count == 1, let machine = homes.first ?? nil else { return [] }
        return [machine]
    }

    var body: some View {
        Menu("Move to Computer") {
            if case .bot(let bot) = thing, bot.project != nil {
                Text("It works in one of your projects, which stays where it is")
            } else if case .bot(let bot) = thing, bot.agents == true {
                Text("It talks with a coding agent, which can’t move yet")
            } else if case .group(let group) = thing, groupPlaces(group).isEmpty {
                // A chat whose bots live on different computers, or all here, is this Mac's.
                Text(Set(group.members.compactMap { app.bots.bot($0)?.machine }).isEmpty
                     ? "Move its bots to a machine first; then it can go there too" : "Its bots live on different computers, so it stays on this Mac")
            } else if case .group(let group) = thing {
                ForEach(groupPlaces(group), id: \.self) { place in
                    if let place, app.machines.engine(place)?.isReady != true {
                        Text("\(place), not connected")
                    } else {
                        Button(place ?? "This Mac") { move(to: place) }
                    }
                }
            } else {
                ForEach(app.moves.destinations(from: here), id: \.self) { place in
                    if let place, app.machines.engine(place)?.isReady != true {
                        Text("\(place), not connected")
                    } else {
                        Button(place ?? "This Mac") { move(to: place) }
                    }
                }
            }
        }
        .disabled(app.moves.isMoving(id))
    }

    private func move(to place: String?) {
        let name: String
        let what: String
        switch thing {
        case .bot(let bot):
            name = bot.name
            what = "Its memory, files, wake-ups and conversation go there, and it carries on there; its seats in group chats start afresh there."
        case .chat(let session):
            name = (session.title ?? "").isEmpty ? "this chat" : "“\(session.title ?? "")”"
            what = "Its conversation and wake-ups go there, and it carries on there."
        case .group(let group):
            name = "“\(group.name)”"
            what = place == nil
                ? "Its messages and meeting come here, and it carries on here while this Mac is on; its bots stay where they are."
                : "Its messages and meeting go there, and it carries on there, also while this Mac is off."
        }
        let trash = here.map { "Kuvo Code’s trash folder on \($0)" } ?? "the Trash"
        let leaves: String
        if case .group = thing {
            leaves = "Nothing goes to it while it moves. What it leaves here goes to \(trash)."
        } else {
            leaves = "Nothing goes to it while it moves. Its folder here goes to \(trash), with a copy of its conversation in it."
        }
        Task {
            let confirmed = await Modal.run {
                let alert = NSAlert()
                alert.messageText = "Move \(name) to \(place ?? "this Mac")?"
                alert.informativeText = "\(what) \(leaves)"
                alert.addButton(withTitle: "Move")
                alert.addButton(withTitle: "Cancel")
                return alert.runModal() == .alertFirstButtonReturn
            }
            guard confirmed else { return }
            do {
                switch thing {
                case .bot(let bot): try await app.moves.move(bot: bot.id, to: place)
                case .chat(let session): try await app.moves.move(chat: session.id, to: place)
                case .group(let group): try await app.moves.move(group: group.id, to: place)
                }
            } catch {
                Modal.show(error)
            }
        }
    }
}

/// How a session is doing, at the end of its row.
private struct SessionStatus: View {
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    let session: Session

    var body: some View {
        if workspace.needsAttention(session.id) {
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 12))
                .foregroundStyle(.orange)
                .help("Waiting for you")
        } else if workspace.isWorking(session.id) {
            Spinner(size: 12)
                .help("Working")
        } else if session.outcome == .failed {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(.red)
                .help("The last run failed")
        } else if session.isUnread {
            Circle().fill(.tint).frame(width: 7, height: 7)
                .help("Finished")
        } else if let next = app.wakeUps.wakes[session.id]?.first {
            // It wakes itself up later (a bot's row says so in words).
            Image(systemName: "alarm")
                .font(.system(size: 11))
                .foregroundStyle(.tint)
                .help("Wakes up " + next.due.formatted(Date.RelativeFormatStyle(presentation: .named, unitsStyle: .wide)))
        } else if app.wakeUps.watches[session.id]?.isEmpty == false {
            Image(systemName: "eye")
                .font(.system(size: 11))
                .foregroundStyle(.tint)
                .help("Watching for a change")
        }
    }
}

/// Which accounts are connected, at the bottom of the sidebar. It opens a menu of what you reach
/// for between sessions: your accounts, the usage your plans have left, your machines, Settings
/// and help.
private struct AccountsRow: View {
    @Environment(Catalog.self) private var catalog
    @Environment(AppModel.self) private var app
    @Environment(Updates.self) private var updates
    let showProviders: () -> Void

    var body: some View {
        NativeMenuButton(name: "account", menu: makeMenu) {
            HStack(spacing: 10) {
                if catalog.connectedProviders.isEmpty {
                    Image(systemName: "person.crop.circle.badge.plus")
                        .font(.system(size: 15))
                        .foregroundStyle(.tint)
                } else {
                    HStack(spacing: 8) {
                        ForEach(catalog.connectedProviders.prefix(3)) { provider in
                            ProviderLogo(id: OutsideAgents.logo(provider.id), size: 18, colored: true)
                        }
                    }
                }
                Text(label)
                    .font(.system(size: 14))
                Spacer()
                // One needs you: its sign-in ended, or it's at its usage limit.
                if !problems.isEmpty {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                        .accessibilityLabel(problemsText)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 38)
            .contentShape(.rect)
            .hoverHighlight(selected: false)
        }
        .help(problems.isEmpty ? "Accounts, usage, Settings and help" : problemsText)
    }

    private var problems: [(name: String, problem: AccountProblem)] {
        catalog.accountProblems(limits: app.agents.auto)
    }

    /// "Antigravity: sign in again. Claude Code: at its usage limit."
    private var problemsText: String {
        problems.map { "\($0.name): \($0.problem.short)." }.joined(separator: " ")
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        let providers = catalog.connectedProviders
        let accounts = ActionItem(
            providers.isEmpty ? "Connect an Account" : "Accounts",
            subtitle: !problems.isEmpty ? problemsText : providers.isEmpty ? "Sign in with a subscription, or add an API key" : Self.list(providers.map(\.name)),
            image: Self.symbol("person.crop.circle"),
            handler: { showProviders() }
        )
        accounts.keyEquivalent = "k"
        accounts.keyEquivalentModifierMask = NSEvent.ModifierFlags([.command, .shift])
        // As the menu bar shows them, not moved to where the keys sit on this keyboard layout.
        accounts.allowsAutomaticKeyEquivalentLocalization = false
        menu.addItem(accounts)
        menu.addItem(.separator())
        menu.addItem(usageItem())
        if !app.machines.list.isEmpty { menu.addItem(machinesItem()) }
        let settings = ActionItem("Settings…", image: Self.symbol("gearshape")) { app.openSettings() }
        settings.keyEquivalent = ","
        settings.keyEquivalentModifierMask = NSEvent.ModifierFlags.command
        settings.allowsAutomaticKeyEquivalentLocalization = false
        menu.addItem(settings)
        menu.addItem(.separator())
        menu.addItem(helpItem())
        return menu
    }

    /// What each plan the usage tracker follows has left, and how soon it resets.
    private func usageItem() -> NSMenuItem {
        let usage = UsageMenuBar.shared
        let plans = usage.trackedProviderIDs.compactMap { usage.planLimits(for: $0) }
        let submenu = NSMenu()
        if plans.isEmpty {
            let none = NSMenuItem(title: usage.isRunning ? "No plan limits to show yet" : "The usage tracker is off", action: nil, keyEquivalent: "")
            none.isEnabled = false
            submenu.addItem(none)
        }
        for (index, plan) in plans.enumerated() {
            if index > 0 { submenu.addItem(.separator()) }
            submenu.addItem(.sectionHeader(title: [plan.providerName, plan.plan].compactMap(\.self).joined(separator: " ")))
            for limit in plan.limits {
                let row = NSMenuItem.info(limit.label, value: ContextGauge.percent(1 - limit.fraction) + " left")
                row.subtitle = limit.resetsAt.map { ContextGauge.resets($0) }
                submenu.addItem(row)
            }
        }
        submenu.addItem(.separator())
        if usage.isRunning { submenu.addItem(ActionItem("Open Usage Panel") { usage.open(.dashboard) }) }
        submenu.addItem(ActionItem("Usage Settings…") { app.openSettings(.usage) })
        return .chained("Usage Remaining", value: nil, image: Self.symbol("gauge.with.dots.needle.50percent"), submenu: submenu)
    }

    /// Your machines and how each is doing; one that isn't connected connects when picked.
    private func machinesItem() -> NSMenuItem {
        let submenu = NSMenu()
        for engine in app.machines.list.compactMap({ app.machines.engine($0.id) }) {
            submenu.addItem(ActionItem(engine.machine.name, subtitle: engine.statusText, image: Self.symbol("server.rack")) {
                switch engine.state {
                case .preparing, .failed: app.connectOrStart(engine)
                default: app.openSettings(.machines)
                }
            })
        }
        submenu.addItem(.separator())
        submenu.addItem(ActionItem("Manage Machines…") { app.openSettings(.machines) })
        return .chained("Machines", value: nil, image: Self.symbol("server.rack"), submenu: submenu)
    }

    private func helpItem() -> NSMenuItem {
        let submenu = NSMenu()
        submenu.addItem(ActionItem("Kuvo Code Help", image: Self.symbol("book")) { NSWorkspace.shared.open(AppInfo.docs) })
        submenu.addItem(ActionItem("Keyboard Shortcuts", image: Self.symbol("command")) { app.openSettings(.shortcuts) })
        submenu.addItem(ActionItem("What\u{2019}s New", image: Self.symbol("sparkles")) { NSWorkspace.shared.open(AppInfo.releases) })
        submenu.addItem(ActionItem("Report an Issue…", image: Self.symbol("exclamationmark.bubble")) { NSWorkspace.shared.open(AppInfo.newIssue) })
        submenu.addItem(ActionItem("Contact Us…", image: Self.symbol("envelope")) { NSWorkspace.shared.open(AppInfo.contact) })
        if updates.isAvailable {
            submenu.addItem(.separator())
            let check = ActionItem("Check for Updates…") { updates.check() }
            check.isEnabled = updates.canCheck
            submenu.addItem(check)
        }
        return .chained("Help", value: nil, image: Self.symbol("questionmark.circle"), submenu: submenu)
    }

    private static func symbol(_ name: String) -> NSImage? {
        NSImage(systemSymbolName: name, accessibilityDescription: nil)
    }

    /// "Anthropic, OpenAI and 2 more".
    private static func list(_ names: [String]) -> String {
        names.count <= 3 ? names.formatted(.list(type: .and)) : names.prefix(2).joined(separator: ", ") + " and \(names.count - 2) more"
    }

    private var label: String {
        switch catalog.connectedProviders.count {
        case 0: "Connect an Account"
        case 1: catalog.connectedProviders[0].name
        case let count: "\(count) Accounts"
        }
    }
}
