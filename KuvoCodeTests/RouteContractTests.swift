import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The route scenarios both boxes answer alike (`Packages/KuvoLink/Vectors/routes`, copied into this
/// bundle as `routes`), run against this Mac's box: PhoneLink's own answers, with the app's real
/// stores wired as AppModel wires them (`wirePhoneLink`) and their files in the tests' folder. Only
/// the engine is a stand-in: the same small engine the machine's runner stands in with
/// (`Packages/KuvoLink/Tests/Bridge/contract.test.js`, which runs the same scenarios against a
/// machine's bridge). How a scenario is written: CONTRIBUTING.md, "Route scenarios".
@MainActor
@Suite(.serialized) struct RouteContractTests {
    @Test(arguments: RouteScenarios.names) func scenario(_ name: String) async throws {
        let scenario = try #require(RouteScenarios.all.first { $0.name == name }?.scenario)
        let box = try MacBox()
        defer { box.finish() }
        try await box.run(scenario)
    }

    /// Every file was read, so a scenario missing from the bundle can't pass by not running.
    @Test func everyScenarioFileIsHere() throws {
        let folder = try #require(RouteScenarios.folder, "The routes folder isn't in the test bundle.")
        let files = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasSuffix(".json") }
        #expect(files.count >= 8)
        #expect(RouteScenarios.names.count >= 40)
        #expect(Set(RouteScenarios.all.map(\.name)).count == RouteScenarios.all.count, "each scenario has a name of its own")
        #expect(RouteScenarios.problems.isEmpty, "\(RouteScenarios.problems)")
    }

    /// Matching an answer and filling in a scenario as the machine's runner does (`routes/match`).
    @Test func bothRunnersMatchAndFillInAlike() throws {
        let file = try #require(RouteScenarios.folder).appending(path: "match/cases.json")
        let read = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let cases = read["cases"] as? [[String: Any]] ?? [], fills = read["filled"] as? [[String: Any]] ?? []
        #expect(cases.count > 40 && fills.count > 5)
        for each in cases {
            #expect((RouteMatch.mismatch(each["expected"] ?? NSNull(), each["actual"]) == nil) == (each["matches"] as? Bool), "\(each)")
        }
        let written = { (value: Any) in try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]) }
        for each in fills {
            let filled = RouteMatch.filled(each["template"] ?? "", each["vars"] as? [String: Any] ?? [:])
            #expect(try written(filled) == written(each["filled"] ?? NSNull()), "\(each)")
        }
    }

    /// The machine's runner sets its box up with what a Mac leaves on a machine (`routes/box`):
    /// these say it's still what this Mac's code writes. `scripts/route-vectors.sh` writes them again.
    @Test func theMachinesRunnerHasWhatAMacLeavesThere() throws {
        let files = RouteScenarios.boxFiles()
        if let path = ProcessInfo.processInfo.environment["KUVO_WRITE_ROUTE_VECTORS"] {
            let folder = URL(filePath: path)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            for (name, data) in files { try data.write(to: folder.appending(path: name)) }
            return
        }
        let folder = try #require(RouteScenarios.folder).appending(path: "box")
        for (name, data) in files {
            let kept = try Data(contentsOf: folder.appending(path: name))
            #expect(try RouteMatch.same(kept, data), "routes/box/\(name) isn't what this Mac writes now: run scripts/route-vectors.sh.")
        }
    }
}

// MARK: The scenarios

