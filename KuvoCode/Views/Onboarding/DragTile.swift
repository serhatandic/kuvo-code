import AppKit
import QuartzCore
import SwiftUI

/// The small window beside System Settings while it's open for a permission: Kuvo Code's icon, to
/// drag into the list, the way you'd drag an app from Finder. It follows System Settings' window,
/// and goes when that closes, when the permission is allowed, or when you close it.
@MainActor
final class DragTile {
    private var panel: NSPanel?
    private var follow: Timer?
    private var closed: (() -> Void)?
    /// System Settings had a window: one gone after that means it closed.
    private var sawSettings = false

    func show(for permission: ScreenAccess.Permission, closed: @escaping () -> Void) {
        self.closed = closed
        sawSettings = false
        let panel = panel ?? makePanel()
        self.panel = panel
        panel.contentView = NSHostingView(rootView: DragTileView(permission: permission) { [weak self] in self?.close() })
        panel.setContentSize(panel.contentView?.fittingSize ?? NSSize(width: 240, height: 200))
        place()
        panel.orderFrontRegardless()
        follow?.invalidate()
        follow = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.place() }
        }
    }

    func hide() {
        follow?.invalidate()
        follow = nil
        closed = nil
        panel?.orderOut(nil)
    }

    private func close() {
        let closed = closed
        hide()
        closed?()
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 240, height: 200), styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: true)
        // Over System Settings, which is in front while you drag.
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        return panel
    }

    /// Beside System Settings' window, on the side with room, a little below its top: where the
    /// list is. Before its window shows, at the right of the screen; while it's away (another
    /// Space, in the Dock), where it was.
    private func place() {
        guard let panel else { return }
        let size = panel.frame.size
        guard let settings = SystemSettings.windowFrame else {
            // It quit: so does this.
            if sawSettings { return SystemSettings.isRunning ? () : close() }
            let screen = NSScreen.main?.visibleFrame ?? .zero
            panel.setFrameOrigin(NSPoint(x: screen.maxX - size.width - 40, y: screen.midY - size.height / 2))
            return
        }
        sawSettings = true
        let screen = NSScreen.screens.first { $0.frame.intersects(settings) }?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let gap: CGFloat = 14
        var x = settings.maxX + gap
        if x + size.width > screen.maxX { x = settings.minX - gap - size.width }
        if x < screen.minX { x = settings.maxX - size.width - 20 }
        let y = min(max(settings.maxY - 140 - size.height, screen.minY + 10), screen.maxY - size.height)
        let target = NSRect(origin: NSPoint(x: x, y: y), size: size)
        guard target.origin != panel.frame.origin else { return }
        panel.setFrame(target, display: true, animate: false)
    }
}

/// What the drag window shows.
struct DragTileView: View {
    let permission: ScreenAccess.Permission
    let close: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            AppIconDragSource()
                .frame(width: 64, height: 64)
                .accessibilityLabel("\(AppInfo.name)’s icon. Drag it into the list in System Settings.")
            VStack(spacing: 3) {
                Text("Drag \(AppInfo.name) into the list")
                    .font(.headline)
                Text("Then switch it on. This window goes away by itself.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            // With VoiceOver, or without a pointer to drag with: the list's + button takes it from Finder.
            Button("Show \(AppInfo.name) in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
            }
            .buttonStyle(.link)
            .font(.callout)
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 14)
        .frame(width: 236)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
        .overlay(alignment: .topTrailing) {
            Button("Close", systemImage: "xmark", action: close)
                .labelStyle(.iconOnly)
                .font(.system(size: 10, weight: .bold))
                .buttonStyle(IconButtonStyle(width: 22, height: 22, cornerRadius: 11))
                .padding(6)
                .help("Close")
        }
        .padding(6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(permission == .screenRecording ? "Allow Screen Recording" : "Allow Accessibility")
    }
}

/// Kuvo Code's icon as something to drag: a file of Kuvo Code itself, as Finder gives it, which
/// System Settings' lists take. Now and then it nudges toward the list, to say what to do.
struct AppIconDragSource: NSViewRepresentable {
    func makeNSView(context: Context) -> IconView { IconView() }
    func updateNSView(_ view: IconView, context: Context) {}

    final class IconView: NSView, NSDraggingSource {
        private let icon = CALayer()

        init() {
            super.init(frame: .zero)
            wantsLayer = true
            icon.contents = NSApp.applicationIconImage
            icon.contentsGravity = .resizeAspect
            layer?.addSublayer(icon)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        /// The side the list is on, as the icon last leaned.
        private var side: CGFloat = 0
        private var moves: (any NSObjectProtocol)?

        // A press in this window of an app that isn't in front starts the drag at once.
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let moves { NotificationCenter.default.removeObserver(moves) }
            moves = window.map { window in
                // The window moves beside System Settings once its window shows: the lean follows.
                NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.nudge() }
                }
            }
        }

        override func layout() {
            super.layout()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            icon.frame = bounds
            CATransaction.commit()
            nudge()
        }

        /// A small lean to the side the list is on, every few seconds; still with Reduce Motion.
        /// Started again only when that side changes.
        private func nudge() {
            let side: CGFloat = (window?.frame.midX ?? 0) > (SystemSettings.windowFrame?.midX ?? .infinity) ? -1 : 1
            guard side != self.side || icon.animation(forKey: "nudge") == nil else { return }
            self.side = side
            icon.removeAnimation(forKey: "nudge")
            guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
            let move = CAKeyframeAnimation(keyPath: "transform.translation.x")
            move.values = [0, 0, 10 * side, -2 * side, 0]
            move.keyTimes = [0, 0.62, 0.72, 0.8, 0.86]
            move.duration = 2.6
            move.repeatCount = .infinity
            move.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: 4)
            icon.add(move, forKey: "nudge")
        }

        override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

        override func mouseDown(with event: NSEvent) {
            let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
            item.setDraggingFrame(bounds, contents: NSApp.applicationIconImage)
            beginDraggingSession(with: [item], event: event, source: self)
        }

        func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
            context == .outsideApplication ? [.copy, .link, .generic] : []
        }
    }
}
