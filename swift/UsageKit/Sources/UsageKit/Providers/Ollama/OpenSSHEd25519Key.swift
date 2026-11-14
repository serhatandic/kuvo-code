import CryptoKit
import Foundation

/// Minimal reader for the unencrypted OpenSSH private-key container (`-----BEGIN OPENSSH PRIVATE KEY-----`),
/// scoped to exactly what Ollama writes: a single `ssh-ed25519` key with no passphrase.
///
/// This is a boundary parser — the file is arbitrary bytes on disk — so every read is length-checked and
/// any deviation from the expected shape returns `nil` rather than trapping. The container format is
/// documented in OpenSSH's `PROTOCOL.key`:
///
///     "openssh-key-v1\0" | string cipher | string kdf | string kdfoptions | uint32 keycount
///                        | string publickey | string privatekeys
///
/// and the private section is `uint32 check | uint32 check | string keytype | string pub | string priv | …`,
/// where an ed25519 `priv` is the 32-byte seed followed by its 32-byte public key.
enum OpenSSHEd25519Key {
    private static let magic = Array("openssh-key-v1\0".utf8)
    private static let keyType = "ssh-ed25519"

    static func parse(pem: String) -> OllamaSigningKey? {
        guard let blob = base64Body(of: pem) else { return nil }
        guard blob.starts(with: magic) else { return nil }

        var reader = ByteReader(blob, offset: magic.count)
        // An encrypted key ("aes256-ctr" + a kdf) can't be used without the user's passphrase; Ollama
        // never writes one, so treat anything but "none"/"none" as unusable rather than guessing.
        guard let cipher = reader.string(), cipher == Data("none".utf8),
              let kdf = reader.string(), kdf == Data("none".utf8),
              reader.string() != nil,                      // kdfoptions (empty for an unencrypted key)
              let keyCount = reader.uint32(), keyCount == 1,
              let publicKeyBlob = reader.string(),
              let privateSection = reader.string()
        else {
            return nil
        }

        var privateReader = ByteReader(privateSection, offset: 0)
        guard privateReader.uint32() != nil,               // checkint1
              privateReader.uint32() != nil,               // checkint2 (equal to checkint1 when decrypted)
              let type = privateReader.string(), type == Data(keyType.utf8),
              privateReader.string() != nil,               // public key, repeated
              let privateKey = privateReader.string(),
              privateKey.count == 64                       // seed || public key
        else {
            return nil
        }

        // Reject a key whose declared public half doesn't match the private one — a corrupt file that
        // would otherwise produce signatures ollama.com silently rejects.
        let seed = privateKey.prefix(32)
        guard let derived = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed),
              derived.publicKey.rawRepresentation == Data(privateKey.suffix(32))
        else {
            return nil
        }

        // The outer public key is the one sent in the `Authorization` header, while the signature comes
        // from `seed`. A damaged file can pair an intact private key with a different public half; every
        // request would then be signed correctly, rejected by ollama.com, and reported to the user as
        // "not signed in" — a dead end, since signing in again cannot fix a corrupt key file. Checking
        // the two halves against each other here turns that into an honest "unusable key" instead.
        var publicReader = ByteReader(publicKeyBlob, offset: 0)
        guard let publicType = publicReader.string(), publicType == Data(keyType.utf8),
              let publicKeyRaw = publicReader.string(),
              publicKeyRaw == derived.publicKey.rawRepresentation
        else {
            return nil
        }

        return OllamaSigningKey(publicKeyBase64: publicKeyBlob.base64EncodedString(), seed: Data(seed))
    }

    /// The base64 payload between the PEM header and footer lines.
    private static func base64Body(of pem: String) -> Data? {
        let body = pem
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("-----") }
            .joined()
        return Data(base64Encoded: body)
    }

    /// Cursor over the SSH wire format: big-endian `uint32` lengths followed by their payloads. Every
    /// read is bounds-checked and returns `nil` past the end, so a truncated file can't over-read.
    private struct ByteReader {
        private let bytes: Data
        private var offset: Int

        init(_ bytes: Data, offset: Int) {
            // `Data` slices keep their parent's indices; re-base so `offset` is always zero-relative.
            self.bytes = Data(bytes)
            self.offset = offset
        }

        mutating func uint32() -> UInt32? {
            guard offset + 4 <= bytes.count else { return nil }
            let value = bytes[offset..<offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            offset += 4
            return value
        }

        mutating func string() -> Data? {
            guard let length = uint32() else { return nil }
            let count = Int(length)
            guard count >= 0, offset + count <= bytes.count else { return nil }
            let value = bytes[offset..<offset + count]
            offset += count
            return Data(value)
        }
    }
}
