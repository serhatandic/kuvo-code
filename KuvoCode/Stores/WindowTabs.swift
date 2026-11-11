import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI

/// One of the window's tabs: a session, a new session's draft in a folder (it doesn't exist on
/// the server until its first message), a group chat, or a terminal standing in for a conversation.
enum TabKey: Hashable, Codable {
    case session(String)
    case draft(String)
    case group(String)
    case terminal(String)

    private static let draftPrefix = "draft:"
    private static let groupPrefix = "group:"
    private static let terminalPrefix = "terminal:"

    /// From its written form: `draft:<folder>`, `group:<id>`, `terminal:<id>`, else a session's ID.
    init(_ text: String) {
        if text.hasPrefix(Self.draftPrefix) {
            self = .draft(String(text.dropFirst(Self.draftPrefix.count)))
        } else if text.hasPrefix(Self.groupPrefix) {
            self = .group(String(text.dropFirst(Self.groupPrefix.count)))
        } else if text.hasPrefix(Self.terminalPrefix) {
            self = .terminal(String(text.dropFirst(Self.terminalPrefix.count)))
        } else {
            self = .session(text)
        }
    }

    /// Its written form: how tabs were saved before, and how drafts, notifications and the panel
    /// name what a tab shows.
    var text: String {
        switch self {
        case .session(let id): id
        case .draft(let folder): Self.draftPrefix + folder
        case .group(let id): Self.groupPrefix + id
        case .terminal(let id): Self.terminalPrefix + id
        }
    }

    var sessionID: String? {
        if case .session(let id) = self { return id }
        return nil
    }

    var draftFolder: String? {
        if case .draft(let folder) = self { return folder }
        return nil
    }

    var groupID: String? {
        if case .group(let id) = self { return id }
        return nil
    }

    var isTerminal: Bool {
        if case .terminal = self { return true }
        return false
    }

    init(from decoder: Decoder) throws {
        self.init(try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(text)
    }
}

/// The main window's tabs, and what goes with them: the one in view, the session beside a tab in
/// split view (kept with the tab, as a browser's split tabs are), which half of a split you work
/// in, the tabs you closed (⇧⌘T opens them again), the side panel shown or expanded over the
/// conversation, and an editor (a bot's, a group chat's) shown in the main card in place of the
/// tab. The app has one main window, so one set (`AppModel.tabs`): stores open, swap and close tabs
/// here directly, also while the window is closed, and the window shows them as it opens. The
/// window keeps them with its scene (`saved`, `restore`) and tells it how wide it and its cards are.
@Observable
final class WindowTabs {
    enum Pane { case sessions, conversation, split, changes }

    struct ClosedTab: Equatable {
        var key: TabKey
        var index: Int
        /// The session that was beside it, back with it.
        var beside: String?
        /// The tab it was beside, which it goes back beside if it still can.
        var besideOf: TabKey?
    }

    /// How wide the window's content is, and the widths its cards are dragged to (it sets this):
    /// with what's open, they lay out the cards (`layout`).
    struct Room: Equatable {
        var width = 1200.0
        /// The sidebar's, nil while it's hidden.
        var sessions: Double? = 280
        var changes = 420.0
        var split = 560.0
    }

    /// The open tabs, in order.
    private(set) var keys: [TabKey] = []
    /// The tab in view.
    var selection: TabKey? {
        didSet {
            guard selection != oldValue else { return }
            // Another tab: you're back in its own conversation, not the one beside the last
            // (whatever had the keyboard: the panel or the sidebar keep the last half otherwise).
            if focus == .split { focus = .conversation }
            activeHalf = .conversation
        }
    }
    /// How many times Show Next Tab or Show Previous Tab went round past an end, to the tab at the
    /// other: the tab bar draws each as one more step the same way, not a slide back across it.
    private(set) var loops = 0
    /// Split views, as pairs: a tab and the session beside it. Choosing another tab shows it alone;
    /// the pair comes back with its tab.
    private(set) var pairs: [TabKey: String] = [:] {
        didSet {
            // Another session beside: you work in the tab's until you click into it.
            if let selection, pairs[selection] != oldValue[selection] { activeHalf = .conversation }
        }
    }
    /// The card you clicked or typed in last.
    var focus = Pane.conversation {
        didSet { if focus == .conversation || focus == .split { activeHalf = focus } }
    }
    /// The half of the conversation you worked in last (a click in the panel or the sidebar isn't
    /// working in either): a tab you pick in the panel is its agent's.
    private(set) var activeHalf = Pane.conversation
    /// Tabs you closed, last one last, with where they were.
    private(set) var closedTabs: [ClosedTab] = []
    /// The tab whose split you opened (or swapped) last: there it keeps its place in `givesWay`;
    /// another tab's, met again, gives way first.
    private(set) var keptSplit: TabKey?
    /// Out of room, the side cards give way in this order: the one opened last stays.
    private(set) var givesWay: [PaneLayout.Pane] = [.split, .changes, .sessions]
    /// The side panel is wanted, in the conversation in view: each has its own (`Utilities.isOpen`).
    var showsPanel: Bool { app.utilities.isOpen(in: openView) }
    /// Goes up as the panel's opened or closed (`Utilities.openTurns`), for it to slide.
    var panelTurns: Int { app.utilities.openTurns }
    /// The sidebar is wanted.
    private(set) var showsSidebar = true
    /// The panel over the conversation, for room.
    var panelExpanded = false
    var room = Room()
    /// Making or changing a bot, or a group chat, in the main card while it's open.
    var botEditor: BotEditorRequest?
    var groupEditor: GroupEditorRequest?
    /// New Project or Edit Project, in a popup over the window while it's open.
    var projectEditor: ProjectEditorRequest?
    /// Goes up to put the cursor in a new session's composer.
    private(set) var draftFocus = 0
    /// Goes up to put the cursor in the group chat in view's composer.
    private(set) var groupFocus = 0
    /// The window put back what its scene kept, once this launch.
    @ObservationIgnored private(set) var isRestored = false
    /// Where the tabs are kept for the next launch (`keep`). The scene's own storage isn't enough:
    /// macOS drops it when you quit, unless "Close windows when quitting an application" is off,
    /// and the window came back on the latest session, after a moment of the welcome. None while
    /// testing, so one test's tabs aren't the next one's; a test sets its own.
    @ObservationIgnored var keptIn: UserDefaults? = AppInfo.isHostingTests ? nil : .standard
    static let keptKey = "windowTabs"

