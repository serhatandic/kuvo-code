import CryptoKit
import Foundation
import KuvoLink
import Network
import OpenCodeKit
import os
import Testing
@testable import KuvoCode

/// What a phone asks of this Mac's own routes and its engine, as this Mac's box hands it the app
/// (KuvoLink's PROTOCOL.md, "Host interface", `link/route`): a phone that goes stops what it asked,
/// even before any answer; a long answer streams on with the window busy, never waiting on it; and
/// one cut off partway reaches the box cut off, never as if it were whole. Over real HTTP, with the
/// engine a stand-in on a port of its own.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneHostStreamTests {
    let host = HostInterface()
    let link = PhoneLink(file: AppInfo.testRoot.appending(path: "PhoneHostStream/\(UUID().uuidString).json"), identity: (LinkKey(), RelaySecret()))

    init() { TestEnvironment.prepare() }

    /// What the engine stand-in saw: asked, and stopped (its asker went).
    nonisolated final class Seen: Sendable {
        private let state = OSAllocatedUnfairLock(initialState: (asked: false, stopped: false))
        var asked: Bool { state.withLock { $0.asked } }
        var stopped: Bool { state.withLock { $0.stopped } }
        func ask() { state.withLock { $0.asked = true }; TestPulse.beat() }
        func stop() { state.withLock { $0.stopped = true }; TestPulse.beat() }
    }

    /// An engine answering with `respond`, and the app's host reaching it as this Mac's engine.
    private func engine(_ respond: @escaping (HTTPRequest) async -> HTTPResponse) async throws -> (engine: LoopbackServer, host: [String: String]) {
        let engine = LoopbackServer(respond: respond)
        let port = try await engine.start()
        StubWeb.letThrough(port: Int(port))
        link.start(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:\(port)/")!, password: "test"))
        host.phoneLink = link
        let environment = try await host.start()
        StubWeb.letThrough(port: URL(string: environment["KUVO_HOST_URL"] ?? "")?.port ?? 0)
        return (engine, environment)
    }

    private func done(_ engine: LoopbackServer) {
        link.stop()
        host.stop()
        engine.stop()
    }

    /// As this Mac's box asks its app for what a phone asked.
    private func asked(_ path: String, at environment: [String: String]) throws -> URLRequest {
        let base = try #require(environment["KUVO_HOST_URL"]), password = try #require(environment["KUVO_HOST_PASSWORD"])
        var request = URLRequest(url: try #require(URL(string: base + "/link/route")))
        request.httpMethod = "POST"
        request.setValue("Bearer \(password)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["method": "GET", "path": path, "headers": [:], "body": "", "phone": LinkKey().publicBytes.base64URL])
        return request
    }

    @Test func aPhoneThatGoesStopsWhatItAskedBeforeAnyAnswer() async throws {
        let seen = Seen()
        let (engine, environment) = try await engine { _ in
            seen.ask()
            // An answer that takes as long as it takes.
            let (wait, end) = AsyncStream<Void>.makeStream()
            await withTaskCancellationHandler {
                for await _ in wait {}
            } onCancel: {
                seen.stop()
                end.finish()
            }
            return HTTPResponse(status: 200)
        }
        defer { done(engine) }
        let request = try asked("api/session/ses_1/diff", at: environment)
        let asking = Task.detached { _ = try? await URLSession(configuration: .ephemeral).data(for: request) }
        try await until { seen.asked }
        // The phone goes, and the box with it.
        asking.cancel()
        try await until { seen.stopped }
    }

    /// The engine's events, streamed to a phone while the window is too busy to do anything:
    /// they still come.
    @Test func aStreamToAPhoneNeverWaitsOnTheWindow() async throws {
        let (events, sending) = AsyncThrowingStream<Data, Error>.makeStream()
        let (engine, environment) = try await engine { _ in
            HTTPResponse(status: 200, headers: ["Content-Type": "text/event-stream"], stream: events)
        }
        defer {
            sending.finish()
            done(engine)
        }
        let request = try asked("api/event", at: environment)
        let lines = OSAllocatedUnfairLock<[String]>(initialState: [])
        let third = DispatchSemaphore(value: 0)
        let reading = Task.detached {
            let (bytes, _) = try await URLSession(configuration: .ephemeral).bytes(for: request)
            for try await line in bytes.lines where !line.isEmpty {
                let count = lines.withLock { $0.append(line); return $0.count }
                TestPulse.beat()
                if count == 3 { third.signal() }
            }
        }
        defer { reading.cancel() }
        sending.yield(Data("data: 1\n\n".utf8))
        try await until { lines.withLock { $0.count } == 1 }
        // The window busy (the main thread taken) while two more come.
        let feeding = Task.detached {
            sending.yield(Data("data: 2\n\n".utf8))
            sending.yield(Data("data: 3\n\n".utf8))
        }
        let came = busyWindow(until: third)
        await feeding.value
        #expect(came == .success, "the stream waited on the main thread")
        #expect(lines.withLock { $0 } == ["data: 1", "data: 2", "data: 3"])
    }

    /// The main thread taken until `done`, on purpose: that's what the test measures. The wait is
    /// bounded because it can't be on an event (main is the thing held), and unbounded, a stream
    /// that needs main would hang the whole run past the suite's time limit instead of failing.
    private func busyWindow(until done: DispatchSemaphore) -> DispatchTimeoutResult {
        done.wait(timeout: .now() + 20)
    }

    /// An answer the engine cut off partway reaches the box cut off, so it tells the phone so,
    /// rather than handing it half an answer as if it were whole. Read as the box reads it: with
    /// Node's fetch. (The app's own streamed answers end the same way when they fail.)
    @Test func anAnswerCutOffReachesTheBoxCutOff() async throws {
        let node = try #require(TestBox.node, "Node reads it, as the box does")
        // A streamed answer of the app's own that fails partway.
        let own = LoopbackServer { _ in
            let (body, sending) = AsyncThrowingStream<Data, Error>.makeStream()
            sending.yield(Data(#"{"data":[{"id":"ses_1"},"#.utf8))
            sending.finish(throwing: URLError(.networkConnectionLost))
            return HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], stream: body)
        }
        let ownPort = try await own.start()
        defer { own.stop() }
        #expect(try await Self.nodeReads(node, URLRequest(url: URL(string: "http://127.0.0.1:\(ownPort)/")!)) == "cut off")
        // The engine, gone halfway through an answer: a phone's, through the app.
        let engine = try await RawEngine.start(answering: "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{\"data\":[{\"id\":\"ses_1\"},")
        defer { engine.stop() }
        StubWeb.letThrough(port: Int(engine.port))
        link.start(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:\(engine.port)/")!, password: "test"))
        host.phoneLink = link
        let environment = try await host.start()
        defer {
            link.stop()
            host.stop()
        }
        let throughHost = try await Self.nodeReads(node, try asked("api/session", at: environment))
        #expect(throughHost == "cut off", "through the app: \(throughHost)")
    }

    /// A streamed answer that ends whole (its last chunk) leaves its connection open for the next
    /// request, as HTTP/1.1 has it: URLSession and Node's fetch both send their next request on it,
    /// and one closed under them is lost (a POST isn't sent again), as the box's next call to the
    /// app would be.
    @Test func theNextRequestOnAConnectionIsAnsweredAfterAStreamedOne() async throws {
        let server = LoopbackServer { request in
            guard request.path == "/streamed" else { return .json(["next": true]) }
            let (body, sending) = AsyncThrowingStream<Data, Error>.makeStream()
            sending.yield(Data("{}\n".utf8))
            sending.finish()
            return HTTPResponse(status: 200, headers: ["Content-Type": "application/x-ndjson"], stream: body)
        }
        let port = try await server.start()
        defer { server.stop() }
        let client = try await RawClient.connect(port: port)
        defer { client.close() }
        await client.send("POST /streamed HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n")
        #expect(await client.read(through: "\r\n0\r\n\r\n").hasPrefix("HTTP/1.1 200"))
        await client.send("POST /next HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n")
        let next = await client.read(through: #"{"next":true}"#)
        #expect(next.hasPrefix("HTTP/1.1 200"), "the connection was closed after the streamed answer: \(next.debugDescription)")
    }

    /// What Node's fetch makes of `request`'s answer: "whole: <text>", or "cut off".
    private nonisolated static func nodeReads(_ node: URL, _ request: URLRequest) async throws -> String {
        let script = """
            const headers = JSON.parse(process.env.HEADERS);
            fetch(process.env.URL, { method: process.env.METHOD, headers, body: process.env.METHOD === "GET" ? undefined : process.env.BODY })
              .then(response => response.text().then(text => "whole: " + response.status + " " + text))
              .then(said => console.log(said), error => console.log("cut off"));
            """
        let process = Process()
        process.executableURL = node
        process.arguments = ["-e", script]
        process.environment = [
            "URL": request.url?.absoluteString ?? "", "METHOD": request.httpMethod ?? "GET",
            "HEADERS": String(decoding: try JSONSerialization.data(withJSONObject: request.allHTTPHeaderFields ?? [:]), as: UTF8.self),
            "BODY": String(decoding: request.httpBody ?? Data(), as: UTF8.self),
        ]
        let output = Pipe()
        process.standardOutput = output
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            process.terminationHandler = { _ in done.resume() }
            do { try process.run() } catch { done.resume(throwing: error) }
        }
        return String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// One HTTP/1.1 connection, written and read as bytes: what a client that keeps its connection
/// sends on it, in order.
@MainActor
final class RawClient {
    private let connection: NWConnection
    /// What came past what was read so far.
    private var pending = Data()

    private init(connection: NWConnection) {
        self.connection = connection
    }

    static func connect(port: UInt16) async throws -> RawClient {
        let connection = NWConnection(host: .ipv4(.loopback), port: try #require(NWEndpoint.Port(rawValue: port)), using: .tcp)
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            let once = OSAllocatedUnfairLock(initialState: false)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: if !once.withLock({ let was = $0; $0 = true; return was }) { done.resume() }
                case .failed(let error): if !once.withLock({ let was = $0; $0 = true; return was }) { done.resume(throwing: error) }
                default: break
                }
            }
            connection.start(queue: .main)
        }
        return RawClient(connection: connection)
    }

    func send(_ text: String) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in done.resume() })
        }
    }

    /// What comes, up to and including `marker`; or, once the other side has closed, all there was.
    func read(through marker: String) async -> String {
        let marker = Data(marker.utf8)
        while true {
            if let found = pending.range(of: marker) {
                let read = pending[..<found.upperBound]
                pending.removeSubrange(..<found.upperBound)
                return String(decoding: read, as: UTF8.self)
            }
            let (data, ended) = await withCheckedContinuation { (done: CheckedContinuation<(Data?, Bool), Never>) in
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                    done.resume(returning: (data, complete || error != nil))
                }
            }
            if let data { pending.append(data) }
            if ended, pending.range(of: marker) == nil {
                defer { pending = Data() }
                return String(decoding: pending, as: UTF8.self)
            }
        }
    }

    func close() { connection.cancel() }
}

/// An engine that answers each request with `answer`'s bytes as they are, then closes: one cut off
/// partway, say.
nonisolated final class RawEngine: Sendable {
    private let listener: NWListener
    let port: UInt16

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
    }

    static func start(answering answer: String) async throws -> RawEngine {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "raw-engine")
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                connection.send(content: Data(answer.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { done in
            let once = OSAllocatedUnfairLock(initialState: false)
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: if !once.withLock({ let was = $0; $0 = true; return was }) { done.resume(returning: listener.port?.rawValue ?? 0) }
                case .failed(let error): if !once.withLock({ let was = $0; $0 = true; return was }) { done.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
        return RawEngine(listener: listener, port: port)
    }

    func stop() { listener.cancel() }
}
