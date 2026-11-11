import ClientDesign
import ClientSessions
import ClientText
import SwiftUI
import UniformTypeIdentifiers

/// The panel's Work Queue: the conversation's items (a lead's with those of the sessions it
/// oversees; a session's with what it works on that's someone else's, under Working on), or every
/// item. Narrow, one column: In progress with what's being done, Next in its order, the other
/// categories as counts that open; an item opens over the list. Wide (as the expanded
/// panel is), two panes: filter chips over the list, the item open beside it. You reorder (drag,
/// or Move Up and Down), move between categories, delete and bring back; agents write what items
/// say, through their tools.
struct WorkQueuePanel: View {
    let utilities: Utilities
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme
    @State private var width: CGFloat = 0
    /// The categories opened in the narrow list (Later, Parked… show as counts until then).
    @State private var unfolded: Set<String> = []
    /// A category being named: a new one (nil), or one being renamed.
    @State private var naming: WorkCategory??
    @State private var name = ""
    @State private var isSearching = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    /// Each row's height, for where a drop over it turns from before to after.
    @State private var rowHeights: [String: CGFloat] = [:]

    /// From this width the panel has room for two panes.
    static let twoPanes: CGFloat = 620

    private var store: WorkQueues { app.workQueues }
    private var panel: String { utilities.panelKey }
    private var box: String { utilities.queueBox }
    private var owner: String? { utilities.queueOwner }

    private var scope: WorkQueues.Scope {
        owner == nil ? .all : store.scopes[panel] ?? .own
    }

    private var key: WorkQueues.Key { store.key(for: utilities) }

    private var view: WorkQueueView? { store.views[key] }

    private var filter: WorkQueue.Filter { store.filters[panel] ?? .all }

    private var showsDeleted: Bool { store.filters[panel] == .category(Self.deleted) }
    static let deleted = "deleted"

    private var opened: WorkQueues.Opened? {
        guard let opened = store.opened[panel], opened.box == box else { return nil }
        return opened
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .overlay(alignment: .bottom) { bars }
            // Two panes folding to one: back to the list, not to the item that was open beside it.
            .onChange(of: width >= Self.twoPanes) { wasWide, isWide in
                if wasWide, !isWide, store.opened[panel]?.id != nil { store.opened[panel] = nil }
            }
            .alert((naming ?? nil).map { "Rename “\($0.name)”" } ?? "New Category", isPresented: Binding { naming != nil } set: { if !$0 { naming = nil } }) {
                TextField("Name", text: $name)
                Button(naming??.id == nil ? "Add" : "Rename") {
                    let given = name.trimmingCharacters(in: .whitespacesAndNewlines)
                    let category = naming ?? nil
                    naming = nil
                    guard !given.isEmpty else { return }
                    Task {
                        if let category { await store.renameCategory(category.id, to: given, on: box) } else { await store.addCategory(given, on: box) }
                    }
                }
                Button("Cancel", role: .cancel) { naming = nil }
            } message: {
                Text(naming??.id == nil ? "Every conversation’s queue has it, between Later and Parked." : "Its items stay in it.")
            }
    }

    /// Rename and Remove for a category of your own (the built-in ones stay as they are).
    @HeldRows private func categoryMenu(_ id: String?, count: Int, adds: Bool = true) -> [HeldRow] {
        if let id, let category = view?.categories.first(where: { $0.id == id }), !category.builtIn {
            HeldRow.button("Rename “\(category.name)”…") {
                name = category.name
                naming = .some(category)
            }
            HeldRow.button("Remove “\(category.name)”", role: .destructive, disabled: count > 0, help: count > 0 ? "Move its items out first." : nil) {
                Task { await store.removeCategory(category.id, on: box) }
            }
            if adds { HeldRow.divider }
        }
        if adds {
            HeldRow.button("New Category…") {
                name = ""
                naming = .some(nil)
            }
        }
    }

