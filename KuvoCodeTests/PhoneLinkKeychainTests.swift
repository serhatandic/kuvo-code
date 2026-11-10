import Foundation
import KuvoLink
import Security
import Testing
@testable import KuvoCode

/// This Mac's link keys as the keeper gives them to its box (`link/identity`): at login with
/// Background Work on, the keeper can start before your Keychain is unlocked. It reads them without
/// asking you (a prompt would hold up everything it answers), keys it couldn't read then are read
/// again a while later, and none is ever made in their place. (The box's side, coming back on the
/// relay after a restart: the bridge's mac-restart tests.)
@MainActor
@Suite(.serialized) struct PhoneLinkKeychainTests {
    private let service = "run.kuvo.code.tests.phone-link.\(UUID().uuidString)"
    private let file = FileManager.default.temporaryDirectory.appending(path: "phone-link-\(UUID().uuidString).json")
    private var all: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] }

    private func items() -> Int {
        var found: CFTypeRef?
        var query = all
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        query[kSecReturnAttributes as String] = true
        return Keychain.copyMatching(query, &found) == errSecSuccess ? (found as? [Any])?.count ?? 0 : 0
    }

    private func cleanUp() {
        Keychain.lockForTests(service, false)
        Keychain.delete(all)
        try? FileManager.default.removeItem(at: file)
    }

    /// This Mac's keys, as the app made them before.
    private func made() async throws -> (identity: [String: String], macKey: String?) {
        let app = PhoneLink(file: file, keychain: service)
        app.hasMachines = { true }
        let mine = try #require(await app.boxIdentity())
        #expect(items() == 3)
        return (mine, app.macKey)
    }

    @Test func keysTheLockedKeychainWouldntGiveAreReadAgainLaterAndNeverStoodInFor() async throws {
        defer { cleanUp() }
        let mine = try await made().identity

        // The keeper, started at login before the Keychain was unlocked: none, and none made.
        Keychain.lockForTests(service, true)
        let keeper = PhoneLink(file: file, keychain: service)
        keeper.hasMachines = { true }
        keeper.readAgainAfter = 3600
        #expect(await keeper.boxIdentity() == nil)
        Keychain.lockForTests(service, false)
        #expect(items() == 3, "nothing written in their place")
        // Unlocked: not read again at once (the box asks every half a minute)…
        #expect(await keeper.boxIdentity() == nil)
        // …but once it's time, they're this Mac's own.
        keeper.readAgainAfter = 0
        #expect(await keeper.boxIdentity() == mine)
        #expect(items() == 3)
    }

    /// Its box asking for them never asks you to unlock your Keychain (the keeper has no window, and
    /// a prompt you cancelled would keep the link off until a restart): while it's locked, the read
    /// fails at once, and it's tried again once you've unlocked it.
    @Test func theBoxsAskingNeverAsksYouToUnlockTheKeychainAndHasThemOnceItsUnlocked() async throws {
        defer { cleanUp() }
        let mine = try await made().identity

        Keychain.lockForTests(service, true, answer: errSecUserCanceled)
        let keeper = PhoneLink(file: file, keychain: service)
        keeper.hasMachines = { true }
        keeper.readAgainAfter = 0
        #expect(await keeper.boxIdentity() == nil)
        #expect(await keeper.boxIdentity() == nil, "still refused")
        #expect(Keychain.promptsForTests(service) == 0, "never asked")
        Keychain.lockForTests(service, false)
        #expect(items() == 3, "nothing made")
        #expect(await keeper.boxIdentity() == mine)
    }

    /// Two reading them for the first time at once (the app's own read and its box's asking, or the
    /// keeper's and the app's): one key each, the one kept, never one in use and another kept.
    @Test func keysMadeByTwoAtOnceAreOne() async throws {
        defer { cleanUp() }
        let first = PhoneLink(file: file, keychain: service), second = PhoneLink(file: file, keychain: service)
        first.hasMachines = { true }
        second.hasMachines = { true }
        async let one = first.boxIdentity()
        async let other = second.boxIdentity()
        let (a, b) = await (one, other)
        #expect(a != nil && a == b)
        #expect(first.macKey == second.macKey)
        #expect(items() == 3)
        let next = PhoneLink(file: file, keychain: service)
        next.hasMachines = { true }
        #expect(await next.boxIdentity() == a)
    }

    /// The open app reads them as it did (it may ask you). A prompt you said no to there leaves the
    /// link off, nothing made, and isn't shown again (its box's asking never reads them again this
    /// launch); the next launch reads them as they were.
    @Test func aPromptYouSaidNoToInTheAppIsntShownAgainThisLaunch() async throws {
        defer { cleanUp() }
        let (mine, macKey) = try await made()

        Keychain.lockForTests(service, true, answer: errSecUserCanceled)
        let app = PhoneLink(file: file, keychain: service)
        app.hasMachines = { true }
        app.readAgainAfter = 0
        #expect(app.macKey == nil, "you said no: not this Mac's, and no stand-in")
        #expect(app.macKey == nil)
        #expect(await app.boxIdentity() == nil)
        #expect(Keychain.promptsForTests(service) == 1, "asked once, not again")
        Keychain.lockForTests(service, false)
        #expect(await app.boxIdentity() == nil, "not read again this launch")
        #expect(items() == 3, "nothing made")

        let next = PhoneLink(file: file, keychain: service)
        next.hasMachines = { true }
        #expect(next.macKey != nil && next.macKey == macKey)
        #expect(await next.boxIdentity() == mine)
    }
}
