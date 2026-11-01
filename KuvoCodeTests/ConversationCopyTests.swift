import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A selection across a conversation copies each row it takes whole as that row is copied: a
/// command you ran with "!" as its command and what it printed, though only what it printed is
/// text you can select in. Real rows, in a window of the test's own.
@MainActor
@Suite(.serialized) struct ConversationCopyTests {
    struct Item: Identifiable, Equatable {
        let id: String
        var text = ""
        var row: Row?
    }

    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 720, height: 520), styleMask: [.titled, .resizable], backing: .buffered, defer: false)

    private func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
        guard let view else { return [] }
        return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
    }

    @Test func aCommandYouRanCopiesWithItsCommandFromTheMiddleOfASelection() async throws {
        TestEnvironment.prepare()
        defer { window.orderOut(nil); window.close() }
        let shell = try JSONDecoder().decode(Message.Shell.self, from: JSONSerialization.data(withJSONObject: [
            "id": "msg_shell", "time": ["created": 2], "shellID": "sh_1", "command": "ls docs", "status": "exited", "exit": 0,
            "output": ["output": "guide.md\nnotes.md", "truncated": false],
        ]))
        let items = [
            Item(id: "a", text: "Here's what the folder holds."),
            Item(id: "shell", row: .shell(shell)),
            Item(id: "b", text: "Both files are Markdown."),
        ]
        let view = ConversationScroll(scroller: ConversationScroller(), change: 0, quote: { _ in }) {
            RowStack(items: items, id: \.id, same: ==, estimate: { _ in 60 }, text: { $0.row?.copiedText(folders: []) ?? $0.text }) { item, _ in
                if case .shell(let shell) = item.row {
                    ShellRow(shell: shell)
                } else {
                    ReplyView(markdown: item.text, parser: FileLinkingParser(folders: { [] }))
                }
            }
        }
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view.frame(width: 720, height: 520))
        window.orderBack(nil)
        var stack: RowStackView? { all(RowStackView.self, in: window.contentView).first }
        for _ in 0..<40 where all(SelectableTextView.self, in: stack).isEmpty || all(ReplyTextView.self, in: stack).count < 2 {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(25))
        }
        let rows = try #require(stack)
        #expect(!all(SelectableTextView.self, in: rows).isEmpty, "what it printed is text you select in")

        rows.selectAll(nil)
        let copied = rows.selectedText()
        #expect(copied == "Here's what the folder holds.\n\nls docs\nguide.md\nnotes.md\n\nBoth files are Markdown.", "\(copied)")
    }
}
