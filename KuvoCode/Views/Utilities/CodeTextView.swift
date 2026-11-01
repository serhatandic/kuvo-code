import AppKit
import ClientDesign
import SwiftUI

/// Code in a read-only text view: selectable across lines, numbered in a ruler, colored
/// by Prism once tokenized (files over 300 KB stay plain).
struct CodeTextView: NSViewRepresentable {
    let text: String
    let language: String?
    /// Add to Message in the right-click menu, with the selected lines (1 first).
    var addToMessage: ((ClosedRange<Int>) -> Void)?
    @Environment(\.colorScheme) private var scheme

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = PointerAwareTextView(usingTextLayoutManager: false)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 6, height: 10)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = .width
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        textView.delegate = context.coordinator

        let scroll = NSScrollView()
        scroll.documentView = textView
        // No scroll bar, like the rest of the panel: one shown all the time takes a strip off
        // the code.
        scroll.hasVerticalScroller = false
        scroll.drawsBackground = false
        scroll.autohidesScrollers = true
        // It sits in the panel, not under the title bar, so it needs no room for one; and since
        // views no longer clip by default, the ruler's edge would otherwise draw up over the
        // file's header.
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsetsZero
        scroll.clipsToBounds = true
        let ruler = LineNumberRuler(textView: textView, scrollView: scroll)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        context.coordinator.ruler = ruler
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let textView = scroll.documentView as? NSTextView else { return }
        let dark = scheme == .dark
        let coordinator = context.coordinator
        coordinator.addToMessage = addToMessage
        guard coordinator.text != text || coordinator.dark != dark else { return }
        coordinator.text = text
        coordinator.dark = dark
        textView.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.base))
        coordinator.ruler?.update(text: text)
        coordinator.highlight?.cancel()
        guard let language, text.utf8.count <= 300_000 else { return }
        coordinator.highlight = Task {
            guard let lines = await CodeHighlighter.shared.lines(of: text, language: language), !Task.isCancelled else { return }
            let colored = NSMutableAttributedString()
            for (index, line) in lines.enumerated() {
                if index > 0 { colored.append(NSAttributedString(string: "\n", attributes: Self.base)) }
                for run in line {
                    var attributes = Self.base
                    if let color = CodeColors.color(for: run.type, dark: dark) { attributes[.foregroundColor] = NSColor(color) }
                    colored.append(NSAttributedString(string: run.text, attributes: attributes))
                }
            }
            // Only if it still matches (the text may have changed meanwhile).
            guard colored.string == text || colored.string == text.replacingOccurrences(of: "\r\n", with: "\n") else { return }
            textView.textStorage?.setAttributedString(colored)
            // Windows line endings come back as "\n": the line numbers go by the text shown.
            coordinator.ruler?.update(text: colored.string)
        }
    }

    private static let base: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
        .foregroundColor: NSColor.labelColor,
    ]

    final class Coordinator: NSObject, NSTextViewDelegate {
        var text: String?
        var dark: Bool?
        var ruler: LineNumberRuler?
        var highlight: Task<Void, Never>?
        var addToMessage: ((ClosedRange<Int>) -> Void)?
        private var selectedLines: ClosedRange<Int>?

        /// Add to Message first in the text view's own menu, while there's a selection.
        func textView(_ view: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? {
            let selection = view.selectedRange()
            guard addToMessage != nil, selection.length > 0 else { return menu }
            let string = view.string as NSString
            func line(at offset: Int) -> Int {
                1 + string.substring(to: offset).utf16.count { $0 == 10 }
            }
            // A selection ending at the start of a line (a whole line picked) doesn't include it.
            var end = NSMaxRange(selection)
            if end > selection.location, string.character(at: end - 1) == 10 { end -= 1 }
            selectedLines = line(at: selection.location)...max(line(at: end), line(at: selection.location))
            let item = NSMenuItem(title: "Add to Message", action: #selector(addSelection), keyEquivalent: "")
            item.target = self
            menu.insertItem(item, at: 0)
            menu.insertItem(.separator(), at: 1)
            return menu
        }

        @objc private func addSelection() {
            if let selectedLines { addToMessage?(selectedLines) }
        }
    }
}

/// Line numbers beside a text view, drawn for the visible lines only.
final class LineNumberRuler: NSRulerView {
    private weak var textView: NSTextView?
    /// Where each line starts, in UTF-16 offsets.
    private var lineStarts: [Int] = [0]

    init(textView: NSTextView, scrollView: NSScrollView) {
        self.textView = textView
        super.init(scrollView: scrollView, orientation: .verticalRuler)
        clientView = textView
        ruleThickness = 40
        NotificationCenter.default.addObserver(self, selector: #selector(redraw), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        scrollView.contentView.postsBoundsChangedNotifications = true
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError() }

    func update(text: String) {
        var starts = [0]
        for (offset, unit) in text.utf16.enumerated() where unit == 10 { starts.append(offset + 1) }
        if starts.count > 1, starts.last == text.utf16.count { starts.removeLast() }
        lineStarts = starts
        ruleThickness = CGFloat(String(starts.count).count) * 7.5 + 20
        needsDisplay = true
    }

    @objc private func redraw() { needsDisplay = true }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView, let layoutManager = textView.layoutManager, let container = textView.textContainer else { return }
        let visible = textView.visibleRect
        let glyphs = layoutManager.glyphRange(forBoundingRect: visible, in: container)
        let characters = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.tertiaryLabelColor,
        ]
        var line = firstLine(atOrBefore: characters.location)
        let length = (textView.string as NSString).length
        while line < lineStarts.count, lineStarts[line] <= NSMaxRange(characters), lineStarts[line] <= length {
            let glyph = layoutManager.glyphIndexForCharacter(at: min(lineStarts[line], max(length - 1, 0)))
            let fragment = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let origin = convert(NSPoint(x: 0, y: fragment.minY + textView.textContainerOrigin.y), from: textView)
            let label = NSAttributedString(string: "\(line + 1)", attributes: attributes)
            let size = label.size()
            label.draw(at: NSPoint(x: ruleThickness - size.width - 8, y: origin.y + (fragment.height - size.height) / 2))
            line += 1
        }
    }

    /// The last line starting at or before `offset` (binary search).
    private func firstLine(atOrBefore offset: Int) -> Int {
        var low = 0, high = lineStarts.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            if lineStarts[middle] <= offset { low = middle } else { high = middle - 1 }
        }
        return low
    }
}
