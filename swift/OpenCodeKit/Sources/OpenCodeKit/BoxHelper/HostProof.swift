#if os(macOS)
import CryptoKit
import Foundation

/// What a Mac's box and whatever answers its host interface (KuvoLink's PROTOCOL.md, "Host
/// interface") prove to each other, the same for the app's keeper (`HostInterface`) and the box's
/// helper (`BoxHelperHost`): that it's the one that wrote `run/host.json` the box reaches (`hello`),
/// that a vault call comes from the box given the vault's secret, and which names it answers for.
public enum HostProof {
    /// The box's nonce, with where it reached it (`127.0.0.1:<port>`), signed with the password
    /// (HMAC-SHA256, hex), as it checks it: relayed from another port, it's wrong there.
    public static func proof(of nonce: String, at address: String, password: String, tag: String = "kuvo-host-hello") -> String {
        let signed = Data("\(tag)\u{0}\(nonce)\u{0}\(address)".utf8)
        let code = HMAC<SHA256>.authenticationCode(for: signed, using: SymmetricKey(data: Data(password.utf8)))
        return code.map { String(format: "%02x", $0) }.joined()
    }

    /// `hello`'s answer: the proof with the password, and with the vault's secret when the box asks
    /// for it (`vault`). Nil for a request that isn't one (400).
    public static func hello(_ request: HTTPRequest, port: UInt16, password: String, vaultSecret: String) -> [String: String]? {
        let given = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
        guard let nonce = given["nonce"] as? String, (16...256).contains(nonce.count) else { return nil }
        var answer = ["proof": proof(of: nonce, at: "127.0.0.1:\(port)", password: password)]
        if given["vault"] as? Bool == true { answer["vaultProof"] = proof(of: nonce, at: "127.0.0.1:\(port)", password: vaultSecret, tag: "kuvo-host-vault") }
        return answer
    }

    /// Whether a request carries the password (`Authorization: Bearer …`).
    public static func authorized(_ request: HTTPRequest, password: String) -> Bool {
        guard let authorization = request.headers["authorization"], authorization.hasPrefix("Bearer ") else { return false }
        return samePassword(String(authorization.dropFirst(7)), password)
    }

    /// The names it answers for: Kuvo Code's own keys (`KUVO_KEY_…`).
    public static func isKey(_ name: String) -> Bool {
        name.hasPrefix("KUVO_KEY_") && name.count > "KUVO_KEY_".count
            && name.unicodeScalars.allSatisfy { ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "_" }
    }

    /// A vault item's id, as the box makes them.
    public static func isVaultItem(_ id: String) -> Bool {
        id.hasPrefix("v_") && id.count == 12 && id.dropFirst(2).allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
    }

    /// A random secret: 32 bytes, hex.
    public static func secret() -> String {
        (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }
}

/// Vault calls' proofs (an HMAC with the vault's secret of the call, its body and when it was
/// made, within a minute), each taken once, until it would be too old anyway.
public final class VaultCallProofs: @unchecked Sendable {
    private let secret: String
    private let lock = NSLock()
    private var used: [String: Date] = [:]

    public init(secret: String) {
        self.secret = secret
    }

    /// Whether `request` carries the box's proof of it, not used before.
    public func proved(_ request: HTTPRequest, now: Date = Date()) -> Bool {
        guard let auth = request.headers["x-kuvo-vault-auth"], let atText = request.headers["x-kuvo-vault-at"], let at = Double(atText),
              abs(now.timeIntervalSince1970 * 1000 - at) < 60_000 else { return false }
        let call = String(request.path.dropFirst())
        let body = SHA256.hash(data: request.body).map { String(format: "%02x", $0) }.joined()
        let signed = Data("kuvo-host-vault-call\u{0}\(call)\u{0}\(body)\u{0}\(atText)".utf8)
        let expected = HMAC<SHA256>.authenticationCode(for: signed, using: SymmetricKey(data: Data(secret.utf8))).map { String(format: "%02x", $0) }.joined()
        guard samePassword(auth, expected) else { return false }
        return lock.withLock {
            used = used.filter { now.timeIntervalSince($0.value) < 120 }
            guard used[auth] == nil else { return false }
            used[auth] = now
            return true
        }
    }
}
#endif
