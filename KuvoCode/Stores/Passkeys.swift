import WebKit

/// Passkeys in the browsers agents use (the panel's here, and a machine's, which sends the same
/// script): not yet. A page that asks for one hears at once that there's none, rather than waiting
/// on a prompt that can't show (a machine's browser draws its passkey dialog where no one sees it,
/// and that dialog held the page still, so "Try another way" couldn't be clicked). Sites then
/// offer a password or their other ways, and say they can't use a passkey here. Replaced where
/// every way of asking reaches it, `CredentialsContainer.prototype.get.call(…)` too, which goes
/// round anything put on `navigator.credentials` itself.
nonisolated enum Passkeys {
    /// Run in the page's own world before anything else, in every frame.
    static let script = #"""
    (() => {
      try {
        // How the app (WebKit's message handler) or a machine's keeper (Chrome's binding) hears that
        // a passkey was asked for, taken before the page can change them.
        const handlers = window.webkit && window.webkit.messageHandlers, handler = handlers && handlers.kuvoPasskey;
        const binding = window.kuvoPasskeyAsked;
        // (Chrome's binding comes back a moment after the page does, so it's looked for a while.)
        const tell = (tries = 20) => {
          try {
            const chrome = binding || window.kuvoPasskeyAsked;
            if (handler) handler.postMessage("");
            else if (typeof chrome === "function") chrome("");
            else if (tries > 0) setTimeout(() => tell(tries - 1), 100);
          } catch {}
        };
        const none = (options) => {
          // Asked of you, not looked for quietly as the page loads.
          if (options.mediation !== "conditional") tell();
          return Promise.reject(new DOMException("Passkeys can't be used in this browser.", "NotAllowedError"));
        };
        const Container = window.CredentialsContainer;
        if (Container && Container.prototype) {
          const prototype = Container.prototype, get = prototype.get, create = prototype.create;
          if (get) prototype.get = function (options) { return options && options.publicKey ? none(options) : get.call(this, options); };
          if (create) prototype.create = function (options) { return options && options.publicKey ? none(options) : create.call(this, options); };
        }
        const Credential = window.PublicKeyCredential;
        if (Credential) {
          Credential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
          if (Credential.isConditionalMediationAvailable) Credential.isConditionalMediationAvailable = () => Promise.resolve(false);
        }
      } catch {}
    })();
    """#

    /// The message handler the script tells a passkey was asked for through.
    static let messageName = "kuvoPasskey"

    /// Adds the script and its message handler to a configuration (once; windows a page opens
    /// share their opener's).
    @MainActor static func install(in configuration: WKWebViewConfiguration) {
        let controller = configuration.userContentController
        guard !controller.userScripts.contains(where: { $0.source == script }) else { return }
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        controller.add(PasskeyAsks.shared, contentWorld: .page, name: messageName)
    }
}

/// Hears from every tab's pages that one asked for a passkey, with its site as WebKit has it (a
/// frame's own, not what the page says): the tab notes it for its page, and an agent's ask for
/// that site says so.
@MainActor
final class PasskeyAsks: NSObject, WKScriptMessageHandler {
    static let shared = PasskeyAsks()
    /// Told of each site that asked (the app's asks).
    var onAsked: (String) -> Void = { _ in }
    private let sessions = NSHashTable<BrowserSession>.weakObjects()

    func register(_ session: BrowserSession) {
        sessions.add(session)
    }

    /// The site as asks and Passwords name it.
    nonisolated static func site(of origin: WKSecurityOrigin) -> String? {
        switch origin.protocol {
        case "https": origin.host.isEmpty ? nil : origin.host
        case "http": origin.host.isEmpty ? nil : "http://" + origin.host
        case "file": "a file on this Mac"
        default: nil
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let site = Self.site(of: message.frameInfo.securityOrigin) else { return }
        // A frame of another site in the page (a sign-in button) asking counts for the page too:
        // an ask names the page's site.
        let page = message.webView.flatMap { BrowserAgent.site(of: $0.url) } ?? site
        onAsked(page)
        if page != site { onAsked(site) }
        guard let webView = message.webView, let session = sessions.allObjects.first(where: { $0.webView === webView }) else { return }
        session.passkeySite = page
    }
}
