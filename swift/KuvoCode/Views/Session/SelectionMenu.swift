import AppKit
import SwiftUI
import WebKit

/// What you can do with a selection in the conversation: Add to Chat (it goes over the composer
/// as a quote to answer), where the conversation takes quotes, and Copy. The conversation shows
/// it over its own selection (see `RowStackView`), and `SelectionMenu` over a page's in it.
struct SelectionActions: View {
    var addToChat: (() -> Void)?
    var copy: () -> Void

    var body: some View {
        HStack(spacing: 2) {
            if let addToChat {
                Button(action: addToChat) {
                    Label("Add to Chat", systemImage: "text.quote")
                }
                .help("Reply to this part: it goes over the composer, to answer under")
                Divider().frame(height: 14)
            }
            Button(action: copy) {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
        .font(.callout)
        .buttonStyle(TextButtonStyle())
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .glassEffect(.regular, in: .capsule)
        .fixedSize()
    }
}

/// The menu over what you select in a page in the conversation (a widget), which the
/// conversation doesn't see: the page holds its selection. It shows when a drag or a double click
/// in the page leaves text selected, and goes at the next click, scroll or key.
struct SelectionMenu: ViewModifier {
    let addToChat: (String) -> Void
    /// A conversation kept hidden (see `SessionView`) has none.
    @Environment(\.isConversationShown) private var isShown
    /// Where it shows, in the conversation's own space; nil while it doesn't.
    @State private var point: CGPoint?
    @State private var frame: CGRect = .zero
    @State private var menuFrame: CGRect = .zero
    @State private var monitor: Any?
    @State private var windowBox = WindowBox()
    /// Where the button went down, to tell a drag from a click.
    @State private var downAt: CGPoint?
    /// What's selected in the page, read as the menu shows: a page copies only a moment later,
    /// too late for Add to Chat.
    @State private var pageSelection: String?

    func body(content: Content) -> some View {
        content
            .background(WindowReader(box: windowBox))
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { frame = $0 }
            .overlay(alignment: .topLeading) {
                if let point {
                    SelectionActions(addToChat: {
                        if let pageSelection { addToChat(pageSelection) }
                        self.point = nil
                    }, copy: {
                        NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
                        self.point = nil
                    })
                    .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { menuFrame = $0 }
                    .position(x: min(max(point.x, 90), max(frame.width - 90, 90)), y: max(point.y - 26, 18))
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                }
            }
            .animation(.easeOut(duration: 0.12), value: point == nil)
            .onAppear(perform: install)
            .onDisappear {
                if let monitor { NSEvent.removeMonitor(monitor) }
                monitor = nil
            }
    }

    private func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .scrollWheel, .keyDown]) { event in
            handle(event)
            return event
        }
    }

    private func handle(_ event: NSEvent) {
        guard isShown else {
            point = nil
            return
        }
        guard let window = windowBox.window, event.window === window, let view = window.contentView else { return }
        let location = view.convert(event.locationInWindow, from: nil)
        let inWindow = view.isFlipped ? location : CGPoint(x: location.x, y: view.bounds.height - location.y)
        switch event.type {
        case .leftMouseDown:
            // A click on the menu is its own.
            guard point == nil || !menuFrame.contains(inWindow) else { return }
            point = nil
            menuFrame = .zero
            downAt = inWindow
        case .leftMouseUp:
            guard frame.contains(inWindow), point == nil || !menuFrame.contains(inWindow) else { return }
            let dragged = downAt.map { hypot($0.x - inWindow.x, $0.y - inWindow.y) > 4 } ?? false
            guard dragged || event.clickCount >= 2 else { return }
            let at = CGPoint(x: inWindow.x - frame.minX, y: inWindow.y - frame.minY)
            // Once the page has its selection: it's asked what it is, as it says it can copy
            // whether or not anything is (a drag in a widget's drawing selects nothing).
            Task {
                try? await Task.sleep(for: .milliseconds(60))
                guard let page = Self.page(in: window) else { return }
                let text = (try? await page.evaluateJavaScript("String(getSelection())", in: nil, contentWorld: .defaultClient) as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !text.isEmpty else { return }
                pageSelection = text
                point = at
            }
        default:
            point = nil
            menuFrame = .zero
        }
    }

    /// The page that has the keyboard, if one does.
    private static func page(in window: NSWindow) -> WKWebView? {
        var view = window.firstResponder as? NSView
        while let current = view, !(current is WKWebView) { view = current.superview }
        return view as? WKWebView
    }
}

extension EnvironmentValues {
    /// The conversation is the one in view, not one kept hidden for going back to.
    @Entry var isConversationShown = true
}
