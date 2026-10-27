import ClientDesign
import Foundation

/// A long reply in pieces of a few thousand characters, split between paragraphs, each drawn on its
/// own. While it streams in, only the last piece changes, so only it is read and laid out again
/// (Textual reads and lays out all of a text each time it changes, which takes longer the longer
/// the reply gets). Where it splits follows from the text alone, the same while it streams and
/// after.
nonisolated enum MarkdownChunks {
    struct Chunk: Equatable {
        /// Its Markdown, after the link definitions (`[1]: https://…`) its links use from the rest
        /// of the text: a piece is read on its own.
        var text: String
        /// The space above it, as the Markdown style puts between the blocks either side.
        var gap: CGFloat
        /// Where the language of a code block still being written is (it ends inside one).
        var writing: Range<String.Index>?
    }

    /// About how long a piece gets before the next one starts.
    #if DEBUG
    /// KUVO_PERF_PIECE: another size, to measure.
    static let size = ProcessInfo.processInfo.environment["KUVO_PERF_PIECE"].flatMap(Int.init) ?? 4000
    #else
    static let size = 4000
    #endif

    /// `text` in pieces, split only where a paragraph or heading starts after a paragraph,
    /// heading or code block has ended: blocks a split can't change (not inside a list, quote,
    /// table or code block), with the space between them known. `isWriting`: the text is still
    /// streaming in, so its last line, unfinished, isn't a link definition yet (one would change
    /// every piece that uses it with each letter).
    static func split(_ text: String, size: Int = size, isWriting: Bool = false) -> [Chunk] {
        var pieces: [(range: Range<String.Index>, gap: CGFloat)] = []
        var start = text.startIndex
        var gap: CGFloat = 0
        var length = 0
        var fence: Fence?
        var blank = true
        // The block since the last blank line is one a split can come after: paragraphs and
        // headings at the left edge, or a code block (a list's lines needn't be indented).
        var blockIsSafe = false
        // The language of the code block being read.
        var language: Range<String.Index>?
        // Link definitions, which count for all of the text, wherever they are: each label's
        // first, as Markdown takes the first.
        var definitions: [(label: String, range: Range<String.Index>)] = []
        var defined: Set<String> = []
        var afterDefinition = false
        var lineStart = text.startIndex
        while lineStart < text.endIndex {
            // Only whole lines: the last one may still be streaming in.
            guard let newline = text[lineStart...].firstIndex(of: "\n") else { break }
            let line = text[lineStart..<newline]
            var counts = true
            defer {
                if counts { length += line.utf8.count + 1 }
                lineStart = text.index(after: newline)
            }
            let trimmed = line.drop { $0 == " " }
            let indent = line.count - trimmed.count
            if let open = fence {
                // In its quote, and in its list item: indented as far, or blank.
                let (depth, indent, words) = quoted(line)
                if depth >= open.depth, words.isEmpty || indent >= open.column {
                    // Closed by the same marker, at least as long, less than a code block's
                    // indentation into its item.
                    if indent - open.column < 4, words.prefix(while: { $0 == open.marker }).count >= open.count,
                       words.drop(while: { $0 == open.marker }).allSatisfy(\.isWhitespace) {
                        fence = nil
                        language = nil
                        blockIsSafe = open.depth == 0 && open.column == 0
                    }
                    continue
                }
                // Its list item or quote ended, and the code with it.
                fence = nil
                language = nil
            }
            if trimmed.allSatisfy(\.isWhitespace) {
                blank = true
                continue
            }
            if blank, blockIsSafe, length >= size, startsSafely(trimmed, indent: indent) {
                pieces.append((start..<lineStart, gap))
                start = lineStart
                gap = trimmed.first == "#" ? 24 : 16
                length = 0
            }
            let startsBlock = blank
            blank = false
            // One starts a block or follows another (under a paragraph's line, it's part of it).
            let label = (startsBlock || afterDefinition) && indent < 4 ? definitionLabel(trimmed) : nil
            afterDefinition = label != nil
            if let label {
                if defined.insert(label).inserted { definitions.append((label, line.startIndex..<line.endIndex)) }
                // Not counted, as they go ahead of other pieces: a piece split again (a row's
                // words, drawn) splits where it did here.
                counts = false
            }
            if let opened = Self.fence(openedBy: line) {
                fence = opened
                language = opened.info..<opened.info
                blockIsSafe = false
                continue
            }
            let safe = indent == 0 && isParagraphOrHeading(trimmed)
            blockIsSafe = startsBlock ? safe : blockIsSafe && safe
        }
        // The last line can be one too, once it's written.
        if !isWriting, fence == nil, lineStart < text.endIndex, blank || afterDefinition {
            let line = text[lineStart...]
            let trimmed = line.drop { $0 == " " }
            if line.count - trimmed.count < 4, let label = definitionLabel(trimmed), defined.insert(label).inserted {
                definitions.append((label, line.startIndex..<line.endIndex))
            }
        }
        pieces.append((start..<text.endIndex, gap))
        return pieces.indices.map { index in
            let piece = pieces[index]
            // Those elsewhere in the text that its links use go ahead of it (Markdown shows
            // nothing for them): only those, so a piece changes only with what it shows.
            let used = definitions.isEmpty || pieces.count == 1 ? [] : labels(in: text[piece.range])
            let elsewhere = definitions.filter { used.contains($0.label) && !piece.range.contains($0.range.lowerBound) }
            let ahead = elsewhere.isEmpty ? "" : elsewhere.map { text[$0.range] }.joined(separator: "\n") + "\n\n"
            let own = pieces.count == 1 ? text : String(text[piece.range])
            var chunk = Chunk(text: ahead.isEmpty ? own : ahead + own, gap: piece.gap)
            if index == pieces.count - 1, fence != nil, let language {
                let offset = ahead.utf8.count + text.utf8.distance(from: piece.range.lowerBound, to: language.lowerBound)
                let at = chunk.text.utf8.index(chunk.text.utf8.startIndex, offsetBy: offset)
                chunk.writing = at..<at
            }
            return chunk
        }
    }

    /// The text of `chunk`, with `mark` before the language of the code block it's still writing:
    /// Textual colors code with a language again each time it changes (showing it plain
    /// meanwhile), so it waits until the block is done.
    static func text(of chunk: Chunk, marking mark: String) -> String {
        guard let writing = chunk.writing else { return chunk.text }
        return String(chunk.text[..<writing.lowerBound]) + mark + String(chunk.text[writing.lowerBound...])
    }

    /// A code block's fence, as far as splitting goes: its marks, how many, where its language
    /// is written, how many quotes it's in, and the column its lines are indented to in the list
    /// item it opened on (0 out of one): left of that, the item ends, and the code with it.
    struct Fence {
        var marker: Character
        var count: Int
        var info: String.Index
        var depth: Int
        var column: Int
    }

    /// The fence `line` opens, after any quote marks and list markers (`- ```sh`, `1. ~~~`,
    /// `> ```), as Markdown reads it.
    private static func fence(openedBy line: Substring) -> Fence? {
        let (depth, indent, words) = quoted(line)
        guard indent < 4 else { return nil }
        var rest = words
        var column = indent
        var inItem = false
        // Items on items ("- 1. ```").
        while let (width, spaces) = listMarker(rest) {
            column += width + spaces
            rest = rest.dropFirst(width + spaces)
            inItem = true
        }
        guard let marker = rest.first, marker == "`" || marker == "~" else { return nil }
        let count = rest.prefix { $0 == marker }.count
        guard count >= 3, !(marker == "`" && rest.dropFirst(count).contains("`")) else { return nil }
        let info = rest.dropFirst(count).drop { $0 == " " }
        return Fence(marker: marker, count: count, info: info.startIndex, depth: depth, column: inItem ? column : 0)
    }

    /// A line's quote marks, how far its words are indented after them, and its words.
    private static func quoted(_ line: Substring) -> (depth: Int, indent: Int, words: Substring) {
        var rest = line
        var depth = 0
        while true {
            let spaces = rest.prefix { $0 == " " }.count
            guard spaces < 4, rest.dropFirst(spaces).first == ">" else { break }
            rest = rest.dropFirst(spaces + 1)
            if rest.first == " " { rest = rest.dropFirst() }
            depth += 1
        }
        var indent = 0
        while let first = rest.first, first == " " || first == "\t" {
            indent = first == "\t" ? indent + 4 - indent % 4 : indent + 1
            rest = rest.dropFirst()
        }
        return (depth, indent, rest)
    }

    /// A list item's marker at the start of `words` (`-`, `*`, `+`, `1.` or `1)`), and the spaces
    /// after it before the item's words: none for a marker alone on its line.
    private static func listMarker(_ words: Substring) -> (width: Int, spaces: Int)? {
        guard let first = words.first else { return nil }
        var width = 0
        if "-*+".contains(first) {
            width = 1
        } else {
            let digits = words.prefix { $0.isASCII && $0.isNumber }.count
            guard (1...9).contains(digits), let mark = words.dropFirst(digits).first, mark == "." || mark == ")" else { return nil }
            width = digits + 1
        }
        let after = words.dropFirst(width)
        let spaces = after.prefix { $0 == " " }.count
        // Words right after the marker aren't an item, and five spaces or more start indented
        // code in it, not a fence.
        guard spaces >= 1, spaces <= 4 else { return nil }
        return (width, spaces)
    }

    /// A line that starts a paragraph, a heading or a code block, whatever comes after it.
    private static func startsSafely(_ line: Substring, indent: Int) -> Bool {
        guard indent == 0, let first = line.first else { return false }
        if first == "`" || first == "~" { return line.prefix { $0 == first }.count >= 3 }
        return isParagraphOrHeading(line)
    }

    /// The label of a link definition on one line, as `label(_:)` puts it: `[label]: destination`,
    /// and maybe a title in quotes or parentheses (not a footnote's, `[^1]: …`).
    private static func definitionLabel(_ line: Substring) -> String? {
        guard line.first == "[", let close = line.firstIndex(of: "]") else { return nil }
        let label = line[line.index(after: line.startIndex)..<close]
        guard label.first != "^", !label.contains("["), !label.allSatisfy(\.isWhitespace),
              line[line.index(after: close)...].first == ":" else { return nil }
        var rest = line[line.index(close, offsetBy: 2)...].drop { $0 == " " || $0 == "\t" }
        if rest.first == "<" {
            guard let end = rest.firstIndex(of: ">") else { return nil }
            rest = rest[rest.index(after: end)...]
        } else {
            let destination = rest.prefix { !$0.isWhitespace }
            guard !destination.isEmpty else { return nil }
            rest = rest[destination.endIndex...]
        }
        guard !rest.allSatisfy(\.isWhitespace) else { return self.label(label) }
        guard rest.first?.isWhitespace == true else { return nil }
        let title = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        guard title.count >= 2, let open = title.first, let end = title.last,
              open == "\"" && end == "\"" || open == "'" && end == "'" || open == "(" && end == ")" else { return nil }
        return self.label(label)
    }

    /// The labels `text` may link with: what's in each pair of brackets (`[text][label]`,
    /// `[label][]`, `[label]`), more than it uses, which is harmless.
    private static func labels(in text: Substring) -> Set<String> {
        var labels: Set<String> = []
        var open: String.Index?
        var index = text.startIndex
        while index < text.endIndex {
            switch text[index] {
            case "\\":
                index = text.index(after: index)
                if index == text.endIndex { return labels }
            case "[": open = text.index(after: index)
            case "]":
                if let start = open { labels.insert(label(text[start..<index])) }
                open = nil
            default: break
            }
            index = text.index(after: index)
        }
        return labels
    }

    /// A label as Markdown matches them: case and runs of spaces aside.
    private static func label(_ text: Substring) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }

    /// Not a list item, quote, table row, HTML, link definition or rule (or a heading's underline).
    private static func isParagraphOrHeading(_ line: Substring) -> Bool {
        guard let first = line.first else { return false }
        if first == "#" { return line.drop { $0 == "#" }.first.map { $0 == " " } ?? true }
        if [">", "|", "<", "[", "`", "~", "$"].contains(first) { return false }
        // A table's row, which needn't start with a pipe ("a | b"): one block with the rows after
        // it, the space after it in its last cell.
        if line.contains("|") { return false }
        if "-*+_=".contains(first) {
            // "- item", "* item", "+ item", or a rule or underline ("---", "***", "===").
            if line.dropFirst().first == " " || line.allSatisfy({ $0 == first || $0 == " " }) { return false }
        }
        // "1. item", "2) item".
        let digits = line.prefix(while: \.isNumber)
        if !digits.isEmpty, digits.count < 10, let after = line.dropFirst(digits.count).first, after == "." || after == ")" {
            return false
        }
        return true
    }
}
