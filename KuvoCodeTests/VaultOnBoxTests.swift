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
        // The sign-ins saved as before the vault, and this Mac's vault's values.
        Keychain.delete([kSecClass as String: kSecClassInternetPassword, kSecAttrCreator as String: Legacy.creator])
        for item in Vaults.shared[BoxClient.mac].vault?.items ?? [] { _ = VaultValues.remove(item.id) }
        VaultValues.forgetFiles()
        Vaults.shared.forget(BoxClient.mac)
        Vaults.shared.client = { _ in nil }
        for key in [Passwords.movedKey, Legacy.agentSitesKey, Legacy.agentAccountsKey] { UserDefaults.standard.removeObject(forKey: key) }
        box.stop()
        engine.stop()
    }

    /// The account every agent signs in to `host` with on its own, as this Mac's vault grants it.
    private func agentsOwn(_ host: String) -> String? {
        guard let vault = Vaults.shared[BoxClient.mac].vault else { return nil }
        return vault.items.first { item in item.sites.contains(host) && vault.grants(for: item).contains { $0.who.everyone == true && $0.how == .own } }?.username
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
        #expect(agentsOwn("github.com") == "kuvo-bots", "agents still sign in there on their own, with that account")
        #expect(agentsOwn("example.com") == nil)
        #expect(Legacy.found(for: nil) == [], "the old ones are gone once they're in the vault")
        // Settings › Vault shows them as the vault's sign-ins.
        let items = try #require(Vaults.shared[BoxClient.mac].vault?.items)
        #expect(Set(items.map(\.name)) == ["github.com", "github.com (someone-else)", "example.com"])
        #expect(items.allSatisfy { $0.kind == .login })
        #expect(items.allSatisfy { $0.signInOnly == true }, "only for signing in, as before: never handed to a command")

        // The next launch: nothing read yet, the move done. The browser finds them all the same,
        // and none moved twice.
        Vaults.shared.forget(BoxClient.mac)
        #expect(Passwords.logins().isEmpty)
        #expect(await Passwords.ready())
        #expect(Passwords.logins().count == 3)
        #expect(agentsOwn("github.com") == "kuvo-bots")
    }

    @Test func aSignInSavedFromTheBrowserIsTheVaultsAndAgentsUseItAsYouSaid() async throws {
        defer { done() }
        #expect(await Passwords.ready())
        // Saved from a sign-in card with Let agents sign in here on their own ticked.
        let saved = await Passwords.save(host: "example.com", account: "me@example.com", password: "first-password", allowAgents: true)
        #expect(saved?.name == "example.com")
        #expect(agentsOwn("example.com") == "me@example.com", "agents sign in there on their own at once")
        #expect(saved?.signInOnly == true)

        // A new password for it, saved before this launch read the vault: the same sign-in, changed.
        Vaults.shared.forget(BoxClient.mac)
        #expect(await Passwords.save(host: "example.com", account: "me@example.com", password: "second-password") != nil)
        let logins = Passwords.logins(for: "example.com")
        #expect(logins.count == 1)
        #expect(logins.first.flatMap(Passwords.password(for:)) == "second-password")
        #expect(agentsOwn("example.com") == "me@example.com", "still theirs")
    }

    /// Any of your processes can read another's environment (`ps -E`), agents' commands among them:
    /// the box's password and the vault's secrets go to it on its stdin, so none of them is there.
    @Test func theBoxsSecretsAreNotInItsEnvironment() async throws {
        defer { done() }
        let pid = try #require(box.process.processID)
        let ps = Process()
        ps.executableURL = URL(filePath: "/bin/ps")
        ps.arguments = ["-Eww", "-o", "command=", "-p", String(pid)]
        let out = Pipe()
        ps.standardOutput = out
        try ps.run()
        ps.waitUntilExit()
        let shown = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(shown.contains("serve"), "it's the box: \(shown.prefix(200))")
        for name in ["OPENCODE_PASSWORD=", "KUVO_HOST_VAULT_SECRET=", "KUVO_VAULT_FILE_KEY="] {
            #expect(!shown.contains(name), "\(name) is in its environment")
        }
        // And it answers with them all the same.
        #expect(await Passwords.ready())
    }

    /// One an earlier build moved before it could be only for signing in: made so as the move
    /// finishes, as every sign-in moved from before is.
    @Test func aSignInMovedByAnEarlierBuildIsMadeOnlyForSigningIn() async throws {
        defer { done() }
        #expect(await Passwords.ready())
        UserDefaults.standard.removeObject(forKey: Passwords.movedKey)
        let early = try await Vaults.shared.add(VaultDraft(kind: .login, name: "github.com", sites: ["github.com"], username: "kuvo-bots", values: ["password": "first-password"]), on: BoxClient.mac)
        #expect(early.signInOnly != true)
        savedBefore("github.com", "kuvo-bots", "first-password")

        #expect(await Passwords.ready())
        let items = try #require(Vaults.shared[BoxClient.mac].vault?.items)
        #expect(items.count == 1, "not moved twice")
        #expect(items.first?.signInOnly == true)
    }

    /// The box runs with the engine's Bun, a file in the app's folder an agent's command could
    /// replace: one that isn't opencode's own any more doesn't start, and says so.
    @Test func theBoxDoesntStartWithAnEngineThatIsntOpencodesOwn() async throws {
        defer { done() }
        let other = BoxProcess()
        await other.start(engine: URL(filePath: "/bin/sh"), environment: ProcessInfo.processInfo.environment)
        #expect(other.endpoint == nil)
        #expect(other.failure?.contains("isn’t the one it downloaded") == true)
    }

    /// A machine's vault files put back to older copies while its box was stopped: this Mac, which
    /// remembers the newest it saw, notices, once; what it says now is remembered from then on.
    @Test func aMachinesVaultPutBackToOlderCopiesIsNoticed() {
        let machine = "test-machine-\(UUID().uuidString)"
        defer {
            UserDefaults.standard.removeObject(forKey: "vault.generations.\(machine)")
            done()
        }
        #expect(!Vaults.wentBack(machine, to: ["items": 3, "grants": 5, "paused": 1]), "the first look")
        Vaults.remember(machine, ["items": 3, "grants": 5, "paused": 1])
        #expect(!Vaults.wentBack(machine, to: ["items": 4, "grants": 5, "paused": 1]), "newer")
        Vaults.remember(machine, ["items": 4, "grants": 5, "paused": 1])
        #expect(Vaults.wentBack(machine, to: ["items": 4, "grants": 2, "paused": 1]), "its grants older than seen")
        // Its agents not paused yet (that didn't go): seen again.
        #expect(Vaults.wentBack(machine, to: ["items": 4, "grants": 2, "paused": 1]))
        // Paused: these from now on.
        Vaults.remember(machine, ["items": 4, "grants": 2, "paused": 1], replacing: true)
        #expect(!Vaults.wentBack(machine, to: ["items": 4, "grants": 3, "paused": 1]))
    }

    @Test func aMacWithNothingSavedBeforeHasAnEmptyVault() async throws {
        defer { done() }
        #expect(await Passwords.ready())
        #expect(Passwords.logins().isEmpty)
        #expect(Vaults.shared[BoxClient.mac].vault?.items == [])
        #expect(UserDefaults.standard.bool(forKey: Passwords.movedKey))
    }
}
