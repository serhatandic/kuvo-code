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
// innermost marked view there, where nothing is drawn over it. So it also works in the title bar,
// where SwiftUI's `.contextMenu` never fires: the window's toolbar takes those clicks. VoiceOver's Show Menu (VO-Shift-M) opens it,
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
                destructive: role == .destructive, disabled: disabled, help: help?.isEmpty == true ? nil : help)
    }

    /// A menu of its own, opening from this row, its rows made as it opens. Disabled, its row is
    /// dimmed and doesn't open; with no rows, it's left out.
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

    /// The items of `rows`, as SwiftUI made a menu's: a section has a line before and after it. A
    /// line only goes between rows: none at either end, nor two together (where the rows between
    /// them don't show now).
    static func items(_ rows: [HeldRow], disabled: Bool) -> [NSMenuItem] {
        var tidy: [NSMenuItem] = []
        for item in made(rows, disabled: disabled) where !item.isSeparatorItem || tidy.last.map({ !$0.isSeparatorItem }) == true {
            tidy.append(item)
        }
        if tidy.last?.isSeparatorItem == true { tidy.removeLast() }
        return tidy
    }

    private static func made(_ rows: [HeldRow], disabled: Bool) -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        for row in rows {
            if case .section(let inside) = row.kind {
                items.append(.separator())
                if !row.title.isEmpty { items.append(.sectionHeader(title: row.title)) }
                items += made(inside, disabled: disabled || row.disabled)
                items.append(.separator())
            } else if let item = row.item(disabled: disabled) {
                items.append(item)
            }
        }
        return items
    }

    private func item(disabled inherited: Bool) -> NSMenuItem? {
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
            // Nothing to show in it now: no row for it. (Its rows are made again as it opens.)
            guard !Self.items(rows(), disabled: disabled).isEmpty else { return nil }
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.image = image
            item.isEnabled = !disabled
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
        if let icon = row.icon {
            Label { title(row) } icon: { Image(nsImage: icon) }
        } else if let symbol = row.symbol {
            Label { title(row) } icon: { Image(systemName: symbol) }
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
            // Over what it marks, taking clicks only while a right-click asks what's in front
            // (`HeldMenus.frontmost`). Enabled itself in a disabled view: SwiftUI finds nothing
            // in one, and a disabled view's menu opens, its rows disabled, as SwiftUI's did.
            .overlay(HeldMenuMarker(rows: rows, isEnabled: isEnabled, place: place)
                .allowsHitTesting(HeldMenus.shared.probe.isOn)
                .environment(\.isEnabled, true)
                .accessibilityHidden(true))
            // As SwiftUI gave a view with a `.contextMenu`: each element in it offers Show Menu
            // (applied to a stack, it reaches every element in it, as a probe of macOS 27 found).
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

/// Marks a view with a held menu, over it, its size.
final class HeldMenuView: NSView {
    fileprivate var rows: (() -> [HeldRow])?
    fileprivate var isEnabled = true

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { HeldMenus.shared.add(self) }
    }

    // Never what a click lands on, what it marks is; but for what's in front, while a right-click asks.
    override func hitTest(_ point: NSPoint) -> NSView? {
        HeldMenus.shared.probe.isOn ? super.hitTest(point) : nil
    }

    /// Its menu, made now; nil when it has nothing to show.
    func makeMenu() -> NSMenu? {
        guard let rows = rows?(), !rows.isEmpty else { return nil }
        let menu = HeldRow.menu(rows, disabled: !isEnabled)
        return menu.items.isEmpty ? nil : menu
    }

    fileprivate func showForAccessibility() {
        guard let menu = makeMenu() else { return }
        // After the action: a menu's loop run inside it would hold up VoiceOver until it closed.
        Modal.later { HeldMenus.shared.present(menu, self, nil) }
    }

    /// Whether a right-click on `hit` is on what this marks (or what's inside it), not on something
    /// over it. `front`: the marked view frontmost there. `passedOn`: `hit` passes its right-click
    /// on (a message's words, see `menu(for:from:)`), so it's in front.
    fileprivate func isReached(by event: NSEvent, on hit: NSView, front: HeldMenuView?, passedOn: Bool) -> Bool {
        guard let common = hit.ancestorShared(with: self) else { return false }
        if !passedOn {
            // Drawn over by something that isn't marked (a card, a button), or by another marked
            // view that isn't around this one: not this one's. (The marker of a view around it is
            // in front of it, over all it holds.)
            guard let front, front === self || front.convert(front.bounds, to: nil).contains(convert(bounds, to: nil)) else { return false }
            // Something under the click with a right-click of its own (a text's words, a web page): theirs.
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
    /// On while a right-click asks what's in front; the markers take clicks only then.
    let probe = Probe()

    @Observable final class Probe {
        var isOn = false
    }

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
        guard !candidates.isEmpty else { return nil }
        let front = view == nil ? frontmost(at: point, in: frame) : nil
        for (marked, _) in candidates where marked.isReached(by: event, on: hit, front: front, passedOn: view != nil) {
            if let menu = marked.makeMenu() { return (menu: menu, view: marked) }
        }
        return nil
    }

    /// The marked view frontmost at `point`, as SwiftUI finds what a click there reaches: for this
    /// moment the markers, each over what it marks, take clicks, laid out so and back at once. Nil
    /// where something that isn't marked is in front (a card over a row, the Send button).
    private func frontmost(at point: NSPoint, in frame: NSView) -> HeldMenuView? {
        probe.isOn = true
        frame.layoutSubtreeIfNeeded()
        let hit = frame.hitTest(point)
        probe.isOn = false
        frame.layoutSubtreeIfNeeded()
        return hit as? HeldMenuView
    }
}

private extension NSView {
    /// Whether a right-click (or a Control-click) here stays here: a text's, a terminal's, a web
    /// page's, a control's Control-click, one with a menu of its own. SwiftUI's own views, a
    /// control's right-click it has no menu for, and AppKit's and the app's views that do nothing
    /// with one pass it on to what they're in, as they always did.
    func takesRightClick(_ event: NSEvent) -> Bool {
        if self is HeldMenuView { return false }
        if self is NSTextView { return true }
        // (A SwiftUI picker's pop-up button too.)
        if menu != nil { return true }
        let bundle = Bundle(for: type(of: self))
        if bundle == NSView.swiftUI { return false }
        if gestureRecognizers.contains(where: { $0.takesRightClicks }) { return true }
        if self is NSControl {
            // A Control-click is the control's (a pop-up button opens, a field takes it).
            guard event.type == .rightMouseDown else { return true }
            return overrides(#selector(menu(for:))) && menu(for: event) != nil
        }
        if overrides(#selector(menu(for:))), menu(for: event) != nil { return true }
        if overrides(#selector(rightMouseDown(with:))) { return true }
        // Anyone else's (a web page's views): theirs, however they take it.
        return bundle != .main && bundle != NSView.appKit
    }

    func overrides(_ selector: Selector) -> Bool {
        class_getMethodImplementation(type(of: self), selector) != class_getMethodImplementation(NSView.self, selector)
    }

    static let swiftUI = Bundle(for: NSHostingView<EmptyView>.self)
    static let appKit = Bundle(for: NSView.self)
}

private extension NSGestureRecognizer {
    /// Whether it takes the secondary button's clicks.
    var takesRightClicks: Bool {
        let mask = (self as? NSClickGestureRecognizer)?.buttonMask ?? (self as? NSPressGestureRecognizer)?.buttonMask ?? 0
        return mask & 0x2 != 0
    }
}
