import Foundation
import LocalAuthentication
import Security
import WebKit

/// Sign-ins the panel's browser saved: in the login keychain as internet passwords, marked as Kuvo
/// Code's own (so other apps' items, like git's GitHub token, are never read), by site and
/// username. Filled in only when you click the key in the browser's toolbar, never on their own,
/// and never handed to the agent.
nonisolated enum Passwords {
    struct Login: Identifiable, Hashable, Sendable {
        var host: String
        var account: String
        var modified: Date?
        var id: String { host + "\n" + account }
    }

    /// Settings › Passwords: whether the browser offers to save a password you sign in with.
    static let offersKey = "passwords.offersToSave"
    /// Sites you chose Never for.
    static let neverKey = "passwords.never"

    static var offersToSave: Bool { UserDefaults.standard.object(forKey: offersKey) as? Bool ?? true }

    static var neverSites: [String] { UserDefaults.standard.stringArray(forKey: neverKey) ?? [] }

    /// Sites you let agents sign in to with their saved password, without asking you each time.
    static let agentSitesKey = "passwords.agentSignIn"
    /// The account each of those is for (by site): the one you allowed, not whichever is newest.
    static let agentAccountsKey = "passwords.agentSignInAccounts"

    static var agentSites: [String] { UserDefaults.standard.stringArray(forKey: agentSitesKey) ?? [] }

    private static var agentAccounts: [String: String] {
        UserDefaults.standard.dictionary(forKey: agentAccountsKey) as? [String: String] ?? [:]
    }

    static func setAgentSignIn(_ host: String, _ allowed: Bool, account: String? = nil) {
        var sites = agentSites.filter { $0 != host }
        var accounts = agentAccounts
        accounts[host] = nil
        if allowed {
            sites.append(host)
            accounts[host] = account
        }
        UserDefaults.standard.set(sites.sorted(), forKey: agentSitesKey)
        UserDefaults.standard.set(accounts, forKey: agentAccountsKey)
    }

    /// The saved login agents sign in to `host` with on their own, if you allowed that: the
    /// account you allowed it for.
    static func agentLogin(for host: String) -> Login? {
        guard agentSites.contains(host), let account = agentAccounts[host] else { return nil }
        return logins(for: host).first { $0.account == account }
    }

    /// Sites allowed before the account was kept get the one they'd have used then, the site's
    /// newest: a login saved after this isn't used without asking. Run once, at launch.
    static func keepAgentAccounts() {
        let accounts = agentAccounts
        let loose = agentSites.filter { accounts[$0] == nil }
        guard !loose.isEmpty else { return }
        for host in loose {
            // The keychain couldn't say (locked at launch): left for the next launch, not turned off.
            guard let saved = found(for: host) else { continue }
            if let newest = saved.first { setAgentSignIn(host, true, account: newest.account) } else { setAgentSignIn(host, false) }
        }
    }

    static func setNever(_ host: String, _ never: Bool) {
        var sites = neverSites.filter { $0 != host }
        if never { sites.append(host) }
        UserDefaults.standard.set(sites.sorted(), forKey: neverKey)
    }

    /// 'KUVO', the creator code on every item the app saves. A demo or test copy (another bundle
    /// ID) marks its own with 'KV' and two letters of its own, so it never lists, fills or
    /// deletes the passwords you saved in the app.
    private static let creator: OSType = {
        guard AppInfo.bundleID != "run.kuvo.code" else { return 0x4B55_564F }
        var hash: UInt32 = 2_166_136_261
        for byte in AppInfo.bundleID.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".utf8)
        return 0x4B56_0000 | OSType(letters[Int(hash % 36)]) << 8 | OSType(letters[Int(hash / 36 % 36)])
    }()

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassInternetPassword, kSecAttrCreator as String: creator]
    }

    /// Saved logins, every site's or one's, newest first.
    static func logins(for host: String? = nil) -> [Login] {
        found(for: host) ?? []
    }

    /// The saved logins, or nil when the keychain couldn't say (locked, say): none is `[]`.
    private static func found(for host: String?) -> [Login]? {
        var query = base
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        query[kSecReturnAttributes as String] = true
        if let host { query[kSecAttrServer as String] = host }
        var result: CFTypeRef?
        let status = Keychain.copyMatching(query, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { return nil }
        return items.compactMap { item in
            guard let host = item[kSecAttrServer as String] as? String else { return nil }
            return Login(host: host, account: item[kSecAttrAccount as String] as? String ?? "", modified: item[kSecAttrModificationDate as String] as? Date)
        }
        .sorted { ($0.modified ?? .distantPast) > ($1.modified ?? .distantPast) }
    }

    static func password(for login: Login) -> String? {
        var query = base
        query[kSecAttrServer as String] = login.host
        query[kSecAttrAccount as String] = login.account
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard Keychain.copyMatching(query, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Saves a login, or updates its password.
    @discardableResult
    static func save(host: String, account: String, password: String) -> Bool {
        var query = base
        query[kSecAttrServer as String] = host
        query[kSecAttrAccount as String] = account
        let data = Data(password.utf8)
        if Keychain.update(query, [kSecValueData as String: data]) == errSecSuccess { return true }
        query[kSecValueData as String] = data
        query[kSecAttrProtocol as String] = kSecAttrProtocolHTTPS
        query[kSecAttrLabel as String] = host
        query[kSecAttrDescription as String] = "Kuvo Code browser password"
        return Keychain.add(query) == errSecSuccess
    }

    static func delete(_ login: Login) {
        var query = base
        query[kSecAttrServer as String] = login.host
        query[kSecAttrAccount as String] = login.account
        Keychain.delete(query)
        // Agents no longer sign in with it on their own: a password saved later for the site isn't
        // theirs without asking.
        if agentSites.contains(login.host), agentAccounts[login.host] == login.account {
            setAgentSignIn(login.host, false)
        }
    }

    /// Asks for Touch ID or your Mac's password before showing or copying a password.
    static func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return true }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }

    /// The world the browser's password scripts run in, apart from the page's own scripts. Kept,
    /// as WebKit drops a world once nothing holds it.
    @MainActor static let world = WKContentWorld.world(name: "kuvo-passwords")
    static let messageName = "kuvoLogin"

    /// Spots a sign-in being sent (a form submitted, a button clicked, Return pressed with a password
    /// filled in) and tells the app the username and password, for it to offer saving them.
    static let captureScript = """
    (() => {
      const report = (scope) => {
        const fields = [...(scope || document).querySelectorAll('input')];
        const password = fields.find((field) => field.type === 'password' && field.value);
        // One the agent filled in came from its card, which asked whether to save it.
        if (!password || password.hasAttribute('data-kuvo-secret')) return;
        const before = fields.slice(0, fields.indexOf(password)).reverse();
        const user = before.find((field) => ['text', 'email', 'tel'].includes(field.type) && field.value)
          || fields.find((field) => (field.autocomplete || '').includes('username') && field.value);
        window.webkit.messageHandlers.\(messageName).postMessage({ username: user ? user.value : '', password: password.value });
      };
      document.addEventListener('submit', (event) => report(event.target), true);
      document.addEventListener('click', (event) => {
        const button = event.target.closest && event.target.closest('button, input[type=submit], [role=button]');
        if (button) report(button.closest('form') || document);
      }, true);
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.target.matches && event.target.matches('input')) report(event.target.closest('form') || document);
      }, true);
    })();
    """

    /// Fills the page's sign-in fields: the password field, and the username field before it (or,
    /// on a page that asks for the username first, the first one there is).
    static let fillScript = """
    // Only on the site the login is for: the toolbar's list can be a page behind. And over https,
    // where it was saved: over plain http it could be read on the way.
    if (location.hostname !== host || location.protocol !== 'https:') return false;
    const fields = [...document.querySelectorAll('input')].filter((field) => !field.disabled && field.type !== 'hidden');
    const set = (field, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const password = fields.find((field) => field.type === 'password');
    if (password) set(password, secret);
    const candidates = password ? fields.slice(0, fields.indexOf(password)).reverse() : fields;
    const user = candidates.find((field) => ['text', 'email', 'tel'].includes(field.type));
    if (user && username) set(user, username);
    return Boolean(password || user);
    """

    /// Whether the page has a field for a password or a username.
    static let hasLoginFieldScript = """
    return Boolean(document.querySelector('input[type=password], input[autocomplete~=username], input[type=email]'));
    """
}

