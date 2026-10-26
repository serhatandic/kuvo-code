import AppKit
import CryptoKit
import Foundation

/// The icons of the sites agents' replies link to, shown before each link (`SiteIconAttachment`).
/// Each comes from the site itself, never a service in between: the icon its page declares, else
/// its /favicon.ico, read without cookies. Kept in the app's own caches folder, a small file a
/// site, within a cap; a site with no icon that reads well (none, broken, or one ink that would
/// vanish on a dark or light card) is remembered too, for a while, and shows the globe.
@MainActor final class SiteIcons {
    static let shared = SiteIcons()

    /// Posted with a site's host as `object` once what it has is known: its icon, or none.
    static let loaded = Notification.Name("SiteIcons.loaded")
    /// How long a link shows the globe waiting for its site's icon; one that comes later shows
    /// the next time the link is drawn anew.
    static let wait = Duration.seconds(1)

    /// How it reaches the sites (tests answer for them).
    var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 10
        return URLSession(configuration: configuration)
    }()

    /// The folder they're kept in: `~/Library/Caches/<bundle id>/Site Icons` (the tests' own).
    var folder: URL = AppInfo.isHostingTests
        ? AppInfo.testRoot.appending(path: "Caches/Site Icons")
        : URL.cachesDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code").appending(path: "Site Icons")

    /// What's known of each host: its icon, or that it has none worth showing.
    private enum Known { case icon(NSImage), none }
    private var known: [String: Known] = [:]
    private var loading: Set<String> = []

    /// How long an icon is kept, and how long a site without one is left before asking again.
    private static let keepIcon: TimeInterval = 30 * 24 * 3600
    private static let keepNone: TimeInterval = 3 * 24 * 3600
    /// At most this many sites are kept; the ones looked at longest ago go first.
    static let most = 1000
    /// What's read of a page or an icon, at most.
    nonisolated private static let largest = 512 * 1024
    /// Each icon is kept at this size, in points squared, drawn at twice that.
    nonisolated private static let side: CGFloat = 32

    /// The icon of `host`, if it has one and it's here (in memory or on disk). Nil while it's
    /// coming, or when it has none: the globe shows.
    func icon(for host: String) -> NSImage? {
        if case .icon(let image) = known[host] { return image }
        if known[host] != nil { return nil }
        let file = self.file(host, ext: "png"), none = self.file(host, ext: "none")
        if let age = Self.age(of: file), age < Self.keepIcon, let image = NSImage(contentsOf: file) {
            known[host] = .icon(image)
            Self.touch(file)
            return image
        }
        if let age = Self.age(of: none), age < Self.keepNone { known[host] = Known.none }
        return nil
    }

    /// Whether what's known of `host` is settled: its icon is here, or it has none.
    func isKnown(_ host: String) -> Bool {
        _ = icon(for: host)
        return known[host] != nil
    }

    /// Fetches the icon of the site `url` is on, unless it's known or already coming; `loaded` is
    /// posted once it's here.
    func load(_ url: URL) {
        guard let host = url.host()?.lowercased(), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              !isKnown(host), !loading.contains(host) else { return }
        loading.insert(host)
        let session = session
        Task {
            let png = await Self.fetch(scheme: scheme, host: host, port: url.port, session: session)
            let image = png.flatMap(NSImage.init(data:))
            loading.remove(host)
            store(image, for: host)
            NotificationCenter.default.post(name: Self.loaded, object: host)
        }
    }

    private func store(_ image: NSImage?, for host: String) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let image, let png = image.representations.first.flatMap({ ($0 as? NSBitmapImageRep)?.representation(using: .png, properties: [:]) }) {
            known[host] = .icon(image)
            try? png.write(to: file(host, ext: "png"), options: .atomic)
            try? FileManager.default.removeItem(at: file(host, ext: "none"))
        } else {
            known[host] = Known.none
            FileManager.default.createFile(atPath: file(host, ext: "none").path, contents: Data())
        }
        prune()
    }

    /// Past the cap, the files looked at longest ago go.
    private func prune() {
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys), files.count > Self.most else { return }
        let dated = files.map { ($0, (try? $0.resourceValues(forKeys: Set(keys)))?.contentModificationDate ?? .distantPast) }
        for (file, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(files.count - Self.most) {
            try? FileManager.default.removeItem(at: file)
        }
    }

    private func file(_ host: String, ext: String) -> URL {
        let name = SHA256.hash(data: Data(host.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return folder.appending(path: name + "." + ext)
    }

    private static func age(of file: URL) -> TimeInterval? {
        (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate.map { -$0.timeIntervalSinceNow }
    }

    /// Looked at now: it's the last to go past the cap. (An icon's age still counts from when it
    /// came, by the cap: one looked at goes on being kept while it's looked at.)
    private static func touch(_ file: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
    }

    // MARK: From the site

    /// The site's icon, as the site has it (the one its page declares, else /favicon.ico), drawn
    /// at the size it's kept, as PNG; nil if it has none worth showing.
    nonisolated private static func fetch(scheme: String, host: String, port: Int?, session: URLSession) async -> Data? {
        var site = URLComponents()
        site.scheme = scheme
        site.host = host
        site.port = port
        site.path = "/"
        guard let home = site.url else { return nil }
        var candidates: [URL] = []
        if let page = await read(home, session: session), let html = String(data: page, encoding: .utf8) ?? String(data: page, encoding: .isoLatin1) {
            candidates = declaredIcons(in: html, page: home)
        }
        if let favicon = URL(string: "/favicon.ico", relativeTo: home)?.absoluteURL, !candidates.contains(favicon) { candidates.append(favicon) }
        for candidate in candidates {
            if let data = await read(candidate, session: session), let icon = usable(data) { return icon }
        }
        return nil
    }

    /// At most `largest` bytes of what `url` answers with, if it answers 200.
    nonisolated private static func read(_ url: URL, session: URLSession) async -> Data? {
        guard let (bytes, response) = try? await session.bytes(from: url), (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= largest { break }
            }
        } catch { return nil }
        return data
    }

    /// The icons a page declares in its <link rel="… icon …"> tags, the best first: one near the
    /// size it's shown at (or a picture that scales, an SVG), then the rest, Apple's touch icons
    /// last of the sized ones; addresses as the page would resolve them.
    nonisolated static func declaredIcons(in html: String, page: URL) -> [URL] {
        let head = html.prefix(256 * 1024)
        var found: [(url: URL, score: Int)] = []
        for match in head.matches(of: linkTag) {
            let tag = String(match.output)
            guard let rel = attribute("rel", in: tag)?.lowercased(), rel.split(separator: " ").contains(where: { $0.hasSuffix("icon") }),
                  !rel.contains("mask-icon"), let href = attribute("href", in: tag),
                  let url = URL(string: href.trimmingCharacters(in: .whitespaces), relativeTo: page)?.absoluteURL,
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { continue }
            let size = attribute("sizes", in: tag).flatMap { Int($0.lowercased().split(separator: "x").first ?? "") }
            let isSVG = url.pathExtension.lowercased() == "svg" || attribute("type", in: tag)?.contains("svg") == true
            var score = isSVG ? 64 : size.map { 1000 - abs($0 - 64) } ?? 500
            if rel.contains("apple-touch-icon") { score -= 200 }
            found.append((url, score))
        }
        var seen = Set<URL>()
        return found.sorted { $0.score > $1.score }.map(\.url).filter { seen.insert($0).inserted }
    }

    nonisolated private static func attribute(_ name: String, in tag: String) -> String? {
        let pattern = try! Regex("(?i)\\b\(name)\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))")
        guard let match = tag.firstMatch(of: pattern) else { return nil }
        for index in [2, 3, 4] {
            if let value = match.output[index].substring { return String(value) }
        }
        return nil
    }

    nonisolated(unsafe) private static let linkTag = /(?i)<link\b[^>]*>/

    // MARK: Whether it reads

    /// `data` as an icon worth showing, as PNG at the size it's kept: a picture that decodes, not
    /// tiny, and not one ink on clear (a monochrome glyph, which would vanish on a dark or a light
    /// card, or read as a stray mark).
    nonisolated static func usable(_ data: Data) -> Data? {
        guard data.count > 0, let image = NSImage(data: data), image.isValid,
              let rep = image.representations.max(by: { $0.pixelsWide < $1.pixelsWide }),
              max(rep.pixelsWide, Int(image.size.width)) >= 8 else { return nil }
        let pixels = Int(side * 2)
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                                            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        bitmap.size = NSSize(width: side, height: side)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard !isOneInkOnClear(bitmap) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    /// Mostly clear, and what isn't is one ink (black, white, a gray or one color): a monochrome
    /// glyph. Also an icon with almost nothing in it.
    nonisolated static func isOneInkOnClear(_ bitmap: NSBitmapImageRep) -> Bool {
        var opaque: [(r: Double, g: Double, b: Double)] = []
        let total = bitmap.pixelsWide * bitmap.pixelsHigh
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                guard let color = bitmap.colorAt(x: x, y: y), color.alphaComponent > 0.9 else { continue }
                opaque.append((color.redComponent, color.greenComponent, color.blueComponent))
            }
        }
        guard Double(opaque.count) > Double(total) * 0.08 else { return true }
        // Covering most of its square, it's a tile of its own, whatever its colors.
        guard Double(opaque.count) < Double(total) * 0.75 else { return false }
        let count = Double(opaque.count)
        let mean = opaque.reduce((r: 0.0, g: 0.0, b: 0.0)) { ($0.r + $1.r / count, $0.g + $1.g / count, $0.b + $1.b / count) }
        let spread = opaque.reduce(0.0) { max($0, abs($1.r - mean.r) + abs($1.g - mean.g) + abs($1.b - mean.b)) }
        return spread < 0.3
    }
}