    @ViewBuilder private var content: some View {
        if store.older.contains(box) {
            ContentUnavailableView("No Work Queue Here Yet", systemImage: "checklist", description: Text("This computer’s Kuvo Code is older. Update it to keep work items here."))
        } else if let view {
            let shown = searched(view)
            if width >= Self.twoPanes {
                VStack(spacing: 0) {
                    header(view)
                    chips(shown)
                    Divider().padding(.horizontal, 14)
                    HStack(spacing: 0) {
                        list(shown, wide: true)
                            .frame(width: min(380, max(280, width * 0.44)))
                        Divider().padding(.vertical, 12)
                        detailPane(view)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            } else if let opened {
                WorkItemPage(opened: opened, view: view, utilities: utilities, back: { store.opened[panel] = nil })
                    .id(opened)
            } else {
                VStack(spacing: 0) {
                    header(view)
                    Divider().padding(.horizontal, 14)
                    list(shown, wide: false)
                }
            }
        } else if let failure = store.failures[key] {
            ContentUnavailableView("Can’t Read the Work Queue", systemImage: "exclamationmark.triangle", description: Text(failure))
        } else {
            Spinner(size: 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// The view with only the items the search finds (by title, or by number).
    private func searched(_ view: WorkQueueView) -> WorkQueueView {
        let words = query.trimmingCharacters(in: .whitespaces)
        guard isSearching, !words.isEmpty else { return view }
        let number = Int(words.trimmingCharacters(in: CharacterSet(charactersIn: "#")))
        var found = view
        // (An issue by its name too: "app#12", "#12".)
        let keeps = { (item: WorkItem) in
            item.title.localizedStandardContains(words) || (number != nil && item.source == nil && item.number == number)
                || (item.source.map { $0.shownName.localizedStandardContains(words) || $0.ref.localizedStandardContains(words) } ?? false)
        }
        found.items = view.items.filter(keeps)
        found.removed = view.removed.filter(keeps)
        return found
    }

    // MARK: Header

    /// "Work Queue", whose (this conversation's, or every one's), how many are open, search and
    /// categories.
    private func header(_ view: WorkQueueView) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "checklist")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                if owner != nil {
                    Menu {
                        Picker("Show", selection: Binding(get: { scope }, set: { store.scopes[panel] = $0 })) {
                            Text(ownTitle).tag(WorkQueues.Scope.own)
                            Text("All Conversations").tag(WorkQueues.Scope.all)
                        }
                        .pickerStyle(.inline)
                    } label: {
                        HStack(spacing: 4) {
                            Text("Work Queue")
                            if scope == .all { Text("· All").foregroundStyle(.secondary) }
                            MenuChevron()
                        }
                        .font(.system(size: 14, weight: .semibold))
                    }
                    .menuStyle(.button)
                    .menuIndicator(.hidden)
                    .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                    .fixedSize()
                    .help("Whose items to show: \(ownTitle.lowercased())’s (with the sessions it oversees), or every conversation’s")
                } else {
                    Text("Work Queue")
                        .font(.system(size: 14, weight: .semibold))
                    Text("· All").font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Text(WorkQueue.openWords(WorkQueue.openCount(view)))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Button {
                    withAnimation(.ui) { isSearching.toggle() }
                    if !isSearching { query = "" }
                } label: {
                    Label("Search", systemImage: "magnifyingglass")
                }
                .buttonStyle(IconButtonStyle())
                .help("Find an item by its title or number")
                Menu {
                    HeldMenuContent(rows: categoryMenu(nil, count: 0))
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(IconButtonStyle())
                .fixedSize()
                .help("Categories")
                .accessibilityLabel("More")
            }
            if isSearching {
                TextField("Title or #number", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .padding(.horizontal, 8)
                    .frame(height: 26)
                    .wellField(cornerRadius: 7)
                    .focused($searchFocused)
                    .onAppear { searchFocused = true }
                    .onExitCommand {
                        isSearching = false
                        query = ""
                    }
            }
            if let away = awayNote(view) {
                Label(away, systemImage: "wifi.slash")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    /// What's said when what shows isn't live: the computer this view is from isn't answering (read
    /// from this Mac's own box instead), or one whose items are in it isn't.
    private func awayNote(_ view: WorkQueueView) -> String? {
        if store.fellBack.contains(key) { return "\(box) isn’t answering: its items are as it last told this Mac." }
        return WorkQueue.awayNote(view)
    }

    private var ownTitle: String {
        guard let owner else { return "This Conversation" }
        if owner.hasPrefix("grp_") { return "This Group Chat" }
        return app.bots.bot(forSession: owner) != nil ? "This Bot" : "This Session"
    }

    // MARK: Filter chips (two panes)

    /// All, In progress and each category, with how many each has: the one chosen in a pill, the
    /// others as words.
    private func chips(_ view: WorkQueueView) -> some View {
        let sections = WorkQueue.sections(view)
        return Flow(spacing: 2) {
            chip("All", count: WorkQueue.allCount(view), filter: .all)
            if let workingOn = WorkQueue.section(for: .workingOn, in: view) {
                chip(workingOn.name, count: workingOn.items.count, filter: .workingOn)
            }
            chip("In progress", count: WorkQueue.items(view, .inProgress).count, filter: .inProgress)
            ForEach(sections.filter { $0.category != nil }) { section in
                chip(section.name, count: section.items.count, filter: .category(section.id))
            }
            if !view.removed.isEmpty {
                chip("Recently Deleted", count: view.removed.count, filter: .category(Self.deleted))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.bottom, 10)
    }

    private func chip(_ title: String, count: Int, filter: WorkQueue.Filter) -> some View {
        let isOn = self.filter == filter
        return Button {
            store.filters[panel] = filter
        } label: {
            HStack(spacing: 4) {
                Text(title)
                Text("\(count)").monospacedDigit()
            }
            .font(.system(size: 13, weight: isOn ? .semibold : .regular))
            .foregroundStyle(isOn ? .primary : .secondary)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(Capsule().fill(Color.primary.opacity(isOn ? 0.1 : 0)))
            .contentShape(Capsule())
        }
        .buttonStyle(FilledButtonStyle(shape: Capsule(), rest: 0))
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .heldContextMenu {
            if case .category(let id) = filter, id != Self.deleted { categoryMenu(id, count: count) }
        }
    }

    // MARK: The list

    @ViewBuilder private func list(_ view: WorkQueueView, wide: Bool) -> some View {
        if view.items.isEmpty, view.removed.isEmpty {
            // Outside the scroll view's leading-aligned stack, so it centres in the panel's full width.
            if isSearching, !query.isEmpty {
                ContentUnavailableView.search(text: query).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                empty
            }
        } else {
            populated(view, wide: wide)
        }
    }

    private func populated(_ view: WorkQueueView, wide: Bool) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if wide, showsDeleted {
                    sectionHeader("Recently Deleted", count: view.removed.count, section: nil)
                    ForEach(view.removed) { item in deletedRow(item) }
                } else if wide, filter != .all {
                    let items = WorkQueue.items(view, filter)
                    let section = WorkQueue.section(for: filter, in: view)
                    if items.isEmpty {
                        Text(filter == .inProgress ? "Nothing is being worked on now." : "Nothing here.")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(.rect)
                            .onDrop(of: [.plainText], delegate: dropping(on: section, index: nil))
                    }
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        row(item, view: view, wide: wide, in: section, at: index, isLast: index == items.count - 1)
                    }
                } else {
                    overview(view, wide: wide)
                }
            }
            .padding(.bottom, store.undoable?.box == box || store.refusal?.box == box ? 56 : 12)
        }
    }

    /// What this session works on that's someone else's, In progress and Next with their items,
    /// Next's first few until you ask for the rest; then the other categories as counts that open
    /// (narrow) or filter the list (wide).
    @ViewBuilder private func overview(_ view: WorkQueueView, wide: Bool) -> some View {
        let sections = WorkQueue.sections(view)
        if let workingOn = sections.first(where: { $0.id == WorkQueue.workingOnID }) {
            sectionHeader(workingOn.name, count: workingOn.items.count, section: workingOn)
            ForEach(workingOn.items) { item in row(item, view: view, wide: wide, in: workingOn, at: 0, isLast: false) }
        }
        if let working = sections.first(where: { $0.id == WorkQueue.inProgressID }), !working.items.isEmpty {
            sectionHeader(working.name, count: working.items.count, section: working)
            ForEach(working.items) { item in row(item, view: view, wide: wide, in: working, at: 0, isLast: false) }
        }
        if let next = sections.first(where: { $0.category == "next" }) {
            let shows = unfolded.contains("next") || isSearching ? next.items.count : Self.nextShown
            sectionHeader(next.name, count: next.items.count, section: next)
            if next.items.isEmpty {
                Text("Nothing next yet. Ask an agent to add an item.")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 4)
            }
            let shown = Array(next.items.prefix(shows))
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, item in
                row(item, view: view, wide: wide, in: next, at: index, isLast: index == shown.count - 1)
            }
            if next.items.count > Self.nextShown {
                Button {
                    withAnimation(.ui) { if unfolded.contains("next") { unfolded.remove("next") } else { unfolded.insert("next") } }
                } label: {
                    HStack(spacing: 4) {
                        Text(unfolded.contains("next") ? "Show fewer" : "\(next.items.count - Self.nextShown) more in Next")
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .rotationEffect(.degrees(unfolded.contains("next") ? 180 : 0))
                    }
                    .font(.system(size: 12))
                }
                .buttonStyle(TextButtonStyle())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
        }
        Divider().padding(.horizontal, 14).padding(.vertical, 8)
        ForEach(sections.filter { $0.category != nil && $0.category != "next" && (!$0.items.isEmpty || !$0.id.hasPrefix("cat_")) }) { section in
            folded(section.name, count: section.items.count, id: section.id, section: section, symbol: Self.symbol(of: section.id), wide: wide) {
                ForEach(Array(section.items.enumerated()), id: \.element.id) { index, item in
                    row(item, view: view, wide: wide, in: section, at: index, isLast: index == section.items.count - 1)
                }
            }
        }
        if !view.removed.isEmpty {
            folded("Recently Deleted", count: view.removed.count, id: Self.deleted, symbol: "trash", wide: wide) {
                ForEach(view.removed) { item in deletedRow(item) }
            }
        }
    }

    /// How many of Next show before "N more in Next".
    static let nextShown = 3

    static func symbol(of category: String) -> String {
        switch category {
        case "later": "archivebox"
        case "parked": "pause.circle"
        case "done": "checkmark.circle"
        default: "tag"
        }
    }

    private var empty: some View {
        ContentUnavailableView {
            Label("No Work Items", systemImage: "checklist")
        } description: {
            Text(scope == .all ? "Agents keep their work here as they go. Ask one to add an item." : "Ask the agent to add an item: it keeps its work here as it goes, and you see it move.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// A section's name in small capitals, with how many it has at the end. An item dropped on it
    /// goes to its top.
    private func sectionHeader(_ title: String, count: Int, section: WorkQueue.Section?) -> some View {
        let category = section?.category
        let isTarget = section.map { dropTarget == WorkQueues.DropTarget(section: $0.id, index: nil) } ?? false
        return HStack(spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .medium))
                .tracking(0.4)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text("\(count)")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(dropFill(isTarget))
        .padding(.horizontal, 6)
        .padding(.top, 11)
        .padding(.bottom, 3)
        .contentShape(.rect)
        .onDrop(of: [.plainText], delegate: dropping(on: section, index: nil))
        .heldContextMenu { if category != nil { categoryMenu(category, count: count) } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// A category shown as its count: opening in place in the narrow list, filtering the list in
    /// the wide one.
    private func folded<Rows: View>(_ title: String, count: Int, id: String, section: WorkQueue.Section? = nil, symbol: String, wide: Bool, @ViewBuilder rows: () -> Rows) -> some View {
        let isOpen = !wide && unfolded.contains(id)
        let category = section?.category
        let isTarget = section.map { dropTarget == WorkQueues.DropTarget(section: $0.id, index: nil) } ?? false
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if wide {
                    store.filters[panel] = .category(id)
                } else {
                    withAnimation(.ui) { if isOpen { unfolded.remove(id) } else { unfolded.insert(id) } }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: symbol)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .frame(width: 16)
                    Text(title)
                        .font(.system(size: 13))
                    Spacer(minLength: 0)
                    Text("\(count)")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    if !wide {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isOpen ? 90 : 0))
                    }
                }
                .padding(.horizontal, 8)
                .frame(height: 32)
            }
            .buttonStyle(ListRowButtonStyle(isSelected: false))
            .background(dropFill(isTarget))
            .padding(.horizontal, 6)
            .onDrop(of: [.plainText], delegate: dropping(on: section, index: nil))
            .heldContextMenu { if category != nil { categoryMenu(category, count: count) } }
            .accessibilityValue(wide ? "\(count) items" : "\(count) items, \(isOpen ? "open" : "closed")")
            if isOpen { rows() }
        }
    }

    /// An item's row, at `index` in `section`: dragged, it goes where it's dropped, before or after
    /// the row it's over (by which half), into that row's category. (In progress hides which
    /// category an item is kept in: dropping there would move it to one you can't see, so nothing
    /// drops on it; nor on Working on, a lead's items.)
    private func row(_ item: WorkItem, view: WorkQueueView, wide: Bool, in section: WorkQueue.Section?, at index: Int, isLast: Bool) -> some View {
        let target = dropTarget
        let id = section?.id ?? ""
        let session = WorkQueue.sessionToOpen(item).flatMap { app.workspace.session($0.session) == nil ? nil : $0.session }
        return WorkItemRow(item: item, view: view, isSelected: wide && opened?.matches(item) == true,
                           openSession: session.map { id in { app.open(.session(id), from: app.tabs.messageTarget) } }) {
            store.opened[panel] = WorkQueues.Opened(box: box, id: item.id, number: item.number)
        }
        .padding(.horizontal, 6)
        .overlay(alignment: .top) { if target == WorkQueues.DropTarget(section: id, index: index) { DropLine().offset(y: -3.5) } }
        .overlay(alignment: .bottom) { if isLast, target == WorkQueues.DropTarget(section: id, index: index + 1) { DropLine().offset(y: 3.5) } }
        // Dragged as it's written ("#243", `gh:owner/repo#12`): dropped in the composer, it names
        // the item.
        .draggable(item.written ?? item.title)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowHeights[item.id] = $0 }
        .onDrop(of: [.plainText], delegate: dropping(on: section, index: index, item: item.id))
        .heldContextMenu {
            // The session first, as #417 opens it: in this conversation's place, or a tab of its own.
            if let session {
                HeldRow.button("Open Session") { app.open(.session(session), from: app.tabs.messageTarget) }
                HeldRow.button("Open Session in New Tab") { app.open(.session(session), from: app.tabs.messageTarget, newTab: true) }
                HeldRow.divider
            }
            WorkItemMenu.rows(item, view: view, box: box, app: app)
        }
        .accessibilityActions {
            if let session {
                Button("Open Session") { app.open(.session(session), from: app.tabs.messageTarget) }
            }
            ForEach(WorkQueue.moveTargets(for: item, in: view.categories)) { category in
                Button("Move to \(category.name)") { Task { await store.move(item, to: .category(category.id), on: box) } }
            }
            if WorkQueue.canMove(item) {
                Button("Move to Top") { Task { await store.move(item, to: .top(item.category), on: box) } }
            }
            Button("Delete") { Task { await store.delete(item, on: box) } }
        }
    }

    private func deletedRow(_ item: WorkItem) -> some View {
        HStack(spacing: 8) {
            Text(item.name)
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle(.secondary)
            Text(item.title)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let removed = item.removed {
                Text(WorkQueue.ago(removed.date))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .help("Deleted by \(removed.by.words). It’s kept for 30 days.")
            }
            Button("Restore") { Task { await store.restore(item, on: box) } }
                .buttonStyle(TextButtonStyle())
                .font(.system(size: 12))
                .help("Bring it back, into the category it was in")
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 30)
    }

    // MARK: Dragging

    private var dropTarget: WorkQueues.DropTarget? { store.dropTargets[panel] }

    /// What a drop on a row (`index` in `section`), or on a category's name or an empty list
    /// (`index` nil), does: it says where the item would land as it's dragged over, and moves it
    /// there once it's dropped.
    private func dropping(on section: WorkQueue.Section?, index: Int?, item: String? = nil) -> WorkItemDrop {
        WorkItemDrop(section: section, index: index, owner: item ?? section?.id ?? "", store: store, panel: panel, rowHeight: item.flatMap { rowHeights[$0] } ?? 44) { dragged, target in
            drop(dragged, at: target)
        }
    }

    private func drop(_ dragged: String, at target: WorkQueues.DropTarget) {
        // (Counted in the rows as they're drawn: a search's, when one is on.)
        let shown = view.map(searched)
        Task { await store.drop(dragged, at: target, in: key, shown: shown) }
    }

    private func dropFill(_ isTarget: Bool) -> some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(Color.accentColor.opacity(isTarget ? 0.14 : 0))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.accentColor.opacity(isTarget ? 0.6 : 0), lineWidth: 1.5))
    }

    // MARK: Detail pane

    @ViewBuilder private func detailPane(_ view: WorkQueueView) -> some View {
        if let opened {
            WorkItemPage(opened: opened, view: view, utilities: utilities, back: nil)
                .id(opened)
        } else {
            ContentUnavailableView("No Item Open", systemImage: "checklist", description: Text("Choose an item to see what it says, how far it’s come and who’s on it."))
        }
    }

    // MARK: Undo and refusals

    @ViewBuilder private var bars: some View {
        if let refusal = store.refusal, refusal.box == box {
            PanelNotice(text: refusal.text, action: nil) { store.refusal = nil }
                .padding(10)
        } else if let undo = store.undoable, undo.box == box {
            PanelNotice(text: "Deleted \(undo.item.name) “\(WorkItemChip.shownTitle(undo.item.title))”", action: ("Undo", { Task { await store.undo() } })) { store.dismissUndo() }
                .padding(10)
                .task(id: undo.item.id) {
                    try? await Task.sleep(for: .seconds(10))
                    if store.undoable?.item.id == undo.item.id { store.dismissUndo() }
                }
        }
    }
}

