import AppKit
import ClientText
import CryptoKit
import Foundation

/// The icons of the sites agents' replies link to, shown before each link (`SiteIconAttachment`).
/// Each comes from the site itself, never a service in between: the icon its main page declares,
/// else its /favicon.ico, read without cookies, from the site's main domain only (`github.com` for
/// `docs.github.com`), so a reply can't make the app look up a name made up to carry something
/// out. Never from this Mac's network or its own addresses (`localhost`, `192.168.…`, `.local`).
/// Kept in the app's own caches folder, a small file a site, within a cap. A site with no icon
/// that reads well (none, broken, or a colorless glyph that would vanish on a dark or a light
/// card) is remembered too, for a while, and shows the globe, as one whose icon takes longer than
/// `wait` does until the app opens again.
@MainActor final class SiteIcons {
    static let shared = SiteIcons()

    /// Posted with a site (its main domain) as `object` once what it has is known.
    static let loaded = Notification.Name("SiteIcons.loaded")
    /// How long a link shows the globe waiting for its site's icon.
    static let wait = Duration.seconds(1)

    /// How it reaches the sites (tests answer for them): no cookies or cache, and redirects only
    /// to other public addresses, never from https to http.
    var session: URLSession = URLSession(configuration: {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 10
        return configuration
    }(), delegate: PublicRedirects(), delegateQueue: nil)

    /// The folder they're kept in: `~/Library/Caches/<bundle id>/Site Icons` (the tests' own).
    var folder: URL = AppInfo.isHostingTests
        ? AppInfo.testRoot.appending(path: "Caches/Site Icons")
        : URL.cachesDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code").appending(path: "Site Icons")

    /// What's known of each site: its icon, or that it has none worth showing.
    private enum Known { case icon(NSImage), none }
    private var known: [String: Known] = [:]
    private var loading: Set<String> = []
    /// When each site was first asked for in this run, and when its icon came: late, it shows the
    /// globe everywhere until the next run, so no link changes long after it showed.
    private var asked: [String: ContinuousClock.Instant] = [:]
    private var came: [String: ContinuousClock.Instant] = [:]

    private static let keepIcon: TimeInterval = 30 * 24 * 3600
    private static let keepNone: TimeInterval = 3 * 24 * 3600
    /// At most this many sites are kept; the ones looked at longest ago go first.
    static let most = 1000
    /// What's read of a page or an icon, at most.
    nonisolated private static let largest = 512 * 1024
    /// Each icon is kept at this size, in points squared, drawn at twice that.
    nonisolated private static let side: CGFloat = 32

    /// What a link to `site` shows now: its icon, the globe, or nil while it's coming (the globe,
    /// for now). The same for every link to the site.
    enum Shown { case icon(NSImage), globe }

    func shown(_ site: String) -> Shown? {
        if let icon = icon(for: site) {
            guard let asked = asked[site], let came = came[site] else { return .icon(icon) }
            return came - asked < Self.wait ? .icon(icon) : .globe
        }
        if known[site] != nil { return .globe }
        if let asked = asked[site], ContinuousClock.now - asked >= Self.wait { return .globe }
        return nil
    }

    /// The icon of `site`, if it has one and it's here (in memory or on disk).
    func icon(for site: String) -> NSImage? {
        if case .icon(let image) = known[site] { return image }
        if known[site] != nil || loading.contains(site) { return nil }
        let file = self.file(site, ext: "png"), none = self.file(site, ext: "none")
        if let age = Self.age(of: file), age < Self.keepIcon, let image = NSImage(contentsOf: file) {
            known[site] = .icon(image)
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
            return image
        }
        if let age = Self.age(of: none), age < Self.keepNone { known[site] = Known.none }
        return nil
    }

    /// Whether what's known of `site` is settled: its icon is here, or it has none.
    func isKnown(_ site: String) -> Bool {
        _ = icon(for: site)
        return known[site] != nil
    }

    /// Fetches the icon of the site `url` is on (`site(of:)`), unless it's known, already coming,
    /// or one that isn't asked for (a local or private address).
    func load(_ url: URL) {
        guard let site = SiteAddresses.site(of: url), let scheme = url.scheme?.lowercased(), !isKnown(site), !loading.contains(site) else { return }
        loading.insert(site)
        asked[site] = asked[site] ?? .now
        let session = session
        Task {
            let png = await Self.fetch(scheme: scheme, site: site, session: session)
            loading.remove(site)
            came[site] = .now
            store(png, for: site)
            NotificationCenter.default.post(name: Self.loaded, object: site)
        }
    }

