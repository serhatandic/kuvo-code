import ClientVault
import Foundation
import LocalAuthentication
import OpenCodeKit
import Security
import WebKit

/// Sign-ins the panel's browser saved: this Mac's vault's sign-ins (`Vaults`, KuvoLink's
/// PROTOCOL.md "Vault"), one per site and username, their passwords in the Keychain under the
/// vault's own service (`VaultValues`). Filled in only when you click the key in the browser's
/// toolbar, or for an agent the vault lets sign in there, and never handed to the agent. Before
/// the vault, they were internet passwords marked as Kuvo Code's own, moved into it once.
@MainActor
enum Passwords {
    struct Login: Identifiable, Hashable, Sendable {
        var host: String
        var account: String
        var modified: Date?
        /// The vault's item.
        var item: String = ""
        var id: String { host + "\n" + account }
    }

    /// Settings › Vault: whether the browser offers to save a password you sign in with.
    static let offersKey = "passwords.offersToSave"
    /// Sites you chose Never for.
    static let neverKey = "passwords.never"

    static var offersToSave: Bool { UserDefaults.standard.object(forKey: offersKey) as? Bool ?? true }

    static var neverSites: [String] { UserDefaults.standard.stringArray(forKey: neverKey) ?? [] }

    private static var vault: Vault? { Vaults.shared[BoxClient.thisMac].vault }

    /// The vault's sign-in for each saved login.
    private static var signIns: [VaultItem] { vault?.items.filter { $0.kind == .login } ?? [] }

    private static func login(_ item: VaultItem) -> Login {
        Login(host: item.sites.first ?? "", account: item.username ?? "", modified: Date(timeIntervalSince1970: item.changed / 1000), item: item.id)
    }

    /// Saved logins, every site's or those for a page on `host` (its site's own, and those for a
    /// site it's under: example.com's on accounts.example.com), newest first.
    static func logins(for host: String? = nil) -> [Login] {
        let found = host.map { vault?.signIns(for: $0) ?? [] } ?? signIns
        return found.sorted { $0.changed > $1.changed }.map(login)
    }

    /// Its password, from this Mac's vault: in your Keychain, or once this Mac's box has moved into a
    /// home of its own (its vault's values its helper's then, which the app never reads), as its box
    /// gives it to its app (`kuvo/vault/items/<id>/values`, noted there as shown): the box attached in
    /// place (`SSHConnection.thisMac`), its own.
    static func password(for login: Login) async -> String? {
        guard !login.item.isEmpty else { return nil }
        guard OwnBoxHome.hasMoved else { return VaultValues.values(login.item)?["password"] }
        struct Values: Decodable { var values: [String: String] }
        return try? await Vaults.shared.ask(Values.self, "GET", VaultRoutes.values(login.item), on: SSHConnection.thisMac).values["password"]
    }

    /// Whether `password` is the one saved for `login`; nil when that can't be told (none saved, or
    /// not read now). Once this Mac's box has moved, its box tells (`kuvo/vault/items/<id>/same`),
    /// never giving the saved one, nor noting it as shown: nothing was.
    static func matches(_ password: String, _ login: Login) async -> Bool? {
        guard !login.item.isEmpty else { return nil }
        guard OwnBoxHome.hasMoved else { return VaultValues.values(login.item)?["password"].map { $0 == password } }
        struct Same: Decodable { var same: Bool }
        return try? await Vaults.shared.ask(Same.self, "POST", VaultRoutes.same(login.item), body: ["values": ["password": password]], on: SSHConnection.thisMac).same
    }

    /// What a sign-in answered with `password` is compared with (`BrowserAsks.handling`): the password
    /// saved for `login`, or, once this Mac's box has moved, one that's the same exactly when they
    /// are (`matches`), so the saved one is never read just to compare it. Nil with none saved.
    /// One the box can't compare now is taken for the saved one: never a password you typed, which
    /// would let agents use it without asking for your Touch ID; at worst a new one isn't saved.
    static func savedForComparing(_ password: String, _ login: Login?) async -> String? {
        guard let login else { return nil }
        guard OwnBoxHome.hasMoved else { return await self.password(for: login) }
        return await matches(password, login) == false ? "\u{0}" + password : password
    }

    /// Lets every agent sign in to `host` with the saved login for `account` on their own (or not),
    /// as this Mac's vault has it now.
    static func setAgentSignIn(_ host: String, _ allowed: Bool, account: String? = nil) async {
        await Vaults.shared.refresh(BoxClient.thisMac)
        for item in vault?.signIns(for: host) ?? [] where (account == nil || (item.username ?? "") == account) {
            try? await Vaults.shared.grant(item, to: .init(everyone: true), how: allowed ? .own : nil, on: BoxClient.thisMac)
        }
    }

