import AppKit
import Foundation
import Testing
@testable import KuvoCode

/// A web link in an agent's reply shows its site's icon: the one the site's page declares, else
/// its /favicon.ico, fetched from the site itself and kept in the app's caches folder, so the next
/// launch has it without asking again. A site with none, or only a one-ink glyph (which would
/// vanish on a dark or a light card), shows the globe, and isn't asked again for a while. The
/// sites are stand-ins; nothing reaches the network.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SiteIconsTests {
    let folder = AppInfo.testRoot.appending(path: "Caches/Site Icons \(UUID().uuidString.prefix(6))")
    private let watch: NSObjectProtocol

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["brand.test", "plain.test", "glyph.test", "bare.test"])
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
    private func png(oneInk: Bool) -> Data {
        let image = NSImage(size: NSSize(width: 32, height: 32), flipped: false) { rect in
            if oneInk {
                NSColor.black.setFill()
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
        StubWeb.answer("https://brand.test/", text: #"<html><head><link rel="shortcut icon" href="/static/brand.png"><title>Brand</title></head></html>"#)
        serve("https://brand.test/static/brand.png", png(oneInk: false))
        let icons = icons()
        #expect(icons.icon(for: "brand.test") == nil, "the globe while it comes")
        icons.load(URL(string: "https://brand.test/docs/page?x=1")!)
        try await until { icons.isKnown("brand.test") }
        #expect(icons.icon(for: "brand.test") != nil)

        // The next launch has it, without asking the site again.
        let asked = StubWeb.asked.count
        let next = self.icons()
        #expect(next.icon(for: "brand.test") != nil)
        next.load(URL(string: "https://brand.test/other")!)
        #expect(StubWeb.asked.count == asked)
    }

    /// A page that declares none: the site's /favicon.ico.
    @Test func withoutOneDeclaredItsFaviconIsUsed() async throws {
        defer { done() }
        StubWeb.answer("https://plain.test/", text: "<html><head><title>Plain</title></head></html>")
        serve("https://plain.test/favicon.ico", png(oneInk: false))
        let icons = icons()
        icons.load(URL(string: "https://plain.test/a")!)
        try await until { icons.isKnown("plain.test") }
        #expect(icons.icon(for: "plain.test") != nil)
    }

    /// A one-ink glyph, or nothing at all: the globe, and the site isn't asked again.
    @Test(arguments: ["glyph.test", "bare.test"])
    func noIconThatReadsWellShowsTheGlobe(host: String) async throws {
        defer { done() }
        StubWeb.answer("https://glyph.test/", text: #"<link rel="icon" href="/mark.png">"#)
        serve("https://glyph.test/mark.png", png(oneInk: true))
        let icons = icons()
        icons.load(URL(string: "https://\(host)/")!)
        try await until { icons.isKnown(host) }
        #expect(icons.icon(for: host) == nil)
        let asked = StubWeb.asked.count
        self.icons().load(URL(string: "https://\(host)/again")!)
        #expect(StubWeb.asked.count == asked, "not asked again")
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
    }
}
