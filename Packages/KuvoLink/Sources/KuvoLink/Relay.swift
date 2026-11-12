import Foundation
import os

/// A device's connection to the relay: a WebSocket, or something in memory for tests.
public protocol RelayTransport: AnyObject, Sendable {
    /// The address the relay gave this connection.
    var address: LinkAddress { get }
    /// What the relay sends, ending when the connection does.
    var messages: AsyncStream<RelayMessage> { get }
    /// Queues a message for the relay. They go out in the order queued, which keeps a session's
    /// messages in the order they were encrypted.
    func send(_ message: RelayMessage)
    func close()
    /// Whether messages queued with `send` are still on their way out (a big body on a slow
    /// connection): the other end can't have answered what hasn't reached it.
    var isSending: Bool { get }
    /// Returns once what's queued with `send` so far has gone out (or the connection's closed).
    func allSent() async
}

extension RelayTransport {
    public var isSending: Bool { false }
    public func allSent() async {}
}

/// The relay over a WebSocket.
public final class WebSocketRelay: RelayTransport, @unchecked Sendable {
    public let address: LinkAddress
    public let messages: AsyncStream<RelayMessage>
    private let socket: any RelaySocket
    private let outbox: AsyncStream<RelayMessage>.Continuation
    private let inbox: AsyncStream<RelayMessage>.Continuation
    /// Messages queued that the socket hasn't taken yet, and who waits for there to be none.
    private let queued = OSAllocatedUnfairLock(initialState: Outbox())
    /// How much this connection has handed its socket, in bytes, and how much of it the relay has
    /// had for sure (what went before a ping it answered). What's between may still be on its way:
    /// the system takes a message into its buffers long before a slow connection has sent it.
    private let handed = OSAllocatedUnfairLock(initialState: (sent: 0, arrived: 0))

    private struct Outbox {
        var count = 0
        /// Nothing more goes out: the connection's closed.
        var closed = false
        var waiting: [CheckedContinuation<Void, Never>] = []

        /// The waiters to let go, once nothing's queued.
        mutating func emptied() -> [CheckedContinuation<Void, Never>] {
            guard count == 0 else { return [] }
            defer { waiting = [] }
            return waiting
        }
    }

    /// Connects, says hello and waits for the relay's welcome.
    public static func connect(to url: URL, secret: RelaySecret) async throws -> any RelayTransport {
        let task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = 1 << 20
        task.resume()
        do {
            try await task.send(.data(RelayMessage.hello(secret).data))
            guard case .data(let data) = try await task.receive(),
                  case .welcome(let address) = try RelayMessage(fromRelay: data), address == secret.address
            else { throw LinkError.relayUnavailable }
            return WebSocketRelay(socket: WebSocketTaskSocket(task: task), address: address)
        } catch {
            task.cancel(with: .goingAway, reason: nil)
            throw LinkError.relayUnavailable
        }
    }

    /// On `socket`, connected and welcomed at `address`; `clock` times its pings.
    init(socket: any RelaySocket, address: LinkAddress, clock: LinkClock = .real) {
        self.socket = socket
        self.address = address
        let (messages, inbox) = AsyncStream.makeStream(of: RelayMessage.self)
        let (outgoing, outbox) = AsyncStream.makeStream(of: RelayMessage.self)
        self.messages = messages
        self.inbox = inbox
        self.outbox = outbox

        Task { [socket, queued, handed] in
            for await message in outgoing {
                let data = message.data
                handed.withLock { $0.sent += data.count }
                do {
                    try await socket.send(data)
                } catch {
                    // Nothing more goes out: closed, so it isn't taken for one still sending.
                    socket.cancel()
                    break
                }
                for waiter in queued.withLock({ $0.count -= 1; return $0.emptied() }) { waiter.resume() }
            }
            for waiter in queued.withLock({ $0.count = 0; $0.closed = true; return $0.emptied() }) { waiter.resume() }
        }
        Task { [socket, inbox] in
            while let data = await socket.receive() {
                if let message = try? RelayMessage(fromRelay: data) { inbox.yield(message) }
            }
            inbox.finish()
            outbox.finish()
        }
        // Pings keep the connection open through routers that forget quiet ones, and notice
        // one that's gone.
        Task { [weak self, socket, handed] in
            while self != nil {
                await clock.sleep(Self.pingEvery)
                // The pong's handler can be called again (with an error, as the task closes). A
                // relay that stops answering (frozen, or a path gone dead that sends no reset)
                // never pongs: after 10 s it counts as gone, and everything connects again. The
                // ping goes out behind what's on its way (a picture on LTE, #144), and its pong
                // with it: it has a second more for each `Link.slowUpload` bytes of that.
                let (sent, behind) = handed.withLock { ($0.sent, $0.sent - $0.arrived) }
                let answered = await firstAnswer { answer in
                    socket.sendPing { answer($0 == nil) }
                    Task {
                        await clock.sleep(Self.pongWithin + .seconds(behind / Link.slowUpload))
                        answer(false)
                    }
                }
                if !answered { socket.cancel(); break }
                handed.withLock { $0.arrived = max($0.arrived, sent) }
            }
        }
    }

    /// How often it pings the relay, and how long a pong may take with nothing on its way ahead of it.
    static let pingEvery: Duration = .seconds(25)
    static let pongWithin: Duration = .seconds(10)

    deinit { close() }

    public func send(_ message: RelayMessage) {
        queued.withLock { if !$0.closed { $0.count += 1 } }
        outbox.yield(message)
    }

    public var isSending: Bool { queued.withLock { $0.count > 0 } }

    public func allSent() async {
        await withCheckedContinuation { continuation in
            let now = queued.withLock { outbox in
                guard outbox.count > 0 else { return true }
                outbox.waiting.append(continuation)
                return false
            }
            if now { continuation.resume() }
        }
    }

    public func close() {
        socket.close()
        outbox.finish()
        inbox.finish()
    }
}

/// What `WebSocketRelay` sends on and hears from: URLSession's WebSocket, or a test's.
protocol RelaySocket: Sendable {
    /// Sends one message, once the system has taken it (it may still be on its way).
    func send(_ data: Data) async throws
    /// The next message, or nil once there's none (closed, or one that isn't data).
    func receive() async -> Data?
    /// A ping; `answered` hears its pong, or the error that ended it.
    func sendPing(_ answered: @escaping @Sendable ((any Error)?) -> Void)
    /// Gone (a ping not answered, a send that failed).
    func cancel()
    /// Closed on purpose.
    func close()
}

struct WebSocketTaskSocket: RelaySocket {
    let task: URLSessionWebSocketTask

    func send(_ data: Data) async throws { try await task.send(.data(data)) }

    func receive() async -> Data? {
        guard case .data(let data)? = try? await task.receive() else { return nil }
        return data
    }

    func sendPing(_ answered: @escaping @Sendable ((any Error)?) -> Void) { task.sendPing(pongReceiveHandler: answered) }
    func cancel() { task.cancel(with: .goingAway, reason: nil) }
    func close() { task.cancel(with: .normalClosure, reason: nil) }
}

/// What a callback API answers the first time: `start` is given the callback, which may be called
/// again, from any queue; later calls are let go, where resuming twice would crash.
func firstAnswer<Value: Sendable>(_ start: (@escaping @Sendable (Value) -> Void) -> Void) async -> Value {
    await withCheckedContinuation { continuation in
        let answered = OSAllocatedUnfairLock(initialState: false)
        start { value in
            let isFirst = answered.withLock { done in
                defer { done = true }
                return !done
            }
            if isFirst { continuation.resume(returning: value) }
        }
    }
}
