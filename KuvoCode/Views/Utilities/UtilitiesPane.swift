import AppKit
import SwiftUI

/// The right panel: a card whose header is a strip of tabs (Changes, files, terminals,
/// browsers), with + for a new tab, then expand. The title bar's button shows and hides it.
struct UtilitiesPane: View {
    @Bindable var utilities: Utilities
    /// The project in view; files and terminals start there.
    let directory: String?
    /// All of the project's folders, the primary one first.
    var folders: [String] = []
    let model: SessionModel?
    let environment: [String: String]
    @Binding var isExpanded: Bool
    var isFocused = true
    @Environment(\.windowControlsInset) private var windowControlsInset
    @Environment(\.windowControlsTrailingInset) private var windowControlsTrailingInset
    @Environment(AppModel.self) private var app
    @State private var tabsOverflow = TabsOverflow()

    var body: some View {
        Card(title: "", isFocused: isFocused, showsHeader: false) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                tabStrip
                // A tab whose content can't shrink to the panel is cut off at its edges rather
                // than drawn over the conversation.
                content
                    .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
                    // Scroll bars shown all the time (a Mac set to always show them) took a
                    // strip off every tab; the panel scrolls without them, as the sidebar does.
                    .scrollIndicators(.never)
            }
        }
    }

    // MARK: Tabs

    private var tabStrip: some View {
        HStack(spacing: 6) {
            // Tabs keep a width you can read their names at; past what fits, the row scrolls
            // sideways, faded at the edge that has more. The row is as wide as the tabs while they
            // fit, so New Tab follows the last one, then the room there is. That's worked out in
            // layout, not measured afterwards, so the row moves with the tabs when one closes.
            CappedWidth {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal) {
                        HStack(spacing: 4) {
                            ForEach(utilities.visibleTabs) { tab in
                                UtilityTabButton(
                                    title: title(for: tab),
                                    icon: icon(for: tab),
                                    isSelected: tab.id == utilities.selected?.id,
                                    select: { utilities.choose(tab.id) },
                                    close: { withAnimation(.ui) { utilities.close(tab.id) } }
                                )
                                .frame(minWidth: 120, maxWidth: 190)
                                .id(tab.id)
                                .contextMenu {
                                    Button("Close Tab") { withAnimation(.ui) { utilities.close(tab.id) } }
                                    Button("Close Other Tabs") {
                                        withAnimation(.ui) { for other in utilities.visibleTabs where other.id != tab.id { utilities.close(other.id) } }
                                    }
                                    .disabled(utilities.visibleTabs.count < 2)
                                }
                            }
                        }
                        // Room for the chosen tab's lit edge, which the scroll view would cut off.
                        .padding(1)
                    }
                    .scrollIndicators(.never)
                    .onScrollGeometryChange(for: TabsOverflow.self) { geometry in
                        TabsOverflow(
                            before: geometry.contentOffset.x > 1,
                            after: geometry.contentOffset.x + geometry.containerSize.width < geometry.contentSize.width - 1
                        )
                    } action: { _, overflow in
                        tabsOverflow = overflow
                    }
                    // The chosen tab, toward the middle where it can be so the tabs beside it show
                    // too; at the ends, the row stops at its edge. When it's chosen, and when tabs
                    // come and go (the row's width changes, from its first layout on), gliding along
                    // with them rather than jumping.
                    .onChange(of: utilities.selected?.id) { _, id in
                        guard let id else { return }
                        withAnimation(.ui) { proxy.scrollTo(id, anchor: .center) }
                    }
                    .onScrollGeometryChange(for: CGFloat.self, of: \.contentSize.width) { old, _ in
                        guard let id = utilities.selected?.id else { return }
                        if old == 0 {
                            proxy.scrollTo(id, anchor: .center)
                        } else {
                            withAnimation(.ui) { proxy.scrollTo(id, anchor: .center) }
                        }
                    }
                    .mask { tabsFade }
                }
            }
            Button { withAnimation(.ui) { utilities.newTab() } } label: {
                Label("New Tab", systemImage: "plus")
            }
            .buttonStyle(PanelIconStyle())
            .help("New Tab")
            Spacer(minLength: 0)
            Button { withAnimation(.ui) { isExpanded.toggle() } } label: {
                Label(isExpanded ? "Restore" : "Expand", systemImage: isExpanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
            }
            .buttonStyle(PanelIconStyle())
            .help(isExpanded ? "Restore" : "Expand")
        }
        .padding(.leading, 8 + windowControlsInset)
        .padding(.trailing, 8 + windowControlsTrailingInset)
        .frame(height: 44)
    }

    /// The tabs row faded where there are more tabs to scroll to.
    private var tabsFade: some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                .frame(width: tabsOverflow.before ? 24 : 0)
            Color.black
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: tabsOverflow.after ? 24 : 0)
        }
        .animation(.easeOut(duration: 0.15), value: tabsOverflow)
    }

    private func title(for tab: Utilities.Tab) -> String {
        switch tab.kind {
        case .changes: "Changes"
        case .file(let url): url?.lastPathComponent ?? "Files"
        case .terminal: utilities.terminals[tab.id]?.title ?? "Terminal"
        case .browser: utilities.browsers[tab.id]?.displayTitle ?? "New Tab"
        case .machinePage(let machine, let page):
            app.machines.engine(machine)?.browser.page(page)?.name ?? "New Tab"
        case .subagent(let id, _):
            app.workspace.subagentTitle(id) ?? "Subagent"
        }
    }

    private func icon(for tab: Utilities.Tab) -> TabGlyph {
        switch tab.kind {
        case .changes: .symbol("plus.forwardslash.minus")
        case .file(let url): .symbol(url == nil ? "folder" : "doc")
        case .terminal: .symbol("apple.terminal")
        case .browser:
            if let browser = utilities.browsers[tab.id], let host = browser.url?.host()?.replacingOccurrences(of: "www.", with: ""),
               let site = utilities.history.sites.first(where: { $0.host == host }), let image = utilities.history.icon(for: site) {
                .image(image)
            } else {
                .symbol("globe")
            }
        case .machinePage(let machine, let page):
            if let url = app.machines.engine(machine)?.browser.url(of: page), let host = url.host()?.replacingOccurrences(of: "www.", with: ""),
               let site = utilities.history.sites.first(where: { $0.host == host }), let image = utilities.history.icon(for: site) {
                .image(image)
            } else {
                .symbol("globe")
            }
        case .subagent: .symbol("person.2")
        }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if let tab = utilities.selected {
            switch tab.kind {
            case .changes:
                if let directory {
                    ChangesPanel(directory: directory, folders: folders, model: model)
                        .id(folders.joined(separator: "\n") + directory)
                } else {
                    placeholder("No Project", symbol: "plus.forwardslash.minus", detail: "Open a project to see its changes.")
                }
            case .file(let url):
                if let directory {
                    FilesView(roots: folders.isEmpty ? [directory] : folders, file: url, showsTree: $utilities.showsTree, reveal: utilities.treeReveal, revealed: utilities.revealed) { utilities.open($0) }
                        .id(folders.joined(separator: "\n") + directory)
                } else {
                    placeholder("No Project", symbol: "folder", detail: "Open a project to browse its files.")
                }
            case .terminal:
                if let session = utilities.terminals[tab.id] {
                    TerminalHost(session: session)
                        .id(tab.id)
                } else {
                    placeholder("Terminal Closed", symbol: "terminal", detail: "Close this tab, or open a new one.")
                }
            case .browser:
                if let session = utilities.browsers[tab.id] {
                    BrowserPane(session: session, attach: attachToMessage) {
                        NewTabPage(utilities: utilities, tabID: tab.id, directory: directory, environment: environment) { address in
                            session.load(address)
                        } openInNewTab: { address in
                            utilities.newBrowser(address)
                        }
                    }
                    .id(tab.id)
                } else {
                    placeholder("Page Closed", symbol: "globe", detail: "Close this tab, or open a new one.")
                }
            case .machinePage(let machine, let page):
                if let engine = app.machines.engine(machine), engine.connection != .connected {
                    // Its pages are on the machine: until it's back, what's happening there and a
                    // way to try again, rather than a browser that can't start.
                    MachineWaitingView(engine: engine)
                } else if let browser = app.machines.engine(machine)?.browser {
                    MachineBrowserPane(browser: browser, page: page, attach: attachToMessage) {
                        NewTabPage(utilities: utilities, tabID: tab.id, directory: directory, environment: environment) { address in
                            // A new tab opens its page; a blank page goes there.
                            if page == nil { utilities.open(address, inTab: tab.id) } else { browser.load(address) }
                        } openInNewTab: { address in
                            utilities.newMachinePage(machine, address: address)
                        }
                    } onSubmit: { address in
                        utilities.open(address, inTab: tab.id)
                    }
                    .id(tab.id)
                } else {
                    placeholder("Machine Removed", symbol: "server.rack", detail: "\(machine) isn’t one of your machines anymore. Close this tab.")
                }
            case .subagent(let id, let folder):
                SubagentPane(id: id, folder: folder)
                    .id(tab.id)
            }
        }
    }

    /// Add Screenshot to Message, for a conversation whose message can carry files: not a group
    /// chat's, which takes words only.
    private var attachToMessage: (([URL]) -> Void)? {
        utilities.inView.group == nil ? { [utilities] files in utilities.attachToMessage?(files) } : nil
    }

    private func placeholder(_ title: String, symbol: String, detail: String) -> some View {
        ContentUnavailableView(title, systemImage: symbol, description: Text(detail))
            .frame(maxHeight: .infinity)
    }
}

