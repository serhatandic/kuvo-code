import AppKit
import SwiftUI

/// Plain text that can run long and grows while you read it, like the model's thinking. AppKit's
/// text system sets it: as it grows, only what was added is laid out, and only what's in view is
/// drawn, so tens of thousands of words stream and scroll as smoothly as a line. (A SwiftUI `Text`
/// lays all of it out again for each few words added, and draws all of it.) You can select and
/// copy it, as the rest of the conversation.
struct LongText: NSViewRepresentable {
    let text: String
    var font = NSFont.preferredFont(forTextStyle: .callout)
    var color = NSColor.secondaryLabelColor

    func makeNSView(context: Context) -> LongTextView {
        LongTextView()
    }

    func updateNSView(_ view: LongTextView, context: Context) {
        view.show(text, font: font, color: color)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: LongTextView, context: Context) -> CGSize? {
        // As wide as it's offered; asked for its ideal width, the width it last had.
        guard let width = proposal.width.flatMap({ $0.isFinite && $0 > 0 ? $0 : nil }) ?? view.width else { return nil }
        return CGSize(width: width, height: view.height(forWidth: width))
    }
}

/// The text view under `LongText`: not editable, sized by its text, with no scroll view of its own
/// (the conversation scrolls it).
final class LongTextView: PointerAwareTextView {
    /// What it shows, as last given, to tell what was added.
    private var shown = ""
    private var attributes: [NSAttributedString.Key: Any] = [:]
    /// Where its finished paragraphs end: in what it was given (bytes) and in what it shows.
    private var settled = (source: 0, display: 0)
    /// The width it was last laid out for.
    private(set) var width: CGFloat?

    init() {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        // All of it laid out, so its height is exact (it grows from the end, so only the end is
        // ever laid out again).
        layout.allowsNonContiguousLayout = false
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isRichText = false
        drawsBackground = false
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        usesFindBar = false
        usesFontPanel = false
        // Nothing to check in text you can't edit: no spelling, links or dates looked for in it.
        enabledTextCheckingTypes = 0
        isContinuousSpellCheckingEnabled = false
        isGrammarCheckingEnabled = false
        isAutomaticDataDetectionEnabled = false
        isAutomaticLinkDetectionEnabled = false
        setContentHuggingPriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Shows `text`: what's new at its end added, the rest left as it's laid out. Its `code` spans
    /// are drawn as code; the last paragraph is set again as it grows, since a span it opens may
    /// close later.
    func show(_ text: String, font: NSFont, color: NSColor) {
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        guard let storage = textStorage else { return }
        let restyled = !NSDictionary(dictionary: attributes).isEqual(to: self.attributes)
        if restyled || !Self.text(text, startsWith: shown) {
            storage.setAttributedString(NSAttributedString())
            settled = (0, 0)
        } else if text.utf8.count == shown.utf8.count {
            return
        }
        // Everything after the last finished paragraph, set again.
        let rest = text[text.utf8.index(text.startIndex, offsetBy: settled.source)...]
        let open = rest.lastIndex(of: "\n").map { rest.index(after: $0) } ?? rest.startIndex
        let done = InlineCode.attributed(rest[..<open], font: font, color: color)
        let tail = InlineCode.attributed(rest[open...], font: font, color: color)
        storage.beginEditing()
        storage.replaceCharacters(in: NSRange(location: settled.display, length: storage.length - settled.display), with: done)
        storage.append(tail)
        storage.endEditing()
        settled = (settled.source + rest[..<open].utf8.count, settled.display + done.length)
        shown = text
        self.attributes = attributes
        typingAttributes = attributes
    }

    /// What a right click offers, without what's for text you edit (Cut, Paste, Writing Tools,
    /// spelling, substitutions).
    override func menu(for event: NSEvent) -> NSMenu? {
        guard let menu = super.menu(for: event) else { return nil }
        let editing: Set<String> = ["cut:", "paste:", "pasteAsPlainText:", "showWritingTools:", "showGuessPanel:", "orderFrontSubstitutionsPanel:"]
        func isEditing(_ item: NSMenuItem) -> Bool {
            if let action = item.action, editing.contains(NSStringFromSelector(action)) { return true }
            return item.submenu?.items.contains(where: isEditing) ?? false
        }
        for item in menu.items where isEditing(item) { menu.removeItem(item) }
        // No separators left at the ends or next to each other.
        var last: NSMenuItem?
        for item in menu.items {
            if item.isSeparatorItem, last == nil || last?.isSeparatorItem == true { menu.removeItem(item) } else { last = item }
        }
        if menu.items.last?.isSeparatorItem == true { menu.removeItem(at: menu.items.count - 1) }
        return menu
    }

    /// Whether `text` begins with `prefix`, compared as bytes (a few microseconds for a long text,
    /// where comparing character by character takes milliseconds).
    private static func text(_ text: String, startsWith prefix: String) -> Bool {
        var text = text
        var prefix = prefix
        return text.withUTF8 { whole in
            prefix.withUTF8 { start in
                whole.count >= start.count && (start.isEmpty || memcmp(whole.baseAddress!, start.baseAddress!, start.count) == 0)
            }
        }
    }

    /// How tall it is, set `width` wide.
    func height(forWidth width: CGFloat) -> CGFloat {
        guard let container = textContainer, let layout = layoutManager else { return 0 }
        if container.size.width != width {
            container.size = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        }
        self.width = width
        layout.ensureLayout(for: container)
        return ceil(layout.usedRect(for: container).height)
    }
}

/// `code` in plain text (a step's command, a thought): what's between two backticks on one line,
/// without them, in the code face a step smaller, as replies draw it. A backtick left open stays.
enum InlineCode {
    static func pieces(_ text: Substring) -> [(text: Substring, isCode: Bool)] {
        var pieces: [(Substring, Bool)] = []
        var plain = text.startIndex
        var i = text.startIndex
        while i < text.endIndex {
            if text[i] == "`" {
                let after = text.index(after: i)
                if let close = text[after...].firstIndex(where: { $0 == "`" || $0 == "\n" }), text[close] == "`", close > after {
                    if plain < i { pieces.append((text[plain..<i], false)) }
                    pieces.append((text[after..<close], true))
                    i = text.index(after: close)
                    plain = i
                    continue
                }
            }
            i = text.index(after: i)
        }
        if plain < text.endIndex { pieces.append((text[plain...], false)) }
        return pieces
    }

    static func attributed(_ text: Substring, font: NSFont, color: NSColor) -> NSAttributedString {
        let code = NSFont.monospacedSystemFont(ofSize: (font.pointSize * 0.9).rounded(), weight: .regular)
        let result = NSMutableAttributedString()
        for piece in pieces(text) {
            result.append(NSAttributedString(string: String(piece.text), attributes: [.font: piece.isCode ? code : font, .foregroundColor: color]))
        }
        return result
    }

    /// For a SwiftUI `Text` set in `size`-point type.
    static func attributed(_ text: String, size: CGFloat) -> AttributedString {
        var result = AttributedString()
        for piece in pieces(text[...]) {
            var run = AttributedString(piece.text)
            if piece.isCode { run.font = .system(size: (size * 0.9).rounded(), design: .monospaced) }
            result += run
        }
        return result
    }
}
