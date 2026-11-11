import Foundation

// The blocks a client adds to the end of a message for the agent, and reads back for its bubble:
// the same in both apps (and as every box writes the phone's note, kuvo-link.js).

/// A block the app adds to the end of a message for the agent (the review comments, the note of
/// attached files): its tag on a line of its own, its heading, what's in it, then its closing
/// tag, with nothing after. Only a block like that is read back, so a message can name the tags,
/// or quote one, and keep its words.
public struct MessageBlock: Sendable {
    public init(start: String, end: String, headings: Set<String>) {
        self.start = start
        self.end = end
        self.headings = headings
    }

    public let start: String
    public let end: String
    /// What its first line can be.
    public let headings: Set<String>

    /// The block that ends `text`: the words before it, and its lines from its heading on.
    public func split(_ text: String) -> (before: Substring, lines: [Substring])? {
        guard let found = find(in: text) else { return nil }
        return (text[..<found.open.lowerBound], found.lines)
    }

    /// `text` as it can't be read as ending with a block (one copied from a message, say): its
    /// tag gets a space after it.
    public func escaping(_ text: String) -> String {
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

/// What a keyword sends as your message (/plan's words, /loop's when it sends now): its words,
/// then a block with the keyword as you typed it, so the agent knows how it came, and your bubble
/// draws the keyword as a token in front of them, as the composer did, wherever the conversation
/// is read. Taken back (Undo, Edit, a branch, the history), it's the words alone, so sent again
/// they don't set another loop; a goal's come back with /goal (`draft`).
public enum SentWithKeyword {
    public static let heading = "The user sent this with a Kuvo Code keyword, which Kuvo Code has already done (switched to Plan, or set the message to repeat), so there's nothing for you to do about it:"
    /// /goal in a bot's chat, as every box sends it (`askGoal` in the box's work/goals.ts, in these
    /// words): the bot is to plan it before any of the work.
    public static let goalHeading = "The user sent this as a goal, with Kuvo Code's /goal. Plan it, check what it needs, and put it to them with propose_goal before doing any of the work:"
    private static let block = MessageBlock(start: "<sent-with>", end: "</sent-with>", headings: [heading, goalHeading])
    // How a box sent /goal before it went in the block: its marker, the words, then this.
    private static let oldGoal = (marker: "[Goal] ", note: "\n\n(The user asked for this as a goal: plan it, check what it needs, and put it to them with propose_goal before doing any of the work.)")

    /// `text` sent with `typed` ("/plan", "/loop every hour").
    public static func message(_ text: String, typed: String) -> String {
        // One line, and naming no agents: an "&" in it would read as one named.
        let typed = typed.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "&", with: "＆")
        return [text, "", block.start, heading, typed, block.end].joined(separator: "\n")
    }

    /// What goes back in the composer for words sent with `keyword` (Undo, Edit, a branch, ↑): a
    /// goal as one, "/goal" and its words, as sending it again asks for the goal again; another
    /// keyword's words alone, as sending those again shouldn't switch to Plan or set another loop.
    public static func draft(_ words: String, keyword: String?) -> String {
        keyword == "/goal" ? "/goal " + words : words
    }

    /// A message's words without the block, and the keyword it was sent with as typed ("/loop
    /// every hour"); a message sent without one as it is, and nil.
    public static func split(_ text: String) -> (text: String, keyword: String?) {
        if text.hasPrefix(oldGoal.marker), text.hasSuffix(oldGoal.note) {
            return (String(text.dropFirst(oldGoal.marker.count).dropLast(oldGoal.note.count)).trimmingCharacters(in: .whitespacesAndNewlines), "/goal")
        }
        guard let (before, lines) = block.split(text), let typed = lines.dropFirst().first.map(String.init), typed.hasPrefix("/") else { return (text, nil) }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), typed)
    }
}

/// What a widget sends with `kuvo.send`, as your message: its words, then a block naming the
/// widget, so the agent knows which of its widgets you answered, and your bubble shows it.
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

/// The block a message from a phone ends with, for the agent: the user is on their iPhone, where
/// they read a reply on a small screen and can't open paths or the side panel, so a file is shown
/// with show_file. Every box adds it to what a phone sends (`kuvo-link.js`, in these words), this
/// Mac's too; it's never shown.
public enum FromPhone {
    public static let heading = "The user sent this from Kuvo Code on their iPhone."
    public static let advice = "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it. A widget (show_widget) shows there too: keep it narrow, and make it work with taps rather than hovering."
    private static let block = MessageBlock(start: "<from-phone>", end: "</from-phone>", headings: [heading])

    /// A message without the block, and whether it had it.
    public static func split(_ text: String) -> (text: String, isFromPhone: Bool) {
        guard let (before, _) = block.split(text) else { return (text, false) }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), true)
    }

    public static func isFromPhone(_ text: String) -> Bool { block.split(text) != nil }

    /// A message without the block.
    public static func removing(from text: String) -> String { split(text).text }
}

/// The note of attached files a Mac adds to the end of a message: where the files sent with it
/// are, those sent as paths for the agent to open, and those that stayed on the Mac. Read back the
/// same in both apps, for the files a message names.
public enum AttachedFilesNote {
    public static let includedHeading = "The attached files are on disk here (what's in them is in this message already):"
    public static let pathsHeading = "Open these attached files with your tools if you need them:"
    public static let unsentHeading = "These attached files stayed on the user's Mac (they couldn't be read, or copied to this machine):"
    public static let block = MessageBlock(start: "<attached-files>", end: "</attached-files>", headings: [includedHeading, pathsHeading, unsentHeading])
    /// How a file that stayed on the Mac used to be listed, on its path's line.
    public static let unsentSuffix = " (on the user's Mac: it couldn't be copied to this machine)"

    /// A message's text without the note that ends it, and the paths of the files it sent as
    /// paths or couldn't send (the others are the message's own files).
    public static func split(_ text: String) -> (text: String, paths: [String]) {
        guard let (before, lines) = block.split(text) else { return (text, []) }
        var heading = ""
        var paths: [String] = []
        for line in lines.map(String.init) {
            if block.headings.contains(line) {
                heading = line
            } else if line.hasPrefix("/"), heading != includedHeading {
                paths.append(line.hasSuffix(unsentSuffix) ? String(line.dropLast(unsentSuffix.count)) : line)
            }
        }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), paths)
    }
}