/// What a tab shows before its title: a symbol, or a site's own icon.
enum TabGlyph {
    case symbol(String)
    case image(NSImage)
}

/// A tab in the panel's strip, like a browser's: icon and title in a rounded tab, the
/// selected one raised, and a close button on hover.
private struct UtilityTabButton: View {
    let title: String
    let icon: TabGlyph
    let isSelected: Bool
    let select: () -> Void
    let close: () -> Void
    @State private var isHovering = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 7) {
            Group {
                switch icon {
                case .symbol(let name):
                    Image(systemName: name)
                        .font(.system(size: 12))
                case .image(let image):
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .clipShape(.rect(cornerRadius: 3))
                        .frame(width: 14, height: 14)
                }
            }
            .frame(width: 16)
            .foregroundStyle(isSelected ? .primary : .secondary)
            Text(title)
                .font(.system(size: 13, weight: isSelected ? .medium : .regular))
                .foregroundStyle(isSelected ? .primary : .secondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
            }
            .buttonStyle(IconButtonStyle(width: 16, height: 16, cornerRadius: 8))
            .opacity(isHovering || isSelected ? 1 : 0)
            .help("Close Tab")
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(height: 30)
        .background {
            if isSelected {
                // A lit chip: a firmer fill than hover's, with a bright edge, on a white card
                // as well as an ivory one.
                RoundedRectangle(cornerRadius: 9)
                    .fill(scheme == .dark ? Color.white.opacity(0.1) : Surface.slate.opacity(0.07))
                    .specularRim(RoundedRectangle(cornerRadius: 9))
            } else if isHovering {
                RoundedRectangle(cornerRadius: 9)
                    .fill(Color.primary.opacity(0.04))
            }
        }
        .contentShape(.rect(cornerRadius: 9))
        .onTapGesture(perform: select)
        .onHover { isHovering = $0 }
        .help(title)
        // A tab to pick for VoiceOver, which has no tap to make, and Close Tab, whose button shows
        // only on hover.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction(.default, select)
        .accessibilityAction(named: "Close Tab", close)
    }
}

/// Icon buttons in the panel's chrome: quiet until hovered, on a rounded square.
struct PanelIconStyle: ButtonStyle {
    @State private var isHovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 13))
            .foregroundStyle(isHovering ? .primary : .secondary)
            .frame(width: 28, height: 28)
            .background(isHovering ? Color.primary.opacity(0.07) : .clear, in: .rect(cornerRadius: 8))
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(.rect)
            .onHover { isHovering = $0 }
            .clickablePointer()
    }
}

/// Whether the panel's tabs have more to scroll to before or after what shows.
private struct TabsOverflow: Equatable {
    var before = false
    var after = false
}
