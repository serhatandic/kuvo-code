import CryptoKit
import Foundation
import Testing
@testable import KuvoLink

/// A relay in memory: passes `send`s to whoever is connected at the address. Like the relay, it
/// tells each device that sent something to a connection when that connection is replaced or
/// closes (`gone`), and drops what a replaced connection still sends; `tellsGone: false` is a
/// relay from before that, which does neither.
final class MemoryRelay: @unchecked Sendable {
    let tellsGone: Bool
    private let lock = NSLock()
    private var connected: [LinkAddress: Connection] = [:]
    private var registered: [PushRegistration] = []
    private var phones: [LinkAddress: PushRegistration] = [:]
    private var pushed: [(to: LinkAddress, from: LinkAddress, payload: Data)] = []

    init(tellsGone: Bool = true) {
        self.tellsGone = tellsGone
    }

    /// Each push registration a phone sent, in order.
    var registrations: [PushRegistration] { lock.withLock { registered } }
    /// Each push that went to a phone, as Apple would have it.
    var pushes: [(to: LinkAddress, from: LinkAddress, payload: Data)] { lock.withLock { pushed } }

    final class Connection: RelayTransport, @unchecked Sendable {
        let address: LinkAddress
        let messages: AsyncStream<RelayMessage>
        let inbox: AsyncStream<RelayMessage>.Continuation
        weak var relay: MemoryRelay?
        // Kept under the relay's lock: who sent to this connection, and to whom it sent.
        fileprivate var heardFrom: [ObjectIdentifier: Connection] = [:]
        fileprivate var sentTo: [ObjectIdentifier: Connection] = [:]
        /// Takes frames and never hears them, as a connection that died without closing does
        /// until the relay notices.
        fileprivate var deaf = false

        init(address: LinkAddress, relay: MemoryRelay) {
            self.address = address
            self.relay = relay
            (messages, inbox) = AsyncStream.makeStream()
        }

        func send(_ message: RelayMessage) { relay?.route(message, from: self) }
        func close() {
            inbox.finish()
            relay?.drop(self)
        }
    }

    func connect(_ secret: RelaySecret) -> Connection {
        let connection = Connection(address: secret.address, relay: self)
        lock.withLock {
            if let old = connected[secret.address] {
                old.inbox.finish()
                leave(old, .replaced)
            }
            connected[secret.address] = connection
        }
        return connection
    }

    var connect: LinkClient.Connect {
        { _, secret in self.connect(secret) }
    }

    /// The connection at `address` stays listed and takes frames, but nothing reaches whoever
    /// held it: a host whose connection died without closing (a Mac put to sleep).
    func deafen(_ address: LinkAddress) {
        lock.withLock { connected[address]?.deaf = true }
    }

    fileprivate func route(_ message: RelayMessage, from sender: Connection) {
        // A replaced connection's frames, still coming as it closes, go nowhere.
        if tellsGone, lock.withLock({ connected[sender.address] !== sender }) { return }
        if case .register(let registration) = message {
            lock.withLock {
                registered.append(registration)
                phones[sender.address] = registration
            }
        }
        if case .push(let to, let payload) = message {
            // As the relay answers: sent, or why not.
            let status: RelayMessage.PushStatus = lock.withLock {
                guard let registration = phones[to] else { return .noPhone }
                guard registration.senders.contains(sender.address.text) else { return .notAllowed }
                pushed.append((to, sender.address, payload))
                return .sent
            }
            sender.inbox.yield(.pushed(to: to, status: status))
        }
        guard case .send(let to, let payload) = message else { return }
        let target: Connection? = lock.withLock {
            guard let target = connected[to] else { return nil }
            if tellsGone, target !== sender {
                target.heardFrom[ObjectIdentifier(sender)] = sender
                sender.sentTo[ObjectIdentifier(target)] = target
            }
            return target
        }
        if let target {
            if !lock.withLock({ target.deaf }) { target.inbox.yield(.deliver(from: sender.address, payload: payload)) }
        } else {
            sender.inbox.yield(.unreachable(to))
        }
    }

    fileprivate func drop(_ connection: Connection) {
        lock.withLock {
            guard connected[connection.address] === connection else { return }
            connected[connection.address] = nil
            leave(connection, .left)
        }
    }

    /// A connection that's no longer the one at its address: whoever sent to it hears, once.
    /// Called with the lock held.
    private func leave(_ connection: Connection, _ gone: RelayMessage.Gone) {
        guard tellsGone else { return }
        for listener in connection.heardFrom.values {
            listener.sentTo[ObjectIdentifier(connection)] = nil
            listener.inbox.yield(.gone(connection.address, gone))
        }
        for target in connection.sentTo.values { target.heardFrom[ObjectIdentifier(connection)] = nil }
        connection.heardFrom = [:]
        connection.sentTo = [:]
    }
}

/// Time that passes only when a test moves it on.
final class ManualClock: @unchecked Sendable {
    private let lock = NSLock()
    private let start = ContinuousClock.now
    private var elapsed: Duration = .zero
    private var sleepers: [(until: Duration, wake: CheckedContinuation<Void, Never>)] = []
    private var advancing: (until: Duration, count: Int, go: CheckedContinuation<Void, Never>)?

    var link: LinkClock {
        LinkClock(now: { self.now }, sleep: { await self.sleep($0) })
    }

    var now: ContinuousClock.Instant { lock.withLock { start + elapsed } }

    private func sleep(_ duration: Duration) async {
        await withCheckedContinuation { continuation in
            let go = lock.withLock {
                sleepers.append((elapsed + duration, continuation))
                return readyToAdvance()
            }
            go?.resume()
        }
    }

    /// Waits until `count` sleepers wait to wake within `duration` from now: what the test expects
    /// to be waiting has got that far.
    func sleepers(_ count: Int, dueWithin duration: Duration) async {
        await withCheckedContinuation { continuation in
            let go = lock.withLock {
                advancing = (elapsed + duration, count, continuation)
                return readyToAdvance()
            }
            go?.resume()
        }
    }

    /// Moves time on by `duration`, once `count` sleepers wait to wake by then (the ones the test
    /// expects), and wakes everything due.
    func advance(by duration: Duration, waking count: Int = 1) async {
        await sleepers(count, dueWithin: duration)
        let due = lock.withLock {
            elapsed += duration
            let due = sleepers.filter { $0.until <= elapsed }
            sleepers.removeAll { $0.until <= elapsed }
            return due
        }
        for sleeper in due { sleeper.wake.resume() }
    }

    /// Called with the lock held.
    private func readyToAdvance() -> CheckedContinuation<Void, Never>? {
        guard let waiting = advancing, sleepers.count(where: { $0.until <= waiting.until }) >= waiting.count else { return nil }
        advancing = nil
        return waiting.go
    }
}

