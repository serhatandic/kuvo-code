import Foundation

/// Where the words a search found are in the snippet it shows, to set them in bold. It matches as
/// the box's search does: the words as one phrase, any case and accents, Markdown's marks left out
/// and spaces as one.
public enum SearchMatches {
    /// Each place `query` is in `text`, in order.
    public static func ranges(of query: String, in text: String) -> [Range<String.Index>] {
        let wanted = query.replacingOccurrences(of: "[*`#>]", with: "", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !wanted.isEmpty else { return [] }
        var found: [Range<String.Index>] = []
        var from = text.startIndex
        while from < text.endIndex,
              let range = text.range(of: wanted, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
            found.append(range)
            from = range.upperBound
        }
        return found
    }
}
