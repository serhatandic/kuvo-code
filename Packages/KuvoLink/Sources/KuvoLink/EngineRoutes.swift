import Foundation

/// What a phone may ask an engine for, and passing it on: the Mac's side of what a machine's
/// bridge does in `kuvo-link.js` (the two lists are checked against `Vectors/link.json`).
public enum EngineRoutes {
    /// A paired phone is yours: the engine's whole API, as the app has it (sessions, files,
    /// terminals, commands, accounts and keys, settings, MCP servers). Only a path that isn't what
    /// it seems (`canonical` refuses it) is refused.
    public static func allows(_ path: String, method: String = "GET") -> Bool {
        canonical(path)?.prefixMatch(of: #/api(/|\?|$)/#) != nil
    }

    /// The same of a coding agents' bridge, but for the two routes only the app wires things with:
    /// where the engine is, and its group chats' own steps (moves), which a phone does through
    /// `kuvo/groups`. Checked on the path as it's sent, which the bridge reads part by part.
    public static func allowsAgents(_ path: String, method: String = "GET") -> Bool {
        guard let sent = canonical(path) else { return false }
        return sent.prefixMatch(of: #/api(/|\?|$)/#) != nil && sent.prefixMatch(of: #/api/kuvo/(engine|groups)(/|\?|$)/#) == nil
    }

    /// `path` written one way only, which is both what's checked and what's sent, or nil when it
    /// isn't what it seems. Each part between slashes, and each name and value in its query, is
    /// percent-decoded once (`decoded`) and encoded again the same way; empty parts are left out.
    /// Also refused: a fragment (`#`, which isn't sent) or a space at either end, which a phone
    /// never sends; a part between slashes that holds a slash, or is "." or ".."; a name or value
    /// in the query with a ".." between its slashes. ("%2e%2e" is "..", and so is ".\u{200D}.":
    /// only what's ASCII counts, so a mark or joiner hides neither; "[...slug]" is a name.) As
    /// `canonicalPath` in kuvo-link.js.
    public static func canonical(_ path: String) -> String? {
        // In bytes, never characters, where a mark after a "/" or "?" hides it.
        let bytes = Array(path.utf8)
        guard !bytes.contains(UInt8(ascii: "#")), bytes.first != UInt8(ascii: " "), bytes.last != UInt8(ascii: " ") else { return nil }
        let mark = bytes.firstIndex(of: UInt8(ascii: "?")) ?? bytes.endIndex
        var parts: [String] = []
        for raw in bytes[..<mark].split(separator: UInt8(ascii: "/")) {
            guard let part = decoded(raw), !part.unicodeScalars.contains("/"), ![".", ".."].contains(ascii(part.unicodeScalars)),
                  let written = part.addingPercentEncoding(withAllowedCharacters: pathCharacters) else { return nil }
            parts.append(written)
        }
        // A "+" in a query is a space.
        let query = bytes[min(mark + 1, bytes.endIndex)...].map { $0 == UInt8(ascii: "+") ? UInt8(ascii: " ") : $0 }
        var fields: [String] = []
        for raw in query.split(separator: UInt8(ascii: "&")) {
            var halves: [String] = []
            for half in raw.split(separator: UInt8(ascii: "="), maxSplits: 1, omittingEmptySubsequences: false) {
                guard let text = decoded(half), !text.unicodeScalars.split(separator: "/").contains(where: { ascii($0) == ".." }),
                      let written = text.addingPercentEncoding(withAllowedCharacters: queryCharacters) else { return nil }
                halves.append(written)
            }
            fields.append(halves.joined(separator: "="))
        }
        return parts.joined(separator: "/") + (fields.isEmpty ? "" : "?" + fields.joined(separator: "&"))
    }

    /// Percent-decoded once, or nil when it doesn't decode or holds a backslash or a control
    /// character. "%252e" is a name with "%2e" in it, which is how the engine reads it too.
    private static func decoded(_ raw: some Collection<UInt8>) -> String? {
        guard let text = String(decoding: Array(raw), as: UTF8.self).removingPercentEncoding,
              !text.utf8.contains(where: { $0 < 0x20 || $0 == 0x7f || $0 == UInt8(ascii: "\\") }) else { return nil }
        return text
    }

    /// Its ASCII only.
    private static func ascii(_ scalars: some Sequence<Unicode.Scalar>) -> String {
        String(String.UnicodeScalarView(scalars.filter(\.isASCII)))
    }

    /// What's written as it is (RFC 3986's): letters, digits and `-._~`; between slashes
    /// `!$&'()*+,;=:@` too, and in a query `!$()*,;:@/?` (not `'`, which URL parsers encode there,
    /// nor `&`, `=` or `+`, which a query splits on or reads as a space). Anything else is encoded.
    private static let plain = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    private static let pathCharacters = CharacterSet(charactersIn: plain + "!$&'()*+,;=:@")
    private static let queryCharacters = CharacterSet(charactersIn: plain + "!$()*,;:@/?")

    /// Where a sign-in's page sent the browser back to the computer, for the computer to load
    /// (`kuvo/sign-in/return`): only its own address (127.0.0.1, localhost, [::1]) over http, at a
    /// port, with what the page sent back (a query), written plainly, in the characters an address
    /// may hold as it is (so it's loaded exactly as written, never encoded again). What's loaded
    /// is the address without its fragment, which a browser doesn't send; nil for anything else.
    public static func signInReturn(_ url: String) -> URL? {
        guard url.utf8.count <= 8192, url.unicodeScalars.allSatisfy({ ("!"..."~").contains($0) && $0 != "\\" }),
              let match = url.wholeMatch(of: #/(http://(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})(?:/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*)?\?(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})+)(?:#.*)?/#),
              let port = Int(match.2), port <= 65535 else { return nil }
        return URL(string: String(match.1), encodingInvalidCharacters: false)
    }

    /// The sockets a phone may open: a terminal's.
    public static func allowsSocket(_ path: String) -> Bool {
        canonical(path)?.prefixMatch(of: #/api/pty/[^/?]+/connect(\?|$)/#) != nil
    }

    static let requestHeaders = ["content-type", "accept", "x-opencode-directory", "last-event-id"]
    static let responseHeaders = ["content-type", "cache-control"]

    /// Opens the socket `request` names on the engine at `base` (its password added here): text
    /// from `input` goes to it, and what it sends comes back, `.open` first.
    public static func connect(_ request: LinkRequest, to base: URL, password: String?, input: AsyncStream<Data>) -> AsyncThrowingStream<LinkSocketEvent, Error> {
        AsyncThrowingStream { continuation in
            guard allowsSocket(request.path), let path = canonical(request.path), let url = URL(string: path, relativeTo: base),
                  var components = URLComponents(url: url.absoluteURL, resolvingAgainstBaseURL: false)
            else { return continuation.finish(throwing: URLError(.badURL)) }
            components.scheme = components.scheme == "https" ? "wss" : "ws"
            guard let socketURL = components.url else { return continuation.finish(throwing: URLError(.badURL)) }
            var outgoing = URLRequest(url: socketURL)
            if let directory = request.headers["x-opencode-directory"] { outgoing.setValue(directory, forHTTPHeaderField: "x-opencode-directory") }
            if let password { outgoing.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
            // A session of its own, to hear when the socket's open.
            let watcher = SocketWatcher()
            let session = URLSession(configuration: .ephemeral, delegate: watcher, delegateQueue: nil)
            let socket = session.webSocketTask(with: outgoing)
            socket.resume()
            let reading = Task {
                do {
                    try await watcher.opened()
                    continuation.yield(.open)
                    while true {
                        switch try await socket.receive() {
                        case .string(let text): continuation.yield(.text(Data(text.utf8)))
                        case .data(let data): continuation.yield(.binary(data))
                        @unknown default: break
                        }
                    }
                } catch {
                    // Closed by the engine (the shell exited): the end, not a failure.
                    if socket.closeCode != .invalid { continuation.finish() } else { continuation.finish(throwing: error) }
                }
            }
            let writing = Task {
                for await text in input {
                    try? await socket.send(.string(String(decoding: text, as: UTF8.self)))
                }
                socket.cancel(with: .normalClosure, reason: nil)
            }
            continuation.onTermination = { _ in
                reading.cancel()
                writing.cancel()
                socket.cancel(with: .goingAway, reason: nil)
                session.finishTasksAndInvalidate()
            }
        }
    }

    /// Passes `request` to the engine at `base` (its password added here), and its response back
    /// in pieces as they come: an event stream's events one by one. What's sent is the path as
    /// `canonical` writes it, which is what `allowing` checks.
    /// `adding`: headers of the Mac's own, after what the client sent was taken (which can't set them).
    public static func forward(_ request: LinkRequest, to base: URL, password: String?, session: URLSession = .shared, adding: [String: String] = [:],
                               allowing: @Sendable (String, String) -> Bool = { allows($0, method: $1) }) -> AsyncThrowingStream<LinkResponsePart, Error> {
        AsyncThrowingStream { continuation in
            guard let path = canonical(request.path), allowing(path, request.method) else {
                continuation.yield(.head(status: 403, headers: ["content-type": "text/plain"]))
                continuation.yield(.body(Data("That isn’t available over the link.".utf8)))
                continuation.finish()
                return
            }
            let task = Task {
                do {
                    guard let url = URL(string: path, relativeTo: base) else { throw URLError(.badURL) }
                    var outgoing = URLRequest(url: url)
                    let method = request.method.uppercased()
                    outgoing.httpMethod = method
                    outgoing.timeoutInterval = .infinity
                    let given = Dictionary(request.headers.map { ($0.key.lowercased(), $0.value) }) { first, _ in first }
                    for name in requestHeaders { if let value = given[name] { outgoing.setValue(value, forHTTPHeaderField: name) } }
                    for (name, value) in adding { outgoing.setValue(value, forHTTPHeaderField: name) }
                    if let password { outgoing.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
                    if method != "GET", method != "HEAD" { outgoing.httpBody = request.body }

                    let (bytes, response) = try await session.bytes(for: outgoing)
                    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                    var headers: [String: String] = [:]
                    for name in responseHeaders { if let value = http.value(forHTTPHeaderField: name) { headers[name] = value } }
                    continuation.yield(.head(status: http.statusCode, headers: headers))
                    // In pieces: at each event's end (a blank line; a line, for a box's stream of
                    // JSON lines), so an event goes as soon as it's whole and each costs the relay
                    // one message, or every 32 KB of a long body.
                    let lines = headers["content-type"]?.hasPrefix("application/x-ndjson") == true
                    var piece = Data()
                    piece.reserveCapacity(32 * 1024)
                    var previous: UInt8 = 0
                    for try await byte in bytes {
                        piece.append(byte)
                        defer { previous = byte }
                        if (byte == UInt8(ascii: "\n") && (lines || previous == UInt8(ascii: "\n"))) || piece.count >= 32 * 1024 {
                            continuation.yield(.body(piece))
                            piece.removeAll(keepingCapacity: true)
                        }
                    }
                    if !piece.isEmpty { continuation.yield(.body(piece)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Says when a WebSocket task opens, or that it never will.
private final class SocketWatcher: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var outcome: Result<Void, Error>?
    private var waiting: CheckedContinuation<Void, Error>?

    func opened() async throws {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock {
                if let outcome { continuation.resume(with: outcome) } else { waiting = continuation }
            }
        }
    }

    private func settle(_ result: Result<Void, Error>) {
        lock.withLock {
            guard outcome == nil else { return }
            outcome = result
            waiting?.resume(with: result)
            waiting = nil
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        settle(.success(()))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        settle(.failure(error ?? URLError(.networkConnectionLost)))
    }
}