/// A sign-in the browser saw, waiting for you to save it or not.
struct PendingLogin: Equatable {
    var host: String
    var account: String
    var password: String
    /// A saved login for the same site and username, with another password.
    var isUpdate: Bool
}

/// Takes the sign-in scripts' messages from every tab's page, and hands each to its tab.
final class PasswordCapture: NSObject, WKScriptMessageHandler {
    static let shared = PasswordCapture()
    /// The open tabs, by their web views.
    private let sessions = NSHashTable<BrowserSession>.weakObjects()

    func register(_ session: BrowserSession) {
        sessions.add(session)
    }

    /// Adds the script and its message handler to a configuration (once; windows a page opens
    /// share their opener's).
    static func install(in configuration: WKWebViewConfiguration) {
        let controller = configuration.userContentController
        guard !controller.userScripts.contains(where: { $0.source == Passwords.captureScript }) else { return }
        controller.addUserScript(WKUserScript(source: Passwords.captureScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: Passwords.world))
        controller.add(shared, contentWorld: Passwords.world, name: Passwords.messageName)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard Passwords.offersToSave, message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any], let password = body["password"] as? String, !password.isEmpty,
              let webView = message.webView,
              let session = sessions.allObjects.first(where: { $0.webView === webView }) else { return }
        let origin = message.frameInfo.securityOrigin
        // Secure pages only: those are where a saved password is filled in.
        guard origin.protocol == "https" else { return }
        let host = origin.host
        guard !Passwords.neverSites.contains(host) else { return }
        let account = (body["username"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let saved = Passwords.logins(for: host).first { $0.account == account }
        if let saved, Passwords.password(for: saved) == password { return }
        session.offerToSave(PendingLogin(host: host, account: account, password: password, isUpdate: saved != nil))
    }
}
