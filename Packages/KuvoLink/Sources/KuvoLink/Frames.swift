import Foundation

public enum FrameError: Error, Equatable {
    case malformed
}

/// A message between a device and the relay (see PROTOCOL.md, "The relay").
public enum RelayMessage: Equatable, Sendable {
    // A device sends these.
    case hello(RelaySecret)
    case send(to: LinkAddress, payload: Data)
    case register(PushRegistration)
    case push(to: LinkAddress, payload: Data)
    // The relay sends these.
    case welcome(LinkAddress)
    case deliver(from: LinkAddress, payload: Data)
    case unreachable(LinkAddress)
    case pushed(to: LinkAddress, status: PushStatus)
    /// The device at this address, which sent it something on its current connection, has a new
    /// connection now or none: whatever sessions it had are over.
    case gone(LinkAddress, Gone)

    public static let maxPayload = 65_600

    public enum Gone: UInt8, Sendable {
        /// A new connection took the address (a host that started again, or came back).
        case replaced = 0
        /// Its connection closed, and nothing is at the address now. Any reason but 0 reads as this.
        case left = 1
    }

    public enum PushStatus: UInt8, Sendable {
        case sent = 0, noPhone, notAllowed, refused
    }

    public var data: Data {
        switch self {
        case .hello(let secret): Data([1]) + secret.bytes
        case .welcome(let address): Data([1]) + address.bytes
        case .send(let to, let payload): Data([2]) + to.bytes + payload
        case .deliver(let from, let payload): Data([2]) + from.bytes + payload
        case .unreachable(let to): Data([3]) + to.bytes
        case .register(let registration): Data([4]) + ((try? JSONEncoder().encode(registration)) ?? Data())
        case .push(let to, let payload): Data([5]) + to.bytes + payload
        case .pushed(let to, let status): Data([6]) + to.bytes + Data([status.rawValue])
        case .gone(let address, let gone): Data([7]) + address.bytes + Data([gone.rawValue])
        }
    }

    /// Reads what the relay sent a device.
    public init(fromRelay data: Data) throws {
        let data = Data(data)
        guard let kind = data.first else { throw FrameError.malformed }
        let rest = data.dropFirst()
        let address = LinkAddress(bytes: rest.prefix(LinkAddress.length))
        switch kind {
        case 1 where rest.count == LinkAddress.length: self = .welcome(address!)
        case 2 where address != nil: self = .deliver(from: address!, payload: Data(rest.dropFirst(LinkAddress.length)))
        case 3 where rest.count == LinkAddress.length: self = .unreachable(address!)
        case 6 where rest.count == LinkAddress.length + 1:
            guard let status = PushStatus(rawValue: rest.last!) else { throw FrameError.malformed }
            self = .pushed(to: address!, status: status)
        case 7 where rest.count == LinkAddress.length + 1:
            // A reason this doesn't know yet counts as left: the sessions are over either way.
            self = .gone(address!, rest.last! == Gone.replaced.rawValue ? .replaced : .left)
        default: throw FrameError.malformed
        }
    }
}

/// Where the relay sends a phone's pushes, and from whom it takes them.
public struct PushRegistration: Codable, Equatable, Sendable {
    public var token: String
    public var environment: String
    public var topic: String
    public var senders: [String]

    public init(token: String, environment: String, topic: String, senders: [LinkAddress]) {
        self.token = token
        self.environment = environment
        self.topic = topic
        self.senders = senders.map(\.text)
    }
}

/// What one device sends another through the relay (PROTOCOL.md, "Link frames").
public struct LinkFrame: Equatable, Sendable {
    public enum Kind: UInt8, Sendable {
        case handshake1 = 1, handshake2, transport, close, mail
    }

    public var kind: Kind
    public var session: UInt32
    public var body: Data

    public init(_ kind: Kind, session: UInt32, body: Data = Data()) {
        self.kind = kind
        self.session = session
        self.body = body
    }

    public init(_ data: Data) throws {
        let data = Data(data)
        guard data.count >= 5, let kind = Kind(rawValue: data[0]) else { throw FrameError.malformed }
        self.kind = kind
        session = data[1..<5].reduce(0) { $0 << 8 | UInt32($1) }
        body = Data(data.dropFirst(5))
    }

    public var data: Data {
        Data([kind.rawValue]) + withUnsafeBytes(of: session.bigEndian) { Data($0) } + body
    }
}

/// One message inside a session: a JSON head and a body (PROTOCOL.md, "Messages in a session").
public struct LinkMessage: Equatable, Sendable {
    public struct Head: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable {
            case req, res, data, cancel, ping, pong
        }

