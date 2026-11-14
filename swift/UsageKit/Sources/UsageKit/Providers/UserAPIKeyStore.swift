import Foundation

/// A user-supplied API key already on the machine — a key pasted into the panel (kept in the Keychain),
/// an environment variable or a small JSON/plain-text config file — for providers with no companion
/// CLI/app that stashes a credential (OpenRouter, Z.ai).
/// The full read / status / save / delete behavior lives here so each such provider is a thin wrapper
/// over its own config paths, env-var names, and error messages instead of a line-for-line copy.
///
/// A GUI app launched from Finder/Dock doesn't inherit the interactive shell environment, so
/// `ProcessEnvironmentReader` captures the login shell's environment at launch (see
/// `LoginShellEnvironment`) — an env var exported in a shell profile is honored even in a packaged
/// build; the config file remains the explicit path.
struct UserAPIKeyStore: Sendable {
    /// A save/delete failure the wrapper maps to its provider's own error, preserving the user-facing message.
    enum Failure { case missingKey, saveFailed, deleteFailed }

    /// Config files read for a key, in order. The first is the host app's own file, where earlier
    /// versions saved pasted keys; it's moved into the Keychain when found (fork addition).
    let configPaths: [String]
    let environmentNames: [String]
    /// The provider's ID, naming its Keychain item (fork addition).
    let secretAccount: String
    /// The host app's integration IDs for this provider, whose connected key comes after a saved key
    /// and before the environment (fork addition).
    var hostIntegrationIDs: [String] = []
    var files: TextFileAccessing
    var environment: EnvironmentReading
    var secrets: any APIKeySecrets
    let makeError: @Sendable (Failure) -> Error

    /// A pasted key first, then a config file, then the host app's account, then the environment: the
    /// key a user saved or edited on purpose wins over a stale env value an old `launchctl setenv` may
    /// have left behind.
    func loadKey() -> String? {
        moveSavedFileToKeychain()
        return keyFromKeychain() ?? keyFromConfigFile() ?? keyFromHostApp() ?? keyFromEnvironment()
    }

    /// Which combination of sources currently holds a key — drives the four-state per-provider API-key
    /// editor. A saved key plus an environment key is `overrideActive` because config wins. A key in
    /// another tool's config file (`~/.config/…`) is the user's own, like an environment key: shown
    /// read-only, never removed from here (fork change).
    func keyStatus() -> APIKeyStatus {
        moveSavedFileToKeychain()
        let hasSaved = keyFromKeychain() != nil
        let hasFile = keyFromConfigFile() != nil
        let hasHost = keyFromHostApp() != nil
        let hasEnv = keyFromEnvironment() != nil
        switch (hasSaved, hasFile || hasHost || hasEnv) {
        case (true, true): return .overrideActive
        case (true, false): return .saved
        // As `loadKey` picks: a config file before the host app.
        case (false, true): return hasHost && !hasFile ? .fromHostApp : .fromEnvironment
        default: return .notSet
        }
    }

    /// Keep `key` in the Keychain (fork addition: upstream wrote it to the primary config file), where it
    /// wins over a stale env var — so this is also the "override" path. Empty input is rejected as
    /// `.missingKey`.
    func saveKey(_ key: String) throws {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw makeError(.missingKey) }
        do {
            try secrets.write(secretAccount, trimmed)
        } catch {
            AppLog.error(.auth, "save \(secretAccount) API key to the Keychain failed: \(error)")
            throw makeError(.saveFailed)
        }
        // A key an earlier version saved in a file would otherwise linger beside it.
        if files.exists(configPaths[0]) { try? files.remove(configPaths[0]) }
    }

    /// Remove the saved key: the Keychain's, and the host app's own file from earlier versions. Other
    /// tools' config files are the user's, and stay (fork change: upstream removed every config path);
    /// a key there shows as the user's own after this. A missing file is a no-op.
    func deleteKey() throws {
        do {
            try secrets.delete(secretAccount)
        } catch {
            AppLog.error(.auth, "delete \(secretAccount) API key from the Keychain failed: \(error)")
            throw makeError(.deleteFailed)
        }
        for path in configPaths.prefix(1) {
            guard files.exists(path) else { continue }
            do {
                try files.remove(path)
            } catch {
                AppLog.error(.auth, "delete API key at \(path) failed: \(error.localizedDescription)")
                throw makeError(.deleteFailed)
            }
        }
    }

    private func keyFromKeychain() -> String? {
        secrets.read(secretAccount)
    }

    /// Earlier versions saved a pasted key in the host app's own config file, as plain text. Move it into
    /// the Keychain once, and remove the file only after the Keychain has the key.
    private func moveSavedFileToKeychain() {
        let path = configPaths[0]
        guard files.exists(path) else { return }
        if keyFromKeychain() == nil {
            guard let text = try? files.readText(path), let key = Self.keyFromConfigText(text),
                  (try? secrets.write(secretAccount, key)) != nil else { return }
        }
        try? files.remove(path)
    }

    private func keyFromHostApp() -> String? {
        hostIntegrationIDs.isEmpty ? nil : HostAccounts.secret(for: hostIntegrationIDs)
    }

    private func keyFromEnvironment() -> String? {
        for name in environmentNames {
            if let value = environment.value(for: name)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty {
                return value
            }
        }
        return nil
    }

    private func keyFromConfigFile() -> String? {
        for path in configPaths {
            guard files.exists(path), let text = try? files.readText(path) else { continue }
            if let key = Self.keyFromConfigText(text) {
                return key
            }
        }
        return nil
    }

    /// Accept a JSON object with `apiKey` / `api_key` / `key`, or a plain-text file holding only the key.
    static func keyFromConfigText(_ text: String) -> String? {
        if let data = text.data(using: .utf8),
           let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            for field in ["apiKey", "api_key", "key"] {
                if let value = (object[field] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !value.isEmpty {
                    return value
                }
            }
            return nil
        }

        // Not JSON: treat as a plain-text key file, ignoring blank lines.
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.contains("{") ? nil : trimmed
    }
}