/// Move and delete, for an item's menu and its page.
struct WorkItemMenu: View {
    let item: WorkItem
    let view: WorkQueueView
    let box: String
    @Environment(AppModel.self) private var app

    var body: some View {
        HeldMenuContent(rows: Self.rows(item, view: view, box: box, app: app))
    }

    @HeldRows static func rows(_ item: WorkItem, view: WorkQueueView, box: String, app: AppModel) -> [HeldRow] {
        let store = app.workQueues
        // (Its order is among the items on its own computer: KuvoClient's rule, the phone's too.)
        let places = WorkQueue.menuPlaces(of: item, in: view)
        // (An issue closed on GitHub stays Done until it's reopened there: only Delete.)
        if WorkQueue.canMove(item) {
            HeldRow.submenu("Move To") {
                for category in WorkQueue.moveTargets(for: item, in: view.categories) {
                    HeldRow.button(category.name) { Task { await store.move(item, to: .category(category.id), on: box) } }
                }
            }
            HeldRow.button("Move to Top", disabled: places.top == nil) { if let top = places.top { Task { await store.move(item, to: top, on: box) } } }
            HeldRow.button("Move Up", disabled: places.up == nil) { if let up = places.up { Task { await store.move(item, to: up, on: box) } } }
            HeldRow.button("Move Down", disabled: places.down == nil) { if let down = places.down { Task { await store.move(item, to: down, on: box) } } }
            HeldRow.divider
        }
        HeldRow.button("Delete", role: .destructive) { Task { await store.delete(item, on: box) } }
    }
}

