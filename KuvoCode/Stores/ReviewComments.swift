import ClientChanges
import ClientSessions
import Foundation

/// A comment on one line of the changes, kept until the next message carries it to the
/// agent (like Codex's local comments).
nonisolated struct ReviewComment: Identifiable, Hashable, Sendable, Codable {
    enum Side: String, Sendable, Codable { case new, old }

    var id = UUID()
    var file: String
    var line: Int
    /// A removed line is numbered on the old side.
    var side: Side
    /// The line as it reads, so the agent (and the transcript) can see what it's about.
    var snippet: String
    var text: String

    /// "Sources/App.swift:124", "notes.md:3 (removed)".
    var location: String { "\(file):\(line)" + (side == .old ? " (removed)" : "") }
}

nonisolated extension ReviewComment {
    /// Where the line numbered `number` on `side` in `before` (a file's lines as they showed) is in
    /// `after` (as they show now): followed through what the agent added and removed around it,
    /// so a comment stays with its line, not its place, and never moves onto another line that
    /// reads the same. nil when the line itself changed or went.
    static func line(side: Side, number: Int, from before: [DiffLine], to after: [DiffLine]) -> DiffLine? {
        func onSide(_ lines: [DiffLine]) -> [DiffLine] { lines.filter { ($0.kind == .removed ? Side.old : .new) == side } }
        let old = onSide(before), new = onSide(after)
        guard let at = old.firstIndex(where: { $0.number == number }) else { return nil }
        let difference = new.map(\.text).difference(from: old.map(\.text))
        var removed = Set<Int>(), inserted = Set<Int>()
        for change in difference {
            switch change {
            case .remove(let offset, _, _): removed.insert(offset)
            case .insert(let offset, _, _): inserted.insert(offset)
            }
        }
        // What's left of each side after the changes reads the same, in order: pair them up.
        guard !removed.contains(at) else { return nil }
        var index = 0
        for (offset, _) in new.enumerated() where !inserted.contains(offset) {
            while removed.contains(index) { index += 1 }
            if index == at { return new[offset] }
            index += 1
        }
        return nil
    }

    /// `comments` with each one's line number where its line is now: `before` and `after` are
    /// each file's lines as they showed and show now, by the path comments name it with. One whose
    /// line changed, or whose file isn't in both, stays as it was.
    static func following(_ comments: [ReviewComment], from before: [String: [DiffLine]], to after: [String: [DiffLine]]) -> [ReviewComment] {
        comments.map { comment in
            guard let old = before[comment.file], let new = after[comment.file],
                  let line = line(side: comment.side, number: comment.line, from: old, to: new),
                  line.text.trimmingCharacters(in: .whitespaces) == comment.snippet else { return comment }
            var comment = comment
            comment.line = line.number
            return comment
        }
    }
}

nonisolated extension ReviewComment {
    /// One sent with a message, as its box keeps it.
    init(_ sent: MessageParts.Comment) {
        self.init(file: sent.file, line: sent.line, side: sent.side == .old ? .old : .new, snippet: sent.snippet, text: sent.text)
    }

    /// As a message sends it (`MessageParts.Sending`).
    var sent: MessageParts.Comment {
        MessageParts.Comment(file: file, line: line, side: side == .old ? .old : .new, snippet: snippet, text: text)
    }
}
