import Foundation
import OpenCodeKit

/// A message the box wrote to an agent in its conversation (a goal starting, its sessions' news,
/// your answer told late): the agent reads it whole, and both apps show `line` from `from` in its
/// place, a line of what happened rather than a bubble of yours. Every box marks one as it sends it
/// (`metadata.kuvo.note`, the box's `boxNote`); those sent before it did are read from how it
/// wrote them.
public struct BoxNote: Equatable, Sendable {
    /// Who it's from: "Goal", "Its sessions", "Your answer".
    public let from: String
    /// What happened, in a few words: "Goal started", "“Sign-in” finished".
    public let line: String

    /// The SF Symbol its line shows with: a goal's mark for a goal's, otherwise an info mark.
    public var symbol: String { from == "Goal" ? "scope" : "info.circle" }

    public init(from: String, line: String) {
        self.from = from
        self.line = line
    }

    /// The note `user` is, or nil for a message of yours.
    public static func of(_ user: Message.User) -> BoxNote? {
        of(text: user.text, metadata: user.metadata)
    }

    /// The note a message with `text` and `metadata` is (one waiting to go in, say).
    public static func of(text: String, metadata: JSONValue?) -> BoxNote? {
        if let note = metadata?["kuvo"]?["note"], let from = note["from"]?.string, let line = note["line"]?.string {
            return BoxNote(from: from, line: line)
        }
        return before(text)
    }

    // How a box wrote them before it marked them: each by the words it opened with.
    private static let goalLines: [(start: String, line: String)] = [
        ("[Goal started] The user approved the plan.", "Goal started"),
        ("[Not now] The user didn't start this goal.", "You said not now"),
        ("[Goal changed] The user changed the goal's limits.", "You changed the goal's limits"),
        ("[Goal's end] The end the user set has come.", "The goal's end came"),
        ("[Goal] Nothing of the goal is at work now.", "Reminded to carry on"),
        ("[Goal resumed] The user resumed the goal you paused.", "Goal resumed"),
    ]
    private static let answered = "[The user answered] "

    private static func before(_ text: String) -> BoxNote? {
        if let found = goalLines.first(where: { text.hasPrefix($0.start) }) { return BoxNote(from: "Goal", line: found.line) }
        if text.hasPrefix(answered) { return BoxNote(from: "Your answer", line: "You answered: \(text.dropFirst(answered.count))") }
        if let why = firstMatch(#"^\[Limit reset\] (.+?) has reset\. Carry on"#, in: text)?.first {
            return BoxNote(from: "Goal", line: "\(why.prefix(1).uppercased())\(why.dropFirst()) reset")
        }
        return sessionNews(text)
    }

    // Its sessions' news, as the box's `wakeLineShown` says it: one session's, or how many.
    private static func sessionNews(_ text: String) -> BoxNote? {
        let pattern = #"^\[Session (finished|failed|asks)\] "([^"\n]*)""#
        guard let first = firstMatch(pattern, in: text) else { return nil }
        let told = text.components(separatedBy: "\n\n").filter { firstMatch(pattern, in: $0) != nil }.count
        guard told == 1 else { return BoxNote(from: "Its sessions", line: "\(told) updates from its sessions") }
        let what = first[0] == "finished" ? "finished" : first[0] == "failed" ? "stopped with an error" : "asks something"
        return BoxNote(from: "Its sessions", line: "“\(first[1].isEmpty ? "New Session" : first[1])” \(what)")
    }

    private static func firstMatch(_ pattern: String, in text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let found = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<found.numberOfRanges).map { Range(found.range(at: $0), in: text).map { String(text[$0]) } ?? "" }
    }
}
