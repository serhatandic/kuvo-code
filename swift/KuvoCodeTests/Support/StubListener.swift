import Foundation
import Network
import OpenCodeKit

extension StubEngine {
    /// The same stand-in at a real address on this Mac's loopback, for what runs outside the app
    /// and so can't be answered in it (`StubWeb`): the agents bridge, which reaches its engine
    /// itself. It answers as at its own address, and records what's asked alike. Stop it with the
    /// test.
    func listen() async throws -> StubListener {
        try await StubListener { [weak self] request, body in
            self?.answer(request, body) ?? StubWeb.Answer(status: 503)
        }
    }
}

/// A plain HTTP/1.1 server on a free loopback port: each request answered by `answer`, one a
/// connection, which then closes.
nonisolated final class StubListener: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "run.kuvo.code.tests.stub-listener")
    private(set) var port: UInt16 = 0
    var endpoint: ServerEndpoint { ServerEndpoint(url: URL(string: "http://127.0.0.1:\(port)")!, password: "test") }

    init(answer: @escaping @Sendable (URLRequest, Data) -> StubWeb.Answer) async throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters)
        let queue = queue
        listener.newConnectionHandler = { connection in
            Exchange(connection: connection, queue: queue, answer: answer).start()
        }
        let listener = listener
        port = try await withCheckedThrowingContinuation { continuation in
            // Its states come one at a time, on its queue: the first that settles it counts.
            final class Once: @unchecked Sendable { var done = false }
            let once = Once()
            listener.stateUpdateHandler = { state in
                guard !once.done else { return }
                switch state {
                case .ready:
                    once.done = true
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let error), .waiting(let error):
                    once.done = true
                    continuation.resume(throwing: error)
                case .cancelled:
                    once.done = true
                    continuation.resume(throwing: CancellationError())
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }
}

/// One connection: its request read whole, answered, closed.
nonisolated private final class Exchange: @unchecked Sendable {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let answer: @Sendable (URLRequest, Data) -> StubWeb.Answer
    private var buffer = Data()

    init(connection: NWConnection, queue: DispatchQueue, answer: @escaping @Sendable (URLRequest, Data) -> StubWeb.Answer) {
        self.connection = connection
        self.queue = queue
        self.answer = answer
    }

    func start() {
        connection.start(queue: queue)
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [self] data, _, complete, error in
            if let data { buffer.append(data) }
            if respond() { return }
            if complete || error != nil { connection.cancel() } else { receive() }
        }
    }

    /// Answers once the request's all there; whether it was.
    private func respond() -> Bool {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else { return false }
        var lines = String(decoding: buffer[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else {
            connection.cancel()
            return true
        }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        guard buffer.count - end.upperBound >= length else { return false }
        let body = buffer.subdata(in: end.upperBound..<(end.upperBound + length))
        var request = URLRequest(url: URL(string: "http://127.0.0.1" + first[1])!)
        request.httpMethod = String(first[0])
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let answered = answer(request, body)
        let head = "HTTP/1.1 \(answered.status) Answer\r\nContent-Type: application/json\r\nContent-Length: \(answered.body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + answered.body, completion: .contentProcessed { [connection] _ in connection.cancel() })
        return true
    }
}
