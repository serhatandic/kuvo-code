import CryptoKit
import Foundation

public enum Link {
    public static let version = 1
    static let prologue = Data("kuvo-link v1".utf8)
    static let mailPrologue = Data("kuvo-link mail v1".utf8)
    /// How long a handshake may take before the host counts as unreachable.
    static let handshakeTimeout: Duration = .seconds(15)
    /// How long a request may wait for its answer with nothing at all from the host before the
    /// phone checks the host's still there. A host that started again or left is told by the
    /// relay (`gone`), but one whose connection died without closing (a Mac put to sleep, a path
    /// gone dead) still takes frames until the relay notices, up to a minute later, and never
    /// answers them. A host that's there answers the check, and the request waits on.
    static let answerWithin: Duration = .seconds(5)
    /// How long a check may take: a host that has the session answers at once.
    static let checkTimeout: Duration = .seconds(5)
}

public enum LinkError: Error, Equatable, LocalizedError {
    /// The relay has nothing connected at the host's address.
    case hostOffline
    /// The host turned the phone away: not paired, or a pairing link that's used up.
    case refused
    /// The session ended while a request was under way.
    case closed
    case relayUnavailable
    case unsupportedVersion
    case timedOut
    /// The host wouldn't open a socket there.
    case notAvailable

    public var errorDescription: String? {
        switch self {
        case .hostOffline: "It may be asleep or offline."
        case .refused: "It turned this phone away. Pair again."
        case .closed: "The connection closed."
        case .relayUnavailable: "Couldn’t reach the relay."
        case .unsupportedVersion: "It runs a version this app doesn’t know. Update both."
        case .timedOut: "It didn’t answer."
        case .notAvailable: "It couldn’t open that."
        }
    }
}

/// A host the phone is paired with.
public struct PairedHost: Codable, Hashable, Sendable {
    public var address: String
    public var key: Data
    public var name: String
    public var kind: HostHello.Kind

    public init(address: LinkAddress, key: Data, name: String, kind: HostHello.Kind) {
        self.address = address.text
        self.key = key
        self.name = name
        self.kind = kind
    }

    public var linkAddress: LinkAddress { LinkAddress(text: address)! }
}

/// A request to a host, like an HTTP one.
public struct LinkRequest: Sendable, Equatable {
    public var method: String
    public var path: String
    public var headers: [String: String]
    public var body: Data

    public init(method: String = "GET", path: String, headers: [String: String] = [:], body: Data = Data()) {
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body
    }
}

extension LinkRequest {
    /// A request that opens a socket on the host's engine (PROTOCOL.md, "Sockets").
    public static func socket(_ path: String, headers: [String: String] = [:]) -> LinkRequest {
        LinkRequest(path: path, headers: headers.merging(["upgrade": "websocket"]) { $1 })
    }

    public var isSocket: Bool { headers["upgrade"]?.lowercased() == "websocket" }
}

/// What comes over a socket: that it's open, then its messages.
public enum LinkSocketEvent: Sendable, Equatable {
    case open
    case text(Data)
    case binary(Data)
}

/// A socket on a host's engine, through the link: what comes from it, and a way to send it text.
/// It closes when you close it, stop reading, or the host or engine ends it.
public struct LinkSocket: Sendable {
    public let events: AsyncThrowingStream<LinkSocketEvent, Error>
    let write: @Sendable (Data) async throws -> Void
    let stop: @Sendable () -> Void

    /// Sends one text message, once it's open.
    public func send(_ text: Data) async throws { try await write(text) }

    public func close() { stop() }
}

/// A response, as it arrives: its status and headers once, then its body in pieces.
public enum LinkResponsePart: Sendable, Equatable {
    case head(status: Int, headers: [String: String])
    case body(Data)
}

/// Pushes and other messages for a device that may not be connected (PROTOCOL.md, "Mail").
public enum Mail {
    /// A mail frame, for the relay's `push`.
    public static func seal(_ payload: Data, from key: LinkKey, to remoteStatic: Data) throws -> Data {
        LinkFrame(.mail, session: 0, body: try OneWay.seal(payload, from: key, to: remoteStatic, prologue: Link.mailPrologue).message).data
    }

