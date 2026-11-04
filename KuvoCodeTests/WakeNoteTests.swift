import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A wake-up in a conversation: "Woke up", its note and the time, on a row. A long note takes the
/// row's room and wraps there, not in a narrow column with a gap before the time.
@MainActor
@Suite(.serialized) struct WakeNoteTests {
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 500, height: 400), styleMask: [.titled], backing: .buffered, defer: false)

    init() {
        TestEnvironment.prepare()
        let note = String(repeating: "Checked the harbor log and the tide tables, and wrote down what changed. ", count: 3)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: WakeRow(note: note, at: 0).frame(width: 500))
        window.orderBack(nil)
    }

    private func all(in view: NSView?) -> [SelectableTextView] {
        guard let view else { return [] }
        return ((view as? SelectableTextView).map { [$0] } ?? []) + view.subviews.flatMap { all(in: $0) }
    }

    @Test func aLongNoteTakesTheRowsRoom() async throws {
        defer {
            window.orderOut(nil)
            window.close()
        }
        // Laid out, the note placed in its row.
        var turns = 0
        while all(in: window.contentView).first.map({ $0.frame.width == 0 }) ?? true, turns < 400 {
            window.contentView?.layoutSubtreeIfNeeded()
            await Task.yield()
            turns += 1
        }
        let words = try #require(all(in: window.contentView).first)
        // The row, less its icon, the time and the room between them.
        #expect(words.frame.width > 350, "the note wraps at \(words.frame.width) points of a 500-point row")
    }
}
