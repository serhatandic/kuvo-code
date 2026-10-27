import Foundation

/// What a keyword sends as your message (/plan's words, /loop's when it sends now): its words,
/// then a block with the keyword as you typed it, so the agent knows how it came, and your bubble
/// draws the keyword as a token in front of them, as the composer did, wherever the conversation
/// is read. Taken back (Undo, a draft, the history), it's the words alone: sent again, they don't
/// set another loop. The phone writes and reads the same (kuvo-code-ios's SentMessage.swift).
nonisolated enum SentWithKeyword {
    static let heading = "The user sent this with a Kuvo Code keyword, which Kuvo Code has already done (switched to Plan, or set the message to repeat), so there's nothing for you to do about it:"
    private static let block = MessageBlock(start: "<sent-with>", end: "</sent-with>", headings: [heading])

    /// `text` sent with `typed` ("/plan", "/loop every hour").
    static func message(_ text: String, typed: String) -> String {
        // One line, and naming no agents: an "&" in it would read as one named.
        let typed = typed.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "&", with: "＆")
        return [text, "", block.start, heading, typed, block.end].joined(separator: "\n")
    }

    /// A message's words without the block, and the keyword it was sent with as typed ("/loop
    /// every hour"); a message sent without one as it is, and nil.
    static func split(_ text: String) -> (text: String, keyword: String?) {
        guard let (before, lines) = block.split(text), let typed = lines.dropFirst().first.map(String.init), typed.hasPrefix("/") else { return (text, nil) }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), typed)
    }
}