    private unowned let app: AppModel
    private var workspace: Workspace { app.workspace }
    private var terminals: MainTerminals { app.mainTerminals }

    init(app: AppModel) {
        self.app = app
    }

    // MARK: What's in view

    /// The session of the tab in view, if it's a session's.
    var sessionID: String? { selection?.sessionID }
    /// The group chat in view.
    var groupID: String? { selection?.groupID }
    /// The folder of the new session in view.
    var draftDirectory: String? { selection?.draftFolder }

    /// Open Beside, while a session can open beside the tab in view: it's a session's (not a
    /// draft or a group chat), and there.
    var besideOpener: ((String) -> Void)? {
        guard let sessionID, workspace.session(sessionID) != nil else { return nil }
        return { [weak self] in self?.openBeside($0) }
    }

    /// The session in split view, while it's another than the one in view (and there).
    var splitModel: SessionModel? {
        guard let selection, let beside = pairs[selection], beside != sessionID, workspace.session(beside) != nil else { return nil }
        return workspace.model(for: beside)
    }

    /// How wide each card is in the window `available` wide (the room's, by default). Out of room,
    /// a split you didn't just open (one restored, or met again on its tab) gives way first.
    func layout(available: Double? = nil) -> PaneLayout {
        PaneLayout(
            available: available ?? room.width,
            sessions: room.sessions,
            changes: showsPanel ? room.changes : nil,
            split: splitModel == nil ? nil : room.split,
            givesWay: selection != nil && selection == keptSplit ? givesWay : [.split] + givesWay.filter { $0 != .split }
        )
    }

    /// The split in view shows: there's room for it, and it didn't give way.
    private var showsBeside: Bool { layout().split != nil }

    /// The session beside the tab's, while it shows: with room for it in the window, and not under
    /// the expanded panel. One that gave way is out of view: not read, nor working there.
    var besideID: String? {
        guard let splitModel, showsBeside, !(showsPanel && panelExpanded) else { return nil }
        return splitModel.id
    }

    /// The last half you worked in is the one beside: the panel is its, and the commands go to it.
    /// It stays so while the expanded panel covers it (the panel is still its), not once it gave
    /// way for want of room.
    var worksBeside: Bool {
        activeHalf == .split && splitModel != nil && showsBeside
    }

    /// The session beside you work in, if you do.
    var workedBesideID: String? { worksBeside ? splitModel?.id : nil }

    /// The sessions on screen: the tab's, and the one beside it.
    var sessionsInView: [String] { [sessionID, besideID].compactMap(\.self) }

    /// The sessions you can see now, which count as read: none under Settings, and not the tab's
    /// while a bot's or group chat's editor takes its place or the expanded panel covers it.
    var sessionsSeen: [String] {
        guard !app.showsSettings else { return [] }
        let covered = botEditor != nil || groupEditor != nil || (showsPanel && panelExpanded)
        return [covered ? nil : sessionID, besideID].compactMap(\.self)
    }

    var activeModel: SessionModel? { sessionID.flatMap(workspace.model(for:)) }

    /// The session you're working in: the one beside, once you've clicked into it (and while you
    /// use the panel or the sidebar after, as the panel stays its). The menus' commands go to it.
    var focusedModel: SessionModel? { worksBeside ? splitModel : activeModel }

