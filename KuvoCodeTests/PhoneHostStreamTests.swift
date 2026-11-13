import CryptoKit
import Foundation
import KuvoLink
import Network
import Observation
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

    /// The keeper's host, as it runs this Mac's box with the app open: told where the app answers.
    private func keeper(of app: HostInterface) async throws -> (host: HostInterface, environment: [String: String]) {
        let keeper = HostInterface()
        keeper.appAnswers = false
        keeper.useApp(try #require(app.address))
        let environment = try await keeper.start()
        StubWeb.letThrough(port: URL(string: environment["KUVO_HOST_URL"] ?? "")?.port ?? 0)
        return (keeper, environment)
    }

    /// With the keeper running this Mac's box, what a phone asks of the Mac's own routes goes to the
    /// keeper's host and on to the open app. The box takes an answer only when it says it's the
    /// app's (anything else is "the app isn't answering", a 503, and the phone waits for ever): it
    /// has to say so through the keeper too, a real 404 and a followed route's lines with it.
    @Test func withTheKeeperRunningTheBoxTheAppsAnswersStillReachAPhone() async throws {
        let (engine, _) = try await engine { _ in HTTPResponse(status: 200) }
        defer { done(engine) }
        let keeper = try await keeper(of: host)
        defer { keeper.host.stop() }

        let session = URLSession(configuration: .ephemeral)
        let (lines, followed) = try await session.bytes(for: try asked("kuvo/asks/events", at: keeper.environment))
        let answer = try #require(followed as? HTTPURLResponse)
        #expect(answer.statusCode == 200)
        #expect(answer.value(forHTTPHeaderField: "X-Kuvo-Answer") == "1", "the box would turn this away as the app not answering")
        var first: String?
        for try await line in lines.lines {
            first = line
            break
        }
        #expect(try JSONSerialization.jsonObject(with: Data(try #require(first).utf8)) is [String: Any])

        // A real 404 is the app's too (no usage to read in this test copy).
        let (_, read) = try await session.data(for: try asked("kuvo/usage", at: keeper.environment))
        let missing = try #require(read as? HTTPURLResponse)
        #expect(missing.statusCode == 404)
        #expect(missing.value(forHTTPHeaderField: "X-Kuvo-Answer") == "1")

        // The app quit: the keeper answers itself, and doesn't say it's the app's.
        keeper.host.useApp([:])
        let (_, away) = try await session.data(for: try asked("kuvo/usage", at: keeper.environment))
        let closed = try #require(away as? HTTPURLResponse)
        #expect(closed.statusCode == 503)
        #expect(closed.value(forHTTPHeaderField: "X-Kuvo-Answer") == nil)
    }

    /// The usage panel, as UsageKit's reads: nothing until it's up, and observed, as it is.
    @Observable final class Panel {
        var report: Data?
    }

    /// A phone that asks while the panel is still coming up (the app just started) isn't told
    /// there's no usage, which it would believe until it next opened: its stream stays open, and
    /// the report comes down it as soon as the panel is up, and again as it changes.
    @Test func thePanelComingUpLateReachesAPhoneThatAskedBefore() async throws {
        let (engine, _) = try await engine { _ in HTTPResponse(status: 200) }
        defer { done(engine) }
        let panel = Panel()
        link.usagePanel = { panel.report }
        let keeper = try await keeper(of: host)
        defer { keeper.host.stop() }

        let request = try asked("kuvo/usage/events", at: keeper.environment)
        let seen = OSAllocatedUnfairLock<(status: Int?, answer: String?, lines: [String])>(initialState: (nil, nil, []))
        let reading = Task.detached {
            let (bytes, response) = try await URLSession(configuration: .ephemeral).bytes(for: request)
            let http = response as? HTTPURLResponse
            seen.withLock { $0.status = http?.statusCode; $0.answer = http?.value(forHTTPHeaderField: "X-Kuvo-Answer") }
            TestPulse.beat()
            for try await line in bytes.lines where !line.isEmpty {
                seen.withLock { $0.lines.append(line) }
                TestPulse.beat()
            }
        }
        defer { reading.cancel() }
        try await until { seen.withLock { $0.status != nil } }
        #expect(seen.withLock { $0.status } == 200)
        #expect(seen.withLock { $0.answer } == "1")
        #expect(seen.withLock { $0.lines }.isEmpty)

        panel.report = Data(#"{"providers":[],"refreshing":false}"#.utf8)
        try await until { seen.withLock { $0.lines.count == 1 } }
        panel.report = Data(#"{"providers":[],"refreshing":true}"#.utf8)
        try await until { seen.withLock { $0.lines.count == 2 } }
        #expect(seen.withLock { $0.lines.last } == #"{"providers":[],"refreshing":true}"#)
    }

    /// What the real box's code (`macFront`, in `kuvo-link.js`, on Node) gives a phone asking
    /// `path`, as it comes: first its status, then each piece of the answer as a JSON string. (What
    /// it says if it can't load shows here too.)
    private final class AskedOfTheBox: @unchecked Sendable {
        let process = Process()
        let said = OSAllocatedUnfairLock<[String]>(initialState: [])

        /// `home`: this Mac's box's own folder, rather than one of the test's.
        init(_ path: String, keeper environment: [String: String], home: URL? = nil) throws {
            guard let node = TestBox.node else { throw TestFailure("Node runs the box's code in the tests, and there's none.") }
            let folder = AppInfo.testRoot.appending(path: "PhoneHostStream/box-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            process.executableURL = node
            process.arguments = ["--input-type=module", "-e", """
                import { pathToFileURL } from "node:url";
                const { macFront } = await import(pathToFileURL(\(String(reflecting: try #require(Bridge.scriptURL).path))).href);
                for await (const piece of macFront()({ method: "GET", path: \(String(reflecting: path)), headers: {}, body: null }, { key: Buffer.alloc(32) })) {
                  console.log(piece.head ? piece.head.status : JSON.stringify(Buffer.from(piece.body).toString()));
                }
                """]
            process.environment = environment.merging(["KUVO_HOME": (home ?? folder).path, "KUVO_BOX": "mac", "KUVO_BOTS": folder.appending(path: "bots").path,
                                                       "KUVO_WAKES": folder.appending(path: "wakes").path, "KUVO_ENGINE_CONFIG": folder.appending(path: "opencode").path,
                                                       "KUVO_KEYS": folder.appending(path: "keys").path]) { given, _ in given }
            let out = Pipe()
            process.standardOutput = out
            process.standardError = out
            try process.run()
            Task.detached { [said] in
                for try await line in out.fileHandleForReading.bytes.lines {
                    said.withLock { $0.append(line) }
                    TestPulse.beat()
                }
                TestPulse.beat()
            }
        }

        func stop() { process.terminate() }
    }

    /// The whole way from the box to the usage panel, with the keeper running the box: Kuvo Code
    /// closed, the box tells a phone it isn't answering (503, which a phone asks again after); open
    /// with the panel still coming up, the stream is open and says nothing; and with the panel up,
    /// the report comes down it, so the phone's gauge is back with nothing restarted.
    @Test func theRealBoxGivesAPhoneTheUsageAsTheAppComesAndThePanelComesUp() async throws {
        let (engine, _) = try await engine { _ in HTTPResponse(status: 200) }
        defer { done(engine) }
        let panel = Panel()
        link.usagePanel = { panel.report }
        let address = try #require(host.address)
        let keeper = try await keeper(of: host)
        defer { keeper.host.stop() }

        keeper.host.useApp([:])
        let closed = try AskedOfTheBox("kuvo/usage/events", keeper: keeper.environment)
        defer { closed.stop() }
        try await until { !closed.said.withLock { $0 }.isEmpty }
        #expect(closed.said.withLock { $0.first } == "503")

        keeper.host.useApp(address)
        let opened = try AskedOfTheBox("kuvo/usage/events", keeper: keeper.environment)
        defer { opened.stop() }
        // At once, with the panel not up: an empty line, or what's on the way holds the head back.
        try await until { opened.said.withLock { $0.count >= 2 } }
        #expect(opened.said.withLock { $0 } == ["200", #""\n""#])

        panel.report = Data(#"{"providers":[],"refreshing":false}"#.utf8)
        try await until { opened.said.withLock { $0.count >= 3 } }
        #expect(opened.said.withLock { $0.last } == #""{\"providers\":[],\"refreshing\":false}\n""#)
    }

    /// From what the app keeps to a phone, the real thing at both ends: machines only in the settings,
    /// as an update first finds them, moved as the keeper moves them (`Keeper.start`, which no test
    /// runs), and with the app closed the box reads them from where it runs, for a phone.
    @Test func machinesInTheSettingsReachAPhoneThroughTheRealBoxWithTheAppClosed() async throws {
        let (engine, _) = try await engine { _ in HTTPResponse(status: 200) }
        defer {
            done(engine)
            UserDefaults.standard.removeObject(forKey: "machines")
            try? FileManager.default.removeItem(at: Machines.file)
        }
        let keeper = try await keeper(of: host)
        defer { keeper.host.stop() }
        keeper.host.useApp([:])
        UserDefaults.standard.set(try JSONEncoder().encode([Machine(destination: "lab", otherAddresses: ["lab.tail"], identity: "a", reachedAt: "lab.tail")]), forKey: "machines")
        Machines.moveFromSettings()

        let closed = try AskedOfTheBox("kuvo/machines", keeper: keeper.environment, home: BoxProcess.home)
        defer { closed.stop() }
        try await until { closed.said.withLock { $0.count >= 2 } }
        let said = closed.said.withLock { $0 }
        #expect(said.first == "200")
        let text = try #require(try JSONSerialization.jsonObject(with: Data(said[1].utf8), options: .fragmentsAllowed) as? String)
        let listed = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])["machines"] as? [[String: Any]]
        #expect(listed?.map { $0["id"] as? String } == ["lab"])
        #expect(listed?.first?["otherAddresses"] as? [String] == ["lab.tail"])
        #expect(listed?.first?["status"] as? String == "Kuvo Code isn’t open on this Mac")
    }

    /// Each stream a phone follows through the keeper holds a connection to the app: two phones'
    /// worth of them, and the next thing a phone asks is still answered, not left waiting behind them.
    @Test func manyFollowedStreamsDontHoldUpTheNextRequest() async throws {
        let (engine, _) = try await engine { _ in HTTPResponse(status: 200) }
        defer { done(engine) }
        let keeper = try await keeper(of: host)
        defer { keeper.host.stop() }

        var streams: [(URLSession, URLSession.AsyncBytes)] = []
        defer { for (session, _) in streams { session.invalidateAndCancel() } }
        for _ in 0..<8 {
            let session = URLSession(configuration: .ephemeral)
            let (bytes, _) = try await session.bytes(for: try asked("kuvo/asks/events", at: keeper.environment))
            var lines = bytes.lines.makeAsyncIterator()
            #expect(try await lines.next() != nil)
            streams.append((session, bytes))
        }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let (_, read) = try await session.data(for: try asked("kuvo/usage", at: keeper.environment))
        #expect((read as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Kuvo-Answer") == "1")
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
        // (Which side couldn't, and on which port, if one can't: "Address already in use" came once.)
        let port: UInt16
        do { port = try await server.start() } catch { throw TestFailure("The server couldn't listen on a loopback port: \(error)") }
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
/// sends on it, in order. Each wait ends: with what came, with the connection's error, or with the
/// test's time limit, which closes the connection (a wait on it alone would hold the test past
/// its limit for good, the test process with it). A plain socket, its own port the kernel's pick:
/// one free for the server's, never a pair still closing from an earlier connection there, which
/// Network's own pick can be ("Address already in use", once a test before left one).
@MainActor
final class RawClient {
    private let socket: Int32
    private var isClosed = false
    /// What came past what was read so far.
    private var pending = Data()
    /// Why the connection ended, once it did: in what a read returns, so a failure says.
    private var ended: String?

    private init(socket: Int32) {
        self.socket = socket
    }

    static func connect(port: UInt16) async throws -> RawClient {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { throw TestFailure("The client couldn't make a socket: \(String(cString: strerror(errno)))") }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        // (On loopback the kernel answers it at once, whatever the server's queue is doing.)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard connected == 0 else {
            let why = String(cString: strerror(errno))
            Darwin.close(socket)
            throw TestFailure("The client couldn't connect to 127.0.0.1:\(port): \(why)")
        }
        return RawClient(socket: socket)
    }

    func send(_ text: String) async {
        let socket = socket
        _ = Array(text.utf8).withUnsafeBytes { Darwin.send(socket, $0.baseAddress, $0.count, 0) }
    }

    /// What comes, up to and including `marker`; or, once the connection has ended, all there was,
    /// and why it ended.
    func read(through marker: String) async -> String {
        let marker = Data(marker.utf8)
        let socket = socket
        while true {
            if let found = pending.range(of: marker) {
                let read = pending[..<found.upperBound]
                pending.removeSubrange(..<found.upperBound)
                return String(decoding: read, as: UTF8.self)
            }
            if let ended {
                defer { pending = Data() }
                return String(decoding: pending, as: UTF8.self) + " (\(ended))"
            }
            // Read off the main actor, where the server answers: ended by the test's limit through
            // the socket's shutdown.
            let (data, failure) = await withTaskCancellationHandler {
                await Task.detached { () -> (Data, String?) in
                    var buffer = [UInt8](repeating: 0, count: 65536)
                    let count = recv(socket, &buffer, buffer.count, 0)
                    return count < 0 ? (Data(), String(cString: strerror(errno))) : (Data(buffer[..<count]), nil)
                }.value
            } onCancel: {
                shutdown(socket, SHUT_RDWR)
            }
            if let failure { ended = "ended: \(failure)" } else if data.isEmpty { ended = "closed by the server" } else { pending.append(data) }
        }
    }

    func close() {
        guard !isClosed else { return }
        isClosed = true
        Darwin.close(socket)
    }
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
