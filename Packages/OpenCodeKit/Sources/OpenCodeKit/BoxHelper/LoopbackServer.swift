#if os(macOS)
import Foundation
import Network
import os

/// HTTP on a free loopback port, for Kuvo Code's own helpers to call: the agent's browser tools
/// (`BrowserToolServer`), and this Mac's box asking for what only its app or its helper can do (the
/// app's `HostInterface`, the helper's `BoxHelperHost`). Each checks who's asking itself (a password
/// in the request).
@MainActor
public final class LoopbackServer {
    private let respond: (HTTPRequest) async -> HTTPResponse
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: HTTPConnection] = [:]
    public private(set) var port: UInt16?
    /// Told when it stops listening by itself, once it was (not after `stop()`).
    public var failed: (() -> Void)?
    /// The start under way: one listener at a time, whoever else asks meanwhile waits for it.
    private var starting: Task<UInt16, Error>?

    public init(respond: @escaping (HTTPRequest) async -> HTTPResponse) {
        self.respond = respond
    }

    /// Starts listening (once), and says where.
    public func start() async throws -> UInt16 {
        if let port { return port }
        if let starting { return try await starting.value }
        let starting = Task { try await listen() }
        self.starting = starting
        defer { if self.starting == starting { self.starting = nil } }
        return try await starting.value
    }

    /// A new listener, ready: its port.
    private func listen() async throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            listener.stateUpdateHandler = { [weak self] state in
                MainActor.assumeIsolated {
                    guard !resumed else {
                        // Failed once it was listening: gone, said to whoever keeps it up.
                        if case .failed = state { self?.lost(listener) }
                        return
                    }
                    switch state {
                    case .ready:
                        resumed = true
                        continuation.resume(returning: listener.port?.rawValue ?? 0)
                    // One that can't listen now (waiting for a network that may never come) fails.
                    case .failed(let error), .waiting(let error):
                        resumed = true
                        listener.cancel()
                        continuation.resume(throwing: error)
                    case .cancelled:
                        resumed = true
                        continuation.resume(throwing: CancellationError())
                    default:
                        break
                    }
                }
            }
            listener.start(queue: .main)
        }
        // Stopped meanwhile: not this one's to say.
        guard self.listener === listener else { throw CancellationError() }
        self.port = port
        return port
    }

    /// It stopped listening by itself: as if stopped, then said.
    private func lost(_ gone: NWListener) {
        guard listener === gone else { return }
        stop()
        failed?()
    }

    /// Stops listening, and closes what's open.
    public func stop() {
        starting = nil
        listener?.cancel()
        listener = nil
        port = nil
        for connection in connections.values { connection.close() }
        connections = [:]
    }

    private func accept(_ connection: NWConnection) {
        let http = HTTPConnection(connection: connection) { [weak self] request in
            await self?.respond(request) ?? .init(status: 503)
        } closed: { [weak self] id in
            self?.connections[id] = nil
        }
        connections[ObjectIdentifier(http)] = http
        http.start()
    }
}

/// Whether two passwords are the same, taking as long whichever character differs: how long a
/// wrong guess takes says nothing of the right one.
public func samePassword(_ given: String, _ expected: String) -> Bool {
    let a = Array(given.utf8), b = Array(expected.utf8)
    var difference = UInt8(a.count == b.count ? 0 : 1)
    for index in 0..<b.count { difference |= (index < a.count ? a[index] : 0) ^ b[index] }
    return difference == 0
}

// MARK: - A minimal HTTP/1.1 server connection

public struct HTTPRequest: Sendable {
    public var method: String
    public var path: String
    public var headers: [String: String]
    public var body: Data

    public init(method: String, path: String, headers: [String: String], body: Data) {
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body
    }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var headers: [String: String] = [:]
    public var body = Data()
    /// A body that comes as it's made (a route that follows something), sent as it comes, in chunks:
    /// one that ends with an error is cut off without its last chunk, so the client knows it isn't
    /// whole (the connection closes then; one that ends whole leaves it for the next request).
    public var stream: AsyncThrowingStream<Data, Error>?