    static func setNever(_ host: String, _ never: Bool) {
        var sites = neverSites.filter { $0 != host }
        if never { sites.append(host) }
        UserDefaults.standard.set(sites.sorted(), forKey: neverKey)
    }

    /// Saves a login, or changes its password, in this Mac's vault as it is now; with
    /// `allowAgents`, every agent signs in there with it on its own. Nil when it couldn't be saved.
    @discardableResult
    static func save(host: String, account: String, password: String, allowAgents: Bool = false) async -> VaultItem? {
        await Vaults.shared.refresh(BoxClient.thisMac)
        guard Vaults.shared[BoxClient.thisMac].vault != nil else { return nil }
        do {
            let item: VaultItem
            // One saved for the site it's under (example.com's, signing in on www.example.com) too.
            if let existing = Vaults.shared[BoxClient.thisMac].vault?.signIns(for: host).first(where: { ($0.username ?? "") == account }) {
                item = try await Vaults.shared.change(existing, to: VaultDraft(kind: .login, name: existing.name, sites: existing.sites, username: existing.username, values: ["password": password]), on: BoxClient.thisMac)
            } else {
                // Saved from the browser: for signing in there, never handed to a command.
                item = try await Vaults.shared.add(VaultDraft(kind: .login, name: freeName(host: host, account: account), sites: [host], username: account.isEmpty ? nil : account, signInOnly: true, values: ["password": password]), on: BoxClient.thisMac)
            }
            if allowAgents { try await Vaults.shared.grant(item, to: .init(everyone: true), how: .own, on: BoxClient.thisMac) }
            return item
        } catch {
            return nil
        }
    }

    /// A name no item has: the site's, or with its account.
    private static func freeName(host: String, account: String) -> String {
        let taken = Set((vault?.items ?? []).map { $0.name.lowercased() })
        for name in [host, account.isEmpty ? nil : "\(host) (\(account))"].compactMap({ $0 }) where !taken.contains(name.lowercased()) { return name }
        var number = 2
        while taken.contains("\(host) \(number)".lowercased()) { number += 1 }
        return "\(host) \(number)"
    }

    // MARK: Before the vault

    /// Done once the old sign-ins are in the vault.
    static let movedKey = "passwords.movedToVault"

    /// This Mac's vault read as the app starts, so the browser and agents find its sign-ins; then
    /// the sign-ins kept before the vault (internet passwords marked as Kuvo Code's own) moved into
    /// it, each with whether agents signed in with it on their own, each old one taken away once
    /// it's there. True once its box answered and there's none left to move.
    static func ready() async -> Bool {
        await Vaults.shared.refresh(BoxClient.thisMac)
        guard Vaults.shared[BoxClient.thisMac].vault != nil else { return false }
        if UserDefaults.standard.bool(forKey: movedKey) { return true }
        guard let found = await Task.detached(operation: { Legacy.found(for: nil) }).value else { return false }
        let allowed = Legacy.agentSites
        let accounts = Legacy.agentAccounts
        var left = false
        for old in found {
            guard let password = await Task.detached(operation: { Legacy.password(for: old) }).value else { left = true; continue }
            do {
                // One moved before, by a try that stopped before taking the old one away, is there.
                let item: VaultItem
                if let moved = signIns.first(where: { $0.sites.contains(old.host) && ($0.username ?? "") == old.account }) {
                    // (Moved by a build from before sign-ins could be only for signing in: made so now.)
                    item = moved.signInOnly == true ? moved : try await Vaults.shared.change(moved, to: VaultDraft(kind: .login, name: moved.name, sites: moved.sites, username: moved.username, signInOnly: true), on: BoxClient.thisMac)
                } else {
                    // What it was before: a sign-in the browser fills in, never handed to a command.
                    item = try await Vaults.shared.add(VaultDraft(kind: .login, name: freeName(host: old.host, account: old.account), sites: [old.host], username: old.account.isEmpty ? nil : old.account, signInOnly: true, values: ["password": password]), on: BoxClient.thisMac)
                }
                if allowed.contains(old.host), accounts[old.host] == old.account {
                    try await Vaults.shared.grant(item, to: .init(everyone: true), how: .own, on: BoxClient.thisMac)
                }
                Legacy.delete(old)
            } catch {
                left = true
            }
        }
        if !left {
            UserDefaults.standard.set(true, forKey: movedKey)
            UserDefaults.standard.removeObject(forKey: Legacy.agentSitesKey)
            UserDefaults.standard.removeObject(forKey: Legacy.agentAccountsKey)
        }
        return !left
    }

