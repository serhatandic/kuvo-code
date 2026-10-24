import Foundation
import Network

/// StubWeb's answers from another process: this Mac's box (`kuvo-link.js serve`, run with Node in
/// the tests) reaches a stand-in engine at its address, which nothing else listens on. Each
/// request is answered as StubWeb answers one in this process, then the connection closes.
nonisolated extension StubWeb {
    /// Listens on 127.0.0.1:`port` until `stopListening`; what it's asked goes to the same
    /// routes and handlers as a request here.
    static func listen(port: UInt16) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            read(connection, port: port, so: Data())
        }
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed, .cancelled: ready.signal()
            default: break
            }
        }
        listener.start(queue: .global())
        ready.wait()
        listening.withLock { $0[port] = listener }
    }

    static func stopListening(port: UInt16) {
        listening.withLock { $0.removeValue(forKey: port) }?.cancel()
    }

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
