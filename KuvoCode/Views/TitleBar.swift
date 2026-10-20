import AppKit
import OpenCodeKit
import SwiftUI

/// The tab bar in the title bar, off until you turn it on (View › Show Tab Bar, or Settings ›
/// General). Without it, sessions are switched in the sidebar or with ⌘K, and Settings shows one
/// page at a time.
enum TabBar {
    static let showsKey = "showsTabBar"
    static let showsByDefault = false

    static var isShown: Bool {
        UserDefaults.standard.object(forKey: showsKey) as? Bool ?? showsByDefault
    }
}

/// An open tab: a session, or a new one being written (`draft:<folder>`).
struct TabItem: Identifiable, Equatable {
    var id: String
    var title: String
    /// The model maker's logo (Anthropic, OpenAI, …) for the tab's front tile.
    var logo: String?
    /// A bot's tab shows the bot, moving with what it's up to.
    var bot: BotLook?
    var botMood: BotMood = .idle
    /// A group chat's tab shows its bots.
    var group: [GroupAvatar.Face]?
    var status: Status
    /// Its symbol, when it's not a session's (a page of Settings, a site).
    var symbol: String?
    /// One that stays (Settings' page) has no close button.
    var closes = true
    /// A page you've only looked at, which the next one you open takes the place of (Settings'):
    /// its title in italics, as VS Code shows its preview tab.
    var isPreview = false
    /// The session beside it in split view, shown with it as one tab (none, or one).
    var companion: [TabItem] = []

    func titled(_ title: String) -> TabItem {
        var tab = self
        tab.title = title
        return tab
    }

    enum Status {
        case idle, working, waiting, failed, unread

        var help: String? {
            switch self {
            case .idle: nil
            case .working: "Working"
            case .waiting: "Waiting for you"
            case .failed: "The last run failed"
            case .unread: "Finished"
            }
        }
    }
}

/// How two sessions side by side show in the tab bar (Settings › General): one tab in two
/// halves, the side you're in lit; one tab with both names; or the two tabs joined.
enum PairStyle: String, CaseIterable {
    case halves, compact, joined
    static let key = "pairStyle"
}

/// Open sessions as tabs in one glass track; the active tab is a raised pill
/// that slides to whichever tab you pick.
struct TabStrip: View {
    let tabs: [TabItem]
    @Binding var selection: String?
    let close: (String) -> Void
    /// Closes every tab except the given one, or all of them when it's nil.
    let closeAll: (_ except: String?) -> Void
    /// Shows a session beside the one in view (split view).
    var openBeside: ((String) -> Void)?
    /// Close Split View (the two go back to tabs of their own), closes the session beside a tab's
    /// (its half's close button), and swaps the two, by the tab's id.
    var closeBeside: ((String) -> Void)?
    var closeBesideTab: ((String) -> Void)?
    var swapBeside: ((String) -> Void)?
    /// Renames a session's tab (a new session's has no title to change yet).
    var rename: ((String) -> Void)?

    @Namespace private var pill
    @Environment(\.colorScheme) private var scheme
    @AppStorage(PairStyle.key) private var style = PairStyle.halves
    /// How wide the tabs are, each as wide as its title, and whether some are out of sight at
    /// either end.
    @State private var tracksWidth: CGFloat = 0
    @State private var hidden = HiddenEnds()

    struct HiddenEnds: Equatable {
        var leading = false
        var trailing = false
    }

    /// Room above and below the tabs, in the scroll view, for the raised pill's shadow.
    private static let shadowRoom: CGFloat = 8

