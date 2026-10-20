import AppKit
import SwiftUI
import Textual

/// A piece of a reply's Markdown, drawn with TextKit (see `ReplyDocument`): each run of prose in
/// one text view, each code block in a view of its own. A few views a piece, where Textual makes
/// several for every block, so a long reply comes into view in a fraction of the time.
struct ReplyView: NSViewRepresentable {
    let markdown: String
    /// A reply's (with file links), or another's (a Markdown file's, with `images`).
    let parser: any MarkupParser
    var images: URL? = nil
    /// ` ```mermaid ` blocks are drawn as diagrams (a Markdown file's preview).
    var diagrams = false
    var openURL: (URL) -> Bool = { _ in false }
    @Environment(\.messageFont) private var font
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused

    private var style: ReplyDocument.Style {
        ReplyDocument.Style(size: font.size, design: font.typeface.systemDesign, dark: scheme == .dark)
    }

    func makeNSView(context: Context) -> ReplyPieceView {
        // One a reply scrolled out of view left: its text views are made already, which is much
        // of what a piece costs.
        let view = ReplyPieceView.pool.popLast() ?? ReplyPieceView()
        update(view)
        return view
    }

    static func dismantleNSView(_ view: ReplyPieceView, coordinator: ()) {
        view.putAway()
        if ReplyPieceView.pool.count < 40 { ReplyPieceView.pool.append(view) }
    }

    func updateNSView(_ view: ReplyPieceView, context: Context) {
        update(view)
    }

    private func update(_ view: ReplyPieceView) {
        view.openURL = openURL
        view.cardIsFocused = cardIsFocused
        let marks = (parser as? FileLinkingParser).flatMap { $0.highlight == nil && $0.mentions.isEmpty && $0.agents.isEmpty ? nil : AnyHashable(ParserMarks(highlight: $0.highlight, mentions: $0.mentions, agents: $0.agents)) }
        view.show(markdown, document: {
            if let parser = parser as? FileLinkingParser, images == nil { return ReplyDocument.cached(markdown: markdown, parser: parser, style: style) }
            return ReplyDocument(markdown: markdown, parser: parser, style: style, images: images, diagrams: diagrams)
        }, style: style, marks: marks)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ReplyPieceView, context: Context) -> CGSize? {
        let width = proposal.width ?? 600
        guard width.isFinite, width > 0 else { return nil }
        return CGSize(width: width, height: nsView.height(for: width))
    }
}

/// What a reply's parser draws besides its words: Find's marks, a group chat's faces and the
/// agents a message names.
private struct ParserMarks: Hashable {
    var highlight: FindHighlight?
    var mentions: [Bot]
    var agents: [MessageMentions.Agent]
}

extension Look.Typeface {
    /// AppKit's name for its design.
    var systemDesign: NSFontDescriptor.SystemDesign {
        switch design {
        case .serif: .serif
        case .rounded: .rounded
        case .monospaced: .monospaced
        default: .default
        }
    }
}

// MARK: - The piece

/// A piece's segments, one under another.
final class ReplyPieceView: NSView {
    /// Pieces put away, to show another reply.
    static var pool: [ReplyPieceView] = []

    var openURL: (URL) -> Bool = { _ in false }
    var cardIsFocused = true {
        didSet { if cardIsFocused != oldValue { for case let code as ReplyCodeView in segmentViews { code.cardIsFocused = cardIsFocused } } }
    }
    /// What it shows: the Markdown, its look, and what else the parser draws into it (Find's
    /// marks, a group chat's faces), which change it as much as the words do.
    private var shown: (markdown: String, style: ReplyDocument.Style, marks: AnyHashable?)?
    private var segmentViews: [NSView] = []
    private var gaps: [CGFloat] = []
    /// Heights laid out, by width.
    private var heights: (width: CGFloat, values: [CGFloat])?

    override var isFlipped: Bool { true }

    /// Put away: what it showed is let go, and what's selected in it.
    func putAway() {
        removeFromSuperview()
        for case let text as ReplyTextView in segmentViews { text.setSelectedRange(NSRange(location: 0, length: 0)) }
        openURL = { _ in false }
        // Made again for whatever it shows next: one with Find's marks would keep them otherwise.
        shown = nil
    }

