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
