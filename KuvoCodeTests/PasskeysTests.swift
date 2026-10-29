import Foundation
import Testing
import WebKit
@testable import KuvoCode

/// Passkeys in the browsers agents use (the panel's here; a machine's Chrome gets the same
/// script): a page that asks for one hears at once that there's none, however it asks, so it
/// offers its other ways rather than waiting on a passkey prompt. A machine's Chrome draws that
/// prompt where no one sees it, and it held the sign-in page still.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct PasskeysTests {
    /// What a page's request for a passkey ends with: its error's message.
    private func asked(_ how: String) async throws -> String? {
        let configuration = WKWebViewConfiguration()
        Passkeys.install(in: configuration)
        let page = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
        let loaded = Loaded()
        page.navigationDelegate = loaded
        page.loadHTMLString("<!doctype html><title>Sign in</title><body>Sign in</body>", baseURL: URL(string: "https://accounts.example.com/")!)
        try await loaded.wait()
        let result = try await page.callAsyncJavaScript("""
            const publicKey = { challenge: new Uint8Array(32), timeout: 60000, allowCredentials: [] };
            let ask;
            if (how === "plain") ask = () => navigator.credentials.get({ publicKey });
            if (how === "prototype") ask = () => CredentialsContainer.prototype.get.call(navigator.credentials, { publicKey });
            if (how === "frame") {
              const frame = document.createElement("iframe");
              document.body.appendChild(frame);
              ask = () => frame.contentWindow.navigator.credentials.get({ publicKey });
            }
            if (how === "create") ask = () => navigator.credentials.create({ publicKey: { ...publicKey, rp: { name: "Example" }, user: { id: new Uint8Array(8), name: "me", displayName: "Me" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] } });
            return await Promise.race([
              ask().then(() => "a passkey", (error) => error.message),
              new Promise((done) => setTimeout(() => done("still waiting"), 3000)),
            ]);
            """, arguments: ["how": how], contentWorld: .page)
        return result as? String
    }

    @Test(arguments: ["plain", "prototype", "frame", "create"])
    func aPageAskingForAPasskeyHearsThereIsNone(how: String) async throws {
        #expect(try await asked(how) == "Passkeys can't be used in this browser.")
    }

    /// You're told plainly: the tab notes it for its page, and the agent's ask for that site (open
    /// already, or made soon after) says so. A page looking quietly whether passkeys are offered,
    /// as it loads, isn't asking: nothing's said.
    @Test func aSiteAskingForAPasskeyIsSaidOnItsTabAndItsAsks() async throws {
        TestEnvironment.prepare()
        let asks = BrowserAsks()
        var told: [String] = []
        PasskeyAsks.shared.onAsked = { site in
            told.append(site)
            asks.passkeyAsked(host: site, machine: nil)
            TestPulse.beat()
        }
        defer { PasskeyAsks.shared.onAsked = { _ in } }
        let tab = BrowserSession()
        tab.webView.loadHTMLString("<!doctype html><title>Sign in</title><body>Sign in</body>", baseURL: URL(string: "https://accounts.example.com/login")!)
        try await until { !tab.isLoading && tab.url != nil }
        // Nothing of it in the page's own world: a site that looks for an app's message handlers
        // (as some do, to turn in-app browsers away) finds none.
        #expect(try await tab.webView.callAsyncJavaScript("return typeof window.webkit", contentWorld: .page) as? String == "undefined")
        asks.add(BrowserAsks.Ask(id: "open", kind: .action(instruction: "Sign in"), host: "accounts.example.com", machine: nil, session: "ses_a")) { _ in }
        asks.add(BrowserAsks.Ask(id: "elsewhere", kind: .action(instruction: "Sign in"), host: "accounts.example.com", machine: "box", session: "ses_b")) { _ in }

        let publicKey = "{ challenge: new Uint8Array(32) }"
        _ = try? await tab.webView.callAsyncJavaScript("await navigator.credentials.get({ publicKey: \(publicKey), mediation: 'conditional' }).catch(() => {})", contentWorld: .page)
        _ = try? await tab.webView.callAsyncJavaScript("await navigator.credentials.get({ publicKey: \(publicKey) }).catch(() => {})", contentWorld: .page)
        try await until { tab.passkeySite == "accounts.example.com" }
        // (Pages' messages come in order: one from the quiet look would be here first.)
        #expect(told == ["accounts.example.com"])
        #expect(asks.asks.map(\.passkey) == [true, false], "only this Mac's browser's")
        asks.add(BrowserAsks.Ask(id: "later", kind: .code(prompt: ""), host: "accounts.example.com", machine: nil, session: "ses_a")) { _ in }
        #expect(asks.asks.last?.passkey == true)

        // Asked again by the same page: said once.
        _ = try? await tab.webView.callAsyncJavaScript("await navigator.credentials.get({ publicKey: \(publicKey) }).catch(() => {})", contentWorld: .page)

        // Gone once you leave the site; a page there asking is said for its own site.
        tab.webView.loadHTMLString("<!doctype html><title>Home</title><script>navigator.credentials.get({ publicKey: \(publicKey) }).catch(() => {})</script>", baseURL: URL(string: "https://example.org/")!)
        try await until { told.count == 2 }
        #expect(told == ["accounts.example.com", "example.org"])
        try await until { tab.passkeySite == "example.org" }
    }
}

@MainActor
private final class Loaded: NSObject, WKNavigationDelegate {
    private var done = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        done = true
        TestPulse.beat()
    }

    func wait() async throws {
        try await until { done }
    }
}
