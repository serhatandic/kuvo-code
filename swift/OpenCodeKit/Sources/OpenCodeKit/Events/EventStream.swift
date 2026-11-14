import Foundation

/// The engine's live event feed, kept connected.
///
/// The feed has no replay: events missed while disconnected are gone. So every
/// (re)connection yields `.connected` first, and listeners re-fetch what they show.
public struct EventStream: Sendable {
    public enum Update: Sendable {
        case connected
        case disconnected(Error?)
        case event(ServerEvent)
    }

    let client: HTTPClient
    /// The server sends a heartbeat every 15 s; three missed means the connection is dead.
    var idleTimeout: Duration = .seconds(45)

    public init(client: HTTPClient) {
        self.client = client
    }

    /// How long to wait before trying again: a second after a connection that worked (a blip),
    /// then twice as long each time, up to half a minute, while the server stays away (one that
    /// moved, through a tunnel that no longer reaches it, shouldn't be knocked on every second).
    static func wait(after attempt: Int) -> Duration {
        .seconds(min(pow(2, Double(max(attempt, 1) - 1)), 30))
    }

    public func updates() -> AsyncStream<Update> {
        AsyncStream { continuation in
            let task = Task {
                var attempt = 0
                while !Task.isCancelled {
                    let connected = Flag()
                    do {
                        try await connect { update in
                            if case .connected = update { connected.set() }
                            continuation.yield(update)
                        }
                        continuation.yield(.disconnected(nil))
                    } catch is CancellationError {
                        break
                    } catch {
                        continuation.yield(.disconnected(error))
                    }
                    attempt = connected.isSet ? 1 : attempt + 1
                    try? await Task.sleep(for: Self.wait(after: attempt))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func connect(_ yield: @escaping @Sendable (Update) -> Void) async throws {
        // Watching from the request on: one lost on the way (into a tunnel, or a phone link's
        // session the other end has forgotten) would wait for its answer forever, and the feed
        // would never come back by itself.
        let watchdog = Watchdog(timeout: idleTimeout)
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                let bytes = try await client.stream(client.request("GET", "api/event"))
                watchdog.feed()
                for try await sse in bytes.serverSentEvents(onLine: watchdog.feed) {
                    guard let data = sse.data.data(using: .utf8) else { continue }
                    guard let event = try? ServerEvent(json: data) else { continue }
                    if event.type == "server.connected" {
                        yield(.connected)
                    } else {
                        yield(.event(event))
                    }
                }
            }
            group.addTask { try await watchdog.run() }
            // Whichever ends first (stream closed, or went silent) ends the connection.
            try await group.next()
            group.cancelAll()
        }
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    func set() { lock.withLock { value = true } }
    var isSet: Bool { lock.withLock { value } }
}

/// Throws once nothing has been fed for `timeout`. Fed on every line, heartbeats included.
private final class Watchdog: @unchecked Sendable {
    private let timeout: Duration
    private let lock = NSLock()
    private var last = ContinuousClock.now

    init(timeout: Duration) {
        self.timeout = timeout
    }

    func feed() {
        lock.withLock { last = .now }
    }

    func run() async throws {
        while true {
            try await Task.sleep(for: min(.seconds(5), timeout / 3))
            let silent = lock.withLock { ContinuousClock.now - last }
            if silent > timeout { throw URLError(.timedOut) }
        }
    }
}
