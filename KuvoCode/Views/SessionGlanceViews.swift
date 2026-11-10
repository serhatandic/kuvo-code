import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI

// A session's row at a glance (#395, KuvoLink's PROTOCOL.md, "A session at a glance"): the one mark
// it gains before its state's, and the card that opens beside it as the pointer settles on it. What
// they say comes from its box (`RowGlances`); how they look, from ClientDesign, as on the phone.

/// The mark a session's row gains before its state's: its pull request's, in its state's color (red
/// all over while a check fails), else the branch it has of its own. None for a session in its
/// project's own checkout.
struct SessionRowMark: View {
    let session: Session
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @Environment(\.messageFont) private var messageFont

    var body: some View {
        switch SessionGlance.rowMark(app.glances.glances[session.id], worktreeBranch: workspace.worktrees[session.location.directory]?.branch) {
        case .pull(let pull)?:
            PullMark(pull, size: (12.5 * messageFont.sidebarScale).rounded())
        case .branch(let branch)?:
            Image(systemName: "arrow.triangle.branch")
                .sidebarFont(11)
                .foregroundStyle(.tertiary)
                .accessibilityLabel("On \(branch)")
        case nil:
            EmptyView()
        }
    }
}

/// A session's row: what its box says of it followed while it's on screen, and its card beside it
/// half a second after the pointer settles on it (at once while another row's is open).
struct SessionGlanceHover: ViewModifier {
    let session: Session
    /// Which row it is, as the sidebar tells them apart (a session shows in Recents and its project).
    let row: String
    /// Under its project's heading, which says its folder.
    let underItsProject: Bool
    /// In search results that span your computers, which don't say which it's on.
    let acrossComputers: Bool
    let isUnread: Bool
    /// Out of view under its row, as its mark has them.
    let folded: [Session]
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @Environment(\.messageFont) private var messageFont
    @State private var anchor = GlanceAnchor()
    @State private var isVisible = false

    private var box: String { SidebarBox(directory: session.location.directory).id }

    func body(content: Content) -> some View {
        content
            .background(GlanceAnchorView(anchor: anchor))
            .onHover { inside in
                if inside {
                    let card = GlanceCardForRow(id: session.id, fallback: session, underItsProject: underItsProject, acrossComputers: acrossComputers,
                                                isUnread: isUnread, folded: folded)
                        .environment(workspace)
                        .environment(app)
                        .environment(\.messageFont, messageFont)
                    GlanceCardPanel.shared.entered(row, anchor: anchor) { AnyView(card) }
                } else {
                    GlanceCardPanel.shared.left(row)
                }
            }
            .onScrollVisibilityChange(threshold: 0.01) { visible in
                guard visible != isVisible else { return }
                isVisible = visible
                app.glances.show(session.id, on: box, visible)
            }
            .onDisappear {
                GlanceCardPanel.shared.left(row)
                if isVisible {
                    isVisible = false
                    app.glances.show(session.id, on: box, false)
                }
            }
    }
}

/// The card for a row: its state as its row's mark has it, how long ago, and what its box says of
/// it, read as they change while it's open.
struct GlanceCardForRow: View {
    let id: String
    /// The session as the row had it, for one that's gone meanwhile.
    let fallback: Session
    let underItsProject: Bool
    let acrossComputers: Bool
    let isUnread: Bool
    let folded: [Session]
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @Environment(\.messageFont) private var messageFont

    var body: some View {
        let session = workspace.session(id) ?? fallback
        let glance = app.glances.glances[id]
        let state = statusMark(of: session, isNew: isUnread, folded: folded, workspace: workspace, app: app)
        let directory = session.location.directory
        let place = SidebarBox(directory: directory)
        let catalog = app.catalog(for: place)
        let model = session.model.flatMap { catalog.model($0) }
        let effort = session.model?.variant.flatMap { $0 == ModelRef.defaultVariant ? nil : EffortLevel.title($0) }
        let isChat = Workspace.isChat(directory)
        SessionGlanceCard(
            glance: glance, state: state,
            since: GlanceAge.since(state, asked: glance?.asked, idle: session.time.idle, updated: session.time.updated),
            branch: glance?.branch ?? workspace.worktrees[directory]?.branch,
            model: model?.name ?? session.model?.id, details: SessionGlance.details(effort: effort, account: glance?.account),
            folder: SessionGlance.showsFolder(underItsProject: underItsProject, isChat: isChat) ? workspace.projectName(directory) : nil,
            computer: SessionGlance.showsComputer(acrossComputers: acrossComputers) ? .init(name: app.name(of: place), isMachine: place.machine != nil) : nil,
            size: (13 * messageFont.sidebarScale).rounded()
        ) {
            if let ref = session.model {
                ProviderLogo(id: model?.makerLogoID ?? ref.providerID, size: (14 * messageFont.sidebarScale).rounded())
            }
        }
    }
}

