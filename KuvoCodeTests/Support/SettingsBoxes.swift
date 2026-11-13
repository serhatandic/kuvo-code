import Foundation
import KuvoLink
import OpenCodeKit
@testable import KuvoCode

/// This Mac's box for a test of its engine settings: the real `kuvo-link.js serve` (`TestBox`),
/// keeping them where the app's engine reads them (the engine's settings file, in the tests'
/// folder), which starts and ends with none.
@MainActor
final class SettingsBox {
    let engine: StubEngine
    let box: TestBox
    /// This Mac's engine settings file, where its box keeps them.
    static var file: URL { AppModel.engineFolders.configFile }

    /// `process`, `host` and `defaultsAdded` as `TestBox` has them. `settings`: the file's text before it
    /// starts (none: no file). `alongside`: beside a test's other stand-ins, as `StubEngine` has it.
    init(port: Int, process: BoxProcess = BoxProcess(), host: HostInterface = HostInterface(), defaultsAdded: Bool = true, settings: String? = nil, alongside: Bool = false) async throws {
        try? FileManager.default.removeItem(at: Self.file)
        if let settings {
            try FileManager.default.createDirectory(at: Self.file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(settings.utf8).write(to: Self.file)
        }
        engine = StubEngine(port: port, alongside: alongside)
        box = try await TestBox(engine: engine.url, process: process, host: host, defaultsAdded: defaultsAdded)
    }

    /// This Mac's link, for what it answers itself (its keys, in the Keychain).
    private let link = PhoneLink()

    /// Reached as a phone reaches it, through this Mac's link.
    var client: BoxClient {
        let base = URL(string: engine.url + "/")!
        let link = link
        return BoxClient(box: BoxClient.mac, transport: LocalBox { PhoneLink.respond(to: $0, link: link, engine: base, password: "test", agents: nil) })
    }

    /// What the file says now.
    static func onDisk() throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] ?? [:]
    }

    func stop() {
        box.stop()
        engine.stop()
        try? FileManager.default.removeItem(at: Self.file)
    }
}

/// A machine's box for a test: the same `kuvo-link.js serve` as this Mac's, run with Node, with a
/// folder of its own (`~/.kuvo-code` on a machine) whose settings are its own already, and the
/// popular servers its Mac leaves it. Reached over HTTP, where a Mac reaches a machine's over SSH:
/// the box answers the same.
@MainActor
final class MachineTestBox {
    let folder: URL
    /// Its machine's id, as this Mac names it.
    let name: String
    let server: ServerProcess
    /// Where it answers.
    var endpoint: ServerEndpoint { server.endpoint }

    /// `folder`: its `~/.kuvo-code`, when a test gives one (a machine its moves reach as files).
    /// `environment`: more for its process (`KUVO_TEST_SANDBOX_ON`, a box that may run a night).
    init(name: String = "lab", settings: [String: Any] = [:], folder: URL? = nil, environment: [String: String] = [:]) async throws {
        guard let node = TestBox.node else { throw TestFailure("Node runs the boxes in the tests, and there's none.") }
        let folder = folder ?? AppInfo.testRoot.appending(path: "Machines/\(name)-\(UUID().uuidString.prefix(8))")
        self.folder = folder
        self.name = name
        let manager = FileManager.default
        try manager.createDirectory(at: folder.appending(path: "box/keys"), withIntermediateDirectories: true)
        try manager.createDirectory(at: folder.appending(path: "bin"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: settings).write(to: folder.appending(path: "box/opencode.json"))
        try MachineBox.catalogJSON().write(to: folder.appending(path: "bin/mcp-catalog.json"))
        // What it makes its bots with, as this Mac puts it there (`MachineBox.install`).
        try BotWords.data.write(to: folder.appending(path: "bin/\(BotWords.fileName)"))
        let script = try Bridge.scriptURL.orThrow("The box's script isn't in the app.")
        server = try await ServerProcess.start(executable: node, arguments: [script.path, "serve"],
                                               environment: ["KUVO_HOME": folder.path, "PATH": "/usr/bin:/bin"].merging(environment) { _, given in given }, directory: folder)
        StubWeb.letThrough(port: server.endpoint.url.port ?? 0)
    }

    var client: BoxClient {
        let endpoint = server.endpoint
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        return BoxClient(box: name, transport: LocalBox { EngineRoutes.forward($0, to: base, password: endpoint.password, allowing: { path, _ in path.hasPrefix("kuvo/") }) })
    }

    /// Its settings file, as it is now.
    func onDisk() throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appending(path: "box/opencode.json"))) as? [String: Any] ?? [:]
    }

    /// One of its integrations' keys, as it keeps it.
    func key(_ name: String) -> String? {
        try? String(contentsOf: folder.appending(path: "box/keys/\(name)"), encoding: .utf8)
    }

    func stop() {
        server.stop()
        try? FileManager.default.removeItem(at: folder)
    }
}

private extension Optional {
    func orThrow(_ why: String) throws -> Wrapped {
        guard let self else { throw TestFailure(why) }
        return self
    }
}
