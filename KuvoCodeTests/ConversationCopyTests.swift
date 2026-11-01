import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A selection across a conversation copies each row it takes whole as that row is copied: a
/// command you ran with "!" as its command and what it printed (between its ends, or the last
/// row Select All takes), though only what it printed is text you can select in; a reply between, by its own text (its paragraphs apart, as it copies on
/// its own). Real rows, in a window of the test's own.
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
        let status = try JSONDecoder().decode(Message.Shell.self, from: JSONSerialization.data(withJSONObject: [
            "id": "msg_status", "time": ["created": 3], "shellID": "sh_2", "command": "git status --short", "status": "exited", "exit": 0,
            "output": ["output": "M guide.md", "truncated": false],
        ]))
        let items = [
            Item(id: "a", text: "Here's what the folder holds."),
            Item(id: "m", text: "First I listed it.\n\nThen I read the guide."),
            Item(id: "shell", row: .shell(shell)),
            Item(id: "b", text: "Both files are Markdown."),
            Item(id: "status", row: .shell(status)),
        ]
        let view = ConversationScroll(scroller: ConversationScroller(), change: 0, quote: { _ in }) {
            RowStack(items: items, id: \.id, same: ==, estimate: { _ in 60 }, text: { $0.row?.copiedText(folders: []) ?? FindText.shown(markdown: $0.text, folders: []) }, whole: { $0.row?.copiesWhole ?? false }) { item, _ in
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
        // Laid out as the window shows it: the rows in view made.
        window.contentView?.layoutSubtreeIfNeeded()
        window.contentView?.layoutSubtreeIfNeeded()
        let rows = try #require(stack)
        #expect(all(ReplyTextView.self, in: rows).count == 3, "the replies made")
        #expect(!all(SelectableTextView.self, in: rows).isEmpty, "what it printed is text you select in")

        rows.selectAll(nil)
        let copied = rows.selectedText()
        #expect(copied == "Here's what the folder holds.\n\nFirst I listed it.\nThen I read the guide.\n\nls docs\nguide.md\nnotes.md\n\nBoth files are Markdown.\n\ngit status --short\nM guide.md", "\(copied)")
    }
}
