import Foundation
import KuvoLink
import OpenCodeKit
import os
import Testing
@testable import KuvoCode

/// Projects kept on their box (PROTOCOL.md, "Projects"): this Mac's on its own box (the real
/// `kuvo-link.js serve`, run with Node), which every client changes, so what a phone does shows
/// here and what you do here reaches every client. Those this Mac kept before boxes had their
/// own move there once. Remove Project is the box's: it archives every session of the project,
/// older ones too. The engine is a stand-in, listening on its port so the box can reach it.
@MainActor
@Suite(.serialized) struct ProjectsOnBoxTests {
    static let port: UInt16 = 47_950
    let engine = StubEngine(port: Int(port))
    let box = BoxProcess()
    let work: URL
    let shop: String
    let blog: String

    init() async throws {
        // By its real path (/private/var/…), as the box keeps a folder.
        try FileManager.default.createDirectory(at: AppInfo.testRoot, withIntermediateDirectories: true)
        work = URL(filePath: MacBox.realPath(AppInfo.testRoot.path)).appending(path: "ProjectsOnBox/\(UUID().uuidString.prefix(8))")
        shop = work.appending(path: "shop").path
        blog = work.appending(path: "blog").path
        for folder in [shop, blog] { try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true) }
        for key in ["projectFolders", "projectSettings", "projectsOnBox.mac", "worktrees"] { UserDefaults.standard.removeObject(forKey: key) }
        try? FileManager.default.removeItem(at: BoxProcess.home)
        try StubWeb.listen(port: Self.port)
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        let node = try #require(MacBoxTests.node, "Node runs this Mac's box in the tests")
        await box.start(node: node)
        let endpoint = try #require(box.endpoint, "it started: \(box.failure ?? "")")
        StubWeb.letThrough(port: endpoint.url.port ?? 0)
        BoxProcess.engineChanged(engine.api.client.endpoint, version: "2.0.32", pid: getpid())
    }

    private func done() {
        box.stop()
        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        StubWeb.stopListening(port: Self.port)
        engine.stop()
        for key in ["projectFolders", "projectSettings", "projectsOnBox.mac", "worktrees"] { UserDefaults.standard.removeObject(forKey: key) }
        try? FileManager.default.removeItem(at: BoxProcess.home)
        try? FileManager.default.removeItem(at: work)
    }

    /// The app's Workspace, as AppModel wires it: this Mac's box reached as a phone reaches it.
    private func workspace() -> Workspace {
        let workspace = Workspace()
        workspace.api = engine.api
        let base = URL(string: engine.url + "/")!
        workspace.boxes = { id in
            id == BoxClient.mac ? BoxClient(box: id, transport: LocalBox { PhoneLink.respond(to: $0, link: nil, engine: base, password: "test", agents: nil) }) : nil
        }
        return workspace
    }

    /// What the box keeps, read as another client (a phone) reads it.
    private func onBox(_ workspace: Workspace) async throws -> [Workspace.BoxProject] {
        struct Listed: Decodable { var projects: [Workspace.BoxProject] }
        return try await #require(workspace.boxes?(BoxClient.mac)).value(Listed.self, "GET", "kuvo/projects").projects
    }

    @Test func projectsKeptHereBeforeGoToTheBoxAndChangesReachIt() async throws {
        defer { done() }
        // As an older Kuvo Code kept them.
        UserDefaults.standard.set([shop], forKey: "projectFolders")
        UserDefaults.standard.set(try JSONEncoder().encode([shop: Workspace.ProjectSettings(name: "Shop", folders: [blog], run: "npm run dev")]), forKey: "projectSettings")
        let workspace = workspace()
        await workspace.refresh()
        await workspace.loadProjects(on: BoxClient.mac)
        #expect(try await onBox(workspace) == [.init(directory: shop, name: "Shop", folders: [blog], run: "npm run dev")])
        #expect(workspace.projects.first { $0.directory == shop }?.name == "Shop")

        // Added and renamed here: there too.
        workspace.addFolder(blog)
        workspace.saveProject(shop, settings: .init(name: "Storefront", folders: [blog], run: "npm run dev"))
        await workspace.projectsWritten()
        let kept = try await onBox(workspace)
        #expect(kept.map(\.directory) == [blog, shop])
        #expect(kept.last?.name == "Storefront")

        // Changed by another client (a phone): here once read.
        let phone = try #require(workspace.boxes?(BoxClient.mac))
        _ = try await phone.send("PUT", "kuvo/projects?directory=" + Workspace.queryValue(blog), body: Data(#"{"name":"Notes"}"#.utf8))
        await workspace.loadProjects(on: BoxClient.mac)
        #expect(workspace.projectName(blog) == "Notes")
    }

    @Test func removeProjectArchivesItsSessionsThereAndKeepsItsSettings() async throws {
        defer { done() }
        engine.list([
            StubEngine.session("ses_new", directory: shop, created: 20),
            StubEngine.session("ses_old", directory: shop, created: 10),
            StubEngine.session("ses_blog", directory: blog, created: 5),
        ])
        let workspace = workspace()
        await workspace.refresh()
        await workspace.loadProjects(on: BoxClient.mac)
        workspace.saveProject(shop, settings: .init(name: "Shop"))

        #expect(try await workspace.removeProject(shop) == 0)
        // Archived on the engine by the box, every one of them, and here.
        let patched = Set(engine.requests("PATCH", "").compactMap { request -> String? in
            ((request.body["metadata"] as? [String: Any])?["kuvo.archived"] as? Bool) == true ? String(request.path.split(separator: "/").last ?? "") : nil
        })
        #expect(patched == ["ses_new", "ses_old"])
        #expect(["ses_new", "ses_old"].allSatisfy { workspace.session($0).map(Workspace.isArchived) == true })
        #expect(!workspace.projects.contains { $0.directory == shop })
        #expect(workspace.projects.contains { $0.directory == blog }, "another project stays")
        // Kept on the box with its name, for when one of its sessions comes back.
        #expect(try await onBox(workspace).first { $0.directory == shop } == .init(directory: shop, name: "Shop", folders: [], removed: true))
    }
}
