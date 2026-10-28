import Foundation

/// The sites web links lead to, for their icons: the site a link is on (its main domain), whether
/// an address is a public one (not this computer's or its network's), and the icons a site's page
/// declares, the best first.
public enum SiteAddresses {
    /// The site a web link is on, by its main domain (`github.com` for `docs.github.com`,
    /// `bbc.co.uk` for `news.bbc.co.uk`); nil for one whose icon isn't asked for: not http(s), an
    /// address by number, `localhost`, a name for this network (`.local`, `.lan`, one word).
    public static func site(of url: URL) -> String? {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host()?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")),
              !host.isEmpty, isPublic(host) else { return nil }
        let labels = host.split(separator: ".")
        // A country's own second level (co.uk, com.au, ac.jp): the domain is the one under it.
        let short = labels.count >= 3 && labels[labels.count - 1].count == 2 && secondLevels.contains(String(labels[labels.count - 2]))
        return labels.suffix(short ? 3 : 2).joined(separator: ".")
    }

    /// A name on the internet: not an address by number, nor one this network or this Mac gives.
    public static func isPublic(_ host: String) -> Bool {
        let host = host.lowercased()
        guard host.contains("."), host.contains(where: \.isLetter), !host.contains(":") else { return false }
        let last = host.split(separator: ".").last.map(String.init) ?? ""
        return !["local", "localhost", "lan", "home", "internal", "intranet", "corp", "arpa", "test", "example", "invalid"].contains(last)
    }

    private static let secondLevels: Set<String> = ["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "ltd", "plc", "sch"]

    /// The icons a page declares in its <link rel="… icon …"> tags, the best first: one that
    /// scales (an SVG, where `drawsSVG`; else none), then one near the size it's shown at, Apple's
    /// touch icons last; addresses as the page would resolve them. A mask icon (one ink, for
    /// Safari's pinned tabs) isn't one.
    public static func declaredIcons(in html: String, page: URL, drawsSVG: Bool = true) -> [URL] {
        let head = html.prefix(256 * 1024)
        var found: [(url: URL, score: Int)] = []
        for match in head.matches(of: linkTag) {
            let tag = String(match.output)
            guard let rel = attribute(.rel, in: tag)?.lowercased(), rel.split(separator: " ").contains(where: { $0.hasSuffix("icon") }),
                  !rel.contains("mask-icon"), let href = attribute(.href, in: tag),
                  let url = URL(string: href.trimmingCharacters(in: .whitespaces), relativeTo: page)?.absoluteURL,
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { continue }
            // (The page's own words: a size no icon could have counts as none given.)
            let size = attribute(.sizes, in: tag).flatMap { Int($0.lowercased().split(separator: "x").first ?? "") }.flatMap { (1...4096).contains($0) ? $0 : nil }
            let isSVG = url.pathExtension.lowercased() == "svg" || attribute(.type, in: tag)?.contains("svg") == true
            if isSVG, !drawsSVG { continue }
            var score = isSVG ? 1100 : size.map { 1000 - abs($0 - 64) } ?? 500
            if rel.contains("apple-touch-icon") { score -= 200 }
            found.append((url, score))
        }
        var seen = Set<URL>()
        return found.sorted { $0.score > $1.score }.map(\.url).filter { seen.insert($0).inserted }
    }

    private enum Attribute: String, CaseIterable { case rel, href, sizes, type }

    private static func attribute(_ name: Attribute, in tag: String) -> String? {
        guard let match = tag.firstMatch(of: attributes[name]!) else { return nil }
        for index in [2, 3, 4] {
            if let value = match.output[index].substring { return String(value) }
        }
        return nil
    }

    nonisolated(unsafe) private static let attributes: [Attribute: Regex<AnyRegexOutput>] = Dictionary(uniqueKeysWithValues: Attribute.allCases.map {
        ($0, try! Regex("(?i)\\b\($0.rawValue)\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))"))
    })

    nonisolated(unsafe) private static let linkTag = /(?i)<link\b[^>]*>/
}
