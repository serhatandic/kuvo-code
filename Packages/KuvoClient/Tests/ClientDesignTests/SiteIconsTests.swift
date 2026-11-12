#if os(macOS)
import AppKit
@testable import ClientDesign
import Foundation
import Testing

/// A web link in an agent's reply shows its site's icon: the one the site's page declares, else
/// its /favicon.ico, fetched from the site itself and kept in the app's caches folder, so the next
/// launch has it without asking again. A site with none worth showing shows the globe, and isn't
/// asked again for a while. A link is asked for by its site's main domain (which site that is, and
/// that a link to this computer or its network asks nothing, are `ClientText`'s, tested there).
/// What reads well enough to show is each app's own (`usable`; the Mac's and the phone's
/// SiteIconsTests): here, any picture. The sites are stand-ins, nothing reaches the network, and the
/// icons are kept in a folder of the test's own.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SiteIconsTests {
    let folder = FileManager.default.temporaryDirectory.appending(path: "Site Icons \(UUID().uuidString)")

    init() { Sites.reset() }

    private func done() {
        try? FileManager.default.removeItem(at: folder)
    }

    /// The store as an app's launch has it, reaching the stand-in sites.
    private func icons(drawsSVG: Bool = true) -> SiteIcons {
        let icons = SiteIcons(folder: folder, drawsSVG: drawsSVG, picture: { NSImage(data: $0) },
                              usable: { NSImage(data: $0)?.isValid == true ? $0 : nil })
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Sites.self]
        icons.session = URLSession(configuration: configuration)
        return icons
    }

    /// `url` loaded, once what its site has is known.
    private func load(_ icons: SiteIcons, _ url: String, site: String) async {
        let loaded = NotificationCenter.default.notifications(named: SiteIcons.loaded).makeAsyncIterator()
        icons.load(URL(string: url)!)
        while !icons.isKnown(site), await loaded.next() != nil {}
    }

    /// A picture as a site serves it.
    private var png: Data {
        let image = NSImage(size: NSSize(width: 32, height: 32), flipped: false) { rect in
            NSColor.systemOrange.setFill()
            rect.fill()
            return true
        }
        return NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
    }

    @Test func theIconTheSiteDeclaresIsShownAndKept() async throws {
        defer { done() }
        Sites.serve("https://brand-icons.com/", Data(#"<html><head><link rel="shortcut icon" href="/static/brand.png"><title>Brand</title></head></html>"#.utf8))
        Sites.serve("https://brand-icons.com/static/brand.png", png)
        let icons = icons()
        #expect(icons.icon(for: "brand-icons.com") == nil, "the globe while it comes")
        await load(icons, "https://brand-icons.com/docs/page?x=1", site: "brand-icons.com")
        #expect(icons.icon(for: "brand-icons.com") != nil)

        // The next launch has it, without asking the site again.
        let asked = Sites.asked.count
        let next = self.icons()
        #expect(next.icon(for: "brand-icons.com") != nil)
        next.load(URL(string: "https://brand-icons.com/other")!)
        #expect(Sites.asked.count == asked)
    }

    /// A page that declares none: the site's /favicon.ico.
    @Test func withoutOneDeclaredItsFaviconIsUsed() async throws {
        defer { done() }
        Sites.serve("https://plain-icons.com/", Data("<html><head><title>Plain</title></head></html>".utf8))
        Sites.serve("https://plain-icons.com/favicon.ico", png)
        let icons = icons()
        await load(icons, "https://plain-icons.com/a", site: "plain-icons.com")
        #expect(icons.icon(for: "plain-icons.com") != nil)
    }

    /// An app that can't draw SVG (the phone) never asks for one a page declares: its favicon.
    @Test func anAppThatDrawsNoSVGTakesTheFavicon() async throws {
        defer { done() }
        Sites.serve("https://vector-icons.com/", Data(#"<link rel="icon" type="image/svg+xml" href="/mark.svg">"#.utf8))
        Sites.serve("https://vector-icons.com/mark.svg", Data(#"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="orange"/></svg>"#.utf8))
        Sites.serve("https://vector-icons.com/favicon.ico", png)
        let icons = icons(drawsSVG: false)
        await load(icons, "https://vector-icons.com/", site: "vector-icons.com")
        #expect(icons.icon(for: "vector-icons.com") != nil)
        #expect(!Sites.asked.contains("https://vector-icons.com/mark.svg"))
    }

    /// An icon that doesn't read well (here, not a picture), or nothing at all: the globe, and the
    /// site isn't asked again.
    @Test(arguments: ["glyph-icons.com", "bare-icons.com"])
    func noIconThatReadsWellShowsTheGlobe(host: String) async throws {
        defer { done() }
        Sites.serve("https://glyph-icons.com/", Data(#"<link rel="icon" href="/mark.png">"#.utf8))
        Sites.serve("https://glyph-icons.com/mark.png", Data("not a picture".utf8))
        let icons = icons()
        await load(icons, "https://\(host)/", site: host)
        #expect(icons.icon(for: host) == nil)
        let asked = Sites.asked.count
        self.icons().load(URL(string: "https://\(host)/again")!)
        #expect(Sites.asked.count == asked, "not asked again")
    }

    /// A link's site is its main domain: a page under a subdomain asks the main one, once for both.
    @Test func aSubdomainsIconIsItsSites() async throws {
        defer { done() }
        Sites.serve("https://brand-icons.com/", Data(#"<link rel="icon" href="/brand.png">"#.utf8))
        Sites.serve("https://brand-icons.com/brand.png", png)
        let icons = icons()
        await load(icons, "https://docs.brand-icons.com/guide", site: "brand-icons.com")
        #expect(icons.icon(for: "brand-icons.com") != nil)
        #expect(!Sites.asked.contains { $0.contains("docs.brand-icons.com") }, "the subdomain isn't asked")
    }

    /// An icon drawn as one colorless ink on clear (black, white or a gray) would vanish on a dark
    /// or a light card; one ink in a color, a tile, or one with color across it reads.
    @Test func whatReadsOnEitherCard() {
        func icon(covering share: Double, _ ink: (r: Double, g: Double, b: Double), and other: (r: Double, g: Double, b: Double)? = nil) -> Bool {
            let total = 64 * 64, count = Int(Double(total) * share)
            let opaque = (0..<count).map { other != nil && $0 % 2 == 1 ? other! : ink }
            return SiteIcons.isColorlessGlyph(opaque, total: total)
        }
        #expect(icon(covering: 0.3, (0, 0, 0)), "a black glyph on clear")
        #expect(icon(covering: 0.3, (1, 1, 1)), "a white one")
        #expect(icon(covering: 0.3, (0.5, 0.5, 0.5)), "a gray one")
        #expect(icon(covering: 0.05, (1, 0.5, 0)), "almost nothing in it")
        #expect(!icon(covering: 0.3, (0, 0.48, 1)), "a colored mark")
        #expect(!icon(covering: 0.9, (0, 0, 0)), "a tile of its own")
        #expect(!icon(covering: 0.3, (0, 0, 0), and: (1, 1, 1)), "black and white across it")
    }
}

/// A site's redirect is followed only to another public address, and never from https down to
/// http; asked on URLSession's own queue, off the main actor.
@Suite struct SiteRedirectsTests {
    private func follows(_ from: String, to: String) async -> Bool {
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: URL(string: from)!)
        defer { task.cancel() }
        let response = HTTPURLResponse(url: URL(string: from)!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": to])!
        return await withCheckedContinuation { done in
            PublicRedirects().urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: to)!)) {
                done.resume(returning: $0 != nil)
            }
        }
    }

    @Test func onlyToPublicAddressesAndNeverDownToHTTP() async {
        #expect(await follows("https://brand-icons.com/favicon.ico", to: "https://cdn.brand-icons.net/favicon.ico"))
        #expect(await follows("http://brand-icons.com/favicon.ico", to: "https://brand-icons.com/favicon.ico"))
        #expect(await follows("http://brand-icons.com/favicon.ico", to: "http://cdn.brand-icons.net/favicon.ico"))
        #expect(!(await follows("https://brand-icons.com/favicon.ico", to: "http://cdn.brand-icons.net/favicon.ico")), "down to http")
        #expect(!(await follows("https://brand-icons.com/favicon.ico", to: "https://localhost/favicon.ico")), "this computer")
        #expect(!(await follows("https://brand-icons.com/favicon.ico", to: "https://192.168.1.20/favicon.ico")), "its network")
    }
}

/// Stand-ins for the sites: what each address answers (200 with it, else 404), and what was asked.
final class Sites: URLProtocol {
    private struct State { var answers: [String: Data] = [:]; var asked: [String] = [] }
    nonisolated(unsafe) private static var state = State()
    private static let lock = NSLock()

    static func reset() { lock.withLock { state = State() } }
    static func serve(_ url: String, _ body: Data) { lock.withLock { state.answers[url] = body } }
    static var asked: [String] { lock.withLock { state.asked } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let body = Self.lock.withLock { () -> Data? in
            Self.state.asked.append(url.absoluteString)
            return Self.state.answers[url.absoluteString]
        }
        let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let body { client?.urlProtocol(self, didLoad: body) }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
