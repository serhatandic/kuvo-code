import AppKit
import SwiftUI
import Textual

/// A reply's Markdown as TextKit draws it (`ReplyView`): its prose, lists, quotes and tables as
/// one attributed text for each run of them, and its code blocks apart, each a view of its own
/// that scrolls sideways. Styled as Textual's GitHub style is, with our code blocks.
struct ReplyDocument {
    enum Segment {
        /// Prose: paragraphs, headings, lists, quotes, tables and rules.
        case text(NSAttributedString)
        /// A code block, without its last line break, and Find's marks in it.
        case code(code: String, language: String?, marks: [ReplyCodeMark])
        /// A formula on its own line (`$$…$$`).
        case math(latex: String)
        /// A Mermaid diagram (` ```mermaid `), where the document is asked to draw them.
        case diagram(source: String)
    }

    var segments: [Segment] = []
    /// The space above each segment (the first's is 0).
    var gaps: [CGFloat] = []
    /// What its first block asks for above it, and its last below it: for putting two together
    /// (`joined`) with the space between them as one document would have it.
    private var leadingTop: CGFloat = 0
    private var trailing = Spacing(top: 0, bottom: 0)

    /// The look it's drawn in: the messages' size and typeface.
    struct Style: Hashable {
        var size: CGFloat = 14
        var design: NSFontDescriptor.SystemDesign = .default
        /// Dark or light: pictures in the text (a formula, a face) are drawn for one.
        var dark = false

        var body: NSFont { Self.font(size, weight: .regular, design: design) }
        var codeSize: CGFloat { size * 0.85 }
        var code: NSFont { NSFont.monospacedSystemFont(ofSize: codeSize, weight: .regular) }
        /// Code's lines: Textual's 0.225 of its size between them.
        var codeLineSpacing: CGFloat { codeSize * 0.225 }

        static func font(_ size: CGFloat, weight: NSFont.Weight, design: NSFontDescriptor.SystemDesign, italic: Bool = false) -> NSFont {
            var descriptor = NSFont.systemFont(ofSize: size, weight: weight).fontDescriptor
            if design != .default, let designed = descriptor.withDesign(design) { descriptor = designed }
            if italic { descriptor = descriptor.withSymbolicTraits(descriptor.symbolicTraits.union(.italic)) }
            return NSFont(descriptor: descriptor, size: size) ?? .systemFont(ofSize: size, weight: weight)
        }
    }

    /// Textual's GitHub colors.
    nonisolated enum Colors {
        /// As Textual leaves it: the system's.
        static let primary = NSColor.labelColor
        static let secondary = dynamic(light: (107, 110, 123), dark: (146, 148, 160))
        static let tertiary = dynamic(light: (107, 110, 123), dark: (109, 112, 125))
        static let secondaryBackground = dynamic(light: (247, 247, 249), dark: (37, 38, 42))
        static let link = dynamic(light: (44, 101, 207), dark: (76, 142, 248))
        static let border = dynamic(light: (228, 228, 232), dark: (66, 68, 78))
        static let divider = dynamic(light: (208, 208, 211), dark: (51, 52, 56))

        static func dynamic(light: (Int, Int, Int), dark: (Int, Int, Int)) -> NSColor {
            NSColor(name: nil) { appearance in
                let (r, g, b) = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
                return NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
            }
        }
    }

    // MARK: Cache

    /// Documents made lately, by what they were made from: a reply scrolled back into view isn't
    /// read again.
    private struct CacheKey: Hashable {
        var markdown: String
        var style: Style
        var folders: [String]
    }

    private static var cache: [CacheKey: ReplyDocument] = [:]
    private static var cacheOrder: [CacheKey] = []
    private static var cachedCharacters = 0
    /// About what the documents kept may hold in all: some hundreds of replies' worth.
    private static let cacheLimit = 600_000

