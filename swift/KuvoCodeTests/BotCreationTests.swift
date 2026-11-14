import ClientDesign
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Making a bot from scratch (F1) on this Mac, whose box makes and keeps it: a folder of its own
/// with a memory that names it, and a conversation of its own in that folder, told who it is and
/// where it runs; it's listed, and still there when Kuvo Code opens again; it writes first, asking
/// what it's for. The job it then keeps with its set_job tool is what shows under its name, and a
/// job changed in Edit Bot reaches it. One the engine couldn't make leaves nothing behind. The
/// engine is stubbed; this Mac's box is real.
@MainActor
@Suite(.serialized) struct BotCreationTests {
    let engine = StubEngine(port: 47997)
    let app = AppModel()
    let botsFile = AppInfo.supportDirectory.appending(path: "bots.json")

    init() {
        app.bots.app = app
        app.wakeUps.app = app
        app.workspace.api = engine.api
        engine.list([])
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        engine.on("PUT", "/api/experimental/session/*", json: [:])
        engine.on("POST", "/api/session/ses_inbox/*", json: [:])
        engine.on("GET", "/api/session/ses_inbox") { _ in StubWeb.json(["data": StubEngine.session("ses_inbox", title: "Inbox Helper", directory: "/")]) }
    }

    private func done(_ box: TestBox) {
        box.stop()
        engine.stop()
        try? FileManager.default.removeItem(at: Bots.root)
        try? FileManager.default.removeItem(at: botsFile)
    }

    private func told(_ session: String) -> [String] {
        engine.requests("PUT", "/api/experimental/session/\(session)/instructions/entries/\(Bots.instructionKey)").compactMap { $0.body["value"] as? String }
    }

    @Test func aBotFromScratch() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { done(box) }
        app.bots.boxes = { _ in box.client(engine: engine.url) }
        engine.on("POST", "/api/session") { request in
            StubWeb.json(["data": StubEngine.session("ses_inbox", title: request.body["title"] as? String ?? "", directory: (request.body["location"] as? [String: Any])?["directory"] as? String ?? "")])
        }
        await app.workspace.refresh()
        let made = try await app.bots.make(name: "Inbox Helper", look: BotLook(color: .mint, shape: .round, face: .calm), model: ModelRef(id: "big-pickle", providerID: "opencode"), machine: nil, project: nil)
        let bot = made.bot
        #expect(made.firstMessage == nil, "it writes first: nothing for your composer")

        // Its own folder on this Mac, with a memory that names it, and its conversation there.
        #expect(bot.folder.hasPrefix(Bots.root.path))
        let memory = try String(contentsOfFile: bot.memoryFile, encoding: .utf8)
        #expect(memory.contains("Inbox Helper"))
        let session = try #require(engine.requests("POST", "/api/session").first)
        #expect((session.body["location"] as? [String: Any])?["directory"] as? String == bot.directory)
        #expect(bot.sessionID == "ses_inbox")
        #expect(app.workspace.session("ses_inbox") != nil)
        let first = try #require(told("ses_inbox").first)
        #expect(first.contains("You are Inbox Helper") && first.contains("You run on this Mac."), "it's told who it is and where it runs")
        // Listed, and still there when Kuvo Code opens again (what its box last said, kept).
        #expect(app.bots.list.map(\.name) == ["Inbox Helper"])
        #expect(Bots().list.map(\.id) == [bot.id])
        #expect(bot.job.isEmpty, "no job until you've told it")
        // It writes first.
        #expect(engine.requests("POST", "/api/session/ses_inbox/synthetic").count == 1)

        // You tell it; it keeps its job with set_job, and that's what shows under its name.
        // (As this Mac's tool server passes the call on to its box, and the app hears of the bot again.)
        let mail = AgentMail()
        mail.box = { box.client(engine: engine.url) }
        let kept = await mail.call("set_job", arguments: ["summary": "Sorts my inbox every morning.", "details": "Archive newsletters; flag anything from my bank."], caller: "ses_inbox")
        #expect(kept.isError == false, "\(kept.text)")
        await app.bots.refresh(BoxClient.mac)
        #expect(app.bots.bot(bot.id)?.job == "Sorts my inbox every morning")
        #expect(app.bots.bot(bot.id)?.instructions == "Archive newsletters; flag anything from my bank.")
        #expect(told("ses_inbox").last?.contains("Archive newsletters; flag anything from my bank.") == true, "it hears its job as kept")
        #expect(try String(contentsOfFile: bot.memoryFile, encoding: .utf8) == memory, "its memory is its own")

