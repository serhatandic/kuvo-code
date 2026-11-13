import ClientDesign
import ClientSessions
import ClientText
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
    @Environment(\.messageFont) private var messageFont

    /// Bots moving in the main card; their rows hold still. The one thing the window hands in
    /// (see `==`, below): the rest comes from the stores, which tell the sidebar when they change.
    /// Anything else handed in has to be compared in `==` too, or the sidebar misses its changes.
    var stagedBots: Set<String> = []
    @Environment(Bots.self) private var bots
    @Environment(GroupChats.self) private var groups
    /// The group chat waiting for the user to confirm its deletion.
    @State private var deletingGroup: BotGroup?

    /// Folders the user closed, by path (newline-separated).
    @AppStorage("collapsedProjects") private var collapsedStorage = ""
    /// Sections the user folded away: "pinned", "bots", "chats", "projects", "recents" (newline-separated).
    @AppStorage("collapsedSections") private var foldedStorage = ""
    /// The box in view, by id ("mac", or a machine's), each a page of its own.
    @AppStorage(SidebarBox.inViewKey) private var boxID = "mac"
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
    /// The project waiting for the user to confirm its removal.
    @State private var removingProject: Workspace.Project?
    /// The worktree of the session being deleted has changes that aren't committed.
    @State private var worktreeIsDirty = false

    private enum Place { case pinned, project, chats, recents }

    private struct RenameTarget: Equatable {
        let id: String
        let place: Place
    }
    /// Sessions whose title or project has this, instead of the usual lists.
    @State private var search = ""
    /// Sessions whose sub-sessions show under them: folded until you unfold one, or open one of them.
    @State private var unfolded: Set<String> = []
    /// How far a swipe has pulled the boxes' pages.
    @State private var boxMotion = BoxPagerMotion()
    /// Sessions whose conversations have the search, with the words around it.
    /// What each box found in its conversations, by the box: one's earlier finds stay until it
    /// answers the newer search, as on the phone.
    @State private var conversationFinds: [String: [Workspace.ConversationFind]] = [:]
    /// The words `conversationFinds` were found for, to mark in them while you type on.
    @State private var findsQuery = ""
    /// Everything found in conversations, the latest first.
    private var conversationResults: [Workspace.ConversationFind] {
        Array(conversationFinds.values.flatMap(\.self).sorted { $0.session.time.updated > $1.session.time.updated }.prefix(20))
    }
    @State private var isSearchingConversations = false
    /// The computers asked for this search, and those that have answered: each says so in turn.
    @State private var searchAsked: [String] = []
    @State private var searchAnswered: Set<String> = []

    /// A project lists this many sessions until you ask for the rest.
    private static let sessionsPerProject = 5
    private static let recentCount = 8

    // What the rows do, through the window's stores rather than closures handed in, so the view
    // the window makes is equal to the one before unless `stagedBots` changed (`==`, below).
    private var tabs: WindowTabs { app.tabs }
    /// The tab in view, by its tag; picking one opens its tab.
    private var selection: String? {
        get { tabs.selection?.text }
        nonmutating set { if let newValue { tabs.choose(TabKey(newValue)) } }
    }
    private func newSession(_ directory: String?) { tabs.newSession(in: directory) }
    /// A conversation in the project, where its new sessions open a terminal instead.
    private func newConversation(_ directory: String) { tabs.open(.draft(directory)) }
    private func newProject() { tabs.openProjectEditor(ProjectEditorRequest(project: nil)) }
    private func editProject(_ project: Workspace.Project) { tabs.openProjectEditor(ProjectEditorRequest(project: project)) }
    private func showProviders() { app.openSettings(.accounts) }
    private func newBot() { tabs.openBotEditor(bot: nil) }
    private func editBot(_ bot: Bot) { tabs.openBotEditor(bot: bot) }
    private func newGroup() { tabs.openGroupEditor(group: nil) }
    private func editGroup(_ group: BotGroup) { tabs.openGroupEditor(group: group) }
    /// Ends a terminal tab.
    private func closeTerminal(_ key: String) { tabs.close(TabKey(key)) }

    /// The selection tag of a project's not-yet-sent new session.
    static func draftTag(_ directory: String) -> String { TabKey.draft(directory).text }

    static func draftDirectory(from tag: String) -> String? {
        TabKey(tag).draftFolder
    }

    var body: some View {
        #if DEBUG
        let _ = ScrollFrameMonitor.sidebarBodies += 1
        #endif
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
                    BoxNameStrip(boxes: boxes, selected: boxBinding, motion: boxMotion)
                        .padding(.top, 6)
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
                .onScrollPhaseChange { _, phase in if phase != .idle { GlanceCardPanel.shared.hide() } }
            } else {
                BoxPager(boxes: boxes, selected: boxBinding, motion: boxMotion) { box in
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
                    // A row's card goes as the list moves under it.
                    .onScrollPhaseChange { _, phase in if phase != .idle { GlanceCardPanel.shared.hide() } }
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
        // KUVO_DEMO_REMOVE_PROJECT: Remove Project…'s dialog for the project of that name.
        .task {
            guard let name = ProcessInfo.processInfo.environment["KUVO_DEMO_REMOVE_PROJECT"] else { return }
            try? await Task.sleep(for: .seconds(4))
            removingProject = workspace.projects.first { $0.name == name }
        }
        // KUVO_DEMO_BOX_FAILED: this Mac's box as if it had stopped for good, with that reason.
        .task {
            guard let text = ProcessInfo.processInfo.environment["KUVO_DEMO_BOX_FAILED"] else { return }
            try? await Task.sleep(for: .seconds(8))
            app.box.showFailure(text)
        }
        // KUVO_DEMO_AGENTS_FAILED: this Mac's coding agents' bridge (and its group chats) as if it
        // had stopped for good, with that reason.
        .task {
            guard let text = ProcessInfo.processInfo.environment["KUVO_DEMO_AGENTS_FAILED"] else { return }
            try? await Task.sleep(for: .seconds(8))
            app.agents.showFailure(text)
        }
        // KUVO_DEMO_SEARCH: text in the sidebar's search field.
        .onAppear { if let text = ProcessInfo.processInfo.environment["KUVO_DEMO_SEARCH"] { search = text } }
        // KUVO_DEMO_RENAME=sidebar: the session in view, renamed in its row.
        .task {
            guard ProcessInfo.processInfo.environment["KUVO_DEMO_RENAME"] == "sidebar" else { return }
            try? await Task.sleep(for: .seconds(2))
            if let selection, let session = workspace.session(selection) {
                renaming = RenameTarget(id: selection, place: workspace.isInChats(session) ? .chats : .project)
            }
        }
        #endif
        // Only the open session's place is remembered (the conversation's, while one of its
        // subagents is open in its place); picked elsewhere, it shows in its project.
        .onChange(of: selection) { pickedIn = pickedIn.filter { $0.key == selection || $0.key == selection.map(topConversation) } }
        // A branch opened (a new one, say): the conversations it came from unfold to show it.
        .onChange(of: selection.map { "\($0)|\(workspace.parent(of: $0) ?? "")" }, initial: true) {
            var id = selection.map(topConversation)
            for _ in 0..<10 {
                guard let current = id, let source = workspace.session(current).flatMap(Branches.origin(of:))?.id, source != current else { break }
                unfolded.insert(source)
                id = source
            }
        }
        // A tab on another box: its page slides in, so what's in view has its row in sight.
        .onChange(of: selection) { _, tag in
            guard let tag, let shown = tabs.box(of: TabKey(tag)), shown != box, boxes.contains(shown) else { return }
            withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) { boxID = shown.id }
        }
        // Another session picked: a rename in another row ends, keeping what was typed.
        .onChange(of: selection) { if renaming?.id != selection { renaming = nil } }
        // Titles match as you type; conversations once you pause.
        // Again once the sessions are in: a search typed while they load found none.
        .task(id: "\(search)\n\(workspace.isLoaded)") {
            let query = search.trimmingCharacters(in: .whitespaces)
            guard query.count >= 3 else {
                conversationFinds = [:]
                isSearchingConversations = false
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            isSearchingConversations = true
            searchAsked = Workspace.thisMacThenMachines(workspace.connectedMachines)
            searchAnswered = []
            // What an earlier search found doesn't stay under this one's while it's asked.
            conversationFinds = [:]
            // Each box's as it answers: one that's slow or far holds none of the others up.
            var answered: Set<String> = []
            let found = await workspace.searchConversations(query) { box, finds in
                guard !Task.isCancelled else { return }
                answered.insert(box)
                searchAnswered.insert(box)
                findsQuery = query
                conversationFinds[box] = finds
            }
            guard !Task.isCancelled else { return }
            // A box not asked this time (gone, not connected) keeps nothing from before.
            conversationFinds = conversationFinds.filter { answered.contains($0.key) }
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
            Button("Delete", role: .destructive) { if let session = deleting { delete(session) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let session = deleting { Text(deletionNote(session)) }
        }
        .alert(removingProject.map { "Remove “\($0.name)”?" } ?? "Remove This Project?", isPresented: Binding(get: { removingProject != nil }, set: { if !$0 { removingProject = nil } })) {
            Button("Remove") { if let project = removingProject { remove(project) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let project = removingProject { Text(removalNote(project)) }
        }
        // Inks readable on the glass: its quieter words solid, not blended with what's behind.
        .listInks()
    }

    // MARK: Boxes

    /// How the boxes are switched besides the swipe (Settings › Appearance).

    /// This Mac, then your machines, each a page of its own.
    private var boxes: [SidebarBox] {
        #if DEBUG
        // KUVO_DEMO_BOXES: stand-in machines by name, comma-separated, for how the name strip looks
        // with many and with long names (their pages are empty).
        if let names = ProcessInfo.processInfo.environment["KUVO_DEMO_BOXES"] {
            return [app.thisMacsBox] + names.split(separator: ",").map { .machine(String($0)) }
        }
        #endif
        return app.boxes
    }

    /// The box in view: the one last picked, while it's still there.
    private var box: SidebarBox {
        let picked = SidebarBox(id: boxID)
        return boxes.contains(picked) ? picked : app.thisMacsBox
    }

    private var boxBinding: Binding<SidebarBox> {
        Binding { box } set: { boxID = $0.id }
    }

    private func boxName(_ box: SidebarBox) -> String { app.name(of: box) }

    /// One box's page: what's on that computer.
    @ViewBuilder private func page(_ box: SidebarBox) -> some View {
        if boxes.count > 1 { BoxHeading(box: box) }
        let pinned = pinned(on: box)
        if !pinned.top.isEmpty {
            SectionHeader(title: "Pinned", isFolded: folded("pinned")) { EmptyView() }
            if !isFolded("pinned") {
                ForEach(pinned.top) { session in
                    sessionRow(session, in: .pinned, branches: pinned.under)
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
                    .sidebarFont(12, weight: .semibold)
            }
            .buttonStyle(IconButtonStyle(width: 22, height: 22))
            .help("New Project… (⇧⌘N)")
            .accessibilityLabel("New Project")
        }
        if !isFolded("projects") {
            // This Mac's box keeps its projects: stopped, nothing here can be saved until it's back.
            if box.machine == nil, let failure = app.box.failure {
                SidebarRow(isSelected: false, action: { Task { await app.box.startAgain() } }) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.orange)
                } title: {
                    Text("Projects can’t be saved")
                        .foregroundStyle(.secondary)
                } accessory: {
                    Text("Try Again")
                        .sidebarFont(12, weight: .medium)
                        .foregroundStyle(.tint)
                }
                .help("What keeps your projects on this Mac stopped. \(failure)")
                .accessibilityLabel("Projects can’t be saved. Try Again")
            }
            // A box from before it listed its sessions: what to do, where they'd be.
            if workspace.outdatedLists.contains(box.machine ?? BoxClient.thisMac) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sessions Need a Newer Kuvo Code")
                        .sidebarFont(13, weight: .medium)
                    Text("Update Kuvo Code on \(boxName(box)) to list its sessions here.")
                        .sidebarFont(12)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .accessibilityElement(children: .combine)
            }
            // (Once its box has said what its sessions are: until then there may be some.)
            if workspace.isLoaded && workspace.isListed(box.machine ?? BoxClient.thisMac) && projects.isEmpty {
                Text(box.machine == nil ? "Open a folder for the agent to work in." : "Open a folder on \(boxName(box)) for the agent to work in.")
                    .sidebarFont(13)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
            }
            ForEach(projects) { project in
                projectSection(project)
            }
        }
        let recents = recents(on: box)
        if !recents.top.isEmpty {
            SectionHeader(title: "Recents", isFolded: folded("recents")) { EmptyView() }
            if !isFolded("recents") {
                ForEach(recents.top) { session in
                    sessionRow(session, in: .recents, branches: recents.under)
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
                        .sidebarFont(12, weight: .semibold)
                        .frame(width: 22, height: 22)
                        .hoverHighlight(in: RoundedRectangle(cornerRadius: 6), mutesInk: true)
                }
                .help("New Bot or Group Chat")
                .accessibilityLabel("New Bot or Group Chat")
            } else {
                Button(action: newBot) {
                    Image(systemName: "plus")
                        .sidebarFont(12, weight: .semibold)
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
                botRow(bot)
            }
            // This Mac's bridge runs its group chats: stopped, they show as last seen until it's back.
            if box.machine == nil, !groupsHere.isEmpty, case .stopped(let failure) = groups.macReach {
                SidebarRow(isSelected: false, action: { Task { await app.restartGroupChats() } }) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.orange)
                } title: {
                    Text("Group chats stopped")
                        .foregroundStyle(.secondary)
                } accessory: {
                    Text("Restart")
                        .sidebarFont(12, weight: .medium)
                        .foregroundStyle(.tint)
                }
                .help("What runs your group chats on this Mac stopped. \(failure)")
                .accessibilityLabel("Group chats stopped. Restart")
            }
            // Group chats, under the bots they're with.
            ForEach(groupsHere) { group in
                let key = BotGroups.tabKey(group.id)
                GroupRow(group: group, isSelected: selection == key) {
                    selection = key
                }
                .heldContextMenu {
                    HeldRow.button("Edit Group Chat…", disabled: app.moves.isMoving(group.id)) { editGroup(group) }
                    MoveToComputerItems(thing: .group(group), app: app).submenu
                    HeldRow.divider
                    HeldRow.button("Delete Group Chat…", role: .destructive, disabled: app.moves.isMoving(group.id)) { deletingGroup = group }
                }
            }
        }
    }

    /// Sessions, and conversations' words, that have the search, on every box.
    @ViewBuilder private var searchResults: some View {
        // Not those already found by name, nor one deleted since the search.
        let results = results
        let inConversations = SidebarSearch.inConversations(conversationResults, besides: results, in: workspace, bots: bots)
        if !results.isEmpty || inConversations.isEmpty {
            SectionHeader(title: "Results") { EmptyView() }
        }
        if results.isEmpty && inConversations.isEmpty && !isSearchingConversations {
            Text("Nothing matches.")
                .sidebarFont(13)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
        }
        ForEach(results) { found in
            switch found {
            case .session(let session): sessionRow(session, in: .recents, branches: [:])
            case .bot(let bot): botRow(bot)
            }
        }
        // Computers whose conversations couldn't be searched, said, once there's a search of them.
        let unsearched = search.trimmingCharacters(in: .whitespaces).count >= 3 && !isSearchingConversations ? workspace.unsearched.sorted { $0.key < $1.key } : []
        if !inConversations.isEmpty || isSearchingConversations || !unsearched.isEmpty {
            SectionHeader(title: "In Conversations") {
                // One computer: its wait in the heading. More: each says so below as it answers.
                if isSearchingConversations && searchAsked.count < 2 { Spinner(size: 11).padding(.trailing, 6) }
            }
            if isSearchingConversations && searchAsked.count > 1 {
                ForEach(searchAsked, id: \.self) { box in
                    SearchedComputer(name: BoxClient.isThisMac(box) ? "This Mac" : app.machines.engine(box)?.machine.name ?? box,
                                     found: searchAnswered.contains(box) ? (conversationFinds[box]?.count ?? 0) : nil)
                }
            }
            ForEach(inConversations, id: \.found.id) { result in
                let show = {
                    // Find has the keyboard, not the composer.
                    app.tabs.open(TabKey(result.found.id))
                    let words = search.trimmingCharacters(in: .whitespaces)
                    if let subagent = result.subagent {
                        // Said by one of its subagents: that one, in its place, with Find on the words.
                        app.tabs.openInPlace(subagent)
                        let folder = workspace.session(result.found.id)?.location.directory ?? ""
                        Task { await workspace.subagentModel(for: subagent, in: folder)?.showFind(words) }
                    } else {
                        workspace.model(for: result.found.id)?.showFind(words)
                    }
                    // From the sidebar: no way back but a subagent's own, to the one it works for.
                    app.tabs.startFresh(TabKey(result.subagent ?? result.found.id))
                }
                switch result.found {
                case .bot(let bot):
                    botRow(bot, snippet: SearchMatches.snippet(result.snippet, found: findsQuery), action: show)
                case .session(let session):
                    ConversationResultRow(title: session.title ?? "New Session", snippet: SearchMatches.snippet(result.snippet, found: findsQuery), isSelected: selection == session.id, action: show)
                        .heldContextMenu { menu(for: session) }
                }
            }
            ForEach(unsearched, id: \.key) { computer, why in
                Text(why.line(for: computer))
                    .sidebarFont(12)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// A bot's row, in its box's page or found by the search, which stands in for the page: its
    /// face moves unless it's staged. `snippet`: the words a search found in its conversation.
    private func botRow(_ bot: Bot, snippet: AttributedString? = nil, action: (() -> Void)? = nil) -> some View {
        BotRow(bot: bot, isSelected: selection == bot.sessionID, animates: !stagedBots.contains(bot.id), snippet: snippet) {
            if let action { action() } else { selection = bot.sessionID }
        }
        .heldContextMenu {
            HeldRow.button("Edit Bot…", disabled: app.moves.isMoving(bot.id)) { editBot(bot) }
            MoveToComputerItems(thing: .bot(bot), app: app).submenu
        }
    }

    /// A new session on the box in view: on this Mac, in the project in view, as ⌘N; on a machine,
    /// in its first project, or a chat there when it has none.
    private func newSessionHere() {
        guard let machine = box.machine else { return newSession(nil) }
        if let project = workspace.projects.first(where: { SidebarBox(directory: $0.directory) == box }) { return newSession(project.directory) }
        newChat(on: machine)
    }

    /// A new chat on `machine`, in Kuvo Code's chats folder there, as its box names it (`kuvo/info`).
    private func newChat(on machine: String) {
        Task {
            struct Info: Decodable { var chats: String? }
            do {
                guard let chats = try await app.box(machine).value(Info.self, "GET", "kuvo/info").chats else {
                    throw BoxRefusal(status: 404, message: "\(app.machines.engine(machine)?.machine.name ?? machine) needs a newer Kuvo Code to start chats there. It updates by itself overnight.")
                }
                newSession(RemoteFolder.folder(chats, on: machine))
            } catch {
                Modal.show(error)
            }
        }
    }

    // MARK: Worktrees

    /// In a worktree no other session is working in.
    private func hasOwnWorktree(_ session: Session) -> Bool {
        workspace.worktrees[session.location.directory] != nil && !workspace.worktreeIsShared(session.location.directory, besides: session.id)
    }

    /// What else goes: its worktree, once its last session does (the box removes it), and the
    /// changes in it that weren't committed, unless archived sessions there keep them.
    private func deletionNote(_ session: Session) -> String {
        guard hasOwnWorktree(session) else { return "This can’t be undone." }
        let keepsChanges = workspace.worktreeHasArchivedSessions(session.location.directory, besides: session.id)
        return worktreeIsDirty && !keepsChanges ? "Its worktree and changes that weren’t committed are deleted too." : "Its worktree is deleted too."
    }

    /// Reads whether its worktree has changes that weren't committed first, for what Delete says.
    private func confirm(_ session: Session, then ask: @escaping (Session) -> Void) {
        guard hasOwnWorktree(session) else { return ask(session) }
        let place = GitPlace.of(session.location.directory, box: app.box)
        Task {
            worktreeIsDirty = await Git.hasUncommittedChanges(at: place)
            ask(session)
        }
    }

    /// What comes into view in its place is the window's tabs' to say, once it's gone (`dropClosed`).
    private func delete(_ session: Session) {
        Task {
            do { try await workspace.delete(session.id) } catch { Modal.show(error) }
        }
    }

    // MARK: Projects

    private func removalNote(_ project: Workspace.Project) -> String {
        let files = "Its files stay as they are."
        switch project.sessions.count {
        case 0: return files
        case 1: return "Its session goes to Archived Sessions in Settings, where you can bring it back. " + files
        case let count: return "Its \(count) sessions go to Archived Sessions in Settings, where you can bring them back. " + files
        }
    }

    private func remove(_ project: Workspace.Project) {
        Task {
            let kept: Int
            do {
                kept = try await workspace.removeProject(project.directory)
            } catch {
                return Modal.show(error)
            }
            guard kept > 0 else { return }
            let them = kept == 1 ? "One of its sessions couldn’t be archived" : "\(kept) of its sessions couldn’t be archived"
            Modal.show(ProjectKept(errorDescription: them + ", so “\(project.name)” stays in the sidebar with them. Try Remove Project… again in a moment."))
        }
    }

    private struct ProjectKept: LocalizedError {
        var errorDescription: String?
    }

    /// A project and its rows, with the lane of each bot overseeing sessions in it over them.
    private func projectSection(_ project: Workspace.Project) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            projectRows(project)
        }
        .overlayPreferenceValue(OverseenRows.self) { rows in
            if !collapsed.contains(project.directory), project.sessions.contains(where: { WorksFor($0) != nil }) {
                GeometryReader { proxy in
                    OverseerLanes(lanes: lanes(in: project, rows: rows, proxy: proxy), lights: lights(in: project))
                }
            }
        }
        // Each project's rows are its own lanes' alone.
        .transformPreference(OverseenRows.self) { $0 = [:] }
    }

    /// What its bots just did to its sessions, each on the lane to its row: one under another
    /// (a branch, a hand-off) lights the row it's under.
    private func lights(in project: Workspace.Project) -> [OverseerLight] {
        guard !app.botOversight.recent.isEmpty else { return [] }
        let marks = app.botOversight.playing(in: Set(project.sessions.map(\.id)))
        guard !marks.isEmpty else { return [] }
        let tree = Branches.latestFirst(project.sessions)
        var above: [String: String] = [:]
        for (parent, children) in tree.under {
            for child in children { above[child.id] = parent }
        }
        return marks.map { mark in
            var session = mark.session
            while let parent = above[session] { session = parent }
            return OverseerLight(id: mark.id, bot: mark.bot, session: session)
        }
    }

    /// Each bot's lane down `project`'s sessions shown: from under its folder, an elbow into each
    /// of the bot's sessions, and on into Show More when some of them are among those not shown.
    private func lanes(in project: Workspace.Project, rows: [String: Anchor<CGRect>], proxy: GeometryProxy) -> [OverseerLane] {
        guard let folder = rows[OverseenRows.project].map({ proxy[$0] }) else { return [] }
        let overseers = Oversight.overseers(of: Branches.latestFirst(project.sessions).top, ranked: bots.list.map(\.id)).compactMap { overseer in
            bots.bot(overseer.bot).map { (overseer: overseer, bot: $0) }
        }
        let icon = SidebarMetrics.iconWidth(messageFont), half = SidebarMetrics.rowHeight(messageFont) / 2
        let more = rows[OverseenRows.more].map { proxy[$0].midY }
        // Just under the folder.
        let top = folder.midY + (16 * messageFont.sidebarScale).rounded() / 2 + 1
        return overseers.enumerated().compactMap { index, overseen in
            let (overseer, bot) = overseen
            var elbows: [String: CGFloat] = [:]
            for session in overseer.sessions {
                if let row = rows[session] { elbows[session] = proxy[row].minY + half }
            }
            // On into Show More while some of them are under it; otherwise into the last one's
            // elbow, where the line turns.
            let hidden = elbows.count < overseer.sessions.count
            guard let bottom = hidden ? (more ?? elbows.values.max()) : elbows.values.max().map({ $0 - OverseerLanes.radius }) else { return nil }
            // Side by side under the folder, 6 points apart, closer for more than three, so each
            // turns into its rows before the title.
            let gap = overseers.count > 3 ? 12 / CGFloat(overseers.count - 1) : 6
            let x = 10 + icon / 2 + (CGFloat(index) - CGFloat(overseers.count - 1) / 2) * gap
            return OverseerLane(bot: bot.id, look: bot.look, paused: bots.paused.contains(bot.id), x: x, top: top,
                                bottom: bottom, elbows: elbows, reach: 10 + icon + 10 - 6)
        }
    }

    @ViewBuilder private func projectRows(_ project: Workspace.Project) -> some View {
        let isOpen = !collapsed.contains(project.directory)
        ProjectRow(project: project, isOpen: isOpen) {
            withAnimation(.ui) { toggle(project.directory) }
        } newSession: {
            newSession(project.directory)
        } openBot: { bot in
            selection = bot.sessionID
        }
        .heldContextMenu {
            HeldRow.button("New Session") { newSession(project.directory) }
            if workspace.settings[project.directory]?.terminal != nil {
                // Its sessions open a terminal; this still starts a conversation.
                HeldRow.button("New Conversation") { newConversation(project.directory) }
            }
            HeldRow.button("Edit Project…") { editProject(project) }
            if let engine = app.machines.engine(RemoteFolder.machine(of: project.directory)) {
                if !engine.isReady {
                    HeldRow.divider
                    // COMPAT(0.7 engine-stop): Start. Goes 3 months after 0.8.0.
                    HeldRow.button(engine.isStopped ? "Start \(engine.machine.name)" : "Connect to \(engine.machine.name)") { app.connectOrStart(engine) }
                }
            } else {
                HeldRow.divider
                openIn(URL(filePath: project.directory))
                HeldRow.button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting(project.allFolders.map { URL(filePath: $0) }) }
            }
            HeldRow.divider
            // Its sessions are archived on its computer, so not while a machine's isn't connected.
            HeldRow.button("Remove Project…", disabled: !project.sessions.isEmpty && app.machines.engine(RemoteFolder.machine(of: project.directory)).map { !$0.isReady } ?? false) {
                removingProject = project
            }
        }
        .anchorPreference(key: OverseenRows.self, value: .bounds) { [OverseenRows.project: $0] }
        if isOpen {
            if selection == Self.draftTag(project.directory) {
                SidebarRow(isSelected: true, indented: true, action: {}) {
                    EmptyView()
                } title: {
                    Text("New Session")
                }
            }
            terminalRows(terminals(in: project.directory), indented: true)
            let all = showsAll.contains(project.directory) || Self.demoShowsAll
            // Branched and handed-off ones show under the conversation they came from.
            let tree = Branches.latestFirst(project.sessions)
            let sessions = tree.top
            ForEach(all ? sessions : Array(sessions.prefix(Self.sessionsPerProject))) { session in
                sessionRow(session, in: .project, branches: tree.under)
                    .anchorPreference(key: OverseenRows.self, value: .bounds) { WorksFor(session) == nil ? [:] : [session.id: $0] }
            }
            if sessions.count > Self.sessionsPerProject, !Self.demoShowsAll {
                SidebarRow(isSelected: false, indented: true, action: {
                    withAnimation(.ui) {
                        if all { showsAll.remove(project.directory) } else { showsAll.insert(project.directory) }
                    }
                }) {
                    EmptyView()
                } title: {
                    Text(all ? "Show Less" : "Show \(sessions.count - Self.sessionsPerProject) More")
                        .foregroundStyle(.secondary)
                }
                .anchorPreference(key: OverseenRows.self, value: .bounds) { [OverseenRows.more: $0] }
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
                title: terminal.entry.session.title,
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
        let tree = Branches.latestFirst(workspace.chats.filter { SidebarBox(directory: $0.location.directory) == box })
        let chats = tree.top
        let isDraft = selection.flatMap(Self.draftDirectory).map { Workspace.isChat($0) && SidebarBox(directory: $0) == box } ?? false
        let more = box.machine.map { "chats:" + $0 } ?? Workspace.chatsFolder
        let newChat = { if let machine = box.machine { self.newChat(on: machine) } else { newSession(Workspace.chatsFolder) } }
        SectionHeader(title: "Chats", isFolded: folded("chats")) {
            Button { newChat() } label: {
                Image(systemName: "plus")
                    .sidebarFont(12, weight: .semibold)
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
                sessionRow(session, in: .chats, branches: tree.under)
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

    private var results: [SidebarSearch.Found] {
        SidebarSearch.byName(search, in: workspace, bots: bots)
    }

    /// `box`'s latest, each with its branches under it, a conversation as new as its newest
    /// branch; pinned ones are already at the top.
    private func recents(on box: SidebarBox) -> (top: [Session], under: [String: [Session]]) {
        let tree = Branches.latestFirst((workspace.projects.flatMap(\.sessions) + workspace.chats).filter { !Workspace.isPinned($0) && SidebarBox(directory: $0.location.directory) == box }
            .sorted { $0.time.updated > $1.time.updated })
        return (Array(tree.top.prefix(Self.recentCount)), tree.under)
    }

    /// `box`'s pinned ones, a pinned branch under its source when that's pinned too.
    private func pinned(on box: SidebarBox) -> (top: [Session], under: [String: [Session]]) {
        Branches.latestFirst((workspace.projects.flatMap(\.sessions) + workspace.chats).filter { Workspace.isPinned($0) && SidebarBox(directory: $0.location.directory) == box }
            .sorted { $0.time.updated > $1.time.updated })
    }

    /// The conversation `id` is a subagent of, through subagents of subagents; any other, itself.
    private func topConversation(_ id: String) -> String {
        var id = id
        for _ in 0..<10 {
            guard workspace.session(id) == nil, let parent = workspace.parent(of: id) else { break }
            id = parent
        }
        return id
    }

    /// Where a branch came from, for VoiceOver: "Branched from Timer cycle".
    static func origin(of session: Session, in workspace: Workspace, nested: Bool = true) -> String {
        Branches.rowHint(of: session, nested: nested, from: originTitle(of: session, in: workspace))
    }

    /// What a row shows at its end for one a lead on another computer started: "from Mini".
    static func tail(of session: Session, in workspace: Workspace, nested: Bool) -> String? {
        Branches.tail(of: session, nested: nested, from: originTitle(of: session, in: workspace))
    }

    /// The title of the conversation `session` came from, where that one is on the same computer:
    /// the sidebar holds every computer's sessions, and a lead on Mini isn't one a row on this
    /// Mac's page sits under, so its row says where it came from.
    private static func originTitle(of session: Session, in workspace: Workspace) -> String? {
        guard let origin = Branches.origin(of: session), let from = workspace.session(origin.id),
              SidebarBox(directory: from.location.directory) == SidebarBox(directory: session.location.directory) else { return nil }
        return from.title
    }

    /// Highlighted where it was picked; picked elsewhere (a tab, a new session), in its project.
    /// A subagent's conversation open, the one it works for is.
    private func isHighlighted(_ session: Session, in place: Place) -> Bool {
        guard let selection, topConversation(selection) == session.id else { return false }
        if let picked = pickedIn[session.id] { return picked == place }
        return place == (workspace.isInChats(session) ? .chats : .project)
    }

    /// A session's row, and under it, unfolded, the conversations branched or handed off from it
    /// in the same list (`branches`, by the one each came from).
    private func sessionRow(_ session: Session, in place: Place, branches: [String: [Session]]) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            sessionOnlyRow(session, in: place, branches: branches[session.id]?.count ?? 0, folded: folded(under: session.id, in: branches))
            if isUnfolded(session.id), !(branches[session.id] ?? []).isEmpty {
                BranchRows(parent: session.id, branches: branches, titleInset: 10 + (place == .project ? SidebarMetrics.iconWidth(messageFont) + 10 : 0), isUnfolded: { isUnfolded($0) }) { child, inset in
                    AnyView(sessionOnlyRow(child, in: place, branches: branches[child.id]?.count ?? 0, folded: folded(under: child.id, in: branches), branchInset: inset))
                }
            }
        }
    }

    /// KUVO_DEMO_SHOW_ALL: every project's sessions shown, as after Show More, for the sidebar
    /// with many rows.
    #if DEBUG
    static let demoShowsAll = ProcessInfo.processInfo.environment["KUVO_DEMO_SHOW_ALL"] != nil
    #else
    static let demoShowsAll = false
    #endif

    /// What's out of view under a row while it's folded: its branches and the sessions its agent
    /// started, and theirs.
    private func folded(under id: String, in branches: [String: [Session]]) -> [Session] {
        isUnfolded(id) ? [] : Branches.all(under: id, in: branches)
    }

    /// KUVO_DEMO_UNFOLD: every session's branches shown, for a look at them.
    #if DEBUG
    private static let demoUnfolds = ProcessInfo.processInfo.environment["KUVO_DEMO_UNFOLD"] != nil
    #else
    private static let demoUnfolds = false
    #endif

    private func isUnfolded(_ id: String) -> Bool {
        Self.demoUnfolds || unfolded.contains(id)
    }

    private func toggleBranches(of id: String) {
        withAnimation(.ui) {
            if unfolded.contains(id) { unfolded.remove(id) } else { unfolded.insert(id) }
        }
    }

    /// `branchInset`: a branch's, under the conversation it came from, its title that far in.
    /// `branches`: how many are under it.
    /// `folded`: what's out of view under it, whose news and asks show on it.
    private func sessionOnlyRow(_ session: Session, in place: Place, branches: Int, folded: [Session] = [], branchInset: CGFloat? = nil) -> some View {
        let look = SessionRowLook(session: session, place: place, isHighlighted: isHighlighted(session, in: place),
                                  isEditing: renaming == RenameTarget(id: session.id, place: place),
                                  branches: branches, folded: folded, branchInset: branchInset, isUnfolded: isUnfolded(session.id), isSearching: !search.isEmpty,
                                  isUnread: session.isUnread || workspace.hasNewSubSessions(session.id),
                                  origin: Self.origin(of: session, in: workspace, nested: branchInset != nil),
                                  elsewhere: Self.tail(of: session, in: workspace, nested: branchInset != nil), acrossComputers: !search.isEmpty && boxes.count > 1)
        return StillRow(look: look) { sessionRowContent(look) }.equatable()
    }

    /// What a session's row shows and does, all worked out by the sidebar: nothing in the row reads
    /// the window's selection itself, so switching tabs works out again only the rows it changes.
    /// Anything the row reads from the sidebar's own state has to be in here, or the row misses
    /// its changes (the stores it reads itself still update it).
    private struct SessionRowLook: Equatable {
        let session: Session
        let place: Place
        let isHighlighted: Bool
        let isEditing: Bool
        let branches: Int
        let folded: [Session]
        let branchInset: CGFloat?
        let isUnfolded: Bool
        let isSearching: Bool
        /// Finished and not seen, it or a sub-session: worked out here, as it reads the whole list
        /// of sessions, which opening any session changes.
        let isUnread: Bool
        /// Where a branch came from, for VoiceOver (from the list too).
        let origin: String
        /// Started by a lead on another computer that isn't listed here: "from Mini", at its end.
        var elsewhere: String? = nil
        /// More than one computer, which search results span.
        var acrossComputers = false
    }

    private func sessionRowContent(_ look: SessionRowLook) -> some View {
        let session = look.session, place = look.place, branches = look.branches, folded = look.folded
        return SidebarRow(isSelected: look.isHighlighted, indented: place == .project, branchInset: look.branchInset, isEditing: look.isEditing, action: {
            GlanceCardPanel.shared.hide()
            pickedIn[session.id] = place
            selection = session.id
            // Its mark was one under it: shown, so that one's row has it.
            if folded.contains(where: { $0.isUnread || workspace.needsAttention($0.id) }) {
                withAnimation(.ui) { _ = unfolded.insert(session.id) }
            }
        }) {
            EmptyView()
        } title: {
            if look.isEditing {
                // Each ends only its own rename: one started on another row meanwhile stays.
                let target = RenameTarget(id: session.id, place: place)
                InlineTitleField(original: session.title ?? "") { title in
                    Task { await workspace.rename(session.id, to: title) }
                    if renaming == target { renaming = nil }
                } cancel: {
                    if renaming == target { renaming = nil }
                }
            } else if let elsewhere = look.elsewhere, !Workspace.isArchived(session) {
                // Started from another computer: which, in a word, at the title's end; pointed at,
                // who and where. The title always wins: in a row too narrow for both, it goes.
                TitleWithTail(session.title ?? "New Session") { words in
                    sessionTitle(session, in: place, words: words)
                } tail: {
                    Text(elsewhere)
                        .sidebarFont(11)
                        // (Readable on the open row's fill, as its other secondary words are.)
                        .foregroundStyle(look.isHighlighted ? HierarchicalShapeStyle.secondary : .tertiary)
                        .lineLimit(1)
                        // (As wide as it reads, up to a cap: a long name loses its end, never "from".)
                        .truncationMode(.tail)
                        .frame(maxWidth: 80, alignment: .trailing)
                        .fixedSize(horizontal: true, vertical: false)
                        // (The row's hint says it whole.)
                        .accessibilityHidden(true)
                }
                // Who and where, pointed at, the note shown or not.
                .help(look.origin)
            } else {
                sessionTitle(session, in: place)
            }
        } accessory: {
            if Workspace.isArchived(session) {
                Text("Archived")
                    .sidebarFont(11)
                    .foregroundStyle(.tertiary)
            } else {
                HStack(spacing: 6) {
                    if look.isSearching, workspace.isInChats(session), let machine = RemoteFolder.machine(of: session.location.directory) {
                        Image(systemName: "server.rack")
                            .sidebarFont(10)
                            .foregroundStyle(.tertiary)
                            // (Its card names the computer.)
                            .accessibilityLabel("On \(machine)")
                    }
                    // Its pull request's mark, else its own branch's (its card says which).
                    SessionRowMark(session: session)
                    if branches > 0 {
                        BranchesToggle(count: branches, isUnfolded: look.isUnfolded) { toggleBranches(of: session.id) }
                    }
                    // A subagent that finished since you were here shows on it: what it found is
                    // in its conversation.
                    SessionStatus(session: session, isUnread: look.isUnread, folded: folded)
                }
            }
        }
        .heldContextMenu { menu(for: session, in: place) }
        .modifier(BranchesAction(count: branches, isUnfolded: look.isUnfolded) { toggleBranches(of: session.id) })
        .modifier(SessionGlanceHover(session: session, row: "\(place)/\(session.id)", underItsProject: place == .project && !look.isSearching,
                                     acrossComputers: look.isSearching && look.acrossComputers, isUnread: look.isUnread, folded: folded))
        .accessibilityHint(look.origin)
    }

    /// A session's title in its row: a bot's face before it where its lane doesn't show it.
    /// `words`: in place of its title (what of it is kept, to measure by).
    private func sessionTitle(_ session: Session, in place: Place, words: String? = nil) -> some View {
        HStack(spacing: 6) {
            // A bot's work: its face, still, before the title; in a project, its lane shows
            // it instead, the session staying yours.
            if place != .project, let by = WorksFor(session), let bot = bots.bot(by.bot) {
                BotAvatar(look: bot.look, size: 15, animates: false)
                    .help("Started by \(bot.name)")
                    .accessibilityLabel("\(bot.name)’s work")
            }
            Text(words ?? session.title ?? "New Session")
                .fontWeight(session.isUnread ? .semibold : .regular)
                .foregroundStyle(Workspace.isArchived(session) ? .secondary : .primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .accessibilityValue(place == .project ? WorksFor(session).flatMap { bots.bot($0.bot) }.map { Oversight.overseenBy($0.name) } ?? "" : "")
        }
    }

    /// A conversation's side threads ("/btw"), each opening it with the thread over the composer.
    @HeldRows private func sideQuestionsMenu(for session: Session, in place: Place?) -> [HeldRow] {
        let bridge = workspace.agents(forFolder: session.location.directory)
        if let count = bridge?.sideQuestionCounts[session.id], count > 0 {
            HeldRow.submenu("Side Questions") {
                let questions = bridge?.sideQuestions[session.id] ?? []
                if questions.isEmpty {
                    HeldRow.button("Open the Latest") { showSideQuestion(nil, of: session, in: place) }
                }
                for thread in SideThread.threads(questions).reversed() {
                    HeldRow.button(String(thread.first.question.prefix(60)), subtitle: thread.questions.count > 1 ? "\(thread.questions.count) asked" : nil) {
                        showSideQuestion(thread.latest.id, of: session, in: place)
                    }
                }
            }
        }
    }

    /// `place`: the row it's opened from, highlighted as a click on it would be.
    private func showSideQuestion(_ id: String?, of session: Session, in place: Place?) {
        if let place { pickedIn[session.id] = place }
        selection = session.id
        Task { await workspace.model(for: session.id)?.showSideQuestion(id) }
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
    @HeldRows private func menu(for session: Session, in place: Place? = nil) -> [HeldRow] {
        // A bot's own conversation (found by a search): the bot's menu. Deleting, archiving or
        // renaming it as a session would leave the bot without its conversation.
        if let bot = bots.list.first(where: { $0.sessionID == session.id }) {
            HeldRow.button("Edit Bot…") { editBot(bot) }
        } else if let engine = app.machines.engine(workspace.waitingMachine(for: session.id)) {
            // COMPAT(0.7 engine-stop): an engine an older Mac stopped. Goes 3 months after 0.8.0.
            // On a machine that's away, the session is as last seen: what it does waits for it.
            HeldRow.note(engine.isStopped ? "\(engine.machine.name)’s engine is stopped" : "\(engine.machine.name) isn’t connected")
            switch engine.state {
            case .starting, .downloading: HeldRow.note("Connecting…")
            // COMPAT(0.7 engine-stop): Start. Goes 3 months after 0.8.0.
            default: HeldRow.button(engine.isStopped ? "Start" : "Connect Now") { app.reconnectNow(engine) }
            }
        } else {
            liveMenu(for: session, in: place)
        }
    }

    @HeldRows private func liveMenu(for session: Session, in place: Place?) -> [HeldRow] {
        // Moving to another computer (or just moved, not yet shown where it lives now): what
        // would change it waits until it's there.
        let moving = app.moves.isHeld(session.id)
        if !Workspace.isArchived(session) {
            if Workspace.isPinned(session) {
                HeldRow.button("Unpin", disabled: moving) { Task { await workspace.setPinned(session.id, false) } }
            } else {
                HeldRow.button("Pin", disabled: moving) { Task { await workspace.setPinned(session.id, true) } }
            }
        }
        // Open Beside, on another session's menu while a session's tab is in view.
        if let open = app.tabs.sessionID, open != session.id {
            HeldRow.button("Open Beside") { app.tabs.openBeside(session.id) }
        }
        sideQuestionsMenu(for: session, in: place)
        if let place {
            HeldRow.button("Rename…", disabled: moving) {
                renaming = RenameTarget(id: session.id, place: place)
            }
        }
        if workspace.isInChats(session) {
            moveToProject(session, disabled: moving)
            MoveToComputerItems(thing: .chat(session), app: app).submenu
        } else if !RemoteFolder.isRemote(session.location.directory) {
            HeldRow.button("Show in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: session.location.directory) }
        }
        HeldRow.divider
        HeldRow.button("Copy as Markdown") {
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
        HeldRow.button("Export as Markdown…") { Task { await export(session) } }
        HeldRow.divider
        if Workspace.isArchived(session) {
            HeldRow.button("Unarchive", disabled: moving) { Task { await workspace.setArchived(session.id, false) } }
        } else {
            HeldRow.button("Archive", disabled: moving) {
                Task { await workspace.setArchived(session.id, true) }
            }
        }
        HeldRow.button("Delete…", role: .destructive, disabled: moving) { confirm(session) { deleting = $0 } }
    }

    /// "Move to Project ›": a chat's way into one of the projects on its computer.
    private func moveToProject(_ session: Session, disabled: Bool) -> HeldRow {
        let machine = RemoteFolder.machine(of: session.location.directory)
        return HeldRow.submenu("Move to Project", disabled: disabled) {
            let projects = workspace.projects.filter { RemoteFolder.machine(of: $0.directory) == machine }
            for project in projects {
                HeldRow.button(project.name) {
                    Task {
                        do {
                            try await workspace.move(session.id, toProject: project.directory)
                        } catch {
                            Modal.show(error)
                        }
                    }
                }
            }
            if projects.isEmpty {
                HeldRow.note(machine.map { "No projects on \($0)" } ?? "No projects on this Mac")
            }
        }
    }
}

// MARK: - Rows

/// "Open In ›": the developer apps on this Mac that open a folder: editors, terminals, git apps,
/// then the Finder. (The system's own list for folders is mostly archivers and readers.)
private func openIn(_ folder: URL) -> HeldRow {
    HeldRow.submenu("Open In") {
        let workspace = NSWorkspace.shared
        for app in OpenInApps.ids.compactMap({ workspace.urlForApplication(withBundleIdentifier: $0) }) {
            HeldRow.button(FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: ""), icon: workspace.icon(forFile: app.path)) {
                workspace.open([folder], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
            }
        }
    }
}

private enum OpenInApps {
    /// By bundle identifier, in the order they're listed.
    static let ids = [
        "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf", "dev.zed.Zed",
        "com.apple.dt.Xcode", "com.panic.Nova", "com.sublimetext.4", "com.barebones.bbedit",
        "com.jetbrains.intellij", "com.jetbrains.intellij.ce", "com.jetbrains.WebStorm", "com.jetbrains.pycharm",
        "com.jetbrains.pycharm.ce", "com.jetbrains.goland", "com.jetbrains.rider", "com.google.android.studio",
        "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp-Stable",
        "com.DanPristupov.Fork", "com.fournova.Tower3", "com.github.GitHubClient", "com.torusknot.SourceTreeNotMAS",
        "com.apple.finder",
    ]
}

/// A session found by what was said in it: its title, and the words around the match.
private struct ConversationResultRow: View {
    let title: String
    let snippet: AttributedString
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .sidebarFont(14)
                Text(snippet)
                    .sidebarFont(12)
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
    @Environment(\.messageFont) private var messageFont

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .sidebarFont(13)
                .foregroundStyle(.secondary)
                .frame(width: SidebarMetrics.iconWidth(messageFont))
            TextField("Search", text: $text)
                .textFieldStyle(.plain)
                .sidebarFont(14)
                .focused($isFocused)
                .onExitCommand { text = "" }
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(ClearFieldButtonStyle())
                .accessibilityLabel("Clear")
                .help("Clear")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: SidebarMetrics.rowHeight(messageFont))
        // Sunken, without a border of its own; the focus rim while you type in it, as every well.
        .background(Surface.well(scheme), in: .rect(cornerRadius: 8))
        .focusRim(.rect(cornerRadius: 8), isOn: isFocused)
        .contentShape(.rect)
        .onTapGesture { isFocused = true }
        .padding(.vertical, 4)
    }
}

enum SidebarMetrics {
    static let rowHeight: CGFloat = 32
    static let iconWidth: CGFloat = 18

    /// A row's height in the window's sidebar, which follows Settings › Appearance › Text size.
    static func rowHeight(_ font: MessageFont) -> CGFloat { (rowHeight * font.sidebarScale).rounded() }
    static func iconWidth(_ font: MessageFont) -> CGFloat { (iconWidth * font.sidebarScale).rounded() }
}

extension MessageFont {
    /// The window's sidebar follows Text size: its names are 14 points at Default, as messages are.
    var sidebarScale: CGFloat { size / 14 }
}

extension View {
    /// The system font at `size` points, as at the Default text size: larger or smaller with
    /// Settings › Appearance › Text size, as the conversation's is.
    func sidebarFont(_ size: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(SidebarFont(size: size, weight: weight))
    }
}

private struct SidebarFont: ViewModifier {
    let size: CGFloat
    let weight: Font.Weight
    @Environment(\.messageFont) private var font

    func body(content: Content) -> some View {
        content.font(.system(size: size * font.sidebarScale, weight: weight))
    }
}

/// A row's highlight, the sidebar's and Settings': what you pick from a list, drawn as everywhere
/// else (`pickHighlight`), from where the row's own content starts (`leading`).
struct RowHighlight: ViewModifier {
    let isSelected: Bool
    var leading: CGFloat = 0

    func body(content: Content) -> some View {
        content.pickHighlight(RoundedRectangle(cornerRadius: 8), isOn: isSelected, leading: leading)
    }
}

/// One line in the sidebar: an optional icon, a title, an optional trailing accessory.
/// Indented rows line their titles up with the project names above them.
private struct SidebarRow<Icon: View, Title: View, Accessory: View>: View {
    var isSelected: Bool
    var indented = false
    /// A branch's, under the conversation it came from: its title this far in, past the line.
    var branchInset: CGFloat?
    /// Its title is being typed (renamed): not a button meanwhile, so the field takes the keys.
    var isEditing = false
    let action: () -> Void
    @ViewBuilder var icon: () -> Icon
    @ViewBuilder var title: () -> Title
    @ViewBuilder var accessory: () -> Accessory
    @Environment(\.messageFont) private var messageFont

    var body: some View {
        #if DEBUG
        let _ = ScrollFrameMonitor.sidebarRowBodies += 1
        #endif
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
                    .sidebarFont(14)
                    .foregroundStyle(.secondary)
                    .frame(width: SidebarMetrics.iconWidth(messageFont))
            } else if indented, branchInset == nil {
                Color.clear.frame(width: SidebarMetrics.iconWidth(messageFont), height: 1)
            }
            // The title takes the room up to the accessory, one gap from its mark, rather than
            // a spacer with a gap on each side of it.
            title()
                .sidebarFont(14)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            accessory()
        }
        .padding(.leading, branchInset ?? 10)
        .padding(.trailing, 10)
        .frame(height: SidebarMetrics.rowHeight(messageFont))
        // An indented row's fill starts at its title, beside the project's line of sessions; a
        // branch's just before its title, so the line and its elbow stay in view.
        .modifier(RowHighlight(isSelected: isSelected, leading: branchInset.map { $0 - 5 } ?? (indented && Icon.self == EmptyView.self ? 10 + SidebarMetrics.iconWidth(messageFont) : 0)))
    }
}

extension SidebarRow where Accessory == EmptyView {
    init(isSelected: Bool, indented: Bool = false, action: @escaping () -> Void, @ViewBuilder icon: @escaping () -> Icon, @ViewBuilder title: @escaping () -> Title) {
        self.init(isSelected: isSelected, indented: indented, branchInset: nil, action: action, icon: icon, title: title, accessory: { EmptyView() })
    }
}

/// A project: its folder (open or closed) and name. Clicking opens or closes it; the
/// compose button for a new session in it shows under the pointer, in place.
private struct ProjectRow: View {
    @Environment(\.messageFont) private var messageFont
    let project: Workspace.Project
    let isOpen: Bool
    let toggle: () -> Void
    let newSession: () -> Void
    /// A bot's face clicked: its chat.
    let openBot: (Bot) -> Void
    @State private var isHovering = false
    @Environment(AppModel.self) private var app

    @Environment(\.marksMachines) private var marksMachines

    /// The machine the project is on, when it's not this Mac.
    private var machine: MachineEngine? {
        app.machines.engine(RemoteFolder.machine(of: project.directory))
    }

    /// The bots overseeing sessions here, the first to show first.
    private func overseers() -> [Bot] {
        Oversight.overseers(of: Branches.latestFirst(project.sessions).top, ranked: app.bots.list.map(\.id)).compactMap { app.bots.bot($0.bot) }
    }

    /// The size of a bot's face here, and how far the next one overlaps it.
    private var faceSize: CGFloat { (20 * messageFont.sidebarScale).rounded() }
    private func facesWidth(_ count: Int) -> CGFloat {
        let shown = CGFloat(min(count, 3))
        return shown * (faceSize + 4) - (shown - 1) * (faceSize / 5 + 4) + (count > 3 ? 22 : 0)
    }

    /// Their faces, overlapping a little: bright while a session of theirs here needs you, asleep
    /// while paused, pleased a moment as one finishes. Each opens its bot's chat.
    private func faces(_ overseers: [Bot]) -> some View {
        let size = faceSize
        let finished = app.botOversight.recent.isEmpty ? []
            : app.botOversight.playing(in: Set(project.sessions.map(\.id))).filter { $0.kind == .finished }
        return HStack(spacing: 2) {
            HStack(spacing: -(size / 5 + 4)) {
                ForEach(overseers.prefix(3)) { bot in
                    face(bot, size: size, pleased: finished.first { $0.bot == bot.id }?.id)
                }
            }
            if overseers.count > 3 {
                Text("+\(overseers.count - 3)")
                    .sidebarFont(11, weight: .medium)
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                    .help(Oversight.overseenBy(overseers.dropFirst(3).map(\.name)))
            }
        }
    }

    private func face(_ bot: Bot, size: CGFloat, pleased: String?) -> some View {
        // Any of its sessions here, under another one too.
        let pose: OverseerFace.Pose = app.bots.paused.contains(bot.id) ? .paused
            : project.sessions.contains(where: { WorksFor($0)?.bot == bot.id && app.workspace.needsAttention($0.id) }) ? .needsYou : .rest
        return Button { openBot(bot) } label: {
            OverseerFace(look: bot.look, size: size, pose: pose, pleased: pleased)
        }
        .buttonStyle(IconButtonStyle(width: size + 4, height: size + 4, cornerRadius: (size + 4) / 2))
        .clickablePointer()
        .help(Oversight.overseenBy(bot.name))
        .accessibilityLabel(bot.name)
        .accessibilityHint("Opens its conversation")
    }

    var body: some View {
        // Worked out here, not by the sidebar, so only this row follows its sessions' states.
        let mark = isOpen ? nil : foldedMark(of: project.sessions, workspace: app.workspace, app: app)
        let overseers = self.overseers()
        Button(action: toggle) {
            HStack(spacing: 10) {
                FolderIcon(isOpen: isOpen, size: (16 * messageFont.sidebarScale).rounded())
                    .foregroundStyle(.secondary)
                .frame(width: SidebarMetrics.iconWidth(messageFont))
                Text(project.name)
                    .sidebarFont(14)
                    .lineLimit(1)
                    .layoutPriority(1)
                if let machine, marksMachines {
                    MachineLabel(engine: machine)
                }
                Spacer(minLength: 6)
                // Room for the bots' faces (over the row, so each takes its own click), as far as
                // they go under the pointer.
                if !overseers.isEmpty {
                    Color.clear.frame(width: facesWidth(overseers.count), height: 1)
                        .padding(.trailing, mark == nil ? -10 : -2)
                }
                // Room for the compose button, so a long name never runs under it; folded, the
                // mark of what's under it, where a session's sits, the button over it under the
                // pointer.
                ZStack(alignment: .trailing) {
                    Color.clear.frame(width: 22, height: 1)
                    // Always there, so a state arriving plays its arrival; an empty tip shows none.
                    StatusMark(showing: mark)
                        .opacity(isHovering ? 0 : 1)
                        .help(mark?.wordsFromUnder ?? "")
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: SidebarMetrics.rowHeight(messageFont))
            .hoverHighlight(selected: false)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .accessibilityValue([mark?.wordsFromUnder, overseers.isEmpty ? nil : Oversight.overseenBy(overseers.map(\.name))].compactMap { $0 }.joined(separator: ", "))
        .overlay(alignment: .trailing) {
            // Beside the compose button, which shows under the pointer, so they stay put as you
            // reach for one; before the mark of what's folded under it.
            if !overseers.isEmpty {
                faces(overseers)
                    .padding(.trailing, mark != nil ? 40 : 32)
            }
        }
        .overlay(alignment: .trailing) {
            Button(action: newSession) {
                Image(systemName: "square.and.pencil")
                    .sidebarFont(13, weight: .medium)
            }
            .buttonStyle(IconButtonStyle(width: 26, height: 24))
            .padding(.trailing, 4)
            .opacity(isHovering ? 1 : 0)
            .accessibilityLabel("New Session in \(project.name)")
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
                    .sidebarFont(11)
                    .foregroundStyle(.secondary)
                Text(title)
            }
        } accessory: {
            // Room for the End button, so a long name never runs under it.
            Color.clear.frame(width: 6, height: 1)
        }
        .overlay(alignment: .trailing) {
            Button(action: end) {
                Image(systemName: "xmark")
                    .sidebarFont(10, weight: .semibold)
            }
            .buttonStyle(IconButtonStyle(width: 22, height: 22))
            .padding(.trailing, 4)
            .opacity(isHovering ? 1 : 0)
            .help("End Terminal")
            .accessibilityLabel("End Terminal")
        }
        .onHover { isHovering = $0 }
        .heldContextMenu { HeldRow.button("End Terminal", action: end) }
    }
}

/// Which machine a project is on, small after its name, with a dot when it isn't connected.
private struct MachineLabel: View {
    let engine: MachineEngine

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "server.rack")
                .sidebarFont(9, weight: .semibold)
            Text(engine.machine.name)
                .lineLimit(1)
            MachineIndicator(connection: engine.connection, size: 6, quiet: true, progress: engine.installProgress)
        }
        .sidebarFont(11, weight: .medium)
        .foregroundStyle(.secondary)
        .help(engine.statusDetail)
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
        let speaker = groups.speaker(in: group.id).flatMap { bots.bot($0) }
        let isUnread = groups.isUnread(group) && !isSelected
        let machine = groups.machine(of: group.id)
        FaceRow(title: group.name, isUnread: isUnread, isSelected: isSelected, action: action) {
            GroupAvatar(faces: group.members.compactMap { id in
                bots.bot(id).map { GroupAvatar.Face(look: $0.look, mood: $0.id == speaker?.id ? .working : .idle) }
            }, size: 28)
        } subtitle: {
            if let going = app.moves.underWay[group.id] {
                MoveStatus(going: going)
            } else if let speaker {
                ShimmerText(text: "\(speaker.name) is thinking…")
            } else if groups.isDiscussing(group.id) {
                ShimmerText(text: "Talking it over…")
            } else {
                Text(lastLine)
            }
        } trailing: {
            HStack(spacing: 6) {
                // One that lives on a machine, which talks there while this Mac is off.
                if let machine, marksMachines {
                    Image(systemName: "server.rack")
                        .sidebarFont(10)
                        .foregroundStyle(.tertiary)
                        .help("Lives on \(app.machines.engine(machine)?.machine.name ?? machine)")
                }
                if isUnread {
                    StatusMark(.new)
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
    @Environment(\.messageFont) private var messageFont
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
                        .sidebarFont(14)
                        .fontWeight(isUnread ? .semibold : .regular)
                    subtitle
                        .sidebarFont(12)
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                trailing
            }
            .padding(.horizontal, 10)
            .frame(height: (46 * messageFont.sidebarScale).rounded())
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
    /// Words found in its conversation by a search: shown in place of what it's doing.
    var snippet: AttributedString?
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
            if let snippet { Text(snippet) } else { status }
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
    private var hasNews: Bool { session?.isUnread == true }

    /// What it's up to: working, waiting for you, what it said that you haven't read, when it
    /// wakes next, or its job. What it's set to do (wake up, watch) and how it's set (paused)
    /// stand apart from what it said, with their sign.
    @ViewBuilder private var status: some View {
        if let going = app.moves.underWay[bot.id] {
            MoveStatus(going: going)
        } else if workspace.needsAttention(bot.sessionID) {
            Text("Needs you")
                .foregroundStyle(.orange)
        } else if workspace.running.contains(bot.sessionID) {
            ShimmerText(text: "Working…")
        } else if case let helpers = workspace.helpersAtWork(in: bot.sessionID), helpers > 0 {
            ShimmerText(text: helpers == 1 ? "Working on a task…" : "Working on \(helpers) tasks…")
        } else if let line = bots.workLine(bot, in: workspace) {
            // Its sessions at work, as the bar over its composer counts them (one only waiting on
            // you shows on its own row).
            ShimmerText(text: line)
        } else if let place = bots.waitingFor(bot) {
            // What you changed while its machine was away, on its way once it's back.
            BotState(systemImage: "clock.arrow.circlepath", isSet: false) { Text("Changes waiting for \(place)") }
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
        } else if let line = AtWork.restLine(of: bot.id, in: workspace.sessions) {
            // At rest: what it looks after, in place of its job.
            Text(line)
        } else {
            // No job yet: it asks for one, until your message gives it.
            Text(bot.job.isEmpty ? EmptyConversationView.purposeQuestion : bot.job)
        }
    }
}

/// A bot's or a group chat's move in its row: how far it is, shimmering, or, while it waits for a
/// computer that has gone quiet, still, with the sign of what waits for a computer.
private struct MoveStatus: View {
    let going: Moves.Going

    var body: some View {
        if going.waitingFor != nil {
            BotState(systemImage: "clock.arrow.circlepath", isSet: false) { Text(going.words) }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(going.spoken)
        } else {
            ShimmerText(text: going.words)
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
                .sidebarFont(10, weight: .semibold)
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
                            .sidebarFont(9, weight: .bold)
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
        .padding(.top, 20)
        .padding(.bottom, 4)
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
    }

    private var label: some View {
        Text(title)
            .sidebarFont(12, weight: .semibold)
            // A heading reads as one: the words under it are quieter.
            .foregroundStyle(.primary)
    }
}

/// A computer asked for a search of its conversations: its name, and, once it has answered, a
/// check and how many it found; dots while it's being asked.
private struct SearchedComputer: View {
    let name: String
    /// What it found, once it has answered.
    let found: Int?

    var body: some View {
        HStack(spacing: 6) {
            Text(name)
                .foregroundStyle(.secondary)
            if let found {
                Image(systemName: "checkmark")
                    .sidebarFont(10, weight: .semibold)
                    .foregroundStyle(.green)
                Spacer(minLength: 6)
                Text(found == 0 ? "None" : "\(found) found")
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            } else {
                AskingDots()
                Spacer(minLength: 6)
            }
        }
        .sidebarFont(12)
        .padding(.horizontal, 10)
        .frame(height: 24)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(found.map { "\(name), \($0 == 0 ? "nothing" : "\($0)") found" } ?? "\(name), searching")
    }
}

/// "Move to Computer ›": a bot's, chat's or group chat's way to another of your computers, where it
/// carries on (`Moves`), as the box it lives on says it can go, with why not where it can't. Asked
/// first, as the original goes to the trash where it was.
struct MoveToComputerItems {
    enum Thing {
        case bot(Bot)
        case chat(Session)
        case group(BotGroup)

        var id: String {
            switch self {
            case .bot(let bot): bot.id
            case .chat(let session): session.id
            case .group(let group): group.id
            }
        }

        var kind: String {
            switch self {
            case .bot: "bot"
            case .chat: "chat"
            case .group: "group"
            }
        }

        /// The machine it lives on (nil: this Mac).
        @MainActor func machine(in app: AppModel) -> String? {
            switch self {
            case .bot(let bot): bot.machine
            case .chat(let session): RemoteFolder.machine(of: session.location.directory)
            case .group(let group): app.chats.machine(of: group.id)
            }
        }
    }

    let thing: Thing
    let app: AppModel

    private var id: String { thing.id }
    private var kind: String { thing.kind }
    private var here: String? { thing.machine(in: app) }

    /// Where it can go, as the box it lives on said last (asked again as the menu opens); before
    /// it has, your other computers as this Mac knows them, each asked as it's picked.
    private var places: [Moves.Place] {
        app.moves.places(of: id, from: here) ?? app.moves.knownPlaces(from: here)
    }

    /// Its row in a menu. Where it can go is asked of again as the menu opens, and the list is
    /// made as the submenu opens, by when the answer has usually come.
    var submenu: HeldRow {
        Task { await app.moves.loadPlaces(kind, id, from: here) }
        return HeldRow.submenu("Move to Computer", disabled: app.moves.isMoving(id)) { rows }
    }

    /// What it lists.
    @HeldRows var rows: [HeldRow] {
        let places = places
        let reasons = Set(places.map(\.why))
        if let why = app.moves.whyNotAsked(from: here) {
            HeldRow.note(why)
        } else if places.isEmpty {
            HeldRow.note("No other computers to move it to")
        } else if places.count > 1, reasons.count == 1, let one = places.first, !one.ok {
            // Why it can't go anywhere (it works in a project, it's moving already), once.
            HeldRow.note(one.note ?? one.why ?? "")
        } else {
            // Why not one, in a few words beside its name (a menu doesn't wrap).
            for place in places {
                HeldRow.button(place.name, subtitle: place.note ?? place.why, disabled: !place.ok) { move(to: place) }
            }
        }
    }

    private func move(to place: Moves.Place) {
        let name = switch thing {
        case .bot(let bot): bot.name
        case .chat(let session): (session.title ?? "").isEmpty ? "this chat" : "“\(session.title ?? "")”"
        case .group(let group): "“\(group.name)”"
        }
        Task {
            // Asked again as it's picked: what the menu showed may be old, or this Mac's own guess.
            let now = await app.moves.loadPlaces(kind, id, from: here, fresh: true)
            let why = if let now {
                // Gone from the list: it lives there now, or that computer isn't one of yours.
                now.contains { $0.key == place.key } ? now.first { $0.key == place.key }?.why : "It can’t go to \(place.name) now."
            } else {
                app.moves.whyNotAsked(from: here)
            }
            if let why {
                Modal.show(Moves.Failure.refused(why))
                return
            }
            // What stays here, as its box said just now.
            let question = MoveWords.question(kind: kind, name: name, place: place.name, placeIsMac: place.kind == "mac", toHere: place.key == app.phoneLink.macKey,
                                              from: here.map { app.machines.engine($0)?.machine.name ?? $0 }, fromMachine: here != nil,
                                              stays: app.moves.stays(of: id, from: here))
            let confirmed = await Modal.run {
                let alert = NSAlert()
                alert.messageText = question.title
                alert.informativeText = question.message
                alert.addButton(withTitle: "Move")
                alert.addButton(withTitle: "Cancel")
                return alert.runModal() == .alertFirstButtonReturn
            }
            guard confirmed else { return }
            do {
                try await app.moves.move(kind, id, from: here, to: place)
            } catch {
                Modal.show(error)
            }
        }
    }
}

/// What a session's row and its tab show: one place decides, so the two always agree. A move to
/// another computer is work; a machine that's getting there (connecting, installing) isn't away.
/// `folded`: sessions out of view under its row, one waiting on you showing there too.
@MainActor func statusMark(of session: Session, isNew: Bool, folded: [Session] = [], workspace: Workspace, app: AppModel) -> StatusMark.Kind? {
    #if DEBUG
    if DemoStates.shared.isOn { return DemoStates.shared.kind(of: session.id) }
    #endif
    let id = session.id
    // A move waiting for a computer that went quiet isn't work: it waits, with nothing going on.
    let going = app.moves.underWay[id]
    let moving = going != nil && going?.waitingFor == nil
    let working = workspace.isWorking(id) || moving
    return ConversationState.kind(
        needsYou: workspace.needsAttention(id) || folded.contains { workspace.needsAttention($0.id) },
        working: working,
        subagentsOnly: !moving && working && !workspace.running.contains(id) && workspace.helpersAtWork(in: id) > 0,
        failed: session.outcome == .failed,
        isNew: isNew || folded.contains(where: \.isUnread),
        // (Its machine away while it moves: the move says what it waits for.)
        offline: going == nil && awayMachine(of: session, app: app) != nil,
        waitingForComputer: going?.waitingFor != nil,
        wakes: app.wakeUps.wakes[id]?.isEmpty == false,
        watching: app.wakeUps.watches[id]?.isEmpty == false)
}

/// A folded project's mark, where its sessions' sit (see `ConversationState.folded`).
@MainActor func foldedMark(of sessions: [Session], workspace: Workspace, app: AppModel) -> StatusMark.Kind? {
    ConversationState.folded(sessions.lazy.map {
        statusMark(of: $0, isNew: $0.isUnread || workspace.hasNewSubSessions($0.id), workspace: workspace, app: app)
    })
}

/// The machine a session lives on, by name, while that machine isn't connected and isn't on its
/// way to it.
@MainActor func awayMachine(of session: Session, app: AppModel) -> String? {
    guard let machine = RemoteFolder.machine(of: session.location.directory), let engine = app.machines.engine(machine),
          !engine.isReady, !engine.connection.isUnderWay else { return nil }
    return engine.machine.name
}

/// How a session is doing, at the end of its row. One mark stays in place while the state comes
/// and goes, so a state arriving on screen plays its arrival.
private struct SessionStatus: View {
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    let session: Session
    /// Finished and not seen: the session's own say, unless a row knows better (a sub-session's
    /// seen through the session above it; a folded session has a sub-session's news).
    var isUnread: Bool?
    /// Out of view under its row: one waiting on you shows here.
    var folded: [Session] = []

    var body: some View {
        let kind = statusMark(of: session, isNew: isUnread ?? session.isUnread, folded: folded, workspace: workspace, app: app)
        // One under it, folded away, gave it the mark: said so.
        let fromUnder = !folded.isEmpty && kind != statusMark(of: session, isNew: isUnread ?? session.isUnread, workspace: workspace, app: app)
        StatusMark(showing: kind)
            .help(kind.map { fromUnder ? $0.wordsFromUnder : help($0) } ?? "")
            .modifier(SpokenFromUnder(words: fromUnder ? kind?.wordsFromUnder : app.moves.underWay[session.id]?.spoken))
    }

    private func help(_ kind: StatusMark.Kind) -> String {
        switch kind {
        case .working, .waitingForComputer:
            app.moves.underWay[session.id]?.words ?? kind.words
        case .subagents: workspace.helpersAtWork(in: session.id).counting("subagent") + " at work"
        case .failed: "The last run failed"
        case .new: "Finished"
        case .offline: "\(awayMachine(of: session, app: app) ?? "Its machine") isn’t connected"
        case .wake:
            app.wakeUps.wakes[session.id]?.first.map { "Wakes up " + $0.due.formatted(Date.RelativeFormatStyle(presentation: .named, unitsStyle: .wide)) } ?? kind.words
        default: kind.words
        }
    }
}

/// A mark's words for VoiceOver when one under its row gave it.
private struct SpokenFromUnder: ViewModifier {
    let words: String?

    func body(content: Content) -> some View {
        if let words { content.accessibilityLabel(words) } else { content }
    }
}

// MARK: Branches

/// The conversations branched or handed off from one, under its row while it's unfolded: hung
/// from one line under its title, with a rounded elbow into each. Each is a conversation's row
/// like any other (`row`, given where its title starts); one with branches of its own folds and
/// unfolds the same way.
private struct BranchRows: View {
    let parent: String
    /// The list's branches, by the one each came from.
    let branches: [String: [Session]]
    /// Where the parent's title starts in its row: the line hangs under it.
    let titleInset: CGFloat
    let isUnfolded: (String) -> Bool
    let row: (Session, CGFloat) -> AnyView

    @State private var showsAll = false
    @Environment(\.messageFont) private var messageFont
    private static let shown = 8

    private var all: [Session] { branches[parent] ?? [] }
    private var children: [Session] { showsAll ? all : Array(all.prefix(Self.shown)) }
    private var lineX: CGFloat { titleInset + 5 }
    private var childInset: CGFloat { lineX + 14 }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(children) { child in
                VStack(alignment: .leading, spacing: 1) {
                    row(child, childInset)
                    if isUnfolded(child.id), !(branches[child.id] ?? []).isEmpty {
                        BranchRows(parent: child.id, branches: branches, titleInset: childInset, isUnfolded: isUnfolded, row: row)
                    }
                }
                // Its piece of the line: from the gap above it (so the line runs on without a
                // break) through its row, on to the next one's unless it's the last.
                .background(alignment: .topLeading) {
                    BranchLine(x: lineX, elbowY: SidebarMetrics.rowHeight(messageFont) / 2, runsOn: child.id != children.last?.id || all.count > children.count)
                }
            }
            if all.count > children.count {
                Button("Show \(all.count - children.count) More") { withAnimation(.ui) { showsAll = true } }
                    .buttonStyle(TextButtonStyle())
                    .sidebarFont(12)
                    .padding(.leading, childInset - 6)
                    .frame(height: SidebarMetrics.rowHeight(messageFont), alignment: .leading)
                    .background(alignment: .topLeading) {
                        BranchLine(x: lineX, elbowY: SidebarMetrics.rowHeight(messageFont) / 2, runsOn: false)
                    }
            }
        }
        .transition(.opacity)
    }
}

/// A piece of the line branches hang from: down from 1pt above its top, a rounded elbow
/// into its row, and on to its bottom when another follows. One stroke, so the pieces meet
/// without a seam or a darker overlap.
private struct BranchLine: View {
    let x: CGFloat
    let elbowY: CGFloat
    let runsOn: Bool
    private let radius: CGFloat = 6
    private let reach: CGFloat = 9

    var body: some View {
        GeometryReader { geometry in
            Path { path in
                path.move(to: CGPoint(x: x, y: -1))
                path.addLine(to: CGPoint(x: x, y: elbowY - radius))
                path.addQuadCurve(to: CGPoint(x: x + radius, y: elbowY), control: CGPoint(x: x, y: elbowY))
                path.addLine(to: CGPoint(x: x + reach, y: elbowY))
                if runsOn {
                    path.move(to: CGPoint(x: x, y: elbowY - radius))
                    path.addLine(to: CGPoint(x: x, y: geometry.size.height))
                }
            }
            .stroke(.primary.opacity(0.26), lineWidth: 1.25)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Where a project's rows are, for its bots' lanes: its own, each of its bots' sessions shown (by
/// id), and Show More's.
private struct OverseenRows: PreferenceKey {
    static let project = "project"
    static let more = "more"
    static let defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

/// How many conversations were branched or handed off from one, and the chevron that folds them
/// away or shows them.
private struct BranchesToggle: View {
    let count: Int
    let isUnfolded: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 3) {
                Text("\(count)")
                    .monospacedDigit()
                Image(systemName: "chevron.down")
                    .sidebarFont(9, weight: .semibold)
                    .rotationEffect(.degrees(isUnfolded ? 0 : -90))
            }
            .sidebarFont(12, weight: .medium)
        }
        .buttonStyle(TextButtonStyle())
        .help(isUnfolded ? "Hide its branches" : "Show its \(count.counting("branch", "branches"))")
        // The row it's in says so, with its action (see `BranchesAction`).
        .accessibilityHidden(true)
    }
}

/// A row with branches under it, for VoiceOver: how many, and the action that shows or hides
/// them, as the count inside it does.
private struct BranchesAction: ViewModifier {
    let count: Int
    let isUnfolded: Bool
    let toggle: () -> Void

    func body(content: Content) -> some View {
        if count > 0 {
            content
                .accessibilityValue(count.counting("branch", "branches") + (isUnfolded ? ", shown" : ""))
                .accessibilityAction(named: isUnfolded ? "Hide Branches" : "Show Branches", toggle)
        } else {
            content
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
                if catalog.signedInAccounts.isEmpty {
                    Image(systemName: "person.crop.circle.badge.plus")
                        .sidebarFont(15)
                        .foregroundStyle(.tint)
                } else {
                    HStack(spacing: 8) {
                        ForEach(catalog.signedInAccounts.prefix(3)) { provider in
                            ProviderLogo(id: OutsideAgents.logo(provider.id), size: 18, colored: true)
                        }
                    }
                }
                Text(label)
                    .sidebarFont(14)
                Spacer()
                // One needs you: its sign-in ended, or it's at its usage limit.
                if !problems.isEmpty {
                    Image(systemName: "exclamationmark.circle.fill")
                        .sidebarFont(13)
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
        // Its items enabled as each says (Mark All as Read with nothing new, Check for Updates).
        menu.autoenablesItems = false
        let providers = catalog.signedInAccounts
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
        // Everything new on every computer read at once, as Mail's Mark All as Read; what asks you stays.
        let markRead = ActionItem("Mark All as Read", image: Self.symbol("envelope.open")) { app.markAllRead(on: app.boxes) }
        markRead.isEnabled = !app.boxesToMarkRead(app.boxes).isEmpty
        menu.addItem(markRead)
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
        submenu.addItem(ActionItem("What\u{2019}s New", image: Self.symbol("gift")) { NSWorkspace.shared.open(AppInfo.releases) })
        submenu.addItem(ActionItem("Report a Problem…", image: Self.symbol("exclamationmark.bubble")) { app.reportProblem() })
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
        let accounts = catalog.signedInAccounts
        return switch accounts.count {
        case 0: "Connect an Account"
        case 1: accounts[0].name
        case let count: "\(count) Accounts"
        }
    }
}

/// The window makes the sidebar again whenever anything around it changes (the panel shown or
/// hidden, the focus, a sheet), and SwiftUI took each one for a new sidebar, since its
/// `@AppStorage` keeps a store of its own each time it's made: it worked the whole list out again,
/// every row, at the start of the panel's slide. Equal while what's handed in is (`.equatable()`
/// where it's made); what it reads from the stores and keeps itself still updates it as before.
/// So `==` compares every property the window hands in: one left out here is a change the sidebar
/// never shows.
extension SidebarView: Equatable {
    static func == (lhs: SidebarView, rhs: SidebarView) -> Bool {
        lhs.stagedBots == rhs.stagedBots
    }
}

/// A row that's worked out again only when what it shows changes (`look`), not each time the
/// sidebar is: its content is handed in as a closure, which SwiftUI can't compare.
private struct StillRow<Look: Equatable, Content: View>: View, Equatable {
    let look: Look
    @ViewBuilder let content: () -> Content

    var body: some View { content() }

    static func == (lhs: StillRow, rhs: StillRow) -> Bool { lhs.look == rhs.look }
}