    static func cached(markdown: String, parser: FileLinkingParser, style: Style) -> ReplyDocument {
        // With Find's marks, a group chat's faces or named agents, made each time (rarely).
        guard parser.highlight == nil, parser.mentions.isEmpty, parser.agents.isEmpty else { return ReplyDocument(markdown: markdown, parser: parser, style: style) }
        let key = CacheKey(markdown: markdown, style: style, folders: parser.folders())
        if let known = cache[key] { return known }
        // A long one from short parts, each kept: as a reply is written, only its last part is
        // read again with each few words, not all of it (most of what each update cost).
        let parts = markdown.utf8.count > Self.partSize * 2 ? MarkdownChunks.split(markdown, size: Self.partSize) : []
        let document: ReplyDocument
        if parts.count > 1 {
            var joined = cached(markdown: parts[0].text, parser: parser, style: style)
            for part in parts.dropFirst() { joined = joined.joined(cached(markdown: part.text, parser: parser, style: style)) }
            document = joined
            #if DEBUG
            if PartsCheck.isOn { PartsCheck.compare(joined, ReplyDocument(markdown: markdown, parser: parser, style: style), markdown: markdown) }
            #endif
        } else {
            document = ReplyDocument(markdown: markdown, parser: parser, style: style)
        }
        cache[key] = document
        cacheOrder.append(key)
        cachedCharacters += markdown.utf16.count
        // Kept by how much they hold, not how many: a long block being written (a table, a code
        // block, which can't be read in parts) is a new document with each few words.
        while cachedCharacters > Self.cacheLimit || cacheOrder.count > 1500, !cacheOrder.isEmpty {
            let oldest = cacheOrder.removeFirst()
            cache[oldest] = nil
            cachedCharacters -= oldest.markdown.utf16.count
        }
        return document
    }

    /// About how long the parts a long piece is read in are.
    private static let partSize = 600

    /// `next` after this, with the space between them that one document of both would have: the
    /// two only meet where a paragraph or heading starts (see `MarkdownChunks`).
    private func joined(_ next: ReplyDocument) -> ReplyDocument {
        guard let first = next.segments.first else { return self }
        guard let last = segments.last else { return next }
        var joined = self
        let gap: CGFloat
        if case .text = first {
            gap = max(trailing.bottom, next.leadingTop) + trailing.below
        } else {
            gap = trailing.bottom + trailing.below
        }
        if case .text(let before) = last, case .text(let after) = first, before.length > 0 {
            // One text: the space goes after the paragraph before, less the line spacing TextKit
            // leaves under its last line.
            let text = NSMutableAttributedString(attributedString: before)
            let paragraphRange = (text.string as NSString).paragraphRange(for: NSRange(location: text.length - 1, length: 0))
            if let style = text.attribute(.paragraphStyle, at: text.length - 1, effectiveRange: nil) as? NSParagraphStyle,
               let paragraph = style.mutableCopy() as? NSMutableParagraphStyle {
                paragraph.paragraphSpacing = max(0, gap - paragraph.lineSpacing)
                text.addAttribute(.paragraphStyle, value: paragraph, range: paragraphRange)
            }
            text.append(NSAttributedString(string: "\n", attributes: Self.separatorAttributes(of: text)))
            text.append(after)
            joined.segments[joined.segments.count - 1] = .text(text)
            joined.segments += next.segments.dropFirst()
            joined.gaps += next.gaps.dropFirst()
        } else {
            joined.segments += next.segments
            joined.gaps += [gap] + next.gaps.dropFirst()
        }
        joined.trailing = next.trailing
        return joined
    }

    // MARK: Building

    /// What a block asks for above and below it; the space between two is the larger.
    private struct Spacing {
        var top: CGFloat
        var bottom: CGFloat
        /// Room of its own under it (a heading's line), on top of the space between.
        var below: CGFloat = 0
    }

    /// One block of prose, before it's put in with the others.
    private struct Block {
        var text: NSMutableAttributedString
        var paragraph: NSMutableParagraphStyle
        var spacing: Spacing
        /// The table it's a cell of.
        var table: Int?
        /// The outermost list it's in: inside one, every block is a quarter line apart.
        var list: Int?
    }

    /// What's known while a document is put together.
    private final class Context {
        var tables: [Int: NSTextTable] = [:]
        var itemsSeen: Set<Int> = []
        var images: URL?
        /// Each table's columns, as wide as their widest cell on one line.
        var columnWidths: [Int: [Int: CGFloat]] = [:]
        var cells: [Int: [(column: Int, block: NSTextTableBlock)]] = [:]

