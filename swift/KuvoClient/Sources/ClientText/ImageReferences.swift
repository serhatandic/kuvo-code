import Foundation

/// A message's words naming the pictures it carries: "[Image 1]" for its first picture, "[Image
/// 2]" for its second, in the order they're attached. A picture added to a composer puts its name
/// where you're writing, so you can say which one you mean, and the agent reads the same words
/// beside the pictures. Removing a picture takes its name out and the later ones down a number.
public enum ImageReferences {
    /// The name of the `number`th picture, as written.
    public static func name(_ number: Int) -> String { "[Image \(number)]" }

    /// Each picture named in `text`, with its number.
    public static func find(in text: String) -> [(range: Range<String.Index>, number: Int)] {
        guard text.contains("[Image ") else { return [] }
        return text.matches(of: pattern).compactMap { match in
            Int(match.output.1).map { (match.range, $0) }
        }
    }

    /// `text` without the `number`th picture's names (and a space each leaves behind), the later
    /// ones a number down, as they are once it's gone.
    public static func removing(_ number: Int, from text: String) -> String {
        var text = text
        for (range, found) in find(in: text).reversed() {
            if found == number {
                var range = range
                // The space after it goes with it; else, the one before it (at the message's end).
                if range.upperBound < text.endIndex, text[range.upperBound] == " " {
                    range = range.lowerBound..<text.index(after: range.upperBound)
                } else if range.lowerBound > text.startIndex, text[text.index(before: range.lowerBound)] == " " {
                    range = text.index(before: range.lowerBound)..<range.upperBound
                }
                text.removeSubrange(range)
            } else if found > number {
                text.replaceSubrange(range, with: name(found - 1))
            }
        }
        return text
    }

    nonisolated(unsafe) private static let pattern = /\[Image ([1-9][0-9]{0,2})\]/
}
