import Foundation
import Security

/// Where keys pasted into the usage panel are kept (fork addition: upstream saved them in a JSON
/// file). One secret per provider, by the provider's ID.
protocol APIKeySecrets: Sendable {
    func read(_ account: String) -> String?
    func write(_ account: String, _ value: String) throws
    func delete(_ account: String) throws
}

/// The login Keychain: one generic password per provider, under the host app's bundle ID, labeled so
/// it's easy to find in Keychain Access ("Kuvo Code API key (openrouter)").
struct KeychainAPIKeySecrets: APIKeySecrets {
    struct Failure: Error {
        let status: OSStatus
    }

    var service = HostApp.bundleIdentifier + ".usage-api-key"

    func read(_ account: String) -> String? {
        var query = item(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8), !value.isEmpty else { return nil }
        return value
    }

    func write(_ account: String, _ value: String) throws {
        let data = Data(value.utf8)
        var status = SecItemUpdate(item(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = item(account)
            attributes[kSecValueData as String] = data
            attributes[kSecAttrLabel as String] = "\(HostApp.name) API key (\(account))"
            status = SecItemAdd(attributes as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure(status: status) }
    }

    func delete(_ account: String) throws {
        let status = SecItemDelete(item(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
    }

    private func item(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
