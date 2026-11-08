import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Escape closes what's open over the conversation before it stops the agent (#287: a picture you
/// sent, looked at closer, stayed open while Escape stopped the agent at work). With nothing open,
/// Escape stops it, wherever the keyboard is. The window's real Escape (`EscapeToStop`) and the
/// real picture viewer, in a window of the test's own; Escape goes in through the app, monitors
/// first, as a key press does.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct EscapeOrderTests {
    final class TestWindow: NSWindow {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    final class Stops { var count = 0 }

    let window = TestWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 700, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
    let stops = Stops()
    let folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-tests-escape-\(UUID().uuidString)")

    init() throws {
        TestEnvironment.prepare()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let stops = stops
        let view = ZStack { Color.gray }
            .background(EscapeToStop(canStop: true) { stops.count += 1 })
            .overlay { ImageViewerOverlay() }
            .frame(width: 700, height: 500)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderBack(nil)
    }

    private func done() {
        ImageViewer.shared.close()
        window.orderOut(nil)
        window.close()
        window.contentView = nil
        try? FileManager.default.removeItem(at: folder)
    }

    /// Escape, pressed: queued, as a hand's would be, where the app's monitors see it first (the
    /// window's Escape is one). (This window is never key, so AppKit gives it nothing the monitors
    /// let through.)
    private func pressEscape() async throws {
        let escape = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                      windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                                      isARepeat: false, keyCode: 53)!
        NSApp.postEvent(escape, atStart: false)
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
    }

    /// The window's Escape in place: laid out, its watcher in the window.
    private func settled() async throws {
        func watchers(in view: NSView?) -> Int {
            guard let view else { return 0 }
            return (view is EscapeToStop.Watcher ? 1 : 0) + view.subviews.reduce(0) { $0 + watchers(in: $1) }
        }
        try await until {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            return watchers(in: window.contentView) > 0
        }
    }

    private func picture() throws -> URL {
        let image = NSImage(size: NSSize(width: 40, height: 30), flipped: false) { rect in
            NSColor.systemTeal.setFill()
            rect.fill()
            return true
        }
        let tiff = try #require(image.tiffRepresentation)
        let png = try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
        let url = folder.appending(path: "sent.png")
        try png.write(to: url)
        return url
    }

    @Test func escapeClosesThePictureBeforeItStopsTheAgent() async throws {
        defer { done() }
        try await settled()
        ImageViewer.shared.show([.local(try picture())])
        // On screen. (It takes the keyboard as it opens in a window that's key; this one never is,
        // as when the keyboard stayed where it was.)
        try await until {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            return ImageViewer.shared.request != nil
        }

        try await pressEscape()
        #expect(ImageViewer.shared.request == nil, "the picture closes")
        #expect(stops.count == 0, "and the agent goes on")

        // Nothing open now: Escape stops it, from where the viewer left the keyboard.
        try await settled()
        try await pressEscape()
        #expect(stops.count == 1)
    }

    /// With nothing open and the keyboard nowhere in particular, Escape stops the agent.
    @Test func escapeWithNothingOpenStopsTheAgent() async throws {
        defer { done() }
        window.makeFirstResponder(nil)
        try await settled()
        try await pressEscape()
        #expect(stops.count == 1)
    }

    /// The composer with the keyboard while a picture is open over an ask's card (it opened from
    /// the composer, and the keyboard didn't follow it in): Escape closes the picture, and neither
    /// answers the card under it nor stops the agent.
    /// (The window's Escape takes it before AppKit's own pass would offer it to the card; this
    /// window is never key, so what it let through would go nowhere here: the card's check
    /// catches only the window's Escape offering it to the card before the picture.)
    @Test func escapeInTheComposerClosesThePictureBeforeACardUnderIt() async throws {
        defer { done() }
        final class Cancels { var count = 0 }
        let app = AppModel()
        let cancels = Cancels(), stops = stops
        let composer = Composer(session: "ses_escape", text: .constant(""), files: .constant([]), quotes: .constant([]), quoteFocus: nil,
                                agent: "build", approval: .fullAccess, model: nil, isRunning: true, keywords: [],
                                onSelectAgent: { _ in }, onSelectApproval: { _ in }, onSelectModel: { _ in }, onSend: {}, onStop: { stops.count += 1 })
            .environment(\.messageFont, MessageFont())
            .environment(app)
            .environment(app.workspace)
            .environment(app.catalog)
        let view = VStack {
            Button("Don’t Allow") { cancels.count += 1 }.keyboardShortcut(.cancelAction)
            composer
        }
        .frame(width: 700, height: 300, alignment: .bottom)
        .background(EscapeToStop(canStop: true) { stops.count += 1 })
        .overlay { ImageViewerOverlay() }
        window.contentView = NSHostingView(rootView: view)
        func field() -> MessageTextView? {
            window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            return all(in: window.contentView).first { $0.accessibilityIdentifier() == "composer" }
        }
        try await until { field()?.window != nil }
        try await settled()
        let text = try #require(field())

        ImageViewer.shared.show([.local(try picture())])
        window.makeFirstResponder(text)
        #expect(window.firstResponder === text, "the composer has the keyboard")
        try await pressEscape()
        #expect(ImageViewer.shared.request == nil, "the picture closes")
        #expect(cancels.count == 0, "the card under it isn't answered")
        #expect(stops.count == 0, "and the agent goes on")
    }

    private func all(in view: NSView?) -> [MessageTextView] {
        guard let view else { return [] }
        return ((view as? MessageTextView).map { [$0] } ?? []) + view.subviews.flatMap { all(in: $0) }
    }

    /// A card that takes Escape (an ask's Cancel) gets it before the agent is stopped.
    @Test func aCardsCancelGetsEscapeBeforeTheAgentStops() async throws {
        defer { done() }
        final class Cancels { var count = 0 }
        let cancels = Cancels(), stops = stops
        let view = ZStack { Button("Cancel") { cancels.count += 1 }.keyboardShortcut(.cancelAction) }
            .background(EscapeToStop(canStop: true) { stops.count += 1 })
            .frame(width: 700, height: 500)
        window.contentView = NSHostingView(rootView: view)
        try await settled()
        window.makeFirstResponder(nil)
        try await pressEscape()
        #expect(cancels.count == 1, "the card's Cancel")
        #expect(stops.count == 0, "and the agent goes on")
    }
}
