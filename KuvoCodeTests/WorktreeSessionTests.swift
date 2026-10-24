import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// B8: a session in a worktree, worked in and merged back. The session starts on a branch of its
/// own, named after its title once it has one; its work merges into the branch the project was
/// on; the worktree goes only with what you were told about; and the archived session stays
/// with its project. Real git; the engine is stubbed, making and removing worktrees with git as
/// it does.
@MainActor
@Suite(.serialized) struct WorktreeSessionTests {
    static let engine = "http://127.0.0.1:47994"
    let repository: TestRepository
    let workspace = Workspace()
    let engineState = EngineState()

    /// The sessions the stubbed engine has, as it would list them.
    nonisolated final class EngineState: @unchecked Sendable {
        private let lock = NSLock()
        private var sessions: [String: [String: Any]] = [:]
        func add(_ session: [String: Any]) { lock.withLock { sessions[session["id"] as! String] = session } }
        func rename(_ id: String, _ title: String) { lock.withLock { sessions[id]?["title"] = title } }
        func session(_ id: String) -> [String: Any]? { lock.withLock { sessions[id] } }
        var all: [[String: Any]] { lock.withLock { Array(sessions.values) } }
    }

    private static let defaultsKeys = ["worktrees", "removedWorktrees", "projectFolders", "projectSettings"]

