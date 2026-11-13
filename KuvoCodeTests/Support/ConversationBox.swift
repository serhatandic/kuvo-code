import Foundation
import OpenCodeKit
@testable import KuvoCode

/// A conversation's box for a test of what its composer sends: the real `kuvo-link.js` (as a
/// `MachineTestBox` runs it), which reaches the test's stand-in engine where it listens and the
/// agents bridge where a test runs one, recorded as the app records them for its box
/// (`run/engine.json`, `run/bridge.json`). A "/" or "!" text goes there as it does in the app
/// (`kuvo/sessions/<id>/typed`), the keywords "/" offers come from it, and a message goes through it
/// (`kuvo/sessions/<id>/send`), which writes what the agent reads. Stop it with the test.
@MainActor
final class ConversationBox {
    let machine: MachineTestBox
    /// The stand-in engine's listener for it, where this started one.
    private var listener: StubListener?
    /// StubWeb's port it listens on for it, where it does.
    private var listening: UInt16?

    /// Its engine is `engine`, reached where `bridge` reaches it (one listener for both), else at a
    /// listener of its own.
    init(engine: StubEngine, bridge: RealBridge? = nil) async throws {
        machine = try await MachineTestBox(name: "conversation")
        let endpoint: ServerEndpoint
        if let bridge {
            endpoint = bridge.listener.endpoint
        } else {
            let listener = try await engine.listen()
            self.listener = listener
            endpoint = listener.endpoint
        }
        try record("engine.json", ["port": endpoint.url.port ?? 0, "password": endpoint.password ?? ""])
        if let bridge { try self.bridge(bridge) }
    }

    /// Its engine is StubWeb's routes at `engine` ("http://127.0.0.1:<port>"), listened on here.
    init(stubWeb engine: String) async throws {
        machine = try await MachineTestBox(name: "conversation")
        let port = UInt16(URL(string: engine)?.port ?? 0)
        try await StubWeb.listen(port: port)
        listening = port
        try record("engine.json", ["port": Int(port), "password": "test"])
    }

    /// Its agents bridge: `bridge`, running for real, as the app tells its box; none (it stopped).
    func bridge(_ bridge: RealBridge?) throws {
        guard let bridge, let endpoint = bridge.agents.address.endpoint, let pid = bridge.agents.processID else {
            try? FileManager.default.removeItem(at: run.appending(path: "bridge.json"))
            return
        }
        try record("bridge.json", ["port": endpoint.url.port ?? 0, "password": endpoint.password ?? "", "pid": Int(pid)])
    }

    /// `model`'s box is this one, and what "/" offers there is read.
    func serves(_ model: SessionModel) async {
        let client = machine.client
        model.box = { client }
        await model.readKeywords()
    }

    func stop() {
        machine.stop()
        listener?.stop()
        if let listening { StubWeb.stopListening(port: listening) }
    }

    private var run: URL { machine.folder.appending(path: "run") }

    private func record(_ name: String, _ value: [String: Any]) throws {
        try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: value).write(to: run.appending(path: name), options: .atomic)
    }
}

/// A test's box for its sessions: this Mac's own, as the app reaches it (`TestBox`), started as it
/// opens one and stopped with the test. What its messages go through, as in the app.
@MainActor
final class SessionsBox {
    private(set) var box: TestBox?

    /// Started once, for `workspace`'s sessions on this Mac, on `engine`.
    func start(_ engine: StubEngine, for workspace: Workspace) async throws {
        try await start(engine: engine.url, for: workspace)
    }

    /// The same, its engine StubWeb's routes at `engine` ("http://127.0.0.1:<port>"), listened on.
    func start(engine: String, for workspace: Workspace) async throws {
        if box == nil { box = try await TestBox(engine: engine) }
        guard let box else { return }
        let client = box.client(engine: engine)
        workspace.boxes = { $0 == BoxClient.mac ? client : nil }
    }

    func stop() {
        box?.stop()
        box = nil
    }
}