        /// Tables as wide as their cells need, up to the room there is (Textual's are).
        func sizeTables() {
            for (identity, table) in tables {
                let columns = columnWidths[identity] ?? [:]
                // Each column as wide as its widest cell, unless the table is wider than the room.
                for cell in cells[identity] ?? [] {
                    cell.block.setValue(ceil(columns[cell.column] ?? 0) + 1, type: .absoluteValueType, for: .width)
                }
                table.setValue(100, type: .percentageValueType, for: .maximumWidth)
            }
        }

        func table(_ identity: Int, columns: Int) -> NSTextTable {
            if let table = tables[identity] { return table }
            let table = NSTextTable()
            table.numberOfColumns = max(columns, 1)
            table.collapsesBorders = true
            table.hidesEmptyCells = false
            table.layoutAlgorithm = .automaticLayoutAlgorithm
            table.setWidth(1, type: .absoluteValueType, for: .border)
            table.setBorderColor(Colors.border)
            tables[identity] = table
            return table
        }
    }

    /// `images`: the folder a file's own pictures are looked for in (a Markdown file's); none from
    /// the web (a README's badges and tracking pixels would reach their hosts as it opens).
    /// `diagrams`: ` ```mermaid ` blocks are drawn as diagrams (a file's preview), not shown as code.
    init(markdown: String, parser: some MarkupParser, style: Style, images: URL? = nil, diagrams: Bool = false) {
        let parsed = (try? parser.attributedString(for: markdown)) ?? AttributedString(markdown)
        let findsMarks = (parser as? FileLinkingParser).map { $0.highlight != nil } ?? false
        let context = Context()
        context.images = images
        var text = NSMutableAttributedString()
        // Each paragraph's style and where it is, set once the space after each is known.
        var styles: [(range: NSRange, paragraph: NSMutableParagraphStyle)] = []
        var textGap: CGFloat = 0
        var last: (spacing: Spacing, paragraph: NSMutableParagraphStyle?, table: Int?, list: Int?)?

        func flushText() {
            guard text.length > 0 else { return }
            for style in styles { text.addAttribute(.paragraphStyle, value: style.paragraph.copy(), range: style.range) }
            styles = []
            segments.append(.text(text))
            gaps.append(segments.count == 1 ? 0 : textGap)
            text = NSMutableAttributedString()
        }

        for (intent, range) in parsed.runs[\.presentationIntent] {
            let content = parsed[range]
            let components = intent?.components ?? []
            // A code block: a view of its own.
            if let language = Self.codeLanguage(components) {
                let gap = last.map { $0.spacing.bottom + $0.spacing.below } ?? 0
                flushText()
                var code = String(content.characters)
                if code.hasSuffix("\n") { code.removeLast() }
                if language == MathText.blockLanguage || language?.lowercased() == "math" {
                    segments.append(.math(latex: code.trimmingCharacters(in: .whitespacesAndNewlines)))
                } else if diagrams, language?.lowercased() == "mermaid" {
                    segments.append(.diagram(source: code))
                } else {
                    // Find's marks only while Find has some: looking through every run of a
                    // code block for them was a good part of reading one.
                    segments.append(.code(code: code, language: language, marks: findsMarks ? Self.marks(in: content) : []))
                }
                gaps.append(segments.count == 1 ? 0 : gap)
                last = (Spacing(top: 0, bottom: 16), nil, nil, nil)
                continue
            }
            let block = Self.block(content, components: components, style: style, context: context)
            let gap: CGFloat = {
                guard let last else { return 0 }
                if block.table != nil, block.table == last.table { return 0 }
                if block.list != nil, block.list == last.list { return style.size * 0.25 }
                // Out of a list: the list's own space below it; into one, none above it.
                let bottom = last.list != nil ? 16 : last.spacing.bottom
                let top = block.list != nil ? 0 : block.spacing.top
                return max(bottom, top) + last.spacing.below
            }()
            if text.length > 0 {
                // The space goes after the paragraph before (inside a table cell, it'd be inside
                // the cell: then before this one instead, which isn't in that table).
                if let previous = last?.paragraph, last?.table == nil {
                    // TextKit leaves a paragraph's line spacing under its last line too.
                    previous.paragraphSpacing = max(0, gap - previous.lineSpacing)
                } else if block.table == nil {
                    block.paragraph.paragraphSpacingBefore = gap
                }
                text.append(NSAttributedString(string: "\n", attributes: Self.separatorAttributes(of: text)))
                if let lastStyle = styles.indices.last { styles[lastStyle].range.length += 1 }
            } else {
                textGap = gap
            }
            if segments.isEmpty, text.length == 0 { leadingTop = block.spacing.top }
            styles.append((NSRange(location: text.length, length: block.text.length), block.paragraph))
            text.append(block.text)
            last = (block.spacing, block.paragraph, block.table, block.list)
        }
        context.sizeTables()
        flushText()
        if let last { trailing = last.list != nil ? Spacing(top: 0, bottom: 16, below: last.spacing.below) : last.spacing }
    }

