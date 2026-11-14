import ClientVault
import Foundation
import Observation
import KuvoLink
import Security
import Testing
import WebKit
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
        var passwords: [String] = []
        for login in moved { passwords.append(await Passwords.password(for: login) ?? "") }
        #expect(passwords.sorted() == ["first-password", "second-password", "third-password"])
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
        #expect(await Passwords.password(for: try #require(logins.first)) == "second-password")
        #expect(agentsOwn("example.com") == "me@example.com", "still theirs")
    }

    /// A phone answering a sign-in card (`POST kuvo/asks/<id>`) does what the Mac's card does:
    /// saves in the vault, and lets agents sign in there on their own, over https only; and a
    /// saved account whose password can't be read says so and keeps the card, rather than going
    /// as if answered while the agent still waits.
    @Test func aPhonesSignInAnswerIsTheCardsOverHttpsOnly() async throws {
        defer { done() }
        #expect(await Passwords.ready())
        let asks = BrowserAsks()
        let link = PhoneLink()
        link.browserAsks = asks
        func ask(_ host: String) -> String {
            // Each in a conversation of its own: one asking again soon after is answered as before.
            let id = UUID().uuidString
            asks.add(BrowserAsks.Ask(id: id, kind: .signIn(username: true, password: true), host: host, machine: nil, session: "ses_\(id)")) { _ in }
            return id
        }
        func phone(_ path: String, _ body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]?) {
            let request = LinkRequest(method: body == nil ? "GET" : "POST", path: path, headers: ["content-type": "application/json"],
                                      body: try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data())
            var status = 0
            var data = Data()
            for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:9/")!, password: nil, agents: nil) {
                switch part {
                case .head(let code, _): status = code
                case .body(let chunk): data += chunk
                }
            }
            return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        func listed(_ id: String) async throws -> [String: Any]? {
            try await (phone("kuvo/asks").json?["asks"] as? [[String: Any]])?.first { $0["id"] as? String == id }
        }

        // A page over http: never offered to save, and saving or agents asked for anyway are left out.
        let plain = ask("http://example.org")
        #expect(try await listed(plain)?["offersToSave"] as? Bool == false)
        #expect(try await phone("kuvo/asks/\(plain)", ["answer": "signIn", "username": "ada", "password": "plain-password", "save": true, "agents": true]).status == 200)
        #expect(Vaults.shared[BoxClient.mac].vault?.items == [], "nothing kept from a page over http")

        // Over https: saved, with agents signing in on their own as asked.
        let secure = ask("example.com")
        #expect(try await listed(secure)?["offersToSave"] as? Bool == true)
        #expect(try await phone("kuvo/asks/\(secure)", ["answer": "signIn", "username": "ada", "password": "first-password", "save": true, "agents": true]).status == 200)
        #expect(await Passwords.password(for: try #require(Passwords.logins(for: "example.com").first)) == "first-password")
        #expect(agentsOwn("example.com") == "ada", "Let agents sign in here on their own, from the phone")

        // A saved account picked, with agents allowed: theirs too.
        #expect(await Passwords.save(host: "github.com", account: "kuvo-bots", password: "bots-password") != nil)
        let github = ask("github.com")
        #expect(try await phone("kuvo/asks/\(github)", ["answer": "signIn", "saved": "kuvo-bots", "agents": true]).status == 200)
        #expect(agentsOwn("github.com") == "kuvo-bots", "agents allowed for a saved account (the phone asked for Face ID)")

        // Its password typed anew (the account saved, so nothing offered to save): kept, or agents
        // would sign in with the old one.
        let changed = ask("github.com")
        #expect(try await listed(changed)?["offersToSave"] as? Bool == false)
        #expect(try await phone("kuvo/asks/\(changed)", ["answer": "signIn", "username": "kuvo-bots", "password": "new-bots-password", "save": false]).status == 200)
        #expect(await Passwords.password(for: try #require(Passwords.logins(for: "github.com").first)) == "new-bots-password")

        // A saved account whose password this Mac can't read: says so, and the card stays.
        let item = try #require(Vaults.shared[BoxClient.mac].vault?.signIns(for: "github.com").first)
        #expect(VaultValues.remove(item.id))
        let unreadable = ask("github.com")
        let refused = try await phone("kuvo/asks/\(unreadable)", ["answer": "signIn", "saved": "kuvo-bots"])
        #expect(refused.status == 422)
        #expect((refused.json?["message"] as? String)?.contains("couldn’t be read") == true)
        #expect(asks.asks.map(\.id) == [unreadable], "still waiting to be answered another way")
    }

    /// Shows `html` in the panel's browser as the page at `address`, once it's finished.
    private func show(_ html: String, at address: String, in browser: BrowserSession) async {
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            browser.onVisit = { _, _, _ in
                browser.onVisit = nil
                finished.resume()
            }
            browser.webView.loadHTMLString(html, baseURL: URL(string: address))
        }
    }

    private func value(of id: String, in browser: BrowserSession) async -> String? {
        try? await browser.webView.evaluateJavaScript("document.getElementById('\(id)').value") as? String
    }

    /// Saved for example.com, as the Vault's placeholder has it: offered and filled on
    /// accounts.example.com, and a new password signing in on www.example.com changes it rather
    /// than saving a second. Filled into the form you see: not the search box above it, nor a
    /// hidden form's fields.
    @Test func aSignInForASiteIsOfferedAndFilledOnPagesUnderIt() async throws {
        defer { done() }
        #expect(await Passwords.ready())
        #expect(await Passwords.save(host: "example.com", account: "ada", password: "first-password") != nil)
        #expect(Passwords.logins(for: "accounts.example.com").map(\.account) == ["ada"])
        #expect(Passwords.logins(for: "notexample.com").isEmpty)

        #expect(await Passwords.save(host: "www.example.com", account: "ada", password: "second-password") != nil)
        let logins = Passwords.logins(for: "www.example.com")
        #expect(logins.count == 1, "changed, not saved twice")
        let login = try #require(logins.first)
        #expect(await Passwords.password(for: login) == "second-password")

        let browser = BrowserSession()
        defer { browser.close() }
        await show("""
            <input id="search" type="text" placeholder="Search">
            <form style="display:none"><input id="new-user" type="text"><input id="new-password" type="password"></form>
            <form><input id="user" type="text" autocomplete="username"><input id="password" type="password"></form>
            """, at: "https://accounts.example.com/login", in: browser)
        #expect(browser.savedLogins.map(\.account) == ["ada"], "the toolbar's key offers it")
        await browser.fill(login)?.value
        #expect(await value(of: "user", in: browser) == "ada")
        #expect(await value(of: "password", in: browser) == "second-password")
        #expect(await value(of: "search", in: browser) == "")
        #expect(await value(of: "new-password", in: browser) == "")
    }

    /// A sign-in form a page's script puts in after it loaded: the toolbar's key comes with it.
    @Test func aSignInFormThatComesLaterGetsTheKey() async throws {
        defer { done() }
        #expect(await Passwords.ready())
        #expect(await Passwords.save(host: "app.example.com", account: "ada", password: "first-password") != nil)
        let browser = BrowserSession()
        defer { browser.close() }
        await show("""
            <div id="app">Loading…</div>
            <script>setTimeout(() => { document.getElementById('app').innerHTML = '<input type="email"><input type="password">' }, 50)</script>
            """, at: "https://app.example.com/", in: browser)
        while !browser.hasLoginField {
            await withCheckedContinuation { (changed: CheckedContinuation<Void, Never>) in
                withObservationTracking { _ = browser.hasLoginField } onChange: { changed.resume() }
            }
        }
        #expect(browser.savedLogins.map(\.account) == ["ada"])
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

    /// The vault's file key as a build from before kept it, alone: kept with its generations from
    /// now on, its files' own taken once, rather than its vault refused for good.
    @Test func theVaultsKeyFromAnEarlierBuildIsKeptWithItsGenerations() {
        defer { done() }
        VaultValues.forgetFiles()
        let earlier = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        Keychain.add([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "run.kuvo.code") + ".vault",
                      kSecAttrAccount as String: "files", kSecValueData as String: earlier])
        #expect(VaultValues.fileKey() == earlier.base64URL, "the same key")
        #expect(VaultValues.generations()?.adopt == true, "its files' own taken once")
        #expect(VaultValues.remember("items", generation: 4))
        #expect(VaultValues.generations()?.adopt == false)
        #expect(VaultValues.generations()?.generations == ["items": 4])
    }

    /// This Mac's box's answers, some held until the test lets them go: the second time a route is
    /// asked, and the first time of the asks (so a read can be stopped half way, and another begun).
    nonisolated private final class HeldRoutes: @unchecked Sendable {
        private let lock = NSLock()
        private var asked: [String: Int] = [:]
        private var held: [(route: String, count: Int, resume: CheckedContinuation<Void, Never>)] = []
        private var open = false

        func pass(_ route: String) async {
            let hold = lock.withLock { () -> Bool in
                asked[route, default: 0] += 1
                return !open && (asked[route]! > 1 || route == VaultRoutes.asks)
            }
            guard hold else { return }
            await withCheckedContinuation { resume in
                lock.withLock { held.append((route, asked[route] ?? 0, resume)) }
                TestPulse.beat()
            }
        }

        func isHolding(_ route: String, _ count: Int) -> Bool {
            lock.withLock { held.contains { $0.route == route && $0.count == count } }
        }

        func release(_ route: String, _ count: Int) {
            let resume = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                guard let index = held.firstIndex(where: { $0.route == route && $0.count == count }) else { return nil }
                return held.remove(at: index).resume
            }
            resume?.resume()
        }

        func releaseAll() {
            let resumes = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                open = true
                defer { held = [] }
                return held.map(\.resume)
            }
            for resume in resumes { resume.resume() }
        }
    }

    /// Another reader (a conversation's, every few seconds) begins a read of the vault while this
    /// one is half way: this one's answer is still what shows once it's in, rather than nothing
    /// (the browser's sign-ins and a saved password found no vault, as though its box hadn't
    /// answered), and the later read's replaces it when it comes.
    @Test func aReadAnotherOvertookStillShowsWhatItRead() async throws {
        defer { done() }
        let routes = HeldRoutes()
        // Whatever stays held when an expectation fails midway is let go, not left suspended.
        defer { routes.releaseAll() }
        let base = try #require(URL(string: engine.url + "/"))
        Vaults.shared.client = { $0 == BoxClient.mac ? BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            AsyncThrowingStream { answer in
                let task = Task {
                    await routes.pass(request.path)
                    do {
                        for try await part in PhoneLink.respond(to: request, link: nil, engine: base, password: "test", agents: nil) { answer.yield(part) }
                        answer.finish()
                    } catch { answer.finish(throwing: error) }
                }
                answer.onTermination = { _ in task.cancel() }
            }
        }) : nil }
        Vaults.shared.forget(BoxClient.mac)

        let first = Task { await Vaults.shared.refresh(BoxClient.mac) }
        try await until { routes.isHolding(VaultRoutes.asks, 1) }
        let later = Task { await Vaults.shared.refresh(BoxClient.mac) }
        try await until { routes.isHolding(VaultRoutes.vault, 2) }
        routes.release(VaultRoutes.asks, 1)
        await first.value
        #expect(Vaults.shared[BoxClient.mac].vault != nil, "what the first read found shows while the later one is on its way")

        routes.releaseAll()
        await later.value
        #expect(Vaults.shared[BoxClient.mac].vault != nil)
    }

    @Test func aMacWithNothingSavedBeforeHasAnEmptyVault() async throws {
        defer { done() }
        #expect(await Passwords.ready())
        #expect(Passwords.logins().isEmpty)
        #expect(Vaults.shared[BoxClient.mac].vault?.items == [])
        #expect(UserDefaults.standard.bool(forKey: Passwords.movedKey))
    }
}
