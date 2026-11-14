import ClientSessions
import OpenCodeKit
import SwiftUI

/// The model's effort, and the model, in one card that stays open, as Codex does: it opens on the
/// effort, a slider, under the level and the model, which open the model list. The list is by
/// provider, as T3 Code's is: a rail of providers down its side (your starred models first, then
/// Auto, your coding agents' accounts, each its own, and the engine's providers), and the chosen
/// one's models, newest of each kind first with older ones folded away. Typing searches every
/// model; ⌘1–⌘9 pick the rows in view. Picking a model turns back to its effort (a model without
/// levels closes the card). What you chose goes to the session as the card closes, once.
struct ModelPicker: View {
    let catalog: Catalog
    let selection: ModelRef?
    let onSelect: (ModelRef) -> Void
    let close: () -> Void
    /// Whose models it offers: the engine's, or every one with the coding agents' and Auto.
    var scope: ModelScope = .engine
    /// Auto among them (not in your Auto list's own picker).
    var offersAuto = true
    var startsExpanded = false
    /// On the model list rather than the effort (KUVO_DEMO_MENU=list).
    var startsOnList = false
    /// The room it has on the side it opened on: its list scrolls within it. Growing past it, its
    /// popover would jump to the chip's other side.
    var maxHeight: CGFloat = .infinity
    /// Opens a page of Settings (Accounts, to sign in; Auto, to edit your list).
    var openSettings: (SettingsPage) -> Void = { _ in }
    @AppStorage("favoriteModels") private var favoriteStorage = ""
    /// What you've picked, until the card closes.
    @State private var picked: ModelRef?
    /// The page you turned to; until then, the one it opens on.
    @State private var turnedTo: Page?
    /// The rail's choice; until you make one, the current model's provider.
    @State private var chosenRail: String?
    @State private var showsOlder = false
    /// How tall the list's rows and the rail's marks are, for the list's height to fit them.
    @State private var contentHeight: CGFloat = 0
    @State private var railHeight: CGFloat = 0
    @State private var query = ""
    /// The row under the pointer or the arrow keys.
    @State private var highlight: String?
    @FocusState private var focus: Focus?

    private enum Page { case list, effort }
    private enum Focus { case card, search }

    /// The rail's entries that aren't providers.
    private static let favoritesRail = "★"
    private static let autoRail = OutsideAgents.autoProvider

    /// Which side of its chip the card opens on, and how tall it may be there. It opens on the side
    /// it's meant to when its longest page fits there, else on the side with more room; either
    /// way it stays there, whatever page you turn to.
    struct Placement {
        var below = false
        var height: CGFloat = .infinity

        /// The longest page: the search and the list.
        static let tallest: CGFloat = 421
        /// The popover's rim above and below the card (its arrow in it), and a little air from the
        /// screen's edge: taller than the room, the popover would open beside its chip instead.
        private static let margin: CGFloat = 34

        init() {}

        init(room: (above: CGFloat, below: CGFloat)?, prefersBelow: Bool) {
            guard let room else {
                below = prefersBelow
                return
            }
            let preferred = prefersBelow ? room.below : room.above
            let other = prefersBelow ? room.above : room.below
            below = preferred - Self.margin >= Self.tallest || preferred >= other ? prefersBelow : !prefersBelow
            height = (below ? room.below : room.above) - Self.margin
        }
    }

    /// The page in view: the effort first, for a model that has levels, else the list. Right from
    /// the first frame: turning to it once open changed the card's size, and its popover would
    /// open above the chip, then jump below it.
    private var page: Page {
        turnedTo ?? (startsExpanded || startsOnList || selection == nil || current?.variants.isEmpty != false ? .list : .effort)
    }