    var body: some View {
        // As many tabs as fit, each as wide as its title; past that, the track scrolls, with the
        // tab in view kept in sight, as VS Code's and a browser's do, rather than squeezing the
        // titles and running off the window.
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                track
                    .padding(3)
                    .padding(.vertical, Self.shadowRoom)
                    .onGeometryChange(for: CGFloat.self, of: \.size.width) { tracksWidth = $0 }
            }
            .scrollIndicators(.never)
            .onScrollGeometryChange(for: HiddenEnds.self) { geometry in
                HiddenEnds(
                    leading: geometry.contentOffset.x > 1,
                    trailing: geometry.contentOffset.x + geometry.containerSize.width < geometry.contentSize.width - 1
                )
            } action: { _, ends in hidden = ends }
            // Tabs out of sight fade at the end they're past.
            .mask {
                HStack(spacing: 0) {
                    LinearGradient(colors: [hidden.leading ? .clear : .black, .black], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 24)
                    Color.black
                    LinearGradient(colors: [.black, hidden.trailing ? .clear : .black], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 24)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, -Self.shadowRoom)
            .frame(maxWidth: tracksWidth > 0 ? tracksWidth : nil)
            // Once it's laid out too: before, the room it has, and so where the tab is, isn't known.
            .onAppear { DispatchQueue.main.async { proxy.scrollTo(selection) } }
            .onGeometryChange(for: CGFloat.self, of: \.size.width) { _ in proxy.scrollTo(selection) }
            .onChange(of: tracksWidth) { proxy.scrollTo(selection) }
            .onChange(of: selection) { _, id in withAnimation(.ui) { proxy.scrollTo(id) } }
            .onChange(of: tabs.map(\.id)) { withAnimation(.ui) { proxy.scrollTo(selection) } }
        }
        .glassEffect(.regular, in: .capsule)
        .animation(.ui, value: tabs.map(\.id))
    }

    private var track: some View {
        HStack(spacing: 0) {
            ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                let isActive = tab.id == selection
                tabView(tab, isActive: isActive)
                    .id(tab.id)
                // Hairlines between inactive neighbours, like Rex; none next to the pill. They
                // fade out at both ends, so they read as a crease in the glass, not a drawn line.
                if index < tabs.count - 1, !isActive, tabs[index + 1].id != selection {
                    Rectangle()
                        .fill(LinearGradient(
                            stops: [
                                .init(color: .clear, location: 0),
                                .init(color: Surface.hairline(scheme), location: 0.3),
                                .init(color: Surface.hairline(scheme), location: 0.7),
                                .init(color: .clear, location: 1),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        ))
                        .frame(width: 1, height: 16)
                }
            }
        }
    }

    /// The session beside a tab's, in its half of the tab.
    private func besideMenu(for tab: TabItem) -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        if let swapBeside { items.append(ActionItem("Swap") { swapBeside(tab.id) }) }
        if let closeBeside { items.append(ActionItem("Close Split View") { closeBeside(tab.id) }) }
        return items
    }

    /// A tab: a session's, or two side by side as one tab, drawn as Settings › General says.
    @ViewBuilder private func tabView(_ tab: TabItem, isActive: Bool) -> some View {
        let select = { withAnimation(.ui) { selection = tab.id } }
        switch (tab.companion.first, style) {
        case (let companion?, .halves):
            // One tab in two halves on a soft fill; the tab's own half raised while it's in view.
            HStack(spacing: 0) {
                TabButton(tab: tab, isActive: isActive, close: { close(tab.id) }, select: select)
                    .rightClickMenu { menu(for: tab) }
                    .background { if isActive { ActivePill().matchedGeometryEffect(id: "pill", in: pill) } }
                TabButton(tab: companion, isActive: false, close: { closeBesideTab?(tab.id) }, select: select)
                    .rightClickMenu { besideMenu(for: tab) }
            }
            .background(Pressable.hoverFill, in: .capsule)
        case (let companion?, .compact):
            // One tab: the two tiles stacked, and both titles.
            TabButton(tab: tab.titled(tab.title + " · " + companion.title), isActive: isActive, close: { close(tab.id) }, behind: companion, select: select)
                .rightClickMenu { menu(for: tab) + [.separator()] + besideMenu(for: tab) }
                .background { if isActive { ActivePill().matchedGeometryEffect(id: "pill", in: pill) } }
        default:
            HStack(spacing: 0) {
                TabButton(tab: tab, isActive: isActive, close: { close(tab.id) }, select: select)
                    .rightClickMenu { menu(for: tab) }
                // The session beside it, in the same tab: a crease between the two.
                if let companion = tab.companion.first {
                    Rectangle()
                        .fill(Surface.hairline(scheme))
                        .frame(width: 1, height: 16)
                    TabButton(tab: companion, isActive: isActive, close: { closeBesideTab?(tab.id) }, select: select)
                        .rightClickMenu { besideMenu(for: tab) }
                }
            }
            .background {
                if isActive {
                    ActivePill()
                        .matchedGeometryEffect(id: "pill", in: pill)
                } else if !tab.companion.isEmpty {
                    // Two sessions in one tab read as one, even out of view.
                    Capsule().strokeBorder(Surface.hairline(scheme))
                }
            }
        }
    }

    private func menu(for tab: TabItem) -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        if let openBeside, tab.id != selection, SidebarView.draftDirectory(from: tab.id) == nil, BotGroups.groupID(fromTab: tab.id) == nil, !MainTerminals.isTerminal(tab.id) {
            items += [ActionItem("Open Beside") { openBeside(tab.id) }]
        }
        // A bot or a group chat is renamed in its editor, not here.
        if let rename, SidebarView.draftDirectory(from: tab.id) == nil, tab.bot == nil, BotGroups.groupID(fromTab: tab.id) == nil, !MainTerminals.isTerminal(tab.id) {
            items += [ActionItem("Rename…") { rename(tab.id) }, .separator()]
        }
        let others = ActionItem("Close Other Tabs") { closeAll(tab.id) }
        others.isEnabled = tabs.count > 1
        return items + [
            ActionItem("Close Tab") { close(tab.id) },
            others,
            .separator(),
            ActionItem("Close All Tabs") { closeAll(nil) },
        ]
    }
}

