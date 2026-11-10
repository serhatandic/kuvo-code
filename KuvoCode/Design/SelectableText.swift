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
    /// As many whole lines as fit this high, for a text whose lines may be of different heights
    /// (a tool's output, its other scripts in taller fonts).
    var maxHeight: CGFloat?
    /// Told whether `lineLimit` or `maxHeight` cuts anything, as it changes.
    var cut: ((Bool) -> Void)?
    /// Whether they cut it at each width it's measured at, known as it's measured (`cut` says so
    /// a turn later, once it's laid out).
    var cuts: TextCuts?

    var body: some View {
        Host(text: text, faces: faces, lineLimit: lineLimit, maxHeight: maxHeight, cut: cut, cuts: cuts)
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
    let maxHeight: CGFloat?
    let cut: ((Bool) -> Void)?
    let cuts: TextCuts?

    func makeNSView(context: Context) -> SelectableTextView {
        SelectableTextView()
    }

    func updateNSView(_ view: SelectableTextView, context: Context) {
        let openURL = context.environment.openURL
        view.openURL = { openURL($0) }
        view.cut = cut
        view.cuts = cuts
        view.show(text, faces: faces, lineLimit: lineLimit, maxHeight: maxHeight)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: SelectableTextView, context: Context) -> CGSize? {
        view.size(fitting: proposal.width.flatMap { $0.isFinite ? $0 : nil })
    }
}

