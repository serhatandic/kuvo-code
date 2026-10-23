import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit

/// A machine's own settings and keys, a box of its own (KuvoLink's PROTOCOL.md, "Settings per
/// box"): in `~/.kuvo-code/box` there, which its engine reads and reloads, changed from any Mac
/// or phone through the box's own tool (`kuvo-link.js box`, the phone link's script, which
/// answers phones the same way). Nothing copies them between computers but you.
enum MachineBox {
    /// What a machine with no settings yet starts with: this Mac's, as its start sent them before
    /// boxes had their own, and its integrations' keys, by their variables.
    struct Seed: Encodable {
        var settings: [String: JSONValue]
        var keys: [String: String]
    }

    /// The tool's answer.
    private struct Answer: Decodable {
        var status: JSONValue?
        var seeded: Bool?
        var settings: [String: JSONValue]?
        var own: Bool?
        var personalities: [Personality]?
        var removed: [Personalities.Removal]?
        var message: String?
    }

    enum Failure: LocalizedError {
        case refused(String)
        /// It hasn't been started by a Kuvo Code with boxes yet: what it runs with isn't its own.
        case notOwnYet

        var errorDescription: String? {
            switch self {
            case .refused(let message): message
            case .notOwnYet: "Its settings become its own the next time Kuvo Code starts it."
            }
        }
    }

    /// Puts the box's tool on the machine, in `~/.kuvo-code/bin`, unless it has this one, with
    /// Settings › MCP Servers' popular servers beside it, for a phone to add there as here.
    static func install(on connection: SSHConnection) async throws {
        try await installTool(on: connection)
        try await writeCatalog(on: connection)
        try await writeCatalog(await integrationsJSON(), named: "integrations.json", on: connection)
    }

