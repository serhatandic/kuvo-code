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

    private func ask(_ path: String, _ body: [String: Any], password: String?, at environment: [String: String]) async throws -> (status: Int, json: [String: Any]?) {
        let base = try #require(environment["KUVO_HOST_URL"])
        var request = URLRequest(url: try #require(URL(string: base + path)))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let password { request.setValue("Bearer \(password)", forHTTPHeaderField: "authorization") }
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
        #expect(environment["KUVO_KEY_FILES"] == IntegrationKeys.folder.path)

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

    @Test func nothingWithoutThePasswordNorForANameThatIsntKuvoCodes() async throws {
        let environment = try await host.start()
        defer {
            host.stop()
            IntegrationKeys.set(nil, for: name)
        }
        let password = try #require(environment["KUVO_HOST_PASSWORD"])
        IntegrationKeys.set("ghp_kept", for: name)

        #expect(try await ask("/keys/get", ["name": name], password: nil, at: environment).status == 401)
        #expect(try await ask("/keys/get", ["name": name], password: String(password.dropLast()) + "0", at: environment).status == 401)
        #expect(try await ask("/keys/names", [:], password: "", at: environment).status == 401)
        #expect(try await ask("/keys/delete", ["name": name], password: "wrong", at: environment).status == 401)
        #expect(IntegrationKeys.value(name) == "ghp_kept", "untouched")

        // Only Kuvo Code's own keys, by name: no other Keychain item, and nothing that names a path.
        for other in ["com.apple.account", "KUVO_KEY_", "KUVO_KEY_../X", "kuvo_key_lower", "PHONE_LINK_SIGNING"] {
            #expect(try await ask("/keys/get", ["name": other], password: password, at: environment).status == 400, "\(other)")
            #expect(try await ask("/keys/set", ["name": other, "value": "x"], password: password, at: environment).status == 400, "\(other)")
        }
    }
}
