import Foundation

/// One event from a `text/event-stream` response.
public struct ServerSentEvent: Sendable, Equatable {
    public var id: String?
    public var event: String?
    public var data: String
    public var retry: Int?

    public init(id: String? = nil, event: String? = nil, data: String, retry: Int? = nil) {
        self.id = id
        self.event = event
        self.data = data
        self.retry = retry
    }
}

/// Turns the lines of an event stream into events, following the WHATWG
/// "event stream interpretation" rules: `data` lines join with newlines, a
/// blank line dispatches, comment lines (`:`) are ignored, and an event with
/// no data is dropped.
public struct ServerSentEventParser: Sendable {
    private var id: String?
    private var event: String?
    private var data: [String] = []
    private var retry: Int?
    private var sawData = false

    public init() {}

    /// Feeds one line, without its terminator. Returns an event when the line
    /// completes one.
    public mutating func feed(line: some StringProtocol) -> ServerSentEvent? {
        if line.isEmpty { return dispatch() }
        if line.hasPrefix(":") { return nil }

        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = Substring(line[..<colon])
            value = Substring(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }

        switch field {
        case "data":
            data.append(String(value))
            sawData = true
        case "event":
            event = String(value)
        case "id" where !value.contains("\0"):
            id = String(value)
        case "retry":
            retry = Int(value)
        default:
            break
        }
        return nil
    }

    private mutating func dispatch() -> ServerSentEvent? {
        defer {
            event = nil
            data = []
            retry = nil
            sawData = false
        }
        guard sawData else { return nil }
        return ServerSentEvent(id: id, event: event, data: data.joined(separator: "\n"), retry: retry)
    }
}

extension URLSession.AsyncBytes {
    /// The events in this response body, in order. Ends when the server closes the stream.
    /// `onLine` runs for every line, comments included, so callers can tell a quiet
    /// stream (heartbeat comments only) from a dead one.
    public func serverSentEvents(onLine: @escaping @Sendable () -> Void = {}) -> AsyncThrowingStream<ServerSentEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var parser = ServerSentEventParser()
                var line: [UInt8] = []
                do {
                    // `lines` would merge blank lines away, and blank lines are what dispatch events,
                    // so split on line terminators by hand (\n, \r\n or a lone \r).
                    var lastWasCR = false
                    for try await byte in self {
                        if byte == UInt8(ascii: "\n"), lastWasCR {
                            lastWasCR = false
                            continue
                        }
                        lastWasCR = byte == UInt8(ascii: "\r")
                        if byte == UInt8(ascii: "\n") || byte == UInt8(ascii: "\r") {
                            onLine()
                            if let event = parser.feed(line: String(decoding: line, as: UTF8.self)) {
                                continuation.yield(event)
                            }
                            line.removeAll(keepingCapacity: true)
                        } else {
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