    /// The tab in view's folder.
    var activeDirectory: String? {
        activeModel?.session.location.directory ?? draftDirectory ?? selection.flatMap { terminals.entry($0.text)?.directory }
    }

    /// The folder of the session you're working in: Run, a new terminal and Open Quickly go there.
    var focusedDirectory: String? {
        worksBeside ? splitModel?.session.location.directory ?? activeDirectory : activeDirectory
    }

    /// The computer a tab is on (a session's, a bot's, a group chat's, a draft's, a terminal's);
    /// nil for one that's on none known. The sidebar's page slides to it as the tab comes into view.
    func box(of key: TabKey) -> SidebarBox? {
        switch key {
        case .draft(let folder):
            return SidebarBox(directory: folder)
        case .session(let id):
            if let session = workspace.session(workspace.root(of: id)) { return SidebarBox(directory: session.location.directory) }
            if let bot = app.bots.list.first(where: { $0.sessionID == id }) { return SidebarBox(machine: bot.machine) }
            return nil
        case .group(let id):
            guard app.chats.group(id) != nil else { return nil }
            return SidebarBox(machine: app.chats.machine(of: id))
        case .terminal:
            return terminals.entry(key.text).map { SidebarBox(directory: $0.directory) }
        }
    }

    /// A folder when it's a project's: not the chats' folder or a bot's own.
    static func project(_ directory: String?) -> String? {
        directory.flatMap { Workspace.isChat($0) || Workspace.isBotFolder($0) ? nil : $0 }
    }

    /// Where the panel's Add to Message goes: the session you work in.
    var messageTarget: TabKey? { workedBesideID.map(TabKey.session) ?? selection }

    /// What the side panel follows: the conversations in view, the one you work in, its place,
    /// and this Mac's bots in view (a bot's conversation, or a group chat's).
    /// What says whether the panel is open in the conversation in view (`Utilities.openKey`), as
    /// the window has it now.
    private var openView: Utilities.InView {
        Utilities.InView(session: sessionID, group: groupID.map { TabKey.group($0).text },
                         draft: sessionID == nil && groupID == nil ? selection?.text : nil, tabPanel: sessionID.map(app.utilities.panelOf))
    }

    var inView: Utilities.InView {
        let groups = app.chats
        let bots = app.bots
        let botsInView = groupID.flatMap { groups.group($0)?.members.compactMap { bots.bot($0) } } ?? [bots.bot(forSession: sessionID)].compactMap { $0 }
        return Utilities.InView(
            session: sessionID,
            beside: besideID,
            group: groupID.map { TabKey.group($0).text },
            worksBeside: workedBesideID,
            place: focusedDirectory.flatMap(RemoteFolder.machine(of:)),
            bots: Set(botsInView.filter { $0.machine == nil }.map(\.id)),
            draft: sessionID == nil && groupID == nil ? selection?.text : nil,
            panel: (workedBesideID ?? sessionID).map(app.utilities.panelOf),
            tabPanel: sessionID.map(app.utilities.panelOf)
        )
    }

    // MARK: Opening and closing

    /// Shows a tab, opening it next to the current one if needed, out of Settings and any editor.
    /// The session beside a tab is the one you get, by itself: it comes out of that pair into a tab
    /// of its own next to it (side by side is only for when you ask), unless the pair is in view,
    /// where you work in it. A conversation whose subagent is open in its tab comes back in that tab.
    func open(_ key: TabKey) {
        var pair = pairs.first { $0.value == key.sessionID && keys.contains($0.key) }?.key
        if let tab = pair, !(tab == selection && showsBeside) {
            closeBeside(tab)
            pair = nil
        }
        if pair == nil, !keys.contains(key), let id = key.sessionID, workspace.session(id) != nil,
           let subagent = keys.first(where: { $0.sessionID.map { workspace.session($0) == nil && workspace.root(of: $0) == id } ?? false }) {
            return swap(subagent, for: key)
        }
        let key = pair ?? key
        if !keys.contains(key) {
            let index = selection.flatMap { keys.firstIndex(of: $0) }.map { $0 + 1 } ?? keys.count
            keys.insert(key, at: index)
        }
        withAnimation(.ui) {
            selection = key
            focus = pair != nil && showsBeside ? .split : .conversation
            app.showsSettings = false
            botEditor = nil
            groupEditor = nil
        }
    }

    /// A tab picked in the sidebar (a session, a bot, a group chat, a terminal, a search's find):
    /// in view, and you work in its conversation, its composer with the keyboard, as a tab picked
    /// in the tab bar.
    func choose(_ key: TabKey) {
        open(key)
        typeInConversation()
    }

    /// A subagent's conversation (or, from one, the conversation above it) in place of the
    /// conversation in view, in its tab: the way back at its top swaps them again, and the
    /// sidebar keeps the conversation it works for picked. With no conversation in view, a tab of
    /// its own.
    func openInPlace(_ id: String) {
        guard let current = selection, current.sessionID != nil else { return open(.session(id)) }
        swap(current, for: .session(id))
    }