    public static func open(_ frame: Data, to key: LinkKey, from remoteStatic: Data) throws -> Data {
        let frame = try LinkFrame(frame)
        guard frame.kind == .mail else { throw FrameError.malformed }
        return try OneWay.open(frame.body, to: key, from: remoteStatic, prologue: Link.mailPrologue).payload
    }
}

/// What the link tells the time by and waits with: the real clock, or one a test moves by hand.
struct LinkClock: Sendable {
    var now: @Sendable () -> ContinuousClock.Instant
    var sleep: @Sendable (Duration) async -> Void

    static let real = LinkClock(now: { .now }, sleep: { try? await Task.sleep(for: $0) })
}

/// The phone's side: sessions with the hosts it's paired with, over one relay connection.
public actor LinkClient {
    public typealias Connect = @Sendable (URL, RelaySecret) async throws -> any RelayTransport

    public nonisolated let relayURL: URL
    let key: LinkKey
    let secret: RelaySecret
    let hello: PhoneHello
    let connect: Connect

    private var relay: (any RelayTransport)?
    private var connecting: Task<any RelayTransport, Error>?
    private var sessions: [LinkAddress: Session] = [:]
    private var registration: PushRegistration?
    private var clock = LinkClock.real

    private final class Session {
        /// A new one if its handshake starts over (see `startOver`).
        var id = UInt32.random(in: 1...UInt32.max)
        var host: PairedHost
        /// The pairing token its handshake carries, while pairing.
        let pairing: Data?
        var initiator: IKInitiator?
        var transport: Transport?
        var hostHello: HostHello?
        var waiting: [CheckedContinuation<Void, Error>] = []
        /// When the host last said anything on it.
        var lastHeard: ContinuousClock.Instant
        /// Whether a check that the host's still there (see `checkAnswer`) is under way; which check
        /// it is, for its timeout.
        var checking = false
        var check = 0
        /// Requests sent that have no answer yet.
        var unanswered: Set<Int> = []
        var nextID = 1
        var streams: [Int: AsyncThrowingStream<LinkResponsePart, Error>.Continuation] = [:]
        var sockets: [Int: AsyncThrowingStream<LinkSocketEvent, Error>.Continuation] = [:]

        init(host: PairedHost, pairing: Data?, now: ContinuousClock.Instant) {
            self.host = host
            self.pairing = pairing
            lastHeard = now
        }
    }

    public init(relay: URL, key: LinkKey, secret: RelaySecret, name: String, app: String, connect: @escaping Connect = WebSocketRelay.connect) {
        relayURL = relay
        self.key = key
        self.secret = secret
        hello = PhoneHello(name: name, app: app)
        self.connect = connect
    }

    /// Pairs with the host a pairing link names. Returns it, to keep.
    public func pair(_ link: PairingLink) async throws -> PairedHost {
        let address = link.host
        if let old = sessions[address] { end(old, with: .closed) }
        var host = PairedHost(address: address, key: link.key, name: link.name, kind: .mac)
        let hostHello = try await open(host, pairing: link.token)
        host.name = hostHello.name
        host.kind = hostHello.kind
        sessions[address]?.host = host
        return host
    }

    /// What the host says it is, opening a session if there's none.
    public func hostHello(_ host: PairedHost) async throws -> HostHello {
        try await open(host, pairing: nil)
    }

    /// Sends `request` to `host`; the response arrives in pieces. Stopping early (leaving the loop,
    /// or cancelling the task that reads) cancels the request on the host.
    public nonisolated func send(_ request: LinkRequest, to host: PairedHost) -> LinkResponse {
        let ticket = Ticket()
        let stop: @Sendable () -> Void = { Task { await self.cancel(ticket, on: host) } }
        let stream = AsyncThrowingStream<LinkResponsePart, Error> { continuation in
            let task = Task { await self.start(request, to: host, ticket: ticket, continuation: continuation) }
            continuation.onTermination = { termination in
                guard case .cancelled = termination else { return }
                task.cancel()
                stop()
            }
        }
        return LinkResponse(stream: stream, stop: stop)
    }

    /// Opens a socket on `host`'s engine (`api/pty/<id>/connect`, a terminal).
    public nonisolated func socket(_ request: LinkRequest, to host: PairedHost) -> LinkSocket {
        let request = LinkRequest.socket(request.path, headers: request.headers)
        let ticket = Ticket()
        let stop: @Sendable () -> Void = { Task { await self.cancel(ticket, on: host) } }
        let events = AsyncThrowingStream<LinkSocketEvent, Error> { continuation in
            let task = Task { await self.start(request, to: host, ticket: ticket, for: .socket(continuation)) }
            continuation.onTermination = { termination in
                guard case .cancelled = termination else { return }
                task.cancel()
                stop()
            }
        }
        return LinkSocket(events: events, write: { text in try await self.write(text, ticket: ticket, on: host) }, stop: stop)
    }

    /// Where the relay sends this phone's pushes, and from whom it takes them: sent now
    /// (connecting to the relay if need be) and again each time the relay connection is made,
    /// as the relay asks; nil stops sending it.
    public func register(_ registration: PushRegistration?) async {
        self.registration = registration
        guard let registration else { return }
        if let relay {
            relay.send(.register(registration))
        } else {
            // Sends it once it's connected.
            _ = try? await relayConnection()
        }
    }

    #if DEBUG
    /// The relay connection gone, as a phone put to sleep loses it: no close sent to anyone.
    func dropRelayForTesting() {
        relay?.close()
    }

    /// Time that passes only when a test moves it.
    func setClockForTesting(_ clock: LinkClock) {
        self.clock = clock
    }

    /// Each time the host is heard on a session, from now on.
    func heardForTesting() -> AsyncStream<Void> {
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
        heardWatchers.append(continuation)
        return stream
    }

    private var heardWatchers: [AsyncStream<Void>.Continuation] = []
    #endif

    /// Ends every session and the relay connection.
    public func disconnect() {
        for session in sessions.values { end(session, with: .closed) }
        relay?.close()
        relay = nil
    }

    // MARK: Sessions

    @discardableResult
    private func open(_ host: PairedHost, pairing token: Data?) async throws -> HostHello {
        let address = host.linkAddress
        if let session = sessions[address] {
            if let hello = session.hostHello { return hello }
            try await withCheckedThrowingContinuation { session.waiting.append($0) }
            return session.hostHello!
        }
        let session = Session(host: host, pairing: token, now: clock.now())
        sessions[address] = session
        do {
            let relay = try await relayConnection()
            // Ended while connecting (a pairing started over, the relay dropped): nothing will answer it.
            guard sessions[address] === session else { throw LinkError.closed }
            try sendHandshake(session, on: relay)
            let clock = clock
            Task {
                await clock.sleep(Link.handshakeTimeout)
                self.timeOut(session)
            }
            try await withCheckedThrowingContinuation { session.waiting.append($0) }
            return session.hostHello!
        } catch {
            end(session, with: (error as? LinkError) ?? .relayUnavailable)
            throw error
        }
    }

    /// The handshake's first message, under the session's number.
    private func sendHandshake(_ session: Session, on relay: any RelayTransport) throws {
        var initiator = IKInitiator(staticKey: key, remoteStatic: session.host.key, prologue: Link.prologue)
        var hello = self.hello
        hello.pair = session.pairing?.base64URL
        let message = try initiator.writeMessage1(payload: JSONEncoder().encode(hello))
        session.initiator = initiator
        relay.send(.send(to: session.host.linkAddress, payload: LinkFrame(.handshake1, session: session.id, body: message).data))
    }

    /// The host was replaced or left while this session's handshake was on its way: it may have
    /// reached the old host, which won't answer, or the new one, which will. Sent again under a
    /// new number, the new host answers that one (and drops the first); a host that's gone is
    /// unreachable, as for any handshake.
    private func startOver(_ session: Session) {
        guard let relay, session.transport == nil, session.initiator != nil else { return }
        session.id = UInt32.random(in: 1...UInt32.max)
        do { try sendHandshake(session, on: relay) } catch { end(session, with: .closed, tellingHost: false) }
    }

    /// No answer in time: whoever waits on it hears so, whether or not it's still the current one.
    private func timeOut(_ session: Session) {
        if session.transport == nil { end(session, with: .timedOut) }
    }

    /// Ends `session`, telling the host unless it no longer has it (the relay said it's gone).
    private func end(_ session: Session, with error: LinkError, tellingHost: Bool = true) {
        let address = session.host.linkAddress
        if sessions[address] === session { sessions[address] = nil }
        for waiter in session.waiting { waiter.resume(throwing: error) }
        session.waiting = []
        session.checking = false
        session.unanswered = []
        for stream in session.streams.values { stream.finish(throwing: error) }
        session.streams = [:]
        for socket in session.sockets.values { socket.finish(throwing: error) }
        session.sockets = [:]
        if tellingHost, session.transport != nil { relay?.send(.send(to: address, payload: LinkFrame(.close, session: session.id).data)) }
        session.transport = nil
    }

    private func start(_ request: LinkRequest, to host: PairedHost, ticket: Ticket, continuation: AsyncThrowingStream<LinkResponsePart, Error>.Continuation) async {
        await start(request, to: host, ticket: ticket, for: .response(continuation))
    }

    /// Who hears a request's answer.
    private enum Listener: Sendable {
        case response(AsyncThrowingStream<LinkResponsePart, Error>.Continuation)
        case socket(AsyncThrowingStream<LinkSocketEvent, Error>.Continuation)

        func failed(_ error: Error) {
            switch self {
            case .response(let continuation): continuation.finish(throwing: error)
            case .socket(let continuation): continuation.finish(throwing: error)
            }
        }
    }

    /// Sends `request`, once there's a session the host still has, with who hears its answer set
    /// up first.
    private func start(_ request: LinkRequest, to host: PairedHost, ticket: Ticket, for listener: Listener) async {
        do {
            try await open(host, pairing: nil)
            guard let session = sessions[host.linkAddress], session.transport != nil else { throw LinkError.closed }
            try Task.checkCancellation()
            let id = session.nextID
            session.nextID += 1
            ticket.set(id: id, session: session.id)
            switch listener {
            case .response(let continuation): session.streams[id] = continuation
            case .socket(let continuation): session.sockets[id] = continuation
            }
            let head = LinkMessage.Head(t: .req, id: id, m: request.method, p: request.path, h: request.headers)
            for piece in LinkMessage.pieces(head, body: request.body, end: true) {
                try seal(piece, in: session)
            }
            session.unanswered.insert(id)
            watchAnswer(id, in: session)
        } catch {
            listener.failed(error)
        }
    }

    /// Pings the host on a session, unless a ping's already on its way: its answer, or the host
    /// closing a session it doesn't have, says whether it's still there; no answer in time ends it.
    private func startCheck(_ session: Session) throws {
        guard !session.checking else { return }
        try seal(LinkMessage(.init(t: .ping)), in: session)
        session.checking = true
        session.check += 1
        timeCheck(session.check, on: session)
    }

    /// Gives a check its time from when the ping has left: it may be behind this phone's own
    /// frames on their way out (a big body on a slow connection).
    private func timeCheck(_ check: Int, on session: Session) {
        let (relay, clock) = (relay, clock)
        Task {
            await relay?.allSent()
            await clock.sleep(Link.checkTimeout)
            self.checkTimedOut(session, check: check)
        }
    }

    /// Checks on a request a while after it went, and again while it waits.
    private func watchAnswer(_ id: Int, in session: Session) {
        let clock = clock
        Task {
            await clock.sleep(Link.answerWithin)
            self.checkAnswer(id, in: session)
        }
    }

    /// A request still without an answer: if the host hasn't said anything for a while either, a
    /// check finds out whether it's there. One that's there just takes long, and waits on.
    private func checkAnswer(_ id: Int, in session: Session) {
        guard sessions[session.host.linkAddress] === session, session.unanswered.contains(id) else { return }
        // Not while this phone's own frames are still going out (a big body on a slow
        // connection): the host can't answer what hasn't reached it, and a ping would wait behind it.
        if relay?.isSending != true, clock.now() - session.lastHeard >= Link.answerWithin {
            do { try startCheck(session) } catch { return end(session, with: .closed) }
        }
        watchAnswer(id, in: session)
    }

    /// The host said something on it: it's still there.
    private func heard(_ session: Session) {
        session.lastHeard = clock.now()
        #if DEBUG
        for watcher in heardWatchers { watcher.yield() }
        #endif
        session.checking = false
    }

    /// No answer to a check in time: the session's gone, whatever was on it with it.
    private func checkTimedOut(_ session: Session, check: Int) {
        guard session.checking, session.check == check else { return }
        end(session, with: .timedOut)
    }

    private func cancel(_ ticket: Ticket, on host: PairedHost) {
        guard let (id, sessionID) = ticket.value, let session = sessions[host.linkAddress], session.id == sessionID else { return }
        session.unanswered.remove(id)
        let socket = session.sockets.removeValue(forKey: id)
        guard session.streams.removeValue(forKey: id) != nil || socket != nil else { return }
        socket?.finish()
        try? seal(LinkMessage(.init(t: .cancel, id: id)), in: session)
    }

    /// One text message on an open socket.
    private func write(_ text: Data, ticket: Ticket, on host: PairedHost) throws {
        guard let (id, sessionID) = ticket.value, let session = sessions[host.linkAddress], session.id == sessionID,
              session.sockets[id] != nil
        else { throw LinkError.closed }
        for piece in LinkMessage.pieces(.init(t: .data, id: id), body: text, end: false) {
            try seal(piece, in: session)
        }
    }

    private func seal(_ message: LinkMessage, in session: Session) throws {
        guard var transport = session.transport, let relay else { throw LinkError.closed }
        let ciphertext = try transport.seal(message.data)
        session.transport = transport
        relay.send(.send(to: session.host.linkAddress, payload: LinkFrame(.transport, session: session.id, body: ciphertext).data))
    }

    // MARK: The relay

    private func relayConnection() async throws -> any RelayTransport {
        if let relay { return relay }
        if let connecting { return try await connecting.value }
        let (connect, url, secret) = (connect, relayURL, secret)
        let task = Task { try await connect(url, secret) }
        connecting = task
        defer { connecting = nil }
        do {
            let relay = try await task.value
            self.relay = relay
            if let registration { relay.send(.register(registration)) }
            Task { [weak self] in
                for await message in relay.messages { await self?.receive(message) }
                await self?.relayEnded(relay)
            }
            return relay
        } catch {
            throw LinkError.relayUnavailable
        }
    }

    private func relayEnded(_ ended: any RelayTransport) {
        guard relay === ended else { return }
        relay = nil
        // A host can't tell a session's frames went missing, so start again.
        for session in sessions.values { end(session, with: .closed) }
    }

    private func receive(_ message: RelayMessage) {
        switch message {
        case .deliver(let from, let payload):
            guard let frame = try? LinkFrame(payload), let session = sessions[from], session.id == frame.session else { return }
            receive(frame, in: session)
        case .unreachable(let address):
            if let session = sessions[address] { end(session, with: .hostOffline) }
        case .gone(let address, let gone):
            // The host started again (or came back) or left: it has none of this phone's sessions,
            // so streams that only listen end now rather than waiting on it forever. One that
            // started again is there for a new session at once; one that left is offline.
            guard let session = sessions[address] else { return }
            if session.transport == nil { return startOver(session) }
            end(session, with: gone == .replaced ? .closed : .hostOffline, tellingHost: false)
        default:
            break
        }
    }

    private func receive(_ frame: LinkFrame, in session: Session) {
        switch frame.kind {
        case .handshake2:
            guard var initiator = session.initiator, session.transport == nil else { return }
            do {
                let (payload, transport) = try initiator.readMessage2(frame.body)
                let hello = try JSONDecoder().decode(HostHello.self, from: payload)
                session.initiator = nil
                session.transport = transport
                session.lastHeard = clock.now()
                guard hello.v == Link.version else { return end(session, with: .unsupportedVersion) }
                session.hostHello = hello
                for waiter in session.waiting { waiter.resume() }
                session.waiting = []
            } catch {
                end(session, with: .refused)
            }
        case .transport:
            guard var transport = session.transport else { return }
            guard let plaintext = try? transport.open(frame.body), let message = try? LinkMessage(plaintext) else {
                return end(session, with: .closed)
            }
            session.transport = transport
            heard(session)
            receive(message, in: session)
        case .close:
            end(session, with: session.transport == nil ? .refused : .closed)
        case .handshake1, .mail:
            break
        }
    }

    private func receive(_ message: LinkMessage, in session: Session) {
        let head = message.head
        switch head.t {
        case .res, .data:
            // Answered, with a head or (a host that sends none) its body.
            if let id = head.id { session.unanswered.remove(id) }
            if let id = head.id, let socket = session.sockets[id] {
                if head.t == .res, head.s != 101 {
                    session.sockets[id] = nil
                    return socket.finish(throwing: LinkError.notAvailable)
                }
                if head.t == .res { socket.yield(.open) }
                if !message.body.isEmpty { socket.yield(head.h?["type"] == "binary" ? .binary(message.body) : .text(message.body)) }
                if head.end == true {
                    session.sockets[id] = nil
                    socket.finish()
                }
                return
            }
            guard let id = head.id, let stream = session.streams[id] else { return }
            if head.t == .res { stream.yield(.head(status: head.s ?? 502, headers: head.h ?? [:])) }
            if !message.body.isEmpty { stream.yield(.body(message.body)) }
            if head.end == true {
                session.streams[id] = nil
                stream.finish()
            }
        case .cancel:
            guard let id = head.id else { return }
            session.unanswered.remove(id)
            session.streams.removeValue(forKey: id)?.finish(throwing: LinkError.closed)
            session.sockets.removeValue(forKey: id)?.finish(throwing: LinkError.closed)
        case .ping:
            try? seal(LinkMessage(.init(t: .pong)), in: session)
        case .req, .pong:
            break
        }
    }
}

