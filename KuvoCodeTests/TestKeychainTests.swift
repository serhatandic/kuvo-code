import Foundation
import Security
import Testing
@testable import KuvoCode

/// What the app keeps in the Keychain (integrations' keys, the phone link's keys) the tests keep in
/// a Keychain of their own, in memory: your login keychain never gets it, and no run waits on macOS
/// asking whether the tests' copy, signed anew with each build, may use what an earlier build kept.
@MainActor
@Suite(.serialized) struct TestKeychainTests {
    @Test func aKeySavedInTheTestsNeverReachesYourKeychain() {
        let name = "KUVO_KEY_TESTS_KEYCHAIN_PROBE"
        defer { IntegrationKeys.set(nil, for: name) }
        #expect(IntegrationKeys.set("tok_probe", for: name))
        #expect(IntegrationKeys.value(name) == "tok_probe", "kept, as the Keychain keeps it")
        #expect(IntegrationKeys.names.contains(name))
        // The login keychain, asked for the item's attributes only, which never prompts.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: AppInfo.bundleID + ".integrations",
            kSecAttrAccount as String: name,
            kSecReturnAttributes as String: true,
        ]
        #expect(SecItemCopyMatching(query as CFDictionary, nil) == errSecItemNotFound, "it's in your login keychain")

        IntegrationKeys.set(nil, for: name)
        #expect(IntegrationKeys.value(name) == nil)
        #expect(!IntegrationKeys.names.contains(name))
    }

    /// This Mac's key for its phones and machines, made the first time, is the same for the next
    /// phone link (the app's next launch), as the Keychain keeps it.
    @Test func thisMacsLinkKeyIsKept() {
        let file = AppInfo.testRoot.appending(path: "TestKeychain/\(UUID().uuidString).json")
        let first = PhoneLink(file: file).macKey
        #expect(first != nil, "the Keychain gave it out")
        #expect(PhoneLink(file: file).macKey == first)
    }
}
