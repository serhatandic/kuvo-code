import Foundation
import OpenCodeKit
import Security

/// Keys you bring for integrations that take one (a bot token, an API key), kept in your Keychain.
/// This Mac's engine reads them from files only you can read, in Kuvo Code's temporary folder,
/// which its settings name with `{file:…}`: written each time it starts, and gone when Kuvo Code
/// quits. So they're never in its settings file, nor in its environment, where the agent's own
/// commands (`env`, say) would print them. A machine's engine has them the same way, in files in
/// its folder there for as long as it runs (see `RemoteServer.launchScript`).
nonisolated enum IntegrationKeys {
    private static var service: String { (Bundle.main.bundleIdentifier ?? "run.kuvo.code") + ".integrations" }

    /// The variable an integration's key goes in: KUVO_KEY_<ID>_<NAME>.
    static func variable(_ integration: String, _ name: String) -> String {
        "KUVO_KEY_" + plain(integration + "_" + name)
    }

    /// A bot's own key, which only its conversation uses: KUVO_KEY_<ID>_<NAME>__<BOT>.
    static func variable(_ integration: String, _ name: String, bot: String) -> String {
        variable(integration, name) + botSuffix(bot)
    }

    /// How each of a bot's own keys ends: __<BOT>.
    static func botSuffix(_ bot: String) -> String {
        "__" + plain(bot)
    }

    /// Whether `variable` is a bot's own key.
    static func isBots(_ variable: String) -> Bool {
        variable.contains("__")
    }

    /// The shared keys saved (not a bot's own), by variable.
    static var shared: [String] {
        names.filter { !isBots($0) }.sorted()
    }

    /// A bot's own keys, as saved: each one's variable.
    static func variables(ofBot bot: String) -> [String] {
        variables(ofBot: bot, in: names)
    }

    /// Those of `names` that are `bot`'s own keys.
    static func variables(ofBot bot: String, in names: [String]) -> [String] {
        names.filter { $0.hasSuffix(botSuffix(bot)) }.sorted()
    }

    private static func plain(_ text: String) -> String {
        text.uppercased().map { $0.isLetter || $0.isNumber ? $0 : "_" }.map(String.init).joined()
    }

    /// Where this Mac's engine reads the keys.
    static var folder: URL {
        FileManager.default.temporaryDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code").appending(path: "integration-keys")
    }

    /// How this Mac's engine settings name a key: the file it's read from.
    static func reference(_ variable: String) -> String {
        "{file:\(folder.path)/\(variable)}"
    }

    /// How a computer's engine settings name a key: this Mac's (nil) as above; a machine's, in its
    /// own keys' folder there (`MachineBox.setKey`).
    static func reference(_ variable: String, on machine: String?) -> String {
        guard machine != nil else { return reference(variable) }
        return "{file:~/\(RemoteEngineInstaller.root)/box/keys/\(variable)}"
    }

    /// Every key you saved, each in its file for the engine to read as it starts, and no others.
    static func writeFiles() {
        let keys = environment
        let manager = FileManager.default
        try? manager.removeItem(at: folder)
        guard !keys.isEmpty else { return }
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for (name, value) in keys {
            manager.createFile(atPath: folder.appending(path: name).path, contents: Data(value.utf8), attributes: [.posixPermissions: 0o600])
        }
    }

    /// macOS clears what's sat three days in a temporary folder, and Kuvo Code runs for longer:
    /// each key's file is marked used twice a day (and written again if it went), so the engine
    /// still finds it when it next reads its settings.
    static func keepFresh() {
        guard freshness == nil else { return }
        freshness = Task.detached {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(12 * 3600))
                let manager = FileManager.default
                let keys = environment
                if keys.contains(where: { !manager.fileExists(atPath: folder.appending(path: $0.key).path) }) {
                    writeFiles()
                } else {
                    for name in keys.keys { utimes(folder.appending(path: name).path, nil) }
                    utimes(folder.path, nil)
                }
            }
        }
    }

    nonisolated(unsafe) private static var freshness: Task<Void, Never>?

    /// One key's file, for an engine that's running: its settings read it when they're next read
    /// (as adding the integration does), with no need to start it again.
    private static func writeFile(_ value: String, for variable: String) {
        let manager = FileManager.default
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = folder.appending(path: variable)
        try? manager.removeItem(at: file)
        manager.createFile(atPath: file.path, contents: Data(value.utf8), attributes: [.posixPermissions: 0o600])
    }

    /// When Kuvo Code quits: the keys' files go.
    static func removeFiles() {
        try? FileManager.default.removeItem(at: folder)
    }

    static func value(_ variable: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: variable,
            kSecReturnData as String: true,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Saves a key, in place of the one before (or removes it, for nil or empty).
    @discardableResult
    static func set(_ value: String?, for variable: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: variable,
        ]
        guard let value, !value.isEmpty else {
            // Its file too, for an engine that's running.
            try? FileManager.default.removeItem(at: folder.appending(path: variable))
            let status = SecItemDelete(base as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }
        let data = Data(value.utf8)
        let updated = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        var saved = updated == errSecSuccess
        if updated == errSecItemNotFound {
            var item = base
            item[kSecValueData as String] = data
            item[kSecAttrLabel as String] = "Kuvo Code integration key"
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            saved = SecItemAdd(item as CFDictionary, nil) == errSecSuccess
        }
        if saved { writeFile(value, for: variable) }
        return saved
    }

    /// Every key you saved, as the environment the engines run with. (The keychain lists them
    /// without their values, so each is read on its own.)
    static var environment: [String: String] {
        var found: [String: String] = [:]
        for name in names {
            if let value = value(name) { found[name] = value }
        }
        return found
    }

    /// The keys you saved, by their variables, without reading them.
    static var names: [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let items = result as? [[String: Any]] else { return [] }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }
}
