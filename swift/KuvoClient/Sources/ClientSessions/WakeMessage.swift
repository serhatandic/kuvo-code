import Foundation
import OpenCodeKit

/// A wake-up's message in its conversation ("[Wake-up] " and its note, or a watch's note and what it
/// saw): the agent reads it whole, and both apps show it as a card that reads `summary`, at most two
/// lines, and opens to the whole note. The summary is the one its agent gave it, as the box marks
/// the message (`metadata.kuvo.wake.summary`, PROTOCOL.md "Wake-ups"); without one (one from before,
/// or none given), the note's first sentence.
public struct WakeMessage: Equatable, Sendable {
    /// The note whole, as the agent read it.
    public let note: String
    /// What its card shows while it's folded.
    public let summary: String

    /// Whether its card folds to its summary and opens to the note: there's more to the note, or it's
    /// one that two lines on a phone may not hold. One that doesn't fold shows whole.
    public var folds: Bool {
        let whole = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return summary != whole || whole.count > Self.short
    }
    /// The most a note shown whole, on its own, has.
    static let short = 60

    public init(note: String, summary: String) {
        self.note = note
        self.summary = summary
    }

    /// The wake-up `user` is, or nil for any other message.
    public static func of(_ user: Message.User) -> WakeMessage? {
        of(text: user.text, metadata: user.metadata)
    }

    /// The wake-up a message with `text` and `metadata` is, or nil for any other.
    public static func of(text: String, metadata: JSONValue?) -> WakeMessage? {
        guard text.hasPrefix(Wakes.marker) else { return nil }
        let note = String(text.dropFirst(Wakes.marker.count))
        let given = (metadata?["kuvo"]?["wake"]?["summary"]?.string ?? "")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return WakeMessage(note: note, summary: given.isEmpty ? firstSentence(of: note) : given)
    }

    /// The first sentence of `note`'s first line (Markdown's marks out of it, but not underscores,
    /// which names and addresses have), or that line whole when it has no sentence's end.
    public static func firstSentence(of note: String) -> String {
        let line = note.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        let plain = line.replacingOccurrences(of: #"[*`]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^[\s#>-]+"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        // A sentence ends at . ! ? or … with a space or the line's end after it: not in 1.2 or a site's name.
        guard let end = plain.range(of: #"[.!?…](?=\s|$)"#, options: .regularExpression) else { return plain }
        return String(plain[..<end.upperBound])
    }
}
