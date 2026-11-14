import Foundation

/// The ed25519 keypair the `ollama` CLI/app generates at `~/.ollama/id_ed25519` on first run and links
/// to an ollama.com account on `ollama signin`. It is the whole Ollama Cloud credential: there is no
/// token or API key to read, so requests are signed with it (see `OllamaRequestSigner`).
///
/// `seed` is secret key material. It lives in memory for the duration of a refresh and is never logged,
/// cached, or written anywhere — which is also why this type is deliberately not `CustomStringConvertible`
/// and not part of any snapshot.
struct OllamaSigningKey: Sendable {
    /// Base64 of the SSH wire-format public key (the `AAAAC3Nz…` body of `id_ed25519.pub`). ollama.com
    /// identifies the account by this value and verifies the signature against it.
    let publicKeyBase64: String
    /// The 32-byte ed25519 seed.
    let seed: Data
}

enum OllamaAuthError: Error, LocalizedError, Equatable {
    /// No `~/.ollama/id_ed25519` — Ollama has never run on this Mac.
    case missingKey
    /// The key file exists but could not be read (permissions, unreadable storage).
    case keyUnreadable
    /// The key file exists but is not an unencrypted OpenSSH ed25519 key.
    case invalidKey
    /// The key is valid but ollama.com does not associate it with an account.
    case notSignedIn

    var errorDescription: String? {
        switch self {
        case .missingKey:
            return "No Ollama key found. Install Ollama and run `ollama signin` to track cloud usage."
        case .keyUnreadable:
            return "Couldn't read ~/.ollama/id_ed25519. Check the file's permissions."
        case .invalidKey:
            return "~/.ollama/id_ed25519 isn't a usable Ollama signing key."
        case .notSignedIn:
            return "Not signed in to Ollama Cloud. Run `ollama signin` to see usage."
        }
    }
}

/// Reads the Ollama signing key already on the machine. Nothing is ever asked of the user: if `ollama`
/// has run here, the key exists, and if the user has signed in, ollama.com accepts it.
struct OllamaAuthStore: Sendable {
    /// Where the `ollama` CLI and the desktop app both keep the key.
    static let keyPath = "~/.ollama/id_ed25519"

    private let files: any TextFileAccessing

    init(files: any TextFileAccessing = LocalTextFileAccessor()) {
        self.files = files
    }

    /// The parsed signing key, or `nil` when Ollama isn't installed here. Throws when the file exists
    /// but can't be read or parsed, so a broken install never reads as a plain logout.
    func loadSigningKey() throws -> OllamaSigningKey? {
        let pem: String?
        do {
            pem = try files.readTextIfPresent(Self.keyPath)
        } catch {
            throw OllamaAuthError.keyUnreadable
        }
        guard let pem, !pem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard let key = OpenSSHEd25519Key.parse(pem: pem) else {
            throw OllamaAuthError.invalidKey
        }
        return key
    }
}