    private func store(_ png: Data?, for site: String) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let png, let image = NSImage(data: png) {
            known[site] = .icon(image)
            try? png.write(to: file(site, ext: "png"), options: .atomic)
            try? FileManager.default.removeItem(at: file(site, ext: "none"))
        } else {
            known[site] = Known.none
            FileManager.default.createFile(atPath: file(site, ext: "none").path, contents: Data())
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

    private func file(_ site: String, ext: String) -> URL {
        let name = SHA256.hash(data: Data(site.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return folder.appending(path: name + "." + ext)
    }

    private static func age(of file: URL) -> TimeInterval? {
        (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate.map { -$0.timeIntervalSinceNow }
    }

    // MARK: From the site

    /// The site's icon, as the site has it (one its main page declares, else /favicon.ico, both
    /// asked for at once), drawn at the size it's kept, as PNG; nil if it has none worth showing.
    @concurrent nonisolated private static func fetch(scheme: String, site: String, session: URLSession) async -> Data? {
        guard let home = URL(string: "\(scheme)://\(site)/"), let faviconURL = URL(string: "/favicon.ico", relativeTo: home)?.absoluteURL else { return nil }
        async let page = read(home, session: session)
        async let favicon = read(faviconURL, session: session)
        var declared: [URL] = []
        if let page = await page, let html = String(data: page, encoding: .utf8) ?? String(data: page, encoding: .isoLatin1) {
            declared = SiteAddresses.declaredIcons(in: html, page: home).filter { $0 != faviconURL && $0.host().map(SiteAddresses.isPublic) == true }
        }
        // Two of those the page names at most, then its favicon.
        for candidate in declared.prefix(2) {
            if let data = await read(candidate, session: session), let icon = usable(data) { return icon }
        }
        return await favicon.flatMap(usable)
    }

    /// At most `largest` bytes of what `url` answers with, if it answers 200.
    @concurrent nonisolated private static func read(_ url: URL, session: URLSession) async -> Data? {
        guard let (bytes, response) = try? await session.bytes(from: url), (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        var data = Data()
        data.reserveCapacity(64 * 1024)
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= largest { break }
            }
        } catch { return nil }
        return data
    }

    // MARK: Whether it reads

    /// `data` as an icon worth showing, as PNG at the size it's kept: a picture that decodes, not
    /// tiny, and not a colorless glyph on clear (black, white or gray, which would vanish on a dark
    /// or a light card).
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
        guard !isColorlessGlyph(bitmap) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    /// Mostly clear, and what isn't is one colorless ink (black, white or a gray): a monochrome
    /// glyph. Also an icon with almost nothing in it. One ink in a color reads on either card.
    nonisolated static func isColorlessGlyph(_ bitmap: NSBitmapImageRep) -> Bool {
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
        let saturation = max(mean.r, mean.g, mean.b) - min(mean.r, mean.g, mean.b)
        return spread < 0.3 && saturation < 0.2
    }
}

/// Redirects only to another public address, and never from https down to http.
private final class PublicRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let from = task.originalRequest?.url?.scheme?.lowercased()
        guard let url = request.url, let host = url.host(), SiteAddresses.isPublic(host),
              url.scheme?.lowercased() == "https" || from == "http" else { return completionHandler(nil) }
        completionHandler(request)
    }
}

/// A site's icon in a reply drawn by TextKit (`ReplyView`), in the square of the globe it shows
/// until then (`SiteIcons.shown`), with the room before the link's words: nothing moves when it
/// comes.
final class SiteIconCell: NSTextAttachmentCell {
    let site: String?
    private let url: URL
    nonisolated private let room: CGSize
    private let globe: NSImage
    nonisolated private let baseline: CGFloat
    /// The square it's drawn in, at the left of its room.
    private let side: CGFloat

    init(url: URL, size: CGSize, globe: NSImage, baseline: CGFloat) {
        self.url = url
        self.site = SiteAddresses.site(of: url)
        self.room = size
        self.side = size.height
        self.globe = globe
        self.baseline = baseline
        super.init(imageCell: nil)
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    nonisolated override func cellSize() -> NSSize { room }
    nonisolated override func cellBaselineOffset() -> NSPoint { NSPoint(x: 0, y: baseline) }

    override func draw(withFrame frame: NSRect, in view: NSView?) {
        let square = NSRect(x: frame.minX, y: frame.minY, width: side, height: frame.height)
        guard let site else { return globe.draw(in: square, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil) }
        let shown = SiteIcons.shared.shown(site)
        if shown == nil { SiteIcons.shared.load(url) }
        if case .icon(let icon)? = shown {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: square, xRadius: side * 0.2, yRadius: side * 0.2).addClip()
            icon.draw(in: square, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
            NSGraphicsContext.restoreGraphicsState()
        } else {
            globe.draw(in: square, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
    }

    override func draw(withFrame frame: NSRect, in view: NSView?, characterIndex: Int) {
        draw(withFrame: frame, in: view)
    }

    override func draw(withFrame frame: NSRect, in view: NSView?, characterIndex: Int, layoutManager: NSLayoutManager) {
        draw(withFrame: frame, in: view)
    }
}