    private func swap(_ old: TabKey, for new: TabKey) {
        guard old != new, let index = keys.firstIndex(of: old) else { return open(new) }
        var keys = keys
        keys[index] = new
        // One tab of it is enough.
        if let other = keys.indices.first(where: { $0 != index && keys[$0] == new }) { keys.remove(at: other) }
        if let beside = pairs[old] {
            pairs[old] = nil
            pairs[new] = beside
        }
        withAnimation(.ui) {
            self.keys = keys
            selection = new
            focus = .conversation
            app.showsSettings = false
            botEditor = nil
            groupEditor = nil
        }
    }

    /// Opens a tab at the end, without showing it: for you to find.
    func add(_ key: TabKey) {
        guard !isOpen(key) else { return }
        keys.append(key)
    }

    /// Closes a tab; one you close (rather than a deleted session's) can be reopened.
    func close(_ key: TabKey, remember: Bool = true) {
        guard let index = keys.firstIndex(of: key) else { return }
        var keys = keys
        keys.remove(at: index)
        Analytics.shared.sessionEnded(key.text)
        let beside = pairs[key]
        if let beside {
            Analytics.shared.sessionEnded(beside)
            pairs[key] = nil
        }
        if remember && !key.isTerminal { rememberClosed([ClosedTab(key: key, index: index, beside: beside)]) }
        terminals.close(key.text)
        // A terminal's tab doesn't come back: its panel goes with it.
        if key.isTerminal { app.utilities.closeTabs(of: key.text) }
        withAnimation(.ui) {
            self.keys = keys
            if selection == key {
                selection = keys.indices.contains(index) ? keys[index] : keys.last
            }
        }
    }

    /// ⌘W outside Settings: closes the tab in view. False when no tab is open, for the window to
    /// close, as a browser's does; with tabs open but none in view (the last one on the computer the
    /// sidebar shows was deleted), nothing goes.
    func closeInView() -> Bool {
        guard let selection else { return !keys.isEmpty }
        close(selection)
        return true
    }

    /// Closes every tab but `key`, or all of them when it's nil.
    func closeAll(except key: TabKey?) {
        // Reopened last first, so the leftmost comes back last.
        rememberClosed(keys.enumerated().filter { $0.element != key && !$0.element.isTerminal }.map { ClosedTab(key: $0.element, index: $0.offset, beside: pairs[$0.element]) }.reversed())
        for closed in keys where closed != key {
            Analytics.shared.sessionEnded(closed.text)
            terminals.close(closed.text)
            if closed.isTerminal { app.utilities.closeTabs(of: closed.text) }
            if let beside = pairs[closed] { Analytics.shared.sessionEnded(beside) }
        }
        withAnimation(.ui) {
            keys = keys.filter { $0 == key }
            pairs = pairs.filter { $0.key == key }
            selection = key
        }
    }

    /// No tabs, and none to reopen: the welcome card (a demo's).
    func clear() {
        keys = []
        pairs = [:]
        selection = nil
    }

    private func rememberClosed(_ closed: [ClosedTab]) {
        closedTabs.append(contentsOf: closed)
        if closedTabs.count > 50 { closedTabs.removeFirst(closedTabs.count - 50) }
    }

    /// In a tab, or beside one.
    func isOpen(_ key: TabKey) -> Bool {
        keys.contains(key) || key.sessionID.map { pairs.values.contains($0) } == true
    }

    /// Not open again already, and not a session deleted since.
    private func canReopen(_ closed: ClosedTab) -> Bool {
        guard !isOpen(closed.key) else { return false }
        switch closed.key {
        case .draft: return true
        case .session(let id): return workspace.session(id) != nil || workspace.subSession(id) != nil
        case .group(let id): return app.chats.group(id) != nil
        case .terminal: return false
        }
    }

    var canReopenTab: Bool { closedTabs.contains(where: canReopen) }

    /// Opens the tab closed last, where it was, skipping sessions deleted since. A pair comes back
    /// as a pair, and a session closed from beside a tab goes back beside it.
    func reopenClosedTab() {
        while let closed = closedTabs.popLast() {
            guard canReopen(closed) else { continue }
            var keys = keys
            var pairs = pairs
            let shown: TabKey
            if let partner = closed.besideOf, keys.contains(partner), pairs[partner] == nil, let id = closed.key.sessionID {
                pairs[partner] = id
                shown = partner
            } else {
                keys.insert(closed.key, at: min(closed.index, keys.count))
                if let beside = closed.beside, !isOpen(.session(beside)), workspace.session(beside) != nil { pairs[closed.key] = beside }
                shown = closed.key
            }
            withAnimation(.ui) {
                self.keys = keys
                self.pairs = pairs
                selection = shown
                focus = .conversation
            }
            return
        }
    }

