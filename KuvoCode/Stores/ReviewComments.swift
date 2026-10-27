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