    /// Whether a list item's first paragraph is a task's: "[ ] ", "[x] " or "[X] " ahead of its
    /// words. Done or not, or nil for a plain item.
    private static func task(_ content: AttributedSubstring) -> Bool? {
        let start = String(content.characters.prefix(4))
        switch start {
        case "[ ] ": return false
        case "[x] ", "[X] ": return true
        default: return nil
        }
    }

    /// Find's marks in a code block, where they are in its code.
    private static func marks(in content: AttributedSubstring) -> [ReplyCodeMark] {
        var marks: [ReplyCodeMark] = []
        var offset = 0
        for run in content.runs {
            let length = content[run.range].characters.reduce(0) { $0 + $1.utf16.count }
            if let background = run.swiftUI.backgroundColor {
                marks.append(ReplyCodeMark(range: NSRange(location: offset, length: length), background: NSColor(background), foreground: run.swiftUI.foregroundColor.map { NSColor($0) }))
            }
            offset += length
        }
        return marks
    }

    private static func codeLanguage(_ components: [PresentationIntent.IntentType]) -> String?? {
        for component in components {
            if case .codeBlock(let language) = component.kind { return .some(language) }
        }
        return nil
    }

    /// The line break that ends a paragraph: as its last character is, without what's drawn.
    private static func separatorAttributes(of text: NSAttributedString) -> [NSAttributedString.Key: Any] {
        var attributes = text.attributes(at: text.length - 1, effectiveRange: nil)
        for key in [NSAttributedString.Key.attachment, .link, .backgroundColor, .replyInlineCode] { attributes[key] = nil }
        return attributes
    }

    // MARK: Blocks

