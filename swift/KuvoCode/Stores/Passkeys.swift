import WebKit

/// Passkeys in the browsers agents use (the panel's here, and a machine's, which sends the same
/// script): not yet. A page that asks for one hears at once that there's none, rather than waiting
/// on a prompt that can't show (a machine's browser draws its passkey dialog where no one sees it,
/// and that dialog held the page still, so "Try another way" couldn't be clicked). Sites then
/// offer a password or their other ways, and say they can't use a passkey here. Replaced where
/// every way of asking reaches it, `CredentialsContainer.prototype.get.call(…)` too, which goes
/// round anything put on `navigator.credentials` itself.
nonisolated enum Passkeys {
    /// Run in the page's own world before anything else, in every frame (as a machine's Chrome
    /// gets it too, `NO_PASSKEYS`), with this launch's event name in it.
    static let template = #"""
    (() => {
      try {
        // Says a passkey was asked for with an event only this launch's listener, in a world of its
        // own, knows the name of: nothing of it is left in the page's world. (Taken before the page
        // can change them.)
        const dispatch = EventTarget.prototype.dispatchEvent, Made = Event;
        const tell = () => {
          try {
            dispatch.call(window, new Made("KUVO_PASSKEY_EVENT"));
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

    /// The event the script fires when a passkey is asked for: a name of this launch's, which only
    /// the listener knows.
    static let eventName = "kuvo-" + UUID().uuidString.lowercased()
    static let script = template.replacingOccurrences(of: "KUVO_PASSKEY_EVENT", with: eventName)

    /// The world the listener runs in, apart from the page's: its message handler is seen there
    /// only (in the page's own, a site would see `window.webkit.messageHandlers`).
    @MainActor static let world = WKContentWorld.world(name: "KuvoPasskeys")

    /// Hears the script's event in each frame, and tells the app.
    static let listener = """
    window.addEventListener("\(eventName)", () => {
      try { window.webkit.messageHandlers.\(messageName).postMessage(""); } catch {}
    });
    """

    /// The message handler the listener tells a passkey was asked for through.
    static let messageName = "kuvoPasskey"

    /// Adds the script and its message handler to a configuration (once; windows a page opens
    /// share their opener's).
    @MainActor static func install(in configuration: WKWebViewConfiguration) {
        let controller = configuration.userContentController
        guard !controller.userScripts.contains(where: { $0.source == script }) else { return }
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        controller.addUserScript(WKUserScript(source: listener, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world))
        controller.add(PasskeyAsks.shared, contentWorld: world, name: messageName)
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
        let frame = message.frameInfo
        guard let site = Self.site(of: frame.securityOrigin) else { return }
        // A frame of another site in the page (a sign-in button) asking counts for the page too:
        // an ask names the page's site, the one the frame was loaded in (not wherever the tab
        // has gone since).
        let page = frame.isMainFrame ? site : frame.request.mainDocumentURL.flatMap { BrowserAgent.site(of: $0) } ?? site
        let session = message.webView.flatMap { webView in sessions.allObjects.first { $0.webView === webView } }
        // Asked again by the same page: said already.
        if let session, session.passkeySite == page { return }
        onAsked(page)
        if page != site { onAsked(site) }
        // Its note, while the tab's still on that site.
        if let session, BrowserAgent.site(of: session.webView.url) == page { session.passkeySite = page }
    }
}
