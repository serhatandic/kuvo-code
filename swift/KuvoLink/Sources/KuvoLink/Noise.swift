import CryptoKit
import Foundation

/// The parts of the Noise protocol framework (noiseprotocol.org, revision 34) Kuvo Link uses:
/// the IK pattern for sessions and the one-way K pattern for mail, with X25519, AES-GCM and
/// SHA-256. Checked against cacophony's test vectors (`Vectors/noise.json`).
public enum Noise {
    public static let keyLength = 32
    public static let tagLength = 16
    /// The longest message Noise allows.
    public static let maxMessage = 65_535

    public enum Failure: Error, Equatable {
        /// A message that's too short, or a key that isn't one.
        case malformed
        /// A message that didn't decrypt: tampered with, out of order, or for someone else.
        case decrypt
        case tooLong
    }

    static func dh(_ key: Curve25519.KeyAgreement.PrivateKey, _ publicKey: Data) throws -> Data {
        guard let other = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey),
              let shared = try? key.sharedSecretFromKeyAgreement(with: other)
        else { throw Failure.malformed }
        return shared.withUnsafeBytes { Data($0) }
    }

    static func hash(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    static func hmac(_ key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    /// Noise's HKDF, two outputs.
    static func hkdf(_ chainingKey: Data, _ input: Data) -> (Data, Data) {
        let temp = hmac(chainingKey, input)
        let first = hmac(temp, Data([1]))
        return (first, hmac(temp, first + Data([2])))
    }
}

/// One direction's key and nonce.
public struct CipherState: Sendable {
    var key: SymmetricKey?
    var nonce: UInt64 = 0

    init(key: Data? = nil) {
        self.key = key.map(SymmetricKey.init(data:))
    }

    mutating func encrypt(_ plaintext: Data, ad: Data) throws -> Data {
        guard let key else { return plaintext }
        let sealed = try AES.GCM.seal(plaintext, using: key, nonce: Self.nonce(nonce), authenticating: ad)
        nonce += 1
        return sealed.ciphertext + sealed.tag
    }

    mutating func decrypt(_ ciphertext: Data, ad: Data) throws -> Data {
        guard let key else { return ciphertext }
        guard ciphertext.count >= Noise.tagLength else { throw Noise.Failure.malformed }
        do {
            let box = try AES.GCM.SealedBox(nonce: Self.nonce(nonce), ciphertext: ciphertext.dropLast(Noise.tagLength), tag: ciphertext.suffix(Noise.tagLength))
            let plaintext = try AES.GCM.open(box, using: key, authenticating: ad)
            nonce += 1
            return plaintext
        } catch {
            throw Noise.Failure.decrypt
        }
    }

    /// AES-GCM's nonce in Noise: four zero bytes, then the counter, big-endian.
    static func nonce(_ n: UInt64) -> AES.GCM.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.bigEndian) { bytes.append(contentsOf: $0) }
        return try! AES.GCM.Nonce(data: bytes)
    }
}

struct SymmetricState {
    var cipher = CipherState()
    var chainingKey: Data
    var hash: Data

    init(protocolName: String, prologue: Data) {
        let name = Data(protocolName.utf8)
        hash = name.count <= 32 ? name + Data(count: 32 - name.count) : Noise.hash(name)
        chainingKey = hash
        mixHash(prologue)
    }

    mutating func mixKey(_ input: Data) {
        let (chainingKey, key) = Noise.hkdf(chainingKey, input)
        self.chainingKey = chainingKey
        cipher = CipherState(key: key)
    }

    mutating func mixHash(_ data: Data) {
        hash = Noise.hash(hash + data)
    }

    mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ciphertext = try cipher.encrypt(plaintext, ad: hash)
        mixHash(ciphertext)
        return ciphertext
    }

    mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let plaintext = try cipher.decrypt(ciphertext, ad: hash)
        mixHash(ciphertext)
        return plaintext
    }

    func split() -> (CipherState, CipherState) {
        let (first, second) = Noise.hkdf(chainingKey, Data())
        return (CipherState(key: first), CipherState(key: second))
    }
}

/// An open session's two directions.
public struct Transport: Sendable {
    var sending: CipherState
    var receiving: CipherState
    /// The handshake's hash, the same on both ends.
    public let handshakeHash: Data

    public mutating func seal(_ plaintext: Data) throws -> Data {
        guard plaintext.count + Noise.tagLength <= Noise.maxMessage else { throw Noise.Failure.tooLong }
        return try sending.encrypt(plaintext, ad: Data())
    }

    public mutating func open(_ ciphertext: Data) throws -> Data {
        try receiving.decrypt(ciphertext, ad: Data())
    }
}

/// `Noise_IK_25519_AESGCM_SHA256`: the side that starts, knowing the other's static key.
///
///     <- s
///     ...
///     -> e, es, s, ss
///     <- e, ee, se
public struct IKInitiator {
    static let name = "Noise_IK_25519_AESGCM_SHA256"

    private var state: SymmetricState
    private let s: Curve25519.KeyAgreement.PrivateKey
    private let e: Curve25519.KeyAgreement.PrivateKey
    private let rs: Data