    /// Settings' tabs aside: the next or previous tab, around the ends.
    func cycle(by offset: Int) {
        guard !keys.isEmpty else { return }
        // None in view: the first, going on, or the last, going back.
        guard let index = selection.flatMap({ keys.firstIndex(of: $0) }) else {
            withAnimation(.ui) { selection = offset > 0 ? keys.first : keys.last }
            return
        }
        withAnimation(.ui) {
            selection = keys[(index + offset + keys.count) % keys.count]
            if !keys.indices.contains(index + offset), keys.count > 1 { loops += 1 }
        }
    }

    /// A tab picked in the tab bar: in view, and you work in its conversation, wherever you were
    /// working before (the sidebar, the panel): its composer has the keyboard, so what you type
    /// goes where the window shows you working.
    func pick(_ key: TabKey) {
        selection = key
        focusComposer(key.text)
        focus = .conversation
    }

    /// ⌘1 to ⌘8 show that tab, ⌘9 the last.
    func show(number: Int) {
        guard !keys.isEmpty else { return }
        let index = number == 9 ? keys.count - 1 : number - 1
        if keys.indices.contains(index) { open(keys[index]) }
    }

    /// With nothing open, pick up where you left off.
    func startIfEmpty() {
        guard workspace.isLoaded, keys.isEmpty, let latest = workspace.projects.first?.sessions.first else { return }
        open(.session(latest.id))
    }

    /// Deleted sessions lose their tabs; the one beside a deleted tab's session takes its tab.
    /// Pairs whose tab or session beside is gone end; a terminal's tab goes with its shell.
    func dropClosed() {
        guard workspace.isLoaded else { return }
        let known = Set(workspace.sessions.map(\.id))
        // A machine's sessions wait for it to connect; a sub-session stays while its session's
        // list has it.
        func isGone(_ id: String) -> Bool {
            guard !known.contains(id), workspace.waitingMachine(for: id) == nil, workspace.subSession(id) == nil else { return false }
            // A sub-session not listed yet stays while the session it's from does.
            if let parent = workspace.parent(of: id), parent != id { return isGone(parent) }
            return true
        }
        for key in keys {
            switch key {
            case .draft: continue
            // A terminal's tab stays while its shell runs; one restored at launch has none.
            case .terminal: if terminals.entry(key.text) != nil { continue }
            // A group chat's tab stays as long as the chat does.
            case .group(let id): if app.chats.group(id) != nil { continue }
            case .session(let id):
                guard isGone(id) else { continue }
                if let beside = pairs[key], !isGone(beside), !keys.contains(.session(beside)) {
                    pairs[key] = nil
                    if let index = keys.firstIndex(of: key) { keys[index] = .session(beside) }
                    if selection == key { selection = .session(beside) }
                    continue
                }
            }
            // The tab in view gone: the nearest on the computer whose page the sidebar shows takes
            // its place, or none. A deletion never takes the sidebar, which follows the tab in
            // view, to another computer's page.
            if selection == key {
                let next = nearest(to: key, on: app.boxInView)
                withAnimation(.ui) { selection = next }
            }
            close(key, remember: false)
        }
        let open = Set(keys)
        let kept = pairs.filter { open.contains($0.key) && !open.contains(.session($0.value)) && !isGone($0.value) }
        if kept != pairs { pairs = kept }
        // A selection that isn't one of the tabs (its session went while the app was closed)
        // shows nothing; show the last tab instead.
        if let selection, !keys.contains(selection) { self.selection = keys.last }
    }

    /// The open tab nearest `key` that's on `box`: the first after it, else the last before it.
    private func nearest(to key: TabKey, on box: SidebarBox) -> TabKey? {
        guard let index = keys.firstIndex(of: key) else { return nil }
        return (keys[(index + 1)...] + keys[..<index].reversed()).first { self.box(of: $0) == box }
    }

    // MARK: Sessions that carry on, start or begin

    /// A session that carries on in another (moved to the coding agents): the new one takes its
    /// tab, or its place beside one, in view if the old one was. False when no tab has it.
    @discardableResult
    func swap(from old: String, to id: String) -> Bool {
        if let tab = pairs.first(where: { $0.value == old })?.key {
            // The same conversation, carrying on: you still work in it if you did.
            let half = activeHalf
            pairs[tab] = id
            activeHalf = half
            return true
        }
        let key = TabKey.session(old)
        guard let index = keys.firstIndex(of: key) else { return false }
        let half = activeHalf, focused = focus
        if let beside = pairs[key] {
            pairs[key] = nil
            pairs[.session(id)] = beside
        }
        keys[index] = .session(id)
        if keptSplit == key { keptSplit = .session(id) }
        if selection == key {
            selection = .session(id)
            (focus, activeHalf) = (focused, half)
        }
        return true
    }

