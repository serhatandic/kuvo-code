#if os(macOS)
import Foundation
import Security

/// Kuvo Code's items for a Mac's box in the legacy (file) keychain, where they've always been: a
/// generic password each, by service (`<bundle ID>.phone-link`, `.integrations`, `.vault`) and
/// account. Used by the box's helper (its own items) and by the app's keeper (copying its items for
/// the helper, #333 piece 4). It never asks you anything: a read macOS would ask about (a locked
/// Keychain, a program not in the item's list) is refused, and said so. An item is made with the
/// programs that may read it named at creation (`SecAccessCreate`), never by changing the list of
/// one that's there, which macOS asks you about once per item.
///
/// Tests (and only tests) give it a keychain file of their own, made with `security create-keychain`
/// in their folder: it then reads and writes only that file, never your login keychain.
public struct HostKeychain: Sendable {
    /// What a read found.
    public enum Read: Equatable, Sendable {
        case found(Data)
        case missing
        /// The Keychain wouldn't give it out without asking (`OSStatus`): locked, or this program
        /// isn't one the item names.
        case refused(OSStatus)

        public var data: Data? {
            if case .found(let data) = self { return data }
            return nil
        }
    }

    /// One item, as listed (no secret read).
    public struct Item: Equatable, Sendable {
        public var account: String
        public var label: String?
    }

    /// A test's keychain file and its password; nil: the login keychain, as macOS finds it.
    private let file: String?
    private let password: String?

    /// The Keychain as macOS finds it for you (your login keychain).
    public init() {
        file = nil
        password = nil
    }

    /// A test's own keychain file, unlocked with `password`, and nothing else.
    public init(testFile: String, password: String) {
        file = testFile
        self.password = password
    }

    /// Whether it reads only a test's file.
    public var isTests: Bool { file != nil }

    /// The test's file, opened and unlocked (each time: a `SecKeychain` isn't one to share).
    private func testKeychain() -> SecKeychain? {
        guard let file else { return nil }
        var keychain: SecKeychain?
        guard SecKeychainOpen(file, &keychain) == errSecSuccess, let keychain else { return nil }
        if let password { _ = SecKeychainUnlock(keychain, UInt32(password.utf8.count), password, true) }
        return keychain
    }

    /// `query`, kept to the test's file where there is one.
    private func scoped(_ query: [String: Any], adding: Bool = false) -> [String: Any]? {
        var query = query
        query[kSecUseDataProtectionKeychain as String] = false
        guard file != nil else { return query }
        guard let keychain = testKeychain() else { return nil }
        if adding { query[kSecUseKeychain as String] = keychain } else { query[kSecMatchSearchList as String] = [keychain] }
        return query
    }

    /// Whether the keychain the items are in is locked now: a read then would ask you to unlock it.
    public var isLocked: Bool {
        var keychain: SecKeychain?
        if file != nil { keychain = testKeychain() } else { _ = SecKeychainCopyDefault(&keychain) }
        var status: SecKeychainStatus = 0
        guard let keychain, SecKeychainGetStatus(keychain, &status) == errSecSuccess else { return false }
        return status & SecKeychainStatus(kSecUnlockStateStatus) == 0
    }

    private static func base(_ service: String, _ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    /// An item's secret.
    public func read(_ service: String, _ account: String) -> Read {
        if isLocked { return .refused(errSecInteractionNotAllowed) }
        var query = Self.base(service, account)
        query[kSecReturnData as String] = true
        guard let query = scoped(query) else { return .refused(errSecNoSuchKeychain) }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess: return (result as? Data).map(Read.found) ?? .missing
        case errSecItemNotFound: return .missing
        default: return .refused(status)
        }
    }

    /// The items of `service`, by account (and label), with no secret read, so it never asks: nil
    /// when the Keychain won't list them.
    public func items(_ service: String) -> [Item]? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        guard let query = scoped(query) else { return nil }
        var result: CFTypeRef?
        switch SecItemCopyMatching(query as CFDictionary, &result) {
        case errSecSuccess:
            let found = (result as? [[String: Any]]) ?? []
            return found.compactMap { item in
                (item[kSecAttrAccount as String] as? String).map { Item(account: $0, label: item[kSecAttrLabel as String] as? String) }
            }.sorted { $0.account < $1.account }
        case errSecItemNotFound: return []
        default: return nil
        }
    }

    /// Whether an item is there (no secret read); nil when the Keychain won't say.
    public func exists(_ service: String, _ account: String) -> Bool? {
        var query = Self.base(service, account)
        query[kSecReturnAttributes as String] = true
        guard let query = scoped(query) else { return nil }
        var result: CFTypeRef?
        switch SecItemCopyMatching(query as CFDictionary, &result) {
        case errSecSuccess: return true
        case errSecItemNotFound: return false
        default: return nil
        }
    }

    /// A new item (`errSecDuplicateItem` where there's one). `trusting`: the programs (app bundles,
    /// by their designated requirement) that may read it without asking, named as it's made; nil,
    /// the program making it, as macOS does by itself.
    @discardableResult
    public func add(_ service: String, _ account: String, _ data: Data, label: String?, trusting programs: [URL]? = nil) -> OSStatus {
        var item = Self.base(service, account)
        item[kSecValueData as String] = data
        if let label { item[kSecAttrLabel as String] = label }
        // Bots work overnight, with the Mac locked: readable once it's been unlocked since it started.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        if let programs {
            var trusted: [SecTrustedApplication] = []
            for program in programs {
                var application: SecTrustedApplication?
                let status = SecTrustedApplicationCreateFromPath(program.path(percentEncoded: false), &application)
                guard status == errSecSuccess, let application else { return status }
                trusted.append(application)
            }
            var access: SecAccess?
            let status = SecAccessCreate((label ?? service) as CFString, trusted as CFArray, &access)
            guard status == errSecSuccess, let access else { return status }
            item[kSecAttrAccess as String] = access
        }
        guard let item = scoped(item, adding: true) else { return errSecNoSuchKeychain }
        return SecItemAdd(item as CFDictionary, nil)
    }

    /// An item's secret changed, or the item made (by and for this program) where there's none.
    @discardableResult
    public func set(_ service: String, _ account: String, _ data: Data, label: String?) -> OSStatus {
        guard let query = scoped(Self.base(service, account)) else { return errSecNoSuchKeychain }
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecItemNotFound else { return updated }
        return add(service, account, data, label: label)
    }

    /// An item taken away (`errSecItemNotFound` where there's none). Only a program the item names
    /// may: macOS refuses another without asking.
    @discardableResult
    public func delete(_ service: String, _ account: String) -> OSStatus {
        guard let query = scoped(Self.base(service, account)) else { return errSecNoSuchKeychain }
        return SecItemDelete(query as CFDictionary)
    }

    /// For a process with no one to answer macOS (the helper, a test): anything that would ask you
    /// fails at once instead.
    public static func neverAsk() {
        SecKeychainSetUserInteractionAllowed(false)
    }
}
#endif