    /// `ephemeral` is for tests; a session always gets a new one.
    public init(staticKey: Curve25519.KeyAgreement.PrivateKey, remoteStatic: Data, prologue: Data, ephemeral: Curve25519.KeyAgreement.PrivateKey = .init()) {
        state = SymmetricState(protocolName: Self.name, prologue: prologue)
        s = staticKey
        e = ephemeral
        rs = remoteStatic
        state.mixHash(rs)
    }

    public mutating func writeMessage1(payload: Data) throws -> Data {
        var message = e.publicKey.rawRepresentation
        state.mixHash(message)
        state.mixKey(try Noise.dh(e, rs))
        message += try state.encryptAndHash(s.publicKey.rawRepresentation)
        state.mixKey(try Noise.dh(s, rs))
        message += try state.encryptAndHash(payload)
        return message
    }

    public mutating func readMessage2(_ message: Data) throws -> (payload: Data, transport: Transport) {
        let message = Data(message)
        guard message.count >= Noise.keyLength + Noise.tagLength else { throw Noise.Failure.malformed }
        let re = message.prefix(Noise.keyLength)
        state.mixHash(re)
        state.mixKey(try Noise.dh(e, re))
        state.mixKey(try Noise.dh(s, re))
        let payload = try state.decryptAndHash(message.dropFirst(Noise.keyLength))
        let (first, second) = state.split()
        return (payload, Transport(sending: first, receiving: second, handshakeHash: state.hash))
    }
}

/// `Noise_IK_25519_AESGCM_SHA256`: the side that answers, learning the other's static key.
public struct IKResponder {
    private var state: SymmetricState
    private let s: Curve25519.KeyAgreement.PrivateKey
    private let e: Curve25519.KeyAgreement.PrivateKey
    private var re = Data()
    /// The initiator's static key, once message 1 is read.
    public private(set) var remoteStatic = Data()

    public init(staticKey: Curve25519.KeyAgreement.PrivateKey, prologue: Data, ephemeral: Curve25519.KeyAgreement.PrivateKey = .init()) {
        state = SymmetricState(protocolName: IKInitiator.name, prologue: prologue)
        s = staticKey
        e = ephemeral
        state.mixHash(s.publicKey.rawRepresentation)
    }

    public mutating func readMessage1(_ message: Data) throws -> Data {
        let message = Data(message)
        let staticEnd = Noise.keyLength * 2 + Noise.tagLength
        guard message.count >= staticEnd + Noise.tagLength else { throw Noise.Failure.malformed }
        re = message.prefix(Noise.keyLength)
        state.mixHash(re)
        state.mixKey(try Noise.dh(s, re))
        remoteStatic = try state.decryptAndHash(message[Noise.keyLength..<staticEnd])
        state.mixKey(try Noise.dh(s, remoteStatic))
        return try state.decryptAndHash(message[staticEnd...])
    }

    public mutating func writeMessage2(payload: Data) throws -> (message: Data, transport: Transport) {
        var message = e.publicKey.rawRepresentation
        state.mixHash(message)
        state.mixKey(try Noise.dh(e, re))
        state.mixKey(try Noise.dh(e, remoteStatic))
        message += try state.encryptAndHash(payload)
        let (first, second) = state.split()
        return (message, Transport(sending: second, receiving: first, handshakeHash: state.hash))
    }
}

/// `Noise_K_25519_AESGCM_SHA256`: one message to a device that knows the sender, needing no
/// answer, for mail.
///
///     -> s
///     <- s
///     ...
///     -> e, es, ss
public enum OneWay {
    static let name = "Noise_K_25519_AESGCM_SHA256"

    /// The message, and the sender's side of what follows it (for tests).
    public static func seal(_ payload: Data, from staticKey: Curve25519.KeyAgreement.PrivateKey, to remoteStatic: Data, prologue: Data, ephemeral: Curve25519.KeyAgreement.PrivateKey = .init()) throws -> (message: Data, following: CipherState) {
        var state = SymmetricState(protocolName: name, prologue: prologue)
        state.mixHash(staticKey.publicKey.rawRepresentation)
        state.mixHash(remoteStatic)
        var message = ephemeral.publicKey.rawRepresentation
        state.mixHash(message)
        state.mixKey(try Noise.dh(ephemeral, remoteStatic))
        state.mixKey(try Noise.dh(staticKey, remoteStatic))
        message += try state.encryptAndHash(payload)
        return (message, state.split().0)
    }

    public static func open(_ message: Data, to staticKey: Curve25519.KeyAgreement.PrivateKey, from remoteStatic: Data, prologue: Data) throws -> (payload: Data, following: CipherState) {
        let message = Data(message)
        guard message.count >= Noise.keyLength + Noise.tagLength else { throw Noise.Failure.malformed }
        var state = SymmetricState(protocolName: name, prologue: prologue)
        state.mixHash(remoteStatic)
        state.mixHash(staticKey.publicKey.rawRepresentation)
        let re = message.prefix(Noise.keyLength)
        state.mixHash(re)
        state.mixKey(try Noise.dh(staticKey, re))
        state.mixKey(try Noise.dh(staticKey, remoteStatic))
        let payload = try state.decryptAndHash(message.dropFirst(Noise.keyLength))
        return (payload, state.split().0)
    }
}
