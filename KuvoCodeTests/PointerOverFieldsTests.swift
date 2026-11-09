import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Text fields (a page's search field, a sheet's name and keys) show the I-beam where you'd type,
/// but never under a button or bar drawn over them: over the button, the button's pointer. Here
/// the search fields Settings and Accounts use, in a window of the test's own, with a bar and its
/// button floating over the bottom one, as a sheet's bottom bar or a page's Done button floats
/// over what scrolls under it. Nothing moves the real pointer: the fields are asked what they'd
/// show, or told of a move as AppKit tells them.
@MainActor
@Suite(.serialized) struct PointerOverFieldsTests {
    struct Page: View {
        @State private var texts = ["", "", "", ""]

        var body: some View {
            VStack(spacing: 12) {
                ForEach(texts.indices, id: \.self) { index in
                    SearchField(text: $texts[index], prompt: "Search")
                }
            }
            .padding(20)
            .frame(width: 420, height: 260, alignment: .bottom)
            .overlay(alignment: .bottom) {
                Button("Done") {}
                    .buttonStyle(.borderedProminent)
                    .frame(width: 200, height: 40)
                    .background(.background)
                    .padding(.bottom, 14)
            }
        }
    }

    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 420, height: 260), styleMask: [.titled], backing: .buffered, defer: false)

    init() async throws {
        TestEnvironment.prepare()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Page())
        window.orderBack(nil)
        WindowServer.pointerIsOver(window)
        var turns = 0
        // Laid out, and the fields' rectangles given, as AppKit asks for them once the pointer is
        // in the window (`WindowServer.appKitsTurn`).
        while !isReady, turns < 400 {
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            WindowServer.appKitsTurn(over: window)
            await Task.yield()
            turns += 1
        }
    }

    private var isReady: Bool {
        guard fields.count == 4, let beside = besideTheButton(), let field = field(under: beside) else { return false }
        return CursorRects.cursor(of: field, at: beside) != nil
    }

    private func done() {
        WindowServer.pointerLeft(window)
        NSCursor.arrow.set()
        window.orderOut(nil)
        window.close()
    }

    private func all(in view: NSView?) -> [NSView] {
        guard let view else { return [] }
        return [view] + view.subviews.flatMap { all(in: $0) }
    }

    /// The fields' own views: the AppKit fields SwiftUI types in.
    private var fields: [NSTextField] {
        all(in: window.contentView).compactMap { $0 as? NSTextField }.filter(\.isEditable)
    }

    private func hit(_ point: NSPoint) -> NSView? {
        var root = window.contentView
        while let parent = root?.superview { root = parent }
        return root?.hitTest(point)
    }

    /// The field laid out under `point` (in the window), whatever is over it.
    private func field(under point: NSPoint) -> NSTextField? {
        fields.first { $0.convert($0.bounds, to: nil).contains(point) }
    }

    /// Points across the bottom field that the button is drawn over (a click there reaches
    /// SwiftUI's view, which has the button, not the field).
    private func pointsUnderTheButton() -> [NSPoint] {
        guard let bottom = fields.min(by: { $0.convert($0.bounds, to: nil).minY < $1.convert($1.bounds, to: nil).minY }) else { return [] }
        let rect = bottom.convert(bottom.bounds, to: nil)
        return stride(from: rect.minX + 2, to: rect.maxX - 2, by: 4).map { NSPoint(x: $0, y: rect.midY) }.filter { point in
            guard let hit = hit(point) else { return false }
            return hit !== bottom && !hit.isDescendant(of: bottom)
        }
    }

    /// A point on the bottom field beside the button, level with the others.
    private func besideTheButton() -> NSPoint? {
        guard let under = pointsUnderTheButton().first, let bottom = field(under: under) else { return nil }
        let rect = bottom.convert(bottom.bounds, to: nil)
        return stride(from: rect.minX + 2, to: under.x, by: 2).map { NSPoint(x: $0, y: under.y) }.first { hit($0) === bottom }
    }

    /// The pointer moved to `point` (in the window), as AppKit tells it: to the owner of each
    /// tracking area for moves that has the point, and first, when it `comesOn`, a cursor update to
    /// the innermost one for those that has it (the one AppKit sends as the pointer comes on).
    private func move(to point: NSPoint, comesOn: Bool = false) throws {
        let event = try #require(NSEvent.mouseEvent(with: .mouseMoved, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
        let areas = all(in: window.contentView).flatMap { view in
            view.trackingAreas.filter { area in
                let local = view.convert(point, from: nil)
                return (area.options.contains(.inVisibleRect) ? view.visibleRect : area.rect).contains(local)
            }
        }
        if comesOn {
            if let area = areas.last(where: { $0.options.contains(.cursorUpdate) }) {
                let update = try #require(NSEvent.enterExitEvent(with: .cursorUpdate, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, trackingNumber: Int(bitPattern: Unmanaged.passUnretained(area).toOpaque()), userData: nil))
                (area.owner as? NSResponder)?.cursorUpdate(with: update)
            }
        }
        for area in areas where area.options.contains(.mouseMoved) {
            (area.owner as? NSResponder)?.mouseMoved(with: event)
        }
    }

    @Test func noIBeamUnderAButtonOverAField() throws {
        defer { done() }
        let under = pointsUnderTheButton()
        #expect(under.count > 10, "the bottom field under the button at \(under.count) points")
        for point in under {
            let field = try #require(field(under: point))
            #expect(CursorRects.cursor(of: field, at: point) == nil, "the I-beam at \(point.x), under the button")
        }
        // Beside the button, and on the fields above: the I-beam.
        let beside = try #require(besideTheButton())
        #expect(CursorRects.cursor(of: try #require(field(under: beside)), at: beside) == .iBeam)
        for field in fields {
            let middle = field.convert(NSPoint(x: field.bounds.midX, y: field.bounds.midY), to: nil)
            guard hit(middle) === field else { continue }
            #expect(CursorRects.cursor(of: field, at: middle) == .iBeam)
        }
    }

    @Test func movingOntoTheButtonLetsTheIBeamGo() throws {
        defer { done() }
        let beside = try #require(besideTheButton())
        let under = try #require(pointsUnderTheButton().first)
        NSCursor.arrow.set()
        try move(to: beside)
        #expect(NSCursor.current == .iBeam, "on the field")
        try move(to: under)
        #expect(NSCursor.current != .iBeam, "over the button")
        try move(to: beside)
        #expect(NSCursor.current == .iBeam, "back on the field")
    }

    /// While you type in it, a field shows the I-beam from AppKit's text it's edited in: coming
    /// onto the field where the button is shows none, moving onto the field beside it does.
    @Test func noIBeamUnderAButtonOverTheFieldYoureTypingIn() async throws {
        defer { done() }
        let beside = try #require(besideTheButton())
        let bottom = try #require(field(under: beside))
        #expect(window.makeFirstResponder(bottom))
        let editor = try #require(window.firstResponder as? NSTextView, "typing in the field")
        // Its tracking areas come once it's laid out in the field.
        var turns = 0
        while !editor.trackingAreas.contains(where: { $0.options.contains(.cursorUpdate) }), turns < 400 {
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            WindowServer.appKitsTurn(over: window)
            await Task.yield()
            turns += 1
        }
        // Where the text it's edited in is, under the button.
        let shows = editor.convert(editor.visibleRect, to: nil)
        let under = try #require(pointsUnderTheButton().first { shows.contains($0) }, "the text it's edited in, \(shows), under the button")
        NSCursor.arrow.set()
        try move(to: under, comesOn: true)
        #expect(NSCursor.current != .iBeam, "coming on under the button")
        try move(to: beside)
        #expect(NSCursor.current == .iBeam, "on the field")
        try move(to: under)
        #expect(NSCursor.current != .iBeam, "over the button")
    }
}

