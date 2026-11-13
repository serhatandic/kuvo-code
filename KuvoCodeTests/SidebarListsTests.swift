import ClientSessions
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The sidebar's lists: each project with its sessions, the latest first, the project worked in
/// last on top; chats apart; an archived session out of both, at once, and back when brought back.
/// Remove Project here is a box's that can't keep its projects yet (a machine on an older Kuvo
/// Code), done here one session at a time; ProjectsOnBoxTests has a box's own. The engine is stubbed,
/// and what its box says of its sessions (`ListingBox`) follows what the engine lists.
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
        func all() -> [[String: Any]] { lock.withLock { listed } }
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

    /// This Mac's box's list of the engine's sessions, sent again as the engine's are read or changed.
    let listing = ListingBox(chats: Workspace.chatsFolder)
    var following: Task<Void, Never>?

    init() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        let sessions = sessions, listing = listing
        listing.list { sessions.all() }
        StubWeb.route(Self.engine + "/api/session") { _ in
            defer { listing.push() }
            return sessions.list()
        }
        StubWeb.route(Self.engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        StubWeb.handle(Self.engine + "/api/session/") { request, body in
            defer { listing.push() }
            return sessions.change(request, body)
        }
        workspace.api = Self.api
        await workspace.refresh()
        following = try await listing.follow(workspace)
    }

    private func done() {
        following?.cancel()
        StubWeb.stop()
        // (Kept for the next launch: not for the next test's.)
        SessionCopies.removeList(of: BoxClient.mac)
    }

    private static var api: OpenCodeAPI { OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine)!, password: "test")) }

    @Test func projectsWithTheirSessionsLatestFirst() {
        defer { done() }
        let projects = workspace.projects.filter { $0.directory.hasPrefix("/tmp/kuvo-tests/") }
        #expect(projects.map(\.directory) == ["/tmp/kuvo-tests/web", "/tmp/kuvo-tests/api"])
        #expect(projects.first?.sessions.map(\.id) == ["s_web_new", "s_web_old"])
        // Archived: in neither list.
        #expect(projects.last?.sessions.map(\.id) == ["s_api"])
        #expect(workspace.chats.map(\.id) == ["s_chat"])
    }

    /// Settings › Storage's Delete Old Sessions offers only what its box calls people's
    /// conversations: never a bot's, however long it's been quiet (deleting it would end the bot's
    /// conversation), one this Mac doesn't know is a bot's too, as its box says.
    @Test func deletingOldSessionsLeavesBotsConversations() async throws {
        defer { done() }
        sessions.add(Self.session("s_bot", in: "/tmp/kuvo-tests/web", updated: 5))
        listing.change { $0.botSessions = ["s_bot"] }
        await workspace.refresh()
        try await until { workspace.session("s_bot").flatMap { workspace.listKind(of: $0) } == .bot }
        #expect(!workspace.botSessions.contains("s_bot"))
        // (Older than 45 ms since 1970: all but the archived one, and the bot's left out.)
        #expect(workspace.oldSessions(unusedSince: 45, keepsPinned: true).map(\.id) == ["s_web_old", "s_chat", "s_api"])
    }

    /// A new session its box made (New Session, `kuvo/sessions`) has its row in its project at once,
    /// as the box's answer says, before its list tells of it.
    @Test func aNewSessionHasItsRowBeforeItsListSaysSo() async throws {
        defer { done() }
        let made = Self.session("s_new", in: "/tmp/kuvo-tests/web", updated: 60)
        workspace.boxes = { id in id == BoxClient.mac ? BoxClient(box: id, transport: Starts(made: made)) : nil }
        let session = try await workspace.createSession(in: "/tmp/kuvo-tests/web", model: nil, agent: "build")
        #expect(session.id == "s_new")
        #expect(workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }?.sessions.map(\.id) == ["s_new", "s_web_new", "s_web_old"])
    }

    /// A machine whose box is from before it listed its sessions: the sidebar says to update Kuvo
    /// Code there rather than file them by a rule of its own, and the worktrees this Mac removed
    /// there are kept to hand over once it's updated (the box refuses them until then).
    @Test func aMachineFromBeforeSessionListsSaysToUpdateIt() async throws {
        defer { done() }
        let machine = "m_lists_old"
        UserDefaults.standard.removeObject(forKey: "removedWorktreesHandedOver." + machine)
        defer { UserDefaults.standard.removeObject(forKey: "removedWorktreesHandedOver." + machine) }
        let old = OlderBox()
        workspace.boxes = { id in id == machine ? BoxClient(box: id, transport: old) : nil }
        let following = Task { await workspace.followSessionList(on: machine) }
        defer { following.cancel() }
        try await until { workspace.outdatedLists.contains(machine) }
        #expect(!workspace.isListed(machine))
        #expect(!UserDefaults.standard.bool(forKey: "removedWorktreesHandedOver." + machine))
        #expect(old.paths == ["kuvo/info"])
    }

    /// A box from before `sessions.list`: its features say so, and the list's route isn't there.
    private nonisolated final class OlderBox: BoxTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var asked: [String] = []
        var paths: [String] { lock.withLock { asked } }
        func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
            lock.withLock { asked.append(request.path) }
            let info = request.path == "kuvo/info"
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: info ? 200 : 404, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data((info ? #"{"features":["projects","worktrees"]}"# : "{}").utf8)))
                continuation.finish()
            }
        }
    }

    /// A box that makes a session as New Session asks (`kuvo/sessions`), and answers nothing else.
    private struct Starts: BoxTransport, @unchecked Sendable {
        let made: [String: Any]
        func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
            let answer: [String: Any]? = request.method == "POST" && request.path == "kuvo/sessions"
                ? ["session": made["id"] ?? "", "title": NSNull(), "folder": "/tmp/kuvo-tests/web", "project": "web", "info": made] : nil
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: answer == nil ? 404 : 200, headers: ["content-type": "application/json"]))
                continuation.yield(.body((try? JSONSerialization.data(withJSONObject: answer ?? [:])) ?? Data()))
                continuation.finish()
            }
        }
    }

    /// A chat is drawn as its box marks it (#571, `kuvo.chat`): in the chats, named Chats, whatever
    /// its folder is called there, and never a project of its own. One from a box from before the
    /// mark (`s_chat`) is still a chat by its folder.
    @Test func aChatItsBoxMarkedIsAChatWhateverItsFolder() async throws {
        defer { done() }
        var marked = Self.session("s_marked", in: "/tmp/kuvo-tests/box/chats", updated: 70)
        marked["metadata"] = ["kuvo": ["chat": "/tmp/kuvo-tests/box/chats"]]
        sessions.add(marked)
        await workspace.refresh()
        try await until { workspace.chats.map(\.id) == ["s_marked", "s_chat"] }
        #expect(!workspace.projects.contains { $0.directory == "/tmp/kuvo-tests/box/chats" })
        #expect(workspace.projectName(of: try #require(workspace.session("s_marked"))) == "Chats")
        #expect(workspace.projects.filter { $0.directory.hasPrefix("/tmp/kuvo-tests/") }.map(\.directory) == ["/tmp/kuvo-tests/web", "/tmp/kuvo-tests/api"])
    }

    /// A rename the engine doesn't take (a machine's connection dropped, an engine that's busy)
    /// goes back to the title it had, as a pin does, rather than looking saved until the next read.
    @Test func aRenameTheEngineDoesntTakeGoesBack() async {
        defer { done() }
        sessions.refuse("s_api")
        await workspace.rename("s_api", to: "Payments")
        #expect(workspace.session("s_api")?.title == "s_api")
        await workspace.rename("s_web_new", to: "Checkout")
        #expect(workspace.session("s_web_new")?.title == "Checkout")
    }

    @Test func archivingTakesItOutAtOnceAndBack() async {
        defer { done() }
        await workspace.setArchived("s_web_new", true)
        #expect(workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }?.sessions.map(\.id) == ["s_web_old"])
        #expect(workspace.projects.first?.directory == "/tmp/kuvo-tests/api")
        await workspace.setArchived("s_web_new", false)
        #expect(workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }?.sessions.map(\.id) == ["s_web_new", "s_web_old"])
        await workspace.setArchived("s_chat", true)
        #expect(workspace.chats.isEmpty)
    }

    @Test func pinningMarksIt() async {
        defer { done() }
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
            done()
            UserDefaults.standard.removeObject(forKey: "worktrees")
        }
        let tree = Workspace.Worktree(project: "/tmp/kuvo-tests/web", root: "/tmp/kuvo-tests/trees/brave-otter", branch: "kuvo/brave-otter", base: "main")
        UserDefaults.standard.set(try JSONEncoder().encode([tree.root: tree]), forKey: "worktrees")
        sessions.add(Self.session("s_tree", in: tree.root, updated: 60))
        // (Its box files the worktree's sessions under its project.)
        listing.change { $0.filed[tree.root] = tree.project }
        let workspace = Workspace()
        workspace.api = Self.api
        await workspace.refresh()
        let following = try await listing.follow(workspace)
        defer { following.cancel() }
        let web = ["s_tree", "s_web_new", "s_web_old"]
        try await until { workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }?.sessions.map(\.id) == web }

        #expect(try await workspace.removeProject("/tmp/kuvo-tests/web") == 0)
        #expect(workspace.projects.map(\.directory).filter { $0.hasPrefix("/tmp/kuvo-tests/") } == ["/tmp/kuvo-tests/api"])
        await workspace.refresh()
        #expect(workspace.projects.map(\.directory).filter { $0.hasPrefix("/tmp/kuvo-tests/") } == ["/tmp/kuvo-tests/api"])
        #expect(web.allSatisfy { workspace.session($0).map(Workspace.isArchived) == true })
        #expect(workspace.projects.first?.sessions.map(\.id) == ["s_api"])
    }

    /// A project with no sessions, one you added: it just leaves the sidebar.
    @Test func removingAnEmptyProject() async throws {
        defer { done() }
        workspace.addFolder("/tmp/kuvo-tests/empty")
        #expect(workspace.projects.contains { $0.directory == "/tmp/kuvo-tests/empty" })
        #expect(try await workspace.removeProject("/tmp/kuvo-tests/empty") == 0)
        #expect(!workspace.projects.contains { $0.directory == "/tmp/kuvo-tests/empty" })
    }

    /// A session the engine doesn't archive stays, and the project with it, so nothing goes out
    /// of sight unarchived; Remove Project… counts it.
    @Test func aSessionNotArchivedKeepsItsProject() async throws {
        defer {
            done()
            for key in ["projectFolders", "projectSettings"] { UserDefaults.standard.removeObject(forKey: key) }
        }
        workspace.saveProject("/tmp/kuvo-tests/web", settings: .init(name: "Web", folders: ["/tmp/kuvo-tests/api"]))
        sessions.refuse("s_web_old")
        #expect(try await workspace.removeProject("/tmp/kuvo-tests/web") == 1)
        let kept = workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }
        #expect(kept?.sessions.map(\.id) == ["s_web_old"])
        #expect(kept?.name == "Web" && kept?.settings.folders == ["/tmp/kuvo-tests/api"], "as it was")
    }

    /// A session of a removed project brought back from Archived Sessions brings the project back
    /// as it was, with its name and folders.
    @Test func aRemovedProjectComesBackAsItWas() async throws {
        defer {
            done()
            for key in ["projectFolders", "projectSettings"] { UserDefaults.standard.removeObject(forKey: key) }
        }
        workspace.saveProject("/tmp/kuvo-tests/web", settings: .init(name: "Web", folders: ["/tmp/kuvo-tests/api"]))
        #expect(try await workspace.removeProject("/tmp/kuvo-tests/web") == 0)
        #expect(!workspace.projects.contains { $0.directory == "/tmp/kuvo-tests/web" })
        await workspace.setArchived("s_web_new", false)
        let back = workspace.projects.first { $0.directory == "/tmp/kuvo-tests/web" }
        #expect(back?.name == "Web" && back?.settings.folders == ["/tmp/kuvo-tests/api"])
    }
}