    private static func block(_ content: AttributedSubstring, components: [PresentationIntent.IntentType], style: Style, context: Context) -> Block {
        let size = style.size
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = size * 0.25
        var weight = NSFont.Weight.regular
        var fontSize = size
        var color = Colors.primary
        var spacing = Spacing(top: 0, bottom: 16)
        var marker: NSAttributedString?
        var indent: CGFloat = 0
        var quoteDepth = 0
        var rule: ReplyRule?
        var table: Int?
        /// A task's "[ ] " or "[x] ", left out of its words (a box shows it).
        var dropped = 0
        let list = components.last { component in
            switch component.kind {
            case .orderedList, .unorderedList: true
            default: false
            }
        }?.identity

        // Outermost first: lists and quotes indent what's inside them.
        let outward = Array(components.reversed())
        var listDepth = 0
        for (index, component) in outward.enumerated() {
            switch component.kind {
            case .blockQuote:
                quoteDepth += 1
                indent += size * 1.2
                color = Colors.secondary
            case .orderedList, .unorderedList:
                listDepth += 1
            case .listItem(let ordinal):
                let markerRight = indent + size * 1.5
                indent += size * 2
                // Its marker on its first paragraph only.
                guard context.itemsSeen.insert(component.identity).inserted else { break }
                let isOrdered: Bool = {
                    if index > 0, case .orderedList = outward[index - 1].kind { return true }
                    return false
                }()
                let plainIndent = String(repeating: "  ", count: listDepth - 1)
                if isOrdered {
                    marker = NSAttributedString(string: "\t\(ordinal).\t", attributes: [
                        .font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular), .foregroundColor: color,
                        .replyPlainText: plainIndent + "\(ordinal). ",
                    ])
                } else if let done = Self.task(content) {
                    // A task: a box, ticked when it's done, in the bullet's place.
                    dropped = 4
                    let box = NSMutableAttributedString(string: "\t", attributes: [.font: style.body])
                    box.append(ReplyAttachments.taskBox(done: done, size: size, font: style.body))
                    box.append(NSAttributedString(string: "\t", attributes: [.font: style.body]))
                    box.addAttribute(.replyPlainText, value: plainIndent + (done ? "- [x] " : "- [ ] "), range: NSRange(location: 0, length: box.length))
                    marker = box
                } else {
                    let bullet = NSMutableAttributedString(string: "\t", attributes: [.font: style.body])
                    bullet.append(ReplyAttachments.bullet(level: listDepth - 1, size: size, font: style.body))
                    bullet.append(NSAttributedString(string: "\t", attributes: [.font: style.body]))
                    bullet.addAttribute(.replyPlainText, value: plainIndent + "- ", range: NSRange(location: 0, length: bullet.length))
                    marker = bullet
                }
                paragraph.tabStops = [NSTextTab(textAlignment: .right, location: markerRight), NSTextTab(textAlignment: .left, location: indent)]
            case .header(let level):
                let scale = [2, 1.5, 1.25, 1, 0.875, 0.85][min(max(level, 1), 6) - 1]
                fontSize = size * scale
                weight = .semibold
                paragraph.lineSpacing = fontSize * 0.125
                spacing = Spacing(top: 24, bottom: 16)
                if level == 6 { color = Colors.tertiary }
                if level <= 2 {
                    rule = .underline(gap: size * 0.3)
                    // Room for the line.
                    spacing.below = size * 0.3 + 1
                }
            case .thematicBreak:
                rule = .line(height: size * 0.25)
                spacing = Spacing(top: 24, bottom: 24)
            case .tableCell(let column):
                let row = outward.lazy.compactMap { component -> Int? in
                    switch component.kind {
                    case .tableHeaderRow: 0
                    case .tableRow(let index): index
                    default: nil
                    }
                }.first ?? 0
                guard let tableComponent = outward.first(where: { if case .table = $0.kind { true } else { false } }),
                      case .table(let columns) = tableComponent.kind else { break }
                table = tableComponent.identity
                let cell = NSTextTableBlock(table: context.table(tableComponent.identity, columns: columns.count), startingRow: row, rowSpan: 1, startingColumn: column, columnSpan: 1)
                cell.setWidth(1, type: .absoluteValueType, for: .border)
                cell.setBorderColor(Colors.border)
                cell.setWidth(6, type: .absoluteValueType, for: .padding, edge: .minY)
                // Less the line spacing TextKit leaves under the last line.
                cell.setWidth(max(0, 6 - size * 0.25), type: .absoluteValueType, for: .padding, edge: .maxY)
                cell.setWidth(13, type: .absoluteValueType, for: .padding, edge: .minX)
                cell.setWidth(13, type: .absoluteValueType, for: .padding, edge: .maxX)
                if row > 0, row % 2 == 0 { cell.backgroundColor = Colors.secondaryBackground }
                paragraph.textBlocks = [cell]
                context.cells[tableComponent.identity, default: []].append((column, cell))
                if row == 0 { weight = .semibold }
                spacing = Spacing(top: 0, bottom: 16)
            default:
                break
            }
        }
        paragraph.firstLineHeadIndent = marker == nil ? indent : 0
        paragraph.headIndent = indent