/// Rex's raised pill: white (a lighter glass in dark mode) with a lit edge, held off the
/// track by a tight contact shadow and a soft one under it.
struct ActivePill: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Capsule()
            .fill(scheme == .dark ? Color.white.opacity(0.17) : Color.white)
            .specularRim(Capsule())
            .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.1), radius: 0.5, y: 0.5)
            .shadow(color: .black.opacity(scheme == .dark ? 0.3 : 0.08), radius: 6, y: 2)
    }
}

private struct TabButton: View {
    let tab: TabItem
    let isActive: Bool
    let close: () -> Void
    /// A second tile behind its own (a split pair shown as one tab).
    var behind: TabItem?
    let select: () -> Void

    @State private var isHovering = false
    @State private var textWidth: CGFloat = 0
    @State private var shownWidth: CGFloat = 0
    private let maxTitleWidth: CGFloat = 190

    var body: some View {
        HStack(spacing: 8) {
            ZStack(alignment: .leading) {
                if let behind {
                    // With its own status: working, or waiting for you, it shows here too.
                    TabIcon(logo: behind.logo, symbol: behind.symbol ?? "bubble.left", bot: behind.bot, botMood: behind.botMood, group: behind.group, status: behind.status)
                        .scaleEffect(0.86)
                        .offset(x: 9, y: -3)
                        .opacity(0.9)
                }
                TabIcon(logo: tab.logo, symbol: tab.symbol ?? (SidebarView.draftDirectory(from: tab.id) == nil ? "bubble.left" : "square.and.pencil"), bot: tab.bot, botMood: tab.botMood, group: tab.group, status: tab.status)
            }
            .padding(.trailing, behind == nil ? 0 : 9)
            Text(tab.title)
                .font(.system(size: 13, weight: isActive ? .medium : .regular))
                .italic(tab.isPreview)
                .foregroundStyle(isActive ? .primary : .secondary)
                .fixedSize()
                .onGeometryChange(for: CGFloat.self, of: \.size.width) { textWidth = $0 }
                // Titles shrink when the window is narrow (rather than the whole
                // strip being pushed into the toolbar's overflow menu).
                .frame(minWidth: 28, maxWidth: min(max(textWidth, 28), maxTitleWidth), alignment: .leading)
                .onGeometryChange(for: CGFloat.self, of: \.size.width) { shownWidth = $0 }
                .clipped()
                // Long titles fade out instead of ending in "…".
                .mask {
                    if textWidth > shownWidth + 0.5 {
                        LinearGradient(stops: [.init(color: .black, location: 0.82), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing)
                    } else {
                        Color.black
                    }
                }
            if tab.closes {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                }
                .buttonStyle(IconButtonStyle(width: 16, height: 16, cornerRadius: 8))
                .opacity(isHovering ? 1 : 0)
                .help("Close Tab")
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 8)
        .frame(height: 30)
        // Another tab lights up under the pointer, like a button.
        .background(isHovering && !isActive ? Pressable.hoverFill : .clear, in: .capsule)
        .contentShape(.capsule)
        .onTapGesture(perform: select)
        .onHover { hovering in withAnimation(.easeOut(duration: 0.12)) { isHovering = hovering } }
        .help(tab.status.help.map { "\(tab.title) — \($0)" } ?? tab.title)
        // One button to VoiceOver and the keyboard, as it is to the pointer, with Close as an action.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tab.status.help.map { "\(tab.title), \($0)" } ?? tab.title)
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { select() }
        .accessibilityActions {
            if tab.closes { Button("Close Tab", action: close) }
        }
    }
}

/// An app-icon tile, like Rex's full-color tab badges: the model maker's logo large, in
/// the maker's own color on a tile washed with it, wrapped tightly in a white rim. How
/// the session is doing shows as a colored badge in its corner, with the sidebar's
/// marks: a spinner while the agent works, a hand while it waits for you, a red mark
/// after a failed run, a dot when a run finished out of sight.
struct TabIcon: View {
    let logo: String?
    /// Shown when there's no logo: a pencil for a draft, a bubble for a session.
    var symbol = "bubble.left"
    /// A bot's tab shows the bot itself in place of the tile.
    var bot: BotLook?
    var botMood: BotMood = .idle
    var group: [GroupAvatar.Face]?
    let status: TabItem.Status