        // Changed in Edit Bot: kept by its box, and it hears it.
        var edited = try #require(app.bots.bot(bot.id))
        edited.job = "Sorts my inbox twice a day"
        edited.instructions = "Morning and evening. Archive newsletters."
        try await app.bots.update(edited, job: true)
        #expect(app.bots.bot(bot.id)?.job == "Sorts my inbox twice a day")
        #expect(told("ses_inbox").last?.contains("Morning and evening. Archive newsletters.") == true)
        #expect(Bots().list.first?.job == "Sorts my inbox twice a day", "kept")
        // Gone back to 0.8.0-beta.1, which reads jobs from memories: it finds this one, as kept.
        #expect(Beta1.jobs(in: botsFile)[bot.id] == "Sorts my inbox twice a day")
    }

    /// New Bot's Create clicked again after its answer was lost on the way back (the box made the
    /// bot, the connection dropped): one bot, the one it made; another New Bot makes another.
    @Test func oneNewBotSentAgainMakesOneBot() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { done(box) }
        let real = box.client(engine: engine.url)
        let lost = LosesFirstAnswer(to: real.transport, path: "kuvo/bots")
        app.bots.boxes = { _ in BoxClient(box: real.box, transport: lost) }
        engine.on("POST", "/api/session") { request in
            StubWeb.json(["data": StubEngine.session("ses_" + UUID().uuidString.prefix(8).lowercased(), title: request.body["title"] as? String ?? "", directory: (request.body["location"] as? [String: Any])?["directory"] as? String ?? "")])
        }
        let made = { engine.requests("POST", "/api/session").count }
        engine.on("GET", "/api/session/*") { request in StubWeb.json(["data": StubEngine.session(String(request.path.split(separator: "/").last ?? ""), title: "Inbox Helper", directory: "/")]) }
        await app.workspace.refresh()
        let look = BotLook(color: .mint, shape: .round, face: .calm), model = ModelRef(id: "big-pickle", providerID: "opencode")

        let sheet = Bots.NewBotRequest()
        await #expect(throws: (any Error).self) {
            try await sheet.make(with: app.bots, name: "Inbox Helper", look: look, model: model, machine: nil, project: nil)
        }
        let again = try await sheet.make(with: app.bots, name: "Inbox Helper", look: look, model: model, machine: nil, project: nil)
        #expect(made() == 1, "made once")
        #expect(app.bots.list.map(\.id) == [again.bot.id])

        // Another New Bot, the same name: another bot.
        let other = try await Bots.NewBotRequest().make(with: app.bots, name: "Inbox Helper", look: look, model: model, machine: nil, project: nil)
        #expect(other.bot.id != again.bot.id)
        #expect(made() == 2)
    }

    /// The engine couldn't make its conversation: no bot, and no folder left of it.
    @Test func oneThatCouldntBeMadeLeavesNothing() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { done(box) }
        app.bots.boxes = { _ in box.client(engine: engine.url) }
        engine.on("POST", "/api/session", json: ["message": "Engine busy"], status: 500)
        await app.workspace.refresh()
        let before = (try? FileManager.default.contentsOfDirectory(atPath: Bots.root.path(percentEncoded: false))) ?? []
        await #expect(throws: (any Error).self) {
            try await app.bots.make(name: "Inbox Helper", look: BotLook(color: .mint, shape: .round, face: .calm), model: ModelRef(id: "big-pickle", providerID: "opencode"), machine: nil, project: nil)
        }
        #expect(app.bots.list.isEmpty)
        let after = (try? FileManager.default.contentsOfDirectory(atPath: Bots.root.path(percentEncoded: false))) ?? []
        #expect(Set(after).subtracting(before).subtracting(["kit.json"]).isEmpty, "a folder was left: \(Set(after).subtracting(before))")
    }
}

/// How Kuvo Code 0.8.0-beta.1 took a bot's job from `bots.json` as it opened (its `Bots.syncJob`),
/// frozen: one marked as keeping its job in its memory (`jobInMemory: true`) had it read from there,
/// under a Job heading; any other had the job written in the list moved into its memory, unless its
/// memory had one of its own.
enum Beta1 {
    static func jobs(in file: URL) -> [String: String] {
        struct Listed: Decodable { var id: String; var job: String; var instructions: String; var jobInMemory: Bool?; var folder: String; var machine: String? }
        guard let data = try? Data(contentsOf: file), let bots = try? JSONDecoder().decode([Listed].self, from: data) else { return [:] }
        var jobs: [String: String] = [:]
        for bot in bots where bot.machine == nil {
            let memory = (try? String(contentsOfFile: (bot.folder as NSString).appendingPathComponent("MEMORY.md"), encoding: .utf8)) ?? ""
            let fromMemory = jobLine(in: memory)
            if bot.jobInMemory != true, !(bot.job.isEmpty && bot.instructions.isEmpty) {
                jobs[bot.id] = fromMemory ?? bot.job
            } else {
                jobs[bot.id] = fromMemory ?? ""
            }
        }
        return jobs
    }

    /// The first line under a Job heading ("## Job", "## My job", "## Job: …"), as beta.1 read it.
    private static func jobLine(in memory: String) -> String? {
        let lines = memory.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: { line in
            let title = line.trimmingCharacters(in: .whitespaces).drop { $0 == "#" }.trimmingCharacters(in: .whitespaces).lowercased()
            return line.trimmingCharacters(in: .whitespaces).hasPrefix("#") && (title == "job" || title == "my job" || title == "the job" || title.hasPrefix("job:"))
        }) else { return nil }
        return lines[(start + 1)...].map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty && !$0.hasPrefix("#") } ?? ""
    }
}

/// A box whose first answer to `path` is lost on the way back: it did what was asked, and the
/// connection dropped before its answer came.
private final class LosesFirstAnswer: BoxTransport, @unchecked Sendable {
    let inner: any BoxTransport
    let path: String
    private let lock = NSLock()
    private var lost = false

    init(to inner: any BoxTransport, path: String) {
        self.inner = inner
        self.path = path
    }

    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
        let loses = request.path == path && lock.withLock { lost ? false : { lost = true; return true }() }
        guard loses else { return inner.send(request) }
        let answer = inner.send(request)
        return AsyncThrowingStream { continuation in
            Task {
                do { for try await _ in answer {} } catch {}
                continuation.finish(throwing: URLError(.networkConnectionLost))
            }
        }
    }
}