        let text = NSMutableAttributedString()
        if let marker { text.append(marker) }
        var toDrop = dropped
        for run in content.runs {
            var runRange = run.range
            if toDrop > 0 {
                let available = content[runRange].characters.count
                let skip = min(toDrop, available)
                runRange = content.characters.index(runRange.lowerBound, offsetBy: skip)..<runRange.upperBound
                toDrop -= skip
                if runRange.isEmpty { continue }
            }
            let inline = run.inlinePresentationIntent ?? []
            let isCode = inline.contains(.code)
            let runWeight: NSFont.Weight = inline.contains(.stronglyEmphasized) ? .semibold : weight
            let font = isCode
                ? NSFont.monospacedSystemFont(ofSize: fontSize * 0.85, weight: runWeight)
                : Style.font(fontSize, weight: runWeight, design: style.design, italic: inline.contains(.emphasized))
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            if isCode { attributes[.replyInlineCode] = true }
            if inline.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let url = run.link {
                attributes[.link] = url
                attributes[.foregroundColor] = Colors.link
            }
            // Find's marks.
            if let background = run.swiftUI.backgroundColor { attributes[.backgroundColor] = NSColor(background) }
            if let foreground = run.swiftUI.foregroundColor { attributes[.foregroundColor] = NSColor(foreground) }
            // A picture of the file's own, if there's a folder to find it in; its words otherwise.
            if let source = run.imageURL, let folder = context.images,
               let picture = ReplyAttachments.picture(source, in: folder, attributes: attributes) {
                text.append(picture)
                continue
            }
            if let attachment = run.textual.attachment {
                text.append(ReplyAttachments.attachment(for: attachment, attributes: attributes, size: fontSize, dark: style.dark))
                continue
            }
            // A line break inside a paragraph, not a new paragraph.
            let string = String(content[runRange].characters).replacingOccurrences(of: "\n", with: "\u{2028}")
            text.append(NSAttributedString(string: string, attributes: attributes))
        }
        if let table, case .tableCell(let column)? = components.first(where: { if case .tableCell = $0.kind { true } else { false } })?.kind {
            let width = text.size().width
            context.columnWidths[table, default: [:]][column] = max(context.columnWidths[table]?[column] ?? 0, width)
        }
        if case .line = rule {
            text.setAttributedString(NSAttributedString(string: "\u{200B}", attributes: [.font: NSFont.systemFont(ofSize: 1)]))
        }
        let whole = NSRange(location: 0, length: text.length)
        if quoteDepth > 0 { text.addAttribute(.replyQuote, value: quoteDepth, range: whole) }
        if let rule { text.addAttribute(.replyRule, value: rule, range: whole) }
        return Block(text: text, paragraph: paragraph, spacing: spacing, table: table, list: list)
    }
}

/// Find's mark on a code block's code.
struct ReplyCodeMark: Equatable {
    var range: NSRange
    var background: NSColor
    var foreground: NSColor?
}

/// A heading's line under it, or a line on its own (`---`).
nonisolated enum ReplyRule {
    case underline(gap: CGFloat)
    case line(height: CGFloat)
}

extension NSAttributedString.Key {
    /// Inline code, drawn on a rounded background.
    nonisolated static let replyInlineCode = NSAttributedString.Key("kuvo.reply.inlineCode")
    /// How many quotes it's in, drawn as a bar beside it.
    nonisolated static let replyQuote = NSAttributedString.Key("kuvo.reply.quote")
    /// A rule under a heading, or one on its own.
    nonisolated static let replyRule = NSAttributedString.Key("kuvo.reply.rule")
    /// What it is as plain text, copied (a list's marker, a picture in the text).
    nonisolated static let replyPlainText = NSAttributedString.Key("kuvo.reply.plainText")
}

/// Textual's attachments (a file's icon, a formula, a bot's face) as pictures in the text.
enum ReplyAttachments {
    private static var images: [String: NSImage] = [:]

    /// A picture a Markdown file shows (`![…](images/shot.png)`), from its folder, as wide as it
    /// is up to a reply's width; nil for one from the web or that isn't there.
    static func picture(_ source: URL, in folder: URL, attributes: [NSAttributedString.Key: Any]) -> NSAttributedString? {
        let url: URL
        if source.isFileURL {
            url = source
        } else if source.scheme == nil {
            url = URL(filePath: source.path(percentEncoded: false), relativeTo: folder).standardizedFileURL
        } else {
            return nil
        }
        guard let image = NSImage(contentsOf: url), image.size.width > 0 else { return nil }
        let item = NSTextAttachment()
        item.image = image
        let width = min(image.size.width, 640)
        item.bounds = CGRect(x: 0, y: 0, width: width, height: image.size.height * width / image.size.width)
        let text = NSMutableAttributedString(attachment: item)
        text.addAttributes(attributes.filter { $0.key == .paragraphStyle || $0.key == .link }, range: NSRange(location: 0, length: text.length))
        return text
    }

