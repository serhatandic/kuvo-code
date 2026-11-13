import Foundation
import KuvoLink
import OpenCodeKit
import Security

/// This Mac's vault's values (KuvoLink's PROTOCOL.md, "Vault"), in the Keychain: one item each, by
/// its id, its values as JSON. Its box keeps everything else about them and asks for these through
/// the host interface (`vault/get`, `vault/set`, `vault/delete`), only to fill or run with them, or
/// for a client to show one. A demo or test copy keeps its own, under its own bundle ID.
nonisolated enum VaultValues {
    private static var service: String { (Bundle.main.bundleIdentifier ?? "run.kuvo.code") + ".vault" }

    /// An item's id, as the box makes them.
    static func isItem(_ id: String) -> Bool {
        HostProof.isVaultItem(id)
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

    /// The key this Mac's box signs its vault's files with (its items, grants and Pause), which no
    /// agent can read, and each file's newest generation, in one Keychain item: one can't be taken
    /// away without the other (made again, the key signs none of the files there). Given to the box
    /// alone as it starts. Nil when the Keychain won't say.
    private static let filesAccount = "files"

    private struct Files: Codable {
        var key: String
        var generations: [String: Int] = [:]
        /// Kept by a build from before the generations were: the files' own are taken, once.
        var adopt: Bool?
    }

    private static func readFiles() -> (Files?, OSStatus) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: filesAccount, kSecReturnData as String: true]
        var result: CFTypeRef?
        let status = Keychain.copyMatching(query, &result)
        guard status == errSecSuccess, let data = result as? Data else { return (nil, status) }
        if let files = try? JSONDecoder().decode(Files.self, from: data) { return (files, status) }
        // The key alone, as a build from before kept it: kept with its generations from now on.
        guard data.count == 32 else { return (nil, errSecDecode) }
        let moved = Files(key: data.base64URL, adopt: true)
        return (keep(moved) ? moved : nil, status)
    }

    private static func keep(_ files: Files) -> Bool {
        guard let data = try? JSONEncoder().encode(files) else { return false }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: filesAccount]
        let updated = Keychain.update(query, [kSecValueData as String: data])
        if updated == errSecSuccess { return true }
        guard updated == errSecItemNotFound else { return false }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Kuvo Code vault"
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return Keychain.add(item) == errSecSuccess
    }

    static func fileKey() -> String? {
        let (files, status) = readFiles()
        if let files { return files.key }
        guard status == errSecItemNotFound else { return nil }
        let made = Files(key: Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64URL)
        return keep(made) ? made.key : nil
    }

    /// The newest generation of each of the box's signed files (`items`, `grants`, `paused`), as it
    /// told the app it wrote them: so a copy put back while the box was stopped is caught as it starts.
    /// `adopt`: none kept yet by an older build, so the files' own are taken, once. Nil when the
    /// Keychain can't be read now (not none: the box waits).
    static func generations() -> (generations: [String: Int], adopt: Bool)? {
        let (files, status) = readFiles()
        if let files { return (files.generations, files.adopt == true) }
        return status == errSecItemNotFound ? ([:], false) : nil
    }

    /// Notes a file's newer generation (never an older one).
    static func remember(_ file: String, generation: Int) -> Bool {
        guard var files = readFiles().0 else { return false }
        let adopting = files.adopt != nil
        files.adopt = nil
        let newer = generation > files.generations[file] ?? 0
        if newer { files.generations[file] = generation }
        return newer || adopting ? keep(files) : true
    }

    /// Takes the file key and generations away (a test's, as it ends: the next starts afresh).
    static func forgetFiles() {
        Keychain.delete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: filesAccount])
    }

    /// Takes it away (nothing for one that wasn't kept).
    static func remove(_ id: String) -> Bool {
        let status = Keychain.delete(query(id))
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
