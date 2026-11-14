import AppKit
import ClientText

/// Replying to a message, or a part of one: what you selected (else the whole message) goes into
/// the composer as a quote, for you to answer under. How a quote is written into a message and read
/// back is KuvoClient's (`ClientText`'s `Quoting`), the same on the phone.
extension Quoting {
    /// The text selected in the window, copied as ⌘C would, with your clipboard put back as it
    /// was; nil when nothing's selected.
    static func selection() -> String? {
        // Asked of what holds it, where that can say: copying through the clipboard and putting
        // it back changes it twice, which clipboard histories keep and password managers notice.
        if let responder = NSApp.keyWindow?.firstResponder {
            if let stack = responder as? RowStackView { return trimmed(stack.selectedText()) }
            if let text = responder as? NSTextView, !text.isEditable {
                // One of its own, let go once read: a named one would keep the words readable.
                let board = NSPasteboard.withUniqueName()
                defer { board.releaseGlobally() }
                guard text.writeSelection(to: board, types: [.string]) else { return nil }
                return trimmed(board.string(forType: .string))
            }
        }
        let board = NSPasteboard.general
        let saved = (board.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
        let before = board.changeCount
        NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
        guard board.changeCount != before else { return nil }
        let text = board.string(forType: .string)
        board.clearContents()
        if !saved.isEmpty { board.writeObjects(saved) }
        return trimmed(text)
    }

    private static func trimmed(_ text: String?) -> String? {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
