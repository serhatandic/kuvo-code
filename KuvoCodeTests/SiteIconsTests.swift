import AppKit
import Foundation
import Testing
@testable import KuvoCode

/// A web link in an agent's reply shows its site's icon: the one the site's page declares, else
/// its /favicon.ico, fetched from the site itself and kept in the app's caches folder, so the next
/// launch has it without asking again. A site with none, or only a colorless glyph (which would
/// vanish on a dark or a light card), shows the globe, and isn't asked again for a while. A link
/// is asked for by its site's main domain, and a link to this Mac or its network asks nothing.
/// The sites are stand-ins; nothing reaches the network.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SiteIconsTests {
    let folder = AppInfo.testRoot.appending(path: "Caches/Site Icons \(UUID().uuidString.prefix(6))")
    private let watch: NSObjectProtocol

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["brand-icons.com", "plain-icons.com", "glyph-icons.com", "bare-icons.com", "blue-icons.com"])
        watch = NotificationCenter.default.addObserver(forName: SiteIcons.loaded, object: nil, queue: nil) { _ in TestPulse.beat() }
    }

    private func done() {
        NotificationCenter.default.removeObserver(watch)
        StubWeb.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    /// The store as a launch of the app has it, reaching the stand-in sites.
    private func icons() -> SiteIcons {
        let icons = SiteIcons()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubWeb.self]
        icons.session = URLSession(configuration: configuration)
        icons.folder = folder
        return icons
    }

    /// A picture as a site serves it: two colors, or one ink on clear.
    private func png(oneInk: Bool, ink: NSColor = .black) -> Data {
        let image = NSImage(size: NSSize(width: 32, height: 32), flipped: false) { rect in
            if oneInk {
                ink.setFill()
                NSBezierPath(ovalIn: rect.insetBy(dx: 8, dy: 8)).fill()
            } else {
                NSColor.systemOrange.setFill()
                rect.fill()
                NSColor.white.setFill()
                NSBezierPath(ovalIn: rect.insetBy(dx: 8, dy: 8)).fill()
            }
            return true
        }
        return NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
    }

    private func serve(_ url: String, _ body: Data) {
        StubWeb.route(url) { _ in StubWeb.Answer(status: 200, body: body) }
    }

    @Test func theIconTheSiteDeclaresIsShownAndKept() async throws {
        defer { done() }
        StubWeb.answer("https://brand-icons.com/", text: #"<html><head><link rel="shortcut icon" href="/static/brand.png"><title>Brand</title></head></html>"#)
        serve("https://brand-icons.com/static/brand.png", png(oneInk: false))
        let icons = icons()
        #expect(icons.icon(for: "brand-icons.com") == nil, "the globe while it comes")
        icons.load(URL(string: "https://brand-icons.com/docs/page?x=1")!)
        try await until { icons.isKnown("brand-icons.com") }
        #expect(icons.icon(for: "brand-icons.com") != nil)

        // The next launch has it, without asking the site again.
        let asked = StubWeb.asked.count
        let next = self.icons()
        #expect(next.icon(for: "brand-icons.com") != nil)
        next.load(URL(string: "https://brand-icons.com/other")!)
        #expect(StubWeb.asked.count == asked)
    }

    /// A page that declares none: the site's /favicon.ico.
    @Test func withoutOneDeclaredItsFaviconIsUsed() async throws {
        defer { done() }
        StubWeb.answer("https://plain-icons.com/", text: "<html><head><title>Plain</title></head></html>")
        serve("https://plain-icons.com/favicon.ico", png(oneInk: false))
        let icons = icons()
        icons.load(URL(string: "https://plain-icons.com/a")!)
        try await until { icons.isKnown("plain-icons.com") }
        #expect(icons.icon(for: "plain-icons.com") != nil)
    }

    /// A one-ink glyph, or nothing at all: the globe, and the site isn't asked again.
    @Test(arguments: ["glyph-icons.com", "bare-icons.com"])
    func noIconThatReadsWellShowsTheGlobe(host: String) async throws {
        defer { done() }
        StubWeb.answer("https://glyph-icons.com/", text: #"<link rel="icon" href="/mark.png">"#)
        serve("https://glyph-icons.com/mark.png", png(oneInk: true))
        let icons = icons()
        icons.load(URL(string: "https://\(host)/")!)
        try await until { icons.isKnown(host) }
        #expect(icons.icon(for: host) == nil)
        let asked = StubWeb.asked.count
        self.icons().load(URL(string: "https://\(host)/again")!)
        #expect(StubWeb.asked.count == asked, "not asked again")
    }

    /// A link's site is its main domain: a page under a subdomain asks the main one, once for both.
    @Test func aSubdomainsIconIsItsSites() async throws {
        defer { done() }
        StubWeb.answer("https://brand-icons.com/", text: #"<link rel="icon" href="/brand.png">"#)
        serve("https://brand-icons.com/brand.png", png(oneInk: false))
        let icons = icons()
        icons.load(URL(string: "https://docs.brand-icons.com/guide")!)
        try await until { icons.isKnown("brand-icons.com") }
        #expect(icons.icon(for: "brand-icons.com") != nil)
        #expect(!StubWeb.asked.contains { $0.contains("docs.brand-icons.com") }, "the subdomain isn't asked")
        #expect(SiteIcons.site(of: URL(string: "https://news.bbc.co.uk/x")!) == "bbc.co.uk")
    }

    /// A link to this Mac or its network (a dev server, a router, a name for the network) asks
    /// nothing: no icon is fetched from there.
    @Test(arguments: ["http://localhost:3000/", "http://127.0.0.1:8080/", "http://192.168.1.1/", "http://[::1]:5000/", "http://printer.local/", "http://intranet/", "file:///tmp/a.html"])
    func localAddressesArentAsked(link: String) {
        #expect(SiteIcons.site(of: URL(string: link)!) == nil)
    }

    /// A one-ink mark in a color (a blue whale) reads on a dark card and a light one: it shows.
    @Test func aColoredMarkShows() async throws {
        defer { done() }
        StubWeb.answer("https://blue-icons.com/", text: #"<link rel="icon" href="/mark.png">"#)
        serve("https://blue-icons.com/mark.png", png(oneInk: true, ink: .systemBlue))
        let icons = icons()
        icons.load(URL(string: "https://blue-icons.com/")!)
        try await until { icons.isKnown("blue-icons.com") }
        #expect(icons.icon(for: "blue-icons.com") != nil)
    }

    /// The icons a page declares, the best first: one near the size it's shown at before Apple's
    /// touch icon, addresses as the page resolves them; a mask icon (one ink, for Safari's pins) not.
    @Test func whatAPageDeclares() {
        let html = """
        <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
        <link rel='icon' type='image/png' sizes='32x32' href='https://cdn.test/32.png'>
        <link rel="mask-icon" href="/pin.svg" color="#000">
        <link href=icon-16.png rel=icon sizes=16x16>
        """
        let found = SiteIcons.declaredIcons(in: html, page: URL(string: "https://site.test/blog/")!)
        #expect(found.map(\.absoluteString) == ["https://cdn.test/32.png", "https://site.test/blog/icon-16.png", "https://site.test/touch.png"])
        // One that scales comes first.
        let svg = SiteIcons.declaredIcons(in: html + #"<link rel="icon" href="/logo.svg">"#, page: URL(string: "https://site.test/")!)
        #expect(svg.first?.absoluteString == "https://site.test/logo.svg")
    }
}