nonisolated enum RouteScenarios {
    private final class Marker {}

    static let folder: URL? = Bundle(for: Marker.self).url(forResource: "routes", withExtension: nil)

    /// Each scenario by its name (`<file>: <name>`, as the machine's runner names it).
    nonisolated(unsafe) static let all: [(name: String, scenario: [String: Any])] = load().scenarios
    /// What couldn't be read.
    nonisolated(unsafe) static let problems: [String] = load().problems
    /// Those this Mac answers: a machine's alone (`"only": "machine"`) aren't run here (the
    /// bridge's runner lists them as skipped there).
    static let names: [String] = all.filter { $0.scenario["only"] as? String != "machine" }.map(\.name)

    private static func load() -> (scenarios: [(name: String, scenario: [String: Any])], problems: [String]) {
        guard let folder, let files = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return ([], ["no routes folder"]) }
        var scenarios: [(name: String, scenario: [String: Any])] = []
        var problems: [String] = []
        for file in files.filter({ $0.hasSuffix(".json") }).sorted() {
            guard let data = try? Data(contentsOf: folder.appending(path: file)),
                  let read = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let list = read["scenarios"] as? [[String: Any]] else {
                problems.append(file)
                continue
            }
            for scenario in list { scenarios.append(("\(file): \(scenario["name"] as? String ?? "?")", scenario)) }
        }
        return (scenarios, problems)
    }

    /// What a Mac leaves on a machine that the machine's routes read: the integrations it offers,
    /// the popular MCP servers, and what a box makes bots with (its release's, without the version,
    /// which a box uses only to choose between a Mac's and its own).
    @MainActor static func boxFiles() -> [String: Data] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var kit = (try? JSONSerialization.jsonObject(with: encoder.encode(Bots.releaseKit()))) as? [String: Any] ?? [:]
        kit["version"] = nil
        let pretty = { (data: Data) -> Data in
            let value = (try? JSONSerialization.jsonObject(with: data)) ?? [:]
            return ((try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data()) + Data("\n".utf8)
        }
        return [
            "integrations.json": pretty(MachineBox.integrationsJSON()),
            "mcp-catalog.json": pretty(MachineBox.catalogJSON()),
            "bot-kit.json": pretty((try? JSONSerialization.data(withJSONObject: kit)) ?? Data()),
        ]
    }
}

// MARK: This Mac's box

/// This Mac's box for one scenario: its stores' files in the tests' folder, made fresh, the app's
/// stores on them (made once the first request goes, as the app is running by then), and the engine
/// a stand-in.
@MainActor
final class MacBox {
    let engine = StubEngine(port: 47_961)
    let state = EngineState()
    /// This Mac's box (`kuvo-link.js serve`), run with Node.
    let box = BoxProcess()
    let work: URL
    private(set) var app: AppModel?
    var vars: [String: Any] = [:]
    /// Bots given, for what they leave in the Keychain.
    private var bots: [String] = []
    private let previousMail = AgentMail.shared.app

    private static let support = AppInfo.supportDirectory
    private static let folders = EngineFolders(root: support.appending(path: "opencode"))
    private static var skills: URL { folders.configFile.deletingLastPathComponent().appending(path: "skills") }

    init() throws {
        TestEnvironment.prepare()
        work = URL(filePath: Self.realPath(AppInfo.testRoot.path)).appending(path: "RouteContract/\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: work.appending(path: "work"), withIntermediateDirectories: true)
        Self.forgetStores()
        try FileManager.default.createDirectory(at: Self.folders.configFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: Self.folders.configFile)
        vars = ["chats": Workspace.chatsFolder, "skills": Self.skills.path, "work": work.appending(path: "work").path, "keys": IntegrationKeys.folder.path]
        state.worktrees = work.appending(path: "worktrees").path
        let state = state
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            engine.on(method, "/api/*") { state.answer($0) }
        }
    }

    /// What the stores keep, gone: each scenario starts with an empty box, as the machine's does.
    private static func forgetStores() {
        let manager = FileManager.default
        for name in ["bots.json", "bots", "machine-bots.json", "wakes", "groups.json", "groups", "opencode/config/opencode", "box"] {
            try? manager.removeItem(at: support.appending(path: name))
        }
        for key in ["worktrees", "projectSettings", "botEditsWaiting"] { UserDefaults.standard.removeObject(forKey: key) }
        for personality in Personalities.shared.custom { Personalities.shared.delete(personality) }
        for name in IntegrationKeys.shared { _ = IntegrationKeys.set(nil, for: name) }
    }

