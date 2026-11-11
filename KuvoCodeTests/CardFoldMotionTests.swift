import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A message card in the conversation opens and folds from its header, as one: the header stays
/// where it is, the same, the words unfold and fold under it, the line it folds to and the words
/// never show at once, and nothing above moves (#94, #61). Folded, its header is one line, the
/// receiver's name cut short to leave the line it folds to room (#444).
///
/// The conversation is the real one, in a window of the test's own, the card pressed as VoiceOver
/// presses it; the engine is stubbed. The app's motion is held halfway (`Held`), so each frame
/// drawn of the change is the same one: it's looked at as drawn, in pixels.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct CardFoldMotionTests {
    let engine = StubEngine(port: 48_331)
    let app = AppModel()
    let catalog = Catalog()
    let model: SessionModel
    let id = "ses_card_fold_" + UUID().uuidString
    static let size = NSSize(width: 720, height: 620)
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    /// Its messages' ids of its own: what's folded is kept by them, for as long as the app runs.
    let run = "msg_" + UUID().uuidString.prefix(8) + "_"

    static let name = "#442 phone: loader over the chat; fold-all button placement"
    static let words = "Foreman: a third fix for this task, from the user (11-11 12:56–12:57, phone screenshots): the conversation header (back button, the bot/session name capsule, •••) sits on a full-width band, a blurred bar background with a hard bottom edge across the screen.\n\nRemove the band: the header controls float as glass capsules directly over the conversation (content scrolls under them; at most the system's soft scroll-edge fade, no hard edge or full-width fill), in every conversation kind (session, bot, chat, group chat).\n\nCheck the Mac's conversation header doesn't have an equivalent band; same rule if it does."

    /// Something of the window's own that animates as the app does, to tell when a change is over.
    @Observable final class Probe { var isOn = false }
    struct ProbeView: View {
        let probe: Probe
        var body: some View { Color.clear.frame(width: probe.isOn ? 2 : 1, height: 1) }
    }
    let probe = Probe()

    nonisolated private static func sent(_ run: String, number: Int, to: String, text: String) -> [String: Any] {
        ["id": run + "\(number)", "type": "assistant", "agent": "build", "time": ["created": Double(number), "completed": Double(number)], "model": ["id": "m", "providerID": "p"],
         "content": [["type": "tool", "id": "call_\(run)\(number)", "name": "kuvo-browser_send_message", "executed": true,
                      "state": ["status": "completed", "input": ["to": to, "text": text], "content": [["type": "text", "text": "Sent."]]]]]]
    }

    init() async throws {
        TestEnvironment.prepare()
        app.workspace.api = engine.api
        let run = run
        let messages: [[String: Any]] = [
            ["id": run + "01", "type": "user", "time": ["created": 1], "text": "Hand the header band to the phone's session."],
            Self.sent(run, number: 2, to: "Kuvo Foreman", text: Self.words),
            Self.sent(run, number: 3, to: Self.name, text: Self.words),
        ]
        engine.list([StubEngine.session(id, title: "Card", directory: "/tmp/kuvo-tests-card-fold", created: 1)], running: [])
        engine.conversation(id, messages)
        await app.workspace.refresh()
        model = try #require(app.workspace.model(for: id))
        await model.load()
        AXElement.reading(true)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = NSHostingView(rootView: AnyView(SessionView(model: model)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: Self.size.width, height: Self.size.height)
            .background(ProbeView(probe: probe))))
        window.orderBack(nil)
    }

    private func done() {
        Animation.uiForTests = nil
        engine.stop()
        window.orderOut(nil)
        window.close()
        window.contentView = nil
        AXElement.reading(false)
    }

    // MARK: The app's motion, held

    /// Where the app's motion is held: each frame of a change drawn at `progress` of its way, until
    /// it `goes`, when it's over at the next frame.
    nonisolated final class Held: @unchecked Sendable {
        nonisolated(unsafe) var progress: Double = 0.5
        nonisolated(unsafe) var goes = false
        nonisolated(unsafe) var frames = 0
    }

    nonisolated struct HeldAnimation: CustomAnimation {
        let held: Held

        func animate<V: VectorArithmetic>(value: V, time: TimeInterval, context: inout AnimationContext<V>) -> V? {
            if held.goes { return nil }
            held.frames += 1
            TestPulse.beat()
            return value.scaled(by: held.progress)
        }

        static func == (a: Self, b: Self) -> Bool { a.held === b.held }
        func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(held)) }
    }

    /// The card's header pressed with the app's motion held halfway, and a few frames of it drawn.
    private func pressHeld(_ header: String) async throws -> Held {
        let held = Held()
        Animation.uiForTests = Animation(HeldAnimation(held: held))
        try press(header)
        try await until { held.frames >= 30 }
        window.contentView?.layoutSubtreeIfNeeded()
        let drawn = held.frames
        try await until { held.frames >= drawn + 10 }
        return held
    }

    /// The change let go, over, and the conversation still.
    private func letGo(_ held: Held) async {
        held.goes = true
        Animation.uiForTests = nil
        await settled()
        await settled()
    }

    /// An animation started now, and with it what started before it, has finished.
    private func settled() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            withAnimation(.ui) { probe.isOn.toggle() } completion: { done.resume() }
        }
        window.contentView?.layoutSubtreeIfNeeded()
    }

    // MARK: The window

    private var labels: [String] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView).compactMap(\.label)
    }

    private func element(_ containing: String) throws -> AXElement {
        window.contentView?.layoutSubtreeIfNeeded()
        return try #require(AXElement.all(in: window.contentView).first { $0.label?.contains(containing) == true }, "“\(containing)” among \(labels)")
    }

    private func press(_ containing: String) throws {
        #expect(try element(containing).press(), "“\(containing)” didn't press")
    }

    /// Where the header is in the window's content (from its top), at rest.
    private func header(_ containing: String) throws -> CGRect {
        let content = try #require(window.contentView)
        let inWindow = window.convertFromScreen(try element(containing).frame)
        return content.convert(inWindow, from: nil)
    }

    /// The window's content as drawn now; into KUVO_SHOTS_OUT too, as `name`, where that's set.
    private func shot(_ name: String) throws -> Shot {
        let content = try #require(window.contentView)
        content.layoutSubtreeIfNeeded()
        let rep = try #require(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        let cg = try #require(rep.cgImage)
        let width = cg.width, height = cg.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try #require(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(gray: 0.12, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        let shot = Shot(pixels: pixels, width: width, height: height, scale: CGFloat(width) / content.bounds.width)
        if let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"], let image = context.makeImage(),
           let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
            try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
            try png.write(to: URL(fileURLWithPath: out).appending(path: name + ".png"))
        }
        return shot
    }

    struct Shot {
        let pixels: [UInt8]
        let width: Int
        let height: Int
        let scale: CGFloat

        /// The brightness of each pixel in `rect` (points, from the top).
        func gray(_ rect: CGRect) -> [Int] {
            let x0 = max(0, Int(rect.minX * scale)), x1 = min(width, Int(rect.maxX * scale))
            let y0 = max(0, Int(rect.minY * scale)), y1 = min(height, Int(rect.maxY * scale))
            var values: [Int] = []
            for y in y0..<max(y0, y1) {
                for x in x0..<max(x0, x1) {
                    let i = (y * width + x) * 4
                    values.append((Int(pixels[i]) * 3 + Int(pixels[i + 1]) * 6 + Int(pixels[i + 2])) / 10)
                }
            }
            return values
        }

        /// How much of `rect` is ink (text, a symbol) rather than what's behind it: pixels well off
        /// its usual brightness.
        func ink(_ rect: CGRect) -> Double {
            let values = gray(rect)
            guard !values.isEmpty else { return 0 }
            let usual = values.sorted()[values.count / 2]
            return Double(values.filter { abs($0 - usual) > 40 }.count) / Double(values.count)
        }

        /// How far `rect` here is from the same in `other`: the mean difference in brightness.
        func difference(_ rect: CGRect, from other: Shot) -> Double {
            let a = gray(rect), b = other.gray(rect)
            guard a.count == b.count, !a.isEmpty else { return .infinity }
            return Double(zip(a, b).map { abs($0 - $1) }.reduce(0, +)) / Double(a.count)
        }
    }

    // MARK: Tests

    @Test func opensAndFoldsUnderItsHeader() async throws {
        defer { done() }
        try await until { labels.contains { $0.contains(Self.name) } }
        await settled()
        let header = try header(Self.name)
        // Its icon and the start of the name; the line it folds to, past the name's share; the
        // words, under the header; and what's above the card.
        let name = CGRect(x: header.minX, y: header.minY, width: header.width * 0.3, height: header.height)
        let preview = CGRect(x: header.minX + header.width * 0.6, y: header.minY, width: header.width * 0.35, height: header.height)
        let words = CGRect(x: header.minX + 24, y: header.maxY + 10, width: header.width * 0.6, height: 40)
        let above = CGRect(x: 0, y: max(0, header.minY - 120), width: Self.size.width, height: 110)

        let folded = try shot("folded")
        #expect(folded.ink(preview) > 0.01, "folded, it shows its first line")
        #expect(folded.ink(words) < 0.002, "folded, its words don't show")

        // Opening, halfway.
        var held = try await pressHeld(Self.name)
        let opening = try shot("opening")
        #expect(opening.difference(name, from: folded) < 2, "the header stays where it is, the same, as it opens")
        #expect(opening.difference(above, from: folded) < 2, "nothing above moves as it opens")
        #expect(opening.ink(words) > 0.01, "its words unfold under the header")
        #expect(opening.ink(preview) < 0.002, "the line it folded to is gone as its words show")
        await letGo(held)

        let open = try shot("open")
        #expect(open.difference(name, from: folded) < 2, "open, the header is as it was folded")
        #expect(open.ink(preview) < 0.002)
        #expect(open.ink(words) > 0.01)

        // Folding, halfway.
        held = try await pressHeld(Self.name)
        let folding = try shot("folding")
        #expect(folding.difference(name, from: folded) < 2, "the header stays where it is, the same, as it folds")
        #expect(folding.difference(above, from: folded) < 2, "nothing above moves as it folds")
        #expect(folding.ink(words) > 0.002, "its words fold under the header")
        #expect(folding.ink(preview) < 0.002, "the line it folds to waits for its words to go")
        await letGo(held)

        let again = try shot("folded-again")
        #expect(again.difference(name, from: folded) < 2)
        #expect(again.ink(preview) > 0.01, "folded again, it shows its first line")
        #expect(again.ink(words) < 0.002)
    }

    /// A conversation taller than the window, at its end and following it, with the folded card
    /// last, over the composer.
    private func longConversation() async {
        let run = run
        var messages: [[String: Any]] = []
        for turn in 0..<10 {
            let at = Double(turn) / 100
            messages.append(["id": run + "0\(100 + turn * 2)", "type": "user", "time": ["created": at], "text": "Question \(turn)"])
            messages.append(["id": run + "0\(101 + turn * 2)", "type": "assistant", "agent": "build", "time": ["created": at, "completed": at], "model": ["id": "m", "providerID": "p"],
                             "content": [["type": "text", "text": String(repeating: "Some words of the answer. ", count: 40)]]])
        }
        messages.append(["id": run + "01", "type": "user", "time": ["created": 1], "text": "Hand the header band to the phone's session."])
        messages.append(Self.sent(run, number: 3, to: Self.name, text: Self.words))
        engine.conversation(id, messages)
        await model.load()
    }

    private var stack: RowStackView? {
        func stacks(_ view: NSView?) -> [RowStackView] { guard let view else { return [] }; return (view as? RowStackView).map { [$0] } ?? view.subviews.flatMap(stacks) }
        return stacks(window.contentView).first
    }

    private var origin: CGFloat { stack?.enclosingScrollView?.contentView.bounds.origin.y ?? -1 }

    private var isFollowing: Bool {
        DispatchQueue.main.async { TestPulse.beat() }
        return stack?.scrollAnchor?.isFollowingEnd ?? false
    }

    /// Opened at the end of a conversation that follows it: it opens where it is, under its header,
    /// with nothing above it moving (the end followed took it up under you as it grew). Once open,
    /// the view goes down as far as its words need, its header kept in view.
    @Test func openingAtTheEndMovesNothingThenShowsIt() async throws {
        defer { done() }
        await longConversation()
        try await until { labels.contains { $0.contains(Self.name) } }
        await settled()
        try await until { isFollowing }
        let start = origin
        #expect(start > 0, "it scrolls")
        let header = try header(Self.name)
        let name = CGRect(x: header.minX, y: header.minY, width: header.width * 0.3, height: header.height)
        let above = CGRect(x: 0, y: max(0, header.minY - 200), width: Self.size.width, height: 190)
        let folded = try shot("end-folded")

        let held = try await pressHeld(Self.name)
        let opening = try shot("end-opening")
        #expect(opening.difference(name, from: folded) < 2, "the header stays where it is as it opens")
        #expect(opening.difference(above, from: folded) < 2, "nothing above moves as it opens")
        #expect(abs(origin - start) < 1, "the view stays: moved from \(start) to \(origin)")
        await letGo(held)
        // Once open, the view goes down to its words.
        try await until {
            DispatchQueue.main.async { TestPulse.beat() }
            return origin > start + 20
        }
        await settled()
        let after = try self.header(Self.name)
        #expect(after.minY >= 0 && after.maxY <= Self.size.height, "its header is still in view: \(after)")
        #expect(!isFollowing, "you're reading what you opened: what comes next doesn't move it")
    }

    /// Folded, a header is one line however long the name: the name is cut short at its share and
    /// the line it folds to has the rest.
    @Test func foldedHeaderIsOneLine() async throws {
        defer { done() }
        try await until { labels.contains { $0.contains(Self.name) } }
        await settled()
        let long = try header(Self.name)
        let short = try header("Kuvo Foreman")
        #expect(abs(long.height - short.height) < 1, "a long name's header is as tall as a short one's: \(long) \(short)")
        let folded = try shot("one-line")
        let preview = CGRect(x: long.minX + long.width * 0.6, y: long.minY, width: long.width * 0.35, height: long.height)
        #expect(folded.ink(preview) > 0.01, "the line it folds to has its room")
    }

    /// Frames of it opening and folding, at points of the app's motion's way, into KUVO_SHOTS_OUT
    /// (`open-…`, `fold-…`): to look at, not a test.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] != nil))
    func frames() async throws {
        defer { done() }
        try await until { labels.contains { $0.contains(Self.name) } }
        await settled()
        for way in ["open", "fold"] {
            let held = Held()
            held.progress = 0
            Animation.uiForTests = Animation(HeldAnimation(held: held))
            try press(Self.name)
            for (index, progress) in [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1].enumerated() {
                held.progress = progress
                let drawn = held.frames
                try await until { held.frames >= drawn + 20 }
                window.contentView?.layoutSubtreeIfNeeded()
                _ = try shot("\(way)-\(index)")
            }
            await letGo(held)
            _ = try shot("\(way)-end")
        }
    }
}
