import AppKit
import Observation
import SwiftUI
import Testing
import UniformTypeIdentifiers
@testable import KuvoCode

/// A right-click menu is made when the right-click comes, from what's true then, and nothing changes
/// it while it's open (#556). SwiftUI's `.contextMenu` put new items in an open menu each time the
/// view around it was drawn again (each time a session started or ended a turn), so it lost its
/// highlighted row and closed the submenu you were in. Right-clicks go through the app as AppKit
/// sends them (`NSApp.sendEvent`), to views in a window of the test's own; the menu is caught as
/// it would open, rather than opened.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct HeldMenuTests {
    @Observable final class Turns {
        var count = 0
    }

    /// How many times a row was drawn.
    final class Drawn {
        var count = 0
    }

    /// Changes to menus, as AppKit posts them (on the main thread, as they're made).
    final class Changes: @unchecked Sendable {
        var count = 0
    }

    private struct TurnRow: View {
        let turns: Turns
        let drawn: Drawn

        var body: some View {
            let _ = drawn.count += 1
            Text("Turn \(turns.count)")
                .frame(width: 300, height: 40)
                .heldContextMenu {
                    HeldRow.button("Turn \(turns.count)") {}
                    HeldRow.button("Copy") {}
                    HeldRow.submenu("Steps") { HeldRow.button("Step \(turns.count)") {} }
                }
        }
    }

    private final class Shown {
        let window: NSWindow
        var host: NSView { window.contentView! }

        init(_ view: some View, width: CGFloat = 300, height: CGFloat = 300) {
            window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: view.frame(width: width, height: height))
            window.contentView?.layoutSubtreeIfNeeded()
        }

        func close() {
            window.contentView = nil
            window.close()
        }

        /// The menu a right-click (or a Control-click) at `point` (from the window's bottom left)
        /// opens, caught as it opens; nil where none does.
        func rightClick(at point: NSPoint, control: Bool = false) throws -> NSMenu? {
            var caught: NSMenu?
            let present = HeldMenus.shared.present
            HeldMenus.shared.present = { menu, _, _ in caught = menu }
            defer { HeldMenus.shared.present = present }
            let event = try #require(NSEvent.mouseEvent(with: control ? .leftMouseDown : .rightMouseDown, location: point, modifierFlags: control ? .control : [],
                                                        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                                                        eventNumber: 0, clickCount: 1, pressure: 1))
            NSApp.sendEvent(event)
            return caught
        }
    }

    private func titles(_ menu: NSMenu?) -> [String] {
        menu?.items.map { $0.isSeparatorItem ? "—" : $0.title } ?? []
    }

    /// Fills a submenu as AppKit does as it opens.
    private func open(_ submenu: NSMenu?) {
        guard let submenu else { return }
        submenu.delegate?.menuNeedsUpdate?(submenu)
    }

    @Test func anOpenMenuStaysAsItOpenedWhileItsRowIsDrawnAgain() throws {
        let turns = Turns(), drawn = Drawn()
        let shown = Shown(TurnRow(turns: turns, drawn: drawn).frame(maxHeight: .infinity, alignment: .top))
        defer { shown.close() }
        let menu = try #require(try shown.rightClick(at: NSPoint(x: 150, y: 280)))
        #expect(titles(menu) == ["Turn 0", "Copy", "Steps"])

        let items = menu.items.map(ObjectIdentifier.init)
        let changes = Changes()
        let center = NotificationCenter.default
        let watches = [NSMenu.didAddItemNotification, NSMenu.didRemoveItemNotification, NSMenu.didChangeItemNotification].map {
            center.addObserver(forName: $0, object: nil, queue: nil) { _ in changes.count += 1 }
        }
        defer { for watch in watches { center.removeObserver(watch) } }

        // Sessions start and end turns while it's open: the row is drawn again each time.
        let before = drawn.count
        for turn in 1...5 {
            turns.count = turn
            shown.host.layoutSubtreeIfNeeded()
        }
        #expect(drawn.count >= before + 5, "the row was drawn again")
        // Its submenu, opened now: made as it opens, then left as it is.
        let steps = try #require(menu.items.last?.submenu)
        open(steps)
        #expect(titles(steps) == ["Step 5"])
        let stepItems = steps.items.map(ObjectIdentifier.init)
        changes.count = 0
        for turn in 6...8 {
            turns.count = turn
            shown.host.layoutSubtreeIfNeeded()
        }

        #expect(menu.items.map(ObjectIdentifier.init) == items, "the same items, not new ones")
        #expect(titles(menu) == ["Turn 0", "Copy", "Steps"])
        #expect(steps.items.map(ObjectIdentifier.init) == stepItems)
        #expect(titles(steps) == ["Step 5"])
        #expect(changes.count == 0, "nothing in the open menu changed")
        // The next right-click has what's true then.
        #expect(titles(try shown.rightClick(at: NSPoint(x: 150, y: 280))).first == "Turn 8")
    }

    @Test func theInnermostMarkedViewUnderTheClickHasItsMenu() throws {
        let view = VStack(spacing: 0) {
            HStack(spacing: 0) {
                Text("Row").frame(width: 100, height: 50).heldContextMenu { HeldRow.button("Row") {} }
                // No rows of its own: the menu around it.
                Text("Quiet").frame(width: 100, height: 50).heldContextMenu {}
                Spacer()
            }
            .frame(width: 300, height: 50)
            .heldContextMenu {
                HeldRow.button("Section") {}
                HeldRow.divider
                HeldRow.button("New Category…") {}
            }
            Spacer()
        }
        let shown = Shown(view)
        defer { shown.close() }
        #expect(titles(try shown.rightClick(at: NSPoint(x: 50, y: 275))) == ["Row"])
        #expect(titles(try shown.rightClick(at: NSPoint(x: 50, y: 275), control: true)) == ["Row"], "a Control-click too")
        #expect(titles(try shown.rightClick(at: NSPoint(x: 250, y: 275))) == ["Section", "—", "New Category…"])
        #expect(titles(try shown.rightClick(at: NSPoint(x: 150, y: 275))) == ["Section", "—", "New Category…"])
        #expect(try shown.rightClick(at: NSPoint(x: 150, y: 100)) == nil, "nothing marked there")
    }

    @Test func aRowUnderWhatCoversItsListHasNoMenuThere() throws {
        let view = ScrollView {
            VStack(spacing: 0) {
                ForEach(0..<20) { row in
                    Text("Row \(row)").frame(width: 300, height: 30).contentShape(.rect).heldContextMenu { HeldRow.button("Row \(row)") {} }
                }
            }
        }
        .frame(height: 300)
        .overlay(alignment: .bottom) { Text("Composer").frame(width: 300, height: 60).background(.background) }
        let shown = Shown(view)
        defer { shown.close() }
        #expect(titles(try shown.rightClick(at: NSPoint(x: 150, y: 285))) == ["Row 0"])
        #expect(titles(try shown.rightClick(at: NSPoint(x: 150, y: 195))) == ["Row 3"])
        // Row 8 is under the composer: the click is the composer's.
        #expect(try shown.rightClick(at: NSPoint(x: 150, y: 45)) == nil)
    }

    @Test func aControlInARowPassesTheRightClickOnToIt() throws {
        let view = HStack {
            Text("Account").frame(width: 150)
            Toggle("On", isOn: .constant(true)).toggleStyle(.switch).labelsHidden()
        }
        .frame(width: 300, height: 50)
        .heldContextMenu { HeldRow.button("Sign In Again…") {} }
        .frame(maxHeight: .infinity, alignment: .top)
        let shown = Shown(view)
        defer { shown.close() }
        let toggle = try #require(all(in: shown.host).first { $0 is NSControl && !($0 is NSTextField) }, "the switch is AppKit's")
        let frame = toggle.convert(toggle.bounds, to: nil)
        #expect(titles(try shown.rightClick(at: NSPoint(x: frame.midX, y: frame.midY))) == ["Sign In Again…"])
    }

    private func all(in view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap(all)
    }

    // MARK: The same rows as SwiftUI's

    /// What AppKit shows of a menu's items, its submenus filled as they open.
    private func described(_ menu: NSMenu, _ indent: String = "") -> [String] {
        menu.items.flatMap { item -> [String] in
            var line = "\(indent)\(item.title) | \(item.subtitle ?? "-") | enabled \(item.isEnabled) | separator \(item.isSeparatorItem) | header \(item.isSectionHeader)"
                + " | state \(item.state.rawValue) | tip \(item.toolTip ?? "-") | image \(item.image.map { "\($0.size) \($0.isTemplate)" } ?? "-")"
                + " | key \(item.keyEquivalent) | spoken \(item.accessibilityLabel() ?? "-")"
            if #available(macOS 27, *) { line += " | shows image \(item.preferredImageVisibility.rawValue)" }
            guard let submenu = item.submenu else { return [line] }
            submenu.delegate?.menuNeedsUpdate?(submenu)
            return [line, "\(indent)[\(submenu.title), sets enabled \(submenu.autoenablesItems)]"] + described(submenu, indent + "  ")
        }
    }

    private struct SwiftUIRows: View {
        let icon: NSImage

        var body: some View {
            Button("Plain") {}
            Button("Tip") {}.help("Move its items out first.")
            Button("Off") {}.disabled(true)
            Button {} label: { Text("Lab"); Text("Needs a newer Kuvo Code") }
            Button("Delete…", role: .destructive) {}
            Button {} label: { Label("Symbol", systemImage: "trash") }
            Button {} label: { Label { Text("App") } icon: { Image(nsImage: icon) } }
            Toggle("Checked", isOn: .constant(true))
            Divider()
            Text("Shared with claude in Terminal")
            Menu("Move To") { Button("Later") {}; Text("Nothing else") }
            Menu("Move to Computer") { Button("lab") {} }.disabled(true)
            Section("Header") { Button("In It") {} }
            Button("After") {}
        }
    }

    private func heldRows(_ icon: NSImage) -> [HeldRow] {
        [
            .button("Plain") {},
            .button("Tip", help: "Move its items out first.") {},
            .button("Off", disabled: true) {},
            .button("Lab", subtitle: "Needs a newer Kuvo Code") {},
            .button("Delete…", role: .destructive) {},
            .button("Symbol", image: "trash") {},
            .button("App", icon: icon) {},
            .button("Checked", checked: true) {},
            .divider,
            .note("Shared with claude in Terminal"),
            .submenu("Move To") { HeldRow.button("Later") {}; HeldRow.note("Nothing else") },
            .submenu("Move to Computer", disabled: true) { HeldRow.button("lab") {} },
            .section("Header") { HeldRow.button("In It") {} },
            .button("After") {},
        ]
    }

    /// The menu SwiftUI's `.contextMenu` made for these rows, as a right-click asks for it.
    private func swiftUIsMenu(_ icon: NSImage, disabled: Bool) throws -> [String] {
        let shown = Shown(Text("Row").frame(width: 300, height: 300).contextMenu { SwiftUIRows(icon: icon) }.disabled(disabled))
        defer { shown.close() }
        let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown, location: NSPoint(x: 150, y: 150), modifierFlags: [], timestamp: 0,
                                                    windowNumber: shown.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        let menu = try #require(shown.host.menu(for: event))
        menu.update()
        return described(menu)
    }

    /// `lines` with the rows that open these submenus dimmed: SwiftUI left a disabled `Menu`'s row
    /// as it was (opening onto disabled rows); a held one's is dimmed and doesn't open.
    private func dimming(_ submenus: [String], in lines: [String]) -> [String] {
        lines.map { line in
            submenus.contains { line.hasPrefix($0 + " | ") } ? line.replacingOccurrences(of: "enabled true", with: "enabled false") : line
        }
    }

    @Test(arguments: [false, true])
    func heldRowsMakeTheMenuSwiftUIsContextMenuMade(disabled: Bool) throws {
        let icon = NSWorkspace.shared.icon(for: .folder)
        let swiftUIs = dimming(disabled ? ["Move To", "Move to Computer"] : ["Move to Computer"], in: try swiftUIsMenu(icon, disabled: disabled))
        let shown = Shown(Text("Row").frame(width: 300, height: 300).heldContextMenu { heldRows(icon) }.disabled(disabled))
        defer { shown.close() }
        let held = described(try #require(try shown.rightClick(at: NSPoint(x: 150, y: 150))))
        #expect(held.count == swiftUIs.count)
        for (index, line) in swiftUIs.enumerated() where index < held.count {
            #expect(held[index] == line)
        }
    }

    @Test func aSwiftUIMenuOfHeldRowsIsTheMenuItWasBefore() {
        let icon = NSWorkspace.shared.icon(for: .folder)
        let before = NSHostingMenu(rootView: SwiftUIRows(icon: icon))
        let after = NSHostingMenu(rootView: HeldMenuContent(rows: heldRows(icon)))
        before.update()
        after.update()
        #expect(described(after) == described(before))
    }

    // MARK: What a menu shows

    private func rows(@HeldRows _ rows: () -> [HeldRow]) -> [HeldRow] { rows() }

    /// Rows that don't show now (read as a menu reads what's true when it opens).
    private let showsNow = false

    @Test func aLineOnlyGoesBetweenRows() throws {
        // At either end, and two together.
        #expect(titles(HeldRow.menu(rows {
            HeldRow.divider
            HeldRow.button("Pin") {}
            HeldRow.divider
            HeldRow.divider
            HeldRow.button("Copy as Markdown") {}
            HeldRow.divider
        })) == ["Pin", "—", "Copy as Markdown"])
        // Around rows that don't show now (a project's menu on a machine, a session that's archived).
        #expect(titles(HeldRow.menu(rows {
            HeldRow.button("New Session") {}
            if showsNow { HeldRow.button("Connect") {} }
            HeldRow.divider
            if showsNow { HeldRow.button("Show in Finder") {} }
            HeldRow.divider
            HeldRow.button("Remove Project…") {}
            HeldRow.divider
            if showsNow { HeldRow.button("Refresh Models") {} }
        })) == ["New Session", "—", "Remove Project…"])
        // A section after a divider: one line before its title.
        #expect(titles(HeldRow.menu(rows {
            HeldRow.button("Rename") {}
            HeldRow.divider
            HeldRow.section("Places") { HeldRow.button("lab") {} }
            HeldRow.divider
        })) == ["Rename", "—", "Places", "lab"])
        // In a submenu, made as it opens.
        let menu = HeldRow.menu(rows {
            HeldRow.submenu("Move To") {
                HeldRow.divider
                HeldRow.button("Later") {}
                HeldRow.divider
                HeldRow.divider
                HeldRow.button("Parked") {}
                HeldRow.divider
            }
        })
        let submenu = try #require(menu.items.first?.submenu)
        open(submenu)
        #expect(titles(submenu) == ["Later", "—", "Parked"])

        // Nothing but lines: no menu.
        let view = Text("Row").frame(width: 300, height: 300).heldContextMenu {
            HeldRow.divider
            if showsNow { HeldRow.button("Copy") {} }
            HeldRow.divider
        }
        let window = Shown(view)
        defer { window.close() }
        #expect(try window.rightClick(at: NSPoint(x: 150, y: 150)) == nil)
    }

    @Test func aDisabledSubmenuIsDimmedAndAnEmptyOneLeftOut() throws {
        let none: [String] = []
        let menu = HeldRow.menu(rows {
            HeldRow.submenu("Move to Computer", disabled: true) { HeldRow.button("lab") {} }
            HeldRow.submenu("Move to Project") {
                for project in none { HeldRow.button(project) {} }
            }
            HeldRow.button("Archive") {}
        })
        #expect(titles(menu) == ["Move to Computer", "Archive"])
        #expect(menu.items.first?.isEnabled == false, "dimmed, and so it doesn't open")
    }

    @Test func anEmptyTooltipIsNone() {
        let menu = HeldRow.menu([.button("Remove “Later”", help: "") {}, .button("Remove “Ideas”", help: "Move its items out first.") {}])
        #expect(menu.items.map(\.toolTip) == [nil, "Move its items out first."])
    }

    @Test func aRowWithAnIconAndASymbolShowsTheIconInEitherMenu() {
        let icon = NSWorkspace.shared.icon(for: .folder)
        let row = HeldRow.button("Finder", image: "folder", icon: icon) {}
        let appKit = HeldRow.menu([row])
        let swiftUI = NSHostingMenu(rootView: HeldMenuContent(rows: [row]))
        swiftUI.update()
        #expect(appKit.items.first?.image === icon)
        #expect(swiftUI.items.first?.image?.isTemplate == false, "the icon, not the symbol (a template)")
        #expect(swiftUI.items.first?.image?.size == icon.size)
    }

    // MARK: What's in front

    @Test func aMarkedViewUnderSomethingDrawnOverItHasNoMenuThere() throws {
        // Not in a list that scrolls: a card over the row, as the title bar's tabs, the Send
        // button or a header are over what's under them; and a marked card over a marked row.
        let view = VStack(spacing: 0) {
            ZStack(alignment: .trailing) {
                Text("Row").frame(width: 300, height: 50).heldContextMenu { HeldRow.button("Row") {} }
                Text("Card").frame(width: 80, height: 50).background(.background)
            }
            ZStack(alignment: .trailing) {
                Text("Row").frame(width: 300, height: 50).heldContextMenu { HeldRow.button("Row") {} }
                Text("Send").frame(width: 80, height: 50).background(.background).heldContextMenu { HeldRow.button("Send") {} }
            }
            Spacer()
        }
        let shown = Shown(view)
        defer { shown.close() }
        #expect(titles(try shown.rightClick(at: NSPoint(x: 50, y: 275))) == ["Row"])
        #expect(try shown.rightClick(at: NSPoint(x: 260, y: 275)) == nil, "the card's")
        #expect(titles(try shown.rightClick(at: NSPoint(x: 50, y: 225))) == ["Row"])
        #expect(titles(try shown.rightClick(at: NSPoint(x: 260, y: 225))) == ["Send"])
    }

    @Test func aRowInAHostingViewOfItsOwnOpensItsMenu() throws {
        // As the conversation's rows are: each in a hosting view of its own, in an AppKit list.
        let row = NSHostingView(rootView: Text("Reply").frame(width: 300, height: 60).heldContextMenu { HeldRow.button("Copy Reply") {} })
        row.frame = NSRect(x: 0, y: 0, width: 300, height: 60)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 300))
        let list = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 300))
        list.addSubview(row)
        scroll.documentView = list
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 300, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 300))
        content.addSubview(scroll)
        window.contentView = content
        content.layoutSubtreeIfNeeded()
        defer {
            window.contentView = nil
            window.close()
        }
        let frame = row.convert(row.bounds, to: nil)
        let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown, location: NSPoint(x: frame.midX, y: frame.midY), modifierFlags: [], timestamp: 0,
                                                    windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        #expect(titles(HeldMenus.shared.menu(for: event)?.menu) == ["Copy Reply"])
    }

    /// A view of someone else's that does its own thing with a right-click (a terminal, a web
    /// page), drawn in a marked view.
    final class Canvas: NSView {}

    private struct Hosted<Kind: NSView>: NSViewRepresentable {
        let make: () -> Kind
        func makeNSView(context: Context) -> Kind { make() }
        func updateNSView(_ view: Kind, context: Context) {}
    }

    @Test func aViewOfItsOwnInAMarkedViewKeepsItsClicks() throws {
        let view = HStack(spacing: 0) {
            Text("Panel").frame(width: 75, height: 50)
            Hosted { Canvas() }.frame(width: 75, height: 50)
            Hosted { () -> NSPopUpButton in
                let button = NSPopUpButton(frame: .zero, pullsDown: false)
                button.addItems(withTitles: ["Chromium", "Safari"])
                return button
            }
            .frame(width: 75, height: 30)
            Hosted { NSTextField(string: "https://kuvo.run") }.frame(width: 75, height: 24)
        }
        .frame(width: 300, height: 50)
        .heldContextMenu { HeldRow.button("Close Tab") {} }
        .frame(maxHeight: .infinity, alignment: .top)
        let shown = Shown(view)
        defer { shown.close() }
        // Asked as a click there would ask, without sending it on to what keeps it.
        func menu(on view: NSView?, control: Bool = false) throws -> NSMenu? {
            let view = try #require(view)
            let frame = view.convert(view.bounds, to: nil)
            let event = try #require(NSEvent.mouseEvent(with: control ? .leftMouseDown : .rightMouseDown, location: NSPoint(x: frame.midX, y: frame.midY),
                                                        modifierFlags: control ? .control : [], timestamp: 0, windowNumber: shown.window.windowNumber,
                                                        context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
            return HeldMenus.shared.menu(for: event)?.menu
        }
        let views = all(in: shown.host)
        #expect(titles(try shown.rightClick(at: NSPoint(x: 37, y: 275))) == ["Close Tab"], "on the marked view itself")
        #expect(try menu(on: views.first { $0 is Canvas }) == nil)
        #expect(try menu(on: views.first { $0 is Canvas }, control: true) == nil)
        #expect(try menu(on: views.first { $0 is NSPopUpButton }) == nil, "its own menu")
        #expect(try menu(on: views.first { $0 is NSPopUpButton }, control: true) == nil)
        #expect(try menu(on: views.first { type(of: $0) == NSTextField.self }, control: true) == nil, "a Control-click is the field's")
    }

    // MARK: VoiceOver

    @Test func voiceOversShowMenuOpensIt() async throws {
        AXElement.reading(true)
        defer { AXElement.reading(false) }
        let shown = Shown(VStack {
            Text("Plain").accessibilityLabel("Plain")
            Button("Archived") {}.heldContextMenu { HeldRow.button("Unarchive") {}; HeldRow.button("Delete…", role: .destructive) {} }
        })
        defer { shown.close() }
        shown.window.orderBack(nil)
        shown.host.layoutSubtreeIfNeeded()
        var caught: NSMenu?
        let present = HeldMenus.shared.present
        HeldMenus.shared.present = { menu, _, _ in
            caught = menu
            TestPulse.beat()
        }
        defer { HeldMenus.shared.present = present }

        let elements = AXElement.all(in: shown.host)
        let row = try #require(elements.first { $0.label == "Archived" }, "among \(elements.compactMap(\.label))")
        #expect(row.object.accessibilityPerformShowMenu?() == true)
        try await until { caught != nil }
        #expect(titles(caught) == ["Unarchive", "Delete…"])
        let plain = try #require(elements.first { $0.label == "Plain" })
        #expect(plain.object.accessibilityPerformShowMenu?() != true, "only what has a menu offers it")
    }

    @Test func everyElementInAMarkedViewOffersShowMenu() async throws {
        AXElement.reading(true)
        defer { AXElement.reading(false) }
        // A row of several elements, as a work item's (its title, its number, who's on it).
        let shown = Shown(HStack {
            Text("Write the tests").accessibilityLabel("Write the tests")
            Text("#243").accessibilityLabel("#243")
        }
        .heldContextMenu { HeldRow.button("Move to Top") {} })
        defer { shown.close() }
        shown.window.orderBack(nil)
        shown.host.layoutSubtreeIfNeeded()
        var caught: [NSMenu] = []
        let present = HeldMenus.shared.present
        HeldMenus.shared.present = { menu, _, _ in
            caught.append(menu)
            TestPulse.beat()
        }
        defer { HeldMenus.shared.present = present }

        let elements = AXElement.all(in: shown.host)
        for label in ["Write the tests", "#243"] {
            let element = try #require(elements.first { $0.label == label }, "among \(elements.compactMap(\.label))")
            #expect(element.object.accessibilityPerformShowMenu?() == true, "\(label)")
        }
        try await until { caught.count == 2 }
        #expect(caught.map { titles($0) } == [["Move to Top"], ["Move to Top"]])
    }
}
