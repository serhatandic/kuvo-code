import Foundation

/// What a keyword sends as your message (/plan's words, /loop's when it sends now): its words,
/// then a block with the keyword as you typed it, so the agent knows how it came, and your bubble
/// draws the keyword as a token, as the composer did, wherever the conversation is read. The phone
/// writes and reads the same (kuvo-code-ios's SentMessage.swift).
nonisolated enum SentWithKeyword {
    static let heading = "The user sent this with a keyword, which Kuvo Code ran as they typed it:"
    private static let block = MessageBlock(start: "<sent-with>", end: "</sent-with>", headings: [heading])

    /// `text` sent with `typed` ("/plan", "/loop every hour").
    static func message(_ text: String, typed: String) -> String {
        // One line, and naming no agents: an "&" in it would read as one named.
        let typed = typed.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "&", with: "＆")
        return [text, "", block.start, heading, typed, block.end].joined(separator: "\n")
    }

    /// The message as you wrote it, the keyword first ("/loop every hour check CI"), and how many
    /// characters the keyword is; a message sent without one as it is, and nil.
    static func split(_ text: String) -> (text: String, keyword: Int?) {
        guard let (before, lines) = block.split(text), let typed = lines.dropFirst().first.map(String.init), typed.hasPrefix("/") else { return (text, nil) }
        let words = before.trimmingCharacters(in: .whitespacesAndNewlines)
        return (words.isEmpty ? typed : typed + " " + words, typed.count)
    }
}
