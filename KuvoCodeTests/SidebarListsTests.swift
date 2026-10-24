import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The sidebar's lists: each project with its sessions, the latest first, the project worked in
/// last on top; chats apart; an archived session out of both, at once, and back when brought back.
/// The engine is stubbed.
@MainActor
@Suite(.serialized) struct SidebarListsTests {
    static let engine = "http://127.0.0.1:47995"
    let workspace = Workspace()

    private static func session(_ id: String, in directory: String, updated: Int, archived: Bool = false) -> [String: Any] {
        ["id": id, "projectID": "p", "cost": 0, "title": id,
         "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
         "time": ["created": 1, "updated": updated], "location": ["directory": directory],
         "metadata": archived ? ["kuvo.archived": true] : [:]]
    }

    /// The engine's sessions, as it keeps them: a session's metadata changed stays so when they're
    /// read again.
    private nonisolated final class EngineSessions: @unchecked Sendable {
        private let lock = NSLock()
        private var listed: [[String: Any]]
        /// Those it won't change, as a busy engine.
        private var refused: Set<String> = []

        init(_ listed: [[String: Any]]) { self.listed = listed }

        func add(_ session: [String: Any]) { lock.withLock { listed.append(session) } }
        func refuse(_ id: String) { lock.withLock { _ = refused.insert(id) } }

        func list() -> StubWeb.Answer { lock.withLock { StubWeb.json(["data": listed]) } }

        func change(_ request: URLRequest, _ body: Data) -> StubWeb.Answer {
            guard request.httpMethod == "PATCH", let id = request.url?.lastPathComponent else { return StubWeb.Answer(status: 404) }
            return lock.withLock {
                guard !refused.contains(id), let index = listed.firstIndex(where: { $0["id"] as? String == id }) else {
                    return StubWeb.json(["error": "busy"], status: 500)
                }
                if let metadata = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["metadata"] { listed[index]["metadata"] = metadata }
                return StubWeb.json(["data": [:]])
            }
        }
    }

    private let sessions = EngineSessions([
        Self.session("s_web_old", in: "/tmp/kuvo-tests/web", updated: 10),
        Self.session("s_web_new", in: "/tmp/kuvo-tests/web", updated: 50),
        Self.session("s_api", in: "/tmp/kuvo-tests/api", updated: 40),
        Self.session("s_gone", in: "/tmp/kuvo-tests/api", updated: 99, archived: true),
        Self.session("s_chat", in: Workspace.chatsFolder, updated: 30),
    ])