    /// Settings › Integrations' catalog as the tool reads it (`integrations.json`), for a phone to
    /// add and remove them there with this Mac closed: each as `kuvo/integrations` describes it,
    /// with its settings there and its keys' variables. Those that use a Mac's own apps aren't in it.
    @MainActor static func integrationsJSON() -> Data {
        let entries: [[String: Any]] = Integrations.all.filter { !Integrations.macOnly.contains($0.id) }.map { service in
            var entry = PhoneLink.described(service)
            if let settings = Integrations.settings(for: service, on: "machine"), let value = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) {
                entry["settings"] = value
            }
            let keys = Integrations.keys(of: service.way)
            if !keys.isEmpty { entry["variables"] = Dictionary(uniqueKeysWithValues: keys.map { ($0.name, IntegrationKeys.variable(service.id, $0.name)) }) }
            return entry
        }
        return (try? JSONSerialization.data(withJSONObject: ["integrations": entries], options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
    }

    /// The popular servers as the tool reads them (`mcp-catalog.json`), written when they change.
    @MainActor static func catalogJSON() -> Data {
        struct Listed: Encodable {
            struct Server: Encodable {
                var id: String, title: String, summary: String, access: String
                var integration: Bool, macOnly: Bool
                var settings: JSONValue
            }
            var servers: [Server]
        }
        let servers = MCPCatalog.servers.map { server in
            let access = switch server.access {
            case .signIn: "signIn"
            case .open: "open"
            case .local: "local"
            }
            return Listed.Server(id: server.id, title: server.title, summary: server.summary, access: access,
                                 integration: Integrations.service(server.id) != nil, macOnly: MCPCatalog.macOnly.contains(server.id), settings: server.settings)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(Listed(servers: servers))) ?? Data("{}".utf8)
    }

    private static func writeCatalog(on connection: SSHConnection) async throws {
        try await writeCatalog(await catalogJSON(), named: "mcp-catalog.json", on: connection)
    }

    /// `data` in the machine's `bin` as `name`, unless it has it already.
    private static func writeCatalog(_ data: Data, named name: String, on connection: SSHConnection) async throws {
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-catalog-\(UUID().uuidString).json")
        try data.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        try await connection.run(BoxVersion.guardScript + "\n" + RemoteEngineInstaller.script("""
            f="$K/bin/\(name)"
            if [ "$(sha256sum "$f" 2>/dev/null | cut -c1-64)" = "\(hash)" ]; then cat >/dev/null; else cat >"$f.new" && mv -f "$f.new" "$f"; fi
            """), input: file)
    }

    private static func installTool(on connection: SSHConnection) async throws {
        let script = try Bridge.script
        let hash = SHA256.hash(data: script).map { String(format: "%02x", $0) }.joined()
        let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-box-\(UUID().uuidString).js")
        try script.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        try await connection.run(BoxVersion.guardScript + "\n" + RemoteEngineInstaller.script("""
            f="$K/bin/\(Bridge.fileName)"
            if [ "$(sha256sum "$f" 2>/dev/null | cut -c1-64)" = "\(hash)" ]; then cat >/dev/null; else cat >"$f.new" && chmod 600 "$f.new" && mv -f "$f.new" "$f"; fi
            """), input: file)
    }

    /// Makes the machine's settings its own, once (the tool's `adoptBox`), from what it runs with
    /// now or, with none, `seed`; then, and every time after, its settings as they are, and
    /// whether it was given `seed` just now.
    static func adopt(on connection: SSHConnection, seed: () async -> Seed) async throws -> (settings: [String: JSONValue], seeded: Bool) {
        // The seed only when there's nothing there: it reads this Mac's keys.
        let fresh = try await connection.run("[ -f \"$HOME/\(RemoteEngineInstaller.root)/box/opencode.json\" ] && echo own || true")
        let given = fresh.trimmingCharacters(in: .whitespacesAndNewlines) == "own" ? nil : await seed()
        let answer = try await run("adopt", input: given.flatMap { try? JSONEncoder().encode($0) }, on: connection)
        return (answer.settings ?? [:], answer.seeded == true)
    }

    /// The machine's settings, as its file has them now.
    static func read(on connection: SSHConnection) async throws -> [String: JSONValue] {
        let answer = try await run("read", input: nil, on: connection)
        guard answer.own != false else { throw Failure.notOwnYet }
        return answer.settings ?? [:]
    }

    /// Changes some of the machine's settings, key by key (the phone's `PATCH kuvo/config`):
    /// another computer's changes to other keys stay. Its settings after.
    static func change(_ changes: [(path: [String], value: JSONValue?)], on connection: SSHConnection) async throws -> [String: JSONValue] {
        struct Change: Encodable { var path: [String]; var value: JSONValue }
        struct Changes: Encodable { var changes: [Change] }
        let body = Changes(changes: changes.map { Change(path: $0.path, value: $0.value ?? .null) })
        return try await run("change", input: try JSONEncoder().encode(body), on: connection).settings ?? [:]
    }

    /// This Mac's copy of your personalities met with the machine's (the tool's
    /// `mergePersonalities`): both, as one, which the machine keeps too.
    static func personalities(_ library: Personalities.Library, on connection: SSHConnection) async throws -> Personalities.Library {
        let answer = try await run("personalities", input: try JSONEncoder().encode(library), on: connection)
        return Personalities.Library(personalities: answer.personalities ?? [], removed: answer.removed ?? [])
    }

    /// Sets one of the machine's own keys (an integration's), or removes it (nil).
    static func setKey(_ name: String, _ value: String?, on connection: SSHConnection) async throws {
        _ = try await run("key \(SSHConnection.quoted(name))", input: Data((value ?? "").utf8), on: connection)
    }

    /// A machine's settings for its Settings tab and its sessions' rules (`EngineConfig`).
    struct Store: RemoteSettings {
        let connection: SSHConnection

        func read() async throws -> [String: JSONValue] {
            try await MachineBox.read(on: connection)
        }

        func change(_ changes: [(path: [String], value: JSONValue?)]) async throws -> [String: JSONValue] {
            try await MachineBox.change(changes, on: connection)
        }
    }

    /// `kuvo-link.js box <arguments>` there, with `input` on its standard input, with whichever
    /// engine runtime the machine has (this version's, or the one at work there).
    private static func run(_ arguments: String, input: Data?, on connection: SSHConnection) async throws -> Answer {
        try JSONDecoder().decode(Answer.self, from: try await answer(arguments, input: input, on: connection))
    }

    /// A client's request to the machine's box, answered as its bridge answers a phone's (`box
    /// route`), over SSH: the status and body. Only for routes that answer once, never a stream.
    static func route(_ method: String, _ path: String, body: [String: Any]? = nil, on connection: SSHConnection) async throws -> (status: Int, body: Data) {
        var request: [String: Any] = ["method": method, "path": path]
        if let body { request["body"] = body }
        let output = try await lastLine("route", input: try JSONSerialization.data(withJSONObject: request), on: connection)
        struct Routed: Decodable { var status: Int; var body: String }
        guard let routed = try? JSONDecoder().decode(Routed.self, from: Data(output.utf8)) else { throw Failure.refused("The machine didn't answer: \(output.prefix(200))") }
        return (routed.status, Data(routed.body.utf8))
    }

    /// Its bots' folders' settings as their keys and the machine's integrations are now (after the
    /// integrations' catalog changed, or a bot moved there).
    static func refreshBotKeys(on connection: SSHConnection) async throws {
        _ = try await run("bot-keys-refresh", input: nil, on: connection)
    }

    /// What `kuvo-link.js box <arguments>` answered (its last line, JSON), or why not.
    private static func answer(_ arguments: String, input: Data?, on connection: SSHConnection) async throws -> Data {
        let output = try await lastLine(arguments, input: input, on: connection)
        let line = Data(output.utf8)
        guard let answer = try? JSONDecoder().decode(Answer.self, from: line) else { throw Failure.refused("The machine's settings couldn't be read: \(output.prefix(200))") }
        if case .number(let status)? = answer.status, status >= 400 { throw Failure.refused(answer.message ?? "The machine said no (\(Int(status))).") }
        return line
    }

    /// The last line `kuvo-link.js box <arguments>` printed, with whichever engine runtime the
    /// machine has.
    private static func lastLine(_ arguments: String, input: Data?, on connection: SSHConnection) async throws -> String {
        let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-box-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: file.path, contents: input ?? Data(), attributes: [.posixPermissions: 0o600])
        defer { try? FileManager.default.removeItem(at: file) }
        let output = try await connection.run(RemoteEngineInstaller.script("""
            [ -x "$E" ] || E=$(for d in "$K"/engine/*/; do [ -x "${d}opencode" ] && printf '%s\\n' "${d}opencode"; done | tail -n 1)
            KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$E" "$K/bin/\(Bridge.fileName)" box \(arguments)
            """), input: file)
        return output.split(separator: "\n").last.map(String.init) ?? ""
    }
}