    func show(_ markdown: String, document: () -> ReplyDocument, style: ReplyDocument.Style, marks: AnyHashable? = nil) {
        guard shown?.markdown != markdown || shown?.style != style || shown?.marks != marks else { return }
        shown = (markdown, style, marks)
        let document = document()
        var views: [NSView] = []
        for (index, segment) in document.segments.enumerated() {
            // The view in its place already, if it's the same kind: as a reply streams in, its
            // last piece's views take the new words rather than being made again.
            let existing = index < segmentViews.count ? segmentViews[index] : nil
            switch segment {
            case .text(let text):
                let view = existing as? ReplyTextView ?? ReplyTextView()
                view.openURL = { [weak self] url in self?.openURL(url) ?? false }
                view.show(text)
                views.append(view)
            case .code(let code, let language, let marks):
                let view = existing as? ReplyCodeView ?? ReplyCodeView()
                view.cardIsFocused = cardIsFocused
                view.show(code: code, language: language, marks: marks, style: style)
                views.append(view)
            case .math(let latex):
                let drawn = MathText.drawable(latex) ?? latex
                let view = existing as? NSHostingView<AnyView> ?? NSHostingView(rootView: AnyView(EmptyView()))
                view.rootView = AnyView(MathBlockView(latex: drawn).environment(\.messageFont, MessageFont(size: style.size)))
                views.append(view)
            case .diagram(let source):
                let view = existing as? MermaidView ?? MermaidView()
                view.cardIsFocused = cardIsFocused
                view.onHeightChange = { [weak self] in self?.diagramChangedHeight() }
                view.show(source: source, style: style)
                views.append(view)
            }
        }
        for view in segmentViews where !views.contains(where: { $0 === view }) { view.removeFromSuperview() }
        for view in views where view.superview !== self { addSubview(view) }
        segmentViews = views
        gaps = document.gaps
        heights = nil
        needsLayout = true
        invalidateIntrinsicContentSize()
    }

    /// A diagram came back from drawing (or showed its code instead) at another height.
    private func diagramChangedHeight() {
        heights = nil
        needsLayout = true
        invalidateIntrinsicContentSize()
    }

    func height(for width: CGFloat) -> CGFloat {
        let values = segmentHeights(for: width)
        return values.reduce(0, +) + gaps.dropFirst().reduce(0, +)
    }

    private func segmentHeights(for width: CGFloat) -> [CGFloat] {
        if let heights, heights.width == width { return heights.values }
        let values = segmentViews.map { view -> CGFloat in
            switch view {
            case let text as ReplyTextView: text.height(for: width)
            case let code as ReplyCodeView: code.height(for: width)
            case let diagram as MermaidView: diagram.height(for: width)
            case let hosting as NSHostingView<AnyView>: hosting.fittingSize.height
            default: 0
            }
        }
        heights = (width, values)
        return values
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        let values = segmentHeights(for: width)
        var y: CGFloat = 0
        for (index, view) in segmentViews.enumerated() {
            if index > 0 { y += index < gaps.count ? gaps[index] : 0 }
            view.frame = CGRect(x: 0, y: y, width: width, height: values[index])
            y += values[index]
        }
    }
}

// MARK: - Prose

/// Prose, as TextKit lays it out: selectable, its links clickable.
final class ReplyTextView: NSTextView, NSTextViewDelegate {
    var openURL: (URL) -> Bool = { _ in false }

    convenience init() {
        let storage = NSTextStorage()
        let layout = ReplyLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        self.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        drawsBackground = false
        isRichText = true
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        usesFontPanel = false
        isAutomaticLinkDetectionEnabled = false
        // The document colors its links (a bot's name in its color, Find's marks in black).
        linkTextAttributes = [.cursor: NSCursor.pointingHand]
        delegate = self
    }

    func show(_ text: NSAttributedString) {
        guard let storage = textStorage else { return }
        ReplyText.replace(storage, with: text)
    }