/// A response's pieces as they arrive. The session holds on to the stream while the host may
/// still send, so leaving the loop early has to say so: the iterator does when it goes.
public struct LinkResponse: AsyncSequence, Sendable {
    public typealias Element = LinkResponsePart

    let stream: AsyncThrowingStream<LinkResponsePart, Error>
    let stop: @Sendable () -> Void

    public func makeAsyncIterator() -> Iterator {
        Iterator(base: stream.makeAsyncIterator(), stopper: Stopper(stop))
    }

    public struct Iterator: AsyncIteratorProtocol {
        var base: AsyncThrowingStream<LinkResponsePart, Error>.Iterator
        let stopper: Stopper

        public mutating func next() async throws -> LinkResponsePart? {
            try await base.next()
        }
    }

    final class Stopper {
        let stop: @Sendable () -> Void
        init(_ stop: @escaping @Sendable () -> Void) { self.stop = stop }
        // Cancelling a request that already ended does nothing.
        deinit { stop() }
    }
}

/// Which request a stream became, for cancelling it.
private final class Ticket: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: (Int, UInt32)?

    func set(id: Int, session: UInt32) { lock.withLock { stored = (id, session) } }
    var value: (Int, UInt32)? { lock.withLock { stored } }
}

/// The machines' side of the link (`Resources/kuvo-link.js`): the script the Mac app puts in a
/// machine's `~/.kuvo-code/bin` and the engine's runtime runs.
public enum Bridge {
    public static let fileName = "kuvo-link.js"

    public static var script: Data {
        get throws { try Data(contentsOf: Bundle.module.url(forResource: "kuvo-link", withExtension: "js")!) }
    }
}
