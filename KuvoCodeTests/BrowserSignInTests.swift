import Foundation
import Testing
import WebKit
@testable import KuvoCode

/// The panel browser around signing in (C5): the offer to save a password stays through where
/// signing in leads (accounts.google.com to myaccount.google.com, a sign-in service sending you
/// back) and leaves once you've gone elsewhere; a sign-in window that closes itself hands its
/// offer to the page that opened it; and an address on this Mac or its network opens over plain
/// http, as its dev server answers. Real WebKit, pages from strings at the addresses they'd be on.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BrowserSignInTests {
    init() { TestEnvironment.prepare() }

    /// Shows `html` as the page at `address`, once it's finished.
    private func show(_ html: String = "<p>Signed in</p>", at address: String, in browser: BrowserSession) async {
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            browser.onVisit = { _, _, _ in
                browser.onVisit = nil
                finished.resume()
            }
            browser.webView.loadHTMLString(html, baseURL: URL(string: address))
        }
    }

    private let login = PendingLogin(host: "accounts.example.com", account: "ada", password: "correct horse", isUpdate: false)

    @Test func theOfferToSaveStaysThroughWhereSigningInLeads() async {
        let browser = BrowserSession()
        defer { browser.close() }
        browser.offerToSave(login)
        await show(at: "https://myaccount.example.com/", in: browser)
        #expect(browser.pendingLogin == login, "the same site's page signing in led to")

        // A sign-in service sending you back to a site of another name: still offered there.
        browser.offerToSave(login)
        await show(at: "https://outlook.example.org/mail", in: browser)
        #expect(browser.pendingLogin == login)
        await show(at: "https://news.example.net/", in: browser)
        #expect(browser.pendingLogin == nil, "gone elsewhere since: it doesn't follow you around")
    }

    @Test func aSignInWindowClosingHandsItsOfferToItsPage() throws {
        let panel = Utilities()
        defer { panel.closeAll() }
        panel.inView = .init(session: "ses_signin")
        let page = panel.newBrowser()
        let pageTab = try #require(panel.browsers.first { $0.value === page }?.key)
        let window = panel.newBrowser(configuration: WKWebViewConfiguration(), openedFrom: pageTab)
        window.offerToSave(login)
        window.onClose?()
        #expect(!panel.browsers.values.contains { $0 === window }, "the window's tab is gone")
        #expect(page.pendingLogin == login, "its page offers to save the password")
    }

    @Test func anAddressOnThisMacOrItsNetworkOpensOverHTTP() {
        for local in ["localhost:3000", "127.0.0.1:8080", "192.168.1.5:3000", "10.0.0.2", "app.localhost:5173", "shop.test", "printer.local", "devbox:3000", "100.101.1.2:8080", "0.0.0.0:4000"] {
            #expect(BrowserSession.url(from: local)?.scheme == "http", "\(local)")
        }
        for site in ["example.com", "example.com/docs", "172.32.0.1"] {
            #expect(BrowserSession.url(from: site)?.scheme == "https", "\(site)")
        }
    }
}
