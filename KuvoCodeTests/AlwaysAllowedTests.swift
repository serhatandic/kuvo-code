import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Settings › Permissions' Always Allowed (B10): what you allowed with Always, in every project a
/// session is in and in folders outside any, each once. The engine lists one project's at a time;
/// asked for none, the list showed nothing. The engine is stubbed.
@MainActor
@Suite(.serialized) struct AlwaysAllowedTests {
    let engine = StubEngine(port: 47987)
    let workspace = Workspace()

    init() {
        workspace.api = engine.api
    }

    private static func approval(_ id: String, _ project: String, _ action: String, _ resource: String) -> [String: Any] {
        ["id": id, "projectID": project, "action": action, "resource": resource]
    }

    @Test func everyProjectsApprovalsOnce() async throws {
        defer { engine.stop() }
        engine.list([
            StubEngine.session("ses_site", directory: "/tmp/kuvo-tests-site", extra: ["projectID": "prj_site"]),
            StubEngine.session("ses_api", directory: "/tmp/kuvo-tests-api", extra: ["projectID": "prj_api"]),
            StubEngine.session("ses_api2", directory: "/tmp/kuvo-tests-api", created: 2, extra: ["projectID": "prj_api"]),
        ])
        await workspace.refresh()
        let saved: [String: [[String: Any]]] = [
            "": [Self.approval("per_brew", "global", "shell", "brew list")],
            "prj_site": [Self.approval("per_npm", "prj_site", "shell", "npm test"), Self.approval("per_brew", "global", "shell", "brew list")],
            "prj_api": [Self.approval("per_src", "prj_api", "edit", "src/*")],
        ]
        let answers = saved.mapValues { StubWeb.json(["data": $0]) }
        engine.on("GET", "/api/permission/saved") { request in answers[request.query["projectID"] ?? ""] ?? StubWeb.json(["data": []]) }

        var shown: [PermissionsSettings.Saved] = []
        let listed = await PermissionsSettings.saved(from: [(engine.api, nil)], sessions: workspace.sessions) { shown = $0 }
        #expect(listed.map(\.permission.resource).sorted() == ["brew list", "npm test", "src/*"])
        #expect(shown.map(\.id) == listed.map(\.id), "shown as the engine answered")
        let asked = engine.requests("GET", "/api/permission/saved").map { $0.query["projectID"] ?? "" }
        #expect(asked.sorted() == ["", "prj_api", "prj_site"], "each project once, and the folders outside any")
    }
}
