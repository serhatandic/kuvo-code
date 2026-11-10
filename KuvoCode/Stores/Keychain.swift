import Foundation
import os
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
    static func copyMatching(_ query: [String: Any], _ result: UnsafeMutablePointer<CFTypeRef?>?,
                             file: StaticString = #fileID, line: UInt = #line) -> OSStatus {
        if inMemory {
            return lock.withLock {
                // (As a locked Keychain does: it asks you to unlock it, and gives your answer. A
                // test's own service's items.)
                if let service = query[kSecAttrService as String] as? String, let answer = lockedServices[service] {
                    prompted[service, default: 0] += 1
                    return answer
                }
                return standIn.copyMatching(query, result)
            }
        }
        return said(SecItemCopyMatching(query as CFDictionary, result), "read", file, line)
    }

    @discardableResult
    static func add(_ attributes: [String: Any], file: StaticString = #fileID, line: UInt = #line) -> OSStatus {
        if inMemory { return lock.withLock { standIn.add(attributes) } }
        return said(SecItemAdd(attributes as CFDictionary, nil), "add", file, line)
    }

    static func update(_ query: [String: Any], _ changes: [String: Any], file: StaticString = #fileID, line: UInt = #line) -> OSStatus {
        if inMemory { return lock.withLock { standIn.update(query, changes) } }
        return said(SecItemUpdate(query as CFDictionary, changes as CFDictionary), "change", file, line)
    }

    @discardableResult
    static func delete(_ query: [String: Any], file: StaticString = #fileID, line: UInt = #line) -> OSStatus {
        if inMemory { return lock.withLock { standIn.delete(query) } }
        return said(SecItemDelete(query as CFDictionary), "remove", file, line)
    }

    /// For the tests' copy and a demo copy that never prompts (`AppInfo.neverPrompts`): anything
    /// that still reaches the real Keychain (a framework, a package) fails at once, rather than
    /// waiting on a prompt no one is there to answer.
    static func neverAsk() {
        SecKeychainSetUserInteractionAllowed(false)
    }

    /// What macOS said, and in the log where it was asked from when it would have asked you.
    private static func said(_ status: OSStatus, _ what: String, _ file: StaticString, _ line: UInt) -> OSStatus {
        if status == errSecInteractionNotAllowed {
            Logger(subsystem: AppInfo.realBundleID, category: "prompts")
                .notice("A Keychain \(what, privacy: .public) (\(String(describing: file), privacy: .public):\(Int(line))) failed rather than ask you: this copy never shows a macOS prompt")
        }
        return status
    }

    /// A read that never asks you to unlock your Keychain: while it's locked,
    /// `errSecInteractionNotAllowed` at once. (SecItem doesn't take `kSecUseAuthenticationUIFail`
    /// for a login Keychain's items, where the app keeps its own, so it's looked at first.)
    static func copyWithoutAsking(_ query: [String: Any], _ result: UnsafeMutablePointer<CFTypeRef?>?,
                                  file: StaticString = #fileID, line: UInt = #line) -> OSStatus {
        if isLocked(query[kSecAttrService as String] as? String) { return errSecInteractionNotAllowed }
        return copyMatching(query, result, file: file, line: line)
    }

    /// Whether the Keychain the app keeps its items in is locked now (a test's: whether its service's
    /// are, `lockForTests`).
    private static func isLocked(_ service: String?) -> Bool {
        if inMemory { return lock.withLock { service.map { lockedServices[$0] != nil } ?? false } }
        var keychain: SecKeychain?
        var status: SecKeychainStatus = 0
        guard SecKeychainCopyDefault(&keychain) == errSecSuccess, let keychain, SecKeychainGetStatus(keychain, &status) == errSecSuccess else { return false }
        return status & SecKeychainStatus(kSecUnlockStateStatus) == 0
    }

    /// Hosting tests: the items of these services read as a locked Keychain's do (a test's own
    /// services, while it says so): a read asks you to unlock it, and gets `answer` (yours, like
    /// `errSecUserCanceled`); one that never asks (`copyWithoutAsking`) doesn't read.
    static func lockForTests(_ service: String, _ locked: Bool, answer: OSStatus = errSecInteractionNotAllowed) {
        lock.withLock { lockedServices[service] = locked ? answer : nil }
    }
    nonisolated(unsafe) private static var lockedServices: [String: OSStatus] = [:]
    /// How many times macOS would have asked you, by a locked service's.
    static func promptsForTests(_ service: String) -> Int { lock.withLock { prompted[service] ?? 0 } }
    nonisolated(unsafe) private static var prompted: [String: Int] = [:]

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
