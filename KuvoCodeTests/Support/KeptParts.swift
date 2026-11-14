import ClientSessions
import Foundation
import OpenCodeKit

/// A message as its box keeps it, for a test's conversation: the text the agent read (its blocks
/// left out here: what clients draw is its parts) and its parts (`metadata.kuvo.parts`, PROTOCOL.md
/// "A message's parts").
enum KeptParts {
    /// What the agent read of `words` sent with `keyword`.
    static func text(_ words: String) -> String { words + "\n\n<sent-with>…</sent-with>" }

    /// Its metadata, as JSON a stand-in engine answers with.
    static func json(words: String, keyword: String? = nil) -> [String: Any] {
        ["kuvo": ["parts": ["words": words].merging(keyword.map { ["keyword": $0] } ?? [:]) { $1 }]]
    }

    /// Its metadata, as a message keeps it.
    static func value(words: String, keyword: String? = nil) -> JSONValue? {
        MessageParts.keeping(MessageParts(words: words, keyword: keyword))
    }
}