    /// A draft's first message made its session: the session takes the draft's tab and stays in
    /// view; more attempts open at the end.
    func draftSent(_ draft: TabKey, as id: String) {
        if let index = keys.firstIndex(of: draft) {
            app.utilities.adoptDraft(draft.text, as: id)
            keys[index] = .session(id)
            selection = .session(id)
        } else if !keys.contains(.session(id)) {
            keys.append(.session(id))
        }
    }

    // MARK: Split view

    /// Shows `id` beside the tab in view, the two as one tab. Its own tab, if it had one, goes into
    /// the pair; one beside before gets its tab back, next to it. Its composer takes the keyboard,
    /// if there's room for it: the menus' commands go to it.
    func openBeside(_ id: String) {
        guard let main = selection, let mainID = main.sessionID, mainID != id, workspace.session(mainID) != nil, workspace.session(id) != nil else { return }
        var pairs = pairs
        var keys = keys
        let key = TabKey.session(id)
        // It's in no other pair, nor has one of its own.
        if let other = pairs.removeValue(forKey: key), !keys.contains(.session(other)) {
            keys.insert(.session(other), at: (keys.firstIndex(of: key) ?? keys.count - 1) + 1)
        }
        for (tab, value) in pairs where value == id { pairs[tab] = nil }
        if let previous = pairs[main], !keys.contains(.session(previous)) {
            keys.insert(.session(previous), at: (keys.firstIndex(of: main) ?? keys.count - 1) + 1)
        }
        keys.removeAll { $0 == key }
        pairs[main] = id
        withAnimation(.ui) {
            self.keys = keys
            self.pairs = pairs
            keep(.split)
            keptSplit = main
        }
        if showsBeside { focus = .split }
    }

    /// Close Split View: the two go back to tabs of their own, the one beside next to `tab`.
    func closeBeside(_ tab: TabKey) {
        guard let beside = pairs[tab] else { return }
        var keys = keys
        if !keys.contains(.session(beside)) { keys.insert(.session(beside), at: (keys.firstIndex(of: tab) ?? keys.count - 1) + 1) }
        withAnimation(.ui) {
            self.keys = keys
            pairs[tab] = nil
        }
    }

    /// Closes the session beside `tab`'s (its half of the tab): ⇧⌘T brings it back beside it.
    func closeBesideTab(_ tab: TabKey) {
        guard let beside = pairs[tab] else { return }
        Analytics.shared.sessionEnded(beside)
        rememberClosed([ClosedTab(key: .session(beside), index: (keys.firstIndex(of: tab) ?? keys.count - 1) + 1, besideOf: tab)])
        withAnimation(.ui) { pairs[tab] = nil }
    }

    /// The two in `tab`'s pair trade places, the tab staying where it is.
    func swapBeside(_ tab: TabKey) {
        guard let other = pairs[tab], let tabID = tab.sessionID else { return }
        let otherKey = TabKey.session(other)
        var pairs = pairs
        pairs[tab] = nil
        pairs[otherKey] = tabID
        // One tab for the two: a tab of its own it had goes.
        var keys = keys.filter { $0 != otherKey }
        if let index = keys.firstIndex(of: tab) { keys[index] = otherKey }
        self.keys = keys
        self.pairs = pairs
        if keptSplit == tab { keptSplit = otherKey }
        if selection == tab { selection = otherKey }
    }

    /// The pair in view trades places.
    func swapSplit() {
        if let selection { swapBeside(selection) }
    }

    // MARK: The panel and the cards

    /// Shows or hides the panel; showing one that's wanted but out of room makes room for it, as
    /// the one opened last.
    func showPanel(_ shows: Bool = true) {
        app.utilities.setOpen(shows, in: openView)
        if shows { keep(.changes) }
    }

    /// Shows or hides the sidebar, by its button or ⌘0; showing it when it's wanted but out of
    /// room makes room for it, as the one opened last. Either way you're back typing in the
    /// conversation you work in, wherever the keyboard was, unless something covers it.
    func showSidebar(_ shows: Bool) {
        showsSidebar = shows
        if shows { keep(.sessions) }
        typeInConversation()
    }

    /// The keyboard in the composer of the conversation you work in, unless something covers it
    /// (Settings, the expanded panel, a bot's or group chat's editor).
    private func typeInConversation() {
        guard !app.showsSettings, !(showsPanel && panelExpanded), botEditor == nil, groupEditor == nil else { return }
        focusComposer()
    }

    /// What you open last keeps its place when the window is short of room.
    func keep(_ pane: PaneLayout.Pane) {
        givesWay.removeAll { $0 == pane }
        givesWay.append(pane)
    }

    /// Makes a project, or changes one, in a popup over what's in the window. One open already
    /// stays, with what's typed in it: a shortcut or a session opened from a notification
    /// doesn't take its place.
    func openProjectEditor(_ request: ProjectEditorRequest) {
        guard projectEditor == nil else { return }
        projectEditor = request
    }

