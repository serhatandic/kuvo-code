import ClientDesign
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
@Suite(.serialized, .timeLimit(.minutes(1))) struct ProjectsOnBoxTests {
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
        for key in ["projectFolders", "projectSettings", "projectsOnBox.mac", "projectsOnBox.lab", "projectsUnsent", "worktrees", "removedWorktrees", "removedWorktreesHandedOver.mac"] { UserDefaults.standard.removeObject(forKey: key) }
        try? FileManager.default.removeItem(at: BoxProcess.home)
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        box = try await TestBox(engine: engine.url)
    }

    private func done() {
        box.stop()
        engine.stop()
        for key in ["projectFolders", "projectSettings", "projectsOnBox.mac", "projectsOnBox.lab", "projectsUnsent", "worktrees", "removedWorktrees", "removedWorktreesHandedOver.mac"] { UserDefaults.standard.removeObject(forKey: key) }
        try? FileManager.default.removeItem(at: BoxProcess.home)
        try? FileManager.default.removeItem(at: work)
    }

    /// The app's Workspace, as AppModel wires it: this Mac's box reached as a phone reaches it.
    private func workspace() -> Workspace {
        let workspace = Workspace()
        workspace.api = engine.api
        let box = box, url = engine.url
        workspace.boxes = { id in id == BoxClient.mac ? box.client(engine: url) : nil }
        // (Its session list from these sessions, filed where the box files their folders: `listed(for:)`.)
        engine.listing.answer(rest: box.client(engine: url).transport)
        return workspace
    }

    /// What the box keeps, read as another client (a phone) reads it.
    private func onBox(_ workspace: Workspace) async throws -> [Workspace.BoxProject] {
        struct Listed: Decodable { var projects: [Workspace.BoxProject] }
        return try await #require(workspace.boxes?(BoxClient.mac)).value(Listed.self, "GET", "kuvo/projects").projects
    }

    /// A project changed again while its last change is still on its way to its box: the box ends
    /// up with the latest, which a list read later doesn't undo.
    @Test func aChangeMadeWhileTheLastOneGoesReachesTheBox() async throws {
        defer { done() }
        let workspace = workspace()
        let held = HoldsFirstProjectChange(to: box.client(engine: engine.url).transport)
        workspace.boxes = { id in id == BoxClient.mac ? BoxClient(box: BoxClient.mac, transport: held) : nil }
        await workspace.refresh()
        await workspace.loadProjects(on: BoxClient.mac)
        workspace.addFolder(shop)
        await workspace.projectsWritten()
        held.holds = true
        workspace.saveProject(shop, settings: .init(name: "Shop"))
        await held.arrived()
        workspace.saveProject(shop, settings: .init(name: "Storefront"))
        held.open()
        await workspace.projectsWritten()
        #expect(try await onBox(workspace).first { $0.directory == shop }?.name == "Storefront")
        await workspace.loadProjects(on: BoxClient.mac)
        #expect(workspace.projects.first { $0.directory == shop }?.name == "Storefront")
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
        struct Listed: Decodable { var projects: [Workspace.BoxProject] }
        let lab = try await #require(workspace.boxes?("lab")).value(Listed.self, "GET", "kuvo/projects")
        #expect(lab.projects.map(\.directory) == ["/home/me/app"])
        #expect(workspace.folders == [RemoteFolder.folder("/home/me/app", on: "lab")])
    }

    /// A machine's project renamed or removed from another client (a phone) shows here while the
    /// machine is connected, as this Mac's own do, not only once the app is opened again.
    @Test func aMachinesProjectsChangedElsewhereShowHere() async throws {
        defer { done() }
        UserDefaults.standard.set(true, forKey: "projectsOnBox.lab")
        let workspace = Workspace()
        let endpoint = try #require(box.process.endpoint)
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        // The machine's box, as SSH reaches it: here, this test's own box.
        workspace.boxes = { id in
            id == "lab" ? BoxClient(box: id, transport: LocalBox { EngineRoutes.forward($0, to: base, password: endpoint.password, allowing: { path, _ in path.hasPrefix("kuvo/") }) }) : nil
        }
        let phone = try #require(workspace.boxes?("lab"))
        let app = RemoteFolder.folder("/home/me/app", on: "lab")
        // Followed from half a minute after it connects (its projects are read as it does).
        let clock = TestClock(), realClock = MachineClock.clock
        MachineClock.clock = { [clock] seconds in await clock.wait(seconds) }
        defer { MachineClock.clock = realClock }
        let following = Task { await workspace.followProjects(on: "lab") }
        defer { following.cancel() }
        try await until { clock.waits == [30] }
        clock.pass(30)
        _ = try await phone.send("PUT", "kuvo/projects?directory=" + Workspace.queryValue("/home/me/app"), body: Data("{}".utf8))
        try await until { workspace.folders.contains(app) }
        _ = try await phone.send("PUT", "kuvo/projects?directory=" + Workspace.queryValue("/home/me/app"), body: Data(#"{"name":"Storefront"}"#.utf8))
        try await until { workspace.projectName(app) == "Storefront" }
        _ = try await phone.send("PUT", "kuvo/projects?directory=" + Workspace.queryValue("/home/me/app"), body: Data(#"{"removed":true}"#.utf8))
        try await until { !workspace.folders.contains(app) }
    }

    /// A machine removed while its projects were still to be read (waiting behind a change on its
    /// way there): nothing more is asked of it, and its projects don't come back.
    @Test func aMachineRemovedWhileItsProjectsWaitIsntAskedForThem() async throws {
        defer { done() }
        UserDefaults.standard.set(true, forKey: "projectsOnBox.lab")
        let workspace = Workspace()
        let endpoint = try #require(box.process.endpoint)
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        // The machine's box, as SSH reaches it: here, this test's own box.
        let held = HoldsFirstProjectChange(to: LocalBox { EngineRoutes.forward($0, to: base, password: endpoint.password, allowing: { path, _ in path.hasPrefix("kuvo/") }) })
        workspace.boxes = { id in id == "lab" ? BoxClient(box: id, transport: held) : nil }
        workspace.machines = ["lab"]
        let app = workspace.addFolder(RemoteFolder.folder("/home/me/app", on: "lab"))
        await workspace.projectsWritten()
        held.holds = true
        workspace.saveProject(app, settings: .init(name: "Storefront"))
        await held.arrived()
        let reading = Task { await workspace.loadProjects(on: "lab") }
        workspace.machines = []
        workspace.forget("lab", forGood: true)
        let asked = held.sent.count
        held.open()
        await reading.value
        await workspace.projectsWritten()
        #expect(Array(held.sent.dropFirst(asked)) == [], "nothing went to it once it was removed")
        #expect(!workspace.projects.contains { RemoteFolder.machine(of: $0.directory) == "lab" })
    }

    /// A worktree removed before its box kept them, whose session this Mac still shows under its
    /// project: Remove Project archives that session too, so it doesn't bring the project back.
    @Test func removeProjectReachesWorktreesRemovedBeforeTheBoxKeptThem() async throws {
        defer { done() }
        let tree = work.appending(path: "trees/long-gone").path
        UserDefaults.standard.set([tree: shop], forKey: "removedWorktrees")
        engine.list([StubEngine.session("ses_shop", directory: shop, created: 20), StubEngine.session("ses_tree", directory: tree, created: 10)])
        let workspace = workspace()
        await workspace.refresh()
        try await engine.listed(for: workspace)
        await workspace.loadProjects(on: BoxClient.mac)
        try await until { workspace.projects.first { $0.directory == shop }?.sessions.map(\.id) == ["ses_shop", "ses_tree"] }

        #expect(try await workspace.removeProject(shop) == 0)
        let patched = Set(engine.requests("PATCH", "").compactMap { request -> String? in
            ((request.body["metadata"] as? [String: Any])?["kuvo.archived"] as? Bool) == true ? String(request.path.split(separator: "/").last ?? "") : nil
        })
        #expect(patched == ["ses_shop", "ses_tree"])
    }

    /// A session in a worktree its box keeps (made by a bot, a phone or another client) is filed
    /// under its project as the box says, the same rule a phone goes by, though this Mac keeps no
    /// record of the worktree itself (#239).
    @Test func aSessionInAWorktreeShowsUnderTheProjectItsBoxNames() async throws {
        defer { done() }
        let tree = work.appending(path: "trees/swift-wolf").path
        try FileManager.default.createDirectory(at: BoxProcess.home.appending(path: "box"), withIntermediateDirectories: true)
        let records = ["worktrees": [["project": shop, "root": tree, "folder": tree, "branch": "kuvo/swift-wolf"]]]
        try JSONSerialization.data(withJSONObject: records).write(to: BoxProcess.home.appending(path: "box/worktrees.json"))
        engine.list([StubEngine.session("ses_shop", directory: shop, created: 20), StubEngine.session("ses_tree", directory: tree, created: 10)])
        let workspace = workspace()
        await workspace.refresh()
        try await engine.listed(for: workspace)
        await workspace.loadProjects(on: BoxClient.mac)
        try await until { workspace.projects.first { $0.directory == shop }?.sessions.map(\.id) == ["ses_shop", "ses_tree"] }
        #expect(!workspace.projects.contains { $0.directory == tree }, "the worktree isn't a project of its own")
    }

    /// A session an agent starts in a new worktree (start_session with worktree) shows under its
    /// project from its first listing, though this Mac hears of it from its engine before its box's
    /// projects say whose the worktree is: it carries its project as it's made (#311). One moved
    /// out of that worktree since goes by where it is now.
    @Test func aSessionStartedInANewWorktreeShowsUnderItsProjectBeforeItsBoxListsTheWorktree() async throws {
        defer { done() }
        let tree = work.appending(path: "trees/proud-eagle-2").path
        let made = ["kuvo": ["startedBy": "ses_lead", "filed": ["folder": tree, "project": shop]]]
        engine.list([
            StubEngine.session("ses_shop", directory: shop, created: 10),
            StubEngine.session("ses_tree", title: "#440 composer icons", directory: tree, created: 20, extra: ["metadata": made]),
            StubEngine.session("ses_moved", directory: blog, created: 5, extra: ["metadata": ["kuvo": ["filed": ["folder": tree, "project": shop]]]]),
        ])
        let workspace = workspace()
        await workspace.refresh()
        try await engine.listed(for: workspace)
        #expect(workspace.projects.first { $0.directory == shop }?.sessions.map(\.id) == ["ses_tree", "ses_shop"])
        #expect(!workspace.projects.contains { $0.directory == tree }, "never a project named after the worktree")
        #expect(workspace.projects.first { $0.directory == blog }?.sessions.map(\.id) == ["ses_moved"], "moved out of it since: where it is now")

        // Its box's word, when it comes, leaves it where it is.
        try FileManager.default.createDirectory(at: BoxProcess.home.appending(path: "box"), withIntermediateDirectories: true)
        let records = ["worktrees": [["project": shop, "root": tree, "folder": tree, "branch": "kuvo/440-composer-icons"]]]
        try JSONSerialization.data(withJSONObject: records).write(to: BoxProcess.home.appending(path: "box/worktrees.json"))
        await workspace.loadProjects(on: BoxClient.mac)
        #expect(workspace.projects.first { $0.directory == shop }?.sessions.map(\.id) == ["ses_tree", "ses_shop"])
    }

    /// A session an agent started in one of a project's other folders (start_session with the
    /// project and that folder) shows under the project, as its box files it, those started before
    /// it said so too; the folder isn't a project of its own (#311).
    @Test func aSessionInAProjectsOtherFolderShowsUnderTheProject() async throws {
        defer { done() }
        try FileManager.default.createDirectory(at: BoxProcess.home.appending(path: "box"), withIntermediateDirectories: true)
        let projects = ["version": 1, "projects": [["directory": shop, "name": "Kuvo Code", "folders": [blog]]]] as [String: Any]
        try JSONSerialization.data(withJSONObject: projects).write(to: BoxProcess.home.appending(path: "box/projects.json"))
        engine.list([StubEngine.session("ses_shop", directory: shop, created: 10), StubEngine.session("ses_web", title: "kuvo-web: Vercel Web Analytics", directory: blog, created: 20)])
        let workspace = workspace()
        await workspace.refresh()
        try await engine.listed(for: workspace)
        await workspace.loadProjects(on: BoxClient.mac)
        try await until { workspace.projects.first { $0.directory == shop }?.sessions.map(\.id) == ["ses_web", "ses_shop"] }
        #expect(!workspace.projects.contains { $0.directory == blog }, "the other folder isn't a project of its own")
        #expect(try await onBox(workspace).map(\.directory) == [shop], "nor does its box keep one")
    }

    /// The sidebar is told when its box's word on a worktree changes where a session is filed, by
    /// itself (a machine's worktree, or one made with `git worktree add`, which this Mac keeps no
    /// record of), rather than showing the worktree as a project until something else changes.
    @Test func theSidebarRedrawsWhenItsBoxFilesAWorktreeUnderItsProject() async throws {
        defer { done() }
        let tree = work.appending(path: "trees/swift-wolf").path
        engine.list([StubEngine.session("ses_shop", directory: shop, created: 20), StubEngine.session("ses_tree", directory: tree, created: 10)])
        let workspace = workspace()
        await workspace.refresh()
        try await engine.listed(for: workspace)
        await workspace.loadProjects(on: BoxClient.mac)
        let told = OSAllocatedUnfairLock(initialState: false)
        withObservationTracking { _ = workspace.projects } onChange: { told.withLock { $0 = true } }
        try FileManager.default.createDirectory(at: BoxProcess.home.appending(path: "box"), withIntermediateDirectories: true)
        let records = ["worktrees": [["project": shop, "root": tree, "folder": tree, "branch": "kuvo/swift-wolf"]]]
        try JSONSerialization.data(withJSONObject: records).write(to: BoxProcess.home.appending(path: "box/worktrees.json"))
        await workspace.loadProjects(on: BoxClient.mac)
        // Its box's list says so as it changes.
        engine.listing.push()
        try await until { told.withLock { $0 } }
        try await until { workspace.projects.first { $0.directory == shop }?.sessions.map(\.id) == ["ses_shop", "ses_tree"] }
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
        try await engine.listed(for: workspace)
        await workspace.loadProjects(on: BoxClient.mac)
        engine.listing.push()
        try await until { workspace.projects.first { $0.directory == shop }?.sessions.map(\.id) == ["ses_shop", "ses_tree"] }

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
        try await engine.listed(for: workspace)
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
        try await until { workspace.projects.contains { $0.directory == blog } }
        // Kept on the box with its name, for when one of its sessions comes back.
        #expect(try await onBox(workspace).first { $0.directory == shop } == .init(directory: shop, name: "Shop", folders: [], removed: true))
    }

    /// A project's folders changed in Edit Project reach the session open in a tab at once, given by
    /// its box (you may write to it next), and no session merely loaded: a write makes each the
    /// newest, which would reshuffle the project's list. Those get them as they next open or run.
    @Test func changedFoldersReachTheSessionInATabThroughItsBoxAndNoneAtRest() async throws {
        defer { done() }
        engine.list([StubEngine.session("ses_open", directory: shop), StubEngine.session("ses_rest", directory: shop)])
        for id in ["ses_open", "ses_rest"] {
            engine.on("GET", "/api/session/\(id)", json: ["data": StubEngine.session(id, directory: shop)])
            engine.on("PUT", "/api/experimental/session/\(id)/instructions/entries/*", json: [:])
        }
        let workspace = workspace()
        await workspace.refresh()
        await workspace.loadProjects(on: BoxClient.mac)
        workspace.saveProject(shop, settings: .init(name: "Shop"))
        await workspace.projectsWritten()
        for id in ["ses_open", "ses_rest"] { _ = try #require(workspace.model(for: id)) }
        for task in workspace.givingFolders { await task.value }
        let written = { (id: String) in engine.requests("PATCH", "/api/session/\(id)").filter { $0.body["permissions"] != nil }.count }
        let atRest = written("ses_rest")

        workspace.saveProject(shop, settings: .init(name: "Shop", folders: [blog]), shown: ["ses_open"])
        for task in workspace.givingFolders { await task.value }
        let rules = try #require(engine.requests("PATCH", "/api/session/ses_open").last?.body["permissions"] as? [[String: Any]])
        #expect(rules.contains { $0["action"] as? String == "external_directory" && $0["resource"] as? String == blog + "/*" && $0["effect"] as? String == "allow" })
        #expect(written("ses_rest") == atRest, "a session at rest isn't written")
    }
}

/// A box whose next project change (once `holds`) waits on its way there until it's `open`ed.
@MainActor
private final class HoldsFirstProjectChange: BoxTransport, @unchecked Sendable {
    nonisolated let inner: any BoxTransport
    var holds = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var came: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    private var hasArrived = false

    nonisolated init(to inner: any BoxTransport) { self.inner = inner }

    /// What was sent through it, in order ("GET kuvo/projects").
    private(set) var sent: [String] = []

    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
        sent.append(request.method + " " + request.path)
        guard request.method == "PUT", request.path.hasPrefix("kuvo/projects") else { return inner.send(request) }
        let inner = inner
        return AsyncThrowingStream { continuation in
            Task { @MainActor in
                await self.pass()
                do {
                    for try await part in inner.send(request) { continuation.yield(part) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    private func pass() async {
        guard holds, !isOpen else { return }
        holds = false
        hasArrived = true
        for each in came { each.resume() }
        came = []
        await withCheckedContinuation { waiting.append($0) }
    }

    func arrived() async {
        if hasArrived { return }
        await withCheckedContinuation { came.append($0) }
    }

    func open() {
        isOpen = true
        for each in waiting { each.resume() }
        waiting = []
    }
}
