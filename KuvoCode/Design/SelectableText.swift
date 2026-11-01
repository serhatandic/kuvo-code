import AppKit
import SwiftUI

/// Words you can select and copy, set by AppKit's text system as the composer and the replies
/// are, so their pointer (the I-beam, a link's pointing hand) shows only where they're what's
/// under it (`PointerAwareTextView`). SwiftUI's selectable `Text` keeps its I-beam over its whole
/// frame, under Scroll to the End or a card drawn over it. Sized as a `Text` is: as wide as its
/// words, up to the width it's offered, and as tall as they wrap, up to `lineLimit` lines (the
/// last one cut short with an ellipsis). In a conversation, it's part of the conversation's one
/// selection, as a reply is.
struct SelectableText: View {
    let text: NSAttributedString
    /// Pictures drawn over characters kept in their place (`TextFaces`): a bot's face for its "&".
    var faces: TextFaces = TextFaces()
    var lineLimit: Int?
    /// Told whether `lineLimit` cuts anything, as it changes.
    var cut: ((Bool) -> Void)?

    var body: some View {
        Host(text: text, faces: faces, lineLimit: lineLimit, cut: cut)
            // Lined up by its first line, as a Text is (an icon beside it).
            .alignmentGuide(.firstTextBaseline) { _ in firstBaseline }
    }

    /// Where its first line's baseline is, from its top.
    private var firstBaseline: CGFloat {
        guard text.length > 0, let font = text.attribute(.font, at: 0, effectiveRange: nil) as? NSFont else { return 0 }
        return Self.baselines.defaultBaselineOffset(for: font)
    }

    private static let baselines = NSLayoutManager()
}

private struct Host: NSViewRepresentable {
    let text: NSAttributedString
    let faces: TextFaces
    let lineLimit: Int?
    let cut: ((Bool) -> Void)?

    func makeNSView(context: Context) -> SelectableTextView {
        SelectableTextView()
    }

    func updateNSView(_ view: SelectableTextView, context: Context) {
        let openURL = context.environment.openURL
        view.openURL = { openURL($0) }
        view.cut = cut
        view.show(text, faces: faces, lineLimit: lineLimit)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: SelectableTextView, context: Context) -> CGSize? {
        view.size(fitting: proposal.width.flatMap { $0.isFinite ? $0 : nil })
    }
}

/// Pictures drawn over characters of a text, which stay in it as they're written (so they're
/// copied and found as written) but unseen, with room made for each: a bot's face over its "&",
/// a keyword's mark over its "/". The composer draws them the same way.
struct TextFaces: Equatable {
    struct Face: Equatable {
        /// The character it's drawn over.
        var at: Int
        var image: NSImage
    }

    var all: [Face] = []
    /// How big each is drawn, in points.
    var size: CGFloat = 0

    /// Makes room for `image` over the first character of `span` in `storage`, in `font` (the
    /// span's): that character unseen, as wide as the picture.
    mutating func add(_ image: NSImage?, at span: NSRange, in storage: NSMutableAttributedString, font: NSFont) {
        guard let image, span.length > 0, span.upperBound <= storage.length else { return }
        let first = (storage.string as NSString).substring(with: NSRange(location: span.location, length: 1))
        let width = (first as NSString).size(withAttributes: [.font: font]).width
        storage.addAttributes([.foregroundColor: NSColor.clear, .kern: size + 1 - width], range: NSRange(location: span.location, length: 1))
        all.append(Face(at: span.location, image: image))
    }

    /// Draws them in `text`, each over its character.
    func draw(in text: NSTextView) {
        guard !all.isEmpty, let layout = text.layoutManager, let container = text.textContainer else { return }
        let origin = text.textContainerOrigin
        let length = (text.string as NSString).length
        for face in all where face.at < length {
            let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: face.at, length: 1), actualCharacterRange: nil)
            // Past a line limit: not laid out, not drawn.
            guard glyphs.length > 0, glyphs.location < layout.glyphRange(for: container).upperBound else { continue }
            let rect = layout.boundingRect(forGlyphRange: glyphs, in: container).offsetBy(dx: origin.x, dy: origin.y)
            guard rect.width > 0 else { continue }
            // As wide as its room, as tall as its shape makes it (a symbol isn't square).
            let height = face.image.size.width > 0 ? size * face.image.size.height / face.image.size.width : size
            face.image.draw(in: NSRect(x: rect.minX, y: rect.midY - height / 2, width: size, height: height), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
    }

    /// A symbol as a face, `size` points, drawn in `ink`: the same picture each time it's asked
    /// for, so a text shown again with the same faces isn't drawn again.
    static func symbol(_ name: String, size: CGFloat, ink: NSColor = .secondaryLabelColor) -> NSImage? {
        let key = "\(name) \(size) \(ink)"
        if let known = symbols[key] { return known }
        let configuration = NSImage.SymbolConfiguration(pointSize: size * 0.82, weight: .regular)
            .applying(.init(hierarchicalColor: ink))
        let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(configuration)
        symbols[key] = image
        return image
    }

    private static var symbols: [String: NSImage] = [:]
}

/// The text view under `SelectableText`: not editable, sized by its words, with no scroll view of
/// its own.
final class SelectableTextView: PointerAwareTextView {
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    var cut: ((Bool) -> Void)?
    private var faces = TextFaces()
    private var lineLimit: Int?
    private var wasCut: Bool?

