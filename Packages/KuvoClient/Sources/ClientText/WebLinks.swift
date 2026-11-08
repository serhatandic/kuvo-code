import Foundation

/// The web addresses in what you write, shown as links in the composer and in your sent
/// messages: those written as one ("https://…", "http://…" or "www.…"), not words that only look
/// like a domain ("main.swift", "README.md"). A bare "www.…" leads to its https page.
public enum WebLinks {
    /// Each address in `text`, and where it leads.
    public static func find(in text: String) -> [(range: Range<String.Index>, url: URL)] {
        guard text.contains("http") || text.contains("www.") else { return [] }
        let whole = NSRange(text.startIndex..., in: text)
        return detector.matches(in: text, range: whole).compactMap { match in
            guard let url = match.url, let range = Range(match.range, in: text),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
            let written = text[range].lowercased()
            guard written.hasPrefix("http://") || written.hasPrefix("https://") || written.hasPrefix("www.") else { return nil }
            // An address written as "www.…" has no scheme of its own. The system's detector picks one
            // (http before macOS 27, https now), so the scheme is set here: the same link on every system.
            guard written.hasPrefix("www."), var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return (range, url) }
            parts.scheme = "https"
            return (range, parts.url ?? url)
        }
    }

    private static let detector = try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
}
