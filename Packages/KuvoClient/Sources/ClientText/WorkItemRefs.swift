import Foundation

/// A message's words naming Work Queue items: `#243`, which both apps draw as a chip (a dot of its
/// state, the number and the item's title) once the box says what it names, and open in the Work
/// Queue when it's clicked. The rule (PROTOCOL.md, "Work Queue references"):
///
/// - a `#` at the start, or after a space or one of `([{"'/,–-`, then 1 to 6 digits, then no
///   letter, digit or underscore;
/// - not inside a code span or block, a Markdown link or a web address;
/// - not after "PR", "MR", "pull request", "issue" or "step": those are someone else's numbers.
///
/// An outside source's reference has a prefix (`gh:owner/repo#12`), so a bare `#n` is always ours.
public enum WorkItemRefs {
    /// Each reference in `text` (plain, or Markdown as written), with its number.
    public static func find(in text: String) -> [(range: Range<String.Index>, number: Int)] {
        guard text.contains("#") else { return [] }
        let skipped = skippedRanges(in: text)
        var found: [(range: Range<String.Index>, number: Int)] = []
        var index = text.startIndex
        while let hash = text[index...].firstIndex(of: "#") {
            index = text.index(after: hash)
            if hash > text.startIndex {
                let before = text[text.index(before: hash)]
                guard before.isWhitespace || Self.opens.contains(before) else { continue }
            }
            var end = index
            while end < text.endIndex, text[end].isASCII, text[end].isNumber, text.distance(from: index, to: end) < 7 { end = text.index(after: end) }
            let digits = text.distance(from: index, to: end)
            guard (1...6).contains(digits) else { continue }
            if end < text.endIndex, text[end].isLetter || text[end].isNumber || text[end] == "_" { continue }
            guard let number = Int(text[index..<end]), number > 0 else { continue }
            let range = hash..<end
            guard !skipped.contains(where: { $0.overlaps(range) }), !afterOthersWord(text, hash) else { continue }
            found.append((range, number))
            index = end
        }
        return found
    }

    /// The numbers `text` names, each once, in order.
    public static func numbers(in text: String) -> [Int] {
        var seen = Set<Int>()
        return find(in: text).map(\.number).filter { seen.insert($0).inserted }
    }

    /// The link a chip carries, which opens the item: `kuvo-item://243`.
    public static func link(_ number: Int) -> URL { URL(string: "\(scheme)://\(number)")! }

    /// The item a chip's link names.
    public static func number(in url: URL) -> Int? {
        guard url.scheme == scheme, let host = url.host(), let number = Int(host), number > 0 else { return nil }
        return number
    }

    public static let scheme = "kuvo-item"

    private static let opens: Set<Character> = ["(", "[", "{", "\"", "'", "/", ",", "–", "-", "“", "‘"]
    private static let othersWords = ["pr", "mr", "pull request", "issue", "step"]

    /// "PR #12", "issue #5", "Step #3": another's number, not ours.
    private static func afterOthersWord(_ text: String, _ hash: String.Index) -> Bool {
        var start = hash
        while start > text.startIndex, text[text.index(before: start)] == " " { start = text.index(before: start) }
        let before = text[text.startIndex..<start].suffix(14).lowercased()
        return othersWords.contains { word in
            guard before.hasSuffix(word) else { return false }
            let rest = before.dropLast(word.count)
            return rest.last.map { !$0.isLetter && !$0.isNumber } ?? true
        }
    }

    /// Where a reference isn't one: code spans and blocks, Markdown links (their words and their
    /// address), and web addresses.
    private static func skippedRanges(in text: String) -> [Range<String.Index>] {
        var ranges: [Range<String.Index>] = []
        // Code: a run of backticks to the next run of as many (a block's fence and all).
        var index = text.startIndex
        while let tick = text[index...].firstIndex(of: "`") {
            var fenceEnd = tick
            while fenceEnd < text.endIndex, text[fenceEnd] == "`" { fenceEnd = text.index(after: fenceEnd) }
            let fence = text[tick..<fenceEnd]
            if let close = text.range(of: fence, range: fenceEnd..<text.endIndex) {
                ranges.append(tick..<close.upperBound)
                index = close.upperBound
            } else {
                // An unclosed fence runs to the end (a code block still being written).
                if fence.count >= 3 { ranges.append(tick..<text.endIndex) }
                index = fenceEnd
            }
        }
        for match in text.matches(of: markdownLink) { ranges.append(match.range) }
        ranges.append(contentsOf: WebLinks.find(in: text).map(\.range))
        return ranges
    }

    nonisolated(unsafe) private static let markdownLink = /!?\[[^\]\n]*\]\([^)\n]*\)/
}