    private var choice: ModelRef? { picked ?? selection }
    /// None while the model picked can't be used now, until you pick another: the list opens.
    private var current: Model? {
        if picked == nil, catalog.isUnavailable(selection) || selection.map({ !scope.allows($0.providerID) }) == true { return nil }
        return catalog.model(choice) ?? (selection == nil ? catalog.defaultModel.flatMap { scope.allows($0.providerID) ? $0 : nil } : nil)
    }
    private var variant: String? { current.flatMap { model in choice.map(model.isNamed(by:)) == true ? choice?.variant : nil } }

    var body: some View {
        Group {
            switch page {
            case .list: listPage
            case .effort: effortPage
            }
        }
        .frame(width: 372)
        // As tall as the page and no taller: the divider beside the rail took whatever height it
        // was offered, so after a longer page the popover kept that height, the short page sunk
        // in its middle.
        .fixedSize(horizontal: false, vertical: true)
        .focusable()
        .focusEffectDisabled()
        .focused($focus, equals: .card)
        .onKeyPress(phases: .down, action: key)
        .onAppear {
            // Kept, whatever you pick on it.
            turnedTo = page
            focus = page == .list ? .search : .card
            highlight = current.map(rowID)
            // What can't answer now, as of this moment (it ends at a reset, or once one answers).
            Task { await catalog.readUnanswering() }
            #if DEBUG
            // KUVO_DEMO_RAIL: open on this entry of the rail (`★`, `auto`, a provider's ID).
            if let rail = ProcessInfo.processInfo.environment["KUVO_DEMO_RAIL"] { chosenRail = rail }
            // KUVO_DEMO_PICK: a moment after it opens, pick this model (`provider/model`), as a click would.
            if let wanted = ProcessInfo.processInfo.environment["KUVO_DEMO_PICK"] {
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    if let model = providers.flatMap(\.models).first(where: { $0.key == wanted }) { pick(model) }
                    // KUVO_DEMO_PICK_BACK: then back to the list, as clicking the model on the effort does.
                    guard ProcessInfo.processInfo.environment["KUVO_DEMO_PICK_BACK"] != nil else { return }
                    try? await Task.sleep(for: .seconds(1.5))
                    go(.list)
                }
            }
            #endif
        }
        .onDisappear {
            if let picked, !(catalog.isSameModel(picked, selection) && picked.variant == selection?.variant) { onSelect(picked) }
        }
    }

    // MARK: The list

    private var listPage: some View {
        HStack(spacing: 0) {
            rail
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 12))
                        .foregroundStyle(.tertiary)
                    TextField("Search models", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13))
                        .focused($focus, equals: .search)
                        .onKeyPress(phases: .down, action: key)
                        .onSubmit { pickHighlighted() }
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 12))
                                .foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.plain)
                        .clickablePointer()
                        .help("Clear")
                    }
                }
                .padding(.horizontal, 12)
                .frame(height: 40)
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 1) { listContent }
                            // A stack of its own for each list: a model is a row of several (its
                            // account's page, Starred, a search), each row known by the model, and
                            // a lazy stack shown another list kept drawing the row it had for that
                            // model there ("Opus 5.5 ⌘1", without its account, in Starred).
                            .id(shownList)
                            .padding(6)
                            .onGeometryChange(for: CGFloat.self, of: \.size.height) { contentHeight = $0 }
                    }
                    .scrollIndicators(.never)
                    .frame(height: listHeight)
                    .onChange(of: highlight) { _, id in
                        guard let id else { return }
                        proxy.scrollTo(id)
                    }
                }
            }
        }
        .onChange(of: query) { highlight = visibleRows.first.map(rowID) }
    }

    /// As tall as what it lists, up to its most, and never shorter than the rail beside it, so a
    /// short list leaves no empty band under it.
    private var listHeight: CGFloat {
        let most = min(380, max(maxHeight - 41, 160))
        return min(most, max(contentHeight, railHeight - 41, 120))
    }

    @ViewBuilder private var listContent: some View {
        if !query.isEmpty {
            let found = results
            if found.isEmpty {
                note("No models match “\(query)”.")
            } else {
                ForEach(Array(found.enumerated()), id: \.element.key) { index, model in
                    modelRow(model, number: index, showsProvider: true)
                }
            }
        } else {
            switch railSelection {
            case Self.favoritesRail:
                railTitle("Starred")
                let starred = favorites
                if starred.isEmpty {
                    note("Star a model with ☆ to keep it here, whichever provider it's from.")
                } else {
                    ForEach(Array(starred.enumerated()), id: \.element.key) { index, model in
                        modelRow(model, number: index, showsProvider: true)
                    }
                }
            case Self.autoRail:
                autoContent
            default:
                if let provider = selectedProvider {
                    // "Free" once, in the title, when it's true of every model there.
                    let allFree = !provider.models.isEmpty && provider.models.allSatisfy(Self.isZenFree)
                    railTitle(allFree ? "\(provider.name) · Free" : provider.name)
                    if let why = provider.unavailable {
                        note(why)
                        if provider.isAgent {
                            settingsButton("Open Accounts", page: .accounts)
                        }
                    } else {
                        let (newest, older) = split(provider.models)
                        ForEach(Array(newest.enumerated()), id: \.element.key) { index, model in
                            modelRow(model, number: index, showsProvider: false, in: provider, saysFree: !allFree)
                        }
                        if !older.isEmpty {
                            disclosureRow(older.count)
                            if showsOlder {
                                ForEach(Array(older.enumerated()), id: \.element.key) { index, model in
                                    modelRow(model, number: newest.count + index, showsProvider: false, in: provider, saysFree: !allFree)
                                }
                            }
                        }
                        if let outdated = provider.outdated {
                            note(outdated)
                            settingsButton(catalog.machine == nil ? "Update in Accounts" : "Open Accounts", page: .accounts)
                        }
                    }
                } else {
                    note(scope == .all ? "Sign in to a coding agent or a provider in Settings › Accounts to use its models." : "Sign in to a provider in Settings › Accounts to use its models.")
                    settingsButton("Open Accounts", page: .accounts)
                }
            }
        }
    }

    /// Auto: your lists (one for bugfixes, one for features), each with its models in order; on
    /// the one under the pointer, a way to edit it; and a way to make another.
    @ViewBuilder private var autoContent: some View {
        railTitle("Custom Auto")
        let lists = catalog.auto.all
        if catalog.outsideAgents?.api == nil {
            note("Custom Auto runs with the coding agents, which are still starting.")
        } else if lists.allSatisfy(\.entries.isEmpty), lists.count == 1 {
            note("Make a list of models, from any agent or provider, to go through in your order: when one reaches its usage limit, the next goes on with the work.")
            settingsButton("Set Up Custom Auto…", page: .auto)
        } else {
            ForEach(Array(lists.enumerated()), id: \.element.id) { index, list in
                autoRow(list, number: index)
            }
            newListRow
        }
    }

    private func autoRow(_ list: AutoList.Named, number: Int) -> some View {
        let model = catalog.autoModel(list.id)
        let id = model.map(rowID) ?? list.id
        let isCurrent = choice?.providerID == OutsideAgents.autoProvider && catalog.auto.list(choice?.id)?.id == list.id
        return Button {
            if let model { pick(model) }
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "list.number")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(list.name)
                        .font(.system(size: 14))
                        .lineLimit(1)
                    // The whole of it, in order: nothing cut off.
                    Text(flow(of: list))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .layoutPriority(1)
                Spacer(minLength: 4)
                // Under the pointer, editing it takes its shortcut's place.
                ZStack(alignment: .trailing) {
                    if number < 9 {
                        Text("⌘\(number + 1)")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                            .fixedSize()
                            .opacity(highlight == id ? 0 : 1)
                    }
                    Button {
                        editAuto(list.id)
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .frame(width: 22, height: 20)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .clickablePointer()
                    .accessibilityLabel("Edit This List")
                    .help("Edit This List")
                    .opacity(highlight == id ? 1 : 0)
                }
                .padding(.top, 1)
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
                    .opacity(isCurrent ? 1 : 0)
                    .padding(.top, 1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(highlight == id ? Color.primary.opacity(0.07) : .clear, in: .rect(cornerRadius: 10))
            .contentShape(.rect(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { if $0 { highlight = id } }
        .id(id)
    }

    /// A list's models in order: "Gemini 4 Argon (High) → GPT-6.1-Sol High → Cursor Auto".
    private func flow(of list: AutoList.Named) -> String {
        guard !list.entries.isEmpty else { return "No models yet: add some to use it" }
        return list.entries.map { entry in
            var name = catalog.model(entry.ref)?.name ?? entry.modelID
            // An agent's own "Auto" says whose it is.
            if name.hasPrefix("Auto") { name = "\(catalog.providerName(entry.providerID)) \(name)" }
            if let variant = entry.variant { name += " " + EffortLevel.title(variant) }
            // Lines break between models, never inside a name.
            return name.replacingOccurrences(of: " ", with: "\u{00A0}").replacingOccurrences(of: "-", with: "\u{2011}")
        }
        .joined(separator: "\u{00A0}→ ")
    }

    /// Another list (for bugfixes, features…): made now, and named and filled in Settings › Custom Auto.
    private var newListRow: some View {
        let id = "auto-new"
        return Button(action: newAutoList) {
            HStack(spacing: 9) {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 18)
                Text("New List…")
                    .font(.system(size: 13))
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(highlight == id ? Color.primary.opacity(0.07) : .clear, in: .rect(cornerRadius: 10))
            .contentShape(.rect(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { if $0 { highlight = id } }
        .help("Make another list of models for Custom Auto to go through")
    }

    /// One of your Custom Auto lists, in Settings › Custom Auto.
    private func editAuto(_ id: String) {
        catalog.outsideAgents?.autoFocus = id
        close()
        openSettings(.auto)
    }

    private func newAutoList() {
        guard let agents = catalog.outsideAgents else { return }
        let list = AutoList.Named(id: "auto-" + UUID().uuidString.prefix(8).lowercased(), name: "New List", entries: [])
        editAuto(list.id)
        Task { try? await agents.saveAuto(agents.auto.all + [list]) }
    }

    private func railTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .padding(.bottom, 3)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(10)
    }

    private func settingsButton(_ title: String, page: SettingsPage) -> some View {
        Button(title) {
            close()
            openSettings(page)
        }
        .buttonStyle(.glass)
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private func disclosureRow(_ count: Int) -> some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { showsOlder.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .rotationEffect(.degrees(showsOlder ? 90 : 0))
                Text("Older models (\(count))")
                    .font(.system(size: 12))
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .frame(height: 28)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .padding(.top, 2)
    }

    /// "Free" only for OpenCode Zen's free models; a $0 subscription model isn't free.
    private static func isZenFree(_ model: Model) -> Bool {
        model.providerID == "opencode" && (model.isFree || model.name.lowercased().hasSuffix(" free"))
    }

    /// A model's name without the "Free" Zen puts at the end of some: the row says that apart.
    private static func shownName(_ model: Model) -> String {
        guard isZenFree(model) else { return model.name }
        for suffix in [" (free)", " free"] where model.name.lowercased().hasSuffix(suffix) {
            return String(model.name.dropLast(suffix.count))
        }
        return model.name
    }

    /// A row of the list. In a provider's own list (`section`), the maker's mark shows only where
    /// the maker isn't that provider, its slot kept so the names line up.
    private func modelRow(_ model: Model, number: Int, showsProvider: Bool, in section: Catalog.PickerProvider? = nil, saysFree: Bool = true) -> some View {
        let id = rowID(model)
        let isCurrent = model.ref.sameModel(as: current?.ref)
        let isStarred = favoriteKeys.contains(model.key)
        // One that can't answer now (out of funds, at a limit): still offered, its name quieter and
        // why on its second line.
        let held = catalog.unanswering(model)
        let free = saysFree && Self.isZenFree(model) && held?.saysFree != true
        let detail = showsProvider ? catalog.providerName(model.providerID) + (free ? " · Free" : "") : (free ? "Free" : nil)
        let showsMark = section.map { model.makerLogoID != $0.logo } ?? true
        return Button {
            pick(model)
        } label: {
            HStack(spacing: 9) {
                ProviderLogo(id: model.makerLogoID, size: 15)
                    // Starred or found, beside the agent's own: whose it is at a glance, as the rail marks it.
                    .overlay(alignment: .bottomTrailing) { if section == nil { accountBadge(model.providerID) } }
                    .opacity(showsMark ? 1 : 0)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(Self.shownName(model))
                        .font(.system(size: 14))
                        .foregroundStyle(held == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                    if detail != nil || held != nil {
                        Group {
                            switch (detail, held) {
                            case let (detail?, held?): Text("\(detail) · ").foregroundStyle(.secondary) + Text(held.line).foregroundStyle(.tertiary)
                            case let (nil, held?): Text(held.line).foregroundStyle(.tertiary)
                            case let (detail, nil): Text(detail ?? "").foregroundStyle(.secondary)
                            }
                        }
                        .font(.system(size: 11))
                        .lineLimit(1)
                    }
                }
                .layoutPriority(1)
                Spacer(minLength: 4)
                if number < 9 {
                    Text("⌘\(number + 1)")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                }
                Button {
                    toggleFavorite(model)
                } label: {
                    Image(systemName: isStarred ? "star.fill" : "star")
                        .font(.system(size: 12))
                        .foregroundStyle(isStarred ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                        .frame(width: 20, height: 20)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                // Starred, or under the pointer: the star shows.
                .opacity(isStarred || highlight == id ? 1 : 0)
                .accessibilityLabel(isStarred ? "Unstar" : "Star")
                .help(isStarred ? "Unstar" : "Star")
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
                    .opacity(isCurrent ? 1 : 0)
            }
            .padding(.horizontal, 10)
            .frame(height: detail == nil && held == nil ? 34 : 42)
            // A hold read as it opens grows the row: smoothly, not a jump under the pointer.
            .animation(.snappy(duration: 0.2), value: held?.line)
            .background(highlight == id ? Color.primary.opacity(0.07) : .clear, in: .rect(cornerRadius: 10))
            .contentShape(.rect(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { if $0 { highlight = id } }
        // The line is in its label already: the engine's words as its help, and VoiceOver's hint.
        .help(held?.why ?? "")
        // The check mark, for VoiceOver: the model in use.
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .id(id)
    }

    // MARK: The rail

    private var rail: some View {
        ScrollView {
            VStack(spacing: 4) {
                railButton(Self.favoritesRail, name: "Starred") {
                    Image(systemName: "star.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
                if showsAuto {
                    railButton(Self.autoRail, name: "Custom Auto") {
                        Image(systemName: "list.number")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }
                Divider()
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                ForEach(providers) { provider in
                    railButton(provider.id, name: provider.name, dimmed: provider.unavailable != nil) {
                        ProviderLogo(id: provider.logo, size: 17)
                            .overlay(alignment: .bottomTrailing) { accountBadge(provider.id) }
                    }
                }
            }
            .padding(.vertical, 8)
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { railHeight = $0 }
        }
        .scrollIndicators(.never)
        .frame(width: 46, height: listHeight + 41)
    }

    private func railButton<Mark: View>(_ id: String, name: String, dimmed: Bool = false, @ViewBuilder mark: () -> Mark) -> some View {
        let isSelected = query.isEmpty && railSelection == id
        return Button {
            query = ""
            chosenRail = id
            showsOlder = false
            highlight = visibleRows.first.map(rowID)
        } label: {
            mark()
                .frame(width: 32, height: 32)
                .background(isSelected ? Color.primary.opacity(0.1) : .clear, in: .rect(cornerRadius: 8))
                .contentShape(.rect(cornerRadius: 8))
                .opacity(dimmed ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .hoverHighlight(in: RoundedRectangle(cornerRadius: 8), selected: isSelected)
        .help(name)
        .accessibilityLabel(name)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// An account you added, marked apart from the agent's own: the first letter of its name, on
    /// its mark in the rail and on its models' in a list of every account's.
    @ViewBuilder private func accountBadge(_ providerID: String) -> some View {
        if OutsideAgents.account(providerID) != nil {
            let label = catalog.providerName(providerID).components(separatedBy: " · ").last ?? ""
            Text(label.first.map { String($0).uppercased() } ?? "+")
                .font(.system(size: 7, weight: .bold))
                .foregroundStyle(.background)
                .frame(width: 11, height: 11)
                .background(.secondary, in: .circle)
                .offset(x: 5, y: 5)
        }
    }

    // MARK: Effort

    private var effortPage: some View {
        VStack(spacing: 14) {
            ZStack {
                // The level and the model, and only they, open the model list.
                Button { go(.list) } label: {
                    VStack(spacing: 2) {
                        Text(variant.map(EffortLevel.title) ?? "Default")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(variant == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.tint))
                        HStack(spacing: 3) {
                            Text(current?.name ?? "")
                                .lineLimit(1)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .hoverHighlight(in: RoundedRectangle(cornerRadius: 12))
                    .contentShape(.rect(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .help("Choose another model")
                // Room for the logo and the reset button beside it, outside what opens the list.
                .padding(.horizontal, 32)
                // Beside it, without moving it: who made the model, and back to its default.
                HStack {
                    if let current {
                        ProviderLogo(id: current.makerLogoID, size: 24, colored: true)
                            .frame(width: 30, height: 30)
                            .allowsHitTesting(false)
                    }
                    Spacer()
                    Button { pickEffort(nil) } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 14, weight: .medium))
                            .frame(width: 26, height: 26)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .clickablePointer()
                    .foregroundStyle(.secondary)
                    .opacity(variant == nil ? 0 : 1)
                    .disabled(variant == nil)
                    .help("Back to the model's default effort")
                }
                .padding(.horizontal, 8)
            }
            if let current {
                EffortSlider(levels: current.variants.map(\.id), selected: variant) { pickEffort($0) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 16)
    }

    // MARK: Choosing

    private func go(_ next: Page) {
        // In one step: a popover animating its size between the two pages could lay itself out
        // again and again, until AppKit stopped the app.
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) { turnedTo = next }
        query = ""
        focus = next == .list ? .search : .card
        highlight = next == .list ? current.map(rowID) : nil
    }

    /// A model, keeping the effort you had if it has that level too; then its effort, or, for a
    /// model without levels, the card closes.
    private func pick(_ model: Model) {
        // An Auto list with nothing in it yet: filled in first.
        if model.providerID == OutsideAgents.autoProvider, !catalog.isAutoAvailable(model.id) {
            editAuto(model.id)
            return
        }
        let keep = variant.flatMap { level in model.variants.contains { $0.id == level } ? level : nil }
        picked = ModelRef(id: model.id, providerID: model.providerID, variant: keep)
        if model.variants.isEmpty {
            close()
        } else {
            go(.effort)
        }
    }

    private func pickEffort(_ level: String?) {
        guard let current else { return }
        picked = ModelRef(id: current.id, providerID: current.providerID, variant: level)
    }

    private func pickHighlighted() {
        if let model = visibleRows.first(where: { rowID($0) == highlight }) ?? (query.isEmpty ? nil : visibleRows.first) {
            pick(model)
        }
    }

    private func key(_ press: KeyPress) -> KeyPress.Result {
        // ⌘1–⌘9: that row of the list in view.
        if page == .list, press.modifiers == .command, let digit = press.characters.first?.wholeNumberValue, (1...9).contains(digit) {
            let rows = visibleRows
            if digit <= rows.count { pick(rows[digit - 1]) }
            return .handled
        }
        switch press.key {
        case .escape:
            close()
            return .handled
        case .return:
            if page == .effort { close() } else { pickHighlighted() }
            return .handled
        case .downArrow, .upArrow:
            guard page == .list else { return .ignored }
            // ⌥↑ ⌥↓: the rail.
            if press.modifiers.contains(.option) {
                moveRail(press.key == .downArrow ? 1 : -1)
                return .handled
            }
            let ids = visibleRows.map(rowID)
            guard !ids.isEmpty else { return .handled }
            let at = highlight.flatMap { ids.firstIndex(of: $0) }
            let next = press.key == .downArrow ? (at.map { min($0 + 1, ids.count - 1) } ?? 0) : (at.map { max($0 - 1, 0) } ?? ids.count - 1)
            highlight = ids[next]
            return .handled
        case .leftArrow, .rightArrow:
            guard page == .effort, let current, !current.variants.isEmpty else { return .ignored }
            let levels = current.variants.map(\.id)
            let at = variant.flatMap { levels.firstIndex(of: $0) }
            let next = press.key == .rightArrow ? (at.map { min($0 + 1, levels.count - 1) } ?? 0) : (at.map { $0 - 1 } ?? -1)
            pickEffort(next >= 0 ? levels[next] : nil)
            return .handled
        default:
            break
        }
        // Typing on the list searches every model.
        guard page == .list, focus != .search, press.modifiers.isEmpty || press.modifiers == .shift,
              let character = press.characters.first, character.isLetter || character.isNumber else { return .ignored }
        query = press.characters
        focus = .search
        return .handled
    }

    private func moveRail(_ offset: Int) {
        let ids = railIDs
        guard let at = ids.firstIndex(of: railSelection) else { return }
        let next = min(max(at + offset, 0), ids.count - 1)
        query = ""
        chosenRail = ids[next]
        showsOlder = false
        highlight = visibleRows.first.map(rowID)
    }

    // MARK: Lists

    private func rowID(_ model: Model) -> String { model.key }

    private var showsAuto: Bool { offersAuto && scope == .all && catalog.outsideAgents != nil }

    private var providers: [Catalog.PickerProvider] { catalog.pickerProviders(scope) }

    private var railIDs: [String] {
        [Self.favoritesRail] + (showsAuto ? [Self.autoRail] : []) + providers.map(\.id)
    }

    /// The rail entry in view: the one you chose; else the current model's provider (Auto, if
    /// that's the model); else your starred models, if you have any; else the first provider.
    private var railSelection: String {
        if let chosenRail, railIDs.contains(chosenRail) { return chosenRail }
        if let ref = choice {
            if ref.providerID == OutsideAgents.autoProvider, showsAuto { return Self.autoRail }
            if providers.contains(where: { $0.id == ref.providerID }) { return ref.providerID }
        }
        if !favorites.isEmpty { return Self.favoritesRail }
        return providers.first { $0.unavailable == nil }?.id ?? providers.first?.id ?? Self.favoritesRail
    }

    private var selectedProvider: Catalog.PickerProvider? {
        providers.first { $0.id == railSelection }
    }

    /// Which list is in view: what was found, or the rail's entry.
    private var shownList: String { query.isEmpty ? railSelection : "?" }

    /// The rows in view, in order: what ⌘1–⌘9 and the arrow keys go through.
    private var visibleRows: [Model] {
        if !query.isEmpty { return results }
        switch railSelection {
        case Self.favoritesRail: return favorites
        case Self.autoRail: return catalog.outsideAgents?.api == nil ? [] : catalog.autoModels
        default:
            guard let provider = selectedProvider, provider.unavailable == nil else { return [] }
            let (newest, older) = split(provider.models)
            return showsOlder ? newest + older : newest
        }
    }

    /// A provider's models: the newest of each kind (Claude Opus, GPT Sol…) and those without a
    /// kind, then the older ones of a kind.
    private func split(_ models: [Model]) -> (newest: [Model], older: [Model]) {
        var newestOfFamily: [String: Model] = [:]
        for model in models {
            guard let family = model.family else { continue }
            if let kept = newestOfFamily[family], kept.time.released >= model.time.released { continue }
            newestOfFamily[family] = model
        }
        let newest = models.filter { model in model.family.map { newestOfFamily[$0]?.key == model.key } ?? true }
        let older = models.filter { model in model.family.map { newestOfFamily[$0]?.key != model.key } ?? false }
        return (newest, older)
    }

    /// Every model that matches what you typed, from every provider here.
    private var results: [Model] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return [] }
        var all = providers.filter { $0.unavailable == nil }.flatMap(\.models)
        if showsAuto { all.insert(contentsOf: catalog.autoModels.filter { catalog.isAutoAvailable($0.id) }, at: 0) }
        return all.filter { model in
            let text = "\(model.name) \(model.id) \(model.family ?? "") \(catalog.providerName(model.providerID))".lowercased()
            return words.allSatisfy { text.contains($0) }
        }
        .prefix(80)
        .map { $0 }
    }

    /// Your starred models' keys, one a model was starred by another name (Claude Code's `default`)
    /// as that model's own.
    private var favoriteKeys: [String] {
        providers.flatMap(\.models).canonicalKeys(favoriteStorage.split(separator: ",").map(String.init))
    }

    /// Your starred models you can use here, in the order you starred them.
    private var favorites: [Model] {
        let usable = providers.filter { $0.unavailable == nil }.flatMap(\.models)
        return favoriteKeys.compactMap { key in usable.first { $0.key == key } }
    }

    private func toggleFavorite(_ model: Model) {
        var keys = favoriteKeys
        if let index = keys.firstIndex(of: model.key) {
            keys.remove(at: index)
        } else {
            keys.append(model.key)
        }
        favoriteStorage = keys.joined(separator: ",")
    }
}

/// Effort as a slider with a stop for each level, filled up to the one picked. While you drag, it
/// follows the pointer as it is; a click or a key glides to the level.
struct EffortSlider: View {
    let levels: [String]
    /// nil for the model's default: nothing filled, no knob.
    let selected: String?
    let onSelect: (String?) -> Void
    @State private var dragging = false

    private var index: Int? { selected.flatMap { levels.firstIndex(of: $0) } }

    var body: some View {
        GeometryReader { geometry in
            let height = geometry.size.height
            let inset = height / 2
            let room = max(geometry.size.width - inset * 2, 1)
            let x = { (i: Int) -> CGFloat in inset + (levels.count > 1 ? room * CGFloat(i) / CGFloat(levels.count - 1) : room / 2) }
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.08))
                Capsule()
                    .fill(.tint)
                    .frame(width: index.map { x($0) + inset } ?? 0)
                    .opacity(index == nil ? 0 : 1)
                ForEach(levels.indices, id: \.self) { i in
                    Circle()
                        .fill(index.map { i < $0 } == true ? Color.white.opacity(0.6) : Color.primary.opacity(0.25))
                        .frame(width: 5, height: 5)
                        .position(x: x(i), y: height / 2)
                        .opacity(index == i ? 0 : 1)
                }
                Circle()
                    .fill(.white)
                    .shadow(color: .black.opacity(0.22), radius: 3, y: 1)
                    .frame(width: height + 4, height: height + 4)
                    .position(x: x(index ?? 0), y: height / 2)
                    .opacity(index == nil ? 0 : 1)
            }
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        dragging = true
                        let i = Int(((value.location.x - inset) / room * CGFloat(max(levels.count - 1, 1))).rounded())
                        let level = levels[min(max(i, 0), levels.count - 1)]
                        if level != selected { onSelect(level) }
                    }
                    .onEnded { _ in dragging = false }
            )
        }
        .frame(height: 26)
        .animation(dragging ? nil : .snappy(duration: 0.18), value: selected)
        .help(levels.map(EffortLevel.title).joined(separator: ", "))
    }
}
