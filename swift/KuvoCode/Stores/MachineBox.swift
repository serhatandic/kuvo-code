import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit

/// A machine's own settings and keys, a box of its own (KuvoLink's PROTOCOL.md, "Settings per
/// box"): in `~/.kuvo-code/box` there, which its engine reads and reloads, made its own and its
/// keys set through the box's own tool (`kuvo-link.js box`, the phone link's script), and read and
/// changed through its routes as any box's are (`BoxSettings`). Nothing copies them between
/// computers but you.
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
        var personalities: [Personality]?
        var removed: [Personalities.Removal]?
        var message: String?
    }

    enum Failure: LocalizedError {
        case refused(String)

        var errorDescription: String? {
            switch self {
            case .refused(let message): message
            }
        }
    }

    /// Puts the box's tool on the machine, in `~/.kuvo-code/bin`, unless it has this one, with
    /// what it makes its bots with and tells them, and Settings › MCP Servers' popular servers
    /// beside it, for a phone to add there as here.
    static func install(on connection: SSHConnection) async throws {
        try await installTool(on: connection)
        try await writeCatalog(try BotWords.data, named: BotWords.fileName, on: connection)
        try await writeCatalog(on: connection)
        try await writeCatalog(await integrationsJSON(), named: "integrations.json", on: connection)
    }

    /// Settings › Integrations' catalog as a box reads it (`integrations.json`), for any client to
    /// add and remove them there, a machine's with this Mac closed: each as `kuvo/integrations`
    /// describes it, in the page's order, with its settings there, its keys' variables, and the file
    /// its server keeps its sign-in in when it signs in by itself (`signInFile`). A machine's leaves
    /// out those that use a Mac's own apps. `keysInBox`: a Mac's box in a home of its own, laid out as
    /// a machine's (#333): every integration, its keys named where that box keeps them (`box/keys`),
    /// as a machine's are (`integrations-mac.json` in the box's release).
    @MainActor static func integrationsJSON(forMac: Bool = false, keysInBox: Bool = false) -> Data {
        let entries: [[String: Any]] = Integrations.all.filter { forMac || !Integrations.macOnly.contains($0.id) }.map { service in
            var entry = described(service)
            if let settings = Integrations.settings(for: service, on: forMac && !keysInBox ? nil : "machine"), let value = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) {
                entry["settings"] = value
            }
            let keys = Integrations.keys(of: service.way)
            if !keys.isEmpty { entry["variables"] = Dictionary(uniqueKeysWithValues: keys.map { ($0.name, IntegrationKeys.variable(service.id, $0.name)) }) }
            if let file = Integrations.signInFiles[service.id]?.first { entry["signInFile"] = file }
            return entry
        }
        return (try? JSONSerialization.data(withJSONObject: ["integrations": entries], options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
    }

    /// What it is and how it's added, as `kuvo/integrations` lists it.
    private static func described(_ service: Integrations.Service) -> [String: Any] {
        var entry: [String: Any] = [
            "id": service.id, "title": service.title, "summary": service.summary, "kind": service.kind.rawValue,
            "symbol": service.symbol, "site": service.site, "how": Integrations.how(service.way),
        ]
        switch service.way {
        case .official: entry["way"] = "official"
        case .officialToken(_, _, let help): entry["way"] = "token"; entry["help"] = help
        case .officialApp(_, let help): entry["way"] = "app"; entry["help"] = help; entry["redirect"] = Integrations.redirect
        case .package(_, _, let help, let by, _, let macOnly):
            entry["way"] = "package"
            entry["by"] = by
            if let help { entry["help"] = help }
            if macOnly { entry["macOnly"] = true }
        case .browser:
            entry["way"] = "browser"
            // The cookie its site keeps while you're signed in, which tells a box whether its browser is.
            if let cookie = Integrations.signInCookies[service.id] { entry["signInCookie"] = ["domain": cookie.domain, "name": cookie.name] }
        }
        let keys = Integrations.keys(of: service.way)
        if !keys.isEmpty { entry["keys"] = keys.map { ["name": $0.name, "label": $0.label, "prompt": $0.prompt] } }
        return entry
    }

    /// The same for this Mac's box, with this Mac's own paths (its keys' files in the app's
    /// temporary folder) and the integrations that use its own apps: what Settings › Integrations
    /// lists here, and what its bots' own keys are named with in their folders' settings.
    @MainActor static func writeMacCatalog() {
        let file = BoxProcess.home.appending(path: "bin/integrations.json")
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? integrationsJSON(forMac: true).write(to: file, options: .atomic)
    }

    /// The popular servers as the tool reads them (`mcp-catalog.json`), written when they change,
    /// with every server that uses a Mac's own apps (integrations' too), which stay on Macs.
    @MainActor static func catalogJSON() -> Data {
        struct Listed: Encodable {
            struct Server: Encodable {
                var id: String, title: String, summary: String, access: String
                var integration: Bool, macOnly: Bool
                var settings: JSONValue
            }
            var servers: [Server]
            var macOnly: [String]
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
        return (try? encoder.encode(Listed(servers: servers, macOnly: (Integrations.macOnly + MCPCatalog.macOnly).sorted()))) ?? Data("{}".utf8)
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
            if [ "\(RemoteEngineInstaller.sumOfFile)" = "\(hash)" ]; then cat >/dev/null; else cat >"$f.new" && mv -f "$f.new" "$f"; fi
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
            if [ "\(RemoteEngineInstaller.sumOfFile)" = "\(hash)" ]; then cat >/dev/null; else cat >"$f.new" && chmod 600 "$f.new" && mv -f "$f.new" "$f"; fi
            """), input: file)
    }

    // COMPAT(0.7 settings): adopting what an older Mac's start left (seeding a new machine stays). Goes 3 months after 0.8.0.
    /// Makes the machine's settings its own, once (the tool's `adoptBox`), from what it runs with
    /// now or, with none, `seed`; then, and every time after, its settings as they are, and
    /// whether it was given `seed` just now.
    static func adopt(on connection: SSHConnection, seed: () async throws -> Seed) async throws -> (settings: [String: JSONValue], seeded: Bool) {
        // The seed only when there's nothing there: it reads this Mac's keys.
        let fresh = try await connection.run("[ -f \"$HOME/\(RemoteEngineInstaller.root)/box/opencode.json\" ] && echo own || true")
        // Removed or disconnected as it answered: your settings and keys aren't even read.
        try await connection.mustBeWanted()
        let given = fresh.trimmingCharacters(in: .whitespacesAndNewlines) == "own" ? nil : try await seed()
        let answer = try await run("adopt", input: given.flatMap { try? JSONEncoder().encode($0) }, on: connection)
        return (answer.settings ?? [:], answer.seeded == true)
    }

    /// This Mac's copy of your personalities met with the machine's (the tool's
    /// `mergePersonalities`): both, as one, which the machine keeps too.
    static func personalities(_ library: Personalities.Library, on connection: SSHConnection) async throws -> Personalities.Library {
        let answer = try await run("personalities", input: try JSONEncoder().encode(library), on: connection)
        return Personalities.Library(personalities: answer.personalities ?? [], removed: answer.removed ?? [])
    }

    /// `kuvo-link.js box <arguments>` there, with `input` on its standard input, with whichever
    /// engine runtime the machine has (this version's, or the one at work there).
    /// Its bots' folders' settings made right, as a bridge older than `kuvo/bots/keys/refresh` does it.
    static func refreshBotKeys(on connection: SSHConnection) async throws {
        _ = try await run("bot-keys-refresh", input: nil, on: connection)
    }

    private static func run(_ arguments: String, input: Data?, on connection: SSHConnection) async throws -> Answer {
        try JSONDecoder().decode(Answer.self, from: try await answer(arguments, input: input, on: connection))
    }

    /// A client's request to the machine's box, answered as its bridge answers a phone's (`box
    /// route`), over SSH: the status and body. Only for routes that answer once, never a stream.
    static func route(_ method: String, _ path: String, body: [String: Any]? = nil, bodyText: String? = nil, folder: String? = nil, headers: [String: String] = [:], on connection: SSHConnection) async throws -> (status: Int, body: Data) {
        var request: [String: Any] = ["method": method, "path": path]
        if let body { request["body"] = body }
        // The body as it is, for what a proof covers.
        if let bodyText { request["bodyText"] = bodyText }
        // The folder it's about, on the machine, as a phone's request names it.
        var given = headers
        if let folder { given["x-opencode-directory"] = folder }
        if !given.isEmpty { request["headers"] = given }
        // One that only reads (a search, a list) is let go when nothing waits for it any more.
        let output = try await lastLine("route", input: try JSONSerialization.data(withJSONObject: request), cancellable: method == "GET", on: connection)
        /// Text as it came, or bytes that aren't text (a picture) in base64.
        struct Routed: Decodable { var status: Int; var body: String?; var bodyBase64: String? }
        guard let routed = try? JSONDecoder().decode(Routed.self, from: Data(output.utf8)) else { throw Failure.refused("The machine didn't answer: \(output.prefix(200))") }
        return (routed.status, routed.bodyBase64.flatMap { Data(base64Encoded: $0) } ?? Data((routed.body ?? "").utf8))
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
    private static func lastLine(_ arguments: String, input: Data?, cancellable: Bool = false, on connection: SSHConnection) async throws -> String {
        let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-box-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: file.path, contents: input ?? Data(), attributes: [.posixPermissions: 0o600])
        defer { try? FileManager.default.removeItem(at: file) }
        let output = try await connection.run(RemoteEngineInstaller.script("""
            [ -x "$E" ] || E=$(for d in "$K"/engine/*/; do [ -x "${d}opencode" ] && printf '%s\\n' "${d}opencode"; done | tail -n 1)
            KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$E" --config=/dev/null --no-env-file "$K/bin/\(Bridge.fileName)" box \(arguments)
            """), input: file, cancellable: cancellable)
        return output.split(separator: "\n").last.map(String.init) ?? ""
    }
}
