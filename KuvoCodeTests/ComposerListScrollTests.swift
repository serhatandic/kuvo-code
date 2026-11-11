import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The lists over the composer's field keep to the room the conversation leaves them, in a short
/// window (#299, as the phone's #228): the "/" list of a project with many commands of its own,
/// longer than that room, scrolls inside rather than running off the window's top, and as ↓ and ↑
/// go past the rows in sight, the chosen one comes into view. In a conversation, and on a new
/// conversation's page. The conversation, the page and their composers are the real ones, in a
/// window of the test's own; the engine is a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ComposerListScrollTests {
    let engine = StubEngine(port: 48_299)
    let app = AppModel()
    let catalog = Catalog()
    let model: SessionModel
    /// Short: the list's twelve rows are taller than the room it has.
    static let size = NSSize(width: 720, height: 440)
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    static let directory = "/tmp/kuvo-tests-list-room"

    init() async throws {
        TestEnvironment.prepare()
        let directory = Self.directory
        app.workspace.api = engine.api
        catalog.api = engine.api
        // The project's own commands, more than the list shows (twelve).
        let commands = (1...20).map { ["name": String(format: "cmd-%02d", $0), "description": "Runs the project’s steps"] }
        engine.on("GET", "/api/command", json: ["location": ["directory": directory], "data": commands])
        engine.list([StubEngine.session("ses_listroom", title: "Lists", directory: directory, created: 1)])
        engine.conversation("ses_listroom", [])
        await app.workspace.refresh()
        model = try #require(app.workspace.model(for: "ses_listroom"))
        // Last, once nothing here can throw: `done()` switches it off again.
        AXElement.reading(true)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AnyView(EmptyView()))
        window.orderBack(nil)
    }

    /// `view` in the window, at `size`.
    private func show(_ view: some View, _ size: NSSize = ComposerListScrollTests.size) {
        window.setContentSize(size)
        let root = AnyView(view
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: size.width, height: size.height))
        (window.contentView as? NSHostingView<AnyView>)?.rootView = root
    }

    /// The new conversation's page, for the project.
    private var page: some View { DraftSessionView(directory: Self.directory) { _, _, _ in } }

    private func done() {
        Drafts.shared.remove(model.id)
        Drafts.shared.remove(SidebarView.draftTag(Self.directory))
        engine.stop()
        window.orderOut(nil)
        window.close()
        window.contentView = nil
        AXElement.reading(false)
    }

    /// What VoiceOver finds in the window, as it lays out now (each look lays it out first, and
    /// says so on the main queue's next turn, for `until` to look again after SwiftUI's update).
    private var elements: [AXElement] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView)
    }

    private var field: MessageTextView? {
        func fields(_ view: NSView?) -> [MessageTextView] {
            guard let view else { return [] }
            return (view as? MessageTextView).map { [$0] } ?? view.subviews.flatMap { fields($0) }
        }
        return fields(window.contentView).first
    }

    /// The "/" list's rows, each by its command's name.
    private func row(_ name: String) -> AXElement? {
        elements.first { $0.label?.contains("/" + name) == true }
    }

    private var chosen: AXElement? {
        elements.first { $0.isSelected && $0.label?.contains("/cmd-") == true }
    }

    /// In sight, between the field and what's kept over the list (the conversation's room, the
    /// page's title). (VoiceOver's frames are on the screen, y going up.)
    private func inView(_ row: AXElement, keeping kept: CGFloat) -> Bool {
        guard let field else { return false }
        let scroller = field.enclosingScrollView ?? field
        let fieldFrame = window.convertToScreen(scroller.convert(scroller.bounds, to: nil))
        let content = window.convertToScreen(window.contentView?.frame ?? .zero)
        return row.frame.minY >= fieldFrame.maxY - 1 && row.frame.maxY <= content.maxY - kept
    }

    /// "/cmd" typed in the window's composer: its list, twelve of the project's commands.
    private func typeCommands() async throws {
        try await until { !elements.isEmpty && field != nil && !catalog.commands(in: Self.directory).isEmpty }
        let field = try #require(field)
        window.makeFirstResponder(field)
        field.insertText("/cmd", replacementRange: NSRange(location: NSNotFound, length: 0))
        try await until { row("cmd-12") != nil && chosen?.label?.contains("/cmd-01") == true }
    }

    @Test func aListLongerThanTheRoomScrollsAndKeepsTheChosenRowInView() async throws {
        defer { done() }
        show(SessionView(model: model))
        try await typeCommands()
        // Open: its first row, chosen, in sight under the conversation's room, not off the top.
        try await until { row("cmd-01").map { inView($0, keeping: 120) } == true }
        try await walk(keeping: 120)
    }

    /// On a new conversation's page, the list open as the window gets short: it keeps to what the
    /// page's title leaves it, rather than growing the page past the window.
    @Test func onANewConversationsPageTheListKeepsToTheWindowAsItShrinks() async throws {
        defer { done() }
        show(page, NSSize(width: 720, height: 900))
        try await typeCommands()
        show(page)
        try await until { row("cmd-01").map { inView($0, keeping: 60) } == true }
        try await walk(keeping: 60)
    }

    /// ↓ past the rows in sight, to the last, and ↑ back to the first: each one chosen comes into view.
    private func walk(keeping kept: CGFloat) async throws {
        let key = { (characters: String, code: UInt16) in
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: self.window.windowNumber,
                             context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)
        }
        let down = try #require(key(String(UnicodeScalar(NSDownArrowFunctionKey)!), 125))
        let up = try #require(key(String(UnicodeScalar(NSUpArrowFunctionKey)!), 126))
        for number in 2...12 {
            try #require(field).keyDown(with: down)
            let name = String(format: "/cmd-%02d", number)
            try await until { chosen?.label?.contains(name) == true }
        }
        try await until { chosen.map { inView($0, keeping: kept) } == true }
        // Longer than its room: the first row went out of sight to make way.
        // (Or gone from what VoiceOver reads, out of sight.)
        let scrolledAway = row("cmd-01")
        #expect(scrolledAway.map { !inView($0, keeping: kept) } ?? true, "the list scrolled: its first row at \(scrolledAway?.frame ?? .zero)")

        // And ↑ back up to the first: in sight again.
        for number in (1...11).reversed() {
            try #require(field).keyDown(with: up)
            let name = String(format: "/cmd-%02d", number)
            try await until { chosen?.label?.contains(name) == true }
        }
        try await until { chosen.map { inView($0, keeping: kept) } == true }
    }
}