    /// Asks for Touch ID or your Mac's password before showing or copying a password.
    static func authenticate(reason: String) async -> Bool {
        guard AppInfo.mayPrompt("Touch ID") else { return false }
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return true }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }

    /// The world the browser's password scripts run in, apart from the page's own scripts. Kept,
    /// as WebKit drops a world once nothing holds it.
    @MainActor static let world = WKContentWorld.world(name: "kuvo-passwords")
    nonisolated static let messageName = "kuvoLogin"

    /// Spots a sign-in being sent (a form submitted, a button clicked, Return pressed with a password
    /// filled in) and tells the app the username and password, for it to offer saving them.
    nonisolated static let captureScript = """
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
      // A sign-in form a page's script puts in after it loaded (or on going to /login without
      // loading): told once it's there, for the toolbar's key.
      let had = Boolean(document.querySelector('input[type=password], input[autocomplete~=username], input[type=email]'));
      let looking = false;
      new MutationObserver(() => {
        if (had || looking) return;
        looking = true;
        setTimeout(() => {
          looking = false;
          had = Boolean(document.querySelector('input[type=password], input[autocomplete~=username], input[type=email]'));
          if (had) window.webkit.messageHandlers.\(messageName).postMessage({ fields: true });
        }, 200);
      }).observe(document.documentElement, { childList: true, subtree: true });
    })();
    """

    /// Fills the page's sign-in fields: the password field you see, and the username field before
    /// it (one marked as the username or an email first, so not a search box above the form); on a
    /// page that asks for the username first, that.
    nonisolated static let fillScript = """
    // Only on the page the login was offered for: the toolbar's list can be a page behind. And
    // over https, where it was saved: over plain http it could be read on the way.
    if (location.hostname !== host || location.protocol !== 'https:') return false;
    const shown = (field) => field.offsetParent !== null || field.getClientRects().length > 0;
    const fields = [...document.querySelectorAll('input')].filter((field) => !field.disabled && field.type !== 'hidden' && shown(field));
    const set = (field, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const password = fields.find((field) => field.type === 'password');
    if (password) set(password, secret);
    const candidates = password ? fields.slice(0, fields.indexOf(password)).reverse() : fields;
    const named = (field) => (field.autocomplete || '').split(/\\s+/).includes('username') || field.type === 'email';
    const user = candidates.find(named) || candidates.find((field) => ['text', 'email', 'tel'].includes(field.type) && field.type !== 'search' && !/search|query/i.test(field.name + ' ' + field.id + ' ' + (field.getAttribute('role') || '')));
    if (user && username) set(user, username);
    return Boolean(password || user);
    """

    /// Whether the page has a field for a password or a username.
    nonisolated static let hasLoginFieldScript = """
    return Boolean(document.querySelector('input[type=password], input[autocomplete~=username], input[type=email]'));
    """
}

/// The sign-ins as they were kept before the vault: read to move them, then taken away.
nonisolated enum Legacy {
    static let agentSitesKey = "passwords.agentSignIn"
    static let agentAccountsKey = "passwords.agentSignInAccounts"
    static var agentSites: [String] { UserDefaults.standard.stringArray(forKey: agentSitesKey) ?? [] }
    static var agentAccounts: [String: String] { UserDefaults.standard.dictionary(forKey: agentAccountsKey) as? [String: String] ?? [:] }

    /// 'KUVO', the creator code on every item the app saved. A demo or test copy (another bundle
    /// ID) marked its own with 'KV' and two letters of its own.
    static let creator: OSType = {
        guard AppInfo.bundleID != "run.kuvo.code" else { return 0x4B55_564F }
        var hash: UInt32 = 2_166_136_261
        for byte in AppInfo.bundleID.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".utf8)
        return 0x4B56_0000 | OSType(letters[Int(hash % 36)]) << 8 | OSType(letters[Int(hash / 36 % 36)])
    }()

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassInternetPassword, kSecAttrCreator as String: creator]
    }

    /// The logins kept, or nil when the keychain couldn't say (locked, say): none is `[]`.
    static func found(for host: String?) -> [Passwords.Login]? {
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
            return Passwords.Login(host: host, account: item[kSecAttrAccount as String] as? String ?? "", modified: item[kSecAttrModificationDate as String] as? Date)
        }
    }

    static func password(for login: Passwords.Login) -> String? {
        var query = base
        query[kSecAttrServer as String] = login.host
        query[kSecAttrAccount as String] = login.account
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard Keychain.copyMatching(query, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ login: Passwords.Login) {
        var query = base
        query[kSecAttrServer as String] = login.host
        query[kSecAttrAccount as String] = login.account
        Keychain.delete(query)
    }
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
        if message.frameInfo.isMainFrame, (message.body as? [String: Any])?["fields"] as? Bool == true {
            sessions.allObjects.first { $0.webView === message.webView }?.refreshLogins()
            return
        }
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
        Task { [weak session] in
            if let saved, await Passwords.matches(password, saved) == true { return }
            session?.offerToSave(PendingLogin(host: host, account: account, password: password, isUpdate: saved != nil))
        }
    }
}
