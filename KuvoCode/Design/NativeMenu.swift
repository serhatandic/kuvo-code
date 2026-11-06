import AppKit
import SwiftUI
import os

/// A SwiftUI button that opens a real AppKit menu, built when clicked.
///
/// SwiftUI's `Menu` can't show a value on the right of a submenu row ("Model …
/// GPT-6 Luna ›"), item subtitles, or open above its button; `NSMenu` can.
struct NativeMenuButton<Label: View>: View {
    /// Identifies the menu for the KUVO_DEMO_MENU debug hook.
    var name = ""
    /// Below the button, for one near the top of a card; above it by default, for the composer's.
    var opensBelow = false
    let menu: () -> NSMenu
    @ViewBuilder let label: () -> Label
    @State private var anchor = NativeMenuAnchor()

    var body: some View {
        #if DEBUG
        let _ = anchor.demoMenu = menu
        #endif
        Button {
            // After the press: a menu's loop run inside it would hold up VoiceOver's press until it closed.
            Modal.later { anchor.popUp(menu(), below: opensBelow) }
        } label: {
            label()
                .environment(\.nativeMenuAnchor, anchor)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .background(MenuAnchorView { anchor.view = $0 })
        #if DEBUG
        .task {
            // KUVO_DEMO_MENU=<name> opens this menu (its first submenu with "<name>s") after launch.
            guard let wanted = ProcessInfo.processInfo.environment["KUVO_DEMO_MENU"], !name.isEmpty, wanted == name || wanted == name + "s" else { return }
            try? await Task.sleep(for: .seconds(Double(ProcessInfo.processInfo.environment["KUVO_DEMO_MENU_AFTER"] ?? "") ?? 3))
            // (As it is by then, as a click would build it: what this task caught is from the first draw.)
            let menu = (anchor.demoMenu ?? menu)()
            // Outside this task: a menu's loop run inside one holds up every other until it closes.
            Modal.later { anchor.popUp(wanted == name ? menu : menu.items.first { $0.submenu != nil }?.submenu ?? menu, below: opensBelow) }
        }
        #endif
    }
}

/// Where a `NativeMenuButton` opens its menu: the button, or the value its label marks with
/// `nativeMenuValue()`.
final class NativeMenuAnchor {
    weak var view: NSView?
    /// The value a row shows on its right ("No limit ⌄"): its menu opens there, as a pop-up
    /// button's does, with the chosen item over it, wherever on the row you clicked.
    weak var value: NSView?
    #if DEBUG
    /// The button's menu as last drawn, for the KUVO_DEMO_MENU debug hook.
    var demoMenu: (() -> NSMenu)?
    #endif

    /// Opens the menu over the label's value, with its chosen item there (one is checked); else
    /// just above the button (the composer sits at the bottom of the window), or just below it.
    func popUp(_ menu: NSMenu, below: Bool = false) {
        if let value, value.window != nil, let chosen = menu.items.first(where: { $0.state == .on }) {
            // A pop-up button's own cell opens it, so it's placed as theirs are: the chosen item's
            // title over the value's. (It leaves the items' checks as they are.)
            let cell = NSPopUpButtonCell(textCell: "", pullsDown: false)
            cell.isBordered = false
            cell.altersStateOfSelectedItem = false
            cell.font = .menuFont(ofSize: 0)
            cell.menu = menu
            cell.select(chosen)
            // It puts the item's title 14 points into its frame (measured on macOS 27), so the
            // frame starts that much before the value.
            cell.performClick(withFrame: value.bounds.offsetBy(dx: -14, dy: 0), in: value)
            return
        }
        guard let view else { return }
        let origin = below
            ? NSPoint(x: 0, y: -4)
            : NSPoint(x: -8, y: view.bounds.height + menu.size.height + 8)
        menu.popUp(positioning: nil, at: origin, in: view)
    }
}

extension EnvironmentValues {
    @Entry var nativeMenuAnchor: NativeMenuAnchor?
}

extension View {
    /// Marks the value a `NativeMenuButton`'s label shows (with its chevron): the menu opens over
    /// it, its chosen item where the value is, as macOS pop-up buttons do.
    func nativeMenuValue() -> some View {
        modifier(NativeMenuValue())
    }
}

private struct NativeMenuValue: ViewModifier {
    @Environment(\.nativeMenuAnchor) private var anchor

    func body(content: Content) -> some View {
        content.background {
            if let anchor { MenuAnchorView { anchor.value = $0 } }
        }
    }
}

/// An empty view that hands itself to `found`, for a menu to open at.
private struct MenuAnchorView: NSViewRepresentable {
    let found: (NSView) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        found(view)
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        found(view)
    }
}

