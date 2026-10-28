import Foundation
import Security

/// This Mac's vault's values (KuvoLink's PROTOCOL.md, "Vault"), in the Keychain: one item each, by
/// its id, its values as JSON. Its box keeps everything else about them and asks for these through
/// the host interface (`vault/get`, `vault/set`, `vault/delete`), only to fill or run with them, or
/// for a client to show one. A demo or test copy keeps its own, under its own bundle ID.
nonisolated enum VaultValues {
    private static var service: String { (Bundle.main.bundleIdentifier ?? "run.kuvo.code") + ".vault" }

    /// An item's id, as the box makes them.
    static func isItem(_ id: String) -> Bool {
        id.hasPrefix("v_") && id.count == 12 && id.dropFirst(2).allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
    }

    private static func query(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
    }

    /// Its values, or nil for one that isn't kept (or a Keychain that won't say).
    static func values(_ id: String) -> [String: String]? {
        var item = query(id)
        item[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard Keychain.copyMatching(item, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
    }

    /// Keeps its values, in place of those before.
    static func set(_ values: [String: String], for id: String) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]) else { return false }
        let updated = Keychain.update(query(id), [kSecValueData as String: data])
        if updated == errSecSuccess { return true }
        guard updated == errSecItemNotFound else { return false }
        var item = query(id)
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Kuvo Code vault item"
        // Bots work overnight, with the Mac locked: readable once it's been unlocked since it started.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return Keychain.add(item) == errSecSuccess
    }

    /// Takes it away (nothing for one that wasn't kept).
    static func remove(_ id: String) -> Bool {
        let status = Keychain.delete(query(id))
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
