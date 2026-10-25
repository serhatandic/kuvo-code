import Foundation
import KuvoLink

/// What this Mac's box asks its app for, that only the app can do (KuvoLink's PROTOCOL.md, "Host
/// interface"): Kuvo Code's own keys in your Keychain, by name, which a machine's box keeps in its
/// files, and whether the panel's browser is signed in to the sites the agent uses there; what it
/// lets go of, moved from its trash folder to the Finder's Trash; and for its link to your phones and
/// machines, this Mac's keys (from your Keychain too), what a phone asks of the Mac's own routes, and
/// mail from your machines, for what the app still does. It answers on a loopback port, to a
/// password the box is given as it starts (`environment`), and only for a name of Kuvo Code's own
/// keys (`KUVO_KEY_…`), so the box can reach nothing else in your Keychain. A key saved or removed
/// here goes to the engine's files too (`IntegrationKeys`); listing them reads no secret, so it never
/// asks you.
@MainActor
final class HostInterface {
    private let password = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    private lazy var server = LoopbackServer { [weak self] request in await self?.respond(to: request) ?? .init(status: 503) }
    /// This Mac's link, for what its box's link asks of the app; set by AppModel.
    weak var phoneLink: PhoneLink?

    /// Starts answering (once), and says what the box is to be given to reach it: where, and its
    /// password. (Where the engine reads keys from, `KUVO_KEYS`, `BoxProcess` gives it.)
    func start() async throws -> [String: String] {
        let port = try await server.start()
        return ["KUVO_HOST_URL": "http://127.0.0.1:\(port)", "KUVO_HOST_PASSWORD": password]
    }

    func stop() { server.stop() }

    /// The names it answers for: Kuvo Code's own keys.
    nonisolated static func isKey(_ name: String) -> Bool {
        name.hasPrefix("KUVO_KEY_") && name.count > "KUVO_KEY_".count
            && name.unicodeScalars.allSatisfy { ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "_" }
    }

    /// An answer as it comes: its head, then its body as a stream (`…/events` routes follow), which
    /// stops when the box goes.
    private static func answer(_ parts: AsyncThrowingStream<LinkResponsePart, Error>) async -> HTTPResponse {
        let (body, sending) = AsyncThrowingStream<Data, Error>.makeStream()
        let head: (status: Int, headers: [String: String]) = await withCheckedContinuation { said in
            let reading = Task {
                var told = false
                do {
                    for try await part in parts {
                        switch part {
                        case .head(let status, let headers):
                            if !told { said.resume(returning: (status, Self.passed(headers))) }
                            told = true
                        case .body(let data):
                            if !told { said.resume(returning: (200, Self.passed([:]))) }
                            told = true
                            sending.yield(data)
                        }
                    }
                } catch {}
                if !told { said.resume(returning: (502, Self.passed([:]))) }
                sending.finish()
            }
            sending.onTermination = { _ in reading.cancel() }
        }
        return HTTPResponse(status: head.status, headers: head.headers, stream: body)
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
        case "/link/mailed":
            // Mail one of your machines sent this Mac, for what the app still does with it.
            guard let frame = (given["frame"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return .init(status: 400) }
            phoneLink?.mailed(frame)
            return .json([:])
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
