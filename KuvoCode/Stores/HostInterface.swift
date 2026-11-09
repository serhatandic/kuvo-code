import AppKit
import CryptoKit
import Foundation
import KuvoLink

/// What this Mac's box asks its app for, that only the app can do (KuvoLink's PROTOCOL.md, "Host
/// interface"): Kuvo Code's own keys in your Keychain, by name, which a machine's box keeps in its
/// files, and whether the panel's browser is signed in to the sites the agent uses there; what it
/// lets go of, moved from its trash folder to the Finder's Trash; and for its link to your phones and
/// machines, this Mac's keys (from your Keychain too), what a phone asks of the Mac's own routes, and
/// mail from your machines, for what the app still does. It answers on a loopback port, to a
/// password, both in the box's `run/host.json` (which the box reads for each call), and only for a name of Kuvo Code's own
/// keys (`KUVO_KEY_…`), so the box can reach nothing else in your Keychain. A key saved or removed
/// here goes to the engine's files too (`IntegrationKeys`); listing them reads no secret, so it never
/// asks you.
@MainActor
final class HostInterface {
    private let password = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    /// What the vault's calls need besides the password, which is in a file an agent's command can
    /// read: given to this Mac's box alone, in its environment as it starts (`boxEnvironment`), which
    /// no other process can read, and never written down.
    let vaultSecret = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    private lazy var server: LoopbackServer = {
        let server = LoopbackServer { [weak self] request in await self?.respond(to: request) ?? .init(status: 503) }
        // Gone by itself: started again, so the box's keys aren't out of reach until the app quits;
        // one that keeps failing, less and less often.
        server.failed = { [weak self] in self?.failedByItself() }
        return server
    }()
    /// Trying again every so often, after it couldn't start or failed by itself.
    private var retrying: Task<Void, Never>?
    /// How long it waits before its next try after failing by itself, and when it last did.
    private var failureWait = HostInterface.firstWait
    private var lastFailure: Date?
    private static let firstWait = 2.0
    private static let longestWait = 60.0
    /// This Mac's link, for what its box's link asks of the app; set by AppModel (and by the keeper,
    /// for this Mac's keys alone).
    weak var phoneLink: PhoneLink?
    /// What only the open app answers (the panel's browser, the Mac's own routes for a phone): the
    /// keeper's (`Keeper`) asks the open app's (`appHost`), and says so while it isn't open.
    var appAnswers = true
    /// The open app's own, for the keeper's: where it answers, and its password.
    private var appHost: (url: URL, password: String)?

    /// The open app's (`{url, password}`), or that it has quit (`{}`).
    func useApp(_ given: [String: Any]) {
        if let url = (given["url"] as? String).flatMap(URL.init(string:)), let password = given["password"] as? String {
            appHost = (url, password)
        } else {
            appHost = nil
        }
    }

    /// Where it answers once started without telling the box (the open app's, while the keeper
    /// runs the box: the keeper's tells it, and asks this one for what only the app answers).
    var address: [String: String]? {
        server.port.map { ["url": "http://127.0.0.1:\($0)", "password": password] }
    }

    /// Whether it tells this Mac's box where it answers (`file`): not the open app's while the keeper
    /// runs the box, whose own host tells it; the app's then only answers the keeper (`address`), so
    /// starting it again (Try Again in Integrations) never takes the keeper's record.
    var tellsBox = true

