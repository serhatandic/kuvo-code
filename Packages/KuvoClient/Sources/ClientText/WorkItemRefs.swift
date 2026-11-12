import Foundation

/// A message's words naming Work Queue items: `#243`, which both apps draw as a chip (a dot of its
/// state, the number and the item's title) once the box says what it names, and open in the Work
/// Queue when it's clicked. The rule (PROTOCOL.md, "Work Queue references"):
///
/// - a `#` at the start, or after a space or one of `([{"'/,–-`, then 1 to 6 digits, then no
///   letter, digit or underscore;
/// - not inside a code span or block, a Markdown link or a web address;
/// - not after "PR", "MR", "pull request", "issue" or "step": those are someone else's numbers;
/// - numbers 1–10 next to rank words or before "on Google", "in search" or "Google result"
///   describe ranks, not queue items.
///
/// An outside source's reference has a prefix (`gh:owner/repo#12`), so a bare `#n` is always ours.
/// One names the item that is that GitHub issue or pull request, by the same rule: at the start or
/// after a space or one of those, not in code, a link or an address, and no letter, digit or
/// underscore after its number.
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
            guard !skipped.contains(where: { $0.overlaps(range) }), !afterOthersWord(text, hash), !(number <= 10 && isOrdinal(text, hash, end)) else { continue }
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

    /// Each reference in `text`, in order, as the box is asked for it: "243" for `#243`, and an
    /// issue's or a pull request's as written (`gh:owner/repo#12`).
    public static func findRefs(in text: String) -> [(range: Range<String.Index>, ref: String)] {
        var numbers = find(in: text).map { (range: $0.range, ref: String($0.number)) }
        guard text.contains("gh:") else { return numbers }
        let skipped = skippedRanges(in: text)
        var sources: [(range: Range<String.Index>, ref: String)] = []
        for match in text.matches(of: sourceRef) {
            let range = match.range
            if range.lowerBound > text.startIndex {
                let before = text[text.index(before: range.lowerBound)]
                guard before.isWhitespace || opens.contains(before) else { continue }
            }
            if range.upperBound < text.endIndex, text[range.upperBound].isLetter || text[range.upperBound].isNumber || text[range.upperBound] == "_" { continue }
            guard !skipped.contains(where: { $0.overlaps(range) }) else { continue }
            sources.append((range, String(text[range])))
        }
        // (A "#12" inside an issue's ref, after a "-" ending its repository's name, is the ref's.)
        numbers.removeAll { number in sources.contains { $0.range.overlaps(number.range) } }
        return (numbers + sources).sorted { $0.range.lowerBound < $1.range.lowerBound }
    }

    /// The refs `text` names, each once, in order (`findRefs`).
    public static func refs(in text: String) -> [String] {
        var seen = Set<String>()
        return findRefs(in: text).map(\.ref).filter { seen.insert($0).inserted }
    }

    /// The link a chip carries, which opens the item: `kuvo-item://243`.
    public static func link(_ number: Int) -> URL { URL(string: "\(scheme)://\(number)")! }

    /// The link a chip of `ref` carries ("243", or `gh:owner/repo#12`): `kuvo-item://243`, or
    /// `kuvo-item://ref/<ref>`.
    public static func link(ref: String) -> URL {
        if let number = Int(ref), number > 0 { return link(number) }
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = "ref"
        parts.path = "/" + ref
        return parts.url ?? URL(string: "\(scheme)://ref")!
    }

    /// The item a chip's link names.
    public static func number(in url: URL) -> Int? {
        guard url.scheme == scheme, let host = url.host(), let number = Int(host), number > 0 else { return nil }
        return number
    }

    /// The ref a chip's link names: "243", or `gh:owner/repo#12`.
    public static func ref(in url: URL) -> String? {
        if let number = number(in: url) { return String(number) }
        guard url.scheme == scheme, url.host() == "ref", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let ref = String(parts.path.dropFirst()) + (parts.fragment.map { "#" + $0 } ?? "")
        return ref.isEmpty ? nil : ref
    }

    public static let scheme = "kuvo-item"

    private static let opens: Set<Character> = ["(", "[", "{", "\"", "'", "/", ",", "–", "-", "“", "‘"]
    private static let othersWords = ["pr", "mr", "pull request", "issue", "step"]

    /// "PR #12", "issue #5", "Step #3": another's number, not ours.
    private static func afterOthersWord(_ text: String, _ hash: String.Index) -> Bool {
        var start = hash
        while start > text.startIndex, text[text.index(before: start)].isWhitespace { start = text.index(before: start) }
        let before = text[text.startIndex..<start].suffix(14).lowercased()
        return othersWords.contains { word in
            guard before.hasSuffix(word) else { return false }
            let rest = before.dropLast(word.count)
            return rest.last.map { !$0.isLetter && !$0.isNumber } ?? true
        }
    }

    private static func isOrdinal(_ text: String, _ hash: String.Index, _ end: String.Index) -> Bool {
        let words: Set<String> = ["ranked", "rank", "number", "result", "spot", "place", "position"]
        let before = text[..<hash].reversed().drop(while: { $0.isWhitespace }).prefix(while: { $0.isLetter }).reversed()
        let after = text[end...].drop(while: { $0.isWhitespace })
        if words.contains(String(before).lowercased()) || words.contains(after.prefix(while: { $0.isLetter }).lowercased()) { return true }
        let following = after.split(whereSeparator: { $0.isWhitespace }).prefix(2).map { $0.lowercased().trimmingCharacters(in: .punctuationCharacters) }
        return following == ["on", "google"] || following == ["in", "search"] || following == ["google", "result"]
    }

    /// Resolves references for a conversation. Bare numbers must be in its visible queue;
    /// explicitly qualified sources keep their computer-wide lookup. Missing visibility fails closed.
    public static func chipRefs<Value>(in text: String, known: [String: Value], visible: [String: Value]) -> [String: Value] {
        var result: [String: Value] = [:]
        for key in refs(in: text) {
            if let value = Int(key) == nil ? known[key] : visible[key] { result[key] = value }
        }
        return result
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
    /// `gh:owner/repo#12`: a GitHub owner, a repository's name, a number.
    nonisolated(unsafe) private static let sourceRef = /gh:[A-Za-z0-9][A-Za-z0-9_\-]{0,38}\/[A-Za-z0-9_.\-]{1,100}#[0-9]{1,10}/
}
