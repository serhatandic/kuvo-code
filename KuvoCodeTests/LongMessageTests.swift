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