/// A line over the panel's foot: what happened, with its action (Undo) and a close button.
struct PanelNotice: View {
    let text: String
    let action: (String, () -> Void)?
    let close: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(text)
                .font(.system(size: 12))
                .lineLimit(2)
            Spacer(minLength: 0)
            if let action {
                Button(action.0, action: action.1)
                    .buttonStyle(ChipButtonStyle(tinted: true))
                    .font(.system(size: 12, weight: .semibold))
            }
            Button("Close", systemImage: "xmark", action: close)
                .buttonStyle(IconButtonStyle(width: 20, height: 20))
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.1)))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// Where a dragged item will land: a line between two rows, as Finder and Reminders draw it.
struct DropLine: View {
    var body: some View {
        HStack(spacing: 0) {
            Circle()
                .strokeBorder(Color.accentColor, lineWidth: 2)
                .frame(width: 7, height: 7)
            Rectangle()
                .fill(Color.accentColor)
                .frame(height: 2)
        }
        .padding(.horizontal, 10)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A drop on the Work Queue's list: over a row, before it (its upper half) or after it (its lower
/// half); over a category's name or an empty list, its top. Says where as it's dragged over, by the
/// panel's `dropTargets`, and puts the item there once it's dropped.
struct WorkItemDrop: DropDelegate {
    let section: WorkQueue.Section?
    let index: Int?
    /// Whose target it is (a row's item, or a section): leaving clears only its own.
    let owner: String
    let store: WorkQueues
    let panel: String
    /// The row's height: its middle is where before turns to after.
    let rowHeight: CGFloat
    let drop: @MainActor (String, WorkQueues.DropTarget) -> Void

    /// Nothing drops in In progress (no category) or outside the list's sections.
    private var takes: Bool { section?.category != nil }

    func validateDrop(info: DropInfo) -> Bool { takes && info.hasItemsConforming(to: [.plainText]) }

    func dropEntered(info: DropInfo) { aim(info) }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        guard takes else { return DropProposal(operation: .forbidden) }
        aim(info)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        if store.dropOwners[panel] == owner {
            store.dropTargets[panel] = nil
            store.dropOwners[panel] = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let target = store.dropTargets[panel] ?? target(info)
        store.dropTargets[panel] = nil
        store.dropOwners[panel] = nil
        guard takes, let target, let provider = info.itemProviders(for: [.plainText]).first else { return false }
        let drop = drop
        Task {
            let text: String? = await withCheckedContinuation { done in
                _ = provider.loadObject(ofClass: NSString.self) { value, _ in done.resume(returning: (value as? NSString).map { String($0) }) }
            }
            if let text { drop(text, target) }
        }
        return true
    }

    private func aim(_ info: DropInfo) {
        guard takes, let target = target(info) else { return }
        if store.dropTargets[panel] != target { store.dropTargets[panel] = target }
        store.dropOwners[panel] = owner
    }

    private func target(_ info: DropInfo) -> WorkQueues.DropTarget? {
        guard let section else { return nil }
        guard let index else { return WorkQueues.DropTarget(section: section.id, index: nil) }
        return WorkQueues.DropTarget(section: section.id, index: info.location.y < rowHeight / 2 ? index : index + 1)
    }
}
