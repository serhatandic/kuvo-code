import ClientText
import Foundation

/// Pictures named in a message (`ClientText`'s `ImageReferences`): taking one off a message being
/// written in the Mac's composer, with its name.
extension ImageReferences {
    /// Takes `file` off a message being written, and, a picture, its name out of `text` and the
    /// answers to its quotes, the later pictures a number down.
    @MainActor static func detach(_ file: URL, files: inout [URL], text: inout String, quotes: inout [Drafts.Quote], isImage: (URL) -> Bool) {
        if let index = files.filter(isImage).firstIndex(of: file) {
            text = removing(index + 1, from: text)
            for quote in quotes.indices { quotes[quote].response = removing(index + 1, from: quotes[quote].response) }
        }
        files.removeAll { $0 == file }
    }
}