/// A site's icon in a reply drawn by TextKit (`ReplyView`), in the square of the globe it shows
/// until then: the icon, if it's here when the link is first drawn or comes within `SiteIcons.wait`
/// of it; else the globe, for as long as this text is shown. The text redraws as icons come.
final class SiteIconCell: NSTextAttachmentCell {
    private let url: URL
    private let host: String
    nonisolated private let side: CGSize
    private let globe: NSImage
    nonisolated private let baseline: CGFloat
    private enum Shown { case waiting(since: ContinuousClock.Instant?), icon(NSImage), globe }
    private var shown = Shown.waiting(since: nil)

    init(url: URL, size: CGSize, globe: NSImage, baseline: CGFloat) {
        self.url = url
        self.host = url.host()?.lowercased() ?? ""
        self.side = size
        self.globe = globe
        self.baseline = baseline
        super.init(imageCell: nil)
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    nonisolated override func cellSize() -> NSSize { side }
    nonisolated override func cellBaselineOffset() -> NSPoint { NSPoint(x: 0, y: baseline) }

    override func draw(withFrame frame: NSRect, in view: NSView?) {
        switch current() {
        case .some(let icon):
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: frame, xRadius: frame.width * 0.2, yRadius: frame.height * 0.2).addClip()
            icon.draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
            NSGraphicsContext.restoreGraphicsState()
        case .none:
            globe.draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
    }

    override func draw(withFrame frame: NSRect, in view: NSView?, characterIndex: Int) {
        draw(withFrame: frame, in: view)
    }

    override func draw(withFrame frame: NSRect, in view: NSView?, characterIndex: Int, layoutManager: NSLayoutManager) {
        draw(withFrame: frame, in: view)
    }

    /// The icon to draw, or nil for the globe, settled once it's known.
    private func current() -> NSImage? {
        switch shown {
        case .icon(let icon): return icon
        case .globe: return nil
        case .waiting(let since):
            let now = ContinuousClock.now
            if let icon = SiteIcons.shared.icon(for: host) {
                // Here before it was first drawn, or in time.
                if since == nil || now - since! < SiteIcons.wait {
                    shown = .icon(icon)
                    return icon
                }
                shown = .globe
                return nil
            }
            if let since {
                if now - since >= SiteIcons.wait { shown = .globe }
            } else {
                shown = .waiting(since: now)
                SiteIcons.shared.load(url)
            }
            return nil
        }
    }
}
