import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A long message of yours shows its first lines with Show More, and Show Less cuts it again with
/// Show More back: Show More shows while its words say their line limit cuts them. Here a long
/// text's limit goes as Show More takes it away and comes back as Show Less brings it, in a window
/// of the test's own: it must say it's cut each time the limit comes back, also when it's as wide
/// cut as whole (its lines all alike), and stay as wide as its lines all along (its bubble hugs
/// them).
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct LongMessageTests {
    @MainActor @Observable final class Message {
        var lineLimit: Int? = 12
        /// What its words last said: whether the limit cuts them.
        var isCut: Bool?
        /// How wide its words are laid out.
        var width: CGFloat = 0
    }

    static let line = "The harbor log, line by line."
    static let font = NSFont.systemFont(ofSize: 14)
    /// How wide each of its lines is.
    static let lineWidth = ceil((line as NSString).size(withAttributes: [.font: font]).width)

    /// Its words, at the trailing edge of a conversation's width as your messages are.
    struct Words: View {
        let message: Message
        private let text = MessageMentions.attributed(
            AttributedString(Array(repeating: LongMessageTests.line, count: 30).joined(separator: "\n")),
            font: LongMessageTests.font).text

        var body: some View {
            SelectableText(text: text, lineLimit: message.lineLimit, cut: { message.isCut = $0 })
                .background(GeometryReader { proxy in
                    Color.clear
                        .onAppear { message.width = proxy.size.width }
                        .onChange(of: proxy.size.width) { _, width in message.width = width }
                })
                .frame(width: 640, alignment: .trailing)
        }
    }

    /// The words in a window of the test's own, their line limit `lineLimit` to start with.
    @MainActor final class Scene {
        let message = Message()
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 640, height: 900), styleMask: [.titled], backing: .buffered, defer: false)

        init(lineLimit: Int?) {
            TestEnvironment.prepare()
            message.lineLimit = lineLimit
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: Words(message: message))
            window.orderBack(nil)
        }

        func done() {
            window.orderOut(nil)
            window.close()
        }
    }

    @Test func showLessCutsItAgainWithShowMoreBack() async throws {
        let scene = Scene(lineLimit: 12)
        defer { scene.done() }
        let message = scene.message
        let hugsItsLines = { message.width > 0 && abs(message.width - Self.lineWidth) <= 1 }
        // Its first lines, cut: Show More.
        try await until { message.isCut == true && hugsItsLines() }

        // Show More: all of it, as wide as its lines.
        message.lineLimit = nil
        try await until { message.isCut == false && hugsItsLines() }

        // Show Less: cut again, so Show More is back.
        message.lineLimit = 12
        try await until { message.isCut == true && hugsItsLines() }
    }

    /// Show More gives the message new words to show, all of them from the start: as wide as its
    /// lines, not as wide as the conversation.
    @Test func allOfItShowsAsWideAsItsLines() async throws {
        let scene = Scene(lineLimit: nil)
        defer { scene.done() }
        let message = scene.message
        try await until { message.isCut == false && message.width > 0 }
        #expect(abs(message.width - Self.lineWidth) <= 1, "as wide as its lines, \(Self.lineWidth), not \(message.width)")
    }

    /// Long messages of yours in a conversation: each comes into view as tall as it is with its Show
    /// More, so the rows under it stay where they were put as the button shows, never sliding down
    /// from under it (for that while, the message above took the clicks on their first lines).
    @Test func aLongMessageComesIntoViewWithItsShowMoresRoom() async throws {
        TestEnvironment.prepare()
        let app = AppModel()
        let words = Array(repeating: Self.line, count: 30).joined(separator: "\n")
        let items = ["0", "1", "2"]
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 640, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: ScrollView {
            RowStack(items: items, id: { $0 }, same: ==, estimate: { _ in 400 }) { _, _ in
                UserBubble(text: words).environment(app)
            }
        }.frame(width: 640, height: 900))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.close() }

        func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
            guard let view else { return [] }
            return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
        }
        /// The rows as they're placed, top to bottom.
        func rows() -> [NSRect] {
            (all(RowStackView.self, in: window.contentView).first?.subviews ?? []).map(\.frame).sorted { $0.minY < $1.minY }
        }
        func settle(until ready: () -> Bool) async {
            var turns = 0
            while !ready(), turns < 400 {
                window.contentView?.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                await Task.yield()
                turns += 1
            }
        }

        // Laid out: each row in its place.
        await settle { all(SelectableTextView.self, in: window.contentView).count == items.count && rows().count == items.count }
        let placed = rows()
        #expect(placed.count == items.count)
        // Their words say they're cut a turn or two after they're laid out, and Show More shows:
        // given far more turns than that, nothing under them moves.
        await settle { rows() != placed }
        #expect(rows() == placed, "the rows stayed where they were put: \(placed) then \(rows())")
        for (above, below) in zip(rows(), rows().dropFirst()) {
            #expect(below.minY >= above.maxY, "a row under the one above: \(above) over \(below)")
        }
        // Under each one's words, more than its bubble's edge: Show More's room.
        let stack = try #require(all(RowStackView.self, in: window.contentView).first)
        for text in all(SelectableTextView.self, in: stack) {
            let words = text.convert(text.bounds, to: stack)
            let row = try #require(rows().first { $0.minY <= words.minY && words.maxY <= $0.maxY })
            #expect(row.maxY - words.maxY > 20, "room under the words for Show More: \(row.maxY - words.maxY)")
        }
    }

    /// A message too short to be called long (a list and a paragraph) in a narrow conversation,
    /// where it runs past the line limit's lines: all of it shows, since there's no Show More for it.
    @Test func aShortMessageInANarrowConversationIsNeverCutWithoutShowMore() async throws {
        TestEnvironment.prepare()
        let app = AppModel()
        let words = (1...8).map { "\($0). Salt" }.joined(separator: "\n")
            + "\nAnd when you're at the harbor market, ask the keeper whether the lamp oil came in, since we'll need it before the ships come back tonight."
        #expect(words.count < 300 && words.filter { $0 == "\n" }.count < 12, "short, as messages go")
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 320, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: UserBubble(text: words).environment(app).frame(width: 320))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.close() }
        func text() -> SelectableTextView? {
            func all(_ view: NSView) -> [SelectableTextView] { ((view as? SelectableTextView).map { [$0] } ?? []) + view.subviews.flatMap(all) }
            return window.contentView.flatMap(all)?.first
        }
        try await until {
            window.contentView?.layoutSubtreeIfNeeded()
            return (text()?.bounds.height ?? 0) > 0
        }
        let shown = try #require(text())
        let layout = try #require(shown.layoutManager), container = try #require(shown.textContainer)
        var lines = 0
        layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { _, _, _, _, _ in lines += 1 }
        #expect(lines > 12, "it runs past the limit's lines here: \(lines)")
        #expect(layout.glyphRange(for: container).length == layout.numberOfGlyphs, "all of its words show")
    }
}