    init() async {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        let sessions = sessions
        StubWeb.route(Self.engine + "/api/session") { _ in sessions.list() }
        StubWeb.route(Self.engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        StubWeb.handle(Self.engine + "/api/session/") { request, body in sessions.change(request, body) }
        workspace.api = Self.api
        await workspace.refresh()
    }

    private static var api: OpenCodeAPI { OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine)!, password: "test")) }

    @Test func projectsWithTheirSessionsLatestFirst() {
        defer { StubWeb.stop() }
        let projects = workspace.projects.filter { $0.directory.hasPrefix("/tmp/kuvo-tests/") }
        #expect(projects.map(\.directory) == ["/tmp/kuvo-tests/web", "/tmp/kuvo-tests/api"])
        #expect(projects.first?.sessions.map(\.id) == ["s_web_new", "s_web_old"])
        // Archived: in neither list.
        #expect(projects.last?.sessions.map(\.id) == ["s_api"])
        #expect(workspace.chats.map(\.id) == ["s_chat"])
    }

    @Test func archivingTakesItOutAtOnceAndBack() async {
        defer { StubWeb.stop() }
        await workspace.setArchived("s_web_new", true)
        #expect(workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }?.sessions.map(\.id) == ["s_web_old"])
        #expect(workspace.projects.first?.directory == "/tmp/kuvo-tests/api")
        await workspace.setArchived("s_web_new", false)
        #expect(workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }?.sessions.map(\.id) == ["s_web_new", "s_web_old"])
        await workspace.setArchived("s_chat", true)
        #expect(workspace.chats.isEmpty)
    }

    @Test func pinningMarksIt() async {
        defer { StubWeb.stop() }
        await workspace.setPinned("s_api", true)
        #expect(workspace.session("s_api").map(Workspace.isPinned) == true)
        await workspace.setPinned("s_api", false)
        #expect(workspace.session("s_api").map(Workspace.isPinned) == false)
    }

    /// Remove Project…: every session of the project, its worktree's too, archived, so the project
    /// leaves the sidebar and stays gone when the sessions are read again, its sessions waiting in
    /// Archived Sessions; the other project stays as it was.
    @Test func removingAProjectArchivesItsSessions() async throws {
        defer {
            StubWeb.stop()
            UserDefaults.standard.removeObject(forKey: "worktrees")
        }
        let tree = Workspace.Worktree(project: "/tmp/kuvo-tests/web", root: "/tmp/kuvo-tests/trees/brave-otter", branch: "kuvo/brave-otter", base: "main")
        UserDefaults.standard.set(try JSONEncoder().encode([tree.root: tree]), forKey: "worktrees")
        sessions.add(Self.session("s_tree", in: tree.root, updated: 60))
        let workspace = Workspace()
        workspace.api = Self.api
        await workspace.refresh()
        let web = ["s_tree", "s_web_new", "s_web_old"]
        #expect(workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }?.sessions.map(\.id) == web)

        #expect(await workspace.removeProject("/tmp/kuvo-tests/web") == 0)
        #expect(workspace.projects.map(\.directory).filter { $0.hasPrefix("/tmp/kuvo-tests/") } == ["/tmp/kuvo-tests/api"])
        await workspace.refresh()
        #expect(workspace.projects.map(\.directory).filter { $0.hasPrefix("/tmp/kuvo-tests/") } == ["/tmp/kuvo-tests/api"])
        #expect(web.allSatisfy { workspace.session($0).map(Workspace.isArchived) == true })
        #expect(workspace.projects.first?.sessions.map(\.id) == ["s_api"])
    }

    /// A project with no sessions, one you added: it just leaves the sidebar.
    @Test func removingAnEmptyProject() async {
        defer { StubWeb.stop() }
        workspace.addFolder("/tmp/kuvo-tests/empty")
        #expect(workspace.projects.contains { $0.directory == "/tmp/kuvo-tests/empty" })
        #expect(await workspace.removeProject("/tmp/kuvo-tests/empty") == 0)
        #expect(!workspace.projects.contains { $0.directory == "/tmp/kuvo-tests/empty" })
    }

    /// A session the engine doesn't archive stays, and the project with it, so nothing goes out
    /// of sight unarchived; Remove Project… counts it.
    @Test func aSessionNotArchivedKeepsItsProject() async {
        defer {
            StubWeb.stop()
            for key in ["projectFolders", "projectSettings"] { UserDefaults.standard.removeObject(forKey: key) }
        }
        workspace.saveProject("/tmp/kuvo-tests/web", settings: .init(name: "Web", folders: ["/tmp/kuvo-tests/api"]))
        sessions.refuse("s_web_old")
        #expect(await workspace.removeProject("/tmp/kuvo-tests/web") == 1)
        let kept = workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }
        #expect(kept?.sessions.map(\.id) == ["s_web_old"])
        #expect(kept?.name == "Web" && kept?.settings.folders == ["/tmp/kuvo-tests/api"], "as it was")
    }

    /// A session of a removed project brought back from Archived Sessions brings the project back
    /// as it was, with its name and folders.
    @Test func aRemovedProjectComesBackAsItWas() async {
        defer {
            StubWeb.stop()
            for key in ["projectFolders", "projectSettings"] { UserDefaults.standard.removeObject(forKey: key) }
        }
        workspace.saveProject("/tmp/kuvo-tests/web", settings: .init(name: "Web", folders: ["/tmp/kuvo-tests/api"]))
        #expect(await workspace.removeProject("/tmp/kuvo-tests/web") == 0)
        #expect(!workspace.projects.contains { $0.directory == "/tmp/kuvo-tests/web" })
        await workspace.setArchived("s_web_new", false)
        let back = workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }
        #expect(back?.name == "Web" && back?.settings.folders == ["/tmp/kuvo-tests/api"])
    }
}
