import Foundation
import Testing
@testable import KuvoLink

/// The phone's WebSocket to the relay pings it now and then, to notice a relay or path that's gone
/// quiet. A ping goes out behind what the phone already handed its connection: a picture still on
/// its way on a slow connection (LTE) holds its pong up as long as that takes (#144).
struct RelayKeepaliveTests {
    /// A picture on a slow connection, still going out when a ping goes: its pong comes back behind
    /// it, late, and the connection (with the message going on it) carries on.
    @Test(.timeLimit(.minutes(1))) func aPingBehindAPictureOnASlowConnectionWaitsForIt() async throws {
        let clock = ManualClock()
        let socket = StandInSocket()
        let relay = WebSocketRelay(socket: socket, address: Self.address, clock: clock.link)
        let picture = Self.send(1_300_000, on: relay)
        await socket.took(picture)
        await clock.advance(by: WebSocketRelay.pingEvery)
        await socket.pinged(1)
        // (The pong's wait, waiting.)
        await clock.sleepers(1, dueWithin: .seconds(3600))
        // Nothing gives up on it while a slow connection may still be sending the picture.
        #expect(clock.due(within: .seconds(25)) == 0)
        await clock.advance(by: .seconds(25), waking: 0)
        socket.answerPing()
        // It pings again in a while: still there.
        await clock.sleepers(1, dueWithin: WebSocketRelay.pingEvery)
        #expect(!socket.isCancelled)
        _ = relay
    }

    /// A relay that stops answering (frozen, or a path gone dead) behind a picture: once a slow
    /// connection would have sent it all, the connection counts as gone, and everything connects
    /// again.
    @Test(.timeLimit(.minutes(1))) func aPingNeverAnsweredBehindAPictureEndsTheConnectionOnceItWouldHaveGone() async throws {
        let clock = ManualClock()
        let socket = StandInSocket()
        let relay = WebSocketRelay(socket: socket, address: Self.address, clock: clock.link)
        await socket.took(Self.send(1_300_000, on: relay))
        await clock.advance(by: WebSocketRelay.pingEvery)
        await socket.pinged(1)
        await clock.advance(by: WebSocketRelay.pongWithin + .seconds(1_300_000 / Link.slowUpload))
        await socket.cancelled()
        _ = relay
    }

    /// With nothing on its way, a relay that doesn't answer a ping counts as gone after 10 s, as
    /// before.
    @Test(.timeLimit(.minutes(1))) func aPingNeverAnsweredOnAQuietConnectionEndsItAfterTenSeconds() async throws {
        let clock = ManualClock()
        let socket = StandInSocket()
        let relay = WebSocketRelay(socket: socket, address: Self.address, clock: clock.link)
        await clock.advance(by: WebSocketRelay.pingEvery)
        await socket.pinged(1)
        #expect(clock.due(within: WebSocketRelay.pongWithin - .seconds(1)) == 0)
        await clock.advance(by: WebSocketRelay.pongWithin)
        await socket.cancelled()
        _ = relay
    }

    /// The picture's bytes, sent as the link sends a body (in pieces of a relay message each).
    /// How many bytes the relay connection hands its socket.
    private static func send(_ size: Int, on relay: WebSocketRelay) -> Int {
        var handed = 0
        var left = size
        while left > 0 {
            let piece = min(left, 60_000)
            let message = RelayMessage.send(to: address, payload: Data(repeating: 7, count: piece))
            handed += message.data.count
            relay.send(message)
            left -= piece
        }
        return handed
    }

    private static let address = LinkAddress(bytes: Data(repeating: 1, count: LinkAddress.length))!
}

/// A relay WebSocket in memory: takes what's sent at once (as the system takes it into its
/// buffers), and answers a ping only when the test says.
private final class StandInSocket: RelaySocket, @unchecked Sendable {
    private let lock = NSLock()
    private var handed = 0
    private var pings: [@Sendable ((any Error)?) -> Void] = []
    private var ended = false
    private var watchers: [(check: () -> Bool, go: CheckedContinuation<Void, Never>)] = []
    private var incoming: CheckedContinuation<Data?, Never>?

    var isCancelled: Bool { lock.withLock { ended } }

    func send(_ data: Data) async throws {
        changed { handed += data.count }
    }

    func receive() async -> Data? {
        await withCheckedContinuation { continuation in
            let now = lock.withLock {
                if ended { return true }
                incoming = continuation
                return false
            }
            if now { continuation.resume(returning: nil) }
        }
    }

    func sendPing(_ answered: @escaping @Sendable ((any Error)?) -> Void) {
        changed { pings.append(answered) }
    }

    func cancel() {
        let waiting = lock.withLock { () -> CheckedContinuation<Data?, Never>? in
            defer { incoming = nil }
            return incoming
        }
        changed { ended = true }
        waiting?.resume(returning: nil)
    }

    func close() { cancel() }

    /// The pong for the last ping.
    func answerPing() {
        let answer = lock.withLock { pings.last }
        answer?(nil)
    }

    /// Once it's taken `bytes` in all.
    func took(_ bytes: Int) async { await until { self.handed >= bytes } }
    /// Once `count` pings went.
    func pinged(_ count: Int) async { await until { self.pings.count >= count } }
    /// Once it's been given up as gone.
    func cancelled() async { await until { self.ended } }

    private func until(_ check: @escaping () -> Bool) async {
        await withCheckedContinuation { continuation in
            let now = lock.withLock {
                if check() { return true }
                watchers.append((check, continuation))
                return false
            }
            if now { continuation.resume() }
        }
    }

    private func changed(_ change: () -> Void) {
        let ready = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            change()
            let ready = watchers.filter { $0.check() }.map(\.go)
            watchers.removeAll { $0.check() }
            return ready
        }
        for go in ready { go.resume() }
    }
}