    /// A file's icon, the symbol filling its slot in the text as Textual draws it, in the accent.
    private static func fileIcon(_ size: CGSize) -> NSImage {
        let key = "file-icon|\(size.width)x\(size.height)"
        if let known = images[key] { return known }
        let symbol = NSImage(systemSymbolName: "doc", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: size.height * 2, weight: .light))
        let image = NSImage(size: size, flipped: false) { rect in
            guard let symbol else { return false }
            // The symbol's glyph fills the slot, not the room around it.
            let glyph = inkBounds(of: symbol)
            let scale = min(rect.width / max(glyph.width, 1), rect.height / max(glyph.height, 1))
            let drawn = CGRect(x: rect.midX - glyph.midX * scale, y: rect.midY - glyph.midY * scale, width: symbol.size.width * scale, height: symbol.size.height * scale)
            let tinted = NSImage(size: symbol.size, flipped: false) { inner in
                symbol.draw(in: inner)
                NSColor.controlAccentColor.set()
                inner.fill(using: .sourceAtop)
                return true
            }
            tinted.draw(in: drawn)
            return true
        }
        images[key] = image
        return image
    }

    /// Where an image has ink, in its own points (bottom-left origin).
    private static func inkBounds(of image: NSImage) -> CGRect {
        let scale: CGFloat = 4
        let width = Int(image.size.width * scale), height = Int(image.size.height * scale)
        guard width > 0, height > 0, let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return CGRect(origin: .zero, size: image.size) }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let data = context.data?.assumingMemoryBound(to: UInt8.self) else { return CGRect(origin: .zero, size: image.size) }
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where data[(y * width + x) * 4 + 3] > 8 {
                minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= minX else { return CGRect(origin: .zero, size: image.size) }
        // Rows from the top in memory: flipped to the image's bottom-left origin.
        return CGRect(x: CGFloat(minX) / scale, y: CGFloat(height - 1 - maxY) / scale, width: CGFloat(maxX - minX + 1) / scale, height: CGFloat(maxY - minY + 1) / scale)
    }

    /// A task's box, ticked when it's done: 0.85 of the text's size, secondary, on the middle of
    /// the first line, as Textual draws it.
    static func taskBox(done: Bool, size: CGFloat, font: NSFont) -> NSAttributedString {
        let item = NSTextAttachment()
        let image = NSImage(systemSymbolName: done ? "checkmark.square" : "square", accessibilityDescription: done ? "Done" : "Not done")?
            .withSymbolConfiguration(.init(pointSize: size * 0.85, weight: .regular).applying(.init(paletteColors: [NSColor.labelColor.withAlphaComponent(0.7)])))
        item.image = image
        let side = image?.size ?? CGSize(width: size * 0.85, height: size * 0.85)
        item.bounds = CGRect(x: 0, y: (font.capHeight - side.height) / 2, width: side.width, height: side.height)
        return NSAttributedString(attachment: item)
    }

    /// A list's bullet, as Textual's: a dot, a ring, a square, by how deep the list is; a third
    /// of the text's size, on the middle of its first line.
    static func bullet(level: Int, size: CGFloat, font: NSFont) -> NSAttributedString {
        let name = ["circle.fill", "circle", "square.fill"][level % 3]
        let item = NSTextAttachment()
        let side = (size * 0.33).rounded()
        item.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: side, weight: .regular).applying(.init(paletteColors: [.labelColor])))
        item.bounds = CGRect(x: 0, y: (font.xHeight - side) / 2 + font.xHeight * 0.1, width: side, height: side)
        return NSAttributedString(attachment: item)
    }

    static func attachment(for attachment: AnyAttachment, attributes: [NSAttributedString.Key: Any], size: CGFloat, dark: Bool) -> NSAttributedString {
        let item = NSTextAttachment()
        // Sized and set on the line as Textual sets it, by its own measures at the text's size.
        let environment = TextEnvironmentValues(font: .system(size: size))
        let bounds = attachment.sizeThatFits(.unspecified, in: environment)
        let offset = attachment.baselineOffset(in: environment)
        if attachment.base is FileIconAttachment {
            item.image = fileIcon(bounds)
        } else {
            let key = "\(attachment.hashValue)|\(bounds.width)x\(bounds.height)|\(dark)"
            item.image = images[key] ?? {
                // Drawn at its own size, which can be larger than it shows (a formula is), and
                // scaled into its place in the text.
                let ink = dark ? Color(white: 1, opacity: 0.85) : Color(white: 0, opacity: 0.85)
                let renderer = ImageRenderer(content: attachment.body.foregroundStyle(ink).environment(\.colorScheme, dark ? .dark : .light))
                renderer.scale = 2 * max(1, (NSScreen.main?.backingScaleFactor ?? 2) / 2)
                let image = renderer.nsImage ?? NSImage()
                images[key] = image
                return image
            }()
        }
        item.bounds = CGRect(x: 0, y: offset, width: bounds.width, height: bounds.height)
        let text = NSMutableAttributedString(attachment: item)
        var kept = attributes.filter { $0.key != .backgroundColor && $0.key != .replyInlineCode }
        kept[.replyPlainText] = attachment.description
        text.addAttributes(kept, range: NSRange(location: 0, length: text.length))
        return text
    }
}