    init() throws {
        TestEnvironment.prepare()
        for key in Self.defaultsKeys { UserDefaults.standard.removeObject(forKey: key) }
        repository = try TestRepository()
        try repository.write("README.md", "# Shop\n")
        try repository.commitAll("First")
        StubWeb.start(hosts: ["127.0.0.1"])
        let state = engineState, engine = Self.engine
        StubWeb.route(engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        StubWeb.route(engine + "/api/location") { request in
            let directory = request.queryItems?.first { $0.name == "directory" }?.value ?? ""
            return StubWeb.json(["directory": directory, "project": ["id": "prj_shop", "directory": directory, "canonical": directory]])
        }
        // As the engine makes them: a detached worktree beside the project, named for it.
        let parent = URL(filePath: workspace.folderPath(repository.path)).deletingLastPathComponent()
        StubWeb.handle(engine + "/api/worktree") { request, body in
            let sent = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            if request.httpMethod == "POST" {
                let folder = parent.appending(path: "worktrees/brave-otter").path
                guard Self.engineGit(["worktree", "add", "--detach", folder]) else { return StubWeb.json([:], status: 400) }
                return StubWeb.json(["directory": folder])
            }
            let force = sent["force"] as? Bool == true
            return Self.engineGit(["worktree", "remove"] + (force ? ["--force"] : []) + [sent["directory"] as? String ?? ""])
                ? StubWeb.json([:]) : StubWeb.json(["error": "git refused"], status: 400)
        }
        StubWeb.handle(engine + "/api/session/") { request, body in
            let path = request.url?.path() ?? ""
            if path.contains("/instructions/") { return StubWeb.json([:]) }
            let id = path.split(separator: "/").last.map(String.init) ?? ""
            return state.session(id).map { StubWeb.json(["data": $0]) } ?? StubWeb.json([:], status: 404)
        }
        StubWeb.handle(engine + "/api/session") { request, body in
            guard request.httpMethod == "POST" else { return StubWeb.json(["data": state.all]) }
            let sent = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            let session: [String: Any] = [
                "id": "ses_tree", "projectID": "prj_shop", "cost": 0,
                "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
                "time": ["created": 1, "updated": 2], "location": sent["location"] ?? [:], "agent": "build",
            ]
            state.add(session)
            return StubWeb.json(["data": session])
        }
        workspace.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine)!, password: "test"))
        Self.projectRoot = workspace.folderPath(repository.path)
    }

    nonisolated(unsafe) private static var projectRoot = ""

    /// git in the project's repository, as the engine runs it.
    nonisolated private static func engineGit(_ arguments: [String]) -> Bool {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = ["-C", projectRoot] + arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return false }
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    private func done() {
        StubWeb.stop()
        for key in Self.defaultsKeys { UserDefaults.standard.removeObject(forKey: key) }
        _ = Self.engineGit(["worktree", "prune"])
        try? FileManager.default.removeItem(at: repository.url.deletingLastPathComponent().appending(path: "worktrees"))
    }

    private func renamed(_ id: String, _ title: String) throws {
        engineState.rename(id, title)
        workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.renamed", "created": 1, "data": ["sessionID": id, "title": title]])))
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<300 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }

    private func git(_ arguments: String..., in folder: String) throws -> String {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = ["-C", folder] + arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @Test func aWorktreeSessionFromStartToMerge() async throws {
        defer { done() }
        let session = try await workspace.createSession(in: repository.path, model: nil, agent: "build", worktree: true)
        let folder = session.location.directory
        let tree = try #require(workspace.worktrees[folder])
        // Its own branch, from the branch the project is on, apart from the project's folder.
        #expect(tree.base == "main")
        #expect(try git("symbolic-ref", "--short", "HEAD", in: folder) == tree.branch)
        #expect(workspace.projectDirectory(of: session) == workspace.folderPath(repository.path))

        // Once it has a title, the branch is named after it.
        try renamed(session.id, "Fix the checkout total")
        try await until { workspace.worktrees[folder]?.branch == "kuvo/fix-the-checkout-total" }
        let branch = try #require(workspace.worktrees[folder]?.branch)
        #expect(branch == "kuvo/fix-the-checkout-total")
        #expect(try git("symbolic-ref", "--short", "HEAD", in: folder) == branch)

        // The agent's work, not committed yet: nothing merges, and the worktree isn't removed
        // without saying its changes go.
        try Data("total = sum(items)\n".utf8).write(to: URL(filePath: folder).appending(path: "checkout.py"))
        let named = try #require(workspace.worktrees[folder])
        guard case .failed(let notCommitted) = named.mergeBack(from: folder, environment: [:]) else { Issue.record("merged uncommitted work"); return }
        #expect(notCommitted.contains("Commit the changes first"))
        await #expect(throws: GitFailure.self) { try await workspace.removeWorktree(folder, discardingChanges: false) }
        #expect(FileManager.default.fileExists(atPath: folder))

        // Committed: it merges into main, in the project's folder.
        _ = try git("add", "-A", in: folder)
        _ = try git("commit", "-q", "-m", "Fix the total", in: folder)
        #expect(named.mergeBack(from: folder, environment: [:]) == .merged(into: "main"))
        #expect(repository.read("checkout.py") == "total = sum(items)\n")
        #expect(named.mergeBack(from: folder, environment: [:]) == .failed("\(branch) has nothing main doesn’t have yet."))

        // Removed, then archived: the worktree and its merged branch go; the session is still the
        // project's.
        try await workspace.removeWorktree(folder, discardingChanges: false)
        #expect(!FileManager.default.fileExists(atPath: folder))
        #expect(try git("branch", "--list", branch, in: repository.path).isEmpty)
        #expect(workspace.projectDirectory(of: session) == workspace.folderPath(repository.path))
    }

    /// The project's folder switched to another branch since: Merge says so rather than merging
    /// into that one.
    @Test func mergeOnlyIntoTheBranchItCameFrom() async throws {
        defer { done() }
        let session = try await workspace.createSession(in: repository.path, model: nil, agent: "build", worktree: true)
        let folder = session.location.directory
        try Data("x\n".utf8).write(to: URL(filePath: folder).appending(path: "x.txt"))
        _ = try git("add", "-A", in: folder)
        _ = try git("commit", "-q", "-m", "x", in: folder)
        try repository.git("switch", "-q", "-c", "release")
        let tree = try #require(workspace.worktrees[folder])
        guard case .failed(let message) = tree.mergeBack(from: folder, environment: [:]) else { Issue.record("merged into release"); return }
        #expect(message.contains("on release now"))
        #expect(!repository.exists("x.txt"))
    }

    /// Settings › Worktrees from a phone: each worktree with what to know before removing it
    /// (changes not committed, commits its base doesn't have, an agent at work), and removed as
    /// the page removes it, but not while its agent works.
    /// What a paired phone asks this Mac, as it answers it.
    private func ask(_ link: PhoneLink, _ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]) {
        let request = LinkRequest(method: method, path: path, headers: [:], body: try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data())
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: Self.engine)!, password: nil, agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): answer += chunk
            }
        }
        return (status, (try? JSONSerialization.jsonObject(with: answer) as? [String: Any]) ?? [:])
    }

    /// A phone starts a session in a new worktree, as the composer's Worktree does: this Mac makes
    /// the worktree on a branch of its own, the phone makes the session in its folder, and the
    /// session is told it works there.
    @Test func aPhoneStartsASessionInANewWorktree() async throws {
        defer { done() }
        let link = PhoneLink()
        link.workspace = workspace
        let told = Sent()
        StubWeb.handle(Self.engine + "/api/experimental/session/") { request, _ in
            told.add(request.url?.path() ?? "")
            return StubWeb.json([:])
        }
        let made = try await ask(link, "kuvo/worktrees", method: "POST", body: ["project": repository.path])
        #expect(made.status == 200)
        let folder = try #require(made.json["folder"] as? String)
        #expect(made.json["branch"] as? String == workspace.worktrees[folder]?.branch)
        #expect(try git("symbolic-ref", "--short", "HEAD", in: folder) == made.json["branch"] as? String)
        // The phone's session, made there through the engine.
        engineState.add(["id": "ses_phone", "projectID": "prj_shop", "cost": 0, "agent": "build",
                         "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
                         "time": ["created": Date.now.timeIntervalSince1970 * 1000, "updated": Date.now.timeIntervalSince1970 * 1000],
                         "location": ["directory": folder]])
        workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.created", "created": 1, "data": ["sessionID": "ses_phone"]])))
        await workspace.reloading["ses_phone"]?.value
        await workspace.tellingWorktree["ses_phone"]?.value
        #expect(told.all == ["/api/experimental/session/ses_phone/instructions/entries/kuvo.worktree"])
        #expect(try await ask(link, "kuvo/worktrees", method: "POST", body: ["project": "relative"]).status == 400)

        // Taken back as one whose session never started (`forget`): not while a session has it.
        let root = try #require(made.json["root"] as? String), branch = try #require(made.json["branch"] as? String)
        let forget: [String: Any] = ["path": root, "discard": true, "forget": true]
        #expect(try await ask(link, "kuvo/worktrees/remove", method: "POST", body: forget).status == 409)
        #expect(FileManager.default.fileExists(atPath: root))
        // Its session gone (it never started after all): gone with its branch, and not kept as a
        // worktree you removed (its folder isn't the project's any more).
        workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.deleted", "created": 1, "data": ["sessionID": "ses_phone"]])))
        #expect(try await ask(link, "kuvo/worktrees/remove", method: "POST", body: forget).status == 200)
        #expect(!FileManager.default.fileExists(atPath: root))
        #expect(try git("branch", "--list", branch, in: repository.path).isEmpty)
        #expect(workspace.projectDirectory(folder) == folder, "not one you removed")
    }

    /// Paths an engine was asked for.
    nonisolated final class Sent: @unchecked Sendable {
        private let lock = NSLock()
        private var paths: [String] = []
        func add(_ path: String) { lock.withLock { paths.append(path) } }
        var all: [String] { lock.withLock { paths } }
    }

    @Test func aPhoneListsAndRemovesWorktrees() async throws {
        defer { done() }
        let link = PhoneLink()
        link.workspace = workspace
        func ask(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]) {
            try await self.ask(link, path, method: method, body: body)
        }
        let session = try await workspace.createSession(in: repository.path, model: nil, agent: "build", worktree: true)
        let folder = session.location.directory
        let tree = try #require(workspace.worktrees[folder])
        try Data("x\n".utf8).write(to: URL(filePath: folder).appending(path: "x.txt"))
        _ = try git("add", "-A", in: folder)
        _ = try git("commit", "-q", "-m", "x", in: folder)
        try Data("y\n".utf8).write(to: URL(filePath: folder).appending(path: "y.txt"))

        let listed = try #require(try await ask("kuvo/worktrees").json["worktrees"] as? [[String: Any]])
        let entry = try #require(listed.first)
        #expect(listed.count == 1)
        #expect(entry["path"] as? String == tree.root)
        #expect(entry["branch"] as? String == tree.branch)
        #expect(entry["base"] as? String == "main")
        #expect(entry["sessions"] as? Int == 1)
        #expect(entry["working"] as? Bool == false)
        #expect(entry["uncommitted"] as? Bool == true)
        #expect(entry["ahead"] as? Int == 1)
        #expect((entry["size"] as? Int ?? 0) > 0)
        #expect(entry["machine"] == nil)

        workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.execution.started", "created": 1, "data": ["sessionID": session.id]])))
        #expect((try await ask("kuvo/worktrees").json["worktrees"] as? [[String: Any]])?.first?["working"] as? Bool == true)
        let refused = try await ask("kuvo/worktrees/remove", method: "POST", body: ["path": tree.root])
        #expect(refused.status == 409)
        #expect((refused.json["message"] as? String)?.contains("An agent is still working") == true)
        workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.execution.interrupted", "created": 2, "data": ["sessionID": session.id]])))

        #expect(try await ask("kuvo/worktrees/remove", method: "POST", body: ["path": tree.root]).status == 200)
        #expect(!FileManager.default.fileExists(atPath: folder), "its changes go with it, as the page says")
        #expect((try await ask("kuvo/worktrees").json["worktrees"] as? [[String: Any]])?.isEmpty == true)
        #expect(try await ask("kuvo/worktrees/remove", method: "POST", body: ["path": tree.root]).status == 404)
    }

    /// What git can't say about a worktree isn't said as if it could (its base branch gone, its
    /// folder deleted by hand), and an engine that couldn't remove one says so as the engine's
    /// failure, not as a refusal.
    @Test func whatGitCantSayIsLeftOut() async throws {
        defer { done() }
        let link = PhoneLink()
        link.workspace = workspace
        let session = try await workspace.createSession(in: repository.path, model: nil, agent: "build", worktree: true)
        let tree = try #require(workspace.worktrees[session.location.directory])
        try repository.git("branch", "-m", "main", "trunk")
        let listed = try #require(try await ask(link, "kuvo/worktrees").json["worktrees"] as? [[String: Any]])
        #expect(listed.first?["uncommitted"] as? Bool == false)
        #expect(listed.first?["ahead"] == nil, "its base is gone: not none ahead")

        StubWeb.route(Self.engine + "/api/worktree", sent: { _, _ in StubWeb.json(["error": "The engine is busy"], status: 500) })
        #expect(try await ask(link, "kuvo/worktrees/remove", method: "POST", body: ["path": tree.root]).status == 502)

        try FileManager.default.removeItem(atPath: tree.root)
        let gone = try #require(try await ask(link, "kuvo/worktrees").json["worktrees"] as? [[String: Any]]).first
        #expect(gone?["uncommitted"] == nil && gone?["ahead"] == nil && gone?["size"] == nil)
    }

    /// A machine's worktree, while the machine isn't connected: removing it says so, and it stays.
    @Test func aMachinesWorktreeWaitsForItsMachine() async throws {
        defer { UserDefaults.standard.removeObject(forKey: "worktrees") }
        let folder = RemoteFolder.folder("/home/me/worktrees/brave-otter", on: "lab")
        let tree = Workspace.Worktree(project: RemoteFolder.folder("/home/me/shop", on: "lab"), root: folder, branch: "kuvo/brave-otter", base: "main")
        UserDefaults.standard.set(try JSONEncoder().encode([folder: tree]), forKey: "worktrees")
        let remembered = Workspace()
        let said = await #expect(throws: GitFailure.self) { try await remembered.removeWorktree(folder) }
        #expect(said?.message == "lab isn’t connected, so the worktree of kuvo/brave-otter can’t be removed now.")
        #expect(remembered.worktrees[folder] == tree)
    }

    /// While its agent works there, the worktree stays, whatever you were told.
    @Test func notRemovedWhileItsAgentWorks() async throws {
        defer { done() }
        let session = try await workspace.createSession(in: repository.path, model: nil, agent: "build", worktree: true)
        workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": "session.execution.started", "created": 1, "data": ["sessionID": session.id]])))
        await #expect(throws: GitFailure.self) { try await workspace.removeWorktree(session.location.directory, discardingChanges: true) }
        #expect(FileManager.default.fileExists(atPath: session.location.directory))
    }
}
