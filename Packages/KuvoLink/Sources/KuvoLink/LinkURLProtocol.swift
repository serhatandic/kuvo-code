import Foundation

/// Lets ordinary URL requests (OpenCodeKit's `HTTPClient` and event stream, unchanged) go to a
/// host over the link: `kuvo-link://<host's address in hex>/api/session`. Give a URLSession
/// `LinkURLProtocol.configuration(...)`.
public final class LinkURLProtocol: URLProtocol, @unchecked Sendable {
    public static let scheme = "kuvo-link"

    /// The URL a host's requests start with.
    public static func baseURL(for host: PairedHost) -> URL {
        URL(string: "\(scheme)://\(host.linkAddress.bytes.hex)/")!
    }

    /// A session configuration whose requests to `kuvo-link://` go through `client`, to the
    /// hosts `hosts` returns.
    public static func configuration(client: LinkClient, hosts: @escaping @Sendable () -> [PairedHost]) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LinkURLProtocol.self]
        // A request waits as long as the host is there and working on it: the link checks on a
        // host that's quiet itself (`Link.answerWithin`), and fails what's on a session it's lost.
        // URLSession's own minute called a busy computer's answer still under way "The request
        // timed out." (#443); this is only a bound for one that never ends.
        configuration.timeoutIntervalForRequest = 600
        configuration.httpAdditionalHeaders = [Route.header: Route.register(client: client, hosts: hosts)]
        return configuration
    }

    /// Lets go of the client a configuration from `configuration(client:hosts:)` sends through,
    /// once no session made with it sends any more: a short-lived session (the share extension's)
    /// leaves nothing behind.
    public static func unregister(_ configuration: URLSessionConfiguration) {
        guard let id = configuration.httpAdditionalHeaders?[Route.header] as? String else { return }
        Route.unregister(id)
    }

    private var loading: Task<Void, Never>?

    public override class func canInit(with request: URLRequest) -> Bool {
        request.url?.scheme == scheme
    }

    public override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    public override func startLoading() {
        let request = self.request
        guard let url = request.url, let route = request.value(forHTTPHeaderField: Route.header).flatMap(Route.find),
              let address = url.host().flatMap({ Data(hex: $0) }).flatMap(LinkAddress.init(bytes:)),
              let host = route.hosts().first(where: { $0.linkAddress == address })
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost, userInfo: [NSLocalizedDescriptionKey: Self.notPaired]))
            return
        }
        var headers = request.allHTTPHeaderFields ?? [:]
        headers[Route.header] = nil
        headers["Authorization"] = nil
        var path = String(url.path().dropFirst())
        if let query = url.query(percentEncoded: true) { path += "?" + query }
        let linkRequest = LinkRequest(method: request.httpMethod ?? "GET", path: path, headers: headers, body: Self.body(of: request))

        let loader = Loader(protocol: self)
        loading = Task { [client = route.client] in
            do {
                for try await part in client.send(linkRequest, to: host) {
                    switch part {
                    case .head(let status, let headers):
                        loader.received(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
                    case .body(let data):
                        loader.loaded(data)
                    }
                }
                // Stopped, it says nothing more to URLSession.
                guard !Task.isCancelled else { return }
                loader.finished()
            } catch {
                guard !Task.isCancelled else { return }
                loader.failed(Self.failure(for: error))
            }
        }
    }

    static let notPaired = "This phone isn’t paired with it."

    /// The link's failure as URLSession's error, in the link's own words (and with the
    /// `LinkError` under it, to tell "pair again" from "asleep"), rather than URLError's generic
    /// "The operation couldn't be completed".
    static func failure(for error: Error) -> URLError {
        let link = error as? LinkError
        let code: URLError.Code = switch link {
        case .hostOffline?, .refused?: .cannotConnectToHost
        case .timedOut?: .timedOut
        case .relayUnavailable?: .notConnectedToInternet
        default: .networkConnectionLost
        }
        return URLError(code, userInfo: [NSLocalizedDescriptionKey: error.localizedDescription, NSUnderlyingErrorKey: error])
    }

    public override func stopLoading() {
        loading?.cancel()
        loading = nil
    }

    /// Tells URLSession how loading goes, from the task that does it.
    private struct Loader: @unchecked Sendable {
        let `protocol`: LinkURLProtocol

        func received(_ response: HTTPURLResponse) {
            `protocol`.client?.urlProtocol(`protocol`, didReceive: response, cacheStoragePolicy: .notAllowed)
        }

        func loaded(_ data: Data) { `protocol`.client?.urlProtocol(`protocol`, didLoad: data) }
        func finished() { `protocol`.client?.urlProtocolDidFinishLoading(`protocol`) }
        func failed(_ error: Error) { `protocol`.client?.urlProtocol(`protocol`, didFailWithError: error) }
    }

    /// URLSession hands a custom protocol the body as a stream.
    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }

    /// Which client a session's requests go through. URLProtocol is made by URLSession, so it
    /// finds its client by a header the configuration adds.
    private struct Route: Sendable {
        static let header = "X-Kuvo-Link-Route"
        nonisolated(unsafe) private static var routes: [String: Route] = [:]
        private static let lock = NSLock()

        let client: LinkClient
        let hosts: @Sendable () -> [PairedHost]

        static func register(client: LinkClient, hosts: @escaping @Sendable () -> [PairedHost]) -> String {
            let id = UUID().uuidString
            lock.withLock { routes[id] = Route(client: client, hosts: hosts) }
            return id
        }

        static func unregister(_ id: String) {
            lock.withLock { routes[id] = nil }
        }

        static func find(_ id: String) -> Route? {
            lock.withLock { routes[id] }
        }
    }
}