    init() {
        // Quitting, crashes aside: the box's record of where it answers goes with it, so nothing
        // else that takes its port later is asked for your keys.
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    /// Where it tells this Mac's box it answers, and with what password: written each time it starts,
    /// taken away when it stops, can't start, or the app quits; only you can read it.
    static var file: URL { BoxProcess.run.appending(path: "host.json") }

    /// Whether it's answering now.
    var isAnswering: Bool { server.port != nil }

    /// Starts answering (once), and tells the box where (`file`): where, and its password, which it
    /// also says. (Where the engine reads keys from, `KUVO_KEYS`, `BoxProcess` gives it.) What the
    /// box was told before goes first, so a start that fails leaves it nothing to follow.
    @discardableResult
    func start() async throws -> [String: String] {
        guard tellsBox else {
            _ = try await server.start()
            return [:]
        }
        tried = true
        if !isAnswering { Self.forget() }
        let port = try await server.start()
        let url = "http://127.0.0.1:\(port)"
        try Self.write(["url": url, "password": password])
        return ["KUVO_HOST_URL": url, "KUVO_HOST_PASSWORD": password]
    }

    /// Kept answering: started now if it isn't (never yet, stopped, or gone by itself), else tried
    /// again every so often, sooner at first, until it starts. Whether it answers now.
    @discardableResult
    func keepUp() async -> Bool {
        if isAnswering { return true }
        if (try? await start()) != nil {
            retrying?.cancel()
            retrying = nil
            return true
        }
        if tellsBox { Self.forget() }
        retry(after: Self.firstWait)
        return false
    }

    /// Stops answering, and tells the box so (its keys out of reach until it starts again): one that
    /// never answered leaves the record alone (the keeper's, while the app quits).
    func stop() {
        retrying?.cancel()
        retrying = nil
        server.stop()
        guard tried else { return }
        tried = false
        Self.forget()
    }

    /// It started answering, or tried to, so the record is its own to take away.
    private var tried = false

    /// Told once it answers again, at a new address, after failing by itself while it doesn't tell
    /// the box where it answers (the open app's, while the keeper runs the box: the keeper is told
    /// again, or what only the app answers stays out of the box's reach); set by AppModel.
    var restarted: (() -> Void)?

    /// Its listener failed by itself: tried again after a wait that doubles with each failure that
    /// comes soon after the last one, up to a minute. The record in the box's folder goes only when
    /// it's its own: the keeper's, while the keeper runs the box, stays.
    func failedByItself() {
        if tellsBox { Self.forget() }
        if let lastFailure, Date.now.timeIntervalSince(lastFailure) < 5 * 60 {
            failureWait = min(failureWait * 2, Self.longestWait)
        } else {
            failureWait = Self.firstWait
        }
        lastFailure = .now
        retrying?.cancel()
        retrying = nil
        retry(after: failureWait)
    }

    /// Tries to start again after `first` seconds, then twice as long each time, up to a minute,
    /// until it starts (one try at a time).
    private func retry(after first: Double) {
        guard retrying == nil else { return }
        retrying = Task { [weak self] in
            var wait = first
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(wait))
                guard let self, !Task.isCancelled else { return }
                if (try? await self.start()) != nil {
                    self.retrying = nil
                    if !self.tellsBox { self.restarted?() }
                    return
                }
                if self.tellsBox { Self.forget() }
                wait = min(wait * 2, Self.longestWait)
            }
        }
    }

    /// What the box was told, gone.
    private static func forget() {
        try? FileManager.default.removeItem(at: file)
    }

    /// Written whole, readable only by you from the moment it exists: a new file made that way,
    /// then moved over the old one.
    private static func write(_ said: [String: String]) throws {
        try FileManager.default.createDirectory(at: BoxProcess.run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONSerialization.data(withJSONObject: said)
        let temporary = BoxProcess.run.appending(path: ".host-\(UUID().uuidString).json")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        let written = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
        let closed = close(descriptor)
        guard written == data.count, closed == 0, rename(temporary.path, file.path) == 0 else {
            unlink(temporary.path)
            throw CocoaError(.fileWriteUnknown)
        }
    }

    /// The box's nonce, with where it reached it (`127.0.0.1:<port>`), signed with the password
    /// (HMAC-SHA256, hex), as it checks it: relayed from another port, it's wrong there.
    nonisolated static func proof(of nonce: String, at address: String, password: String, tag: String = "kuvo-host-hello") -> String {
        let signed = Data("\(tag)\u{0}\(nonce)\u{0}\(address)".utf8)
        let code = HMAC<SHA256>.authenticationCode(for: signed, using: SymmetricKey(data: Data(password.utf8)))
        return code.map { String(format: "%02x", $0) }.joined()
    }

    /// Vault calls' proofs taken already, until they'd be too old anyway: each works once.
    private var usedVaultProofs: [String: Date] = [:]

    /// Whether a vault call carries the box's proof of it: an HMAC with the vault's secret of the
    /// call, its body and when it was made (within a minute), not used before.
    private func vaultCallProved(_ request: HTTPRequest) -> Bool {
        guard let auth = request.headers["x-kuvo-vault-auth"], let at = request.headers["x-kuvo-vault-at"].flatMap(Double.init),
              abs(Date().timeIntervalSince1970 * 1000 - at) < 60_000 else { return false }
        let call = String(request.path.dropFirst())
        let body = SHA256.hash(data: request.body).map { String(format: "%02x", $0) }.joined()
        let signed = Data("kuvo-host-vault-call\u{0}\(call)\u{0}\(body)\u{0}\(request.headers["x-kuvo-vault-at"] ?? "")".utf8)
        let expected = HMAC<SHA256>.authenticationCode(for: signed, using: SymmetricKey(data: Data(vaultSecret.utf8))).map { String(format: "%02x", $0) }.joined()
        guard samePassword(auth, expected) else { return false }
        let now = Date()
        usedVaultProofs = usedVaultProofs.filter { now.timeIntervalSince($0.value) < 120 }
        guard usedVaultProofs[auth] == nil else { return false }
        usedVaultProofs[auth] = now
        return true
    }

    /// The names it answers for: Kuvo Code's own keys.
    nonisolated static func isKey(_ name: String) -> Bool {
        name.hasPrefix("KUVO_KEY_") && name.count > "KUVO_KEY_".count
            && name.unicodeScalars.allSatisfy { ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "_" }
    }

    /// An answer as it comes: its head, then its body as a stream (`…/events` routes follow), each
    /// piece read only as it's sent on (off the main actor), so a slow box never has it pile up
    /// here. It stops when the box goes, before its head too (the phone left, and what it asked
    /// stops with it), and one that fails partway ends cut off, not whole.
    private static func answer(_ parts: AsyncThrowingStream<LinkResponsePart, Error>) async -> HTTPResponse {
        let reader = AnswerReader(parts)
        let head = await reader.head()
        return HTTPResponse(status: head.status, headers: Self.passed(head.headers), stream: Self.body(reader))
    }

    /// Its body, pulled by whoever sends it on, never through the main actor.
    private nonisolated static func body(_ reader: AnswerReader) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { try await reader.nextBody() }
    }

    /// What goes back with an answer: its type and how it may be kept, and that it's the app's own
    /// (`X-Kuvo-Answer`), whatever its status, so the box tells a real 404 from the app not there.
    private nonisolated static func passed(_ headers: [String: String]) -> [String: String] {
        let given = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }) { first, _ in first }
        var passed = ["Content-Type": given["content-type"] ?? "application/json", "X-Kuvo-Answer": "1"]
        if let cache = given["cache-control"] { passed["Cache-Control"] = cache }
        return passed
    }

    /// What the Keychain didn't do, said as Edit Bot says it.
    private static var failed: HTTPResponse {
        var answer = HTTPResponse.json(["message": "Your Keychain didn’t take it. Try again, or check Keychain Access."])
        answer.status = 503
        return answer
    }

    private func respond(to request: HTTPRequest) async -> HTTPResponse {
        // That it's this Mac's app the box reaches, not whatever has its port now: the box's nonce
        // and this port, signed with the password, asked before anything else and without the
        // password, so only the app that wrote `file`, here, can answer it.
        if request.path == "/hello" {
            guard request.method == "POST" else { return .init(status: 405, headers: ["Allow": "POST"]) }
            let given = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
            guard let nonce = given["nonce"] as? String, (16...256).contains(nonce.count) else { return .init(status: 400) }
            guard let port = server.port else { return .init(status: 503) }
            var answer = ["proof": Self.proof(of: nonce, at: "127.0.0.1:\(port)", password: password)]
            // For the vault's calls, the same with the vault's secret, which only the box was given.
            if given["vault"] as? Bool == true { answer["vaultProof"] = Self.proof(of: nonce, at: "127.0.0.1:\(port)", password: vaultSecret, tag: "kuvo-host-vault") }
            return .json(answer)
        }
        guard let authorization = request.headers["authorization"], authorization.hasPrefix("Bearer "),
              samePassword(String(authorization.dropFirst(7)), password) else { return .init(status: 401) }
        guard request.method == "POST" else { return .init(status: 405, headers: ["Allow": "POST"]) }
        let given = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
        let name = given["name"] as? String
        switch request.path {
        case "/keys/names":
            let prefix = given["prefix"] as? String ?? "", suffix = given["suffix"] as? String ?? ""
            // One the Keychain couldn't list isn't "no keys": the box would take bots' servers away.
            guard let names = await Task.detached(operation: { IntegrationKeys.listed }).value else { return Self.failed }
            return .json(["names": names.filter { Self.isKey($0) && $0.hasPrefix(prefix) && $0.hasSuffix(suffix) }.sorted()])
        case "/keys/get":
            guard let name, Self.isKey(name) else { return .init(status: 400) }
            guard let value = await Task.detached(operation: { IntegrationKeys.value(name) }).value else { return .init(status: 404) }
            return .json(["value": value])
        case "/keys/set":
            guard let name, Self.isKey(name), let value = given["value"] as? String, !value.isEmpty else { return .init(status: 400) }
            return await Task.detached(operation: { IntegrationKeys.set(value, for: name) }).value ? .json([:]) : Self.failed
        case "/keys/delete":
            guard let name, Self.isKey(name) else { return .init(status: 400) }
            return await Task.detached(operation: { IntegrationKeys.set(nil, for: name) }).value ? .json([:]) : Self.failed
        case "/vault/generations":
            // The box's signed files' newest generations, kept here where agents can't put them back.
            guard vaultCallProved(request) else { return .init(status: 403) }
            if let file = given["file"] as? String, ["items", "grants", "paused"].contains(file), let generation = given["generation"] as? Int {
                guard await Task.detached(operation: { VaultValues.remember(file, generation: generation) }).value else { return Self.failed }
            }
            guard let kept = await Task.detached(operation: { VaultValues.generations() }).value else {
                var answer = HTTPResponse.json(["message": "This Mac’s Keychain can’t be read now, so its vault waits. Unlock your Mac, then try again."])
                answer.status = 503
                return answer
            }
            return .json(["generations": kept.generations, "adopt": kept.adopt])
        case "/vault/get", "/vault/set", "/vault/delete":
            // The vault's values, by item, in the Keychain: the box keeps everything else about them.
            // Only to the box, which has the secret no file holds: each call with its own proof of it.
            guard vaultCallProved(request) else { return .init(status: 403) }
            guard let id = given["id"] as? String, VaultValues.isItem(id) else { return .init(status: 400) }
            switch request.path {
            case "/vault/get":
                guard let values = await Task.detached(operation: { VaultValues.values(id) }).value else { return .init(status: 404) }
                return .json(["values": values])
            case "/vault/set":
                guard let values = given["values"] as? [String: String] else { return .init(status: 400) }
                return await Task.detached(operation: { VaultValues.set(values, for: id) }).value ? .json([:]) : Self.failed
            default:
                return await Task.detached(operation: { VaultValues.remove(id) }).value ? .json([:]) : Self.failed
            }
        // (`where` binds only the pattern it follows: each one needs its own.)
        case "/sites/signed-in" where !appAnswers, "/link/route" where !appAnswers:
            guard let appHost else { return Self.needsApp }
            return await Self.forward(request, to: appHost) ?? Self.needsApp
        case "/sites/signed-in":
            // Whether the panel's browser is signed in to the sites the agent uses there, as their
            // cookies say (read again once they've changed): only those it can tell.
            return .json(["sites": await SiteSignIns.shared.mac()])
        case "/link/identity":
            // This Mac's keys, for its box's link: in memory there, never in a file.
            guard let identity = phoneLink?.boxIdentity() else { return .init(status: 503) }
            return .json(identity)
        case "/link/route":
            // What a phone asked of the Mac's own routes, answered as it comes.
            guard let phoneLink, let method = given["method"] as? String, let path = given["path"] as? String else { return .init(status: 400) }
            let body = (given["body"] as? String).flatMap { Data(base64Encoded: $0) } ?? Data()
            let headers = (given["headers"] as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
            let phone = (given["phone"] as? String).flatMap { Data(base64URL: $0) }
            return await Self.answer(phoneLink.answerForBox(LinkRequest(method: method, path: path, headers: headers, body: body), phone: phone))
        case "/trash":
            // What the box let go of (a deleted bot's folder), from its own trash folder only, to
            // the Finder's Trash, where you look for what you deleted.
            guard let path = given["path"] as? String else { return .init(status: 400) }
            BoxGroups.toFinderTrash(path)
            return .json([:])
        default:
            return .init(status: 404)
        }
    }
}

