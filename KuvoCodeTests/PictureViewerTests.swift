import AppKit
import CoreGraphics
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A picture opens among every picture of its conversation (#445): yours and the agent's, across
/// all its messages, in order, not only its own message's. From there the one before or after is a
/// two-finger swipe on the trackpad, an arrow key or ‹ › away, in the viewer over the window and in
/// the side panel. The conversation is the real one, in a window of the test's own, clicked through
/// the window; swipes and keys go in through the app, as the trackpad's and the keyboard's do
/// (this window is never key: the app's monitors see them first). The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PictureViewerTests {
    final class TestWindow: NSWindow {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    let engine = StubEngine(port: 48_445)
    let app = AppModel()
    let catalog = Catalog()
    let id = "ses_pictures_" + UUID().uuidString.prefix(8)
    let folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-tests-pictures-\(UUID().uuidString)").standardizedFileURL
    static let size = NSSize(width: 760, height: 640)
    let model: SessionModel
    let window = TestWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.titled], backing: .buffered, defer: false)

    init() async throws {
        TestEnvironment.prepare()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Self.png(.systemTeal).write(to: folder.appending(path: "light.png"))
        try Self.png(.systemPurple).write(to: folder.appending(path: "dark.png"))
        try Self.png(.systemOrange).write(to: folder.appending(path: "made.png"))
        try Self.png(.systemYellow).write(to: folder.appending(path: "new.png"))
        app.workspace.api = engine.api
        let conversation: [[String: Any]] = [
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "This is how it looks now.",
             "files": [["mime": "image/png", "name": "before.png", "source": ["type": "uri", "uri": try Self.dataURI(.systemRed)]]]],
            ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2_000, "completed": 2_500], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": "Here it is in light and dark:"],
                         Self.shown("call_light", folder.appending(path: "light.png").path), Self.shown("call_dark", folder.appending(path: "dark.png").path),
                         ["type": "tool", "id": "call_made", "name": "generate_image", "state": ["status": "completed", "input": ["prompt": "a sunset"],
                          "content": [["type": "file", "uri": folder.appending(path: "made.png").absoluteString, "mime": "image/png", "name": "made"]]]]]],
            ["id": "msg_03", "type": "idle", "time": ["created": 3_000], "outcome": "succeeded"],
            ["id": "msg_04", "type": "user", "time": ["created": 4_000], "text": "And after the fix?",
             "files": [["mime": "image/png", "name": "after.png", "source": ["type": "uri", "uri": try Self.dataURI(.systemGreen)]]]],
        ]
        engine.list([StubEngine.session(id, title: "Pictures", directory: folder.path)])
        engine.conversation(id, conversation)
        await app.workspace.refresh()
        let model = try #require(app.workspace.model(for: id))
        self.model = model
        await model.load()
        AXElement.reading(true)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AnyView(SessionView(model: model)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .overlay { ImageViewerOverlay() }
            .frame(width: Self.size.width, height: Self.size.height)))
        window.orderBack(nil)
    }

    private func done() {
        ImageViewer.shared.close()
        engine.stop()
        window.orderOut(nil)
        window.close()
        window.contentView = nil
        AXElement.reading(false)
        try? FileManager.default.removeItem(at: folder)
    }

    private static func shown(_ id: String, _ path: String) -> [String: Any] {
        ["type": "tool", "id": id, "name": "kuvo-browser_show_file", "state": ["status": "completed", "input": ["path": path], "content": [["type": "text", "text": "Shown."]]]]
    }

    private static func png(_ color: NSColor) throws -> Data {
        let image = NSImage(size: NSSize(width: 80, height: 60), flipped: false) { rect in
            color.setFill()
            rect.fill()
            return true
        }
        let tiff = try #require(image.tiffRepresentation)
        return try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
    }

    private static func dataURI(_ color: NSColor) throws -> String {
        "data:image/png;base64," + (try png(color)).base64EncodedString()
    }

    // MARK: What it shows

    private var elements: [AXElement] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView)
    }

    private var labels: [String] { elements.compactMap(\.label) }

    /// The viewer says "2 of 4" and the picture's name.
    private func shows(_ count: String, _ name: String) -> Bool {
        let labels = labels
        return labels.contains(count) && labels.contains(name)
    }

    /// A click on the picture in the conversation whose tip names it, sent through the window.
    private func clickPicture(_ name: String) async throws {
        var found: AXElement?
        try await until {
            found = elements.first { $0.help?.hasPrefix(name + " — ") == true }
            return found != nil
        }
        let frame = try #require(found).frame
        let point = window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try #require(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
    }

    /// The viewer open on the conversation's pictures as the test lays them out, without a click.
    private func openViewer(on index: Int) {
        let items: [AttachmentItem] = [
            .local(folder.appending(path: "light.png")), .local(folder.appending(path: "dark.png")),
        ]
        ImageViewer.shared.show(items, at: index)
    }

    /// The window as it looks, into KUVO_SHOTS_OUT when that's set: for a look, not a check.
    private func shoot(_ name: String) {
        guard let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"], let view = window.contentView else { return }
        try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        view.layoutSubtreeIfNeeded()
        view.display()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out).appending(path: "mac-\(name).png"))
    }

    // MARK: Events as the trackpad and keyboard send them

    /// Delivered as AppKit delivers what comes in: its monitors first, then the window.
    private func deliver(_ events: [NSEvent]) async throws {
        for event in events { NSApp.postEvent(event, atStart: false) }
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
    }

    private func press(_ keyCode: UInt16) async throws {
        let characters = String(UnicodeScalar(keyCode == 123 ? 0xF702 : 0xF703)!)
        let key = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.function, .numericPad], timestamp: ProcessInfo.processInfo.systemUptime,
                                                windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters,
                                                isARepeat: false, keyCode: keyCode))
        try await deliver([key])
    }

    /// Two fingers across the trackpad over the middle of the window, `fingers` points (left
    /// negative; up and down with `vertical`), in steps as the trackpad sends them, then lifted.
    private func swipe(fingers: CGFloat, vertical: Bool = false, steps: Int = 8) async throws {
        let middle = window.convertPoint(toScreen: NSPoint(x: Self.size.width / 2, y: Self.size.height / 2))
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        let location = CGPoint(x: middle.x, y: top - middle.y)
        func event(_ phase: Int64, _ delta: CGFloat) throws -> NSEvent {
            let made = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: vertical ? Int32(delta) : 0, wheel2: vertical ? 0 : Int32(delta), wheel3: 0))
            made.location = location
            made.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            made.setIntegerValueField(vertical ? .scrollWheelEventPointDeltaAxis1 : .scrollWheelEventPointDeltaAxis2, value: Int64(delta))
            made.setDoubleValueField(vertical ? .scrollWheelEventFixedPtDeltaAxis1 : .scrollWheelEventFixedPtDeltaAxis2, value: Double(delta))
            made.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
            made.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
            made.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
            return try #require(NSEvent(cgEvent: made))
        }
        // The way the scroll goes with the fingers, as this Mac has it.
        let inverted = try event(1, 1).isDirectionInvertedFromDevice
        let step = (inverted ? fingers : -fingers) / CGFloat(steps)
        var events = [try event(1, step)]
        for _ in 1..<steps { events.append(try event(2, step)) }
        events.append(try event(4, 0))
        try await deliver(events)
    }

    // MARK: Scenarios

    @Test func aPictureOpensAmongEveryPictureOfTheConversation() async throws {
        defer { done() }
        shoot("conversation")
        try await clickPicture("after.png")
        try await until { ImageViewer.shared.request != nil && labels.contains("after.png") }
        shoot("opened-on-the-last-message")
        let request = try #require(ImageViewer.shared.request)
        #expect(request.items.map(\.name) == ["before.png", "light.png", "dark.png", "made.png", "after.png"], "your pictures and the agent's, from every message, in order")
        try await until { shows("5 of 5", "after.png") }
        // Back across the agent's message to your first.
        try await swipe(fingers: 260)
        try await until { shows("4 of 5", "made.png") }
        shoot("swiped-back-to-the-agents")
        for _ in 0..<3 { try await press(123) }
        try await until { shows("1 of 5", "before.png") }
        shoot("arrowed-back-to-the-first-message")
    }

    @Test func arrowKeysGoToThePictureBeforeAndAfter() async throws {
        defer { done() }
        openViewer(on: 1)
        try await until { shows("2 of 2", "dark.png") }
        try await press(123)
        try await until { shows("1 of 2", "light.png") }
        try await press(124)
        try await until { shows("2 of 2", "dark.png") }
    }

    @Test func aSwipeOnTheTrackpadGoesToThePictureBeforeAndAfter() async throws {
        defer { done() }
        openViewer(on: 0)
        try await until { shows("1 of 2", "light.png") }
        // Fingers to the left: the next comes in from the right, as in Photos.
        try await swipe(fingers: -260)
        try await until { shows("2 of 2", "dark.png") }
        // Too little, and it stays; up or down isn't a turn.
        try await swipe(fingers: 12)
        try await swipe(fingers: -260, vertical: true)
        #expect(shows("2 of 2", "dark.png"))
        try await swipe(fingers: 260)
        try await until { shows("1 of 2", "light.png") }
    }

    @Test func theComposersPicturesComeAfterTheConversations() async throws {
        defer { done() }
        model.draftFiles = [folder.appending(path: "new.png")]
        var found: AXElement?
        try await until {
            found = elements.first { $0.label == "new.png" && $0.help?.contains("new.png") == true }
            return found != nil
        }
        #expect(try #require(found).press())
        try await until { shows("6 of 6", "new.png") }
        #expect(ImageViewer.shared.request?.items.map(\.name) == ["before.png", "light.png", "dark.png", "made.png", "after.png", "new.png"])
        try await press(123)
        try await until { shows("5 of 6", "after.png") }
    }

    @Test func whatsUndoneIsntAmongThem() async throws {
        defer { done() }
        engine.list([StubEngine.session(id, title: "Pictures", directory: folder.path, extra: ["revert": ["messageID": "msg_04"]])])
        await app.workspace.refresh()
        try await until { model.session.revert != nil }
        try await clickPicture("light.png")
        try await until { shows("2 of 4", "light.png") }
        #expect(ImageViewer.shared.request?.items.map(\.name) == ["before.png", "light.png", "dark.png", "made.png"])
    }

    @Test func aPictureInTheSidePanelSwipesToTheConversationsNext() async throws {
        defer { done() }
        window.contentView = nil
        app.utilities.inView = Utilities.InView(session: id)
        let light = folder.appending(path: "light.png"), dark = folder.appending(path: "dark.png")
        window.contentView = NSHostingView(rootView: AnyView(FileViewer(url: light, root: folder.path, mention: "light.png", showsTree: .constant(false))
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: Self.size.width, height: Self.size.height)))
        try await until { elements.contains { $0.help == "Pinch or double-click to zoom" } }
        try await swipe(fingers: -260)
        try await until { app.utilities.tabs.contains { $0.kind == .file(dark) } }
    }
}
