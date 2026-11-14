import Foundation

// What's left to clients of the blocks at a message's end. A conversation's box writes what the
// agent reads from a message's fields, and keeps its parts (PROTOCOL.md, "A message's parts",
// KuvoClient's `MessageParts`); a group chat's message still carries the widget it answers this way.

/// A block a client adds to the end of a group chat's message for its bots (the widget it answers):
/// its tag on a line of its own, its heading, what's in it, then its closing tag, with nothing
/// after. Only a block like that is read back, so a message can name the tags, or quote one, and
/// keep its words.
struct MessageBlock: Sendable {
    init(start: String, end: String, headings: Set<String>) {
        self.start = start
        self.end = end
        self.headings = headings
    }

    let start: String
    let end: String
    /// What its first line can be.
    let headings: Set<String>

    /// The block that ends `text`: the words before it, and its lines from its heading on.
    func split(_ text: String) -> (before: Substring, lines: [Substring])? {
        guard let found = find(in: text) else { return nil }
        return (text[..<found.open.lowerBound], found.lines)
    }

    /// `text` as it can't be read as ending with a block (one copied from a message, say): its
    /// tag gets a space after it.
    func escaping(_ text: String) -> String {
        var text = text
        while let found = find(in: text) { text.insert(" ", at: text.index(found.open.lowerBound, offsetBy: start.count)) }
        return text
    }

    private func find(in text: String) -> (open: Range<String.Index>, lines: [Substring])? {
        let body = text[..<(text.lastIndex { !$0.isWhitespace && !$0.isNewline }.map(text.index(after:)) ?? text.startIndex)]
        guard body.hasSuffix("\n" + end) else { return nil }
        let close = body.index(body.endIndex, offsetBy: -end.count)
        var before = close
        // The last tag with its heading after it: one in what's before the block is the message's.
        while let open = text.range(of: start + "\n", options: .backwards, range: text.startIndex..<before) {
            before = open.lowerBound
            guard open.lowerBound == text.startIndex || text[text.index(before: open.lowerBound)] == "\n" else { continue }
            let lines = text[open.upperBound..<close].split(separator: "\n", omittingEmptySubsequences: false).dropLast()
            guard let first = lines.first, headings.contains(String(first)) else { continue }
            return (open, Array(lines))
        }
        return nil
    }
}

/// What goes back in the composer for words sent with a keyword (Undo, Edit, a branch, ↑): a goal
/// as one, "/goal" and its words, as sending it again asks for the goal again; another keyword's
/// words alone, as sending those again shouldn't switch to Plan or set another loop.
public enum SentWithKeyword {
    /// `words` sent with `keyword` (as typed: `MessageParts.keyword`), for the composer.
    public static func draft(_ words: String, keyword: String?) -> String {
        keyword == "/goal" ? "/goal " + words : words
    }
}

/// What a widget sends with `kuvo.send` in a group chat, as your message: its words, then a block
/// naming the widget, so its bots know which of their widgets you answered, and your bubble shows
/// it. (A conversation's box writes this itself from the message's `widget`.)
public enum WidgetAnswer {
    public static let heading = "The user sent this from a widget shown in this conversation (show_widget), titled:"
    private static let block = MessageBlock(start: "<from-widget>", end: "</from-widget>", headings: [heading])

    /// `text` from the widget titled `title`, as it's sent.
    public static func message(_ text: String, from title: String?) -> String {
        // One line, and naming no agents: an "&" in it would read as one named.
        let name = (title ?? "").split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "&", with: "＆")
        return [text, "", block.start, heading, name, block.end].joined(separator: "\n")
    }

    /// A message's words without the block, and the title of the widget it came from (empty for
    /// one without a title); nil for a message that didn't.
    public static func split(_ text: String) -> (text: String, widget: String?) {
        guard let (before, lines) = block.split(text) else { return (text, nil) }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), lines.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespaces))
    }

    /// What a widget is called, to VoiceOver and in the chip over what it sent: its title, or
    /// words of our own.
    public static func name(_ title: String?) -> String {
        title.flatMap { $0.isEmpty ? nil : $0 } ?? "Made for you"
    }
}