/// A phone's relay connection whose frames wait to go out while it's held (a big body on a slow
/// connection), in order.
private final class GatedConnection: RelayTransport, @unchecked Sendable {
    let base: MemoryRelay.Connection
    private let lock = NSLock()
    private var held = false
    /// Held frames are going out: what's sent meanwhile goes behind them.
    private var draining = false
    private var queue: [RelayMessage] = []
    private var waiting: [CheckedContinuation<Void, Never>] = []
    /// Each link frame the phone sent (held or not), by kind and where to.
    private var sent: [(kind: LinkFrame.Kind, to: LinkAddress)] = []

    init(_ base: MemoryRelay.Connection) { self.base = base }

    /// How many frames of `kind` the phone has sent to `address`.
    func sent(_ kind: LinkFrame.Kind, to address: LinkAddress) -> Int {
        lock.withLock { sent.count { $0.kind == kind && $0.to == address } }
    }

    var address: LinkAddress { base.address }
    var messages: AsyncStream<RelayMessage> { base.messages }
    var isSending: Bool { lock.withLock { !queue.isEmpty || draining } }

    func hold() { lock.withLock { held = true } }

    /// Lets everything held go, in order, and what comes after straight through.
    func release() {
        guard lock.withLock({ () -> Bool in
            held = false
            defer { draining = true }
            return !draining
        }) else { return }
        while true {
            let (next, waiters): (RelayMessage?, [CheckedContinuation<Void, Never>]) = lock.withLock {
                if !queue.isEmpty { return (queue.removeFirst(), []) }
                draining = false
                defer { waiting = [] }
                return (nil, waiting)
            }
            guard let next else { return waiters.forEach { $0.resume() } }
            base.send(next)
        }
    }

    func send(_ message: RelayMessage) {
        let now = lock.withLock {
            if case .send(let to, let payload) = message, let frame = try? LinkFrame(payload) { sent.append((frame.kind, to)) }
            if held || draining || !queue.isEmpty { queue.append(message); return false }
            return true
        }
        if now { base.send(message) }
    }

    func allSent() async {
        await withCheckedContinuation { continuation in
            let now = lock.withLock {
                if queue.isEmpty, !draining { return true }
                waiting.append(continuation)
                return false
            }
            if now { continuation.resume() }
        }
    }

    func close() {
        release()
        base.close()
    }
}

/// A value shared between a test and what it sets up.
private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

/// Something a test lets happen when it's ready.
private final class Gate: @unchecked Sendable {
    private let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
    func open() { continuation.finish() }
    func wait() async { for await _ in stream {} }
}

/// A host on a memory relay, answering with `handle`, letting in phones that show `token` once.
private struct TestHost {
    let key = LinkKey()
    let secret = RelaySecret()
    let token = randomBytes(16)
    let paired = Paired()
    let server: LinkServer
    let link: PairingLink
    /// Its relay connection.
    let connection: MemoryRelay.Connection

    init(relay: MemoryRelay, handle: @escaping LinkServer.Handle, connect: LinkServer.Connect? = nil) {
        server = Self.server(key: key, token: token, paired: paired, handle: handle, connect: connect)
        link = PairingLink(relay: URL(string: "wss://relay.test")!, host: secret.address, key: key.publicBytes, token: token, name: "Test Mac")
        let connection = relay.connect(secret)
        self.connection = connection
        Task { [server] in await server.serve(connection) }
    }

    /// The host started again, as a Mac that quit and opened: the same key and address, the same
    /// phones paired, none of its sessions.
    @discardableResult
    func startedAgain(on relay: MemoryRelay, handle: @escaping LinkServer.Handle) -> LinkServer {
        let server = Self.server(key: key, token: token, paired: paired, handle: handle, connect: nil)
        let connection = relay.connect(secret)
        Task { await server.serve(connection) }
        return server
    }

    private static func server(key: LinkKey, token: Data, paired: Paired, handle: @escaping LinkServer.Handle, connect: LinkServer.Connect?) -> LinkServer {
        LinkServer(key: key, hello: HostHello(kind: .mac, name: "Test Mac", app: "0.0.1", engine: "2.0.30"), authorize: { key, _, hello in
            if paired.contains(key) { return true }
            guard hello.pair == token.base64URL else { return false }
            paired.insert(key)
            return true
        }, handle: handle, connect: connect)
    }

    final class Paired: @unchecked Sendable {
        private let lock = NSLock()
        private var keys: Set<Data> = []
        func contains(_ key: Data) -> Bool { lock.withLock { keys.contains(key) } }
        func insert(_ key: Data) { _ = lock.withLock { keys.insert(key) } }
        func remove(_ key: Data) { _ = lock.withLock { keys.remove(key) } }
    }
}

/// How many times something happened, from any thread.
private final class Count: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func add() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

/// Phones' addresses on the relay, by static key, as a host learns them.
private final class Addresses: @unchecked Sendable {
    private let lock = NSLock()
    private var known: [Data: LinkAddress] = [:]
    func insert(_ key: Data, _ address: LinkAddress) { lock.withLock { known[key] = address } }
    func of(_ key: Data) -> LinkAddress? { lock.withLock { known[key] } }
}

private func phone(on relay: MemoryRelay) -> LinkClient {
    LinkClient(relay: URL(string: "wss://relay.test")!, key: LinkKey(), secret: RelaySecret(), name: "Test iPhone", app: "0.0.1", connect: relay.connect)
}

/// A phone whose time moves only when the test moves it: no check can fire behind its back.
private func phone(on relay: MemoryRelay, clock: ManualClock) async -> LinkClient {
    let client = phone(on: relay)
    await client.setClockForTesting(clock.link)
    return client
}

/// A host answering `api/event` with an event stream that sends `first` and then whatever the
/// test feeds it, until it's stopped (`stopped` hears when); anything else, echoed.
private final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var feeds: [AsyncStream<String>.Continuation] = []
    let stopped = AsyncStream.makeStream(of: Void.self)

    var handle: LinkServer.Handle {
        { request, phone in
            guard request.path == "api/event" else { return echo(request, phone) }
            let (more, feed) = AsyncStream.makeStream(of: String.self)
            self.lock.withLock { self.feeds.append(feed) }
            return AsyncThrowingStream { continuation in
                let task = Task {
                    continuation.yield(.head(status: 200, headers: ["content-type": "text/event-stream"]))
                    continuation.yield(.body(Data("data: first\n\n".utf8)))
                    for await event in more { continuation.yield(.body(Data("data: \(event)\n\n".utf8))) }
                }
                continuation.onTermination = { _ in
                    task.cancel()
                    feed.finish()
                    self.stopped.continuation.yield()
                }
            }
        }
    }

    /// One more event on every stream open.
    func send(_ event: String) {
        for feed in lock.withLock({ feeds }) { feed.yield(event) }
    }

    /// Waits for a stream to stop on the host.
    func waitForStop() async {
        var iterator = stopped.stream.makeAsyncIterator()
        _ = await iterator.next()
    }
}