/// Where a row is, for its card to open beside it.
@MainActor final class GlanceAnchor {
    weak var view: NSView?

    /// The row's frame on the screen, and its window.
    var place: (frame: NSRect, window: NSWindow)? {
        guard let view, let window = view.window else { return nil }
        return (window.convertToScreen(view.convert(view.bounds, to: nil)), window)
    }
}

private struct GlanceAnchorView: NSViewRepresentable {
    let anchor: GlanceAnchor

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        anchor.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        anchor.view = view
    }
}

/// The card beside the sidebar, as Copilot's is: a borderless card floating over the window, without
/// an arrow, its first line beside the row. One at a time; it takes no clicks, and goes as the
/// pointer leaves the row, a row is clicked, a menu opens or the list scrolls.
@MainActor final class GlanceCardPanel {
    static let shared = GlanceCardPanel()

    /// The room around the card for its shadow.
    private static let margin: CGFloat = 28
    /// How long the pointer settles on a row before its card opens.
    static let settle: Duration = .milliseconds(500)

    private var panel: NSPanel?
    private var host: NSHostingView<AnyView>?
    /// The row whose card is open, and where it is.
    private(set) var shown: String?
    private var anchor: GlanceAnchor?
    private var opening: Task<Void, Never>?
    private var closing: Task<Void, Never>?
    private var watchers: [any NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        for name in [NSMenu.didBeginTrackingNotification, NSApplication.didResignActiveNotification, NSWindow.didResignKeyNotification] {
            watchers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { GlanceCardPanel.shared.hide() }
            })
        }
    }

    /// The pointer came onto `row`: its card, at once while another's is open, else once it settles.
    func entered(_ row: String, anchor: GlanceAnchor, card: @escaping () -> AnyView) {
        closing?.cancel()
        opening?.cancel()
        if shown != nil {
            show(row, anchor: anchor, card: card())
            return
        }
        opening = Task { [weak self] in
            try? await Task.sleep(for: Self.settle)
            guard !Task.isCancelled else { return }
            self?.show(row, anchor: anchor, card: card())
        }
    }

    /// The pointer left `row`: its card goes, a moment later, unless it came onto another row.
    func left(_ row: String) {
        opening?.cancel()
        guard shown == row else { return }
        closing?.cancel()
        closing = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            self?.hide()
        }
    }

    func hide() {
        opening?.cancel()
        closing?.cancel()
        guard let panel, shown != nil else { return }
        shown = nil
        anchor = nil
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }

    private func show(_ row: String, anchor: GlanceAnchor, card: AnyView) {
        guard let found = anchor.place, found.window.isVisible else { return }
        let (frame, window) = (found.frame, found.window)
        let panel = panel ?? makePanel()
        let content = AnyView(GlanceCardChrome(content: card) { [weak self] in self?.place() }.padding(Self.margin))
        if let host { host.rootView = content } else {
            let host = NSHostingView(rootView: content)
            panel.contentView = host
            self.host = host
        }
        panel.appearance = window.effectiveAppearance
        shown = row
        self.anchor = anchor
        if panel.parent !== window {
            panel.parent?.removeChildWindow(panel)
            window.addChildWindow(panel, ordered: .above)
        }
        place(beside: frame, in: window)
        if !panel.isVisible {
            panel.alphaValue = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 1 : 0
            panel.orderFront(nil)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                panel.animator().alphaValue = 1
            }
        }
    }

    /// Placed again as its card's size changes (a line comes or goes while it's open).
    private func place() {
        guard let found = anchor?.place else { return }
        place(beside: found.frame, in: found.window)
    }

    /// Beside the row, past the sidebar's edge, its first line level with the row; kept on the screen.
    private func place(beside row: NSRect, in window: NSWindow) {
        guard let panel, let host else { return }
        let size = host.fittingSize
        let margin = Self.margin
        // The card's first line is about its padding and half a line down from its top.
        var top = row.midY + 22 + margin
        var left = row.maxX + 4 - margin
        if let screen = window.screen?.visibleFrame {
            top = min(max(top, screen.minY + size.height), screen.maxY + margin)
            left = min(left, screen.maxX - size.width + margin)
        }
        panel.setFrame(NSRect(x: left, y: top - size.height, width: size.width, height: size.height), display: true)
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = true
        panel.animationBehavior = .none
        panel.collectionBehavior = [.transient, .ignoresCycle]
        self.panel = panel
        return panel
    }
}

/// The card on its surface, telling its panel as its size changes.
private struct GlanceCardChrome: View {
    let content: AnyView
    let resized: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        content
            .glanceCardSurface(scheme)
            .onGeometryChange(for: CGSize.self, of: { $0.size }) { _ in
                DispatchQueue.main.async { resized() }
            }
    }
}
