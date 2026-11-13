import ClientDesign
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A phone's bots on this Mac, which this Mac's box makes and keeps for every client: what New Bot
/// offers, a bot made from a phone (from scratch it writes first; from a template it waits with its
/// job for the phone's composer), changed and deleted there, each showing in the app as it does,
/// and a key of its own given there. What every box answers alike is in the route scenarios
/// (RouteContractTests). The engine is stubbed; this Mac's box is real.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneBotsTests {
    let engine = StubEngine(port: 47996)
    let app = AppModel()
    let link = PhoneLink()
    let botsFile = AppInfo.supportDirectory.appending(path: "bots.json")

    init() {
        app.bots.app = app
        app.wakeUps.app = app
        app.workspace.api = engine.api
        link.bots = app.bots
        link.workspace = app.workspace
        engine.list([])
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        engine.on("PUT", "/api/experimental/session/*", json: [:])
        engine.on("POST", "/api/session/*", json: [:])
        engine.on("DELETE", "/api/session/*", json: [:])
        var made: [String: [String: Any]] = [:]
        engine.on("POST", "/api/session") { request in
            let session = StubEngine.session("ses_bot\(made.count + 1)", title: request.body["title"] as? String ?? "",
                                             directory: (request.body["location"] as? [String: Any])?["directory"] as? String ?? "")
            made[session["id"] as! String] = session
            return StubWeb.json(["data": session])
        }
        // One it made, as the box reads it just before marking it.
        engine.on("GET", "/api/session/*") { request in
            made[String(request.path.split(separator: "/").last ?? "")].map { StubWeb.json(["data": $0]) } ?? StubWeb.json(["message": "Not found."], status: 404)
        }
    }

    /// This Mac's box, which the app and the phone both reach, and New Bot's kit there.
    private func start() async throws -> TestBox {
        let box = try await TestBox(engine: engine.url)
        app.bots.boxes = { _ in box.client(engine: engine.url) }
        app.bots.writeMacKit()
        return box
    }

    private func done(_ box: TestBox) {
        box.stop()
        engine.stop()
        try? FileManager.default.removeItem(at: Bots.root)
        try? FileManager.default.removeItem(at: botsFile)
    }

    private func ask(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]?) {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: data)
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:47996/")!, password: nil, agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): answer += chunk
            }
        }
        return (status, try? JSONSerialization.jsonObject(with: answer) as? [String: Any])
    }

    private func message(_ answer: (status: Int, json: [String: Any]?)) -> String? { answer.json?["message"] as? String }

    private let model = ModelRef(id: "big-pickle", providerID: "opencode")

    /// A bot on this Mac given a key of its own from a phone, as Edit Bot gives one: in your
    /// Keychain, its folder's settings naming its server with it; read back, and taken away.
    @Test func aPhoneGivesABotHereAKeyOfItsOwn() async throws {
        let box = try await start()
        defer { done(box) }
        let ada = try await app.bots.make(name: "Ada", look: BotLook(color: .mint, shape: .round, face: .calm), model: model, machine: nil, project: nil).bot
        let service = try #require(BotKeys.services.first { Integrations.keys(of: $0.way).count == 1 })
        let name = try #require(Integrations.keys(of: service.way).first?.name)
        let variable = IntegrationKeys.variable(service.id, name, bot: ada.id)
        defer { _ = IntegrationKeys.set(nil, for: variable) }
        let path = "kuvo/bots/\(ada.id)/keys"

        let listed = try #require(try await ask(path).json?["keys"] as? [[String: Any]])
        #expect(listed.map { $0["integration"] as? String } == BotKeys.services.map(\.id))
        #expect(try await ask(path + "/\(service.id)", method: "PUT", body: ["keys": [:]]).status == 400)
        let given = try await ask(path + "/\(service.id)", method: "PUT", body: ["keys": [name: " tok_ada "]])
        #expect(given.status == 200)
        #expect(IntegrationKeys.value(variable) == "tok_ada")
        let settings = try String(contentsOf: URL(filePath: ada.directory).appending(path: ".opencode/opencode.json"), encoding: .utf8)
        #expect(settings.contains(variable), "her folder's settings name her server with it")
        #expect(try await ask(path + "/\(service.id)", method: "DELETE").status == 200)
        #expect(IntegrationKeys.value(variable) == nil)
        #expect(try await ask("kuvo/bots/bot_nobody/keys").status == 404)
    }

    @Test func whatNewBotOffers() async throws {
        let box = try await start()
        defer { done(box) }
        let offered = try #require(try await ask("kuvo/bots/templates").json)
        let templates = try #require(offered["templates"] as? [[String: Any]])
        #expect(templates.map { $0["id"] as? String } == BotTemplate.all.map(\.id))
        let personalities = try #require(offered["personalities"] as? [[String: Any]])
        #expect(personalities.first?["id"] as? String == "preset.straight" && personalities.first?["custom"] as? Bool == false)
        // This Mac's: the model a bot starts on here, known or not yet.
        #expect((offered["startingModel"] as? [String: Any])?.keys.sorted() == ["mac"])
    }

    /// Made from a phone: it shows in the app, and writes first.
    @Test func aBotFromScratchWritesFirst() async throws {
        let box = try await start()
        defer { done(box) }
        let made = try await ask("kuvo/bots", method: "POST", body: ["name": "Inbox Helper", "look": ["color": "mint", "shape": "round", "face": "calm"],
                                                                    "model": ["providerID": "opencode", "id": "big-pickle"]])
        #expect(made.status == 201)
        let id = try #require((made.json?["bot"] as? [String: Any])?["id"] as? String)
        #expect(made.json?["firstMessage"] is NSNull, "no job for the composer: it writes first")
        #expect(engine.requests("POST", "/api/session/ses_bot1/synthetic").count == 1)
        await app.bots.refresh(BoxClient.mac)
        #expect(app.bots.bot(id)?.look == BotLook(color: .mint, shape: .round, face: .calm))
        #expect(app.bots.bot(id)?.name == "Inbox Helper")
    }

    @Test func oneFromATemplateWaitsWithItsJob() async throws {
        let box = try await start()
        defer { done(box) }
        let made = try await ask("kuvo/bots", method: "POST", body: ["name": "Herald", "template": "news", "model": ["providerID": "opencode", "id": "big-pickle"]])
        #expect(made.status == 201)
        let news = try #require(BotTemplate.all.first { $0.id == "news" })
        #expect((made.json?["firstMessage"] as? String)?.hasPrefix("Your job, in a few words: \(news.job).") == true)
        #expect(engine.requests("POST", "/api/session/ses_bot1/synthetic").isEmpty, "it waits for you")
        await app.bots.refresh(BoxClient.mac)
        let bot = try #require(app.bots.list.first)
        #expect(bot.look == news.look && bot.personality == news.personality, "the template's look and personality")
    }

    /// Changed from a phone as Edit Bot changes it: kept by its box, its conversation told, and the
    /// app shows it.
    @Test func aBotChangedFromAPhone() async throws {
        let box = try await start()
        defer { done(box) }
        let ada = try await app.bots.make(name: "Ada", look: BotLook(color: .mint, shape: .round, face: .calm), model: model, machine: nil, project: nil).bot
        let changed = try await ask("kuvo/bots/\(ada.id)", method: "PATCH", body: [
            "name": " Ada\nPrime ", "look": ["color": "sky", "shape": "gem", "face": "wink"], "personality": "preset.straight",
            "job": ["line": "Keeps CI green", "details": "Watch main."],
        ])
        #expect(changed.status == 200)
        await app.bots.refresh(BoxClient.mac)
        let bot = try #require(app.bots.bot(ada.id))
        #expect(bot.name == "Ada Prime" && bot.look == BotLook(color: .sky, shape: .gem, face: .wink) && bot.personality == "preset.straight")
        #expect(bot.job == "Keeps CI green" && bot.instructions == "Watch main.")
        #expect(Bots().list.first?.name == "Ada Prime", "kept")
        #expect(engine.requests("PATCH", "/api/session/\(ada.sessionID)").contains { $0.body["title"] as? String == "Ada Prime" })
        let told = try #require(engine.requests("PUT", "/api/experimental/session/\(ada.sessionID)/instructions/entries/kuvo.bot").last?.body["value"] as? String)
        #expect(told.hasPrefix("You are Ada Prime, one of the user's bots in Kuvo Code: Keeps CI green.") && told.contains("You run on this Mac."), "told as a bot on this Mac, with its job")
        let straight = try #require(Personalities.presets.first { $0.id == "preset.straight" })
        #expect(told.contains("\n\nYour job:\nWatch main.\n\n") && told.contains(straight.instruction))
        // On its way to another computer: not changed or deleted until it's there.
        try Data("moving".utf8).write(to: URL(filePath: bot.folder).appending(path: "paused"))
        let moving = try await ask("kuvo/bots/\(ada.id)", method: "PATCH", body: ["name": "X"])
        #expect(moving.status == 409 && message(moving) == Moves.Failure.moving.localizedDescription)
        #expect(try await ask("kuvo/bots/\(ada.id)", method: "DELETE").status == 409)
    }

    /// Deleted from a phone as Delete Bot… deletes it: gone from the app, its conversation deleted,
    /// its folder in the Trash.
    @Test func aBotDeletedFromAPhone() async throws {
        let box = try await start()
        defer { done(box) }
        let ada = try await app.bots.make(name: "Ada", look: .random(), model: model, machine: nil, project: nil).bot
        let ben = try await app.bots.make(name: "Ben", look: .random(), model: model, machine: nil, project: nil).bot
        let deleted = try await ask("kuvo/bots/\(ada.id)", method: "DELETE")
        #expect(deleted.status == 200)
        await app.bots.refresh(BoxClient.mac)
        #expect(app.bots.bot(ada.id) == nil && Bots().list.map(\.id) == [ben.id])
        #expect(engine.requests("DELETE", "/api/session/\(ada.sessionID)").count == 1, "its conversation is deleted")
        #expect(!FileManager.default.fileExists(atPath: ada.folder), "its folder went to the Trash")
        #expect(try await ask("kuvo/bots/\(ada.id)", method: "DELETE").status == 404)
    }
}
