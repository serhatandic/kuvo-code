import AppKit
import SwiftUI

// Every right-click menu in the app, made as it opens and left alone while it's open (#556).
//
// SwiftUI's `.contextMenu` puts new items in its menu while it's open, each time the view around it
// is drawn again: measured on macOS 27, an open one had all its items replaced by new ones on each
// of five redraws, where a SwiftUI `Menu` button's kept the same items through the same five. Rows
// in the sidebar and the conversation are drawn again each time a session starts or ends a turn,
// so an open menu lost its highlighted row, closed the submenu you were in, or changed under the
// pointer while you read it.
//
// So right-click menus are AppKit's own here, as the phone's are UIKit's (its `HeldMenu`): made from
// rows (`HeldRow`) when the right-click comes, from what's true then (a row that hides or is disabled
// is decided then), and nothing reaches a menu that's open. A submenu's rows are made as it opens.
// `.heldContextMenu { … }` only marks where a view is; one watcher catches right-clicks (and
// Control-clicks) at the window, before the view under them sees them, and opens the menu of the
// innermost marked view there. So it also works in the title bar, where SwiftUI's `.contextMenu`
// never fires: the window's toolbar takes those clicks. VoiceOver's Show Menu (VO-Shift-M) opens it,
// as it did SwiftUI's. `HeldMenuGuardTests` keeps SwiftUI's `.contextMenu` out of the app; SwiftUI's
// `Menu` buttons keep their items while they're open, and stay.

/// One row of a held menu: a button, a submenu, a section with a title over it, a note, or a
/// divider. Its items are as SwiftUI's own menus had them.
struct HeldRow {
    fileprivate enum Kind {
        case action(() -> Void)
        case submenu(() -> [HeldRow])
        case section([HeldRow])
        case note
        case divider
        case item(NSMenuItem)
    }

    fileprivate var kind: Kind
    var title = ""
    var subtitle: String?
    /// A symbol's name, for its icon.
    var symbol: String?
    /// Its icon, when it isn't a symbol (an app's).
    var icon: NSImage?
    var checked = false
    /// As SwiftUI's `role: .destructive`. SwiftUI's right-click menus on the Mac draw it as any other
    /// row, and so does this; a SwiftUI menu made from these rows (`HeldMenuContent`) has the role.
    var destructive = false
    var disabled = false
    /// Its tooltip, as `.help` gave one.
    var help: String?

    /// A row that does `action`: its title, the line under it, its icon (a symbol's name), checked
    /// as the one picked.
    static func button(_ title: String, subtitle: String? = nil, image: String? = nil, icon: NSImage? = nil, checked: Bool = false,
                       role: ButtonRole? = nil, disabled: Bool = false, help: String? = nil, action: @escaping () -> Void) -> HeldRow {
        HeldRow(kind: .action(action), title: title, subtitle: subtitle, symbol: image, icon: icon, checked: checked,
                destructive: role == .destructive, disabled: disabled, help: help)
    }

    /// A menu of its own, opening from this row, its rows made as it opens. Disabled, as a disabled
    /// SwiftUI `Menu`: the row still opens it, with every row in it disabled.
    static func submenu(_ title: String, image: String? = nil, disabled: Bool = false, @HeldRows _ rows: @escaping () -> [HeldRow]) -> HeldRow {
        HeldRow(kind: .submenu(rows), title: title, symbol: image, disabled: disabled)
    }

    /// Rows set apart from the others, with `title` over them, as SwiftUI's `Section`.
    static func section(_ title: String? = nil, disabled: Bool = false, @HeldRows _ rows: () -> [HeldRow]) -> HeldRow {
        HeldRow(kind: .section(rows()), title: title ?? "", disabled: disabled)
    }

    /// A line of text that does nothing, as a `Text` in a SwiftUI menu.
    static func note(_ text: String) -> HeldRow {
        HeldRow(kind: .note, title: text)
    }

    /// A line between the rows before and after it, as SwiftUI's `Divider`.
    static let divider = HeldRow(kind: .divider)

