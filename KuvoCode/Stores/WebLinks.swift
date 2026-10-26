import Foundation

/// The web addresses in what you write, shown as links in the composer and in your sent
/// messages: those written as one ("https://…", "http://…" or "www.…"), not words that only look
/// like a domain ("main.swift", "README.md"). The same on the phone (kuvo-code-ios's WebLinks).
nonisolated enum WebLinks {
    /// Each address in `text`, and where it leads.
    static func find(in text: String) -> [(range: Range<String.Index>, url: URL)] {
        guard text.contains("http") || text.contains("www.") else { return [] }
        let whole = NSRange(text.startIndex..., in: text)
        return detector.matches(in: text, range: whole).compactMap { match in
            guard let url = match.url, let range = Range(match.range, in: text),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
            let written = text[range].lowercased()
            guard written.hasPrefix("http://") || written.hasPrefix("https://") || written.hasPrefix("www.") else { return nil }
            return (range, url)
        }
    }

    private static let detector = try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
}
