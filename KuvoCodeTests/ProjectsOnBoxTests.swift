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
    let box: TestBox
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
        for key in ["projectFolders", "projectSettings", "projectsOnBox.mac", "projectsOnBox.lab", "projectsUnsent", "worktrees"] { UserDefaults.standard.removeObject(forKey: key) }
        try? FileManager.default.removeItem(at: BoxProcess.home)
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        box = try await TestBox(engine: engine.url)
    }

    private func done() {
        box.stop()
        engine.stop()
        for key in ["projectFolders", "projectSettings", "projectsOnBox.mac", "projectsOnBox.lab", "projectsUnsent", "worktrees"] { UserDefaults.standard.removeObject(forKey: key) }
        try? FileManager.default.removeItem(at: BoxProcess.home)
        try? FileManager.default.removeItem(at: work)
    }

    /// The app's Workspace, as AppModel wires it: this Mac's box reached as a phone reaches it.
    private func workspace() -> Workspace {
        let workspace = Workspace()
        workspace.api = engine.api
        let box = box, url = engine.url
        workspace.boxes = { id in id == BoxClient.mac ? box.client(engine: url) : nil }
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
        // The app asking isn't a phone using this box (what holds phones' notices goes by that).
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.run.appending(path: "link.seen").path))
    }

    /// What's changed while this Mac's box is away (stopped, or not up yet) waits, shown as it
    /// is here, and reaches the box when it's back: a list read meanwhile doesn't undo it.
    @Test func aChangeWhileTheBoxIsAwayWaitsForIt() async throws {
        defer { done() }
        let workspace = workspace()
        await workspace.loadProjects(on: BoxClient.mac)
        workspace.saveProject(shop, settings: .init(name: "Shop"))
        await workspace.projectsWritten()

        box.process.stop()
        workspace.saveProject(shop, settings: .init(name: "Storefront"))
        await workspace.projectsWritten()
        await workspace.loadProjects(on: BoxClient.mac)
        #expect(workspace.projectName(shop) == "Storefront")

        await box.startAgain()
        await workspace.loadProjects(on: BoxClient.mac)
        #expect(workspace.projectName(shop) == "Storefront")
        #expect(try await onBox(workspace).first { $0.directory == shop }?.name == "Storefront")
    }

    /// The first time, a project removed before boxes kept their own goes there with its
    /// settings, as removed, so one of its sessions brought back brings it back as it was.
    @Test func aRemovedProjectsSettingsGoToTheBoxToo() async throws {
        defer { done() }
        UserDefaults.standard.set([shop], forKey: "projectFolders")
        UserDefaults.standard.set(try JSONEncoder().encode([blog: Workspace.ProjectSettings(name: "Notes")]), forKey: "projectSettings")
        let workspace = workspace()
        await workspace.loadProjects(on: BoxClient.mac)
        let kept = try await onBox(workspace)
        #expect(kept.first { $0.directory == blog } == .init(directory: blog, name: "Notes", folders: [], removed: true))
        #expect(workspace.projectName(blog) == "Notes")
        #expect(!workspace.projects.contains { $0.directory == blog })
    }

    /// A machine found to be another's address: its projects go to the other's box.
    @Test func aFoldedMachinesProjectsGoToTheOthersBox() async throws {
        defer { done() }
        UserDefaults.standard.set([RemoteFolder.folder("/home/me/app", on: "old-address")], forKey: "projectFolders")
        UserDefaults.standard.set(true, forKey: "projectsOnBox.lab")
        let workspace = Workspace()
        let endpoint = try #require(box.process.endpoint)
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        // The machine's box, as SSH reaches it: here, this test's own box.
        workspace.boxes = { id in
            id == "lab" ? BoxClient(box: id, transport: LocalBox { EngineRoutes.forward($0, to: base, password: endpoint.password, allowing: { path, _ in path.hasPrefix("kuvo/") }) }) : nil
        }
        workspace.fold("old-address", into: "lab")
        await workspace.loadProjects(on: "lab")
        let lab = try await #require(workspace.boxes?("lab")).value([String: [Workspace.BoxProject]].self, "GET", "kuvo/projects")
        #expect(lab["projects"]?.map(\.directory) == ["/home/me/app"])
        #expect(workspace.folders == [RemoteFolder.folder("/home/me/app", on: "lab")])
    }

    /// Worktrees this Mac kept before its box kept them go to the box, so Remove Project there
    /// archives their sessions too.
    @Test func removeProjectReachesWorktreesKeptHereBefore() async throws {
        defer { done() }
        let tree = work.appending(path: "trees/brave-otter").path
        try FileManager.default.createDirectory(atPath: tree, withIntermediateDirectories: true)
        UserDefaults.standard.set(try JSONEncoder().encode([tree: Workspace.Worktree(project: shop, root: tree, branch: "kuvo/brave-otter", base: "main")]), forKey: "worktrees")
        engine.list([StubEngine.session("ses_shop", directory: shop, created: 20), StubEngine.session("ses_tree", directory: tree, created: 10)])
        let workspace = workspace()
        await workspace.refresh()
        await workspace.loadProjects(on: BoxClient.mac)
        #expect(workspace.projects.first { $0.directory == shop }?.sessions.map(\.id) == ["ses_shop", "ses_tree"])

        #expect(try await workspace.removeProject(shop) == 0)
        let patched = Set(engine.requests("PATCH", "").compactMap { request -> String? in
            ((request.body["metadata"] as? [String: Any])?["kuvo.archived"] as? Bool) == true ? String(request.path.split(separator: "/").last ?? "") : nil
        })
        #expect(patched == ["ses_shop", "ses_tree"])
        #expect(!workspace.projects.contains { $0.directory == shop })
        // Its box keeps the worktree now.
        struct Listed: Decodable { var worktrees: [Workspace.BoxWorktree] }
        let kept = try await #require(workspace.boxes?(BoxClient.mac)).value(Listed.self, "GET", "kuvo/worktrees?records=1")
        #expect(kept.worktrees.map(\.root) == [tree])
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
