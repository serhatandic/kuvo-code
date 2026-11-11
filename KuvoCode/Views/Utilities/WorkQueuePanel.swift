import ClientDesign
import ClientSessions
import ClientText
import SwiftUI

/// The panel's Work Queue: the conversation's items (a lead's with those of the sessions it
/// oversees), or every item. Narrow, one column: In progress with what's being done, Next numbered,
/// the other categories as counts that open; an item opens over the list. Wide (as the expanded
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
    @ViewBuilder private func categoryMenu(_ id: String?, count: Int, adds: Bool = true) -> some View {
        if let id, let category = view?.categories.first(where: { $0.id == id }), !category.builtIn {
            Button("Rename “\(category.name)”…") {
                name = category.name
                naming = .some(category)
            }
            Button("Remove “\(category.name)”", role: .destructive) { Task { await store.removeCategory(category.id, on: box) } }
                .disabled(count > 0)
                .help(count > 0 ? "Move its items out first." : "")
            if adds { Divider() }
        }
        if adds {
            Button("New Category…") {
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
        let keeps = { (item: WorkItem) in item.title.localizedStandardContains(words) || (number != nil && item.number == number) }
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
                Text(WorkQueue.count(WorkQueue.openCount(view)))
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
                    categoryMenu(nil, count: 0)
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
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
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
            chip("All", count: WorkQueue.openCount(view), filter: .all)
            chip("In progress", count: sections.first?.items.count ?? 0, filter: .inProgress)
            ForEach(sections.dropFirst()) { section in
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
        .contextMenu {
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
                    sectionHeader("Recently Deleted", count: view.removed.count, category: nil)
                    ForEach(view.removed) { item in deletedRow(item) }
                } else if wide, filter != .all {
                    let items = WorkQueue.items(view, filter)
                    let category: String? = if case .category(let id) = filter { id } else { nil }
                    if items.isEmpty {
                        Text(filter == .inProgress ? "Nothing is being worked on now." : "Nothing here.")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                    }
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        row(item, view: view, ordinal: category == "next" ? index + 1 : nil, wide: wide)
                    }
                } else {
                    overview(view, wide: wide)
                }
            }
            .padding(.bottom, store.undoable?.box == box || store.refusal?.box == box ? 56 : 12)
        }
    }

    /// In progress and Next with their items, Next's first few until you ask for the rest; then
    /// the other categories as counts that open (narrow) or filter the list (wide).
    @ViewBuilder private func overview(_ view: WorkQueueView, wide: Bool) -> some View {
        let sections = WorkQueue.sections(view)
        if let working = sections.first, !working.items.isEmpty {
            sectionHeader(working.name, count: working.items.count, category: nil)
            ForEach(working.items) { item in row(item, view: view, ordinal: nil, wide: wide) }
        }
        if let next = sections.first(where: { $0.category == "next" }) {
            let shows = unfolded.contains("next") || isSearching ? next.items.count : Self.nextShown
            sectionHeader(next.name, count: next.items.count, category: next.category)
            if next.items.isEmpty {
                Text("Nothing next yet. Ask an agent to add an item.")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 4)
            }
            ForEach(Array(next.items.prefix(shows).enumerated()), id: \.element.id) { index, item in
                row(item, view: view, ordinal: index + 1, wide: wide)
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
            folded(section.name, count: section.items.count, id: section.id, category: section.category, symbol: Self.symbol(of: section.id), wide: wide) {
                ForEach(section.items) { item in row(item, view: view, ordinal: nil, wide: wide) }
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

    /// A section's name in small capitals, with how many it has at the end.
    private func sectionHeader(_ title: String, count: Int, category: String?) -> some View {
        HStack(spacing: 6) {
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
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 6)
        .contentShape(.rect)
        .dropDestination(for: String.self) { ids, _ in drop(ids, at: category.map { .top($0) }) }
        .contextMenu { if category != nil { categoryMenu(category, count: count) } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// A category shown as its count: opening in place in the narrow list, filtering the list in
    /// the wide one.
    private func folded<Rows: View>(_ title: String, count: Int, id: String, category: String? = nil, symbol: String, wide: Bool, @ViewBuilder rows: () -> Rows) -> some View {
        let isOpen = !wide && unfolded.contains(id)
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
            .padding(.horizontal, 6)
            .dropDestination(for: String.self) { ids, _ in drop(ids, at: category.map { .top($0) }) }
            .contextMenu { if category != nil { categoryMenu(category, count: count) } }
            .accessibilityValue(wide ? "\(count) items" : "\(count) items, \(isOpen ? "open" : "closed")")
            if isOpen { rows() }
        }
    }

    private func row(_ item: WorkItem, view: WorkQueueView, ordinal: Int?, wide: Bool) -> some View {
        // In progress hides which category an item is kept in: dropping there would move it to
        // one you can't see, so nothing drops on it.
        let takesDrops = !WorkQueue.isInProgress(item)
        return WorkItemRow(item: item, ownerName: WorkQueue.ownerName(of: item, in: view), ordinal: ordinal, isSelected: wide && opened?.matches(item) == true,
                           openSession: item.sessions.first(where: \.working).map { linked in { app.open(.session(linked.session)) } }) {
            store.opened[panel] = WorkQueues.Opened(box: box, id: item.id, number: item.number)
        }
        .padding(.horizontal, 6)
        // Dragged as it's written ("#243"): dropped in the composer, it names the item.
        .draggable(item.number.map { "#\($0)" } ?? item.title)
        .dropDestination(for: String.self) { ids, _ in takesDrops && drop(ids, at: .before(item)) }
        .contextMenu { menu(item, view: view) }
        .accessibilityActions {
            ForEach(WorkQueue.moveTargets(for: item, in: view.categories)) { category in
                Button("Move to \(category.name)") { Task { await store.move(item, to: .category(category.id), on: box) } }
            }
            Button("Move to Top") { Task { await store.move(item, to: .top(item.category), on: box) } }
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

    @ViewBuilder private func menu(_ item: WorkItem, view: WorkQueueView) -> some View {
        WorkItemMenu(item: item, view: view, box: box)
    }

    /// Items dropped on a row go before it (in its category); on a category, to its top.
    private func drop(_ ids: [String], at place: WorkQueues.Place?) -> Bool {
        guard let place, let view, let dragged = ids.first else { return false }
        let number = dragged.hasPrefix("#") ? Int(dragged.dropFirst()) : nil
        guard let item = view.items.first(where: { number != nil ? $0.number == number : $0.number == nil && $0.title == dragged }) else { return false }
        if case .before(let other) = place, other.id == item.id || other.computer?.key != item.computer?.key { return false }
        Task { await store.move(item, to: place, on: box) }
        return true
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
        let store = app.workQueues
        // (Its order is among the items on its own computer.)
        let mates = view.items.filter { $0.category == item.category && !WorkQueue.isInProgress($0) == !WorkQueue.isInProgress(item) && $0.computer?.key == item.computer?.key }
        let index = mates.firstIndex { $0.id == item.id }
        Menu("Move To") {
            ForEach(WorkQueue.moveTargets(for: item, in: view.categories)) { category in
                Button(category.name) { Task { await store.move(item, to: .category(category.id), on: box) } }
            }
        }
        Button("Move to Top") { Task { await store.move(item, to: .top(item.category), on: box) } }
            .disabled(index == 0)
        Button("Move Up") {
            if let index, index > 0 { Task { await store.move(item, to: .before(mates[index - 1]), on: box) } }
        }
        .disabled(index.map { $0 == 0 } ?? true)
        Button("Move Down") {
            if let index, index + 1 < mates.count { Task { await store.move(item, to: .after(mates[index + 1]), on: box) } }
        }
        .disabled(index.map { $0 + 1 >= mates.count } ?? true)
        Divider()
        Button("Delete", role: .destructive) { Task { await store.delete(item, on: box) } }
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

/// An item in the list. In progress: a working ring, its title, what's being done, then its
/// number and when it was last updated, and ↗ to its agent's session. Next's are numbered in
/// their order. Each says whose it is when it isn't the view's own owner's.
struct WorkItemRow: View {
    let item: WorkItem
    /// Whose it is, when it isn't the view's own owner's.
    let ownerName: String?
    let ordinal: Int?
    var isSelected = false
    /// Opens the session at work on it.
    var openSession: (() -> Void)?
    let open: () -> Void

    var body: some View {
        let working = WorkQueue.isInProgress(item)
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Button(action: open) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    if let ordinal {
                        Text("\(ordinal)")
                            .font(.system(size: 12).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 12, alignment: .leading)
                    } else if working {
                        Spinner(size: 12)
                            .alignmentGuide(.firstTextBaseline) { $0.height * 0.82 }
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title)
                            .font(.system(size: 13.5, weight: working ? .medium : .regular))
                            .lineLimit(2)
                            .strikethrough(item.isDone, color: .secondary)
                            .foregroundStyle(item.isDone ? .secondary : .primary)
                        if working, let now = WorkQueue.currentWork(item) {
                            Text(now)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        if working, let value = item.progress?.value {
                            ProgressLine("Progress", fraction: value, layout: .bar)
                                .frame(maxWidth: 160)
                                .padding(.vertical, 2)
                        }
                        Text(footer(working: working))
                            .font(.system(size: 11.5).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(ListRowButtonStyle(isSelected: isSelected))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(spoken(working: working))
            if working, let openSession {
                Button(action: openSession) {
                    Label("Open Agent Session", systemImage: "arrow.up.right")
                }
                .buttonStyle(IconButtonStyle())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .help("Open the session at work on it")
            }
        }
    }

    /// What VoiceOver reads for the row.
    private func spoken(working: Bool) -> String {
        var parts: [String] = []
        if let ordinal { parts.append("\(ordinal).") }
        parts.append(item.number.map { "Work item \($0)" } ?? "New work item")
        parts.append(item.title)
        if working { parts.append("in progress") }
        if let now = WorkQueue.currentWork(item) { parts.append(now) }
        if working { parts.append(WorkQueue.updated(item.updated.date)) }
        if let ownerName { parts.append("in \(ownerName)") }
        if let computer = WorkQueue.computerName(of: item) { parts.append("on \(computer)") }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// "#181 · Updated 8m ago · in Sign-in · on lab": the number, when it's in progress how fresh
    /// it is, whose it is when it isn't the view's own, and the computer it's on when that's another.
    private func footer(working: Bool) -> String {
        var parts = [item.name]
        if working { parts.append(WorkQueue.updated(item.updated.date)) }
        if let ownerName { parts.append("in \(ownerName)") }
        if let computer = WorkQueue.computerName(of: item) { parts.append("on \(computer)") }
        if let handing = item.handing { parts.append("handing to \(handing.name.isEmpty ? "another computer" : handing.name)") }
        return parts.joined(separator: " · ")
    }
}
