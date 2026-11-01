import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A tool's output in its well: as many whole lines as the well holds, faded at the cut, however
/// tall another script's font makes them, and none of them under a scroll bar that's always shown
/// (System Settings, or a mouse plugged in).
@MainActor
@Suite(.serialized) struct ToolOutputTests {
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 500, height: 700), styleMask: [.titled], backing: .buffered, defer: false)

    private func show(_ text: String) {
        TestEnvironment.prepare()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: OutputBlock(text: text).frame(width: 480).frame(maxHeight: .infinity, alignment: .top))
        window.orderBack(nil)
    }

    private func done() {
        window.orderOut(nil)
        window.close()
    }

    private func all<View: NSView>(_ kind: View.Type, in view: NSView?) -> [View] {
        guard let view else { return [] }
        return ((view as? View).map { [$0] } ?? []) + view.subviews.flatMap { all(kind, in: $0) }
    }

    private var words: SelectableTextView? { all(SelectableTextView.self, in: window.contentView).first }

    /// How much of `words`' height is out of sight in the well's scroll view (its `visibleRect`
    /// isn't cut to its own bounds there).
    private func hidden(_ words: SelectableTextView) -> CGFloat {
        guard let clip = words.enclosingScrollView?.contentView else { return 0 }
        let shown = words.convert(words.bounds, to: clip).intersection(clip.bounds)
        return words.bounds.height - shown.height
    }

    private func settle(until ready: () -> Bool) async {
        var turns = 0
        while !ready(), turns < 400 {
            window.contentView?.layoutSubtreeIfNeeded()
            await Task.yield()
            turns += 1
        }
    }

    /// Arabic's font sets its lines taller than the output's own: a line count worked out from the
    /// output's font ran them past the well's bottom, where they were cut off half seen.
    @Test func linesInATallerScriptStayInTheWell() async throws {
        show(Array(repeating: "مرحبا بالعالم، تم البناء", count: 40).joined(separator: "\n"))
        defer { done() }
        await settle { (words?.frame.height ?? 0) > 0 }
        let words = try #require(words)
        // The well's 260 points, less its 12 points of room above and below.
        #expect(words.frame.height <= 236, "its lines take \(words.frame.height) points of the well's 236")
        #expect(hidden(words) <= 0.5, "\(hidden(words)) points of its lines out of sight")
    }

    /// Lines wider than the well scroll sideways; with a scroll bar that's always shown, it sits
    /// under the last line, not over it.
    @Test func anAlwaysShownScrollBarLeavesTheLastLineInSight() async throws {
        let style = OutputBlock.scrollerStyle
        OutputBlock.scrollerStyle = { .legacy }
        defer { OutputBlock.scrollerStyle = style }
        show((1...40).map { "step \($0): " + String(repeating: "compiled module ", count: 12) }.joined(separator: "\n"))
        defer { done() }
        await settle {
            // As AppKit sets it up when that's the system's style.
            for scroller in all(NSScrollView.self, in: window.contentView) where scroller.scrollerStyle != .legacy { scroller.scrollerStyle = .legacy }
            // Laid out with the scroll bar taking its room from the well.
            guard let words, words.frame.height > 0, let scroll = words.enclosingScrollView else { return false }
            return scroll.contentView.frame.height < scroll.frame.height - 1
        }
        window.contentView?.layoutSubtreeIfNeeded()
        let words = try #require(words)
        #expect(hidden(words) <= 0.5, "\(hidden(words)) points of its last line under the scroll bar")
    }
}