    /// An item made elsewhere, as it is (the title bar's tabs make theirs).
    static func item(_ item: NSMenuItem) -> HeldRow {
        HeldRow(kind: .item(item))
    }

    private var image: NSImage? {
        icon ?? symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }
    }
}

extension HeldRow {
    /// AppKit's menu of `rows`, made now. `disabled`: every row in it disabled, as a disabled view's.
    static func menu(_ rows: [HeldRow], title: String = "", disabled: Bool = false) -> NSMenu {
        let menu = NSMenu(title: title)
        // Rows carry their own enabled state (Close Other Tabs with one tab open).
        menu.autoenablesItems = false
        for item in items(rows, disabled: disabled) { menu.addItem(item) }
        return menu
    }

    /// The items of `rows`, as SwiftUI made a menu's: a section has a line before and after it,
    /// where there are rows there.
    static func items(_ rows: [HeldRow], disabled: Bool) -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        for (index, row) in rows.enumerated() {
            if case .section(let inside) = row.kind {
                if index > 0 { items.append(.separator()) }
                if !row.title.isEmpty { items.append(.sectionHeader(title: row.title)) }
                items += Self.items(inside, disabled: disabled || row.disabled)
                if index < rows.count - 1 { items.append(.separator()) }
            } else {
                items.append(row.item(disabled: disabled))
            }
        }
        return items
    }

    private func item(disabled inherited: Bool) -> NSMenuItem {
        let disabled = inherited || self.disabled
        switch kind {
        case .action(let action):
            let item = ActionItem(title, subtitle: subtitle, checked: checked) { action() }
            // Shown or not as macOS decides for a menu's icons, as SwiftUI's were.
            item.image = image
            item.isEnabled = !disabled
            item.toolTip = help
            return item
        case .submenu(let rows):
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.image = image
            let submenu = NSMenu(title: title)
            submenu.autoenablesItems = false
            let filler = SubmenuFiller(rows: rows, disabled: disabled)
            submenu.delegate = filler
            // (A menu holds its delegate weakly; the item keeps it.)
            item.representedObject = filler
            item.submenu = submenu
            return item
        case .note:
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            return item
        case .divider, .section:
            return .separator()
        case .item(let item):
            if disabled { item.isEnabled = false }
            return item
        }
    }
}

/// Makes a submenu's items as it first opens, from what's true then; never again while its menu
/// is open.
private final class SubmenuFiller: NSObject, NSMenuDelegate {
    private var rows: (() -> [HeldRow])?
    private let disabled: Bool

    init(rows: @escaping () -> [HeldRow], disabled: Bool) {
        self.rows = rows
        self.disabled = disabled
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard let rows else { return }
        self.rows = nil
        for item in HeldRow.items(rows(), disabled: disabled) { menu.addItem(item) }
    }
}

/// Makes a held menu's rows from `if`, `for` and the rows themselves, as `@ViewBuilder` does a
/// SwiftUI menu's.
@resultBuilder
enum HeldRows {
    static func buildExpression(_ row: HeldRow) -> [HeldRow] { [row] }
    static func buildExpression(_ rows: [HeldRow]) -> [HeldRow] { rows }
    static func buildExpression(_ item: NSMenuItem) -> [HeldRow] { [.item(item)] }
    static func buildExpression(_ items: [NSMenuItem]) -> [HeldRow] { items.map(HeldRow.item) }
    static func buildBlock(_ parts: [HeldRow]...) -> [HeldRow] { parts.flatMap { $0 } }
    static func buildOptional(_ rows: [HeldRow]?) -> [HeldRow] { rows ?? [] }
    static func buildEither(first rows: [HeldRow]) -> [HeldRow] { rows }
    static func buildEither(second rows: [HeldRow]) -> [HeldRow] { rows }
    static func buildArray(_ parts: [[HeldRow]]) -> [HeldRow] { parts.flatMap { $0 } }
    static func buildLimitedAvailability(_ rows: [HeldRow]) -> [HeldRow] { rows }
}

/// Rows in a SwiftUI menu (a `Menu` button's, which keeps its items while it's open), for a menu
/// whose rows a right-click menu shares.
struct HeldMenuContent: View {
    let rows: [HeldRow]