    func finish() {
        box.stop()
        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        StubWeb.stopListening(port: 47_961)
        engine.stop()
        for bot in bots { for name in IntegrationKeys.variables(ofBot: bot) { _ = IntegrationKeys.set(nil, for: name) } }
        Self.forgetStores()
        AgentMail.shared.app = previousMail
        try? FileManager.default.removeItem(at: work)
    }

    // MARK: Running

    func run(_ scenario: [String: Any]) async throws {
        let steps = scenario["steps"] as? [[String: Any]] ?? []
        if let only = scenario["only"] as? String, only != "mac" { return }
        for (index, step) in steps.enumerated() {
            if let only = step["only"] as? String, only != "mac" { continue }
            let send = step["send"] as? String
            let at = "step \(index + 1)" + (send.map { " (\($0))" } ?? "")
            if let given = step["given"] as? [String: Any] {
                // (One a step, so both runners give them in the order written: the bridge's runner checks it.)
                #expect(given.count == 1, "\(at): one fixture a step")
                for (kind, value) in given { try await give(kind, RouteMatch.filled(value, vars) as? [String: Any] ?? [:], at: at) }
                if app != nil { await settle() }
            } else if let send {
                if app == nil { await start() }
                let parts = send.split(separator: " ", maxSplits: 1).map(String.init)
                let path = RouteMatch.filled(parts.count > 1 ? parts[1] : "", vars) as? String ?? ""
                let answer = try await ask(parts[0], path, body: step["body"].map { RouteMatch.filled($0, vars) })
                let expected = step["expect"] as? [String: Any]
                let expect = (expected?["mac"] ?? expected?["machine"]) != nil ? expected?["mac"] as? [String: Any] : expected
                if let expect = RouteMatch.filled(expect as Any, vars) as? [String: Any] {
                    #expect(answer.status == (expect["status"] as? Int), "\(at): status \(answer.status): \(String(decoding: answer.body.prefix(400), as: UTF8.self))")
                    if let type = expect["type"] as? String { #expect(answer.type.hasPrefix(type), "\(at): content-type \(answer.type), not \(type)") }
                    if let text = expect["text"] as? String { #expect(String(decoding: answer.body, as: UTF8.self) == text, "\(at): body") }
                    if let json = expect["json"] {
                        let why = RouteMatch.mismatch(json, try? JSONSerialization.jsonObject(with: answer.body, options: .fragmentsAllowed))
                        #expect(why == nil, "\(at): \(why ?? "")")
                    }
                }
                for (name, dotted) in step["save"] as? [String: String] ?? [:] {
                    let value = RouteMatch.value(at: dotted, in: try? JSONSerialization.jsonObject(with: answer.body))
                    vars[name] = try #require(value, "\(at): nothing at \(dotted) to save as \(name)")
                }
            } else if let wanted = RouteMatch.filled(step["engineGot"] as Any, vars) as? [String: Any] {
                let method = wanted["method"] as? String ?? "", path = wanted["path"] as? String ?? ""
                let got = try #require(engine.requests(method, path).last { $0.path == path }, "\(at): the engine got no \(method) \(path): \(engine.asked)")
                let why = RouteMatch.mismatch(wanted["json"] ?? [String: Any](), got.body, at: "sent")
                #expect(why == nil, "\(at): \(why ?? "")")
            } else {
                Issue.record("\(at): a step gives, sends or checks what the engine got")
            }
        }
    }

    /// The app, as it is once its engine is up: its stores wired as AppModel's start wires them,
    /// and what it reads as it goes (its sessions, and the wake-ups its rounds read) read now.
    private func start() async {
        // This Mac's box, for the areas that have moved onto it, reaching the stand-in engine at
        // its port as it reaches the engine.
        if let node = MacBoxTests.node {
            try? StubWeb.listen(port: 47_961)
            await box.start(node: node)
            if let port = box.endpoint?.url.port { StubWeb.letThrough(port: port) }
            BoxProcess.engineChanged(engine.api.client.endpoint, version: "2.0.32", pid: getpid())
        }
        #expect(box.endpoint != nil, "this Mac's box started: \(box.failure ?? "no Node")")
        let app = AppModel()
        app.workspace.api = engine.api
        app.wireStores()
        app.wirePhoneLink()
        // (AppModel's machines start sets it, for the agents' mail and `&` names.)
        AgentMail.shared.app = app
        self.app = app
        #expect(app.skillsFolder == Self.skills && app.engineConfig.file == Self.folders.configFile, "the box's folders are the app's")
        await settle()
    }

    private func settle() async {
        guard let app else { return }
        await app.workspace.refresh()
        app.workspace.botSessions = app.bots.sessionIDs
        for bot in app.bots.list { await app.wakeUps.read(bot.wakeOwner) }
        for id in (try? FileManager.default.contentsOfDirectory(atPath: WakeUps.root.path)) ?? [] {
            if let session = app.workspace.session(id) { await app.wakeUps.read(WakeUps.owner(of: session)) }
        }
    }

    struct Answer { var status: Int; var type: String; var body: Data }

    /// What this Mac answers a paired phone's request, whole.
    private func ask(_ method: String, _ path: String, body: Any?) async throws -> Answer {
        let data: Data = switch body {
        case nil: Data()
        case let text as String: Data(text.utf8)
        case let value?: try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        }
        let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: data)
        var answer = Answer(status: 0, type: "", body: Data())
        let link = app?.phoneLink
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: engine.url + "/")!, password: "test", agents: link?.agents?.address) {
            switch part {
            case .head(let status, let headers):
                answer.status = status
                answer.type = headers["content-type"] ?? ""
            case .body(let chunk): answer.body += chunk
            }
        }
        return answer
    }

    // MARK: What a scenario gives

    private func give(_ kind: String, _ given: [String: Any], at: String) async throws {
        let manager = FileManager.default
        let string = { (key: String) in given[key] as? String ?? "" }
        switch kind {
        case "session":
            state.add(StubEngine.session(string("id"), title: string("title"), directory: string("directory"), created: given["updated"] as? Double ?? 1,
                                         extra: Self.extra(given)), running: given["running"] as? Bool == true)
        case "bot":
            guard app == nil else { throw TestFailure("\(at): bots are given before the first request (the app reads bots.json as it starts)") }
            let id = string("id")
            let folder = Bots.root.appending(path: id)
            try manager.createDirectory(at: folder.appending(path: "wakes"), withIntermediateDirectories: true)
            try manager.createDirectory(at: folder.appending(path: "workspace"), withIntermediateDirectories: true)
            try Data("# \(string("name"))'s memory\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
            let look = (given["look"] as? [String: String]).flatMap { try? JSONDecoder().decode(BotLook.self, from: JSONSerialization.data(withJSONObject: $0)) }
                ?? BotLook(color: .mint, shape: .round, face: .calm)
            let model = (given["model"] as? [String: String]).flatMap { try? JSONDecoder().decode(ModelRef.self, from: JSONSerialization.data(withJSONObject: $0)) }
            let bot = Bot(id: id, name: string("name"), job: string("job"), instructions: "", jobInMemory: true, look: look, machine: nil,
                          project: given["project"] as? String, folder: folder.path, sessionID: string("session"),
                          created: ISO8601DateFormatter().date(from: given["created"] as? String ?? "2026-10-01T09:00:00Z") ?? .now,
                          model: model, personality: given["personality"] as? String)
            let file = Self.support.appending(path: "bots.json")
            var list = JSONFile.read([Bot].self, from: file, isoDates: true) ?? []
            list.append(bot)
            JSONFile.write(list, to: file, isoDates: true)
            bots.append(id)
            state.add(StubEngine.session(bot.sessionID, title: bot.name, directory: bot.directory), running: false)
        case "wake":
            let due = Int(Date.now.timeIntervalSince1970) + (given["in"] as? Int ?? 0)
            let every = (given["every"] as? String).map { "-\($0)" } ?? ""
            try write(string("note"), to: wakeFolder(string("session")).appending(path: "wakes/\(due)-\(string("letters"))\(every)"))
        case "watch":
            let folder = try wakeFolder(string("session")).appending(path: "watches/\(string("letters"))")
            try write(string("check"), to: folder.appending(path: "check"))
            try write(string("every"), to: folder.appending(path: "every"))
            try write(string("note"), to: folder.appending(path: "note"))
        case "pause":
            try write("paused", to: wakeFolder(string("session")).appending(path: "paused"))
        case "skill":
            let folder = Self.skills.appending(path: string("name"))
            try write(string("text"), to: folder.appending(path: "SKILL.md"))
            if let github = given["github"] as? [String: String] {
                try write(String(decoding: JSONSerialization.data(withJSONObject: ["branch": "main", "path": github["path"] ?? "", "repository": github["repository"] ?? ""]), as: UTF8.self),
                          to: folder.appending(path: SkillLibrary.sourceFile))
            }
        case "settings":
            let value = try JSONSerialization.data(withJSONObject: given["value"] ?? [String: Any]())
            let text = given["text"] as? String ?? String(decoding: value, as: UTF8.self)
            try write(text, to: Self.folders.configFile)
        case "key":
            #expect(IntegrationKeys.set(string("value"), for: string("name")), "\(at): the Keychain kept it")
        case "credential":
            state.credentials.append(["id": string("id"), "integrationID": string("integrationID"), "label": string("label"), "active": given["active"] as? Bool ?? false, "value": ["type": "api"]])
        case "file":
            let file = work.appending(path: "work").appending(path: string("name"))
            try write(string("text"), to: file)
            vars["\(string("as")).path"] = file.path
            vars["\(string("as")).uri"] = file.absoluteString
        case "repository":
            let folder = work.appending(path: "work").appending(path: string("as"))
            try manager.createDirectory(at: folder, withIntermediateDirectories: true)
            try EngineState.git(["init", "-q", "-b", "main"], in: folder.path)
            for (name, text) in given["files"] as? [String: String] ?? ["README.md": "# Project\n"] { try write(text, to: folder.appending(path: name)) }
            try EngineState.git(["add", "-A"], in: folder.path)
            try EngineState.git(["commit", "-q", "-m", "First"], in: folder.path)
            vars[string("as")] = folder.path
        case "write":
            try write(string("text"), to: URL(filePath: string("path")))
        case "ask":
            // What an agent browsing asks you for, waiting in the app (so given once it runs).
            if app == nil { await start() }
            let kind: BrowserAsks.Kind = switch string("kind") {
            case "code": .code(prompt: string("prompt"))
            case "action": .action(instruction: string("instruction"))
            default: .signIn(username: given["username"] as? Bool ?? true, password: given["password"] as? Bool ?? true)
            }
            app?.browserAsks.add(.init(id: string("id"), kind: kind, host: string("host"), machine: nil), respond: { _ in })
        case "agentsBridge", "peers":
            // This Mac runs its group chats itself, and its coding agents' bridge isn't one this
            // suite stands in for (nor are your other computers, whose bots join its chats from D1b
            // step 4): nothing to give.
            break
        default:
            throw TestFailure("\(at): no fixture “\(kind)”")
        }
    }

    private static func extra(_ given: [String: Any]) -> [String: Any] {
        var extra: [String: Any] = [:]
        if let parent = given["parent"] as? String { extra["parentID"] = parent }
        if given["archived"] as? Bool == true { extra["metadata"] = ["kuvo.archived": true] }
        if let updated = given["updated"] as? Double { extra["time"] = ["created": updated, "updated": updated] }
        return extra
    }

    /// Where a session's wake-ups are kept: its bot's folder, or its own (made as kuvo-wake makes one).
    private func wakeFolder(_ session: String) throws -> URL {
        let bots = JSONFile.read([Bot].self, from: Self.support.appending(path: "bots.json"), isoDates: true) ?? []
        if let bot = bots.first(where: { $0.sessionID == session }) { return URL(filePath: bot.folder) }
        let folder = WakeUps.root.appending(path: session)
        if !FileManager.default.fileExists(atPath: folder.appending(path: "session").path) {
            try write(session, to: folder.appending(path: "session"))
            try write(state.directory(of: session) ?? "", to: folder.appending(path: "directory"))
        }
        return folder
    }

    private func write(_ text: String, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }

    /// A path with its links followed, as git and the engine name it.
    static func realPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

// MARK: The engine, a stand-in

/// The same small engine the machine's runner stands in with: its sessions, which run, its
/// sign-ins, and worktrees made and removed with git as it does; everything else answers `{}`.
nonisolated final class EngineState: @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [[String: Any]] = []
    private var running: Set<String> = []
    private var made = 0
    private var trees = 0
    private var projects: [String: String] = [:]
    var credentials: [[String: Any]] {
        get { lock.withLock { storedCredentials } }
        set { lock.withLock { storedCredentials = newValue } }
    }
    private var storedCredentials: [[String: Any]] = []
    var worktrees = ""

    func add(_ session: [String: Any], running isRunning: Bool) {
        lock.withLock {
            sessions.append(session)
            if isRunning, let id = session["id"] as? String { running.insert(id) }
        }
    }

    func directory(of session: String) -> String? {
        lock.withLock { (sessions.first { $0["id"] as? String == session }?["location"] as? [String: Any])?["directory"] as? String }
    }

    func answer(_ request: StubEngine.Request) -> StubWeb.Answer {
        let folder = request.headers["x-opencode-directory"]?.removingPercentEncoding ?? ""
        switch (request.method, request.path) {
        case ("GET", "/api/session"):
            let parent = request.query["parentID"]
            return StubWeb.json(["data": lock.withLock { sessions }.filter { session in
                guard let parent else { return true }
                return parent == "null" ? session["parentID"] == nil : session["parentID"] as? String == parent
            }])
        case ("GET", "/api/session/active"):
            return StubWeb.json(["data": Dictionary(uniqueKeysWithValues: lock.withLock { running }.map { ($0, ["type": "busy"]) })])
        case ("POST", "/api/session"):
            let session = lock.withLock {
                made += 1
                let session = StubEngine.session("ses_made\(made)", title: request.body["title"] as? String ?? "",
                                                 directory: (request.body["location"] as? [String: Any])?["directory"] as? String ?? "")
                sessions.append(session)
                return session
            }
            return StubWeb.json(["data": session])
        case ("GET", "/api/credential"):
            return StubWeb.json(["data": credentials])
        // Its tools connected (Kuvo Code's own browser's, no integration's), so nothing waits for them.
        case ("GET", "/api/mcp"):
            return StubWeb.json(["data": [["name": "kuvo-browser", "status": ["status": "connected"]]]])
        case ("GET", "/api/skill"), ("GET", "/api/provider"):
            return StubWeb.json(["data": [Any]()])
        // A folder's project is its repository's, by an id of its own, and a worktree is made of
        // the project its id names.
        case ("GET", "/api/location"):
            let top = try? Self.git(["rev-parse", "--show-toplevel"], in: folder)
            let id = "prj_" + String(UInt(bitPattern: (top ?? folder).hashValue), radix: 36)
            if let top { lock.withLock { projects[id] = top } }
            return StubWeb.json(["directory": folder, "project": ["id": id, "directory": top ?? folder, "canonical": top ?? folder]])
        case ("POST", "/api/worktree"):
            let (root, project) = lock.withLock {
                trees += 1
                return (worktrees + "/brave-otter-\(trees)", projects[request.body["projectID"] as? String ?? ""])
            }
            guard let project, (try? Self.git(["worktree", "add", "--quiet", "--detach", root], in: project)) != nil else {
                return StubWeb.json(["message": "Not a git project."], status: 400)
            }
            return StubWeb.json(["directory": root])
        case ("DELETE", "/api/worktree"):
            let force = request.body["force"] as? Bool == true ? ["--force"] : []
            let project = lock.withLock { projects[request.body["projectID"] as? String ?? ""] }
            guard let project, (try? Self.git(["worktree", "remove"] + force + [request.body["directory"] as? String ?? ""], in: project)) != nil else {
                return StubWeb.json(["message": "git refused."], status: 400)
            }
            return StubWeb.json([String: Any]())
        default:
            let parts = request.path.split(separator: "/").map(String.init)
            if request.method == "GET", parts.count == 3, parts[0] == "api", parts[1] == "session" {
                guard let found = lock.withLock({ sessions.first { $0["id"] as? String == parts[2] } }) else { return StubWeb.json(["message": "No such session."], status: 404) }
                return StubWeb.json(["data": found])
            }
            if request.method == "GET", parts.count == 4, parts[1] == "session", ["message", "inbox"].contains(parts[3]) { return StubWeb.json(["data": [Any]()]) }
            // What it doesn't have to read, as an engine without it; what's sent, taken.
            return request.method == "GET" ? StubWeb.json([String: Any](), status: 404) : StubWeb.json([String: Any]())
        }
    }

    @discardableResult
    static func git(_ arguments: [String], in folder: String) throws -> String {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = URL(filePath: folder)
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw TestFailure("git \(arguments.joined(separator: " ")) failed") }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: Matching

/// What a scenario expects, matched as the machine's runner matches it (CONTRIBUTING.md, "Route
/// scenarios"): only the keys it names; `<any>`, `<absent>`, `<string>`, `<number>`, `<bool>`,
/// `<object>`, `<array>`; lists in order, or `<includes>`, `<excludes>` and `<length>`; `<contains>`
/// for a string. Null and left out are the same, as they are to a client's optionals.
nonisolated enum RouteMatch {
    /// `{{name}}` in a string, from `vars`; `{{now+3600}}`, the time then in seconds. A string that's
    /// only one of them takes its value.
    static func filled(_ value: Any, _ vars: [String: Any]) -> Any {
        switch value {
        case let text as String:
            if text.hasPrefix("{{"), text.hasSuffix("}}"), text.dropFirst(2).dropLast(2).allSatisfy({ $0 != "{" && $0 != "}" }) {
                return lookup(String(text.dropFirst(2).dropLast(2)), vars)
            }
            var out = text
            while let start = out.range(of: "{{"), let end = out.range(of: "}}", range: start.upperBound..<out.endIndex) {
                out.replaceSubrange(start.lowerBound..<end.upperBound, with: "\(lookup(String(out[start.upperBound..<end.lowerBound]), vars))")
            }
            return out
        case let list as [Any]: return list.map { filled($0, vars) }
        case let object as [String: Any]: return object.mapValues { filled($0, vars) }
        default: return value
        }
    }

    private static func lookup(_ name: String, _ vars: [String: Any]) -> Any {
        if name.wholeMatch(of: /now([+-][0-9]+)?/) != nil {
            return Int(Date.now.timeIntervalSince1970) + (Int(name.dropFirst(3)) ?? 0)
        }
        guard let value = vars[name] else {
            Issue.record("{{\(name)}} isn't set")
            return ""
        }
        return value
    }

    static func value(at dotted: String, in json: Any?) -> Any? {
        dotted.split(separator: ".").reduce(json) { inner, key in
            if let list = inner as? [Any], let index = Int(key) { return list.indices.contains(index) ? list[index] : nil }
            return (inner as? [String: Any])?[String(key)]
        }
    }

    private static func isBool(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func shown(_ value: Any?) -> String {
        guard let value else { return "nothing" }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]) else { return "\(value)" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Why `actual` isn't what `expected` says, or nil when it is.
    static func mismatch(_ expected: Any, _ actual: Any?, at: String = "body") -> String? {
        let isNull = { (value: Any?) in value == nil || value is NSNull }
        switch expected {
        case let text as String:
            switch text {
            case "<any>": return actual == nil ? "\(at) is missing" : nil
            case "<absent>": return actual == nil ? nil : "\(at) should be left out, but is \(shown(actual))"
            case "<string>": return actual is String ? nil : "\(at) should be a string, but is \(shown(actual))"
            case "<number>": return actual is NSNumber && !isBool(actual) ? nil : "\(at) should be a number, but is \(shown(actual))"
            case "<bool>": return isBool(actual) ? nil : "\(at) should be a boolean, but is \(shown(actual))"
            case "<object>": return actual is [String: Any] ? nil : "\(at) should be an object, but is \(shown(actual))"
            case "<array>": return actual is [Any] ? nil : "\(at) should be a list, but is \(shown(actual))"
            default: return actual as? String == text ? nil : "\(at) should be \(shown(text)), but is \(shown(actual))"
            }
        case is NSNull:
            return isNull(actual) ? nil : "\(at) should be null, but is \(shown(actual))"
        case let number as NSNumber:
            guard let other = actual as? NSNumber, isBool(number) == isBool(other), number == other else { return "\(at) should be \(shown(number)), but is \(shown(actual))" }
            return nil
        case let list as [Any]:
            guard let items = actual as? [Any] else { return "\(at) should be a list, but is \(shown(actual))" }
            guard items.count == list.count else { return "\(at) should have \(list.count), but has \(items.count): \(shown(items))" }
            for (index, each) in list.enumerated() {
                if let why = mismatch(each, items[index], at: "\(at)[\(index)]") { return why }
            }
            return nil
        case let object as [String: Any]:
            if object["<includes>"] != nil || object["<excludes>"] != nil || object["<length>"] != nil {
                guard let items = actual as? [Any] else { return "\(at) should be a list, but is \(shown(actual))" }
                if let length = object["<length>"] as? Int, items.count != length { return "\(at) should have \(length), but has \(items.count)" }
                for each in object["<includes>"] as? [Any] ?? [] where !items.contains(where: { mismatch(each, $0) == nil }) {
                    return "\(at) has none like \(shown(each)): \(shown(items))"
                }
                for each in object["<excludes>"] as? [Any] ?? [] where items.contains(where: { mismatch(each, $0) == nil }) {
                    return "\(at) has one like \(shown(each)): \(shown(items))"
                }
                return nil
            }
            if let part = object["<contains>"] as? String {
                return (actual as? String)?.contains(part) == true ? nil : "\(at) should contain \(shown(part)), but is \(shown(actual))"
            }
            guard let values = actual as? [String: Any] else { return "\(at) should be an object, but is \(shown(actual))" }
            for key in object.keys.sorted() {
                if let why = mismatch(object[key]!, values[key], at: "\(at).\(key)") { return why }
            }
            return nil
        default:
            return "\(at): a scenario can't expect \(expected)"
        }
    }

    /// Two JSON documents alike, whatever their spacing and order.
    static func same(_ one: Data, _ other: Data) throws -> Bool {
        let sorted = { (data: Data) in try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: data), options: [.sortedKeys]) }
        return try sorted(one) == sorted(other)
    }
}