/// Whether a `SelectableText`'s line limit cuts its words at the widths it was measured at, as
/// they're measured: what goes under them (a long message's Show More) has its room from the
/// first time they're measured, rather than a turn later, when `cut` says so once they're laid
/// out, and a conversation would move what's under them. Read by a SwiftUI layout, which isn't
/// held to the main actor, though it lays out on the main thread as the text is measured there.
nonisolated final class TextCuts {
    fileprivate var widths: [CGFloat: Bool] = [:]

    /// At `width`, the width its words were offered; nil if they weren't measured at it.
    func at(_ width: CGFloat) -> Bool? {
        widths[width] ?? widths.first { abs($0.key - width) < 0.5 }?.value
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
        /// Drawn at its own width (a chip), rather than `size` across.
        var width: CGFloat?
    }

    var all: [Face] = []
    /// How big each is drawn, in points.
    var size: CGFloat = 0
    /// The characters VoiceOver leaves out: those under a picture (a bot's name is read without
    /// its "&", as its face was), and those left out of sight (a picture's name's "]").
    var unspoken = IndexSet()

    /// Makes room for `image` over the first character of `span` in `storage`, in `font` (the
    /// span's): that character unseen, as wide as the picture.
    mutating func add(_ image: NSImage?, at span: NSRange, in storage: NSMutableAttributedString, font: NSFont) {
        guard let image, span.length > 0, span.upperBound <= storage.length else { return }
        let first = (storage.string as NSString).substring(with: NSRange(location: span.location, length: 1))
        let width = (first as NSString).size(withAttributes: [.font: font]).width
        storage.addAttributes([.foregroundColor: NSColor.clear, .kern: size + 1 - width], range: NSRange(location: span.location, length: 1))
        all.append(Face(at: span.location, image: image))
        unspoken.insert(span.location)
    }

    /// A Work Queue item's chip drawn over `span` (its "#243"): the first character makes room for
    /// the whole picture and the others go out of sight, though VoiceOver still reads them and
    /// copying keeps them.
    mutating func addChip(_ image: NSImage, over span: NSRange, in storage: NSMutableAttributedString, font: NSFont) {
        guard span.length > 0, span.upperBound <= storage.length else { return }
        let string = storage.string as NSString
        for offset in 0..<span.length {
            let at = NSRange(location: span.location + offset, length: 1)
            let width = string.substring(with: at).size(withAttributes: [.font: font]).width
            storage.addAttributes([.foregroundColor: NSColor.clear, .kern: offset == 0 ? image.size.width + 3 - width : -width], range: at)
        }
        all.append(Face(at: span.location, image: image, width: image.size.width))
    }

    /// Leaves `span` of `storage`, in `font`, out of sight and out of what VoiceOver reads, its
    /// room taken back.
    mutating func hide(_ span: NSRange, in storage: NSMutableAttributedString, font: NSFont) {
        guard span.length > 0, span.upperBound <= storage.length else { return }
        let width = (storage.string as NSString).substring(with: span).size(withAttributes: [.font: font]).width
        storage.addAttributes([.foregroundColor: NSColor.clear, .kern: -width], range: span)
        unspoken.insert(integersIn: span.location..<span.upperBound)
    }

    /// `text` as VoiceOver reads it: without the characters it leaves out.
    func spoken(_ text: String) -> String {
        guard !unspoken.isEmpty else { return text }
        let text = text as NSString
        return IndexSet(integersIn: 0..<text.length).subtracting(unspoken).rangeView
            .map { text.substring(with: NSRange(location: $0.lowerBound, length: $0.count)) }.joined()
    }

    /// Where `index` of the text as written is in the text as it's read.
    func spokenIndex(_ index: Int) -> Int {
        index - unspoken.count(in: 0..<max(0, index))
    }

    /// Where `index` of the text as it's read is in the text as written: the character it reads,
    /// past those left out before it.
    func writtenIndex(_ index: Int) -> Int {
        var written = index
        for range in unspoken.rangeView where range.lowerBound <= written {
            written += range.count
        }
        return written
    }

    /// `range` of the text as written, in the text as it's read.
    func spoken(_ range: NSRange) -> NSRange {
        let start = spokenIndex(range.location)
        return NSRange(location: start, length: spokenIndex(range.location + range.length) - start)
    }

    /// `range` of the text as it's read, in the text as written.
    func written(_ range: NSRange) -> NSRange {
        let start = writtenIndex(range.location)
        let end = range.length > 0 ? writtenIndex(range.location + range.length - 1) + 1 : start
        return NSRange(location: start, length: end - start)
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
            let width = face.width ?? size
            let height = face.image.size.width > 0 ? width * face.image.size.height / face.image.size.width : size
            face.image.draw(in: NSRect(x: rect.minX + (face.width == nil ? 0 : 1), y: rect.midY - height / 2, width: width, height: height), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
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
    var cuts: TextCuts? {
        didSet { if cuts !== oldValue { sizes = [:] } }
    }
    private var faces = TextFaces()
    private var lineLimit: Int?
    private var maxHeight: CGFloat?
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

    func show(_ text: NSAttributedString, faces: TextFaces, lineLimit: Int?, maxHeight: CGFloat? = nil) {
        guard let storage = textStorage, let container = textContainer else { return }
        if lineLimit != self.lineLimit || maxHeight != self.maxHeight || !storage.isEqual(to: text) {
            sizes = [:]
            cuts?.widths = [:]
        }
        self.lineLimit = lineLimit
        self.maxHeight = maxHeight
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
        limit(container, width: width)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        // Never narrower than its lines (so they break where they were measured to).
        let size = CGSize(width: min(ceil(used.width), width), height: ceil(used.height))
        sizes[width] = size
        cuts?.widths[width] = isCut(in: layout, container)
        return size
    }

    /// Its sizes at the widths it was measured at, for its words and line limit as they are.
    private var sizes: [CGFloat: CGSize] = [:]

    /// One line's height, in its first font.
    private var lineHeight: CGFloat {
        let font = (textStorage?.length ?? 0) > 0 ? textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont : nil
        return layoutManager?.defaultLineHeight(for: font ?? .systemFont(ofSize: NSFont.systemFontSize)) ?? 16
    }

    /// Lays `container` out `width` wide (as it is, if nil) to the line limit, the last line cut
    /// short, and to as many whole lines as fit in `maxHeight`.
    private func limit(_ container: NSTextContainer, width: CGFloat? = nil) {
        let size = CGSize(width: width ?? container.size.width, height: maxHeight ?? .greatestFiniteMagnitude)
        if container.size != size { container.size = size }
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

    /// Whether the line limit leaves words out of `container`, as `layout` lays it out.
    private func isCut(in layout: NSLayoutManager, _ container: NSTextContainer) -> Bool {
        guard lineLimit != nil || maxHeight != nil, let storage = textStorage, storage.length > 0 else { return false }
        // Only as far as its lines go: all of a long text's glyphs aren't needed to see it's cut.
        let laid = layout.glyphRange(for: container)
        return layout.characterRange(forGlyphRange: laid, actualGlyphRange: nil).upperBound < storage.length
            || layout.truncatedGlyphRange(inLineFragmentForGlyphAt: max(0, laid.upperBound - 1)).location != NSNotFound
    }

    /// Tells `cut` whether the line limit leaves words out where it's shown, when that changes.
    private func tellCut() {
        guard let cut, let layout = layoutManager, let container = textContainer else { return }
        let isCut = isCut(in: layout, container)
        guard isCut != wasCut else { return }
        wasCut = isCut
        // After this layout pass: it sets state.
        DispatchQueue.main.async { cut(isCut) }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        // Not to nothing: a view is given no room for a moment while it's put in place.
        guard newSize.width > 0, let container = textContainer else { return }
        limit(container, width: newSize.width)
        // Whether it's cut at the width it's shown at (said again only when that changes).
        tellCut()
    }

    // VoiceOver reads it as words on the page, as it does a Text, never as a text area to edit,
    // and reads its pictures' characters as it read the pictures: a bot's name without its "&".
    override func accessibilityRole() -> NSAccessibility.Role? { .staticText }

    override func accessibilityRoleDescription() -> String? {
        NSAccessibility.Role.staticText.description(with: nil)
    }

    override func accessibilityValue() -> String? {
        faces.spoken(string)
    }

    // The rest of what VoiceOver asks, by character, word and line, of the text as it's read.
    override func accessibilityNumberOfCharacters() -> Int {
        faces.unspoken.isEmpty ? super.accessibilityNumberOfCharacters() : (faces.spoken(string) as NSString).length
    }

    override func accessibilityString(for range: NSRange) -> String? {
        guard !faces.unspoken.isEmpty else { return super.accessibilityString(for: range) }
        let spoken = faces.spoken(string) as NSString
        guard range.location >= 0, range.location + range.length <= spoken.length else { return nil }
        return spoken.substring(with: range)
    }

    override func accessibilityAttributedString(for range: NSRange) -> NSAttributedString? {
        guard !faces.unspoken.isEmpty else { return super.accessibilityAttributedString(for: range) }
        return accessibilityString(for: range).map { NSAttributedString(string: $0) }
    }

    override func accessibilityVisibleCharacterRange() -> NSRange {
        faces.unspoken.isEmpty ? super.accessibilityVisibleCharacterRange() : faces.spoken(super.accessibilityVisibleCharacterRange())
    }

    override func accessibilitySelectedTextRange() -> NSRange {
        faces.unspoken.isEmpty ? super.accessibilitySelectedTextRange() : faces.spoken(super.accessibilitySelectedTextRange())
    }

    override func accessibilitySelectedText() -> String? {
        faces.unspoken.isEmpty ? super.accessibilitySelectedText() : accessibilityString(for: accessibilitySelectedTextRange())
    }

    override func accessibilityLine(for index: Int) -> Int {
        super.accessibilityLine(for: faces.unspoken.isEmpty ? index : faces.writtenIndex(index))
    }

    override func accessibilityRange(forLine line: Int) -> NSRange {
        faces.unspoken.isEmpty ? super.accessibilityRange(forLine: line) : faces.spoken(super.accessibilityRange(forLine: line))
    }

    override func accessibilityRange(for point: NSPoint) -> NSRange {
        faces.unspoken.isEmpty ? super.accessibilityRange(for: point) : faces.spoken(super.accessibilityRange(for: point))
    }

    override func accessibilityFrame(for range: NSRange) -> NSRect {
        super.accessibilityFrame(for: faces.unspoken.isEmpty ? range : faces.written(range))
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

    // A right-click offers what's around the words (a message's Undo From Here…, a command's Copy
    // Output), as one beside them does; on words selected or a link, what the text offers for them.
    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        guard link(at: point) == nil, !selectedRanges.contains(where: { NSLocationInRange(character(at: point), $0.rangeValue) }) else { return super.menu(for: event) }
        var view = superview
        while let around = view {
            if let menu = around.menu(for: event), !menu.items.isEmpty { return menu }
            view = around.superview
        }
        return super.menu(for: event)
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
    /// The character under `point` (in the view), or the nearest one (its whole width, where an
    /// insertion point goes by the nearer half).
    func character(at point: NSPoint) -> Int {
        guard let layout = layoutManager, let container = textContainer else { return NSNotFound }
        let inContainer = NSPoint(x: point.x - textContainerOrigin.x, y: point.y - textContainerOrigin.y)
        return layout.characterIndex(for: inContainer, in: container, fractionOfDistanceBetweenInsertionPoints: nil)
    }

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