    init(rows: [HeldRow]) {
        self.rows = rows
    }

    init(@HeldRows _ rows: () -> [HeldRow]) {
        self.rows = rows()
    }

    var body: some View {
        ForEach(rows.indices, id: \.self) { index in
            let row = rows[index]
            switch row.kind {
            case .action(let action):
                if row.checked {
                    Toggle(isOn: Binding(get: { true }, set: { _ in action() })) { label(row) }
                        .disabled(row.disabled)
                        .modifier(Help(text: row.help))
                } else {
                    Button(role: row.destructive ? .destructive : nil, action: action) { label(row) }
                        .disabled(row.disabled)
                        .modifier(Help(text: row.help))
                }
            case .submenu(let rows):
                Menu {
                    HeldMenuContent { rows() }
                } label: {
                    label(row)
                }
                .disabled(row.disabled)
            case .section(let rows):
                if row.title.isEmpty {
                    Section { HeldMenuContent(rows: rows) }
                        .disabled(row.disabled)
                } else {
                    Section(row.title) { HeldMenuContent(rows: rows) }
                        .disabled(row.disabled)
                }
            case .note:
                Text(row.title)
            case .divider:
                Divider()
            case .item:
                // Only AppKit's menus take an item made for them.
                EmptyView()
            }
        }
    }

    @ViewBuilder private func label(_ row: HeldRow) -> some View {
        if let symbol = row.symbol {
            Label { title(row) } icon: { Image(systemName: symbol) }
        } else if let icon = row.icon {
            Label { title(row) } icon: { Image(nsImage: icon) }
        } else {
            title(row)
        }
    }

    @ViewBuilder private func title(_ row: HeldRow) -> some View {
        Text(row.title)
        if let subtitle = row.subtitle { Text(subtitle) }
    }

    private struct Help: ViewModifier {
        let text: String?

        func body(content: Content) -> some View {
            if let text { content.help(text) } else { content }
        }
    }
}

extension View {
    /// A right-click (and Control-click) menu, made from `rows` when the click comes and left as
    /// it is while it's open (see above): rows decide then whether they show. Where marked views
    /// hold one another (a row in a marked list), the innermost one under the click has its menu;
    /// where the innermost has no rows, the one around it.
    func heldContextMenu(@HeldRows _ rows: @escaping () -> [HeldRow]) -> some View {
        modifier(HeldContextMenu(rows: rows))
    }
}

private struct HeldContextMenu: ViewModifier {
    let rows: () -> [HeldRow]
    /// A disabled view's menu has every row disabled, as SwiftUI's had.
    @Environment(\.isEnabled) private var isEnabled
    @State private var place = HeldMenuPlace()

    func body(content: Content) -> some View {
        content
            .background(HeldMenuMarker(rows: rows, isEnabled: isEnabled, place: place).allowsHitTesting(false).accessibilityHidden(true))
            // As SwiftUI gave a view with a `.contextMenu` (each element in it, where it has several).
            .accessibilityAction(.showMenu) { place.view?.showForAccessibility() }
    }
}

/// Where a marked view is, for VoiceOver's Show Menu.
private final class HeldMenuPlace {
    weak var view: HeldMenuView?
}

private struct HeldMenuMarker: NSViewRepresentable {
    let rows: () -> [HeldRow]
    let isEnabled: Bool
    let place: HeldMenuPlace

    func makeNSView(context: Context) -> HeldMenuView { HeldMenuView() }

    func updateNSView(_ view: HeldMenuView, context: Context) {
        view.rows = rows
        view.isEnabled = isEnabled
        place.view = view
    }
}