    public init(status: Int, headers: [String: String] = [:], body: Data = Data(), stream: AsyncThrowingStream<Data, Error>? = nil) {
        self.status = status
        self.headers = headers
        self.body = body
        self.stream = stream
    }

    public static func json(_ object: Any) -> HTTPResponse {
        // Sorted, so the tools' list reads the same at every launch, and a conversation picked up
        // after one keeps the provider's prompt cache.
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], body: data)
    }
}

/// One client connection: reads requests (keep-alive), answers them one at a time. It keeps
/// reading meanwhile, so a client that goes away stops what it asked for.
@MainActor
final class HTTPConnection {
    private let connection: NWConnection
    private let handler: (HTTPRequest) async -> HTTPResponse
    private let closed: (ObjectIdentifier) -> Void
    private var buffer = Data()
    /// The request being answered.
    private var answering: Task<Void, Never>?
    /// Closed, or closing: what's sent off the main actor (a stream) reads it too.
    private let gone = Gone()
    private var closing: Bool {
        get { gone.value }
        set { if newValue { gone.set() } }
    }

    init(connection: NWConnection, handler: @escaping (HTTPRequest) async -> HTTPResponse, closed: @escaping (ObjectIdentifier) -> Void) {
        self.connection = connection
        self.handler = handler
        self.closed = closed
    }

