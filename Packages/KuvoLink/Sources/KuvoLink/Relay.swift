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
    private let task: URLSessionWebSocketTask
    private let outbox: AsyncStream<RelayMessage>.Continuation
    private let inbox: AsyncStream<RelayMessage>.Continuation
    /// Messages queued that the socket hasn't taken yet, and who waits for there to be none.
    private let queued = OSAllocatedUnfairLock(initialState: Outbox())

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
            return WebSocketRelay(task: task, address: address)
        } catch {
            task.cancel(with: .goingAway, reason: nil)
            throw LinkError.relayUnavailable
        }
    }

    private init(task: URLSessionWebSocketTask, address: LinkAddress) {
        self.task = task
        self.address = address
        let (messages, inbox) = AsyncStream.makeStream(of: RelayMessage.self)
        let (outgoing, outbox) = AsyncStream.makeStream(of: RelayMessage.self)
        self.messages = messages
        self.inbox = inbox
        self.outbox = outbox

        Task { [task, queued] in
            for await message in outgoing {
                do {
                    try await task.send(.data(message.data))
                } catch {
                    // Nothing more goes out: closed, so it isn't taken for one still sending.
                    task.cancel(with: .goingAway, reason: nil)
                    break
                }
                for waiter in queued.withLock({ $0.count -= 1; return $0.emptied() }) { waiter.resume() }
            }
            for waiter in queued.withLock({ $0.count = 0; $0.closed = true; return $0.emptied() }) { waiter.resume() }
        }
        Task { [task, inbox] in
            while true {
                guard case .data(let data)? = try? await task.receive() else { break }
                if let message = try? RelayMessage(fromRelay: data) { inbox.yield(message) }
            }
            inbox.finish()
            outbox.finish()
        }
        // Pings keep the connection open through routers that forget quiet ones, and notice
        // one that's gone.
        Task { [weak self, task] in
            while self != nil {
                try? await Task.sleep(for: .seconds(25))
                // The pong's handler can be called again (with an error, as the task closes). A
                // relay that stops answering (frozen, or a path gone dead that sends no reset)
                // never pongs: after 10 s it counts as gone, and everything connects again.
                let answered = await firstAnswer { answer in
                    task.sendPing { answer($0 == nil) }
                    DispatchQueue.global().asyncAfter(deadline: .now() + 10) { answer(false) }
                }
                if !answered { task.cancel(with: .goingAway, reason: nil); break }
            }
        }
    }

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
        task.cancel(with: .normalClosure, reason: nil)
        outbox.finish()
        inbox.finish()
    }
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
