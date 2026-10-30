import ClientChanges
import ClientText
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

/// The block a message carries its comments in. It reads well for the model, and the
/// transcript turns it back into cards.
nonisolated enum ReviewComments {
    private static let intro = "Comments on lines of the current changes:"
    private static let block = MessageBlock(start: "<review-comments>", end: "</review-comments>", headings: [intro])

    static func text(_ text: String, adding comments: [ReviewComment]) -> String {
        let text = block.escaping(text)
        guard !comments.isEmpty else { return text }
        var lines = [block.start, intro]
        for comment in comments {
            lines.append("")
            lines.append("[\(comment.location)]")
            lines.append("> " + comment.snippet)
            lines.append(comment.text)
        }
        lines.append(block.end)
        return (text.isEmpty ? "" : text + "\n\n") + lines.joined(separator: "\n")
    }

    /// The message without the block that ends it, and the comments in it.
    static func split(_ text: String) -> (text: String, comments: [ReviewComment]) {
        guard let (before, lines) = block.split(text) else { return (text, []) }
        var comments: [ReviewComment] = []
        var current: ReviewComment?
        for (index, raw) in lines.enumerated().dropFirst() {
            let line = String(raw)
            // A comment starts after a blank line, with its line of the changes under it; a line
            // like "[b.swift:10]" in what you wrote is part of it.
            if lines[index - 1].isEmpty, index + 1 < lines.count, lines[index + 1].hasPrefix("> "), let header = header(line) {
                if let current { comments.append(current) }
                current = ReviewComment(file: header.file, line: header.line, side: header.side, snippet: "", text: "")
            } else if var comment = current {
                if line.hasPrefix("> "), comment.snippet.isEmpty, comment.text.isEmpty {
                    comment.snippet = String(line.dropFirst(2))
                } else {
                    comment.text += (comment.text.isEmpty ? "" : "\n") + line
                }
                current = comment
            }
        }
        if let current { comments.append(current) }
        comments = comments.map { comment in
            var comment = comment
            comment.text = comment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return comment
        }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), comments)
    }

    /// "[path/to/file.swift:124]" or "[notes.md:3 (removed)]".
    private static func header(_ line: String) -> (file: String, line: Int, side: ReviewComment.Side)? {
        guard line.hasPrefix("["), line.hasSuffix("]") else { return nil }
        var body = String(line.dropFirst().dropLast())
        var side = ReviewComment.Side.new
        if body.hasSuffix(" (removed)") {
            body = String(body.dropLast(" (removed)".count))
            side = .old
        }
        guard let colon = body.lastIndex(of: ":"), let number = Int(body[body.index(after: colon)...]) else { return nil }
        return (String(body[..<colon]), number, side)
    }
}
