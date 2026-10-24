import Foundation
import KuvoLink
import OpenCodeKit

/// One box as a client sees it: its routes (KuvoLink's PROTOCOL.md), wherever it is. The app's
/// stores call a box's routes through this, as a phone does through the link, and never know more
/// of a box than its id: this Mac's (`BoxClient.mac`) goes through PhoneLink's answer, which hands
/// a moved area to this Mac's box process (`BoxProcess`); a machine's, through its box over SSH.
struct BoxClient: Sendable {
    /// "mac", or a machine's id.
    let box: String
    let transport: any BoxTransport

    static let mac = "mac"

    /// What the box answered.
    func send(_ method: String, _ path: String, body: Data? = nil) async throws -> (status: Int, body: Data) {
        var status = 502
        var answer = Data()
        let request = LinkRequest(method: method, path: path, headers: body == nil ? [:] : ["content-type": "application/json"], body: body ?? Data())
        for try await part in transport.send(request) {
            switch part {
            case .head(let code, _): status = code
            case .body(let data): answer += data
            }
        }
        return (status, answer)
    }

    /// Its answer, read as `T`; what a box refuses, as it said it (`BoxRefusal`).
    func value<T: Decodable>(_ type: T.Type = T.self, _ method: String = "GET", _ path: String, body: (any Encodable)? = nil) async throws -> T {
        let (status, data) = try await send(method, path, body: try body.map { try JSONEncoder().encode($0) })
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// A route that follows something (`kuvo/…/events`): each line it sends, as it comes. It ends
    /// when the box stops sending; one that doesn't stream (a machine's, over SSH) sends its answer
    /// once and ends.
    func follow(_ path: String) -> AsyncThrowingStream<Data, Error> {
        let transport = transport
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var buffer = Data()
                    var status = 200
                    for try await part in transport.send(LinkRequest(method: "GET", path: path)) {
                        switch part {
                        case .head(let code, _): status = code
                        case .body(let data):
                            guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
                            buffer += data
                            while let end = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                                let line = buffer[buffer.startIndex..<end]
                                if !line.isEmpty { continuation.yield(Data(line)) }
                                buffer.removeSubrange(buffer.startIndex...end)
                            }
                        }
                    }
                    // Refused with nothing said: still refused, not a stream that ended.
                    guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: buffer) }
                    if !buffer.isEmpty { continuation.yield(buffer) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// What a box said when it said no: its status, and its words (`{"message"}`) or, without them,
/// that it said no.
struct BoxRefusal: LocalizedError {
    var status: Int
    var message: String
    var errorDescription: String? { message }

    init(status: Int, message: String) {
        self.status = status
        self.message = message
    }

    init(status: Int, data: Data) {
        let said = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
        self.init(status: status, message: said ?? "It said no (\(status)).")
    }
}

/// Where a box's routes are reached.
protocol BoxTransport: Sendable {
    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error>
}

/// This Mac's box: PhoneLink's own answer, as a phone gets it, which hands what's moved to the
/// box process.
struct LocalBox: BoxTransport {
    let respond: @Sendable (LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error>

    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> { respond(request) }
}

/// A machine's box, through `kuvo-link.js box route` over SSH: one answer, never a stream.
struct MachineBoxTransport: BoxTransport {
    let connection: SSHConnection

    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
        let connection = connection
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body = request.body.isEmpty ? nil : try JSONSerialization.jsonObject(with: request.body) as? [String: Any]
                    let (status, data) = try await MachineBox.route(request.method, request.path, body: body, on: connection)
                    continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(data))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
