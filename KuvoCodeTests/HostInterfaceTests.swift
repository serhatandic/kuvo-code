import AppKit
import CryptoKit
import Foundation
import Testing
@testable import KuvoCode

/// What this Mac's box asks its app for (PROTOCOL.md, "Host interface"): Kuvo Code's own keys,
/// saved, read, listed and removed by name, as Settings and Edit Bot keep them, with the engine's
/// files kept in step. Nothing without the password, and nothing that isn't one of Kuvo Code's
/// keys. Over real HTTP; the Keychain is the test copy's own, in memory.
@MainActor
@Suite(.serialized) struct HostInterfaceTests {
    let host = HostInterface()
    let name = "KUVO_KEY_GITHUB_TOKEN__BOT_HOSTED"

    private func ask(_ path: String, _ body: [String: Any], password: String?, vaultSecret: String? = nil, at environment: [String: String]) async throws -> (status: Int, json: [String: Any]?) {
        let base = try #require(environment["KUVO_HOST_URL"])
        var request = URLRequest(url: try #require(URL(string: base + path)))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let password { request.setValue("Bearer \(password)", forHTTPHeaderField: "authorization") }
        if let vaultSecret {
            // As the box proves a vault call: an HMAC with the secret of the call, its body and when.
            let at = String(Int(Date().timeIntervalSince1970 * 1000))
            let body = try JSONSerialization.data(withJSONObject: body)
            let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
            let signed = Data("kuvo-host-vault-call\u{0}\(path.dropFirst())\u{0}\(hash)\u{0}\(at)".utf8)
            let auth = HMAC<SHA256>.authenticationCode(for: signed, using: SymmetricKey(data: Data(vaultSecret.utf8))).map { String(format: "%02x", $0) }.joined()
            request.setValue(auth, forHTTPHeaderField: "x-kuvo-vault-auth")
            request.setValue(at, forHTTPHeaderField: "x-kuvo-vault-at")
            request.httpBody = body
            let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func aKeySavedReadListedAndRemovedThroughTheHost() async throws {
        let environment = try await host.start()
        defer {
            host.stop()
            IntegrationKeys.set(nil, for: name)
        }
        let password = try #require(environment["KUVO_HOST_PASSWORD"])

        #expect(try await ask("/keys/set", ["name": name, "value": "ghp_hosted"], password: password, at: environment).status == 200)
        #expect(IntegrationKeys.value(name) == "ghp_hosted", "in the Keychain")
        let file = IntegrationKeys.folder.appending(path: name)
        #expect((try? String(contentsOf: file, encoding: .utf8)) == "ghp_hosted", "and the engine's file")

        #expect(try await ask("/keys/get", ["name": name], password: password, at: environment).json?["value"] as? String == "ghp_hosted")
        let listed = try await ask("/keys/names", ["suffix": "__BOT_HOSTED"], password: password, at: environment).json?["names"] as? [String]
        #expect(listed == [name])

        #expect(try await ask("/keys/delete", ["name": name], password: password, at: environment).status == 200)
        #expect(IntegrationKeys.value(name) == nil)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(try await ask("/keys/get", ["name": name], password: password, at: environment).status == 404)
    }

    /// The password is in the box's folder, which an agent's command can read: with it alone, the
    /// vault's values stay in the Keychain. Only the box, given the vault's secret as it starts
    /// (never written down), gets them.
    @Test func theVaultsValuesGoOnlyToTheBoxNotToWhatReadsItsFolder() async throws {
        let environment = try await host.start()
        let id = "v_hostedtest"
        defer {
            host.stop()
            _ = VaultValues.remove(id)
        }
        let password = try #require(environment["KUVO_HOST_PASSWORD"])
        #expect(VaultValues.set(["password": "kept-secret"], for: id))

        // As anything that read `run/host.json` would ask.
        #expect(try await ask("/vault/get", ["id": id], password: password, at: environment).status == 403)
        #expect(try await ask("/vault/set", ["id": id, "values": ["password": "replaced"]], password: password, at: environment).status == 403)
        #expect(try await ask("/vault/delete", ["id": id], password: password, at: environment).status == 403)
        #expect(try await ask("/vault/get", ["id": id], password: password, vaultSecret: "not-the-secret", at: environment).status == 403)
        #expect(VaultValues.values(id) == ["password": "kept-secret"], "nothing changed")

        // As the box asks, with the secret it was started with.
        let answer = try await ask("/vault/get", ["id": id], password: password, vaultSecret: host.vaultSecret, at: environment)
        #expect(answer.status == 200)
        #expect(answer.json?["values"] as? [String: String] == ["password": "kept-secret"])
    }

    @Test func nothingWithoutThePasswordNorForANameThatIsntKuvoCodes() async throws {
        let environment = try await host.start()
        defer {
            host.stop()
            IntegrationKeys.set(nil, for: name)
        }
        let password = try #require(environment["KUVO_HOST_PASSWORD"])
        IntegrationKeys.set("ghp_kept", for: name)

        #expect(try await ask("/keys/get", ["name": name], password: nil, at: environment).status == 401)
        #expect(try await ask("/keys/get", ["name": name], password: String(password.dropLast()) + (password.last == "0" ? "1" : "0"), at: environment).status == 401)
        #expect(try await ask("/keys/names", [:], password: "", at: environment).status == 401)
        #expect(try await ask("/keys/delete", ["name": name], password: "wrong", at: environment).status == 401)
        #expect(IntegrationKeys.value(name) == "ghp_kept", "untouched")

        // Only Kuvo Code's own keys, by name: no other Keychain item, and nothing that names a path.
        for other in ["com.apple.account", "KUVO_KEY_", "KUVO_KEY_../X", "kuvo_key_lower", "PHONE_LINK_SIGNING"] {
            #expect(try await ask("/keys/get", ["name": other], password: password, at: environment).status == 400, "\(other)")
            #expect(try await ask("/keys/set", ["name": other, "value": "x"], password: password, at: environment).status == 400, "\(other)")
        }
    }

    /// It proves it's the app to the box, which asks without the password (so nothing that took a
    /// left-behind port learns it): the box's nonce, signed with the password.
    @Test func itProvesItsTheAppWithoutBeingGivenThePassword() async throws {
        let environment = try await host.start()
        defer { host.stop() }
        let password = try #require(environment["KUVO_HOST_PASSWORD"])
        let nonce = UUID().uuidString
        let proof = try await ask("/hello", ["nonce": nonce], password: nil, at: environment).json?["proof"] as? String
        let address = try #require(environment["KUVO_HOST_URL"]?.replacingOccurrences(of: "http://", with: ""))
        #expect(proof == HostInterface.proof(of: nonce, at: address, password: password))
        #expect(proof != HostInterface.proof(of: nonce, at: address, password: "another"))
        #expect(proof != HostInterface.proof(of: nonce, at: "127.0.0.1:1", password: password), "for where the box reached it only")
        #expect(try await ask("/keys/names", [:], password: nil, at: environment).status == 401, "nothing else without it")
    }

    /// Quitting takes away where it told the box it answers, so nothing that takes its port later
    /// is asked for your keys.
    @Test func quittingTakesAwayWhereItAnswers() async throws {
        try await host.start()
        defer { host.stop() }
        #expect(FileManager.default.fileExists(atPath: HostInterface.file.path))
        NotificationCenter.default.post(name: NSApplication.willTerminateNotification, object: nil)
        #expect(!FileManager.default.fileExists(atPath: HostInterface.file.path), "gone as the app quits")
        #expect(!host.isAnswering)
    }

    /// While the keeper runs this Mac's box, the box reaches the open app through the keeper's host
    /// interface (its record in the box's folder). The app's own failing by itself (its listener
    /// gone, as after the Mac sleeps) leaves the keeper's record alone, and once the app answers
    /// again, at a new address, the keeper is told: what only the app answers (a phone's requests to
    /// the Mac's own routes) reaches it again, rather than "Kuvo Code on this Mac isn't answering"
    /// until the app quits (#190).
    @Test func theAppFailingByItselfLeavesTheKeepersRecordAndTheKeeperFindsItAgain() async throws {
        let keeper = HostInterface()
        keeper.appAnswers = false
        let app = HostInterface()
        app.tellsBox = false
        defer {
            app.restarted = nil
            app.stop()
            keeper.stop()
        }
        let environment = try await keeper.start()
        let password = try #require(environment["KUVO_HOST_PASSWORD"])
        let record = try Data(contentsOf: HostInterface.file)
        try await app.start()
        keeper.useApp(try #require(app.address))
        let (told, tell) = AsyncStream<Void>.makeStream()
        app.restarted = { [keeper, app] in
            keeper.useApp(app.address ?? [:])
            tell.yield()
        }
        #expect(try await ask("/sites/signed-in", [:], password: password, at: environment).status == 200, "the app, through the keeper")

        // Gone by itself, as its listener's failing has it: stopped, then said.
        app.stop()
        app.failedByItself()
        #expect((try? Data(contentsOf: HostInterface.file)) == record, "the keeper's record stays")

        for await _ in told { break }
        #expect(try await ask("/sites/signed-in", [:], password: password, at: environment).status == 200, "the app again, at its new address")
    }

    /// Try Again while it's starting (its retry, say) waits for that start: one listener, not a
    /// second that would go on answering with the password after it stops.
    @Test func twoStartsAtOnceAreOneListener() async throws {
        defer { host.stop() }
        async let first = host.start()
        async let second = host.start()
        let (a, b) = try await (first, second)
        #expect(a["KUVO_HOST_URL"] == b["KUVO_HOST_URL"])
        host.stop()
        for url in Set([a["KUVO_HOST_URL"], b["KUVO_HOST_URL"]].compactMap { $0 }) {
            await #expect(throws: (any Error).self, "nothing answers at \(url)") {
                _ = try await ask("/hello", ["nonce": UUID().uuidString], password: nil, at: ["KUVO_HOST_URL": url])
            }
        }
    }

    /// Whether the panel's browser is signed in to the sites the agent uses there, for Settings ›
    /// Integrations on a phone: each it can tell, as their cookies say; nothing without the password.
    @Test func whereThePanelsBrowserIsSignedIn() async throws {
        let environment = try await host.start()
        defer { host.stop() }
        let password = try #require(environment["KUVO_HOST_PASSWORD"])
        let sites = try #require(try await ask("/sites/signed-in", [:], password: password, at: environment).json?["sites"] as? [String: Bool])
        #expect(Set(sites.keys) == Set(Integrations.signInCookies.keys))
        #expect(sites.values.allSatisfy { !$0 }, "the test copy's browser is signed in nowhere")
        #expect(try await ask("/sites/signed-in", [:], password: nil, at: environment).status == 401)
    }

    /// The box the app starts (before its engine, or again after) can send this Mac's wake-ups,
    /// with the app's own kuvo-wake, and reach your Keychain through the app, which it's told is
    /// where its keys are: without that, it would keep keys in files of its own. Where the app
    /// answers is in the box's folder, only you can read it, never in its environment, and goes
    /// once the app stops answering.
    @Test func thisMacsBoxIsStartedAbleToSendWakeUpsAndReachYourKeychain() async throws {
        let app = AppModel()
        let environment = await app.ownBox.boxEnvironment(["PATH": "/usr/bin:/bin"])
        defer { app.host.stop() }
        #expect(environment["PATH"] == "/usr/bin:/bin", "your shell's, as it was")
        #expect(environment["KUVO_WAKE_COMMAND"] == WakeUps.command.path)
        #expect(FileManager.default.isExecutableFile(atPath: WakeUps.command.path), "kuvo-wake, there")
        #expect(environment["KUVO_KEYS_ON_HOST"] == "1")
        #expect(environment["KUVO_HOST_URL"] == nil && environment["KUVO_HOST_PASSWORD"] == nil, "nothing it runs has them")
        let said = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: HostInterface.file)) as? [String: String])
        #expect(said["url"]?.hasPrefix("http://127.0.0.1:") == true)
        #expect(said["password"]?.count == 64)
        let attributes = try FileManager.default.attributesOfItem(atPath: HostInterface.file.path)
        #expect((attributes[.posixPermissions] as? Int) == 0o600, "only you can read it")
        app.host.stop()
        #expect(!FileManager.default.fileExists(atPath: HostInterface.file.path), "gone once it stops")
        #expect(FileManager.default.fileExists(atPath: BoxProcess.home.appending(path: "bin/integrations.json").path), "this Mac's catalog")
    }
}