    /// How tall it is at `width` (the piece keeps it, by width).
    func height(for width: CGFloat) -> CGFloat {
        guard let ownContainer = textContainer, let ownLayout = layoutManager, let storage = textStorage else { return 0 }
        // At the width it's shown at (or before it's shown at all), with its own layout. At any
        // other, with a second layout of the same text: SwiftUI asks for sizes at widths it then
        // doesn't use (as a pane opens or closes), and the text shown laid out at those, under a
        // frame of another width, drew lines over the blocks after it, or left gaps.
        let shown = frame.width == 0 || frame.width == width
        let container: NSTextContainer
        let layout: NSLayoutManager
        if shown {
            container = ownContainer
            layout = ownLayout
            if container.size.width != width { container.size = NSSize(width: width, height: .greatestFiniteMagnitude) }
        } else {
            (layout, container) = measuring(in: storage)
            if container.size.width != width { container.size = NSSize(width: width, height: .greatestFiniteMagnitude) }
        }
        layout.ensureLayout(for: container)
        // Without the line spacing TextKit leaves under the last line.
        // (A table's cells make up for it themselves.)
        let last = (textStorage?.length ?? 0) > 0 ? textStorage?.attribute(.paragraphStyle, at: textStorage!.length - 1, effectiveRange: nil) as? NSParagraphStyle : nil
        let trailing = last.map { $0.textBlocks.isEmpty ? $0.lineSpacing : 0 } ?? 0
        return ceil(layout.usedRect(for: container).height - trailing)
    }

    /// The layout that measures at widths it isn't shown at, made the first time one's asked for.
    private var measuringLayout: (NSLayoutManager, NSTextContainer)?

    private func measuring(in storage: NSTextStorage) -> (NSLayoutManager, NSTextContainer) {
        if let measuringLayout { return measuringLayout }
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        measuringLayout = (layout, container)
        return (layout, container)
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        // Not to nothing: a view is given no room for a moment while it's put in place.
        if newSize.width > 0, textContainer?.size.width != newSize.width { textContainer?.size = NSSize(width: newSize.width, height: .greatestFiniteMagnitude) }
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
        guard let url else { return false }
        if openURL(url) { return true }
        NSWorkspace.shared.open(url)
        return true
    }

    // Scrolling goes to the conversation, not to the text.
    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }

    /// Copied as plain text, as Textual copies: a list's markers as "- " and "1. ", a formula
    /// as it's written, the pictures that are only decoration (a file's icon) left out.
    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        guard let storage = textStorage else { return false }
        let text = selectedRanges.map { Self.plain(storage, in: $0.rangeValue) }.joined(separator: "\n")
        guard !text.isEmpty else { return false }
        pboard.clearContents()
        return pboard.setString(text, forType: .string)
    }

    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string] }

    static func plain(_ storage: NSAttributedString, in range: NSRange) -> String {
        var text = ""
        storage.enumerateAttribute(.replyPlainText, in: range) { value, run, _ in
            if let plain = value as? String {
                text += plain
            } else {
                var part = storage.attributedSubstring(from: run).string as NSString
                // A table's cells: a row on a line, its cells apart by tabs.
                var index = 0
                while index < part.length {
                    let character = part.character(at: index)
                    if character == 10, run.location + index + 1 < storage.length,
                       let next = (storage.attribute(.paragraphStyle, at: run.location + index + 1, effectiveRange: nil) as? NSParagraphStyle)?.textBlocks.first as? NSTextTableBlock,
                       next.startingColumn > 0 {
                        part = part.replacingCharacters(in: NSRange(location: index, length: 1), with: "\t") as NSString
                    }
                    index += 1
                }
                text += part as String
            }
        }
        return text.replacingOccurrences(of: "\u{2028}", with: "\n").replacingOccurrences(of: "\u{200B}", with: "---")
    }

    // In a conversation, what's selected is the conversation's (see `RowStackView`): a press, a
    // double or triple click and a shift-click select through it, across its rows; one that
    // selects nothing is a click, a link's opening. This text only shows its part.
    override func mouseDown(with event: NSEvent) {
        guard let stack = enclosingRowStack else { return super.mouseDown(with: event) }
        stack.trackSelection(from: event) { [self] in
            guard event.clickCount == 1, let link = link(at: convert(event.locationInWindow, from: nil)) else { return }
            _ = textView(self, clickedOnLink: link.value, at: link.index)
        }
    }

    // The keyboard goes to the conversation with its selection, never to one of its texts: two
    // holders of one selection would each draw and clear it their own way.
    override var acceptsFirstResponder: Bool {
        enclosingRowStack == nil && super.acceptsFirstResponder
    }

    /// The link under `point`, if one is.
    private func link(at point: NSPoint) -> (value: Any, index: Int)? {
        guard let layout = layoutManager, let container = textContainer, let storage = textStorage, storage.length > 0 else { return nil }
        let inContainer = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        let glyph = layout.glyphIndex(for: inContainer, in: container)
        guard layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container).contains(inContainer) else { return nil }
        let index = layout.characterIndexForGlyph(at: glyph)
        guard index < storage.length, let value = storage.attribute(.link, at: index, effectiveRange: nil) else { return nil }
        return (value, index)
    }

    // Outside a conversation: another text taking the keyboard leaves this one's selection
    // behind; clear it, so only one selection shows at a time, as in Textual.
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned, selectedRange().length > 0 { setSelectedRange(NSRange(location: selectedRange().location, length: 0)) }
        return resigned
    }
}