/// A longer text you type in a sheet (a skill's or a vault item's, SwiftUI's TextEditor) shows the
/// I-beam as the pointer comes onto it, and lets it go when the sheet closes under the pointer: the
/// arrow comes back over what was under it.
@MainActor
@Suite(.serialized) struct PointerOverTextEditorTests {
    @MainActor @Observable final class Sheet {
        var isOpen = true
        var text = "Steps for the skill"
    }

    struct Page: View {
        let sheet: Sheet

        var body: some View {
            @Bindable var sheet = sheet
            VStack {
                if sheet.isOpen { TextEditor(text: $sheet.text) }
            }
            .padding(20)
            .frame(width: 420, height: 260)
        }
    }

    @Test func closingUnderThePointerLetsTheIBeamGo() async throws {
        TestEnvironment.prepare()
        let sheet = Sheet()
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 420, height: 260), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Page(sheet: sheet))
        window.orderBack(nil)
        WindowServer.pointerIsOver(window)
        defer {
            WindowServer.pointerLeft(window)
            NSCursor.arrow.set()
            window.orderOut(nil)
            window.close()
        }
        func all(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(all) }
        func settle(until ready: () -> Bool) async {
            var turns = 0
            while !ready(), turns < 400 {
                window.contentView?.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                WindowServer.appKitsTurn(over: window)
                await Task.yield()
                turns += 1
            }
        }
        var editor: NSTextView? { window.contentView.flatMap { all($0).compactMap { $0 as? NSTextView }.first } }
        await settle { editor?.trackingAreas.contains { $0.owner === editor && $0.options.contains(.cursorUpdate) } == true }
        let text = try #require(editor)
        let area = try #require(text.trackingAreas.first { $0.owner === text && $0.options.contains(.cursorUpdate) })
        let point = text.convert(NSPoint(x: text.visibleRect.midX, y: text.visibleRect.midY), to: nil)

        // Coming onto it, as AppKit tells it.
        NSCursor.arrow.set()
        let update = try #require(NSEvent.enterExitEvent(with: .cursorUpdate, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, trackingNumber: Int(bitPattern: Unmanaged.passUnretained(area).toOpaque()), userData: nil))
        text.cursorUpdate(with: update)
        #expect(NSCursor.current == .iBeam, "on the text")

        // Closed under the pointer: no move comes, the arrow does.
        sheet.isOpen = false
        await settle { text.window == nil }
        #expect(text.window == nil)
        #expect(NSCursor.current != .iBeam, "the text is gone")
    }
}
