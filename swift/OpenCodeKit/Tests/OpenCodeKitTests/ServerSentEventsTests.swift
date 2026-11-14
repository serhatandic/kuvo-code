import Foundation
import Network
import Testing
@testable import OpenCodeKit

struct ServerSentEventsTests {
    private func parse(_ text: String) -> [ServerSentEvent] {
        var parser = ServerSentEventParser()
        return text.split(separator: "\n", omittingEmptySubsequences: false).compactMap { parser.feed(line: $0) }
    }

    @Test func joinsDataLinesAndDispatchesOnBlankLine() {
        let events = parse("event: message\nid: 7\ndata: {\"a\":\ndata: 1}\n\n")
        #expect(events == [ServerSentEvent(id: "7", event: "message", data: "{\"a\":\n1}")])
    }

    @Test func ignoresCommentsAndEventsWithoutData() {
        let events = parse(": heartbeat\n\nevent: ping\n\ndata: x\n\n")
        #expect(events == [ServerSentEvent(data: "x")])
    }

    @Test func keepsLastEventIDAcrossEvents() {
        let events = parse("id: 1\ndata: a\n\ndata: b\n\n")
        #expect(events.map(\.id) == ["1", "1"])
    }

    @Test func stripsOnlyOneLeadingSpace() {
        #expect(parse("data:  two\n\n").first?.data == " two")
        #expect(parse("data:none\n\n").first?.data == "none")
    }
}

struct EventStreamRetryTests {
    @Test func backsOffToHalfAMinute() {
        let waits = (1...8).map { EventStream.wait(after: $0) }
        #expect(waits == [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(16), .seconds(30), .seconds(30), .seconds(30)])
    }
}

/// A server that takes the connection and never answers: the feed gives up on it rather than
/// waiting for the response forever.
struct EventStreamSilentServerTests {
    @Test func givesUpOnARequestNeverAnswered() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let held = Held()
        listener.newConnectionHandler = { connection in
            held.keep(connection)
            connection.start(queue: .global())
        }
        let port = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
            listener.stateUpdateHandler = { state in
                if case .ready = state, let port = listener.port?.rawValue { continuation.resume(returning: port) }
                if case .failed(let error) = state { continuation.resume(throwing: error) }
            }
            listener.start(queue: .global())
        }
        defer { listener.cancel() }
        var stream = EventStream(client: HTTPClient(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:\(port)")!, password: nil)))
        stream.idleTimeout = .seconds(1)
        let started = ContinuousClock.now
        var first: EventStream.Update?
        for await update in stream.updates() {
            first = update
            break
        }
        guard case .disconnected(let error)? = first else {
            Issue.record("expected a disconnection, got \(String(describing: first))")
            return
        }
        #expect((error as? URLError)?.code == .timedOut)
        #expect(ContinuousClock.now - started < .seconds(5))
    }

    private final class Held: @unchecked Sendable {
        private let lock = NSLock()
        private var connections: [NWConnection] = []
        func keep(_ connection: NWConnection) { lock.withLock { connections.append(connection) } }
    }
}
