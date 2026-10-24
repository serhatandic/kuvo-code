import Foundation
import Security

/// The Keychain, as Kuvo Code reaches it: SecItem's four calls, in this one place (the phone
/// link's keys, integrations' keys, the browser's passwords). `scripts/test-app.sh` makes sure
/// nothing else in the app calls them.
///
/// Hosting tests, a Keychain of the tests' own, in memory, empty each run. The tests' copy is
/// signed anew with each build, so macOS would ask whether it may use what an earlier build kept
/// ("wants to use your confidential information"), and the test reading it would wait on that
/// prompt, with no one there to answer it.
nonisolated enum Keychain {
    static func copyMatching(_ query: [String: Any], _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        if inMemory { return lock.withLock { standIn.copyMatching(query, result) } }
        return SecItemCopyMatching(query as CFDictionary, result)
    }

    @discardableResult
    static func add(_ attributes: [String: Any]) -> OSStatus {
        if inMemory { return lock.withLock { standIn.add(attributes) } }
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    static func update(_ query: [String: Any], _ changes: [String: Any]) -> OSStatus {
        if inMemory { return lock.withLock { standIn.update(query, changes) } }
        return SecItemUpdate(query as CFDictionary, changes as CFDictionary)
    }

    @discardableResult
    static func delete(_ query: [String: Any]) -> OSStatus {
        if inMemory { return lock.withLock { standIn.delete(query) } }
        return SecItemDelete(query as CFDictionary)
    }

    /// For the tests' copy: anything that still reaches the real Keychain (a framework, a package)
    /// fails at once, rather than waiting on a prompt no one is there to answer.
    static func neverAsk() {
        SecKeychainSetUserInteractionAllowed(false)
    }

    /// Hosting tests, never the real Keychain: SecItem isn't called at all.
    private static let inMemory = AppInfo.isHostingTests
    private static let lock = NSLock()
    nonisolated(unsafe) private static var standIn = Items()

    /// The tests' Keychain: items as SecItem keeps them, found by the attributes the app asks by.
    private struct Items {
        private var items: [[String: Any]] = []

        /// What a query names an item by (the rest says what to return, and how many).
        private static let identity = [kSecClass, kSecAttrService, kSecAttrAccount, kSecAttrServer, kSecAttrCreator].map { $0 as String }

        private static func matches(_ item: [String: Any], _ query: [String: Any]) -> Bool {
            Self.identity.allSatisfy { key in
                guard let wanted = query[key] else { return true }
                guard let value = item[key] else { return false }
                return (value as AnyObject).isEqual(wanted)
            }
        }

        func copyMatching(_ query: [String: Any], _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
            let found = items.filter { Self.matches($0, query) }
            guard !found.isEmpty else { return errSecItemNotFound }
            let data = query[kSecReturnData as String] as? Bool == true
            let attributes = query[kSecReturnAttributes as String] as? Bool == true
            let shaped = found.map { item -> Any in
                var attributesOnly = item
                attributesOnly[kSecValueData as String] = nil
                if attributes { return data ? item : attributesOnly }
                return data ? item[kSecValueData as String] ?? Data() : attributesOnly
            }
            let all = (query[kSecMatchLimit as String] as AnyObject?)?.isEqual(kSecMatchLimitAll) == true
            result?.pointee = (all ? shaped as NSArray : shaped[0] as AnyObject) as CFTypeRef
            return errSecSuccess
        }

        mutating func add(_ attributes: [String: Any]) -> OSStatus {
            guard !items.contains(where: { Self.matches($0, attributes) && Self.matches(attributes, $0) }) else { return errSecDuplicateItem }
            var item = attributes
            item[kSecAttrCreationDate as String] = Date()
            item[kSecAttrModificationDate as String] = Date()
            items.append(item)
            return errSecSuccess
        }

        mutating func update(_ query: [String: Any], _ changes: [String: Any]) -> OSStatus {
            var found = false
            for index in items.indices where Self.matches(items[index], query) {
                found = true
                items[index].merge(changes) { $1 }
                items[index][kSecAttrModificationDate as String] = Date()
            }
            return found ? errSecSuccess : errSecItemNotFound
        }

        mutating func delete(_ query: [String: Any]) -> OSStatus {
            let before = items.count
            items.removeAll { Self.matches($0, query) }
            return items.count < before ? errSecSuccess : errSecItemNotFound
        }
    }
}