/// Draws what TextKit doesn't: inline code's rounded background, a quote's bar, a heading's line
/// and a rule.
nonisolated final class ReplyLayoutManager: NSLayoutManager {
    override func fillBackgroundRectArray(_ rectArray: UnsafePointer<NSRect>, count rectCount: Int, forCharacterRange charRange: NSRange, color: NSColor) {
        super.fillBackgroundRectArray(rectArray, count: rectCount, forCharacterRange: charRange, color: SelectionColor.shown(color, in: firstTextView, for: charRange))
    }

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let container = textContainers.first else { return }
        let characters = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        storage.enumerateAttribute(.replyInlineCode, in: characters) { value, range, _ in
            guard value != nil else { return }
            ReplyDocument.Colors.secondaryBackground.setFill()
            let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? .systemFont(ofSize: 12)
            enumerateLineFragments(forGlyphRange: glyphs) { _, _, _, lineGlyphs, _ in
                let part = NSIntersectionRange(lineGlyphs, glyphs)
                guard part.length > 0 else { return }
                var rect = self.boundingRect(forGlyphRange: part, in: container)
                let baseline = self.location(forGlyphAt: part.location).y + self.lineFragmentRect(forGlyphAt: part.location, effectiveRange: nil).minY
                rect.origin.y = baseline - font.ascender - 1.5
                rect.size.height = font.ascender - font.descender + 3
                rect = rect.insetBy(dx: -2, dy: 0).offsetBy(dx: origin.x, dy: origin.y)
                NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()
            }
        }
        // A quote's bar runs down all of it, the quotes inside it too.
        var quotes: [(range: NSRange, depth: Int)] = []
        storage.enumerateAttribute(.replyQuote, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if let depth = value as? Int { quotes.append((range, depth)) }
        }
        if let deepest = quotes.map(\.depth).max() {
            let size = (storage.attribute(.font, at: quotes[0].range.location, effectiveRange: nil) as? NSFont)?.pointSize ?? 14
            ReplyDocument.Colors.border.setFill()
            for level in 1...deepest {
                var runs: [NSRange] = []
                for quote in quotes where quote.depth >= level {
                    if let lastRun = runs.last, NSMaxRange(lastRun) == quote.range.location {
                        runs[runs.count - 1] = NSUnionRange(lastRun, quote.range)
                    } else {
                        runs.append(quote.range)
                    }
                }
                for run in runs where NSIntersectionRange(run, characters).length > 0 || run.location == characters.location {
                    // Its lines, without the space after its last paragraph.
                    var text = run
                    if text.length > 1, (storage.string as NSString).character(at: NSMaxRange(text) - 1) == 10 { text.length -= 1 }
                    let glyphs = glyphRange(forCharacterRange: text, actualCharacterRange: nil)
                    let top = lineFragmentUsedRect(forGlyphAt: glyphs.location, effectiveRange: nil).minY
                    let bottom = lineFragmentUsedRect(forGlyphAt: max(glyphs.location, NSMaxRange(glyphs) - 1), effectiveRange: nil).maxY
                    let bar = CGRect(x: origin.x + CGFloat(level - 1) * size * 1.2, y: origin.y + top, width: size * 0.2, height: bottom - top)
                    NSBezierPath(roundedRect: bar, xRadius: size * 0.1, yRadius: size * 0.1).fill()
                }
            }
        }
        storage.enumerateAttribute(.replyRule, in: characters) { value, range, _ in
            guard let rule = value as? ReplyRule else { return }
            let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            let width = container.size.width
            switch rule {
            case .underline(let gap):
                let last = max(glyphs.location, NSMaxRange(glyphs) - 1)
                let used = lineFragmentUsedRect(forGlyphAt: last, effectiveRange: nil)
                // Under the text, not under the line spacing TextKit leaves below it.
                let spacing = (storage.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle)?.lineSpacing ?? 0
                ReplyDocument.Colors.divider.setFill()
                CGRect(x: origin.x, y: origin.y + used.maxY - spacing + gap, width: width, height: 1).fill()
            case .line(let height):
                let line = lineFragmentUsedRect(forGlyphAt: glyphs.location, effectiveRange: nil)
                ReplyDocument.Colors.border.setFill()
                CGRect(x: origin.x, y: origin.y + line.midY - height / 2, width: width, height: height).fill()
            }
        }
    }
}