    static let tileSize = CGSize(width: 25, height: 20)

    var body: some View {
        Group {
            if let group {
                GroupAvatar(faces: group, size: 22)
                    .frame(width: Self.tileSize.width, height: Self.tileSize.height)
            } else if let bot {
                // Still: the bot moves in the sidebar or its conversation.
                BotAvatar(look: bot, size: 21, mood: botMood, animates: false)
                    .frame(width: Self.tileSize.width, height: Self.tileSize.height)
            } else {
                FrontTile(logo: logo, symbol: symbol)
            }
        }
            .overlay(alignment: .bottomTrailing) {
                if status != .idle {
                    StatusBadge(status: status)
                        .offset(x: 5, y: 4)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(.ui, value: status)
    }
}

/// How the session is doing, in the tile's corner: the sidebar's marks, each on a glossy
/// disc of its own color (the accent while it works or has news, orange while it waits,
/// red when it failed) inside a white ring.
private struct StatusBadge: View {
    let status: TabItem.Status
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accent) private var accent

    var body: some View {
        ZStack {
            Circle().fill(scheme == .dark ? Color(white: 0.2) : .white)
            switch status {
            case .working:
                disc(accent)
                Spinner(size: 8)
                    .foregroundStyle(.white, .white)
            case .waiting:
                disc(.orange).overlay { mark("hand.raised.fill") }
            case .failed:
                disc(.red).overlay { mark("exclamationmark") }
            case .unread:
                disc(accent).padding(1.5)
            case .idle:
                EmptyView()
            }
        }
        .frame(width: 14, height: 14)
        .shadow(color: .black.opacity(scheme == .dark ? 0.45 : 0.2), radius: 1, y: 0.5)
    }

    /// Lighter at the top, like the system's own badges, so the color reads rich, not flat.
    private func disc(_ color: Color) -> some View {
        Circle()
            .fill(LinearGradient(colors: [color.mix(with: .white, by: 0.3), color], startPoint: .top, endPoint: .bottom))
            .padding(1.5)
    }

    private func mark(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 6.5, weight: .bold))
            .foregroundStyle(.white)
    }
}

/// The white rim around every tile, with a soft shadow so it holds on a white pill. In
/// dark mode the rim is lit from above instead of a flat gray.
private struct TileRim: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .clipShape(.rect(cornerRadius: 5.5))
            .overlay {
                RoundedRectangle(cornerRadius: 5.5)
                    .strokeBorder(
                        scheme == .dark
                            ? AnyShapeStyle(LinearGradient(colors: [.white.opacity(0.8), .white.opacity(0.4)], startPoint: .top, endPoint: .bottom))
                            : AnyShapeStyle(Color.white),
                        lineWidth: 1.5
                    )
            }
            .shadow(color: .black.opacity(scheme == .dark ? 0.45 : 0.22), radius: 1.2, y: 0.5)
    }
}

/// The tile itself: the maker's color with its mark in white, like an app icon, when the mark
/// has a color; otherwise soft white (soft gray in dark mode) with the mark in ink.
private struct FrontTile: View {
    let logo: String?
    let symbol: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let maker = logo.flatMap { ProviderLogo.makerColor($0, in: .light) }
        ZStack {
            if let maker {
                LinearGradient(colors: [maker.mix(with: .white, by: 0.12), maker.mix(with: .black, by: 0.08)], startPoint: .top, endPoint: .bottom)
            } else {
                LinearGradient(
                    colors: scheme == .dark ? [Color(white: 0.3), Color(white: 0.22)] : [Color(white: 0.97), Color(white: 0.9)],
                    startPoint: .top, endPoint: .bottom
                )
            }
            Group {
                if let logo {
                    ProviderLogo(id: logo, size: 13)
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: 10.5, weight: .semibold))
                }
            }
            .foregroundStyle(maker != nil || scheme == .dark ? Color.white : Color(white: 0.18))
        }
        .frame(width: TabIcon.tileSize.width, height: TabIcon.tileSize.height)
        .modifier(TileRim())
    }
}

