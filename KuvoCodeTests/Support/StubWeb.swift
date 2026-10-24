import Foundation

/// Answers for web services the app calls (GitHub's API, its raw files), so tests never reach the
/// network: each test registers what an address answers, and addresses it didn't register answer
/// 404. Only the hosts given are stubbed; the app's other requests go out as they would.
nonisolated final class StubWeb: URLProtocol, @unchecked Sendable {
    struct Answer: Sendable {
        var status = 200
        var body = Data()
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var answers: [String: Answer] = [:]
    /// Answers by address without its query, worked out from the request (its query, a page).
    nonisolated(unsafe) private static var routes: [String: @Sendable (URLComponents) -> Answer] = [:]
    /// Answers by address without its query, from the whole request (what it sends), ahead of
    /// `routes`.
    nonisolated(unsafe) private static var requestRoutes: [String: @Sendable (URLRequest, Data) -> Answer] = [:]
    /// Answers for every address under a prefix, from the whole request (its method and body).
    nonisolated(unsafe) private static var handlers: [(prefix: String, answer: @Sendable (URLRequest, Data) -> Answer)] = []
    nonisolated(unsafe) private static var hosts: Set<String> = []
    /// Whether an address on those hosts that nothing here answers for goes out as it is, to a
    /// real server a test started (the agents bridge), rather than answering 404.
    nonisolated(unsafe) private static var real = false
    nonisolated(unsafe) private(set) static var asked: [String] = []

    /// Starts answering for `hosts`, with nothing registered yet.
    static func start(hosts: Set<String>) {
        lock.withLock {
            answers = [:]
            routes = [:]
            requestRoutes = [:]
            handlers = []
            asked = []
            real = false
            realPorts = []
            Self.hosts = hosts
        }
        URLProtocol.registerClass(StubWeb.self)
    }

    /// From now on, what nothing here answers for reaches the real server at its address.
    static func letUnansweredThrough() {
        lock.withLock { real = true }
    }

    static func stop() {
        URLProtocol.unregisterClass(StubWeb.self)
        lock.withLock { hosts = [] }
    }

    static func answer(_ url: String, status: Int = 200, json: Any) throws {
        let body = try JSONSerialization.data(withJSONObject: json)
        lock.withLock { answers[url] = Answer(status: status, body: body) }
    }

    static func answer(_ url: String, status: Int = 200, text: String) {
        lock.withLock { answers[url] = Answer(status: status, body: Data(text.utf8)) }
    }

    /// Answers requests to `url` (any query) with what `answer` makes of each.
    static func route(_ url: String, _ answer: @escaping @Sendable (URLComponents) -> Answer) {
        lock.withLock { routes[url] = answer }
    }

    /// Answers requests to `url` (any query) with what `answer` makes of each and what it sends.
    static func route(_ url: String, sent answer: @escaping @Sendable (URLRequest, Data) -> Answer) {
        lock.withLock { requestRoutes[url] = answer }
    }

    /// Answers every request to an address starting with `prefix` with what `answer` makes of it.
    static func handle(_ prefix: String, _ answer: @escaping @Sendable (URLRequest, Data) -> Answer) {
        lock.withLock { handlers.append((prefix, answer)) }
    }

    static func json(_ value: Any, status: Int = 200) -> Answer {
        Answer(status: status, body: (try? JSONSerialization.data(withJSONObject: value)) ?? Data())
    }

    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url, let host = url.host() else { return false }
        return lock.withLock {
            guard hosts.contains(host), !realPorts.contains(url.port ?? 0) else { return false }
            guard real else { return true }
            var bare = URLComponents(url: url, resolvingAgainstBaseURL: false)
            bare?.query = nil
            let address = bare?.string ?? ""
            return answers[url.absoluteString] != nil || routes[address] != nil || requestRoutes[address] != nil
                || handlers.contains { url.absoluteString.hasPrefix($0.prefix) }
        }
    }

    /// Ports a real server listens on (this Mac's box, run with Node): what's sent there goes
    /// there, not here.
    nonisolated(unsafe) private static var realPorts: Set<Int> = []

    static func letThrough(port: Int) {
        lock.withLock { _ = realPorts.insert(port) }
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    /// What's set up to answer `request`, sending `body`: in this process, or from another one
    /// through a port it listens on (`listen`).
    static func answer(for request: URLRequest, body: Data) -> Answer {
        let url = request.url!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var bare = components
        bare.query = nil
        let (route, requestRoute) = lock.withLock {
            asked.append(url.absoluteString)
            return (routes[bare.string ?? ""], requestRoutes[bare.string ?? ""])
        }
        let handler = lock.withLock { handlers.first { url.absoluteString.hasPrefix($0.prefix) }?.answer }
        let answer = lock.withLock { answers[url.absoluteString] } ?? requestRoute?(request, body)
            ?? route?(components) ?? handler?(request, body) ?? Answer(status: 404)
        // Answered: what a test's answer noted on its way is there for a wait to see (`until`).
        TestPulse.beat()
        return answer
    }

    override func startLoading() {
        let url = request.url!
        let answer = Self.answer(for: request, body: Self.body(of: request))
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// What a request sends: its body, or what its stream gives (as URLSession hands it on).
    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