/// An event stream's iterator, past its head and first event.
private func listen(_ client: LinkClient, to host: PairedHost) async throws -> LinkResponse.Iterator {
    var parts = client.send(LinkRequest(path: "api/event"), to: host).makeAsyncIterator()
    _ = try await parts.next()
    _ = try await parts.next()
    return parts
}

/// Answers with the request's method, path, headers and body, echoed.
private let echo: LinkServer.Handle = { request, _ in
    AsyncThrowingStream { continuation in
        continuation.yield(.head(status: 200, headers: ["content-type": "application/octet-stream", "x-path": request.path, "x-method": request.method, "x-dir": request.headers["x-opencode-directory"] ?? ""]))
        if !request.body.isEmpty { continuation.yield(.body(request.body)) }
        continuation.finish()
    }
}

private func collect(_ stream: LinkResponse) async throws -> (status: Int, headers: [String: String], body: Data) {
    var status = 0, headers: [String: String] = [:], body = Data()
    for try await part in stream {
        switch part {
        case .head(let s, let h): (status, headers) = (s, h)
        case .body(let data): body += data
        }
    }
    return (status, headers, body)
}

@Suite struct LinkTests {
    @Test func pairsThenAnswers() async throws {
        let relay = MemoryRelay()
        let host = TestHost(relay: relay, handle: echo)
        let client = phone(on: relay)
        let paired = try await client.pair(host.link)
        #expect(paired.name == "Test Mac")
        #expect(paired.kind == .mac)

        let response = try await collect(client.send(LinkRequest(path: "api/session?limit=5", headers: ["x-opencode-directory": "/tmp/p"]), to: paired))
        #expect(response.status == 200)
        #expect(response.headers["x-path"] == "api/session?limit=5")
        #expect(response.headers["x-dir"] == "/tmp/p")

        // A second request on the same session.
        let posted = try await collect(client.send(LinkRequest(method: "POST", path: "api/x", body: Data("hello".utf8)), to: paired))
        #expect(posted.headers["x-method"] == "POST")
        #expect(posted.body == Data("hello".utf8))
    }

    @Test func aPhoneThatIsNotPairedIsTurnedAway() async throws {
        let relay = MemoryRelay()
        let host = TestHost(relay: relay, handle: echo)
        let stranger = phone(on: relay)
        var link = host.link
        link.token = randomBytes(16)
        await #expect(throws: LinkError.refused) { try await stranger.pair(link) }

        let paired = PairedHost(address: host.secret.address, key: host.key.publicBytes, name: "", kind: .mac)
        await #expect(throws: LinkError.refused) { try await collect(stranger.send(LinkRequest(path: "api/session"), to: paired)) }
    }

    @Test func aPairedPhoneComesBackWithoutTheToken() async throws {
        let relay = MemoryRelay()
        let host = TestHost(relay: relay, handle: echo)
        let key = LinkKey(), secret = RelaySecret()
        let first = LinkClient(relay: host.link.relay, key: key, secret: secret, name: "p", app: "0", connect: relay.connect)
        let paired = try await first.pair(host.link)
        await first.disconnect()

        let later = LinkClient(relay: host.link.relay, key: key, secret: secret, name: "p", app: "0", connect: relay.connect)
        #expect(try await collect(later.send(LinkRequest(path: "api/info"), to: paired)).status == 200)
    }

    /// The Mac quits and opens again while the phone only listens: the relay says the host was
    /// replaced, so the stream ends there and then (no check, no timer), and what the phone sends
    /// next goes on a new session and runs once.
    @Test(.timeLimit(.minutes(1))) func aHostStartedAgainEndsAListeningStreamAtOnce() async throws {
        let relay = MemoryRelay()
        let runs = Count()
        let events = Events()
        let counting: LinkServer.Handle = { request, phone in
            if request.method == "POST" { runs.add() }
            return events.handle(request, phone)
        }
        let host = TestHost(relay: relay, handle: counting)
        let client = await phone(on: relay, clock: ManualClock())
        let paired = try await client.pair(host.link)
        var stream = try await listen(client, to: paired)

        host.startedAgain(on: relay, handle: counting)
        await #expect(throws: LinkError.closed) { _ = try await stream.next() }
        let posted = try await collect(client.send(LinkRequest(method: "POST", path: "api/x", body: Data("once".utf8)), to: paired))
        #expect(posted.status == 200)
        #expect(posted.body == Data("once".utf8))
        #expect(runs.value == 1)
    }

    /// The Mac's relay connection closes (it quit, or its network went): a listening stream ends
    /// as offline at once, and asking again says it's offline.
    @Test(.timeLimit(.minutes(1))) func aHostThatLeftEndsAListeningStreamAsOffline() async throws {
        let relay = MemoryRelay()
        let events = Events()
        let host = TestHost(relay: relay, handle: events.handle)
        let client = await phone(on: relay, clock: ManualClock())
        let paired = try await client.pair(host.link)
        var stream = try await listen(client, to: paired)

        host.connection.close()
        await #expect(throws: LinkError.hostOffline) { _ = try await stream.next() }
        await #expect(throws: LinkError.hostOffline) { try await collect(client.send(LinkRequest(path: "api/info"), to: paired)) }
    }