#if DEBUG
/// KUVO_PERF_PARTS_CHECK=<file>: each long piece read in parts compared with it read whole, and
/// where they differ written down.
enum PartsCheck {
    private static let file = ProcessInfo.processInfo.environment["KUVO_PERF_PARTS_CHECK"]
    /// Only then: reading each piece whole as well would hide what reading it in parts saves.
    static var isOn: Bool { file != nil }
    private static var compared = 0
    private static var problems: [String] = []

    static func compare(_ parts: ReplyDocument, _ whole: ReplyDocument, markdown: String) {
        guard let file else { return }
        compared += 1
        func describe(_ document: ReplyDocument) -> [String] {
            zip(document.segments, document.gaps).map { segment, gap in
                switch segment {
                case .text(let text):
                    var paragraphs: [String] = []
                    text.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: text.length)) { value, range, _ in
                        let style = value as? NSParagraphStyle
                        paragraphs.append("\(range.location)+\(range.length) \(style?.paragraphSpacing ?? -1)/\(style?.paragraphSpacingBefore ?? -1)/\(style?.lineSpacing ?? -1)/\(style?.headIndent ?? -1)")
                    }
                    var fonts: [String] = []
                    text.enumerateAttribute(.font, in: NSRange(location: 0, length: text.length)) { value, range, _ in
                        fonts.append("\(range.location)+\(range.length) \((value as? NSFont)?.pointSize ?? 0)")
                    }
                    return "text gap \(gap): \(text.string.debugDescription) | \(paragraphs.joined(separator: ", ")) | \(fonts.joined(separator: ", "))"
                case .code(let code, let language, _): return "code gap \(gap) \(language ?? "-"): \(code.count)"
                case .math(let latex): return "math gap \(gap): \(latex)"
                case .diagram(let source): return "diagram gap \(gap): \(source.count)"
                }
            }
        }
        let a = describe(parts), b = describe(whole)
        if a != b {
            let index = (0..<min(a.count, b.count)).first { a[$0] != b[$0] } ?? min(a.count, b.count)
            problems.append("piece of \(markdown.count) characters, segment \(index):\n  parts: \(index < a.count ? String(a[index].prefix(1500)) : "none")\n  whole: \(index < b.count ? String(b[index].prefix(1500)) : "none")")
        }
        let out = "\(compared) compared, \(problems.count) different\n" + problems.prefix(8).joined(separator: "\n\n")
        try? out.write(toFile: file, atomically: true, encoding: .utf8)
    }
}
#endif
