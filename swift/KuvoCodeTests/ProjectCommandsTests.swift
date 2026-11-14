import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A project's own "/" commands (`.opencode/command`): opened while the engine was still starting,
/// they come once it's up, rather than only after you switch to another project and back, with
/// "/deploy staging" meanwhile going to the model as words. The engine is stubbed.
@MainActor
@Suite(.serialized) struct ProjectCommandsTests {
    let engine = StubEngine(port: 47_909)
    let folder = "/tmp/kuvo-tests-commands"

    @Test func aProjectsCommandsComeOnceTheEngineIsUp() async throws {
        defer { engine.stop() }
        let location = ["directory": "/"]
        let up = Gate()
        engine.on("GET", "/api/command") { request in
            // (A 503 is waited out, so a failure that isn't.)
            guard up.isOpen else { return StubWeb.json(["error": "not ready"], status: 500) }
            let asked = request.headers["x-opencode-directory"]?.removingPercentEncoding
            let own = asked == folder ? [["name": "deploy", "description": "Ship it"]] : []
            return StubWeb.json(["location": location, "data": own])
        }
        for path in ["/api/integration", "/api/model", "/api/agent"] { engine.on("GET", path, json: ["location": location, "data": []]) }
        engine.on("GET", "/api/model/default", json: ["location": location, "data": NSNull()])
        let catalog = Catalog()

        // Opened before the engine answers at all, then while it can't read the project yet.
        await catalog.loadCommands(in: folder)
        catalog.api = engine.api
        await catalog.loadCommands(in: folder)
        #expect(!catalog.commands(in: folder).contains { $0.name == "deploy" })

        up.open()
        await catalog.refresh()
        #expect(catalog.commands(in: folder).contains { $0.name == "deploy" }, "its own commands, once the engine is up")
    }
}