    init() {
        let storage = NSTextStorage()
        let layout = SelectionLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
        usesFindBar = false
        usesFontPanel = false
        enabledTextCheckingTypes = 0
        isContinuousSpellCheckingEnabled = false
        isGrammarCheckingEnabled = false
        isAutomaticDataDetectionEnabled = false
        isAutomaticLinkDetectionEnabled = false
        // The text colors its links itself (a bot's name in its color, Find's marks in black).
        linkTextAttributes = [.cursor: NSCursor.pointingHand]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func show(_ text: NSAttributedString, faces: TextFaces, lineLimit: Int?) {
        guard let storage = textStorage, let container = textContainer else { return }
        if lineLimit != self.lineLimit || !storage.isEqual(to: text) { sizes = [:] }
        self.lineLimit = lineLimit
        if !storage.isEqual(to: text) { storage.setAttributedString(text) }
        limit(container)
        if faces != self.faces {
            self.faces = faces
            needsDisplay = true
        }
        // Shown already: whether it's cut now (Show Less brings the line limit back at the width
        // it has).
        if frame.width > 0 { tellCut() }
    }

    /// Its size at `width` (nil: as wide as its longest line), as a `Text` takes it: no wider than
    /// its longest line, and as narrow as anything can be when offered no width (a row of it and
    /// others gives it what's left).
    func size(fitting width: CGFloat?) -> CGSize {
        if width == 0 { return CGSize(width: 0, height: ceil(lineHeight)) }
        let width = width ?? CGFloat.greatestFiniteMagnitude
        // SwiftUI asks again and again, at its own widths and the one it offers.
        if let known = sizes[width] { return known }
        // Measured with a layout of its own, never the one it's drawn with: SwiftUI asks at widths
        // it then doesn't use (and a text this hugs is never shown at the width it's offered), and
        // a text view's own layout says its wrapped lines take all the width there is.
        let (layout, container) = measuring
        if container.size.width != width { container.size = CGSize(width: width, height: .greatestFiniteMagnitude) }
        limit(container)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        // Never narrower than its lines (so they break where they were measured to).
        let size = CGSize(width: min(ceil(used.width), width), height: ceil(used.height))
        sizes[width] = size
        return size
    }

    /// Its sizes at the widths it was measured at, for its words and line limit as they are.
    private var sizes: [CGFloat: CGSize] = [:]

    /// One line's height, in its first font.
    private var lineHeight: CGFloat {
        let font = (textStorage?.length ?? 0) > 0 ? textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont : nil
        return layoutManager?.defaultLineHeight(for: font ?? .systemFont(ofSize: NSFont.systemFontSize)) ?? 16
    }

    /// Lays `container` out to the line limit, the last line cut short.
    private func limit(_ container: NSTextContainer) {
        let limit = lineLimit ?? 0
        guard container.maximumNumberOfLines != limit else { return }
        container.maximumNumberOfLines = limit
        container.lineBreakMode = limit > 0 ? .byTruncatingTail : .byWordWrapping
    }

    /// The layout it's measured with.
    private lazy var measuring: (NSLayoutManager, NSTextContainer) = {
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        layout.addTextContainer(container)
        textStorage?.addLayoutManager(layout)
        return (layout, container)
    }()

    /// Tells `cut` whether the line limit leaves words out where it's shown, when that changes.
    private func tellCut() {
        guard let cut, let layout = layoutManager, let container = textContainer, let storage = textStorage else { return }
        var isCut = false
        if lineLimit != nil, storage.length > 0 {
            // Only as far as its lines go: all of a long text's glyphs aren't needed to see it's cut.
            let laid = layout.glyphRange(for: container)
            isCut = layout.characterRange(forGlyphRange: laid, actualGlyphRange: nil).upperBound < storage.length
                || layout.truncatedGlyphRange(inLineFragmentForGlyphAt: max(0, laid.upperBound - 1)).location != NSNotFound
        }
        guard isCut != wasCut else { return }
        wasCut = isCut
        // After this layout pass: it sets state.
        DispatchQueue.main.async { cut(isCut) }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        // Not to nothing: a view is given no room for a moment while it's put in place.
        guard newSize.width > 0, let container = textContainer else { return }
        if container.size.width != newSize.width { container.size = NSSize(width: newSize.width, height: .greatestFiniteMagnitude) }
        // Whether it's cut at the width it's shown at (said again only when that changes).
        tellCut()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        faces.draw(in: self)
    }

    override func clicked(onLink link: Any, at charIndex: Int) {
        guard let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:)) else { return }
        openURL(url)
    }

    // Copied as plain text, its words as written (a bot's "&" under its face).
    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string] }

    // In a conversation, a press selects across it (`RowStackView`), and a click on a link opens it.
    override func mouseDown(with event: NSEvent) {
        guard let stack = enclosingRowStack else { return super.mouseDown(with: event) }
        stack.trackSelection(from: event) { [self] in
            guard event.clickCount == 1, let link = link(at: convert(event.locationInWindow, from: nil)) else { return }
            clicked(onLink: link.value, at: link.index)
        }
    }

    // The keyboard goes to the conversation with its selection, never to one of its texts.
    override var acceptsFirstResponder: Bool {
        enclosingRowStack == nil && super.acceptsFirstResponder
    }

    // Outside a conversation: another text taking the keyboard leaves this one's selection behind.
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned, selectedRange().length > 0 { setSelectedRange(NSRange(location: selectedRange().location, length: 0)) }
        return resigned
    }

    // Scrolling goes to what it's in.
    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }
}

extension NSTextView {
    /// The link under `point` (in the view), if one is.
    func link(at point: NSPoint) -> (value: Any, index: Int)? {
        guard let layout = layoutManager, let container = textContainer, let storage = textStorage, storage.length > 0 else { return nil }
        let inContainer = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        let glyph = layout.glyphIndex(for: inContainer, in: container)
        guard layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container).contains(inContainer) else { return nil }
        let index = layout.characterIndexForGlyph(at: glyph)
        guard index < storage.length, let value = storage.attribute(.link, at: index, effectiveRange: nil) else { return nil }
        return (value, index)
    }
}