        public var t: Kind
        public var id: Int?
        /// The request's method and path.
        public var m: String?
        public var p: String?
        public var h: [String: String]?
        /// The response's status.
        public var s: Int?
        /// Whether this is the last piece of the request's or response's body.
        public var end: Bool?

        public init(t: Kind, id: Int? = nil, m: String? = nil, p: String? = nil, h: [String: String]? = nil, s: Int? = nil, end: Bool? = nil) {
            self.t = t
            self.id = id
            self.m = m
            self.p = p
            self.h = h
            self.s = s
            self.end = end
        }
    }

    /// What fits in one transport message, head included.
    public static let maxLength = Noise.maxMessage - Noise.tagLength

    public var head: Head
    public var body: Data

    public init(_ head: Head, body: Data = Data()) {
        self.head = head
        self.body = body
    }

    public init(_ data: Data) throws {
        let data = Data(data)
        guard data.count >= 2 else { throw FrameError.malformed }
        let length = Int(data[0]) << 8 | Int(data[1])
        guard data.count >= 2 + length, let head = try? JSONDecoder().decode(Head.self, from: data[2..<(2 + length)]) else { throw FrameError.malformed }
        self.head = head
        body = Data(data.dropFirst(2 + length))
    }

    public var data: Data {
        let head = (try? Self.encoder.encode(head)) ?? Data()
        return Data([UInt8(head.count >> 8), UInt8(head.count & 0xFF)]) + head + body
    }

    /// The room left for a body beside this head.
    public static func room(for head: Head) -> Int {
        maxLength - 2 - ((try? encoder.encode(head).count) ?? 0)
    }

    /// `head` and `body` as messages that each fit: the first with `head`, the rest as `data`,
    /// the last marked `end` when `end` is true.
    public static func pieces(_ head: Head, body: Data, end: Bool) -> [LinkMessage] {
        var head = head
        head.end = false
        var pieces: [LinkMessage] = []
        var rest = body[...]
        repeat {
            // The head grows by `"end":true` at most. A head too big to leave room makes a message
            // too long, which sealing turns away, rather than one byte at a time forever.
            let room = max(room(for: head) - 8, 1024)
            pieces.append(LinkMessage(head, body: Data(rest.prefix(room))))
            rest = rest.dropFirst(room)
            head = Head(t: .data, id: head.id, end: false)
        } while !rest.isEmpty
        pieces[pieces.count - 1].head.end = end
        return pieces
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}

/// The first handshake message's payload: the phone saying who it is.
public struct PhoneHello: Codable, Equatable, Sendable {
    public var v = 1
    public var name: String
    public var app: String
    /// The pairing token, while pairing.
    public var pair: String?

    public init(name: String, app: String, pair: String? = nil) {
        self.name = name
        self.app = app
        self.pair = pair
    }
}

/// The second handshake message's payload: the host saying what it is.
public struct HostHello: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case mac, machine }

    public var v = 1
    public var kind: Kind
    public var name: String
    public var app: String
    public var engine: String?

    public init(kind: Kind, name: String, app: String, engine: String?) {
        self.kind = kind
        self.name = name
        self.app = app
        self.engine = engine
    }
}

/// What a host shows, as a QR code, for a phone to pair with it.
public struct PairingLink: Equatable, Sendable {
    public var relay: URL
    public var host: LinkAddress
    public var key: Data
    public var token: Data
    public var name: String

    public init(relay: URL, host: LinkAddress, key: Data, token: Data = randomBytes(16), name: String) {
        self.relay = relay
        self.host = host
        self.key = key
        self.token = token
        self.name = name
    }

    public init?(_ url: URL) {
        guard url.scheme == "kuvo-link", url.host() == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("v") == "1",
              let relay = value("relay").flatMap(URL.init(string:)), ["ws", "wss"].contains(relay.scheme),
              let host = value("host").flatMap(LinkAddress.init(text:)),
              let key = value("key").flatMap(Data.init(base64URL:)), key.count == Noise.keyLength,
              let token = value("token").flatMap(Data.init(base64URL:)), token.count == 16
        else { return nil }
        self.init(relay: relay, host: host, key: key, token: token, name: value("name") ?? "")
    }

    public var url: URL {
        var components = URLComponents()
        components.scheme = "kuvo-link"
        components.host = "pair"
        components.queryItems = [
            URLQueryItem(name: "v", value: "1"),
            URLQueryItem(name: "relay", value: relay.absoluteString),
            URLQueryItem(name: "host", value: host.text),
            URLQueryItem(name: "key", value: key.base64URL),
            URLQueryItem(name: "token", value: token.base64URL),
            URLQueryItem(name: "name", value: name),
        ]
        return components.url!
    }
}