// MARK: - Code

/// A code block: the code in a recessed well, its line numbers beside it, long lines scrolling
/// sideways, and its language and a Copy button in the corner.
final class ReplyCodeView: NSView {
    var cardIsFocused = true { didSet { needsDisplay = true } }
    private let numbers = NSTextField(labelWithString: "")
    private let scroll = SidewaysScrollView()
    private let code = ReplyCodeTextView()
    private let language = NSTextField(labelWithString: "")
    private let copy = ReplyCopyButton()
    private var shown: (code: String, language: String?, marks: [ReplyCodeMark], style: ReplyDocument.Style)?
    private var lineCount = 1
    private var firstLine = ""
    private var style = ReplyDocument.Style()
    private var tokenTask: Task<Void, Never>?
    /// The numbers' size and the corner's, worked out once for what's shown: laying out labels
    /// to measure them, a few times each update, was much of what code being written cost.
    private var numbersSize: CGSize?
    private var cornerSizeKnown: CGSize?

    private static let inset: CGFloat = 12
    private static let radius: CGFloat = 10

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = Self.radius
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        numbers.alignment = .right
        numbers.isSelectable = false
        // Beside the code, not part of it, as Textual's.
        numbers.setAccessibilityElement(false)
        numbers.textColor = .tertiaryLabelColor
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.verticalScrollElasticity = .none
        scroll.horizontalScrollElasticity = .allowed
        scroll.documentView = code
        language.font = .systemFont(ofSize: 11, weight: .medium)
        language.textColor = .tertiaryLabelColor
        copy.target = self
        copy.action = #selector(copyCode)
        addSubview(numbers)
        addSubview(scroll)
        addSubview(language)
        addSubview(copy)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        layer?.backgroundColor = (dark ? NSColor.black.withAlphaComponent(0.3) : NSColor(srgbRed: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 0.035)).cgColor
        layer?.borderColor = (dark ? NSColor.white.withAlphaComponent(0.07) : NSColor(srgbRed: 15 / 255, green: 23 / 255, blue: 42 / 255, alpha: 0.07)).cgColor
    }

    override var wantsUpdateLayer: Bool { true }

    func show(code text: String, language hint: String?, marks: [ReplyCodeMark], style: ReplyDocument.Style) {
        guard shown?.code != text || shown?.language != hint || shown?.marks != marks || shown?.style != style else { return }
        if shown?.style != style { cornerSizeKnown = nil }
        shown = (text, hint, marks, style)
        self.style = style
        lineCount = text.reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
        firstLine = String(text.prefix { $0 != "\n" })
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = style.codeLineSpacing
        paragraph.alignment = .right
        numbers.attributedStringValue = NSAttributedString(string: (1...max(lineCount, 1)).map(String.init).joined(separator: "\n"), attributes: [
            .font: style.code, .foregroundColor: NSColor.tertiaryLabelColor, .paragraphStyle: paragraph,
        ])
        numbers.isHidden = lineCount <= 1
        numbersSize = nil
        let languageName = CodeLanguage.name(of: hint)
        if language.stringValue != languageName { cornerSizeKnown = nil }
        language.stringValue = languageName
        // Colored at once if its tokens were read lately, plain until they are otherwise.
        let name = hint?.trimmingCharacters(in: .whitespaces)
        let isWriting = name?.hasPrefix(CodeLanguage.writing) ?? false
        let cached = name.flatMap { isWriting ? nil : CodeHighlighting.cachedTokens(of: text, in: $0) }
        code.show(ReplyCodeColors.colored(text, tokens: cached, marks: marks, style: style))
        tokenTask?.cancel()
        if cached == nil, let name, !name.isEmpty, !isWriting {
            tokenTask = Task { [weak self] in
                guard let tokens = await CodeHighlighting.tokens(of: text, in: name), !Task.isCancelled, let self, self.shown?.code == text else { return }
                self.code.show(ReplyCodeColors.colored(text, tokens: tokens, marks: marks, style: style))
            }
        }
        needsLayout = true
    }

    /// The code's own room, beside the numbers.
    private func numbersWidth() -> CGFloat {
        lineCount > 1 ? ceil(numbersFittingSize().width) + 12 : 0
    }

    private func numbersFittingSize() -> CGSize {
        if let numbersSize { return numbersSize }
        let size = numbers.fittingSize
        numbersSize = size
        return size
    }

    /// Whether the first line would run in under the corner, so the code starts below it.
    private func clearsCorner(width: CGFloat) -> Bool {
        let codeWidth = width - numbersWidth()
        let advance = style.code.maximumAdvancement.width
        let lineWidth = CopyableCodeBlockStyle.width(of: firstLine, advance: advance)
        return !firstLine.isEmpty && 14 + lineWidth + 8 > codeWidth - cornerSize().width
    }

    private func cornerSize() -> CGSize {
        if let cornerSizeKnown { return cornerSizeKnown }
        let label = language.fittingSize
        let button = copy.fittingSize
        let size = CGSize(width: 28 + label.width + 2 + button.width + 6, height: max(label.height, button.height) + 12)
        cornerSizeKnown = size
        return size
    }

    func height(for width: CGFloat) -> CGFloat {
        let codeHeight = code.contentHeight
        let corner = clearsCorner(width: width) ? max(0, cornerSize().height - Self.inset + 2) : 0
        return ceil(codeHeight + Self.inset * 2 + corner)
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        let top = clearsCorner(width: width) ? max(0, cornerSize().height - Self.inset + 2) : 0
        let numbersWidth = numbersWidth()
        if lineCount > 1 {
            let size = numbersFittingSize()
            numbers.frame = CGRect(x: 12, y: top + Self.inset, width: numbersWidth - 12, height: size.height)
        }
        scroll.frame = CGRect(x: numbersWidth, y: top, width: width - numbersWidth, height: bounds.height - top)
        code.textContainerInset = NSSize(width: 14, height: Self.inset)
        code.fitWidth(min: scroll.contentSize.width)
        let label = language.fittingSize
        let button = copy.fittingSize
        copy.frame = CGRect(x: width - 6 - button.width, y: 6, width: button.width, height: button.height)
        language.frame = CGRect(x: copy.frame.minX - 2 - label.width, y: 6 + (button.height - label.height) / 2, width: label.width, height: label.height)
    }

    @objc private func copyCode() {
        guard let text = shown?.code else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copy.showCopied()
    }
}