    /// Makes a bot (from a shared one's `recipe`, if given), or changes `bot`, in the main card. A
    /// new one starts on the box in view in the sidebar.
    func openBotEditor(bot: Bot?, recipe: BotRecipe? = nil) {
        let machine = bot == nil ? app.boxInView.machine : nil
        withAnimation(.ui) {
            panelExpanded = false
            app.showsSettings = false
            groupEditor = nil
            botEditor = BotEditorRequest(bot: bot, recipe: recipe, machine: machine)
        }
        focus = .conversation
    }

    /// Makes a group chat, or changes `group`, in the main card. A new one starts on the box in
    /// view in the sidebar.
    func openGroupEditor(group: BotGroup?) {
        let machine = group == nil ? app.boxInView.machine : nil
        withAnimation(.ui) {
            panelExpanded = false
            app.showsSettings = false
            botEditor = nil
            groupEditor = GroupEditorRequest(group: group, machine: machine)
        }
        focus = .conversation
    }

    // MARK: New sessions and terminals

    /// A new session in `directory`, or the project in view, or the latest one; with no project
    /// at all, a chat. A bot's own folder isn't a project: from its conversation, the latest one.
    /// `conversation`: one, even in a project whose sessions open its terminal command.
    func newSession(in directory: String?, conversation: Bool = false) {
        let inView = activeDirectory.map(workspace.projectDirectory).flatMap { Workspace.isBotFolder($0) ? nil : $0 }
        let directory = directory ?? inView ?? workspace.projects.first?.directory ?? Workspace.chatsFolder
        // A project that has a terminal command for its sessions opens that, not a conversation.
        if !conversation, let command = workspace.settings[workspace.projectDirectory(directory)]?.terminal {
            openTerminalTab(command: command, in: directory)
            return
        }
        open(.draft(directory))
    }

    /// A terminal as a tab, in the folder of the tab in view (or the one given), typing `command`
    /// in it. Without one, a plain shell: where you start `omp` or any agent yourself.
    func openTerminalTab(command: String?, in directory: String? = nil) {
        // A project's folder, not a bot's own or the chats' (their agents work there).
        let directory = directory ?? Self.project(activeDirectory) ?? NSHomeDirectory()
        Analytics.shared.track("terminal_tab_opened", ["kind": command == nil ? "shell" : "project"])
        let key = terminals.open(in: directory, command: command, environment: app.shellEnvironment)
        // Add to Message in its right-click menu: a new session in its folder, with what's selected.
        terminals.entry(key)?.session.addToMessage = { [weak self] in self?.addToMessage($0) }
        open(TabKey(key))
    }

    // MARK: Adding to a message

    /// Adds a file's lines ("@src/App.swift:12-20") or a terminal's output to what's in the
    /// composer of the session you work in, and puts the cursor there.
    func addToMessage(_ addition: String) {
        composerForAdding()
        guard let key = messageTarget?.text else { return }
        var text = Drafts.shared[key].text
        let isBlock = addition.hasPrefix("```")
        if !text.isEmpty {
            if isBlock { if !text.hasSuffix("\n") { text += "\n" } } else if !(text.last?.isWhitespace ?? true) { text += " " }
        }
        Drafts.shared[key].text = text + addition + (isBlock ? "\n" : " ")
        focusComposer(key)
    }

    /// Attaches files to the message in the composer of the session you work in, and puts the
    /// cursor there.
    func attachToMessage(_ files: [URL]) {
        composerForAdding()
        guard let key = messageTarget?.text else { return }
        Drafts.shared[key].files += files.filter { !Drafts.shared[key].files.contains($0) }
        focusComposer(key)
    }

    /// Puts the cursor in the composer of the conversation you work in (the session beside, if
    /// you work there).
    func focusComposer() {
        if let key = messageTarget?.text { focusComposer(key) }
    }

    private func focusComposer(_ key: String) {
        let tab = TabKey(key)
        if tab.draftFolder != nil {
            draftFocus += 1
        } else if tab.groupID != nil {
            groupFocus += 1
        } else if let model = workspace.model(for: key) {
            model.focusComposer()
        } else {
            // No composer to type in (a terminal's tab): the keyboard stays, and so does the card.
            return
        }
        focus = worksBeside ? .split : .conversation
    }

    /// With no composer in view to add to (no tab open, or a terminal's): a new conversation, in
    /// the terminal's folder if one's in view, never a terminal (which would start the project's
    /// command, and not have the text).
    private func composerForAdding() {
        guard selection == nil || messageTarget?.isTerminal == true else { return }
        newSession(in: selection.flatMap { terminals.entry($0.text)?.directory }, conversation: true)
    }

    // MARK: Keeping them with the window

    /// What the window keeps with its scene, for the next launch.
    struct Saved: Codable, Equatable {
        struct Pair: Codable, Equatable {
            var tab: TabKey
            var beside: String
        }