    /// The host starts again while the phone's handshake is on its way to the old one, which never
    /// answers: the handshake starts over with the new host rather than waiting out its time.
    @Test(.timeLimit(.minutes(1))) func aHandshakeUnderWayWhenTheHostStartsAgainStillOpens() async throws {
        let relay = MemoryRelay()
        let hostKey = LinkKey(), hostSecret = RelaySecret()
        let hello = HostHello(kind: .mac, name: "Test Mac", app: "0.0.1", engine: "2.0.30")
        let (asked, asking) = AsyncStream<Void>.makeStream()
        let oldAnswers = Gate()
        defer { oldAnswers.open() }
        let old = LinkServer(key: hostKey, hello: hello, authorize: { _, _, _ in
            asking.yield()
            await oldAnswers.wait()
            return true
        }, handle: echo)
        let first = relay.connect(hostSecret)
        Task { await old.serve(first) }
        // Another computer the phone listens to, whose leaving shows when the phone has taken in
        // what the relay said before it.
        let events = Events()
        let other = TestHost(relay: relay, handle: events.handle)
        let gate = Locked<GatedConnection?>(nil)
        let client = LinkClient(relay: URL(string: "wss://relay.test")!, key: LinkKey(), secret: RelaySecret(), name: "Test iPhone", app: "0.0.1") { _, secret in
            let connection = GatedConnection(relay.connect(secret))
            gate.value = connection
            return connection
        }
        await client.setClockForTesting(ManualClock().link)
        var stream = try await listen(client, to: try await client.pair(other.link))
        let host = PairedHost(address: hostSecret.address, key: hostKey.publicBytes, name: "", kind: .mac)
        let sending = Task { try await collect(client.send(LinkRequest(path: "api/info"), to: host)) }
        defer { sending.cancel() }
        for await _ in asked { break }

        let new = LinkServer(key: hostKey, hello: hello, authorize: { _, _, _ in true }, handle: echo)
        let second = relay.connect(hostSecret)
        Task { await new.serve(second) }
        other.connection.close()
        await #expect(throws: LinkError.hostOffline) { _ = try await stream.next() }
        // By then the phone has heard the host was replaced, and sent its handshake again.
        try #require(gate.value?.sent(.handshake1, to: hostSecret.address) == 2)
        #expect(try await sending.value.status == 200)
    }

    /// The phone was asleep (its own relay connection gone) while the Mac started again: it heard
    /// nothing from the relay, but its stream ended with its connection, and it carries on, on a
    /// new session, once it's back.
    @Test(.timeLimit(.minutes(1))) func aPhoneAsleepWhileTheHostStartedAgainCarriesOn() async throws {
        let relay = MemoryRelay()
        let runs = Count()
        let events = Events()
        let counting: LinkServer.Handle = { request, phone in
            if request.method == "POST" { runs.add() }
            return events.handle(request, phone)
        }
        let host = TestHost(relay: relay, handle: counting)
        let client = await phone(on: relay, clock: ManualClock())
        let paired = try await client.pair(host.link)
        var stream = try await listen(client, to: paired)

        await client.dropRelayForTesting()
        await #expect(throws: LinkError.closed) { _ = try await stream.next() }
        host.startedAgain(on: relay, handle: counting)
        let posted = try await collect(client.send(LinkRequest(method: "POST", path: "api/x", body: Data("once".utf8)), to: paired))
        #expect(posted.status == 200 && posted.body == Data("once".utf8))
        #expect(runs.value == 1)
    }

    /// A relay from before `gone`: a stream that only listens isn't told the Mac started again.
    /// The host still turns away the old session when the phone next sends on it, so that request
    /// fails (and the stream with it), and the next one runs on a new session.
    @Test(.timeLimit(.minutes(1))) func onAnOldRelayAHostStartedAgainIsFoundOutWhenThePhoneSends() async throws {
        let relay = MemoryRelay(tellsGone: false)
        let runs = Count()
        let events = Events()
        let counting: LinkServer.Handle = { request, phone in
            if request.method == "POST" { runs.add() }
            return events.handle(request, phone)
        }
        let host = TestHost(relay: relay, handle: counting)
        let client = await phone(on: relay, clock: ManualClock())
        let paired = try await client.pair(host.link)
        var stream = try await listen(client, to: paired)

        host.startedAgain(on: relay, handle: counting)
        await #expect(throws: LinkError.closed) { try await collect(client.send(LinkRequest(method: "POST", path: "api/x"), to: paired)) }
        await #expect(throws: LinkError.closed) { _ = try await stream.next() }
        #expect(runs.value == 0)
        let posted = try await collect(client.send(LinkRequest(method: "POST", path: "api/x", body: Data("once".utf8)), to: paired))
        #expect(posted.status == 200)
        #expect(runs.value == 1)
    }

    /// Removed from the Mac's paired phones: its session ends there and then (its stream hears
    /// so), and it's turned away from then on, its key no longer one the Mac knows (the pairing
    /// link it used, gone too).
    @Test(.timeLimit(.minutes(1))) func aPhoneRemovedFromTheMacIsTurnedAway() async throws {
        let relay = MemoryRelay()
        let events = Events()
        let host = TestHost(relay: relay, handle: events.handle)
        let key = LinkKey()
        let client = LinkClient(relay: host.link.relay, key: key, secret: RelaySecret(), name: "p", app: "0", connect: relay.connect)
        let paired = try await client.pair(host.link)
        var stream = try await listen(client, to: paired)

        host.paired.remove(key.publicBytes)
        await host.server.forget(phone: key.publicBytes)
        await #expect(throws: LinkError.closed) { _ = try await stream.next() }
        await #expect(throws: LinkError.refused) { try await collect(client.send(LinkRequest(path: "api/info"), to: paired)) }
    }

    /// Removed while the Mac was letting it in (asked whether to, and removed meanwhile, from a
    /// phone say): it gets no session.
    @Test func aPhoneRemovedWhileItsLetInIsTurnedAway() async throws {
        let relay = MemoryRelay()
        let hostKey = LinkKey(), hostSecret = RelaySecret()
        let (asked, asking) = AsyncStream<Void>.makeStream()
        let (answers, answering) = AsyncStream<Bool>.makeStream()
        let server = LinkServer(key: hostKey, hello: HostHello(kind: .mac, name: "Test Mac", app: "0.0.1", engine: "2.0.30"), authorize: { _, _, _ in
            asking.yield()
            for await allowed in answers { return allowed }
            return false
        }, handle: echo)
        let connection = relay.connect(hostSecret)
        Task { await server.serve(connection) }
        let key = LinkKey()
        let client = LinkClient(relay: URL(string: "wss://relay.test")!, key: key, secret: RelaySecret(), name: "p", app: "0", connect: relay.connect)
        let host = PairedHost(address: hostSecret.address, key: hostKey.publicBytes, name: "", kind: .mac)
        let sending = Task { try await collect(client.send(LinkRequest(path: "api/info"), to: host)) }
        for await _ in asked { break }
        await server.forget(phone: key.publicBytes)
        answering.yield(true)
        await #expect(throws: LinkError.refused) { try await sending.value }
    }

    /// The Mac's own connection to the relay drops and comes back (the network changed): the relay
    /// says it was replaced, the phone's stream ends, and the phone carries on, on a new session,
    /// what it sends running once.
    @Test(.timeLimit(.minutes(1))) func aPhoneCarriesOnAfterTheMacsRelayConnectionComesBack() async throws {
        let relay = MemoryRelay()
        let runs = Count()
        let events = Events()
        let counting: LinkServer.Handle = { request, phone in
            if request.method == "POST" { runs.add() }
            return events.handle(request, phone)
        }
        let host = TestHost(relay: relay, handle: counting)
        let client = await phone(on: relay, clock: ManualClock())
        let paired = try await client.pair(host.link)
        var stream = try await listen(client, to: paired)

        // The same host, serving on a new connection: the old one's sessions are over.
        let again = relay.connect(host.secret)
        Task { [server = host.server] in await server.serve(again) }
        await #expect(throws: LinkError.closed) { _ = try await stream.next() }
        let posted = try await collect(client.send(LinkRequest(method: "POST", path: "api/x", body: Data("once".utf8)), to: paired))
        #expect(posted.status == 200 && posted.body == Data("once".utf8))
        #expect(runs.value == 1)
    }