/// The project the active tab belongs to, and its git branch, at the left of
/// the title bar (where Rex shows the session and its host).
struct ProjectIdentity: View {
    let name: String?
    let branch: String?
    /// Where the session runs, for switching its branch.
    var directory: String?
    /// A session's own worktree keeps its branch.
    var isWorktree = false
    var environment: [String: String] = [:]
    @Binding var showsSidebar: Bool
    /// After switching branches.
    var switched: () -> Void = {}

    var body: some View {
        HStack(spacing: 10) {
            SidebarToggle(showsSidebar: $showsSidebar)

            if let name {
                CappedWidth(max: 220) {
                    // A gap under the name for the branch's hover fill, which reaches above the branch.
                    VStack(alignment: .leading, spacing: 3) {
                        Text(name)
                            .font(.system(size: 13, weight: .semibold))
                        if let branch {
                            if let directory, !isWorktree {
                                BranchSwitcher(branch: branch, directory: directory, environment: environment, switched: switched)
                            } else {
                                BranchLabel(branch: branch)
                                    .help(isWorktree ? "This session's own branch, in its worktree" : "")
                            }
                        }
                    }
                    .lineLimit(1)
                    .truncationMode(.tail)
                }
            }
        }
    }
}

/// As wide as its content, up to `max` and the room there is: a long name (a worktree's branch
/// is its session's title) truncates and leaves the tabs room, and a short one leaves no gap
/// before them. Sized in layout, so it follows its content through animations.
struct CappedWidth: Layout {
    var max: CGFloat = .infinity

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        let width = Swift.min(view.sizeThatFits(.unspecified).width, max, proposal.width ?? .infinity)
        return CGSize(width: width, height: view.sizeThatFits(ProposedViewSize(width: width, height: proposal.height)).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}

private struct BranchLabel: View {
    let branch: String
    /// A menu: a chevron says so, and the ink is left to the button style.
    var isMenu = false

    var body: some View {
        HStack(spacing: 3) {
            Label(branch, systemImage: "arrow.triangle.branch")
                .labelStyle(.titleAndIcon)
                .imageScale(.small)
            if isMenu {
                Image(systemName: "chevron.down")
                    .font(.system(size: 7, weight: .bold))
                    .accessibilityHidden(true)
            }
        }
        .font(.system(size: 11))
        .foregroundStyle(isMenu ? AnyShapeStyle(.foreground) : AnyShapeStyle(.secondary))
    }
}

/// The branch under the project's name, as a menu: switch to another of the repository's
/// branches (the latest first), or start a new one, named right there.
private struct BranchSwitcher: View {
    let branch: String
    let directory: String
    let environment: [String: String]
    let switched: () -> Void
    @State private var branches: [String] = []
    /// A new branch's name being typed, where the branch shows.
    @State private var isNaming = false
    @State private var failure: String?

    var body: some View {
        if isNaming {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
                // Made only on Return: clicking away makes no branch.
                InlineTitleField(original: "", prompt: "New branch from \(branch)", keepsOnLeaving: false) { name in
                    isNaming = false
                    run(["switch", "-c", name], created: true)
                } cancel: {
                    isNaming = false
                }
                .frame(minWidth: 100, maxWidth: 190)
            }
            .font(.system(size: 11))
            .help("Return makes it. It starts from \(branch), and changes you haven't committed come along.")
        } else {
            menu
        }
    }