/// Marks a view with a held menu, behind it, its size.
final class HeldMenuView: NSView {
    fileprivate var rows: (() -> [HeldRow])?
    fileprivate var isEnabled = true

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { HeldMenus.shared.add(self) }
    }

    // Never what a click lands on: what it marks is.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Its menu, made now; nil when it has no rows.
    func makeMenu() -> NSMenu? {
        guard let rows = rows?(), !rows.isEmpty else { return nil }
        return HeldRow.menu(rows, disabled: !isEnabled)
    }

    fileprivate func showForAccessibility() {
        guard let menu = makeMenu() else { return }
        // After the action: a menu's loop run inside it would hold up VoiceOver until it closed.
        Modal.later { HeldMenus.shared.present(menu, self, nil) }
    }

    /// Whether a right-click on `hit` is on what this marks (or what's inside it), not on something
    /// over it. `passedOn`: `hit` passes its right-click on (a message's words, see `menu(for:from:)`).
    fileprivate func isReached(by event: NSEvent, on hit: NSView, passedOn: Bool) -> Bool {
        guard let common = hit.ancestorShared(with: self) else { return false }
        // Something under the click with a right-click of its own (a text's words, a web page): theirs.
        if !passedOn {
            var view: NSView? = hit
            while let on = view, on !== common {
                if on.takesRightClick(event) { return false }
                view = on.superview
            }
        }
        // In a list that scrolls, only where it's in sight: not a row scrolled under the header
        // or the composer over it.
        var view = superview
        while let around = view, around !== common {
            if around is NSScrollView || around is NSClipView { return false }
            view = around.superview
        }
        return true
    }
}

/// The one watcher at the windows, for every marked view.
@MainActor
final class HeldMenus {
    static let shared = HeldMenus()

    private let views = NSHashTable<HeldMenuView>.weakObjects()
    private var monitor: Any?

    /// Opens a menu that's been made: at the click, for the marked view; without one (VoiceOver),
    /// over the view's middle. Tests take it here instead.
    var present: (NSMenu, NSView, NSEvent?) -> Void = { menu, view, event in
        if let event {
            NSMenu.popUpContextMenu(menu, with: event, for: view)
        } else {
            menu.popUp(positioning: nil, at: NSPoint(x: view.bounds.midX, y: view.bounds.midY), in: view)
        }
    }

    fileprivate func add(_ view: HeldMenuView) {
        views.add(view)
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .leftMouseDown]) { [weak self] event in
            guard let self, event.type == .rightMouseDown || event.modifierFlags.contains(.control),
                  let found = menu(for: event) else { return event }
            present(found.menu, found.view, event)
            return nil
        }
    }

    /// The menu of the innermost marked view under a right-click, made now, with that view; nil
    /// where none is (or none has rows). `from`: a view that passes on a right-click it has no
    /// menu of its own for (a message's words, outside what's selected), asking from its own
    /// `menu(for:)`.
    func menu(for event: NSEvent, from view: NSView? = nil) -> (menu: NSMenu, view: HeldMenuView)? {
        guard let window = event.window ?? view?.window, let frame = window.contentView?.superview else { return nil }
        let point = event.locationInWindow
        guard let hit = view ?? frame.hitTest(point) else { return nil }
        let candidates = views.allObjects
            .filter { $0.window === window && !$0.isHiddenOrHasHiddenAncestor }
            .map { (view: $0, frame: $0.convert($0.bounds, to: nil)) }
            .filter { $0.frame.contains(point) }
            .sorted { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
        for (marked, _) in candidates where marked.isReached(by: event, on: hit, passedOn: view != nil) {
            if let menu = marked.makeMenu() { return (menu: menu, view: marked) }
        }
        return nil
    }
}

private extension NSView {
    /// Whether a right-click here stays here: a text's, a web page's, one with a menu of its own.
    /// SwiftUI's own views and controls without a menu pass it on to what they're in.
    func takesRightClick(_ event: NSEvent) -> Bool {
        if self is NSTextView { return true }
        if Bundle(for: type(of: self)) == NSView.swiftUI { return false }
        if menu != nil { return true }
        if overrides(#selector(menu(for:))), menu(for: event) != nil { return true }
        return !(self is NSControl) && overrides(#selector(rightMouseDown(with:)))
    }

    func overrides(_ selector: Selector) -> Bool {
        class_getMethodImplementation(type(of: self), selector) != class_getMethodImplementation(NSView.self, selector)
    }

    static let swiftUI = Bundle(for: NSHostingView<EmptyView>.self)
}
