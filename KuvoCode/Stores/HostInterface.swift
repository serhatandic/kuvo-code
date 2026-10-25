import Foundation

/// What this Mac's box asks its app for, that only the app can do (KuvoLink's PROTOCOL.md, "Host
/// interface"): Kuvo Code's own keys in your Keychain, by name, which a machine's box keeps in its
/// files. It answers on a loopback port, to a password the box is given as it starts
/// (`environment`), and only for a name of Kuvo Code's own keys (`KUVO_KEY_…`), so the box can
/// reach nothing else in your Keychain. A key saved or removed here goes to the engine's files too
/// (`IntegrationKeys`); listing them reads no secret, so it never asks you.
@MainActor
final class HostInterface {
    private let password = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    private lazy var server = LoopbackServer { [weak self] request in await self?.respond(to: request) ?? .init(status: 503) }

    /// Starts answering (once), and says what the box is to be given to reach it: where, its
    /// password, and the folder the engine reads keys from.
    func start() async throws -> [String: String] {
        let port = try await server.start()
        return ["KUVO_HOST_URL": "http://127.0.0.1:\(port)", "KUVO_HOST_PASSWORD": password, "KUVO_KEY_FILES": IntegrationKeys.folder.path]
    }

    func stop() { server.stop() }

    /// The names it answers for: Kuvo Code's own keys.
    nonisolated static func isKey(_ name: String) -> Bool {
        name.hasPrefix("KUVO_KEY_") && name.count > "KUVO_KEY_".count
            && name.unicodeScalars.allSatisfy { ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "_" }
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
            let names = await Task.detached { IntegrationKeys.names }.value
            return .json(["names": names.filter { Self.isKey($0) && $0.hasPrefix(prefix) && $0.hasSuffix(suffix) }.sorted()])
        case "/keys/get":
            guard let name, Self.isKey(name) else { return .init(status: 400) }
            guard let value = await Task.detached(operation: { IntegrationKeys.value(name) }).value else { return .init(status: 404) }
            return .json(["value": value])
        case "/keys/set":
            guard let name, Self.isKey(name), let value = given["value"] as? String, !value.isEmpty else { return .init(status: 400) }
            return await Task.detached(operation: { IntegrationKeys.set(value, for: name) }).value ? .json([:]) : .init(status: 503)
        case "/keys/delete":
            guard let name, Self.isKey(name) else { return .init(status: 400) }
            return await Task.detached(operation: { IntegrationKeys.set(nil, for: name) }).value ? .json([:]) : .init(status: 503)
        default:
            return .init(status: 404)
        }
    }
}