    private var menu: some View {
        Menu {
            if branches.count > 1 {
                Section("Switch To") {
                    ForEach(branches.filter { $0 != branch }.prefix(15), id: \.self) { name in
                        Button(name) { run(["switch", name], created: false) }
                    }
                }
            }
            Button("New Branch…") {
                isNaming = true
            }
        } label: {
            BranchLabel(branch: branch, isMenu: true)
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        // The fill hugs the label without moving it out of line with the project's name.
        .buttonStyle(TextButtonStyle(cornerRadius: 4, outset: true))
        .fixedSize()
        .help("Switch branches, or start a new one")
        .task(id: directory + "\n" + branch) { await load() }
        // Branches made elsewhere show up the next time the pointer comes by.
        .onHover { if $0 { Task { await load() } } }
        .alert("Couldn't Switch Branches", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK") {}
        } message: {
            Text(failure ?? "")
        }
    }

    private func load() async {
        let directory = directory
        let list = await Task.detached {
            Git.run(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"], in: directory) ?? ""
        }.value
        branches = list.split(separator: "\n").map(String.init)
    }

    private func run(_ arguments: [String], created: Bool) {
        guard arguments.last?.isEmpty == false else { return }
        let directory = directory, environment = environment
        Task {
            failure = await Task.detached { Git.report(arguments, in: directory, environment: environment) }.value
            if failure == nil { Analytics.shared.track("branch_switched", ["created": created]) }
            switched()
        }
    }
}

/// Shows or hides the sessions sidebar: in the title bar, or alone by the window's buttons when
/// the tab bar is hidden.
struct SidebarToggle: View {
    @Binding var showsSidebar: Bool

    var body: some View {
        Button {
            withAnimation(.ui) { showsSidebar.toggle() }
        } label: {
            Image(systemName: "sidebar.left")
                .font(.system(size: 14))
        }
        .buttonStyle(IconButtonStyle(width: 28, height: 28, cornerRadius: 7))
        .accessibilityLabel(showsSidebar ? "Hide Sessions" : "Show Sessions")
        .help(showsSidebar ? "Hide Sessions (⌘0)" : "Show Sessions (⌘0)")
    }
}

/// Shows or hides the side panel: mirrors the sessions toggle on the left, and looks the same,
/// a plain icon, not a highlighted toggle.
struct PanelToggle: View {
    @Binding var showsPanel: Bool

    var body: some View {
        Button {
            withAnimation(.ui) { showsPanel.toggle() }
        } label: {
            Image(systemName: "sidebar.right")
                .font(.system(size: 14))
        }
        .buttonStyle(IconButtonStyle(width: 28, height: 28, cornerRadius: 7))
        .accessibilityLabel(showsPanel ? "Hide Panel" : "Show Panel")
        .help(showsPanel ? "Hide Panel (⌥⌘0)" : "Show Panel: Changes, Files, Terminal, Browser (⌥⌘0)")
    }
}

/// Reports where it sits in its window, horizontally: for lining up title bar items, which live
/// in the toolbar's own views, with the window's content.
struct WindowXReader: NSViewRepresentable {
    let changed: (CGFloat) -> Void

    func makeNSView(context: Context) -> Reader { Reader(changed: changed) }

    func updateNSView(_ view: Reader, context: Context) {
        view.changed = changed
        view.report()
    }

    final class Reader: NSView {
        var changed: (CGFloat) -> Void
        private var reported: CGFloat?

        init(changed: @escaping (CGFloat) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func layout() {
            super.layout()
            report()
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            report()
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func report() {
            guard window != nil else { return }
            let x = convert(bounds.origin, to: nil).x
            guard x != reported else { return }
            reported = x
            // After the layout pass that moved it, not during it.
            DispatchQueue.main.async { [changed] in changed(x) }
        }
    }
}

/// The window, as the title bar follows it: being resized by a drag. It also keeps the window
/// out of full screen: the green button fills the screen with the window as it is. (In full
/// screen, AppKit painted a strip of its own at the top, a gray band unlike the rest of the
/// window, which nothing here could reach.)
struct WindowStateReader: NSViewRepresentable {
    struct State: Equatable {
        var isResizing = false
    }

    let changed: (State) -> Void

    func makeNSView(context: Context) -> Reader { Reader(changed: changed) }

    func updateNSView(_ view: Reader, context: Context) {
        view.changed = changed
    }

    final class Reader: NSView {
        var changed: (State) -> Void
        private var observers: [NSObjectProtocol] = []
        private var state = State()

        init(changed: @escaping (State) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { return }
            Self.keepOutOfFullScreen(window)
            // Again whenever it comes forward, in case SwiftUI set the window up anew.
            observers.append(NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak window] _ in
                MainActor.assumeIsolated { if let window { Self.keepOutOfFullScreen(window) } }
            })
            for name in [NSWindow.willStartLiveResizeNotification, NSWindow.didEndLiveResizeNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] note in
                    let isResizing = note.name == NSWindow.willStartLiveResizeNotification
                    MainActor.assumeIsolated { self?.report(State(isResizing: isResizing)) }
                })
            }
        }

        private static func keepOutOfFullScreen(_ window: NSWindow) {
            guard !window.collectionBehavior.contains(.fullScreenNone) else { return }
            window.collectionBehavior.remove(.fullScreenPrimary)
            window.collectionBehavior.insert(.fullScreenNone)
        }

        private func report(_ next: State) {
            guard next != state else { return }
            state = next
            DispatchQueue.main.async { [changed] in changed(next) }
        }
    }
}
