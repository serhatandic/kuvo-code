import Foundation

/// What a widget sends with `kuvo.send`, as your message: its words, then a block naming the
/// widget, so the agent knows which of its widgets you answered, and your bubble shows it. The
/// phone writes the same (kuvo-code-ios's SentMessage.swift).
nonisolated enum WidgetAnswer {
    static let heading = "The user sent this from a widget shown in this conversation (show_widget), titled:"
    private static let block = MessageBlock(start: "<from-widget>", end: "</from-widget>", headings: [heading])

    /// `text` from the widget titled `title`, as it's sent.
    static func message(_ text: String, from title: String?) -> String {
        // One line, and naming no agents: an "&" in it would read as one named.
        let name = (title ?? "").split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "&", with: "＆")
        return [text, "", block.start, heading, name, block.end].joined(separator: "\n")
    }

    /// A message's words without the block, and the title of the widget it came from (empty for
    /// one without a title); nil for a message that didn't.
    static func split(_ text: String) -> (text: String, widget: String?) {
        guard let (before, lines) = block.split(text) else { return (text, nil) }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), lines.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespaces))
    }

    /// What a widget is called, in its caption and in the chip over what it sent: its title, or
    /// words of our own.
    static func name(_ title: String?) -> String {
        title.flatMap { $0.isEmpty ? nil : $0 } ?? "Made for you"
    }
}