        /// A conversation's panel, open or closed, by `Utilities.openKey`.
        struct Panel: Codable, Equatable {
            var key: String
            var open: Bool
        }

        var tabs: [TabKey] = []
        var selection: TabKey?
        var pairs: [Pair] = []
        /// The panel open in the conversation in view; before each had its own, in the window.
        var showsPanel = false
        /// Each conversation's panel, the one in view last last; empty before each had its own.
        var panels: [Panel] = []
        /// Nil: kept before the sidebar was kept here (in scene storage of its own).
        var showsSidebar: Bool?

        init(tabs: [TabKey] = [], selection: TabKey? = nil, pairs: [Pair] = [], showsPanel: Bool = false, panels: [Panel] = [], showsSidebar: Bool? = nil) {
            (self.tabs, self.selection, self.pairs, self.showsPanel, self.panels, self.showsSidebar) = (tabs, selection, pairs, showsPanel, panels, showsSidebar)
        }

        /// What's missing (kept by a version that had less, or more) is as it starts.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            tabs = try container.decodeIfPresent([TabKey].self, forKey: .tabs) ?? []
            selection = try container.decodeIfPresent(TabKey.self, forKey: .selection)
            pairs = try container.decodeIfPresent([Pair].self, forKey: .pairs) ?? []
            showsPanel = try container.decodeIfPresent(Bool.self, forKey: .showsPanel) ?? false
            panels = try container.decodeIfPresent([Panel].self, forKey: .panels) ?? []
            showsSidebar = try container.decodeIfPresent(Bool.self, forKey: .showsSidebar)
        }

        var text: String {
            (try? JSONEncoder().encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        }
    }

    /// What the window keeps of them.
    var snapshot: Saved {
        Saved(tabs: keys, selection: selection, pairs: pairs.sorted { $0.key.text < $1.key.text }.map { Saved.Pair(tab: $0.key, beside: $0.value) }, showsPanel: showsPanel,
              panels: app.utilities.keptPanels.map { Saved.Panel(key: $0.key, open: $0.open) }, showsSidebar: showsSidebar)
    }

    /// The same, as JSON.
    var saved: String { snapshot.text }

    /// Keeps the tabs as they are now for the next launch.
    func keep() {
        let saved = saved
        if keptIn?.string(forKey: Self.keptKey) != saved { keptIn?.set(saved, forKey: Self.keptKey) }
    }

    /// Before the tabs were kept as JSON: the tabs' keys a line each, the one in view, and the
    /// pairs a `<tab>=<session>` line each, in scene storage of their own; and the sidebar, kept
    /// there until it was kept with them.
    struct Older {
        var tabs = ""
        var selection: String?
        var pairs = ""
        var showsPanel = false
        var showsSidebar = true

        var saved: Saved {
            let pairs = pairs.split(separator: "\n").compactMap { line -> Saved.Pair? in
                let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
                return parts.count == 2 ? Saved.Pair(tab: TabKey(parts[0]), beside: parts[1]) : nil
            }
            return Saved(tabs: tabs.split(separator: "\n").map { TabKey(String($0)) }, selection: selection.map(TabKey.init), pairs: pairs, showsPanel: showsPanel)
        }
    }

    /// Puts back what the window kept (`keep`'s, else its scene's `text`, else the older way),
    /// once a launch. Tabs opened before (a folder opened with Kuvo Code as it launched) stay, the
    /// last of them in view.
    func restore(_ text: String, older: Older) {
        guard !isRestored else { return }
        isRestored = true
        let text = keptIn?.string(forKey: Self.keptKey) ?? text
        let saved = text.isEmpty ? older.saved : (try? JSONDecoder().decode(Saved.self, from: Data(text.utf8))) ?? Saved()
        let opened = keys
        var restored: [TabKey] = []
        for key in saved.tabs where !restored.contains(key) { restored.append(key) }
        let all = restored + opened.filter { !restored.contains($0) }
        var pairs: [TabKey: String] = [:]
        // Each session in one place: in a pair at most once, never also in a tab of its own.
        for pair in saved.pairs where restored.contains(pair.tab) && pairs[pair.tab] == nil && !pairs.values.contains(pair.beside)
            && !all.contains(.session(pair.beside)) && !self.pairs.values.contains(pair.beside) {
            pairs[pair.tab] = pair.beside
        }
        keys = all
        self.pairs = pairs.merging(self.pairs) { kept, _ in kept }
        if selection == nil { selection = saved.selection.flatMap { keys.contains($0) ? $0 : nil } ?? keys.last }
        // Each conversation's panel as it was; a version before kept one for the window, which
        // they all start as.
        app.utilities.restoreOpen(saved.panels.map { ($0.key, $0.open) }, last: saved.showsPanel, in: openView)
        showsSidebar = saved.showsSidebar ?? older.showsSidebar
    }
}