extension HostInterface {
    /// Connections of its own to the open app, plenty of them: each stream a phone follows holds
    /// one open, and none may hold up the next request. Kept in memory only.
    private nonisolated static let appSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 64
        return URLSession(configuration: configuration)
    }()

    /// What the box asked, to the open app's host interface, as it came: nil when it doesn't answer.
    static func forward(_ request: HTTPRequest, to app: (url: URL, password: String)) async -> HTTPResponse? {
        // However long it says nothing (what follows something does, until that changes): it ends
        // when the box goes.
        var forwarded = URLRequest(url: app.url.appending(path: String(request.path.dropFirst())), timeoutInterval: 7 * 24 * 3600)
        forwarded.httpMethod = request.method
        forwarded.setValue("Bearer \(app.password)", forHTTPHeaderField: "Authorization")
        forwarded.setValue("application/json", forHTTPHeaderField: "Content-Type")
        forwarded.httpBody = request.body
        // As it comes: a route that follows something (a phone's stream) answers for as long as it lasts.
        guard let (bytes, response) = try? await appSession.bytes(for: forwarded), let response = response as? HTTPURLResponse else { return nil }
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            let reading = Task {
                var chunk = Data()
                do {
                    for try await byte in bytes {
                        chunk.append(byte)
                        if byte == 0x0A || chunk.count >= 16_384 {
                            continuation.yield(chunk)
                            chunk = Data()
                        }
                    }
                    if !chunk.isEmpty { continuation.yield(chunk) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reading.cancel() }
        }
        // As the app said it: its type, how it may be kept, and that it's the app's own (`passed`),
        // without which the box takes this for the app not being there.
        var headers = ["Content-Type": response.value(forHTTPHeaderField: "Content-Type") ?? "application/json"]
        for name in ["X-Kuvo-Answer", "Cache-Control"] {
            if let value = response.value(forHTTPHeaderField: name) { headers[name] = value }
        }
        return HTTPResponse(status: response.statusCode, headers: headers, stream: stream)
    }

    /// What only the open app answers, asked while it isn't.
    static var needsApp: HTTPResponse {
        var answer = HTTPResponse.json(["message": "Kuvo Code isn’t open on this Mac."])
        answer.status = 503
        return answer
    }
}

/// An answer's parts, read one at a time as they're asked for: first its head, then its body.
nonisolated final class AnswerReader: @unchecked Sendable {
    private var parts: AsyncThrowingStream<LinkResponsePart, Error>.AsyncIterator
    /// A body that came before any head, for the first piece.
    private var first: Data?

    init(_ parts: AsyncThrowingStream<LinkResponsePart, Error>) {
        self.parts = parts.makeAsyncIterator()
    }

    /// Its status and headers: a body first means 200; none at all (gone), 502.
    func head() async -> (status: Int, headers: [String: String]) {
        do {
            switch try await parts.next() {
            case .head(let status, let headers): return (status, headers)
            case .body(let data):
                first = data
                return (200, [:])
            case nil: return (502, [:])
            }
        } catch {
            return (502, [:])
        }
    }

    /// The next piece of its body; nil at its end.
    func nextBody() async throws -> Data? {
        if let data = first {
            first = nil
            return data
        }
        while let part = try await parts.next() {
            if case .body(let data) = part { return data }
        }
        return nil
    }
}
