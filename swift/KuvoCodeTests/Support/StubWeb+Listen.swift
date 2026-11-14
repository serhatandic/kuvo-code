import Foundation
import Network

/// StubWeb's answers from another process: this Mac's box (`kuvo-link.js serve`, run with Node in
/// the tests) reaches a stand-in engine at its address, which nothing else listens on. Each
/// request is answered as StubWeb answers one in this process, then the connection closes.
nonisolated extension StubWeb {
    /// Listens on 127.0.0.1:`port` until `stopListening`; what it's asked goes to the same
    /// routes and handlers as a request here. Throws when it can't (the port's taken), rather
    /// than waiting for it.
    static func listen(port: UInt16) async throws {
        // The last test's listener there, closed first.
        await closing.withLock { $0.removeValue(forKey: port) }?.value
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            read(connection, port: port, so: Data())
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = Guarded(false)
            @Sendable func finish(_ error: Error?) {
                guard once.withLock({ done in defer { done = true }; return !done }) else { return }
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(nil)
                case .failed(let error), .waiting(let error):
                    listener.cancel()
                    finish(error)
                case .cancelled: finish(TestFailure("The stand-in's port \(port) closed before it listened."))
                default: break
                }
            }
            listener.start(queue: .global())
        }
        listening.withLock { $0[port] = listener }
    }

    /// Stops listening; the port is free again once it's closed, which the next `listen` there
    /// waits for.
    static func stopListening(port: UInt16) {
        guard let listener = listening.withLock({ $0.removeValue(forKey: port) }) else { return }
        // Closed already (it failed, and was cancelled then): nothing to wait for.
        if case .cancelled = listener.state { return }
        let closed = Task {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                listener.stateUpdateHandler = { state in
                    if case .cancelled = state { continuation.resume() }
                }
                listener.cancel()
            }
        }
        closing.withLock { $0[port] = closed }
    }

    private static let closing = Guarded<[UInt16: Task<Void, Never>]>([:])
    private static let listening = Guarded<[UInt16: NWListener]>([:])

    /// Reads until the request is whole (its head, and as much body as it says), then answers.
    private static func read(_ connection: NWConnection, port: UInt16, so far: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, done, error in
            var received = far
            if let data { received += data }
            if let request = request(from: received, port: port) {
                let answer = answer(for: request, body: request.httpBody ?? Data())
                let reason = HTTPURLResponse.localizedString(forStatusCode: answer.status)
                let head = "HTTP/1.1 \(answer.status) \(reason)\r\ncontent-type: application/json\r\ncontent-length: \(answer.body.count)\r\nconnection: close\r\n\r\n"
                connection.send(content: Data(head.utf8) + answer.body, completion: .contentProcessed { _ in connection.cancel() })
            } else if done || error != nil {
                connection.cancel()
            } else {
                read(connection, port: port, so: received)
            }
        }
    }

    /// The request in `data` once it's whole; nil while more is to come.
    private static func request(from data: Data, port: UInt16) -> URLRequest? {
        guard let end = data.firstRange(of: Data("\r\n\r\n".utf8)) else { return nil }
        let lines = String(decoding: data[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ") ?? []
        guard parts.count >= 2, let url = URL(string: "http://127.0.0.1:\(port)\(parts[1])") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = String(parts[0])
        var length = 0
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces), value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            request.setValue(value, forHTTPHeaderField: name)
            if name.lowercased() == "content-length" { length = Int(value) ?? 0 }
        }
        let body = data[end.upperBound...]
        guard body.count >= length else { return nil }
        request.httpBody = Data(body.prefix(length))
        return request
    }
}

/// A value behind a lock.
nonisolated final class Guarded<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    func withLock<T>(_ body: (inout Value) -> T) -> T { lock.withLock { body(&value) } }
}
