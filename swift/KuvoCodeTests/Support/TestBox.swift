import Foundation
import KuvoLink
import OpenCodeKit
@testable import KuvoCode

/// This Mac's box for a test: the real `kuvo-link.js serve`, run with Node, as the app runs it
/// with the engine's Bun. It reaches the test's stand-in engine at its address, which listens on
/// its port for it (StubWeb answers there as it answers this process), keeps what it has in the
/// tests' folder, and sends the test copy's wake-ups. `stop()` stops it and leaves nothing behind.
@MainActor
final class TestBox {
    let process: BoxProcess
    /// What it asks the app for (the test copy's own Keychain, in memory): an app's own
    /// (`AppModel.host`), else one of its own.
    let host: HostInterface
    private let enginePort: UInt16

    /// Node, where it usually is (CI's, Homebrew's, nvm's).
    static var node: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let nvm = home.appending(path: ".nvm/versions/node")
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: nvm.path)) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        let candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node"] + versions.map { nvm.appending(path: "\($0)/bin/node").path }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }.map { URL(filePath: $0) }
    }

    /// Started, finding the engine at `engine` (StubWeb's, started already). `process`: an app's
    /// own (`AppModel.box`), else one of its own. `defaultsAdded`: it starts as one that added its
    /// defaults to this Mac's settings before (a test's settings stay as it gives them).
    /// `environment`: what else it runs with (GitHub's stand-in, `KUVO_TEST_GITHUB`).
    init(engine: String, password: String = "test", process: BoxProcess = BoxProcess(), host: HostInterface = HostInterface(), defaultsAdded: Bool = true, environment: [String: String] = [:]) async throws {
        guard let node = Self.node else { throw TestFailure("Node runs this Mac's box in the tests, and there's none.") }
        let url = try URL(string: engine).orThrow("Not an engine's address: \(engine)")
        self.process = process
        self.host = host
        enginePort = UInt16(url.port ?? 0)
        try? FileManager.default.removeItem(at: BoxProcess.home)
        if defaultsAdded { BoxProcess.noteDefaultsAdded(["bot-memory", "websearch", "search-exa"]) }
        try await StubWeb.listen(port: enginePort)
        // As the app starts it: its environment, and the app's own wake-up folders and kuvo-wake,
        // with which it sends this Mac's wake-ups.
        try WakeUps.installCommand()
        var environment = ProcessInfo.processInfo.environment.merging(environment) { _, given in given }
        environment["KUVO_BOTS"] = Bots.root.path
        environment["KUVO_WAKES"] = WakeUps.root.path
        environment["KUVO_WAKE_COMMAND"] = WakeUps.command.path
        environment["KUVO_KEYS_ON_HOST"] = "1"
        // A commit's hooks never get the shell's startup files of whoever runs the tests.
        environment["KUVO_TEST_LOGIN_ENV"] = "off"
        // As the app gives them (MacBoxRunner.boxEnvironment): the vault's secrets.
        environment["KUVO_HOST_VAULT_SECRET"] = host.vaultSecret
        environment["KUVO_VAULT_FILE_KEY"] = VaultValues.fileKey()
        // Never the opencode sign-ins of whoever runs the tests (`kuvo/accounts/found`): none.
        environment["KUVO_DEMO_OPENCODE_AUTH"] = BoxProcess.home.appending(path: "opencode-auth.json").path
        // Where its host interface answers, in its folder (`run/host.json`), as the app tells it.
        try await host.start()
        MachineBox.writeMacCatalog()
        await process.start(node: node, environment: environment)
        guard let endpoint = process.endpoint else { throw TestFailure("This Mac's box didn't start: \(process.failure ?? "")") }
        StubWeb.letThrough(port: endpoint.url.port ?? 0)
        BoxProcess.engineChanged(ServerEndpoint(url: url, password: password), version: "2.0.32", pid: getpid())
    }

    /// Its routes as the app's stores reach them (`AppModel.box`): through PhoneLink's answer,
    /// which hands what's moved onto the box to it.
    func client(engine: String, password: String = "test") -> BoxClient {
        let base = URL(string: engine.hasSuffix("/") ? engine : engine + "/")!
        return BoxClient(box: BoxClient.mac, transport: LocalBox { PhoneLink.respond(to: $0, link: nil, engine: base, password: password, agents: nil) })
    }

    /// Phones paired with this Mac before, as its box keeps them (`run/link.json`, which it reads
    /// each time): each a `key` (its public key, base64url), a `name` and its `pairing`, paired at
    /// `added`.
    func paired(_ phones: [(key: String, name: String, pairing: String)], added: Date = Date(timeIntervalSinceReferenceDate: 700_000_000)) throws {
        let file = BoxProcess.run.appending(path: "link.json")
        var link = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        link["phones"] = phones.map { ["key": $0.key, "name": $0.name, "added": added.timeIntervalSince1970, "from": "pair", "pairing": $0.pairing] }
        link["removed"] = link["removed"] ?? []
        try FileManager.default.createDirectory(at: BoxProcess.run, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: link).write(to: file, options: .atomic)
    }

    /// Started again after it stopped (`BoxProcess.startAgain`), at a port of its own.
    func startAgain() async {
        await process.startAgain()
        if let port = process.endpoint?.url.port { StubWeb.letThrough(port: port) }
    }

    /// Where the coding agents' bridge it's told of listens for it (`agents(at:)`).
    private var agentsPort: UInt16?

    /// The coding agents' bridge beside its engine, at `url`, as the app records it for the box
    /// (`run/bridge.json`): a test's stand-in there (a `StubEngine`, or `StubWeb`'s routes), which
    /// listens on its port for it, with `signedIn` installed and signed in.
    func agents(at url: String, password: String = "test", signedIn: [String] = ["claude-code"]) async throws {
        let address = try URL(string: url).orThrow("Not a bridge's address: \(url)")
        let port = UInt16(address.port ?? 0)
        agentsPort = port
        try await StubWeb.listen(port: port)
        for id in signedIn {
            let answer = StubWeb.json(["data": ["id": id, "name": id, "metadata": ["installed": true], "connections": [["type": "agent"]]]])
            StubWeb.route(url + "/api/integration/" + id) { _ in answer }
        }
        BoxProcess.agentsChanged(ServerEndpoint(url: address, password: password), pid: getpid())
    }

    func stop() {
        host.stop()
        process.stop()
        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        StubWeb.stopListening(port: enginePort)
        if let agentsPort {
            BoxProcess.agentsChanged(nil, pid: nil)
            StubWeb.stopListening(port: agentsPort)
        }
        try? FileManager.default.removeItem(at: BoxProcess.home)
    }
}

private extension Optional {
    func orThrow(_ why: String) throws -> Wrapped {
        guard let self else { throw TestFailure(why) }
        return self
    }
}
