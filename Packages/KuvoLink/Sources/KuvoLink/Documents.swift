import CryptoKit
import Foundation

/// What boxes copy between them (PROTOCOL.md, "Documents"): who a Mac's boxes are, the phones each
/// box pairs and removes, and each box's view of your personalities. Each origin signs its own with a
/// key of its own (Ed25519) and numbers each version; any box passes a copy on, and a box keeps the
/// newest one it can verify from each origin it takes that kind from. The same as the bridge's
/// (`readDoc`, `signDoc`, `docMails` in kuvo-link.js), held to `Vectors/docs.json`.
public enum Documents {
    public typealias SigningKey = Curve25519.Signing.PrivateKey

    public static let kinds = ["peers", "phones", "personalities"]
    /// A document at most so big (its bytes); in a mail, at most so much of one, a bigger one in parts.
    public static let mostBytes = 512 * 1024
    public static let partLength = 40_000
    /// A body with room to spare in a document.
    public static let mostBody = mostBytes - 4096
    static let mostParts = Int((Double(mostBytes) * 4 / 3 / Double(partLength)).rounded(.up)) + 1
    static let signed = Data("kuvo-link doc v1\0".utf8)
    static let mostVersion = 9_007_199_254_740_991

    /// One as it's given: its bytes and its signature, in base64url.
    public struct Envelope: Codable, Hashable, Sendable {
        public var d: String
        public var s: String

        public init(d: String, s: String) {
            self.d = d
            self.s = s
        }

        public init?(_ value: Any?) {
            guard let value = value as? [String: Any], let d = value["d"] as? String, let s = value["s"] as? String else { return nil }
            self.init(d: d, s: s)
        }

        public var json: [String: Any] { ["d": d, "s": s] }
    }

    /// One checked: its origin (the key that signed it), kind, version, body (JSON) and hash.
    public struct Document: Sendable {
        public let origin: String
        public let kind: String
        public let n: Int
        public let body: Data
        /// The first 8 bytes of its bytes' SHA-256, as digests name it.
        public let h: String
        public let envelope: Envelope

        /// Its body, decoded.
        public func decoded<T: Decodable>(_ type: T.Type) -> T? { try? JSONDecoder().decode(type, from: body) }
        public var object: [String: Any] { (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:] }
    }

    /// The public half of a signing key, as documents name their origin.
    public static func origin(of key: SigningKey) -> String { key.publicKey.rawRepresentation.base64URL }