/// The code itself: selectable, its lines never wrapping.
final class ReplyCodeTextView: NSTextView {
    convenience init() {
        let storage = NSTextStorage()
        let layout = ReplyCodeLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        self.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        drawsBackground = false
        isRichText = true
        isHorizontallyResizable = true
        isVerticallyResizable = false
        usesFontPanel = false
    }

    func show(_ text: NSAttributedString) {
        guard let storage = textStorage, ReplyText.replace(storage, with: text) else { return }
        cachedSize = nil
        needsDisplay = true
    }

    // As a reply's text: what's selected is the conversation's (see `ReplyTextView`).
    override func mouseDown(with event: NSEvent) {
        guard let stack = enclosingRowStack else { return super.mouseDown(with: event) }
        stack.trackSelection(from: event) {}
    }

    override var acceptsFirstResponder: Bool {
        enclosingRowStack == nil && super.acceptsFirstResponder
    }

    private var cachedSize: CGSize?

    private var usedSize: CGSize {
        if let cachedSize { return cachedSize }
        guard let container = textContainer, let layout = layoutManager else { return .zero }
        layout.ensureLayout(for: container)
        let size = layout.usedRect(for: container).size
        cachedSize = size
        return size
    }

    var contentHeight: CGFloat { ceil(usedSize.height) }

