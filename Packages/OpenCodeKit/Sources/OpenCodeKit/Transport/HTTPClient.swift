import Foundation

/// An error the server answered with, or a response we couldn't use.
public struct ServerError: LocalizedError, Sendable {
    public var status: Int
    public var message: String

    public var errorDescription: String? { message }
}

/// Where the server is and how to authenticate to it.
public struct ServerEndpoint: Sendable, Equatable {
    public var url: URL
    public var username: String
    public var password: String?

    public init(url: URL, username: String = "opencode", password: String?) {
        self.url = url
        self.username = username
        self.password = password
    }

    var authorization: String? {
        password.map { "Basic " + Data("\(username):\($0)".utf8).base64EncodedString() }
    }
}

/// JSON over HTTP to one opencode server.
public struct HTTPClient: Sendable {
    public var endpoint: ServerEndpoint
    let session: URLSession

    public init(endpoint: ServerEndpoint, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    public static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        return decoder
    }()

    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    public func request(_ method: String, _ path: String, query: [String: String?] = [:], body: (some Encodable)? = Empty?.none) throws -> URLRequest {
        // `path` arrives percent-encoded already (IDs are escaped by the caller).
        var components = URLComponents(url: endpoint.url, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = components.percentEncodedPath.trimmingSuffix("/") + "/" + path
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
        if !items.isEmpty { components.percentEncodedQueryItems = items.sorted { $0.name < $1.name }.map(\.formEscaped) }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authorization = endpoint.authorization {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try Self.encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// Sends a request and decodes the JSON response.
    ///
    /// While the engine is still loading a project it answers 503 ("starting");
    /// those are retried for up to `patience` before giving up.
    public func send<Response: Decodable>(_ request: URLRequest, as type: Response.Type = Response.self, patience: Duration = .seconds(30)) async throws -> Response {
        let deadline = ContinuousClock.now + patience
        var (data, response) = try await session.data(for: request)
        while (response as? HTTPURLResponse)?.statusCode == 503, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(400))
            (data, response) = try await session.data(for: request)
        }
        try Self.check(response, data: data)
        if Response.self == Empty.self, data.isEmpty { return Empty() as! Response }
        do {
            return try Self.decoder.decode(Response.self, from: data)
        } catch {
            throw DecodingFailure(path: request.url?.path ?? "", underlying: error, body: String(decoding: data.prefix(2_000), as: UTF8.self))
        }
    }

    /// Opens a streaming response (for `text/event-stream`).
    public func stream(_ request: URLRequest) async throws -> URLSession.AsyncBytes {
        var request = request
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = .infinity
        let (bytes, response) = try await session.bytes(for: request)
        try Self.check(response, data: nil)
        return bytes
    }

    static func check(_ response: URLResponse, data: Data?) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw ServerError(status: http.statusCode, message: data.flatMap(Self.message(in:)) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
    }

    /// Pulls a human-readable message out of an error body, whatever its shape.
    static func message(in data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return String(data: data, encoding: .utf8).flatMap { $0.isEmpty ? nil : $0 }
        }
        for key in ["message", "error", "detail"] {
            if let text = object[key] as? String { return text }
            if let nested = object[key] as? [String: Any], let text = nested["message"] as? String { return text }
        }
        if let data = object["data"] as? [String: Any], let text = data["message"] as? String { return text }
        return nil
    }
}

extension URLQueryItem {
    /// This item escaped for `URLComponents.percentEncodedQueryItems`, the way JavaScript's
    /// `encodeURIComponent` does. `queryItems` leaves `+` (and `;`, `/`, `(`…) as they are, and a
    /// server that reads the query as a form (the engine, search engines) takes `+` for a space,
    /// so "c++" would arrive as "c  ".
    public var formEscaped: URLQueryItem {
        URLQueryItem(name: name.pathEscaped, value: value?.pathEscaped)
    }
}

/// A body or response with nothing in it.
public struct Empty: Codable, Sendable {
    public init() {}
}

public struct DecodingFailure: LocalizedError, CustomStringConvertible {
    public var path: String
    public var underlying: Error
    /// What came back (the start of it), for a closer look while debugging. Not in its
    /// description, which goes in logs: it can hold accounts' details.
    public var body: String

    public var errorDescription: String? { "Couldn't read the response from \(path): \(underlying)" }
    public var description: String { errorDescription ?? path }
}

extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
    }
}
