import AppKit
import ClientDesign
import ClientSessions
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
    /// Expanded over the conversation.
    let isExpanded: PaneSwitch
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
        .task(id: followsQueue ? queueKey : nil) {
            if followsQueue { await app.workQueues.follow(queueKey) }
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
                                // (The Work Queue's says how many items too: "Work Queue · 24 items".)
                                .frame(minWidth: 120, maxWidth: tab.kind == .workQueue ? 226 : 190)
                                .id(tab.id)
                                .heldContextMenu {
                                    HeldRow.button("Close Tab") { withAnimation(.ui) { utilities.close(tab.id) } }
                                    HeldRow.button("Close Other Tabs", disabled: utilities.visibleTabs.count < 2) {
                                        withAnimation(.ui) { for other in utilities.visibleTabs where other.id != tab.id { utilities.close(other.id) } }
                                    }
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
            let expanded = isExpanded.isOn()
            Button { withAnimation(.ui) { isExpanded.set(!expanded) } } label: {
                Label(expanded ? "Restore" : "Expand", systemImage: expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
            }
            .buttonStyle(PanelIconStyle())
            .help(expanded ? "Restore" : "Expand")
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
        case .workQueue:
            app.workQueues.views[queueKey].map { "Work Queue · " + WorkQueue.openWords(WorkQueue.openCount($0)).lowercased() } ?? "Work Queue"
        }
    }

    /// The Work Queue view the panel shows (see `WorkQueuePanel`): followed while its tab is open,
    /// so the tab's count stays current on another tab too.
    private var queueKey: WorkQueues.Key { app.workQueues.key(for: utilities) }

    private var followsQueue: Bool { utilities.visibleTabs.contains { $0.kind == .workQueue } }

    private func icon(for tab: Utilities.Tab) -> TabGlyph {
        switch tab.kind {
        case .changes: .symbol("plus.forwardslash.minus")
        case .file(let url): .symbol(url == nil ? "folder" : "doc")
        case .terminal: .symbol("apple.terminal")
        case .browser:
            if let site = utilities.history.site(for: utilities.browsers[tab.id]?.url), let image = utilities.history.icon(for: site) {
                .image(image)
            } else {
                .symbol("globe")
            }
        case .machinePage(let machine, let page):
            if let site = utilities.history.site(for: app.machines.engine(machine)?.browser.url(of: page)), let image = utilities.history.icon(for: site) {
                .image(image)
            } else {
                .symbol("globe")
            }
        case .workQueue: .symbol("checklist")
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
                } else if let url {
                    // A file a group chat's bot showed: with its folder beside it.
                    let folder = tab.folder ?? RemoteFolder.folder(of: url.deletingLastPathComponent())
                    FilesView(roots: [folder], file: url, showsTree: $utilities.showsTree, reveal: utilities.treeReveal, revealed: utilities.revealed) { utilities.open($0) }
                        .id(folder)
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
                if let engine = app.machines.engine(machine) {
                    let browser = engine.browser
                    // A machine that can't be reached, and nothing live from its browser (which
                    // keeps its own link through a restart or a moment without the engine's
                    // events): what's happening there and a way to try again, rather than a
                    // browser that can't start.
                    if !engine.isReady, browser.state != .live {
                        MachineWaitingView(engine: engine, note: "Its pages show here once it’s back.")
                    } else {
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
                    }
                } else {
                    placeholder("Machine Removed", symbol: "server.rack", detail: "\(machine) isn’t one of your machines anymore. Close this tab.")
                }
            case .workQueue:
                WorkQueuePanel(utilities: utilities)
            }
        } else {
            // A panel with no tab for a moment (its conversation is going): the strip stays at the
            // top, which it wouldn't with nothing here to fill the card.
            Color.clear
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
            .accessibilityLabel("Close Tab")
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

extension EnvironmentValues {
    /// The panel is on screen. Hidden, it's kept as it was for showing again, and what it shows
    /// stops its work meanwhile: no looking at git or files again, no live page from a machine,
    /// and its pages and terminals hidden from AppKit (`PanelVisibility`), so they don't draw.
    @Entry var isPanelShown = true
}

/// A page or a terminal in the panel, hidden from AppKit as the panel is: once it has slid out of
/// sight (it slides out showing), and shown again as it comes back. Hidden, a page is as it was
/// out of the window, which it was while the panel was made again each time: it stops drawing.
@MainActor
final class PanelVisibility {
    private var isShown = true
    /// Counts the panel's hides and shows, for a slide's end to tell whether it's still the latest.
    private var turns = 0

    /// `away` stops what else the view does while it's hidden: called with true as it's hidden,
    /// false as it's back.
    func update<Host: NSViewRepresentable>(_ view: NSView, in context: NSViewRepresentableContext<Host>, away: ((Bool) -> Void)? = nil) {
        let shown = context.environment.isPanelShown
        defer { isShown = shown }
        if shown {
            if !isShown { turns += 1 }
            if view.isHidden {
                view.isHidden = false
                away?(false)
            }
        } else if isShown {
            turns += 1
            let turn = turns
            context.animate {} completion: { [weak self, weak view] in
                // Unless it's come back since, or gone again and still sliding.
                guard let self, let view, self.turns == turn, !view.isHidden else { return }
                // Hidden with the keyboard in it, AppKit would hand the keyboard to the next view
                // along; it goes nowhere, as when the panel left the window, for the window to
                // give it back to where you typed.
                if let window = view.window, let responder = window.firstResponder as? NSView, responder.isDescendant(of: view) {
                    window.makeFirstResponder(nil)
                }
                view.isHidden = true
                away?(true)
            }
        }
    }
}
