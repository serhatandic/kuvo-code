import Foundation

/// A message field's words changed by the app, not by typing (a draft brought back, a name picked
/// from a list, a sent message gone, one put back in front): only the part that changed is new,
/// and the caret moves with it, so what you type next goes where you were typing, after what came
/// in there. The same in both apps' fields. Offsets are UTF-16, as the text views count.
public struct TextChange: Equatable, Sendable {
    /// Where the words differ, in the old text.
    public var range: NSRange
    /// What's there now, in its place.
    public var replacement: String

    /// The change from `old` to `new`: what both start and end with is kept.
    public init(from old: String, to new: String) {
        let old = old as NSString, new = new as NSString
        var prefix = 0
        while prefix < old.length, prefix < new.length, old.character(at: prefix) == new.character(at: prefix) { prefix += 1 }
        var suffix = 0
        while suffix < old.length - prefix, suffix < new.length - prefix,
              old.character(at: old.length - 1 - suffix) == new.character(at: new.length - 1 - suffix) { suffix += 1 }
        range = NSRange(location: prefix, length: old.length - prefix - suffix)
        replacement = new.substring(with: NSRange(location: prefix, length: new.length - prefix - suffix))
    }

    /// Where a caret at `caret` in the old text goes: before the change, it stays; after it, it
    /// moves with the text; in it (or right where words came in), it goes after what came in.
    public func caret(movedFrom caret: Int) -> Int {
        let added = (replacement as NSString).length
        if caret < range.location { return caret }
        if caret >= NSMaxRange(range) { return caret + added - range.length }
        return range.location + added
    }
}
