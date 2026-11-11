import SwiftUI

/// The row under a composer's message field, the same on the Mac and the phone: its words, and its
/// icons (the paperclip, the mode's, a chip's ✕, the model's and the effort's chevron, the mic,
/// Send and Stop) all at one size and weight, the words' own, standing on the words' baseline. An
/// icon a point or two over its words, or under them, reads as a different size at once (#440).
public enum ComposerRow {
    /// The chips' words.
    public static let text: Font = .callout
    /// Every icon in the row: the words' size, a step heavier, as a symbol beside words is drawn.
    public static let icon: Font = text.weight(.medium)
    /// The row, and each chip in it, lined up on its words' baseline, the icons with them.
    public static let alignment: VerticalAlignment = .firstTextBaseline
}
