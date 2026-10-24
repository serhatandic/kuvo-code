import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Making bots and group chats from a phone, as New Bot and New Group Chat make them: what New
/// Bot offers (templates, personalities, looks, the model it starts with in each place, your
/// projects); a bot from scratch writes first, one from a template waits with its job for the
/// phone's composer; a chat of two of them; and what's missing or unknown said in words. The
/// engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneBotsTests {
    let engine = StubEngine(port: 47996)
    let app = AppModel()
    let link = PhoneLink()
    let botsFile = AppInfo.supportDirectory.appending(path: "bots.json")
    let groupsFile = AppInfo.supportDirectory.appending(path: "groups.json")

    init() {
        app.bots.app = app
        app.wakeUps.app = app
        app.groups.app = app
        app.workspace.api = engine.api
        link.bots = app.bots
        link.groups = app.chats
        link.workspace = app.workspace
        engine.list([])
        engine.on("PATCH", "/api/session/*", json: [:])
        engine.on("PUT", "/api/experimental/session/*", json: [:])
        engine.on("POST", "/api/session/*", json: [:])
        var made = 0
        engine.on("POST", "/api/session") { request in
            made += 1
            return StubWeb.json(["data": StubEngine.session("ses_bot\(made)", title: request.body["title"] as? String ?? "",
                                                             directory: (request.body["location"] as? [String: Any])?["directory"] as? String ?? "")])
        }
    }

    private func done() {
        engine.stop()
        for bot in app.bots.list { try? FileManager.default.removeItem(atPath: bot.folder) }
        try? FileManager.default.removeItem(at: botsFile)
        try? FileManager.default.removeItem(at: groupsFile)
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

    /// A bot on this Mac given a key of its own from a phone, as Edit Bot gives one: in your
    /// Keychain, its folder's settings naming its server with it; read back, and taken away.
    @Test func aPhoneGivesABotHereAKeyOfItsOwn() async throws {
        defer { done() }
        let ada = try await app.bots.create(name: "Ada", look: BotLook(color: .mint, shape: .round, face: .calm), model: nil, machine: nil, project: nil)
        let service = try #require(BotKeys.services.first { Integrations.keys(of: $0.way).count == 1 })
        let name = try #require(Integrations.keys(of: service.way).first?.name)
        let variable = IntegrationKeys.variable(service.id, name, bot: ada.id)
        defer { _ = IntegrationKeys.set(nil, for: variable) }
        let path = "kuvo/bots/\(ada.id)/keys"

        let listed = try #require(try await ask(path).json?["keys"] as? [[String: Any]])
        #expect(listed.map { $0["integration"] as? String } == BotKeys.services.map(\.id))
        let entry = listed.first { $0["integration"] as? String == service.id }
        #expect(entry?["own"] as? Bool == false)
        // As Edit Bot shows it: its name, symbol and the keys it takes.
        #expect(entry?["title"] as? String == service.title && entry?["symbol"] as? String == service.symbol)
        #expect((entry?["keys"] as? [[String: String]])?.map { $0["name"] } == Integrations.keys(of: service.way).map(\.name))
        #expect(try await ask(path + "/\(service.id)", method: "PUT", body: ["keys": [:]]).status == 400)

        let given = try await ask(path + "/\(service.id)", method: "PUT", body: ["keys": [name: " tok_ada "]])
        #expect(given.status == 200)
        #expect(IntegrationKeys.value(variable) == "tok_ada")
        let settings = try String(contentsOf: URL(filePath: ada.directory).appending(path: ".opencode/opencode.json"), encoding: .utf8)
        #expect(settings.contains(variable), "her folder's settings name her server with it")
        #expect((try await ask(path + "/\(service.id)").json?["keys"] as? [String: String]) == [name: "tok_ada"])

        #expect(try await ask(path + "/\(service.id)", method: "DELETE").status == 200)
        #expect(IntegrationKeys.value(variable) == nil)
        #expect(try await ask(path + "/\(service.id)", method: "DELETE").status == 404)
        #expect(try await ask("kuvo/bots/bot_nobody/keys").status == 404)
    }

    @Test func whatNewBotOffers() async throws {
        defer { done() }
        let offered = try #require(try await ask("kuvo/bots/templates").json)
        let templates = try #require(offered["templates"] as? [[String: Any]])
        #expect(templates.map { $0["id"] as? String } == BotTemplate.all.map(\.id))
        let ci = try #require(templates.first { $0["id"] as? String == "ci" })
        #expect(ci["wantsProject"] as? Bool == true)
        #expect(ci["personality"] as? String == "preset.perfectionist")
        #expect((ci["look"] as? [String: String])?["shape"] == "squircle")
        let personalities = try #require(offered["personalities"] as? [[String: Any]])
        #expect(personalities.first?["id"] as? String == "preset.straight" && personalities.first?["custom"] as? Bool == false)
        let looks = try #require(offered["looks"] as? [String: [String]])
        #expect(looks["colors"]?.contains("mint") == true && looks["shapes"]?.contains("bloom") == true && looks["faces"]?.contains("wink") == true)
        // This Mac is always a place to make one, its model or not known yet.
        #expect((offered["startingModel"] as? [String: Any])?.keys.contains("mac") == true)
        #expect(offered["projects"] is [[String: Any]])
    }

    @Test func aBotFromScratchWritesFirst() async throws {
        defer { done() }
        await app.workspace.refresh()
        let made = try await ask("kuvo/bots", method: "POST", body: ["name": "Inbox Helper", "look": ["color": "mint", "shape": "round", "face": "calm"]])
        #expect(made.status == 201)
        let bot = try #require(made.json?["bot"] as? [String: Any])
        let id = try #require(bot["id"] as? String)
        #expect(id.hasPrefix("bot_") && bot["name"] as? String == "Inbox Helper" && bot["session"] as? String == "ses_bot1")
        #expect(made.json?["firstMessage"] is NSNull, "no job for the composer: it writes first")
        #expect(app.bots.bot(id)?.look == BotLook(color: .mint, shape: .round, face: .calm))
        // It writes first, as a new bot does.
        try await until { !engine.requests("POST", "/api/session/ses_bot1/synthetic").isEmpty }
        #expect(engine.requests("POST", "/api/session/ses_bot1/synthetic").count == 1)
        // Listed by its id, as group chats name their members.
        let listed = try #require(try await ask("kuvo/bots").json?["bots"] as? [[String: Any]])
        #expect(listed.map { $0["id"] as? String } == [id])
    }

    @Test func oneFromATemplateWaitsWithItsJob() async throws {
        defer { done() }
        await app.workspace.refresh()
        let made = try await ask("kuvo/bots", method: "POST", body: ["name": "Herald", "template": "news"])
        #expect(made.status == 201)
        let news = try #require(BotTemplate.all.first { $0.id == "news" })
        #expect(made.json?["firstMessage"] as? String == BotTemplate.firstMessage(job: news.job, instructions: news.instructions))
        let bot = try #require(app.bots.list.first)
        #expect(bot.look == news.look && bot.personality == news.personality, "the template's look and personality")
        try await Task.sleep(for: .milliseconds(200))
        #expect(engine.requests("POST", "/api/session/ses_bot1/synthetic").isEmpty, "it waits for you")
    }

    @Test func whatsMissingOrUnknownIsSaid() async throws {
        defer { done() }
        await app.workspace.refresh()
        for (body, words) in [
            (["look": ["color": "mint", "shape": "round", "face": "calm"]], "A bot needs a name."),
            (["name": "X", "template": "nope"], "There’s no template “nope”."),
            (["name": "X", "personality": "custom.gone"], "There’s no personality “custom.gone”."),
            (["name": "X", "machine": "box"], "There’s no machine “box”."),
            (["name": "X", "project": "/nowhere"], "That project isn’t in Kuvo Code."),
        ] as [([String: Any], String)] {
            let answer = try await ask("kuvo/bots", method: "POST", body: body)
            #expect(answer.status == 400 && message(answer) == words, "\(body)")
        }
        #expect(app.bots.list.isEmpty, "nothing made")
    }

    @Test func aGroupChatOfTwo() async throws {
        defer { done() }
        await app.workspace.refresh()
        let ada = try await app.bots.create(name: "Ada", look: .random(), model: nil, machine: nil, project: nil)
        let ben = try await app.bots.create(name: "Ben", look: .random(), model: nil, machine: nil, project: nil)
        let made = try await ask("kuvo/groups", method: "POST", body: ["name": "Release", "members": [ada.id, ben.id, ada.id], "purpose": "  Ship 1.0  "])
        #expect(made.status == 201)
        let group = try #require(made.json?["group"] as? [String: Any])
        #expect(group["name"] as? String == "Release" && group["purpose"] as? String == "Ship 1.0")
        #expect((group["members"] as? [[String: Any]])?.map { $0["id"] as? String } == [ada.id, ben.id])
        #expect(app.groups.list.map(\.name) == ["Release"])
        // Listed as the phone lists the rest.
        let listed = try #require(try await ask("kuvo/groups").json?["groups"] as? [[String: Any]])
        #expect(listed.map { $0["id"] as? String } == [group["id"] as? String])

        let one = try await ask("kuvo/groups", method: "POST", body: ["name": "Solo", "members": [ada.id]])
        #expect(one.status == 400 && message(one) == "A group chat needs at least two bots.")
        let unnamed = try await ask("kuvo/groups", method: "POST", body: ["name": " ", "members": [ada.id, ben.id]])
        #expect(unnamed.status == 400)
        let unknown = try await ask("kuvo/groups", method: "POST", body: ["name": "Who", "members": [ada.id, "bot_gone000001"]])
        #expect(unknown.status == 404 && message(unknown) == "There’s no bot “bot_gone000001”.")
        #expect(app.groups.list.count == 1)
    }

    /// A group chat made and changed from a phone, its meeting set up as Edit Group Chat sets it
    /// up: a weekly one at a time to come, kept; one that comes back, its time passed, on to its
    /// next round; a one-off past, or a repeat there isn't, refused.
    @Test func aGroupChatsMeetingFromAPhone() async throws {
        defer { done() }
        await app.workspace.refresh()
        let ada = try await app.bots.create(name: "Ada", look: .random(), model: nil, machine: nil, project: nil)
        let ben = try await app.bots.create(name: "Ben", look: .random(), model: nil, machine: nil, project: nil)
        let nextWeek = Date.now.addingTimeInterval(86_400 * 7).timeIntervalSince1970.rounded()
        let made = try await ask("kuvo/groups", method: "POST", body: ["name": "Standup", "members": [ada.id, ben.id],
                                                                      "meeting": ["next": nextWeek, "every": "1w", "topic": " "]])
        #expect(made.status == 201)
        let id = try #require((made.json?["group"] as? [String: Any])?["id"] as? String)
        let meeting = try #require(app.groups.group(id)?.meeting)
        // To the minute.
        #expect(meeting.next.timeIntervalSince1970 == (nextWeek / 60).rounded(.down) * 60 && meeting.every == "1w")
        #expect(meeting.topic == BotGroup.Meeting.defaultTopic)
        #expect(meeting.weekday == Calendar.current.component(.weekday, from: meeting.next))

        let past = Date.now.addingTimeInterval(-3600).timeIntervalSince1970
        #expect(try await ask("kuvo/groups", method: "POST", body: ["name": "Late", "members": [ada.id, ben.id], "meeting": ["next": past]]).status == 400)
        #expect(try await ask("kuvo/groups", method: "POST", body: ["name": "Odd", "members": [ada.id, ben.id], "meeting": ["next": nextWeek, "every": "1y"]]).status == 400)
        #expect(app.groups.list.count == 1)

        // Changed: a daily one whose time passed comes back at its next round; the name and
        // purpose go with it, and an empty purpose is none.
        let changed = try await ask("kuvo/groups/\(id)", method: "PATCH", body: ["name": "Daily", "purpose": "Ship", "meeting": ["next": past, "every": "1d", "topic": "Where are we?"]])
        #expect(changed.status == 200)
        #expect((changed.json?["group"] as? [String: Any])?["name"] as? String == "Daily")
        let daily = try #require(app.groups.group(id)?.meeting)
        #expect(daily.next > .now && daily.every == "1d" && daily.topic == "Where are we?")
        #expect(app.groups.group(id)?.purpose == "Ship")
        #expect(try await ask("kuvo/groups/\(id)", method: "PATCH", body: ["purpose": "", "meeting": NSNull()]).status == 200)
        #expect(app.groups.group(id)?.meeting == nil && app.groups.group(id)?.purpose == nil)

        #expect(try await ask("kuvo/groups/\(id)", method: "PATCH", body: ["members": [ada.id]]).status == 400)
        #expect(try await ask("kuvo/groups/\(id)", method: "PATCH", body: ["name": " "]).status == 400)
        // One that isn't there says so, apart from an older Mac's answer to a route it doesn't know.
        let gone = try await ask("kuvo/groups/grp_none000001", method: "PATCH", body: ["name": "X"])
        #expect(gone.status == 404 && gone.json?["message"] as? String == "That group chat isn’t there any more.")
    }

    /// The models known, as Edit Bot offers them: Luna's account signed out of, Sol's signed in.
    private func knowModels() async {
        func model(_ id: String, _ provider: String, _ name: String) -> [String: Any] {
            ["id": id, "modelID": id, "providerID": provider, "name": name, "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [],
             "time": ["released": 1], "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true, "limit": ["context": 100_000, "output": 8_000]]
        }
        engine.on("GET", "/api/integration", json: ["location": ["directory": "/"], "data": [
            ["id": "openai", "name": "OpenAI", "methods": [["type": "key"]], "connections": []],
            ["id": "anthropic", "name": "Anthropic", "methods": [["type": "key"]], "connections": [["type": "credential", "id": "c1", "label": "Mine"]]]]])
        engine.on("GET", "/api/model", json: ["location": ["directory": "/"], "data": [model("luna", "openai", "Luna"), model("sol", "anthropic", "Sol")]])
        engine.on("GET", "/api/model/default", json: ["location": ["directory": "/"], "data": NSNull()])
        engine.on("GET", "/api/agent", json: ["location": ["directory": "/"], "data": []])
        engine.on("GET", "/api/command", json: ["location": ["directory": "/"], "data": []])
        app.catalog.api = engine.api
        await app.catalog.refresh()
    }

    /// A bot changed from a phone as Edit Bot changes it: its name, look, personality and model,
    /// kept, with its conversation told; listed with them as `kuvo/bots` lists it.
    @Test func aBotChangedFromAPhone() async throws {
        defer { done() }
        await knowModels()
        await app.workspace.refresh()
        let ada = try await app.bots.create(name: "Ada", look: BotLook(color: .mint, shape: .round, face: .calm), model: nil, machine: nil, project: nil)
        let changed = try await ask("kuvo/bots/\(ada.id)", method: "PATCH", body: [
            "name": " Ada\nPrime ", "look": ["color": "sky", "shape": "gem", "face": "wink"], "personality": "preset.straight",
            "model": ["providerID": "anthropic", "id": "sol", "variant": "high"],
        ])
        #expect(changed.status == 200)
        let listed = try #require(changed.json?["bot"] as? [String: Any])
        #expect(listed["id"] as? String == ada.id && listed["name"] as? String == "Ada Prime" && listed["personality"] as? String == "preset.straight")
        #expect(listed["look"] as? [String: String] == ["color": "sky", "shape": "gem", "face": "wink"])
        #expect(listed["model"] as? [String: String] == ["providerID": "anthropic", "id": "sol", "variant": "high"])
        let bot = try #require(app.bots.bot(ada.id))
        #expect(bot.name == "Ada Prime" && bot.look == BotLook(color: .sky, shape: .gem, face: .wink) && bot.personality == "preset.straight")
        #expect(bot.model == ModelRef(id: "sol", providerID: "anthropic", variant: "high"))
        #expect(Bots().list.first?.name == "Ada Prime", "kept")
        // Its conversation hears of it, as from Edit Bot: its title, its model, what it's told.
        #expect(engine.requests("PATCH", "/api/session/\(ada.sessionID)").contains { $0.body["title"] as? String == "Ada Prime" })
        #expect(engine.requests("POST", "/api/session/\(ada.sessionID)/model").last?.body["model"] as? [String: String] == ["id": "sol", "providerID": "anthropic", "variant": "high"])
        let told = try #require(engine.requests("PUT", "/api/experimental/session/\(ada.sessionID)/instructions/entries/kuvo.bot").last?.body["value"] as? String)
        #expect(told == Bots.instructions(for: bot) && told.contains("Straight Shooter"))

        // Its own way again; only what's sent changes.
        let plain = try await ask("kuvo/bots/\(ada.id)", method: "PATCH", body: ["personality": NSNull()])
        #expect(plain.status == 200 && plain.json?["bot"].flatMap { ($0 as? [String: Any])?["personality"] } == nil)
        #expect(app.bots.bot(ada.id)?.personality == nil && app.bots.bot(ada.id)?.name == "Ada Prime")
    }

    @Test func aChangeThatCantBeIsSaid() async throws {
        defer { done() }
        await knowModels()
        await app.workspace.refresh()
        let luna = ModelRef(id: "luna", providerID: "openai")
        let ada = try await app.bots.create(name: "Ada", look: BotLook(color: .mint, shape: .round, face: .calm), model: nil, machine: nil, project: nil)
        let before = try #require(app.bots.bot(ada.id))
        for (body, status, words) in [
            (["name": " "], 400, "A bot needs a name."),
            (["look": ["color": "plaid", "shape": "round", "face": "calm"]], 400, "That isn’t a look a bot can have."),
            (["personality": "custom.gone"], 400, "There’s no personality “custom.gone”."),
            (["model": ["id": "x"]], 400, "That isn’t a model."),
        ] as [([String: Any], Int, String)] {
            let answer = try await ask("kuvo/bots/\(ada.id)", method: "PATCH", body: body.merging(["name": "Renamed"]) { given, _ in given })
            #expect(answer.status == status && message(answer) == words, "\(body)")
        }
        // A model whose account isn't signed in where it lives: said as Edit Bot would say it.
        let signedOut = try await ask("kuvo/bots/\(ada.id)", method: "PATCH", body: ["name": "Renamed", "model": ["id": "luna", "providerID": "openai"]])
        #expect(signedOut.status == 422 && message(signedOut) == app.catalog.unavailable(luna))
        #expect(app.bots.bot(ada.id) == before, "nothing changed")
        // The one it has stays, signed out of or not.
        var onLuna = before
        onLuna.model = luna
        await app.bots.update(onLuna)
        #expect(try await ask("kuvo/bots/\(ada.id)", method: "PATCH", body: ["name": "Renamed", "model": ["id": "luna", "providerID": "openai"]]).status == 200)

        let gone = try await ask("kuvo/bots/bot_none000001", method: "PATCH", body: ["name": "X"])
        #expect(gone.status == 404 && message(gone) == "That bot isn’t there any more.")
        #expect(try await ask("kuvo/bots/bot_none000001", method: "DELETE").status == 404)
        // On its way to another computer: neither, until it's there.
        link.isMoving = { $0 == ada.id }
        let moving = try await ask("kuvo/bots/\(ada.id)", method: "PATCH", body: ["name": "X"])
        #expect(moving.status == 409 && message(moving) == Moves.Failure.moving.localizedDescription)
        #expect(try await ask("kuvo/bots/\(ada.id)", method: "DELETE").status == 409)
        #expect(app.bots.bot(ada.id)?.name == "Renamed")
    }

    /// Deleted from a phone as Delete Bot… deletes it: gone from the list and its group chat, its
    /// conversation deleted, its folder in the Trash.
    @Test func aBotDeletedFromAPhone() async throws {
        defer { done() }
        engine.on("DELETE", "/api/session/*", json: [:])
        await app.workspace.refresh()
        let ada = try await app.bots.create(name: "Ada", look: .random(), model: nil, machine: nil, project: nil)
        let ben = try await app.bots.create(name: "Ben", look: .random(), model: nil, machine: nil, project: nil)
        let cy = try await app.bots.create(name: "Cy", look: .random(), model: nil, machine: nil, project: nil)
        let group = app.groups.create(name: "Release", purpose: nil, members: [ada.id, ben.id, cy.id], meeting: nil)

        let deleted = try await ask("kuvo/bots/\(ada.id)", method: "DELETE")
        #expect(deleted.status == 200 && deleted.json?.isEmpty == true)
        #expect(app.bots.bot(ada.id) == nil && Bots().list.map(\.id) == [ben.id, cy.id])
        #expect(engine.requests("DELETE", "/api/session/\(ada.sessionID)").count == 1, "its conversation is deleted")
        #expect(!FileManager.default.fileExists(atPath: ada.folder), "its folder went to the Trash")
        #expect(app.groups.group(group.id)?.members == [ben.id, cy.id])
        let listed = try #require(try await ask("kuvo/bots").json?["bots"] as? [[String: Any]])
        #expect(listed.map { $0["id"] as? String } == [ben.id, cy.id])
        #expect(try await ask("kuvo/bots/\(ada.id)", method: "DELETE").status == 404)
    }
}
