import Foundation

/// A host's side: answers the phones it's paired with, over its relay connection. The Mac app
/// runs one; machines run the same in JavaScript (`Resources/kuvo-link.js`).
public actor LinkServer {
    public struct Phone: Sendable, Hashable {
        public var key: Data
        public var name: String
        public var address: LinkAddress
    }

    /// Whether to let a phone in: its static key, its address on the relay (where its pushes go),
    /// and what it said (`pair` holds a pairing token).
    public typealias Authorize = @Sendable (_ key: Data, _ address: LinkAddress, _ hello: PhoneHello) async -> Bool
    /// What the relay said of a push: to which phone, and how it went.
    public typealias Pushed = @Sendable (_ to: LinkAddress, _ status: RelayMessage.PushStatus) -> Void
    /// Answers a request, in pieces.
    public typealias Handle = @Sendable (LinkRequest, Phone) -> AsyncThrowingStream<LinkResponsePart, Error>
    /// Opens a socket (PROTOCOL.md, "Sockets"): what the phone sends arrives on the input; what
    /// comes back goes to the phone, `.open` first.
    public typealias Connect = @Sendable (LinkRequest, Phone, AsyncStream<Data>) -> AsyncThrowingStream<LinkSocketEvent, Error>
    /// A phone's session proved its own: its first message opened with the keys of the handshake,
    /// which a replayed first handshake message can't do. Where it is now (for its notifications).
    public typealias Confirmed = @Sendable (Phone) -> Void
    /// A mail frame from another host (PROTOCOL.md, "Mail"), whole, and where it came from: the
    /// host opens it with the keys it takes mail from.
    public typealias Mailed = @Sendable (_ frame: Data, _ from: LinkAddress) -> Void

    let key: LinkKey
    let hello: HostHello
    let authorize: Authorize
    let handle: Handle
    let connect: Connect?
    let pushed: Pushed?
    let confirmed: Confirmed?
    let mailed: Mailed?
    private var relay: (any RelayTransport)?
    private var sessions: [SessionKey: Session] = [:]

    private struct SessionKey: Hashable {
        var address: LinkAddress
        var id: UInt32
    }

    private final class Session {
        let key: SessionKey
        let phone: Phone
        var transport: Transport
        var incoming: [Int: LinkRequest] = [:]
        var running: [Int: Task<Void, Never>] = [:]
        /// Open sockets' input, by request.
        var sockets: [Int: AsyncStream<Data>.Continuation] = [:]
        /// Its first message came, opened: it's the phone's own (see `Confirmed`).
        var isConfirmed = false

        init(key: SessionKey, phone: Phone, transport: Transport) {
            self.key = key
            self.phone = phone
            self.transport = transport
        }
    }

    public init(key: LinkKey, hello: HostHello, authorize: @escaping Authorize, handle: @escaping Handle, connect: Connect? = nil, pushed: Pushed? = nil, confirmed: Confirmed? = nil, mailed: Mailed? = nil) {
        self.key = key
        self.hello = hello
        self.authorize = authorize
        self.handle = handle
        self.connect = connect
        self.pushed = pushed
        self.confirmed = confirmed
        self.mailed = mailed
    }

    /// Serves over `relay` until it closes. Sessions on an earlier connection end. While a
    /// connection stays up, a session ends only with the phone told (a close) or by the phone's
    /// own doing: phones count on that rather than checking before each request (PROTOCOL.md,
    /// "The relay").
    public func serve(_ relay: any RelayTransport) async {
        for session in sessions.values { end(session, notify: false) }
        self.relay = relay
        for await message in relay.messages {
            switch message {
            case .deliver(let from, let payload):
                guard let frame = try? LinkFrame(payload) else { continue }
                await receive(frame, from: from)
            case .unreachable(let address):
                // The phone's gone (asleep, out of reach): nothing it asked for has anyone to go to.
                for session in sessions.values where session.key.address == address { end(session, notify: false) }
            case .gone(let address, _):
                // The phone's relay connection went or was replaced (it woke on a new one): it
                // ended its sessions with it, so what's under way for them stops here too.
                for session in sessions.values where session.key.address == address { end(session, notify: false) }
            case .pushed(let to, let status):
                pushed?(to, status)
            default:
                continue
            }
        }
        if self.relay === relay {
            self.relay = nil
            for session in sessions.values { end(session, notify: false) }
        }
    }

    /// Whether a phone has a session open: the app on its screen.
    public var hasSessions: Bool { !sessions.isEmpty }

    /// Whether what was queued for the relay (a push, a mail) is still on its way out.
    public var isSending: Bool { relay?.isSending ?? false }

    /// Ends every session, telling each phone, as this host stops (its engine starting over, the
    /// app quitting): a phone opens a new one for what it asks next at once, rather than finding
    /// out the old one's gone when that goes unanswered.
    public func closeAll() {
        for session in sessions.values { end(session, notify: true) }
    }

    /// Sends `notice` (a `Notice`'s JSON) to each phone's notifications, sealed for it alone; the
    /// relay pushes it to the phone through Apple. False with no relay connection to send it on.
    @discardableResult
    public func push(_ notice: Data, to phones: [(key: Data, address: LinkAddress)]) -> Bool {
        guard let relay else { return false }
        for phone in phones {
            guard let mail = try? Mail.seal(notice, from: key, to: phone.key) else { continue }
            relay.send(.push(to: phone.address, payload: mail))
        }
        return true
    }

    /// How a mail went: on its way, not now (no relay connection), or too big for the relay.
    public enum MailOutcome: Sendable, Equatable {
        case sent, offline, tooBig
    }

    /// Sends `payload` to another host (a machine's bridge), sealed for its key alone, through the
    /// relay. Nothing comes back: one that isn't connected now doesn't get it (the relay says it's
    /// unreachable). One the relay won't take (it would close this connection for it) isn't sent.
    @discardableResult
    public func mail(_ payload: Data, to remote: Data, at address: LinkAddress) -> MailOutcome {
        guard let relay else { return .offline }
        guard let sealed = try? Mail.seal(payload, from: key, to: remote), sealed.count <= RelayMessage.maxPayload else { return .tooBig }
        relay.send(.send(to: address, payload: sealed))
        return .sent
    }

    /// Ends the sessions of a phone that's no longer paired, and one it's let in meanwhile.
    public func forget(phone key: Data) {
        forgets += 1
        forgotten[key] = forgets
        for session in sessions.values where session.phone.key == key { end(session, notify: true) }
    }

    /// When each phone was last forgotten, counting forgets: one let in while it was asked whether
    /// to (`authorize`) and forgotten meanwhile doesn't get its session.
    private var forgotten: [Data: Int] = [:]
    private var forgets = 0

    private func receive(_ frame: LinkFrame, from address: LinkAddress) async {
        let key = SessionKey(address: address, id: frame.session)
        switch frame.kind {
        case .handshake1:
            await handshake(frame.body, key: key)
        case .transport:
            guard let session = sessions[key] else { return send(.close, key: key) }
            guard let plaintext = try? session.transport.open(frame.body), let message = try? LinkMessage(plaintext) else {
                return end(session, notify: true)
            }
            if !session.isConfirmed {
                session.isConfirmed = true
                confirmed?(session.phone)
            }
            receive(message, in: session)
        case .close:
            if let session = sessions[key] { end(session, notify: false) }
        case .mail:
            mailed?(frame.data, address)
        case .handshake2:
            break
        }
    }

    private func handshake(_ message: Data, key: SessionKey) async {
        var responder = IKResponder(staticKey: self.key, prologue: Link.prologue)
        let asked = forgets
        guard let payload = try? responder.readMessage1(message),
              let phoneHello = try? JSONDecoder().decode(PhoneHello.self, from: payload), phoneHello.v == Link.version,
              await authorize(responder.remoteStatic, key.address, phoneHello),
              (forgotten[responder.remoteStatic] ?? 0) <= asked,
              let (reply, transport) = try? responder.writeMessage2(payload: JSONEncoder().encode(hello))
        else { return send(.close, key: key) }
        // One session per phone: a new one replaces what's left of the last.
        for old in sessions.values where old.key.address == key.address { end(old, notify: false) }
        let phone = Phone(key: responder.remoteStatic, name: phoneHello.name, address: key.address)
        sessions[key] = Session(key: key, phone: phone, transport: transport)
        send(.handshake2, key: key, body: reply)
    }

    private func receive(_ message: LinkMessage, in session: Session) {
        let head = message.head
        switch head.t {
        case .req:
            guard let id = head.id, let method = head.m, let path = head.p else { return }
            let request = LinkRequest(method: method, path: path, headers: head.h ?? [:], body: message.body)
            if request.isSocket {
                open(request, id: id, in: session)
            } else if head.end == false {
                session.incoming[id] = request
            } else {
                run(request, id: id, in: session)
            }
        case .data:
            if let id = head.id, let socket = session.sockets[id] {
                if !message.body.isEmpty { socket.yield(message.body) }
                if head.end == true { session.sockets.removeValue(forKey: id)?.finish() }
                return
            }
            guard let id = head.id, var request = session.incoming[id] else { return }
            request.body += message.body
            if head.end == true {
                session.incoming[id] = nil
                run(request, id: id, in: session)
            } else {
                session.incoming[id] = request
            }
        case .cancel:
            guard let id = head.id else { return }
            session.running.removeValue(forKey: id)?.cancel()
            session.incoming[id] = nil
            session.sockets.removeValue(forKey: id)?.finish()
        case .ping:
            seal(LinkMessage(.init(t: .pong)), in: session)
        case .res, .pong:
            break
        }
    }

    private func run(_ request: LinkRequest, id: Int, in session: Session) {
        let stream = handle(request, session.phone)
        session.running[id] = Task {
            var head: LinkMessage.Head?
            do {
                for try await part in stream {
                    switch part {
                    case .head(let status, let headers):
                        head = .init(t: .res, id: id, h: headers, s: status)
                    case .body(let data):
                        // The head goes with the first piece of the body.
                        let first = head ?? .init(t: .data, id: id)
                        head = .init(t: .data, id: id)
                        self.reply(first, body: data, id: id, end: false, in: session)
                    }
                }
                self.reply(head ?? .init(t: .data, id: id), body: Data(), id: id, end: true, in: session)
            } catch {
                if head == nil || head?.t == .res {
                    let failed = LinkMessage.Head(t: .res, id: id, h: ["content-type": "text/plain"], s: 502)
                    self.reply(failed, body: Data(String(describing: error).utf8), id: id, end: true, in: session)
                } else {
                    self.reply(.init(t: .cancel, id: id), body: Data(), id: id, end: nil, in: session)
                }
            }
        }
    }

    /// A socket: open once the engine's is, then messages both ways until either side ends it.
    private func open(_ request: LinkRequest, id: Int, in session: Session) {
        guard let connect else {
            session.running[id] = Task {}
            return reply(.init(t: .res, id: id, h: ["content-type": "text/plain"], s: 501), body: Data("Sockets aren’t available here.".utf8), id: id, end: true, in: session)
        }
        let (input, feed) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingNewest(4096))
        session.sockets[id] = feed
        let events = connect(request, session.phone, input)
        session.running[id] = Task {
            var opened = false
            do {
                for try await event in events {
                    switch event {
                    case .open:
                        opened = true
                        self.reply(.init(t: .res, id: id, s: 101), body: Data(), id: id, end: false, in: session)
                    case .text(let data):
                        self.reply(.init(t: .data, id: id), body: data, id: id, end: false, in: session)
                    case .binary(let data):
                        // Binary messages are small (the engine's notes on a terminal); one too long to
                        // go whole doesn't go.
                        let head = LinkMessage.Head(t: .data, id: id, h: ["type": "binary"])
                        guard data.count <= LinkMessage.room(for: head) - 16 else { continue }
                        self.reply(head, body: data, id: id, end: false, in: session)
                    }
                }
                self.reply(opened ? .init(t: .data, id: id) : .init(t: .res, id: id, s: 502), body: Data(), id: id, end: true, in: session)
            } catch {
                if opened {
                    self.reply(.init(t: .data, id: id), body: Data(), id: id, end: true, in: session)
                } else {
                    self.reply(.init(t: .res, id: id, h: ["content-type": "text/plain"], s: 502), body: Data(String(describing: error).utf8), id: id, end: true, in: session)
                }
            }
            session.sockets.removeValue(forKey: id)?.finish()
        }
    }

    private func reply(_ head: LinkMessage.Head, body: Data, id: Int, end: Bool?, in session: Session) {
        // A cancelled request says nothing more.
        guard session.running[id] != nil, sessions[session.key] === session else { return }
        if head.t == .cancel {
            seal(LinkMessage(head), in: session)
        } else {
            for piece in LinkMessage.pieces(head, body: body, end: end ?? false) { seal(piece, in: session) }
        }
        if end != false { session.running[id] = nil }
    }

    private func seal(_ message: LinkMessage, in session: Session) {
        guard let ciphertext = try? session.transport.seal(message.data) else { return end(session, notify: true) }
        send(.transport, key: session.key, body: ciphertext)
    }

    private func end(_ session: Session, notify: Bool) {
        guard sessions[session.key] === session else { return }
        sessions[session.key] = nil
        for task in session.running.values { task.cancel() }
        session.running = [:]
        for socket in session.sockets.values { socket.finish() }
        session.sockets = [:]
        if notify { send(.close, key: session.key) }
    }

    private func send(_ kind: LinkFrame.Kind, key: SessionKey, body: Data = Data()) {
        relay?.send(.send(to: key.address, payload: LinkFrame(kind, session: key.id, body: body).data))
    }
}
