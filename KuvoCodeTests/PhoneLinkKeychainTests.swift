import Foundation
import KuvoLink
import Security
import Testing
@testable import KuvoCode

/// This Mac's link keys as the keeper gives them to its box (`link/identity`): at login with
/// Background Work on, the keeper can start before your Keychain is unlocked. Keys it couldn't read
/// then are read again a while later, and none is ever made in their place. (The box's side, coming
/// back on the relay after a restart: the bridge's mac-restart tests.)
@MainActor
@Suite(.serialized) struct PhoneLinkKeychainTests {
    @Test func keysTheLockedKeychainWouldntGiveAreReadAgainLaterAndNeverStoodInFor() throws {
        let service = "run.kuvo.code.tests.phone-link.\(UUID().uuidString)"
        let file = FileManager.default.temporaryDirectory.appending(path: "phone-link-\(UUID().uuidString).json")
        let all: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        defer {
            Keychain.lockForTests(service, false)
            Keychain.delete(all)
            try? FileManager.default.removeItem(at: file)
        }
        func items() -> Int {
            var found: CFTypeRef?
            var query = all
            query[kSecMatchLimit as String] = kSecMatchLimitAll
            query[kSecReturnAttributes as String] = true
            return Keychain.copyMatching(query, &found) == errSecSuccess ? (found as? [Any])?.count ?? 0 : 0
        }

        // This Mac's keys, as the app made them before.
        let app = PhoneLink(file: file, keychain: service)
        app.hasMachines = { true }
        let mine = try #require(app.boxIdentity())
        #expect(items() == 3)

        // The keeper, started at login before the Keychain was unlocked: none, and none made.
        Keychain.lockForTests(service, true)
        let keeper = PhoneLink(file: file, keychain: service)
        keeper.hasMachines = { true }
        keeper.readAgainAfter = 3600
        #expect(keeper.boxIdentity() == nil)
        Keychain.lockForTests(service, false)
        #expect(items() == 3, "nothing written in their place")
        // Unlocked: not read again at once (the box asks every half a minute)…
        #expect(keeper.boxIdentity() == nil)
        // …but once it's time, they're this Mac's own.
        keeper.readAgainAfter = 0
        #expect(keeper.boxIdentity() == mine)
        #expect(items() == 3)
    }
}
