import ClientVault
import Foundation
import Security
import Testing
@testable import KuvoCode

/// This Mac's vault (PROTOCOL.md, "Vault"), kept by its own box (the real `kuvo-link.js serve`),
/// as the app reads it: the panel browser's saved sign-ins are its sign-ins. Those saved before
/// the vault move into it once, agents' own sign-ins with them, and they're there on every launch
/// after, without Settings › Vault opened first. The engine is a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct VaultOnBoxTests {
    static let enginePort: UInt16 = 47_911
    let engine = StubEngine(port: Int(enginePort))
    let box: TestBox

    init() async throws {
        box = try await TestBox(engine: engine.url)
        let client = box.client(engine: engine.url)
        Vaults.shared.client = { $0 == BoxClient.mac ? client : nil }
        Vaults.shared.forget(BoxClient.mac)
        for key in [Passwords.movedKey, Legacy.agentSitesKey, Legacy.agentAccountsKey] { UserDefaults.standard.removeObject(forKey: key) }
    }

    private func done() {
        Vaults.shared.forget(BoxClient.mac)
        Vaults.shared.client = { _ in nil }
        for key in [Passwords.movedKey, Legacy.agentSitesKey, Legacy.agentAccountsKey] { UserDefaults.standard.removeObject(forKey: key) }
        Keychain.delete([kSecClass as String: kSecClassInternetPassword])
        box.stop()
        engine.stop()
    }

    /// A sign-in as the browser saved it before the vault.
    private func savedBefore(_ host: String, _ account: String, _ password: String) {
        Keychain.add([
            kSecClass as String: kSecClassInternetPassword, kSecAttrCreator as String: Legacy.creator,
            kSecAttrServer as String: host, kSecAttrAccount as String: account, kSecValueData as String: Data(password.utf8),
        ])
    }

    @Test func signInsSavedBeforeTheVaultMoveIntoItOnceAndAreThereEachLaunch() async throws {
        defer { done() }
        savedBefore("github.com", "kuvo-bots", "first-password")
        savedBefore("github.com", "someone-else", "second-password")
        savedBefore("example.com", "", "third-password")
        // Agents signed in to GitHub on their own, with its first account.
        UserDefaults.standard.set(["github.com"], forKey: Legacy.agentSitesKey)
        UserDefaults.standard.set(["github.com": "kuvo-bots"], forKey: Legacy.agentAccountsKey)

        #expect(await Passwords.ready())
        let moved = Passwords.logins()
        #expect(Set(moved.map { "\($0.host) \($0.account)" }) == ["github.com kuvo-bots", "github.com someone-else", "example.com "])
        #expect(moved.map { Passwords.password(for: $0) ?? "" }.sorted() == ["first-password", "second-password", "third-password"])
        #expect(Passwords.agentLogin(for: "github.com")?.account == "kuvo-bots", "agents still sign in there on their own, with that account")
        #expect(Passwords.agentLogin(for: "example.com") == nil)
        #expect(Passwords.agentSites == ["github.com"])
        #expect(Legacy.found(for: nil) == [], "the old ones are gone once they're in the vault")
        // Settings › Vault shows them as the vault's sign-ins.
        let items = try #require(Vaults.shared[BoxClient.mac].vault?.items)
        #expect(Set(items.map(\.name)) == ["github.com", "github.com (someone-else)", "example.com"])
        #expect(items.allSatisfy { $0.kind == .login })

        // The next launch: nothing read yet, the move done. The browser finds them all the same,
        // and none moved twice.
        Vaults.shared.forget(BoxClient.mac)
        #expect(Passwords.logins().isEmpty)
        #expect(await Passwords.ready())
        #expect(Passwords.logins().count == 3)
        #expect(Passwords.agentLogin(for: "github.com")?.account == "kuvo-bots")
    }

    @Test func aMacWithNothingSavedBeforeHasAnEmptyVault() async throws {
        defer { done() }
        #expect(await Passwords.ready())
        #expect(Passwords.logins().isEmpty)
        #expect(Vaults.shared[BoxClient.mac].vault?.items == [])
        #expect(UserDefaults.standard.bool(forKey: Passwords.movedKey))
    }
}
