import ClientText
import CryptoKit
import Foundation
#if os(macOS)
import AppKit

/// The platform's own picture: NSImage on the Mac, UIImage on the phone.
public typealias PlatformImage = NSImage
#else
import UIKit

/// The platform's own picture: NSImage on the Mac, UIImage on the phone.
public typealias PlatformImage = UIImage
#endif

/// The icons of the sites agents' replies link to, shown before each link, the same in both apps.
/// Each comes from the site itself, never a service in between: the icon its main page declares,
/// else its /favicon.ico, read without cookies, from the site's main domain only (`github.com` for
/// `docs.github.com`), so a reply can't make the app look up a name made up to carry something
/// out. Never from the device's network or a computer's own addresses (`localhost`, `192.168.…`,
/// `.local`). Kept in the folder the app gives (its caches), a small file a site, within a cap. A
/// site with no icon that reads well (none, broken, or a colorless glyph that would vanish on a
/// dark or a light card) is remembered too, for a while, and shows the globe, as one whose icon
/// takes longer than `wait` does until the app opens again. Each app reads pictures its own way
/// (`usable`, `picture`): which it can draw, at its screens' scale.
@MainActor public final class SiteIcons {
    /// Posted with a site (its main domain) as `object` once what it has is known.
    public static let loaded = Notification.Name("SiteIcons.loaded")
    /// How long a link shows the globe waiting for its site's icon.
    public static let wait = Duration.seconds(1)

    /// How it reaches the sites (tests answer for them): no cookies or cache, and redirects only
    /// to other public addresses, never from https to http.
    public var session: URLSession = URLSession(configuration: {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 10
        return configuration
    }(), delegate: PublicRedirects(), delegateQueue: nil)

    /// The folder they're kept in.
    public var folder: URL
    /// Whether a page's SVG icons are asked for (an app that can draw them).
    private let drawsSVG: Bool
    /// A kept icon (PNG, as `usable` made it) as the app's picture.
    private let picture: (Data) -> PlatformImage?
    /// What a site sent as an icon worth showing, as PNG at the size it's kept; nil if it isn't.
    private let usable: @Sendable (Data) -> Data?

    /// What's known of each site: its icon, or that it has none worth showing.
    private enum Known { case icon(PlatformImage), none }
    private var known: [String: Known] = [:]
    private var loading: Set<String> = []
    /// When each site was first asked for in this run, and when its icon came: late, it shows the
    /// globe everywhere until the next run, so no link changes long after it showed.
    private var asked: [String: ContinuousClock.Instant] = [:]
    private var came: [String: ContinuousClock.Instant] = [:]

    private static let keepIcon: TimeInterval = 30 * 24 * 3600
    private static let keepNone: TimeInterval = 3 * 24 * 3600
    /// At most this many sites are kept; the ones looked at longest ago go first.
    public static let most = 1000
    /// What's read of a page or an icon, at most.
    nonisolated private static let largest = 512 * 1024
    /// Each icon is kept at this size, in points squared (each app draws it at its screens' scale).
    nonisolated public static let side: CGFloat = 32

    public init(folder: URL, drawsSVG: Bool, picture: @escaping (Data) -> PlatformImage?, usable: @escaping @Sendable (Data) -> Data?) {
        self.folder = folder
        self.drawsSVG = drawsSVG
        self.picture = picture
        self.usable = usable
    }

    /// What a link to `site` shows now: its icon, the globe, or nil while it's coming (the globe,
    /// for now). The same for every link to the site.
    public enum Shown { case icon(PlatformImage), globe }

    public func shown(_ site: String) -> Shown? {
        if let icon = icon(for: site) {
            guard let asked = asked[site], let came = came[site] else { return .icon(icon) }
            return came - asked < Self.wait ? .icon(icon) : .globe
        }
        if known[site] != nil { return .globe }
        if let asked = asked[site], ContinuousClock.now - asked >= Self.wait { return .globe }
        return nil
    }

    /// The icon of `site`, if it has one and it's here (in memory or on disk).
    public func icon(for site: String) -> PlatformImage? {
        if case .icon(let image) = known[site] { return image }
        if known[site] != nil || loading.contains(site) { return nil }
        let file = self.file(site, ext: "png"), none = self.file(site, ext: "none")
        if let age = Self.age(of: file), age < Self.keepIcon, let data = try? Data(contentsOf: file), let image = picture(data) {
            known[site] = .icon(image)
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
            return image
        }
        if let age = Self.age(of: none), age < Self.keepNone { known[site] = Known.none }
        return nil
    }

    /// Whether what's known of `site` is settled: its icon is here, or it has none.
    public func isKnown(_ site: String) -> Bool {
        _ = icon(for: site)
        return known[site] != nil
    }

    /// Fetches the icon of the site `url` is on (`SiteAddresses.site(of:)`), unless it's known,
    /// already coming, or one that isn't asked for (a local or private address).
    public func load(_ url: URL) {
        guard let site = SiteAddresses.site(of: url), let scheme = url.scheme?.lowercased(), !isKnown(site), !loading.contains(site) else { return }
        loading.insert(site)
        asked[site] = asked[site] ?? .now
        let session = session, drawsSVG = drawsSVG, usable = usable
        Task {
            let png = await Self.fetch(scheme: scheme, site: site, session: session, drawsSVG: drawsSVG, usable: usable)
            loading.remove(site)
            came[site] = .now
            store(png, for: site)
            NotificationCenter.default.post(name: Self.loaded, object: site)
        }
    }

    private func store(_ png: Data?, for site: String) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let png, let image = picture(png) {
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
    @concurrent nonisolated private static func fetch(scheme: String, site: String, session: URLSession, drawsSVG: Bool,
                                                      usable: @Sendable (Data) -> Data?) async -> Data? {
        guard let home = URL(string: "\(scheme)://\(site)/"), let faviconURL = URL(string: "/favicon.ico", relativeTo: home)?.absoluteURL else { return nil }
        async let page = read(home, session: session)
        async let favicon = read(faviconURL, session: session)
        var declared: [URL] = []
        if let page = await page, let html = String(data: page, encoding: .utf8) ?? String(data: page, encoding: .isoLatin1) {
            declared = SiteAddresses.declaredIcons(in: html, page: home, drawsSVG: drawsSVG).filter { $0 != faviconURL && $0.host().map(SiteAddresses.isPublic) == true }
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

    /// Whether an icon drawn `total` pixels in all, `opaque` the colors (0…1) of the ones that
    /// aren't clear, is mostly clear, and what isn't is one colorless ink (black, white or a gray):
    /// a monochrome glyph. Also an icon with almost nothing in it. One ink in a color reads on
    /// either card.
    nonisolated public static func isColorlessGlyph(_ opaque: [(r: Double, g: Double, b: Double)], total: Int) -> Bool {
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
final class PublicRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let from = task.originalRequest?.url?.scheme?.lowercased()
        guard let url = request.url, let host = url.host(), SiteAddresses.isPublic(host),
              url.scheme?.lowercased() == "https" || from == "http" else { return completionHandler(nil) }
        completionHandler(request)
    }
}