    /// The bytes an origin signs for one version of its document: `{v, kind, origin, n, body}`.
    static func bytes(origin: String, kind: String, n: Int, body: Data) -> Data {
        Data(#"{"v":1,"kind":"\#(kind)","origin":"\#(origin)","n":\#(n),"body":"#.utf8) + body + Data("}".utf8)
    }

    /// Version `n` of `kind` with `body` (a JSON object), signed with `key`.
    public static func sign(_ key: SigningKey, kind: String, n: Int, body: Data) -> Envelope {
        let bytes = bytes(origin: origin(of: key), kind: kind, n: n, body: body)
        let signature = (try? key.signature(for: signed + bytes)) ?? Data()
        return Envelope(d: bytes.base64URL, s: signature.base64URL)
    }

    static func shortHash(_ data: Data) -> String { Data(SHA256.hash(data: data)).prefix(8).base64URL }

    /// The hash of a body, to tell whether one of this box's own changed.
    public static func bodyHash(_ body: Data) -> String { shortHash(body) }

    /// `envelope` checked: signed by the origin it names, of a kind there is, its version a whole number
    /// from 1, no bigger than a document can be. Nil otherwise.
    public static func read(_ envelope: Envelope) -> Document? {
        guard envelope.d.utf8.count <= mostBytes * 4 / 3 + 4, let bytes = Data(base64URL: envelope.d), bytes.count <= mostBytes,
              bytes.base64URL == envelope.d,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              (object["v"] as? NSNumber).map(isWholeNumber) == true, (object["v"] as? NSNumber)?.intValue == 1,
              let kind = object["kind"] as? String, kinds.contains(kind),
              let origin = object["origin"] as? String, origin.wholeMatch(of: /[A-Za-z0-9_-]{43}/) != nil,
              let number = object["n"] as? NSNumber, isWholeNumber(number), let n = Int(exactly: number.doubleValue), n >= 1, n <= mostVersion,
              let body = object["body"] as? [String: Any],
              let key = Data(base64URL: origin).flatMap({ try? Curve25519.Signing.PublicKey(rawRepresentation: $0) }),
              let signature = Data(base64URL: envelope.s), signature.count == 64, key.isValidSignature(signature, for: signed + bytes),
              let bodyData = try? JSONSerialization.data(withJSONObject: body)
        else { return nil }
        return Document(origin: origin, kind: kind, n: n, body: bodyData, h: shortHash(bytes), envelope: envelope)
    }

    /// A number JSON wrote as a whole number (not true or false, not 1.5).
    private static func isWholeNumber(_ number: NSNumber) -> Bool {
        guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        let value = number.doubleValue
        return value.rounded() == value && abs(value) <= Double(mostVersion)
    }

    /// What goes to one box (`give`, `have`, `reply`), as the mails it takes: documents together while
    /// they fit, a bigger one in parts, the digest last.
    public static func mails(give: [Envelope], have: [[Any]]? = nil, reply: Bool = false) -> [[String: Any]] {
        var mails: [[String: Any]] = []
        var batch: [[String: Any]] = []
        var size = 0
        for envelope in give {
            let length = envelope.d.utf8.count + envelope.s.utf8.count + 16
            if length > 48_000 {
                let whole = Data(SHA256.hash(data: Data(envelope.d.utf8))).base64URL
                let characters = Array(envelope.d.utf8)
                let of = (characters.count + partLength - 1) / partLength
                for i in 0..<of {
                    let piece = String(decoding: characters[(i * partLength)..<min(characters.count, (i + 1) * partLength)], as: UTF8.self)
                    mails.append(["part": ["whole": whole, "i": i, "of": of, "d": piece, "s": envelope.s]])
                }
                continue
            }
            if size + length > 48_000, !batch.isEmpty {
                mails.append(["give": batch])
                batch = []
                size = 0
            }
            batch.append(envelope.json)
            size += length
        }
        if !batch.isEmpty { mails.append(["give": batch]) }
        if let have {
            var mail: [String: Any] = ["have": have]
            if reply { mail["reply"] = true }
            mails.append(mail)
        }
        return mails
    }

    /// Documents too big for one mail, put together from their parts as they come, at most four on
    /// their way from one box at a time.
    public struct Assembler: Sendable {
        private struct Pending: Sendable {
            var of: Int
            var s: String
            var pieces: [Int: String] = [:]
        }

        private var pending: [String: Pending] = [:]
        private var order: [String] = []

        public init() {}

        /// The document once all its parts are here (and they're what its hash says), else nil.
        public mutating func take(_ part: [String: Any], from sender: String) -> Envelope? {
            guard let whole = part["whole"] as? String, let i = part["i"] as? Int, let of = part["of"] as? Int, of >= 2, of <= Documents.mostParts,
                  i >= 0, i < of, let d = part["d"] as? String, d.utf8.count <= Documents.partLength, let s = part["s"] as? String else { return nil }
            let key = "\(sender) \(whole)"
            if pending[key]?.of != of {
                let theirs = order.filter { $0.hasPrefix("\(sender) ") }
                if theirs.count >= 4, let oldest = theirs.first {
                    pending[oldest] = nil
                    order.removeAll { $0 == oldest }
                }
                pending[key] = Pending(of: of, s: s)
                order.append(key)
            }
            pending[key]?.pieces[i] = d
            guard let done = pending[key], done.pieces.count == of else { return nil }
            pending[key] = nil
            order.removeAll { $0 == key }
            let joined = (0..<of).compactMap { done.pieces[$0] }.joined()
            guard Data(SHA256.hash(data: Data(joined.utf8))).base64URL == whole else { return nil }
            return Envelope(d: joined, s: done.s)
        }
    }
}