    /// As wide as its longest line, or as `min`.
    func fitWidth(min: CGFloat) {
        let size = usedSize
        setFrameSize(NSSize(width: max(min, ceil(size.width) + textContainerInset.width * 2), height: ceil(size.height) + textContainerInset.height * 2))
    }

    override func scrollWheel(with event: NSEvent) {
        enclosingScrollView?.scrollWheel(with: event)
    }
}

/// Scrolls sideways only: a mostly-up-and-down gesture goes on to the conversation.
final class SidewaysScrollView: NSScrollView {
    private var passesOn: Bool?

    override func scrollWheel(with event: NSEvent) {
        if event.phase == .began || (event.phase == [] && event.momentumPhase == []) {
            passesOn = abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX)
        }
        if passesOn ?? true || documentView.map({ $0.frame.width <= contentSize.width + 1 }) ?? true {
            nextResponder?.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
        if event.phase == .ended || event.momentumPhase == .ended || event.phase == .cancelled { passesOn = nil }
    }
}

/// Copy, as TextButtonStyle looks: a soft fill when the pointer's over it.
final class ReplyCopyButton: NSButton {
    private var isHovering = false { didSet { needsDisplay = true } }
    private var tracking: NSTrackingArea?
    private var reset: Task<Void, Never>?

    init() {
        super.init(frame: .zero)
        isBordered = false
        setButtonType(.momentaryChange)
        font = .systemFont(ofSize: 11, weight: .medium)
        imagePosition = .imageLeading
        imageHugsTitle = true
        toolTip = "Copy Code"
        show(copied: false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func show(copied: Bool) {
        title = copied ? "Copied" : "Copy"
        image = NSImage(systemSymbolName: copied ? "checkmark" : "doc.on.doc", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .medium))
        contentTintColor = isHovering ? .labelColor : .secondaryLabelColor
        attributedTitle = NSAttributedString(string: title, attributes: [.font: font!, .foregroundColor: isHovering ? NSColor.labelColor : NSColor.secondaryLabelColor])
    }

    func showCopied() {
        show(copied: true)
        reset?.cancel()
        reset = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            self?.show(copied: false)
        }
    }

    override var intrinsicContentSize: NSSize {
        let size = super.intrinsicContentSize
        // As wide as "Copied", so the language beside it stays put.
        let copiedWidth = NSAttributedString(string: "Copied", attributes: [.font: font!]).size().width + 10 + 4
        return NSSize(width: max(size.width, copiedWidth) + 12, height: size.height + 6)
    }

    override var fittingSize: NSSize { intrinsicContentSize }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        isHovering = true
        show(copied: title == "Copied")
    }

    override func mouseExited(with event: NSEvent) {
        isHovering = false
        show(copied: title == "Copied")
    }

    override func draw(_ dirtyRect: NSRect) {
        if isHovering || isHighlighted {
            (isHighlighted ? NSColor.labelColor.withAlphaComponent(0.12) : NSColor.labelColor.withAlphaComponent(0.06)).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        }
        super.draw(dirtyRect)
    }
}

/// Code colored by its tokens, in the code font.
enum ReplyCodeColors {
    private static var colors: [String: NSColor] = [:]

