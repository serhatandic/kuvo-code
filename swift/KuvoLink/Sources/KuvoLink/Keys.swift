import CryptoKit
import Foundation

/// Where a device is reached on the relay: 16 bytes derived from its relay secret.
public struct LinkAddress: Hashable, Sendable, CustomStringConvertible {
    public static let length = 16
    public let bytes: Data

    public init?(bytes: Data) {
        guard bytes.count == Self.length else { return nil }
        self.bytes = Data(bytes)
    }

    public init?(text: String) {
        guard let bytes = Data(base64URL: text) else { return nil }
        self.init(bytes: bytes)
    }

    public var text: String { bytes.base64URL }
    public var description: String { text }
}

/// What a device shows the relay to get its address. Only the device and the relay know it.
public struct RelaySecret: Hashable, Sendable {
    public static let length = 32
    public let bytes: Data

    public init() {
        bytes = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    public init?(bytes: Data) {
        guard bytes.count == Self.length else { return nil }
        self.bytes = Data(bytes)
    }

    public var address: LinkAddress {
        LinkAddress(bytes: Noise.hash(Data("kuvo-link address v1".utf8) + bytes).prefix(LinkAddress.length))!
    }
}

/// A device's static key: who it is to the devices it's paired with.
public typealias LinkKey = Curve25519.KeyAgreement.PrivateKey

extension Curve25519.KeyAgreement.PrivateKey {
    /// The public half, as the protocol sends it.
    public var publicBytes: Data { publicKey.rawRepresentation }
}

/// Random bytes, for tokens. (The system generator is the secure one on Apple's platforms.)
@usableFromInline func randomBytes(_ count: Int) -> Data {
    var generator = SystemRandomNumberGenerator()
    return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
}

extension Data {
    /// Base64url without padding, as the protocol writes bytes in text.
    public var base64URL: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public init?(base64URL text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    /// For test vectors.
    init?(hex: String) {
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        self = data
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