    /// A host mails another (the Mac, its phone list to a machine's bridge) through the relay,
    /// sealed for that one's key alone, from its own.
    @Test func aHostMailsAnotherSealedForItAlone() async throws {
        let relay = MemoryRelay()
        let host = TestHost(relay: relay, handle: echo)
        let machineKey = LinkKey(), machineSecret = RelaySecret()
        let machine = relay.connect(machineSecret)
        let payload = Data(#"{"phones":[],"at":1}"#.utf8)
        var sent = false
        for _ in 0..<100 where !sent {
            sent = await host.server.mail(payload, to: machineKey.publicBytes, at: machineSecret.address) == .sent
            if !sent { try await Task.sleep(for: .milliseconds(10)) }
        }
        #expect(sent)
        var iterator = machine.messages.makeAsyncIterator()
        guard case .deliver(_, let frame)? = await iterator.next() else { Issue.record("nothing came"); return }
        #expect(try Mail.open(frame, to: machineKey, from: host.key.publicBytes) == payload)
        #expect(throws: (any Error).self) { try Mail.open(frame, to: LinkKey(), from: host.key.publicBytes) }
    }

    /// Your other computers mail each other (PROTOCOL.md, "Peers"): mail that comes is handed on,
    /// with where it's from; mail too big for the relay (which would close the connection for
    /// it) isn't sent.
    @Test func mailBetweenHostsIsHandedOnAndOneTooBigIsntSent() async throws {
        let relay = MemoryRelay()
        let sender = TestHost(relay: relay, handle: echo)
        let key = LinkKey(), secret = RelaySecret()
        let came = AsyncStream<(Data, LinkAddress)>.makeStream()
        let receiver = LinkServer(key: key, hello: HostHello(kind: .machine, name: "lokum", app: "0.0.1", engine: "2.0.30"),
                                  authorize: { _, _, _ in false }, handle: echo, mailed: { frame, from in came.continuation.yield((frame, from)) })
        let connection = relay.connect(secret)
        Task { await receiver.serve(connection) }
        let payload = Data(#"{"letter":{"id":"ltr_1"},"at":1}"#.utf8)
        var sent = false
        for _ in 0..<100 where !sent {
            sent = await sender.server.mail(payload, to: key.publicBytes, at: secret.address) == .sent
            if !sent { try await Task.sleep(for: .milliseconds(10)) }
        }
        #expect(sent)
        var iterator = came.stream.makeAsyncIterator()
        let (frame, from) = try #require(await iterator.next())
        #expect(from == sender.secret.address)
        #expect(try Mail.open(frame, to: key, from: sender.key.publicBytes) == payload)
        #expect(await sender.server.mail(Data(repeating: 0x61, count: RelayMessage.maxPayload), to: key.publicBytes, at: secret.address) == .tooBig)
    }

    /// The Mac's relay connection gone (asleep, its connection closed) while the phone was quiet:
    /// what it asks next says it's offline, without waiting on any check.
    @Test(.timeLimit(.minutes(1))) func aQuietSessionToAHostThatLeftSaysSoWithoutWaiting() async throws {
        for relay in [MemoryRelay(), MemoryRelay(tellsGone: false)] {
            let host = TestHost(relay: relay, handle: echo)
            let client = await phone(on: relay, clock: ManualClock())
            let paired = try await client.pair(host.link)
            host.connection.close()
            await #expect(throws: LinkError.hostOffline) { try await collect(client.send(LinkRequest(path: "api/info"), to: paired)) }
        }
    }

    /// The host's connection died without closing (a Mac put to sleep): the relay still takes
    /// frames for it until it notices, and nothing answers. The request checks once it's waited,
    /// and fails when the check goes unanswered.
    @Test(.timeLimit(.minutes(1))) func aRequestLostOnTheWayFailsRatherThanWaitingForever() async throws {
        for relay in [MemoryRelay(), MemoryRelay(tellsGone: false)] {
            let clock = ManualClock()
            let host = TestHost(relay: relay, handle: echo)
            let client = await phone(on: relay, clock: clock)
            let paired = try await client.pair(host.link)
            relay.deafen(host.secret.address)
            let sending = Task { try await collect(client.send(LinkRequest(path: "api/info"), to: paired)) }
            // The request waits its time, and a check goes; then the check waits its own.
            await clock.advance(by: Link.answerWithin)
            await clock.advance(by: Link.checkTimeout, waking: 2)
            await #expect(throws: LinkError.timedOut) { try await sending.value }
        }
    }

    /// A big body still on its way out: the host can't answer what hasn't reached it, so the
    /// request isn't checked on, however long it takes.
    @Test(.timeLimit(.minutes(1))) func aBigBodyOnASlowConnectionIsntCutOff() async throws {
        let relay = MemoryRelay()
        let clock = ManualClock()
        let host = TestHost(relay: relay, handle: echo)
        let gate = Locked<GatedConnection?>(nil)
        let client = LinkClient(relay: URL(string: "wss://relay.test")!, key: LinkKey(), secret: RelaySecret(), name: "Test iPhone", app: "0.0.1") { _, secret in
            let connection = GatedConnection(relay.connect(secret))
            gate.value = connection
            return connection
        }
        await client.setClockForTesting(clock.link)
        let paired = try await client.pair(host.link)
        gate.value?.hold()
        let big = randomBytes(1_300_000)
        let uploading = Task { try await collect(client.send(LinkRequest(method: "POST", path: "api/upload", body: big), to: paired)) }
        for _ in 0..<3 { await clock.advance(by: Link.answerWithin) }
        // The last wait's check has run (it waits again), and no ping went: only the request's pieces.
        await clock.sleepers(1, dueWithin: Link.answerWithin)
        let pieces = LinkMessage.pieces(.init(t: .req, id: 1, m: "POST", p: "api/upload", h: [:]), body: big, end: true).count
        #expect(gate.value?.sent(.transport, to: host.secret.address) == pieces)
        gate.value?.release()
        #expect(try await uploading.value.body == big)
    }

    /// A check's ping held up behind the phone's own frames going out: its time counts from when it
    /// leaves, so a host that's there and answers it then keeps the session.
    @Test(.timeLimit(.minutes(1))) func aCheckHeldUpGoingOutCountsFromWhenItLeaves() async throws {
        let relay = MemoryRelay()
        let clock = ManualClock()
        let answer = Gate()
        let slow: LinkServer.Handle = { _, _ in
            AsyncThrowingStream { continuation in
                Task {
                    await answer.wait()
                    continuation.yield(.head(status: 200, headers: [:]))
                    continuation.finish()
                }
            }
        }
        let host = TestHost(relay: relay, handle: slow)
        let gate = Locked<GatedConnection?>(nil)
        let client = LinkClient(relay: URL(string: "wss://relay.test")!, key: LinkKey(), secret: RelaySecret(), name: "Test iPhone", app: "0.0.1") { _, secret in
            let connection = GatedConnection(relay.connect(secret))
            gate.value = connection
            return connection
        }
        await client.setClockForTesting(clock.link)
        let paired = try await client.pair(host.link)
        let heard = await client.heardForTesting()
        let asking = Task { try await collect(client.send(LinkRequest(method: "POST", path: "api/slow"), to: paired)) }
        // The request's gone; what goes next waits to leave.
        await clock.sleepers(1, dueWithin: Link.answerWithin)
        gate.value?.hold()
        // The request has waited: a check's ping is queued, and waits too, well past a check's time.
        await clock.advance(by: Link.answerWithin)
        await clock.advance(by: Link.answerWithin)
        await clock.advance(by: Link.answerWithin)
        gate.value?.release()
        for await _ in heard { break }
        answer.open()
        #expect(try await asking.value.status == 200)
    }

    @Test(.timeLimit(.minutes(1))) func aSlowAnswerFromAHostThatIsThereIsWaitedFor() async throws {
        let relay = MemoryRelay()
        let clock = ManualClock()
        let answer = Gate()
        let slow: LinkServer.Handle = { _, _ in
            AsyncThrowingStream { continuation in
                Task {
                    await answer.wait()
                    continuation.yield(.head(status: 200, headers: [:]))
                    continuation.finish()
                }
            }
        }
        let host = TestHost(relay: relay, handle: slow)
        let client = await phone(on: relay, clock: clock)
        let paired = try await client.pair(host.link)
        let heard = await client.heardForTesting()
        let asking = Task { try await collect(client.send(LinkRequest(path: "api/slow"), to: paired)) }
        // It's waited: a check goes, and the host answers it.
        await clock.advance(by: Link.answerWithin)
        for await _ in heard { break }
        // Well past the check's time, the request waits on for its answer.
        await clock.advance(by: Link.checkTimeout, waking: 2)
        answer.open()
        #expect(try await asking.value.status == 200)
    }

    @Test func bodiesLongerThanOneMessageArriveWhole() async throws {
        let relay = MemoryRelay()
        let host = TestHost(relay: relay, handle: echo)
        let client = phone(on: relay)
        let paired = try await client.pair(host.link)
        let big = randomBytes(300_000)
        let response = try await collect(client.send(LinkRequest(method: "POST", path: "api/upload", body: big), to: paired))
        #expect(response.body == big)
    }

    @Test(.timeLimit(.minutes(1))) func aHostThatStopsTellsItsPhones() async throws {
        for relay in [MemoryRelay(), MemoryRelay(tellsGone: false)] {
            let events = Events()
            let host = TestHost(relay: relay, handle: events.handle)
            let client = await phone(on: relay, clock: ManualClock())
            let paired = try await client.pair(host.link)
            var stream = try await listen(client, to: paired)
            // The host stops (its engine starting over), its relay connection staying up: the phone
            // hears at once, with no check and no word from the relay.
            await host.server.closeAll()
            await #expect(throws: LinkError.closed) { _ = try await stream.next() }
            // What it asks next goes on a new session.
            #expect(try await collect(client.send(LinkRequest(path: "api/info"), to: paired)).status == 200)
        }
    }

    /// The rule phones count on now that they don't check before each request (PROTOCOL.md, "The
    /// relay"): while its relay connection stays up, a host keeps a phone's session through
    /// whatever else happens (other phones pairing, asking, removed, gone; mail; pushes), and ends
    /// it only with the phone told. On a relay from before `gone`, so nothing else would tell it.
    @Test(.timeLimit(.minutes(1))) func aHostKeepsAPhonesSessionWhileItsRelayConnectionStaysUp() async throws {
        let relay = MemoryRelay(tellsGone: false)
        let events = Events()
        let handshakes = Count()
        let key = LinkKey(), secret = RelaySecret(), token = randomBytes(16)
        let server = LinkServer(key: key, hello: HostHello(kind: .mac, name: "Test Mac", app: "0.0.1", engine: "2.0.30"), authorize: { _, _, hello in
            handshakes.add()
            return hello.pair == token.base64URL || hello.pair == nil
        }, handle: events.handle)
        let connection = relay.connect(secret)
        Task { await server.serve(connection) }
        let link = PairingLink(relay: URL(string: "wss://relay.test")!, host: secret.address, key: key.publicBytes, token: token, name: "Test Mac")
        let clock = ManualClock()
        let client = await phone(on: relay, clock: clock)
        let paired = try await client.pair(link)
        var stream = try await listen(client, to: paired)

        // Another phone comes, asks, is removed, and goes without a word.
        let otherKey = LinkKey()
        let other = LinkClient(relay: link.relay, key: otherKey, secret: RelaySecret(), name: "Other", app: "0", connect: relay.connect)
        let otherHost = try await other.pair(link)
        #expect(try await collect(other.send(LinkRequest(path: "api/info"), to: otherHost)).status == 200)
        await server.forget(phone: otherKey.publicBytes)
        await other.dropRelayForTesting()
        // Mail and pushes go out.
        #expect(await server.mail(Data("{}".utf8), to: LinkKey().publicBytes, at: RelaySecret().address) == .sent)
        #expect(await server.push(Data("{}".utf8), to: [(key: LinkKey().publicBytes, address: RelaySecret().address)]))
        // A long while passes.
        await clock.advance(by: .seconds(3600), waking: 0)

        // The first phone's session is the one it had: its stream goes on, and it asks on it.
        let before = handshakes.value
        events.send("still here")
        guard case .body(let event)? = try await stream.next() else { Issue.record("no event"); return }
        #expect(String(decoding: event, as: UTF8.self) == "data: still here\n\n")
        #expect(try await collect(client.send(LinkRequest(path: "api/info"), to: paired)).status == 200)
        #expect(handshakes.value == before)

        // Ending it, the host says so.
        await server.closeAll()
        await #expect(throws: LinkError.closed) { _ = try await stream.next() }
    }

    @Test func aStreamStopsOnTheHostWhenThePhoneStopsReading() async throws {
        let relay = MemoryRelay()
        let stopped = AsyncStream.makeStream(of: Void.self)
        let host = TestHost(relay: relay) { request, phone in
            guard request.path == "api/event" else { return echo(request, phone) }
            return AsyncThrowingStream { continuation in
                let task = Task {
                    continuation.yield(.head(status: 200, headers: ["content-type": "text/event-stream"]))
                    var n = 0
                    while !Task.isCancelled {
                        continuation.yield(.body(Data("data: \(n)\n\n".utf8)))
                        n += 1
                        try? await Task.sleep(for: .milliseconds(5))
                    }
                    stopped.continuation.yield()
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        }
        let client = phone(on: relay)
        let paired = try await client.pair(host.link)
        var events = 0
        for try await part in client.send(LinkRequest(path: "api/event"), to: paired) {
            if case .body = part { events += 1 }
            if events == 3 { break }
        }
        #expect(events == 3)
        var iterator = stopped.stream.makeAsyncIterator()
        _ = await iterator.next()

        // The session is still good for the next request.
        #expect(try await collect(client.send(LinkRequest(path: "api/info"), to: paired)).status == 200)
    }

    /// The phone goes away mid-stream without a word, as one put to sleep does: the relay tells
    /// the host, which stops the stream though it has nothing more to send on it.
    @Test(.timeLimit(.minutes(1))) func aStreamStopsOnTheHostWhenThePhoneIsGone() async throws {
        let relay = MemoryRelay()
        let events = Events()
        let host = TestHost(relay: relay, handle: events.handle)
        let client = phone(on: relay)
        let paired = try await client.pair(host.link)
        _ = try await listen(client, to: paired)
        await client.dropRelayForTesting()
        await events.waitForStop()
    }

    @Test func aPushRegistrationGoesAgainEachTimeThePhoneConnects() async throws {
        let relay = MemoryRelay()
        let host = TestHost(relay: relay, handle: echo)
        let client = phone(on: relay)
        let registration = PushRegistration(token: "a1b2", environment: "sandbox", topic: "run.kuvo.code.mobile", senders: [host.secret.address])
        // Sent at once, connecting for it.
        await client.register(registration)
        #expect(relay.registrations == [registration])
        // Woken up after the relay went: sent again with the new connection.
        let paired = try await client.pair(host.link)
        await client.dropRelayForTesting()
        try await Task.sleep(for: .milliseconds(50))
        _ = try await client.hostHello(paired)
        #expect(relay.registrations == [registration, registration])
        // Stopped: the next connection goes without it.
        await client.register(nil)
        await client.dropRelayForTesting()
        try await Task.sleep(for: .milliseconds(50))
        _ = try await client.hostHello(paired)
        #expect(relay.registrations.count == 2)
    }

    @Test func aHostPushesToThePhonesItKnows() async throws {
        let relay = MemoryRelay()
        let statuses = AsyncStream.makeStream(of: RelayMessage.PushStatus.self)
        let addresses = Addresses()
        let key = LinkKey(), secret = RelaySecret(), token = randomBytes(16)
        let server = LinkServer(key: key, hello: HostHello(kind: .mac, name: "Test Mac", app: "0.0.1", engine: "2.0.30"), authorize: { phone, address, _ in
            addresses.insert(phone, address)
            return true
        }, handle: echo, pushed: { _, status in statuses.continuation.yield(status) })
        let connection = relay.connect(secret)
        Task { await server.serve(connection) }
        let phoneKey = LinkKey(), phoneSecret = RelaySecret()
        let client = LinkClient(relay: URL(string: "wss://relay.test")!, key: phoneKey, secret: phoneSecret, name: "Test iPhone", app: "0.0.1", connect: relay.connect)
        _ = try await client.pair(PairingLink(relay: URL(string: "wss://relay.test")!, host: secret.address, key: key.publicBytes, token: token, name: "Test Mac"))
        // Learned when the phone came in: where its pushes go.
        let address = try #require(addresses.of(phoneKey.publicBytes))
        #expect(address == phoneSecret.address)
        #expect(await server.hasSessions)
        let notice = Notice(title: "Fixer", body: "Done: the tests pass.", category: .report, thread: "ses_1", data: ["session": "ses_1"])
        var heard = statuses.stream.makeAsyncIterator()

        // Not registered yet: the relay says so.
        #expect(await server.push(try notice.encoded(), to: [(phoneKey.publicBytes, address)]))
        #expect(await heard.next() == .noPhone)

        await client.register(PushRegistration(token: "a1b2", environment: "sandbox", topic: "run.kuvo.code.mobile", senders: [secret.address]))
        try await Task.sleep(for: .milliseconds(20))
        await server.push(try notice.encoded(), to: [(phoneKey.publicBytes, address)])
        #expect(await heard.next() == .sent)
        // Only the phone opens it, as from this host.
        let push = try #require(relay.pushes.first)
        #expect(push.from == secret.address)
        let opened = try Mail.open(push.payload, to: phoneKey, from: key.publicBytes)
        #expect(try JSONDecoder().decode(Notice.self, from: opened) == notice)
        #expect(throws: (any Error).self) { try Mail.open(push.payload, to: LinkKey(), from: key.publicBytes) }
    }

    @Test func aCallbackCalledAgainIsLetGo() async {
        // As URLSession's pong handler can be: an answer, then an error as the task closes, the
        // second from another queue, a moment later.
        let answered = await firstAnswer { (answer: @escaping @Sendable (Bool) -> Void) in
            answer(true)
            answer(false)
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(20)) { answer(false) }
        }
        #expect(answered)
        let later = await firstAnswer { (answer: @escaping @Sendable (Int) -> Void) in
            DispatchQueue.global().async { answer(1) }
            DispatchQueue.global().async { answer(2) }
        }
        #expect(later == 1 || later == 2)
        try? await Task.sleep(for: .milliseconds(50))
    }

    @Test func aLongNoticeIsCutToFit() throws {
        let body = String(repeating: "Wörds and more words. ", count: 400)
        let notice = Notice(title: "Fixer", subtitle: "kuvo-ai", body: body, category: .finished, thread: "ses_1", data: ["session": "ses_1"])
        let data = try notice.encoded()
        #expect(data.count <= Notice.limit)
        let cut = try JSONDecoder().decode(Notice.self, from: data)
        #expect(cut.body.hasSuffix("…"))
        #expect(body.hasPrefix(String(cut.body.dropLast())))
        #expect(cut.body.count > 2000)
        // Short ones go as they are.
        let short = Notice(title: "Fixer", body: "Done.", category: .finished, thread: "ses_1", data: [:])
        #expect(try JSONDecoder().decode(Notice.self, from: short.encoded()) == short)
        // A category from a newer host still decodes, to be shown plainly.
        let newer = try JSONDecoder().decode(Notice.self, from: Data(#"{"t":"notify","title":"Fixer","body":"Hi","category":"reminder","thread":"ses_1","data":{}}"#.utf8))
        #expect(newer.category.rawValue == "reminder")
        #expect(String(decoding: try short.encoded(), as: UTF8.self).contains(#""category":"finished""#))
    }

    @Test func socketsCarryMessagesBothWaysUntilClosed() async throws {
        let relay = MemoryRelay()
        let closed = AsyncStream.makeStream(of: Void.self)
        let note = Data([0]) + Data(#"{"cursor":0}"#.utf8)
        // A terminal that answers each line it's sent, after a note of where its output starts.
        let host = TestHost(relay: relay, handle: echo) { request, _, input in
            AsyncThrowingStream { continuation in
                guard request.path == "api/pty/pty_1/connect" else { return continuation.finish(throwing: URLError(.badURL)) }
                continuation.yield(.open)
                continuation.yield(.binary(note))
                let task = Task {
                    for await text in input { continuation.yield(.text(Data("echo:".utf8) + text)) }
                    closed.continuation.yield()
                    continuation.finish()
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        }
        let client = phone(on: relay)
        let paired = try await client.pair(host.link)
        let socket = client.socket(.socket("api/pty/pty_1/connect"), to: paired)
        var events = socket.events.makeAsyncIterator()
        #expect(try await events.next() == .open)
        #expect(try await events.next() == .binary(note))
        try await socket.send(Data("ls\r".utf8))
        #expect(try await events.next() == .text(Data("echo:ls\r".utf8)))
        // Closing it ends it on the host.
        socket.close()
        var stops = closed.stream.makeAsyncIterator()
        _ = await stops.next()

        // One the host won't open fails, and the session carries on.
        let refused = client.socket(.socket("api/pty/pty_2/connect"), to: paired)
        await #expect(throws: LinkError.notAvailable) { for try await _ in refused.events {} }
        #expect(try await collect(client.send(LinkRequest(path: "api/info"), to: paired)).status == 200)
    }

    @Test func aHostWithoutSocketsTurnsThemAway() async throws {
        let relay = MemoryRelay()
        let host = TestHost(relay: relay, handle: echo)
        let client = phone(on: relay)
        let paired = try await client.pair(host.link)
        await #expect(throws: LinkError.notAvailable) { for try await _ in client.socket(.socket("api/pty/pty_1/connect"), to: paired).events {} }
    }

    @Test func aHostThatIsNotConnectedIsOffline() async throws {
        let relay = MemoryRelay()
        let client = phone(on: relay)
        let nobody = PairedHost(address: RelaySecret().address, key: LinkKey().publicBytes, name: "", kind: .machine)
        await #expect(throws: LinkError.hostOffline) { try await collect(client.send(LinkRequest(path: "api/info"), to: nobody)) }
    }

    @Test func aFailingHandlerAnswers502() async throws {
        let relay = MemoryRelay()
        struct Broken: Error {}
        let host = TestHost(relay: relay) { _, _ in AsyncThrowingStream { $0.finish(throwing: Broken()) } }
        let client = phone(on: relay)
        let paired = try await client.pair(host.link)
        #expect(try await collect(client.send(LinkRequest(path: "api/info"), to: paired)).status == 502)
    }

    @Test func urlSessionRequestsGoOverTheLink() async throws {
        let relay = MemoryRelay()
        let host = TestHost(relay: relay, handle: echo)
        let client = phone(on: relay)
        let paired = try await client.pair(host.link)
        let session = URLSession(configuration: LinkURLProtocol.configuration(client: client) { [paired] })
        let base = LinkURLProtocol.baseURL(for: paired)

        var request = URLRequest(url: base.appending(path: "api/session/abc/prompt").appending(queryItems: [URLQueryItem(name: "a", value: "b c")]))
        request.httpMethod = "POST"
        request.httpBody = Data(#"{"text":"hi"}"#.utf8)
        request.setValue("/Users/me/project", forHTTPHeaderField: "x-opencode-directory")
        let (data, response) = try await session.data(for: request)
        let http = try #require(response as? HTTPURLResponse)
        #expect(http.statusCode == 200)
        #expect(http.value(forHTTPHeaderField: "x-path") == "api/session/abc/prompt?a=b%20c")
        #expect(http.value(forHTTPHeaderField: "x-dir") == "/Users/me/project")
        #expect(data == Data(#"{"text":"hi"}"#.utf8))

        let (bytes, _) = try await session.bytes(for: URLRequest(url: base.appending(path: "api/event")))
        var lines = 0
        for try await _ in bytes.lines { lines += 1 }
        #expect(lines == 0)
    }

    @Test func mailOpensOnlyForItsPhone() throws {
        let host = LinkKey(), phone = LinkKey(), other = LinkKey()
        let payload = Data(#"{"t":"notify","title":"Needs you"}"#.utf8)
        let frame = try Mail.seal(payload, from: host, to: phone.publicBytes)
        #expect(try Mail.open(frame, to: phone, from: host.publicBytes) == payload)
        #expect(throws: Noise.Failure.decrypt) { try Mail.open(frame, to: other, from: host.publicBytes) }
        #expect(throws: Noise.Failure.decrypt) { try Mail.open(frame, to: phone, from: other.publicBytes) }
    }

    @Test func pairingLinksGoBothWays() throws {
        let link = PairingLink(relay: URL(string: "wss://link.example/v1")!, host: RelaySecret().address, key: LinkKey().publicBytes, name: "Sam’s MacBook & co")
        #expect(PairingLink(link.url) == link)
        #expect(PairingLink(URL(string: "kuvo-link://pair?v=2")!) == nil)
        #expect(PairingLink(URL(string: "https://pair")!) == nil)
    }

    @Test func messagesSplitToFit() throws {
        let body = randomBytes(200_000)
        let pieces = LinkMessage.pieces(.init(t: .res, id: 9, h: ["content-type": "x"], s: 200), body: body, end: true)
        #expect(pieces.count == 4)
        #expect(pieces.allSatisfy { $0.data.count <= LinkMessage.maxLength })
        #expect(pieces.first?.head.t == .res)
        #expect(pieces.dropFirst().allSatisfy { $0.head.t == .data && $0.head.id == 9 })
        #expect(pieces.map(\.head.end) == [false, false, false, true])
        #expect(pieces.reduce(Data()) { $0 + $1.body } == body)
        for piece in pieces { #expect(try LinkMessage(piece.data) == piece) }
    }
}