/// A menu item that runs a closure. Opted out of the target's default main-actor
/// isolation because NSMenuItem's initializers aren't isolated; menus still only
/// call it on the main thread.
nonisolated final class ActionItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(_ title: String, subtitle: String? = nil, image: NSImage? = nil, checked: Bool = false, handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
        self.subtitle = subtitle
        self.image = image
        if image != nil { showImage() }
        state = checked ? .on : .off
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError() }

    @objc private func run() {
        let handler = handler
        MainActor.assumeIsolated { handler() }
    }
}

extension NSMenuItem {
    /// A row with a title on the left and its current value on the right, opening `submenu`.
    static func chained(_ title: String, value: String?, image: NSImage? = nil, submenu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.image = image
        if image != nil { item.showImage() }
        item.submenu = submenu
        if let value { item.attributedTitle = .withValue(title, value) }
        return item
    }

    /// macOS 27 hides menu item images unless the item asks to show them. Our logos
    /// tell models apart (Claude through Copilot vs. through OpenCode), so they stay.
    nonisolated func showImage() {
        if #available(macOS 27, *) { preferredImageVisibility = .visible }
    }

    /// A row that only shows information.
    static func info(_ title: String, value: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.attributedTitle = .withValue(title, value)
        item.isEnabled = false
        return item
    }
}

extension NSMenu {
    /// Draws the check of each item in `checked` on its trailing side, lined up, in place of the
    /// leading column, which the menu then leaves out. The items stay off: AppKit draws a leading
    /// check for one that's on, column or not.
    func checksOnTrailingSide(_ checked: Set<NSMenuItem>) {
        showsStateColumn = false
        let font = NSFont.menuFont(ofSize: 0)
        let small = NSFont.menuFont(ofSize: NSFont.smallSystemFontSize)
        let rows = items.filter { !$0.isSeparatorItem && !$0.isSectionHeader && !$0.title.isEmpty }
        // Past the widest title and subtitle, so every check sits in one column.
        let width = rows.reduce(CGFloat(200)) { widest, item in
            max(widest, (item.title as NSString).size(withAttributes: [.font: font]).width + 36, ((item.subtitle ?? "") as NSString).size(withAttributes: [.font: small]).width + 12)
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.tabStops = [NSTextTab(textAlignment: .right, location: width)]
        for item in rows {
            // (No color of its own: a highlighted row draws it as it draws the title.)
            item.attributedTitle = NSAttributedString(string: item.title + "\t" + (checked.contains(item) ? "✓" : ""), attributes: [.font: font, .paragraphStyle: paragraph])
            // (VoiceOver hears the name and whether it's the one picked, not the check's glyph.)
            item.state = .off
            item.setAccessibilityLabel(item.title)
            item.setAccessibilityValue(checked.contains(item) ? "selected" : nil)
        }
    }
}

extension NSAttributedString {
    /// "Title            Value", the value right-aligned and secondary.
    static func withValue(_ title: String, _ value: String) -> NSAttributedString {
        let font = NSFont.menuFont(ofSize: 0)
        let width = max(220, (title as NSString).size(withAttributes: [.font: font]).width + (value as NSString).size(withAttributes: [.font: font]).width + 48)
        let paragraph = NSMutableParagraphStyle()
        paragraph.tabStops = [NSTextTab(textAlignment: .right, location: width)]
        let string = NSMutableAttributedString(string: title + "\t", attributes: [.font: font, .paragraphStyle: paragraph])
        string.append(NSAttributedString(string: value, attributes: [.font: font, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph]))
        return string
    }
}

/// Provider and model-maker logos, kept in memory for menus (which can't wait for a download).
@Observable
final class LogoImages {
    private let log = Logger(subsystem: "run.kuvo.code", category: "logos")
    static let shared = LogoImages()
    private var images: [String: NSImage] = [:]

    /// A 16-pt template image for menu rows, if the logo has loaded. Menus don't draw
    /// the SVG originals reliably, so it's redrawn into a plain drawing-handler image.
    func menuImage(_ id: String) -> NSImage? {
        guard let source = images[id] else {
            log.debug("menu logo missing: \(id, privacy: .public) (have \(self.images.count))")
            return nil
        }
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { rect in
            source.draw(in: rect)
            return true
        }
        image.isTemplate = true
        return image
    }

    func prefetch(_ ids: some Sequence<String>) {
        let wanted = Set(ids).filter { images[$0] == nil }
        log.debug("prefetching \(wanted.count) logos")
        for id in wanted {
            Task {
                if let image = await LogoCache.shared.logo(for: id) {
                    images[id] = image
                } else {
                    log.debug("logo failed: \(id, privacy: .public)")
                }
            }
        }
    }
}