    static func colored(_ code: String, tokens: [CodeHighlighting.Token]?, marks: [ReplyCodeMark] = [], style: ReplyDocument.Style) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = style.codeLineSpacing
        let base: [NSAttributedString.Key: Any] = [.font: style.code, .foregroundColor: ReplyDocument.Colors.primary, .paragraphStyle: paragraph]
        let text = NSMutableAttributedString()
        if let tokens, tokens.reduce(0, { $0 + $1.text.utf16.count }) == code.utf16.count {
            for token in tokens {
                var attributes = base
                if let color = color(for: token.type) { attributes[.foregroundColor] = color }
                text.append(NSAttributedString(string: token.text, attributes: attributes))
            }
        } else {
            text.append(NSAttributedString(string: code, attributes: base))
        }
        // Find's marks, over the colors.
        for mark in marks where NSMaxRange(mark.range) <= text.length {
            text.addAttribute(.backgroundColor, value: mark.background, range: mark.range)
            if let foreground = mark.foreground { text.addAttribute(.foregroundColor, value: foreground, range: mark.range) }
        }
        return text
    }

    private static func color(for type: String) -> NSColor? {
        if let known = colors[type] { return known }
        guard CodeColors.color(for: type, dark: true) != nil else { return nil }
        let color = NSColor(name: nil) { appearance in
            let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return CodeColors.color(for: type, dark: dark).map { NSColor($0) } ?? .labelColor
        }
        colors[type] = color
        return color
    }
}

/// Changing what a text shows.
enum ReplyText {
    /// `storage` made `text`: only from the paragraph before the first that's different, when the
    /// rest is the same (a reply streaming in grows at its end), so TextKit lays out only that.
    /// Whether anything changed.
    @discardableResult
    static func replace(_ storage: NSTextStorage, with text: NSAttributedString) -> Bool {
        let old = storage.string as NSString
        let new = text.string as NSString
        guard old.length > 0, new.length > 0 else {
            guard storage.length > 0 || text.length > 0 else { return false }
            storage.setAttributedString(text)
            return true
        }
        // Where they differ, as characters.
        let limit = min(old.length, new.length)
        var common = 0
        while common < limit, old.character(at: common) == new.character(at: common) { common += 1 }
        if common == old.length, common == new.length, storage.isEqual(to: text) { return false }
        // From the paragraph before (its space after it changes as one comes after it).
        var start = old.paragraphRange(for: NSRange(location: min(common, old.length - 1), length: 0)).location
        if start > 0 { start = old.paragraphRange(for: NSRange(location: start - 1, length: 0)).location }
        guard start > 0, storage.attributedSubstring(from: NSRange(location: 0, length: start)).isEqual(to: text.attributedSubstring(from: NSRange(location: 0, length: start))) else {
            storage.setAttributedString(text)
            return true
        }
        storage.beginEditing()
        storage.replaceCharacters(in: NSRange(location: start, length: old.length - start), with: text.attributedSubstring(from: NSRange(location: start, length: new.length - start)))
        storage.endEditing()
        return true
    }
}

/// A code block's layout: its selection in the color of the conversation's.
nonisolated final class ReplyCodeLayoutManager: NSLayoutManager {
    override func fillBackgroundRectArray(_ rectArray: UnsafePointer<NSRect>, count rectCount: Int, forCharacterRange charRange: NSRange, color: NSColor) {
        super.fillBackgroundRectArray(rectArray, count: rectCount, forCharacterRange: charRange, color: SelectionColor.shown(color, in: firstTextView, for: charRange))
    }
}

/// A text in a conversation draws its part of the selection in the conversation's look (in use,
/// or set aside), as its other texts and the rows it tints do: none of them has the keyboard
/// (the conversation does), so each would otherwise draw it set aside. What's filled is the
/// selection when it's inside what's selected, whatever color TextKit gives it; another fill (an
/// inline code's background, Find's marks) is left as it is.
nonisolated enum SelectionColor {
    static func shown(_ color: NSColor, in text: NSTextView?, for range: NSRange) -> NSColor {
        MainActor.assumeIsolated {
            guard let text, let stack = text.enclosingRowStack, range.length > 0 else { return color }
            let selected = text.selectedRange()
            guard selected.length > 0, NSIntersectionRange(range, selected).length == range.length else { return color }
            let shown: NSColor = stack.isSelectionEmphasized ? .selectedTextBackgroundColor : .unemphasizedSelectedTextBackgroundColor
            shown.setFill()
            return shown
        }
    }
}

extension NSView {
    /// The conversation's rows this is in, if it's in some.
    var enclosingRowStack: RowStackView? {
        var view = superview
        while let current = view, !(current is RowStackView) { view = current.superview }
        return view as? RowStackView
    }
}
