import Foundation

/// The block a message from a phone ends with, for the agent: the user is on their iPhone, where
/// they read a reply on a small screen and can't open paths or the side panel, so a file is shown
/// with show_file. Every box adds it to what a phone sends (`kuvo-link.js`, in these words), this
/// Mac's too; it's never shown.
nonisolated enum FromPhone {
    static let heading = "The user sent this from Kuvo Code on their iPhone."
    static let advice = "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it. A widget (show_widget) shows there too: keep it narrow, and make it work with taps rather than hovering."
    private static let block = MessageBlock(start: "<from-phone>", end: "</from-phone>", headings: [heading])

    /// A message without the block, and whether it had it.
    static func split(_ text: String) -> (text: String, isFromPhone: Bool) {
        guard let (before, _) = block.split(text) else { return (text, false) }
        return (before.trimmingCharacters(in: .whitespacesAndNewlines), true)
    }

    static func isFromPhone(_ text: String) -> Bool { block.split(text) != nil }
}