    /// Closes it, stopping what it was answering.
    func close() {
        closing = true
        answering?.cancel()
        connection.cancel()
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch state {
                case .failed, .cancelled:
                    self.closing = true
                    self.answering?.cancel()
                    self.closed(ObjectIdentifier(self))
                default: break
                }
            }
        }
        connection.start(queue: .main)
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, !self.closing else { return }
                if let data { self.buffer.append(data) }
                if self.answering == nil { self.process() }
                if complete || error != nil {
                    // Gone: what it asked stops.
                    self.connection.cancel()
                } else if !self.closing {
                    self.receive()
                }
            }
        }
    }

    /// The most a request's headers and body may take: far more than a tool call needs.
    static let maxHead = 64 * 1024
    static let maxBody = 16 * 1024 * 1024

    /// Starts answering a complete request in the buffer, if there is one.
    private func process() {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            // Headers that never end aren't a request.
            if buffer.count > Self.maxHead { refuse() }
            return
        }
        guard headerEnd.lowerBound - buffer.startIndex <= Self.maxHead else { return refuse() }
        let head = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else {
            closing = true
            return connection.cancel()
        }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        // A length that isn't one, below zero or too big is turned away before it's read.
        guard let length = Int(headers["content-length"] ?? "0"), (0...Self.maxBody).contains(length) else { return refuse() }
        let bodyStart = headerEnd.upperBound
        guard buffer.count - bodyStart >= length else { return }
        let body = buffer.subdata(in: bodyStart..<(bodyStart + length))
        buffer.removeSubrange(..<(bodyStart + length))
        let request = HTTPRequest(method: String(requestLine[0]), path: String(requestLine[1]), headers: headers, body: body)
        answering = Task {
            let response = await handler(request)
            send(response)
        }
    }

    /// A request it won't read: says so, and closes the connection.
    private func refuse() {
        closing = true
        buffer = Data()
        let head = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated { self?.connection.cancel() }
        })
    }

    /// A body that comes as it's made: each piece as a chunk as it comes, then the last chunk, and
    /// the connection kept for the next request; one that fails closes with no last chunk. One the client leaves stops
    /// (`close`, cancelling `answering`). Sent off the main actor, so a phone following something
    /// (the engine's events) never waits on the window, nor adds to its work.
    private func send(head: Data, stream: AsyncThrowingStream<Data, Error>) {
        let connection = connection, gone = gone
        connection.send(content: head, completion: .contentProcessed { _ in })
        answering = Task.detached {
            var whole = false
            do {
                let sending = InFlight()
                for try await piece in stream where !piece.isEmpty {
                    guard !gone.value else { return }
                    // A client that reads slowly holds the next back, once enough waits to go.
                    await sending.room()
                    let chunk = Self.chunk(piece)
                    sending.add(chunk.count)
                    connection.send(content: chunk, completion: .contentProcessed { _ in sending.done(chunk.count) })
                }
                whole = true
            } catch {}
            guard !gone.value else { return }
            // Cut off: closed with no last chunk, so it's never read as if it had ended.
            guard whole else {
                gone.set()
                return connection.cancel()
            }
            // Whole: its last chunk ends it, and the connection stays for the client's next request,
            // which URLSession and Node's fetch send on it at once (a POST lost if it were closed).
            connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { [weak self] _ in
                MainActor.assumeIsolated { self?.answered() }
            })
        }
    }

    /// The answer's all sent: the next request on this connection, if one came in meanwhile.
    private func answered() {
        guard !closing else { return }
        answering = nil
        process()
    }

    /// `piece` as a chunk of a chunked body.
    private nonisolated static func chunk(_ piece: Data) -> Data {
        Data((String(piece.count, radix: 16) + "\r\n").utf8) + piece + Data("\r\n".utf8)
    }

    private func send(_ response: HTTPResponse) {
        let reason: String = switch response.status {
        case 200: "OK"
        case 202: "Accepted"
        case 400: "Bad Request"
        case 401: "Unauthorized"
        case 403: "Forbidden"
        case 404: "Not Found"
        case 405: "Method Not Allowed"
        case 413: "Content Too Large"
        case 503: "Service Unavailable"
        default: "Error"
        }
        var head = "HTTP/1.1 \(response.status) \(reason)\r\n"
        var headers = response.headers
        if response.stream == nil {
            headers["Content-Length"] = String(response.body.count)
            headers["Connection"] = "keep-alive"
        } else {
            // Chunked, and not said to close: a client then takes a close before the last chunk
            // as cut off, where with "Connection: close" Node's fetch takes it as the end.
            headers["Transfer-Encoding"] = "chunked"
        }
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        guard !closing else { return }
        if let stream = response.stream { return send(head: Data(head.utf8), stream: stream) }
        connection.send(content: Data(head.utf8) + response.body, completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated { self?.answered() }
        })
    }
}

/// Whether a connection's gone, from any thread.
final class Gone: Sendable {
    private let flag = OSAllocatedUnfairLock(initialState: false)
    var value: Bool { flag.withLock { $0 } }
    func set() { flag.withLock { $0 = true } }
}

/// What's been handed to a connection and not sent yet: up to `most` bytes go without waiting (the
/// connection says each one's sent on its own queue, the main one), then the next waits for room.
/// Known: what comes before this (the engine's answer, `EngineRoutes.forward`) isn't bounded yet.
final class InFlight: Sendable {
    private let most = 1 << 20
    private let state = OSAllocatedUnfairLock<(bytes: Int, waiting: [CheckedContinuation<Void, Never>])>(initialState: (0, []))

    func add(_ bytes: Int) { state.withLock { $0.bytes += bytes } }

    func done(_ bytes: Int) {
        let ready = state.withLock { state -> [CheckedContinuation<Void, Never>] in
            state.bytes -= bytes
            guard state.bytes < most else { return [] }
            defer { state.waiting = [] }
            return state.waiting
        }
        for waiting in ready { waiting.resume() }
    }

    func room() async {
        await withCheckedContinuation { continuation in
            let now = state.withLock { state -> Bool in
                if state.bytes < most { return true }
                state.waiting.append(continuation)
                return false
            }
            if now { continuation.resume() }
        }
    }
}
#endif
