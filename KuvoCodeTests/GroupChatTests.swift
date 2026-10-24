import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A group chat talking something through (G1): after your message the lead speaks first, or the
/// bot you named with @; then the next in line, nobody twice in a row; it ends once everyone left
/// has nothing to add (they pass). Each bot speaks in a seat of its own, where it hears what was
/// said since its last turn. The engine is stubbed: each seat answers its turn with the next of
/// its bot's lines.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct GroupChatTests {
    let engine = StubEngine(port: 47984)
    let root = AppInfo.testRoot.appending(path: "GroupChat-\(UUID().uuidString.prefix(6))")
    let botsFile = AppInfo.supportDirectory.appending(path: "bots.json")
    let groupsFile = AppInfo.supportDirectory.appending(path: "groups.json")

    /// Each seat's turns, as the engine runs them: who it is, what it was sent, what it answers.
    nonisolated final class Seats: @unchecked Sendable {
        private let lock = NSLock()
        private var bots: [String: String] = [:]
        private var lines: [String: [String]] = [:]
        private var answered: [String: (prompt: String, text: String)] = [:]
        private(set) var turns: [(bot: String, heard: String)] = []
        private var next = 1
        /// How much a bot's seats send the model (their context, in tokens), as their answers say:
        /// one for each turn in turn, the last kept.
        var sizes: [String: [Int]] = [:]
        private var answeredSize: [String: Int] = [:]
        /// Conversations deleted, and each one's bot.
        private(set) var deleted: [(seat: String, bot: String)] = []

        func delete(_ seat: String) {
            lock.withLock { deleted.append((seat, bots[seat] ?? "")) }
        }

        init(lines: [String: [String]]) { self.lines = lines }

        func seat(for title: String) -> String {
            lock.withLock {
                let bot = String(title.prefix { $0 != " " })
                let id = "ses_seat_\(next)"
                next += 1
                bots[id] = bot
                return id
            }
        }

        /// A turn given to `seat`: its bot's next line.
        func turn(_ seat: String, prompt: String, text: String) {
            lock.withLock {
                guard let bot = bots[seat] else { return }
                turns.append((bot, text))
                let line = lines[bot]?.isEmpty == false ? lines[bot]!.removeFirst() : "PASS"
                answered[seat] = (prompt, line)
                if var queue = sizes[bot], let size = queue.first {
                    if queue.count > 1 { queue.removeFirst() }
                    sizes[bot] = queue
                    answeredSize[seat] = size
                } else {
                    answeredSize[seat] = nil
                }
            }
        }

        func conversation(_ seat: String) -> [[String: Any]] {
            lock.withLock {
                guard let (prompt, text) = answered[seat] else { return [] }
                // A line "ERROR: …" is its provider turning the step down with those words.
                let refused = text.hasPrefix("ERROR: ") ? String(text.dropFirst(7)) : nil
                var reply: [String: Any] = ["id": prompt + "_reply", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3],
                                            "model": ["id": "m", "providerID": "p"], "content": refused == nil ? [["type": "text", "text": text]] : []]
                if let refused { reply["error"] = ["type": "provider", "message": refused] }
                if let size = answeredSize[seat] {
                    reply["tokens"] = ["input": size, "output": 10, "reasoning": 0, "cache": ["read": 0, "write": 0]]
                }
                return [["id": prompt, "type": "user", "time": ["created": 1], "text": "(turn)"], reply]
            }
        }

        /// The discussion's turns: not the lead's request, after it, to list who does what.
        var speakers: [String] { lock.withLock { turns.filter { !$0.heard.contains("For the app, not the chat") }.map(\.bot) } }
    }

    /// The workspace, for the engine's events from its own thread.
    nonisolated final class Events: @unchecked Sendable {
        let workspace: Workspace
        let engine: StubEngine
        init(_ workspace: Workspace, _ engine: StubEngine) {
            self.workspace = workspace
            self.engine = engine
        }

        func ran(_ seat: String) {
            let started = try? engine.event("session.execution.started", session: seat)
            let ended = try? engine.event("session.execution.succeeded", session: seat)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if let started { self.workspace.handle(started) }
                    if let ended { self.workspace.handle(ended) }
                }
            }
        }
    }

    private func bot(_ id: String, _ name: String, model: ModelRef? = nil) -> [String: Any] {
        let folder = root.appending(path: id).path(percentEncoded: false)
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        var bot: [String: Any] = ["id": id, "name": name, "job": "Helps", "instructions": "Helps.", "jobInMemory": true,
                                  "look": ["color": "mint", "shape": "round", "face": "calm"], "folder": folder,
                                  "sessionID": "ses_" + id, "created": "2026-10-21T09:00:00Z"]
        if let model { bot["model"] = ["id": model.id, "providerID": model.providerID] }
        return bot
    }

    /// Ada (the lead) and Ben in a chat, with the lines they'll say; the app around them.
    private func start(lines: [String: [String]], meeting: BotGroup.Meeting? = nil, benOn model: ModelRef? = nil, benTalksOn conversation: ModelRef? = nil,
                       withCy: Bool = false) async throws -> (AppModel, BotGroup, Seats) {
        try FileManager.default.createDirectory(at: botsFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Cy: a bot of yours that isn't in the chat.
        try JSONSerialization.data(withJSONObject: [bot("bot_ada", "Ada"), bot("bot_ben", "Ben", model: model)] + (withCy ? [bot("bot_cy", "Cy")] : [])).write(to: botsFile)
        let app = AppModel()
        app.bots.app = app
        app.wakeUps.app = app
        app.groups.app = app
        app.workspace.api = engine.api
        engine.list([StubEngine.session("ses_bot_ada", title: "Ada", directory: root.appending(path: "bot_ada").path(percentEncoded: false)),
                     StubEngine.session("ses_bot_ben", title: "Ben", directory: root.appending(path: "bot_ben").path(percentEncoded: false),
                                        extra: conversation.map { ["model": ["id": $0.id, "providerID": $0.providerID]] } ?? [:])]
                    + (withCy ? [StubEngine.session("ses_bot_cy", title: "Cy", directory: root.appending(path: "bot_cy").path(percentEncoded: false))] : []))
        let seats = Seats(lines: lines)
        let events = Events(app.workspace, engine)
        let directory = root.path(percentEncoded: false)
        engine.on("POST", "/api/session") { request in
            let id = seats.seat(for: request.body["title"] as? String ?? "")
            return StubWeb.json(["data": StubEngine.session(id, title: request.body["title"] as? String ?? "", directory: directory)])
        }
        engine.on("PATCH", "/api/session/*", json: [:])
        engine.on("PUT", "/api/experimental/session/*", json: [:])
        engine.on("POST", "/api/session/ses_seat_*") { request in
            let seat = request.path.split(separator: "/")[2]
            if request.path.hasSuffix("/prompt") {
                seats.turn(String(seat), prompt: request.body["id"] as? String ?? "", text: request.body["text"] as? String ?? "")
                events.ran(String(seat))
            }
            return StubWeb.json([:])
        }
        engine.on("DELETE", "/api/session/ses_seat_*") { request in
            seats.delete(String(request.path.split(separator: "/")[2]))
            return StubWeb.json([:])
        }
        engine.on("GET", "/api/session/ses_seat_*") { request in
            let seat = String(request.path.split(separator: "/")[2])
            if request.path.hasSuffix("/message") { return StubWeb.json(["data": Array(seats.conversation(seat).reversed())]) }
            return StubWeb.json(["data": StubEngine.session(seat, title: "seat", directory: directory)])
        }
        await app.workspace.refresh()
        let group = app.groups.create(name: "Team", members: ["bot_ada", "bot_ben"], meeting: meeting)
        return (app, group, seats)
    }

    private func done() {
        engine.stop()
        try? FileManager.default.removeItem(at: botsFile)
        try? FileManager.default.removeItem(at: groupsFile)
        try? FileManager.default.removeItem(at: root)
    }

    /// What was said in the chat: who, in order (nil for you).
    private func said(_ app: AppModel, _ group: BotGroup) -> [String?] {
        app.groups.messages(in: group.id).filter { $0.kind == .message }.map(\.author)
    }

    private func talkedThrough(_ app: AppModel, _ group: BotGroup) async throws {
        // Begun as it was asked (a message sent, Keep Going, a meeting due): until it's over.
        try await until { !app.groups.discussing.contains(group.id) }
    }

    @Test func theLeadFirstNobodyTwiceInARowUntilEveryonePasses() async throws {
        defer { done() }
        let (app, group, seats) = try await start(lines: [
            "Ada": ["SQLite: one file, nothing to run.", "PASS"],
            "Ben": ["Agreed, and it's fast enough for notes.", "PASS"],
        ])
        app.groups.send("Which database for the notes app?", to: group.id)
        try await talkedThrough(app, group)
        #expect(said(app, group) == [nil, "bot_ada", "bot_ben"])
        let speakers = seats.speakers
        #expect(speakers.first == "Ada", "the lead speaks first")
        #expect(zip(speakers, speakers.dropFirst()).allSatisfy { $0 != $1 }, "nobody twice in a row: \(speakers)")
        // Each heard your message, and Ben what Ada said before him.
        #expect(seats.turns.first?.heard.contains("Which database for the notes app?") == true)
        #expect(seats.turns.first { $0.bot == "Ben" }?.heard.contains("SQLite: one file") == true)
    }

    /// Named with &, a bot of yours outside the chat answers it, once, as a guest: given the whole
    /// chat, in a conversation of its own for the turn, which goes once it has; it doesn't join.
    @Test func aBotOutsideTheChatNamedWithAndAnswersAsAGuest() async throws {
        defer { done() }
        let (app, group, seats) = try await start(lines: ["Cy": ["Cy here: ship it."], "Ada": ["PASS"], "Ben": ["PASS"]], withCy: true)
        app.groups.send("&Cy, what do you think?", to: group.id)
        try await talkedThrough(app, group)
        #expect(said(app, group) == [nil, "bot_cy"])
        #expect(app.groups.messages(in: group.id).last { $0.author == "bot_cy" }?.text == "Cy here: ship it.")
        let asked = try #require(seats.turns.first { $0.bot == "Cy" })
        #expect(asked.heard.hasPrefix("You're not in \"Team\", but the user named you there with &Cy, so you answer this once, as a guest."))
        #expect(asked.heard.contains("&Cy, what do you think?"))
        #expect(app.groups.group(group.id)?.members == ["bot_ada", "bot_ben"])
        #expect(app.groups.group(group.id)?.seats["bot_cy"] == nil)
        for going in app.groups.droppingScratch.values { await going.value }
        #expect(seats.deleted.contains { $0.bot == "Cy" }, "its conversation for the turn goes once it has answered")
    }

    /// A seat grown well past the chat (pages it read, long answers) since its first turn goes
    /// after the turn, and the bot's next turn is in a new seat, given the whole chat, its own
    /// words as "You". What it carries at every turn (instructions and tools) doesn't count.
    @Test func aSeatGrownPastTheChatStartsOverWithTheWholeChat() async throws {
        defer { done() }
        // Each discussion's work list, in a conversation of its own, takes a line and a size too.
        let (app, group, seats) = try await start(lines: ["Ada": ["Hi there.", "NONE", "Grown.", "NONE", "Still here."], "Ben": ["PASS", "PASS", "PASS"]])
        seats.sizes = ["Ada": [5_000, 5_000, 40_000, 1_000]]
        app.groups.send("Anyone there?", to: group.id)
        try await talkedThrough(app, group)
        #expect(!seats.deleted.contains { $0.bot == "Ada" && $0.seat == app.groups.group(group.id)?.seats["bot_ada"] })
        let first = try #require(app.groups.group(group.id)?.seats["bot_ada"])
        app.groups.send("Again?", to: group.id)
        try await talkedThrough(app, group)
        #expect(seats.deleted.contains { $0.seat == first }, "her grown seat went")
        #expect(app.groups.group(group.id)?.seats["bot_ada"] == nil)
        app.groups.send("Once more?", to: group.id)
        try await talkedThrough(app, group)
        let fresh = try #require(seats.turns.last { $0.bot == "Ada" && $0.heard.contains("Once more?") })
        #expect(fresh.heard.hasPrefix("Everything said in \"Team\" so far, from the start:"))
        #expect(fresh.heard.contains("You:\n    Grown."))
        #expect(fresh.heard.contains("User:\n    Anyone there?"))
    }

    /// A seat that carries a lot at every turn (a bot with many tools) keeps its seat as long as
    /// it hasn't grown.
    @Test func aSeatThatStartsBigKeepsItsSeat() async throws {
        defer { done() }
        let (app, group, seats) = try await start(lines: ["Ada": ["Hi there.", "NONE", "Still here."], "Ben": ["PASS", "PASS"]])
        seats.sizes = ["Ada": [45_000, 45_000, 48_000]]
        app.groups.send("Anyone there?", to: group.id)
        try await talkedThrough(app, group)
        let first = try #require(app.groups.group(group.id)?.seats["bot_ada"])
        app.groups.send("Again?", to: group.id)
        try await talkedThrough(app, group)
        #expect(app.groups.group(group.id)?.seats["bot_ada"] == first)
        #expect(!seats.deleted.contains { $0.seat == first })
    }

    /// Named with &, a bot speaks first, the lead after it; being in the chat, it's asked there,
    /// not described to the others as an agent to go and write to.
    /// A bot on a model whose account you signed out of says so in the chat, naming what to sign
    /// in to, and the talk goes on without it; nothing goes to its seat, where the engine would
    /// drop it without a word (the chat waited, then nothing).
    @Test func aBotWhoseAccountYouSignedOutOfSaysSo() async throws {
        defer { done() }
        let luna = ModelRef(id: "luna", providerID: "openai")
        let (app, group, seats) = try await start(lines: ["Ada": ["Morning!", "PASS"], "Ben": ["Hi!", "PASS"]], benOn: luna)
        engine.on("GET", "/api/integration", json: ["location": ["directory": "/"], "data": [["id": "openai", "name": "OpenAI", "methods": [["type": "key"]], "connections": []]]])
        engine.on("GET", "/api/model", json: ["location": ["directory": "/"], "data": [[
            "id": "luna", "modelID": "luna", "providerID": "openai", "name": "Luna",
            "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [], "time": ["released": 1],
            "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true, "limit": ["context": 100_000, "output": 8_000]]]])
        engine.on("GET", "/api/model/default", json: ["location": ["directory": "/"], "data": NSNull()])
        engine.on("GET", "/api/agent", json: ["location": ["directory": "/"], "data": []])
        engine.on("GET", "/api/command", json: ["location": ["directory": "/"], "data": []])
        app.catalog.api = engine.api
        await app.catalog.refresh()
        #expect(app.catalog.isLoaded, "the models known")
        #expect(app.catalog.isUnavailable(luna), "known, and signed out of")
        #expect(app.bots.bot("bot_ben")?.model == luna, "Ben's model")
        app.groups.send("Morning all", to: group.id)
        try await talkedThrough(app, group)
        #expect(said(app, group) == [nil, "bot_ada"])
        #expect(!seats.turns.contains { $0.bot == "Ben" }, "nothing sent to its seat")
        let note = try #require(app.groups.messages(in: group.id).first { $0.kind == .note })
        #expect(note.text.hasPrefix("Ben couldn’t answer: Luna needs a sign-in: sign in to Codex (your ChatGPT plan"), "\(note.text)")
    }

    /// A provider that turns a bot's request down for want of a sign-in is said in words that say
    /// what to do, not in the provider's.
    /// Ben was given a model whose account you then signed out of (Edit Bot shows none for him),
    /// and you picked another in his own conversation: he talks on that one in the chat.
    @Test func aBotTalksOnItsConversationsModelWhenItsOwnIsSignedOut() async throws {
        defer { done() }
        let luna = ModelRef(id: "luna", providerID: "openai"), sol = ModelRef(id: "sol", providerID: "anthropic")
        let (app, group, seats) = try await start(lines: ["Ada": ["Morning!", "PASS"], "Ben": ["Hi!", "PASS"]], benOn: luna, benTalksOn: sol)
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
        #expect(app.catalog.isUnavailable(luna) && !app.catalog.isUnavailable(sol))
        app.groups.send("Morning all", to: group.id)
        try await talkedThrough(app, group)
        #expect(said(app, group) == [nil, "bot_ada", "bot_ben"], "\(app.groups.messages(in: group.id).map(\.text))")
        #expect(!app.groups.messages(in: group.id).contains { $0.kind == .note })
        let made = engine.requests("POST", "/api/session").first { ($0.body["title"] as? String)?.hasPrefix("Ben") == true }
        #expect((made?.body["model"] as? [String: Any])?["id"] as? String == "sol", "his seat is on his conversation's model")
        #expect(seats.turns.contains { $0.bot == "Ben" })
    }

    @Test func aRefusedSignInIsSaidPlainly() async throws {
        defer { done() }
        let (app, group, _) = try await start(lines: ["Ada": ["Morning!", "PASS"], "Ben": ["ERROR: Missing required Authorization header"]])
        app.groups.send("Morning all", to: group.id)
        try await talkedThrough(app, group)
        let note = try #require(app.groups.messages(in: group.id).first { $0.kind == .note })
        #expect(note.text.hasPrefix("Ben couldn’t answer: ") && note.text.contains("isn’t signed in: sign in to it again in Settings › Accounts"), "\(note.text)")
    }

    /// From a phone, as in the window: your message starts the talk, the list shows the chat with
    /// its last word, Undo takes your message back with what came after it (its words for the
    /// phone's composer), and looking at it clears unread. A chat that isn't there, or a message
    /// with no words, says so.
    @Test func aPhoneWritesInAChatAndTakesItBack() async throws {
        defer { done() }
        let (app, group, _) = try await start(lines: ["Ada": ["Morning!", "PASS"], "Ben": ["Hi!", "PASS"]])
        let link = PhoneLink()
        link.groups = app.chats
        link.bots = app.bots
        func ask(_ path: String, _ body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]?) {
            let request = LinkRequest(method: body == nil ? "GET" : "POST", path: path, headers: ["content-type": "application/json"],
                                      body: try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data())
            var status = 0
            var data = Data()
            for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:9/")!, password: nil, agents: nil) {
                switch part {
                case .head(let code, _): status = code
                case .body(let chunk): data += chunk
                }
            }
            return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
        }

        #expect(try await ask("kuvo/groups/\(group.id)", ["text": "Morning all"]).status == 200)
        try await talkedThrough(app, group)
        #expect(said(app, group) == [nil, "bot_ada", "bot_ben"])
        let listed = try #require((try await ask("kuvo/groups").json?["groups"] as? [[String: Any]])?.first)
        #expect(listed["id"] as? String == group.id && (listed["last"] as? [String: Any])?["text"] as? String == "Hi!")

        let mine = try #require(app.groups.messages(in: group.id).first { $0.author == nil && $0.kind == .message })
        let undone = try await ask("kuvo/groups/\(group.id)/undo", ["message": mine.id])
        #expect(undone.status == 200 && undone.json?["text"] as? String == "Morning all")
        #expect(said(app, group).isEmpty, "taken back, with what came after it")

        #expect(try await ask("kuvo/groups/\(group.id)/viewed", [:]).status == 200)
        #expect(!app.groups.isUnread(try #require(app.groups.group(group.id))))
        #expect(try await ask("kuvo/groups/\(group.id)", ["text": "  "]).status == 400)
        #expect(try await ask("kuvo/groups/grp_nothere000", ["text": "Hello?"]).status == 404)
    }

    @Test func aBotYouNameSpeaksFirst() async throws {
        defer { done() }
        let (app, group, seats) = try await start(lines: [
            "Ada": ["I'd go with Postgres.", "PASS"],
            "Ben": ["SQLite, it's a notes app.", "PASS"],
        ])
        // Bots are agents "&" names, as in the app.
        let before = AgentMail.shared.app
        AgentMail.shared.app = app
        defer { AgentMail.shared.app = before }
        app.groups.send("&Ben which database?", to: group.id)
        try await talkedThrough(app, group)
        #expect(seats.speakers.first == "Ben")
        #expect(said(app, group) == [nil, "bot_ben", "bot_ada"])
        #expect(seats.turns.allSatisfy { !$0.heard.contains("<named-agents>") })
    }

    /// A debate that goes on (G3): it pauses after its turns (three a bot, at least four), the lead
    /// sums up where it stands, and Keep Going carries it on from there until they've said all
    /// they had.
    @Test func aLongDebatePausesAndKeepGoingCarriesOn() async throws {
        defer { done() }
        let (app, group, seats) = try await start(lines: [
            "Ada": ["Tabs.", "Tabs are one key.", "Tabs let each choose a width.", "Still tabs.", "PASS"],
            "Ben": ["Spaces.", "Spaces look the same everywhere.", "Spaces in every style guide.", "Still spaces.", "PASS"],
        ])
        app.groups.send("Tabs or spaces?", to: group.id)
        try await talkedThrough(app, group)
        #expect(said(app, group).compactMap { $0 }.count == 6, "six turns for two bots")
        #expect(app.groups.paused.contains(group.id))
        // The lead sums up where it stands.
        #expect(app.groups.messages(in: group.id).last { $0.kind == .wrapUp }?.author == "bot_ada")

        app.groups.keepGoing(group.id)
        try await talkedThrough(app, group)
        #expect(!app.groups.paused.contains(group.id))
        let carriedOn = said(app, group).compactMap { $0 }
        #expect(carriedOn.count > 6, "it carries on: \(carriedOn)")
        #expect(seats.speakers.last != nil)
    }

    /// Undo From Here (G3): your message and what came after it go, its words come back to you,
    /// and the bots that heard it are told it was taken back at their next turn, once.
    @Test func undoFromYourMessage() async throws {
        defer { done() }
        let (app, group, seats) = try await start(lines: [
            "Ada": ["Postgres, then.", "PASS", "SQLite, for a small app.", "PASS"],
            "Ben": ["Fine by me.", "PASS", "Agreed.", "PASS"],
        ])
        app.groups.send("We need a big database server.", to: group.id)
        try await talkedThrough(app, group)
        let mine = try #require(app.groups.messages(in: group.id).first { $0.author == nil })
        #expect(app.groups.undo(from: mine.id, in: group.id) == "We need a big database server.")
        #expect(app.groups.messages(in: group.id).filter { $0.kind == .message }.isEmpty, "the message and what came after it go")

        app.groups.send("It's a small notes app.", to: group.id)
        try await talkedThrough(app, group)
        let after = seats.turns.filter { !$0.heard.contains("For the app, not the chat") }.suffix(2)
        // Told it was taken back, with what it said, and told so once.
        let ada = try #require(after.first { $0.bot == "Ada" })
        #expect(ada.heard.contains("We need a big database server."))
        #expect(ada.heard.contains("It's a small notes app."))
        #expect(app.groups.group(group.id)?.retracted == nil)
    }

    /// A meeting you scheduled once (G4): when it comes, its topic is in the chat as the meeting's,
    /// the bots talk it through, the lead first, and the schedule is clear, after Kuvo Code opens
    /// again too; it doesn't come twice.
    @Test func aOneOffMeetingComesOnceAndClears() async throws {
        defer { done() }
        let topic = "Standup: what's blocking the release?"
        let (app, group, seats) = try await start(lines: ["Ada": ["The notarization step.", "PASS"], "Ben": ["Nothing on my side.", "PASS"]],
                                                  meeting: .init(next: .now.addingTimeInterval(-1), topic: topic))
        app.groups.meetDue()
        try await talkedThrough(app, group)
        let meetings = app.groups.messages(in: group.id).filter { $0.kind == .meeting }
        #expect(meetings.map(\.text) == [topic])
        #expect(seats.speakers.first == "Ada", "the lead speaks first")
        #expect(seats.turns.first?.heard.contains(topic) == true)
        #expect(app.groups.group(group.id)?.meeting == nil, "a one-off's schedule clears")
        #expect(BotGroups().group(group.id)?.meeting == nil, "and stays clear when Kuvo Code opens again")
        app.groups.meetDue()
        #expect(app.groups.messages(in: group.id).filter { $0.kind == .meeting }.count == 1, "it doesn't come twice")
    }

    /// A daily meeting missed for days while Kuvo Code was closed (G4): it's held once, and next
    /// comes at its own time of day; one due again within a few hours of the missed one held now
    /// is skipped to the day after.
    @Test(arguments: [-1.0, 1.0])
    func aDailyMeetingMissedForDaysIsHeldOnce(hoursFromNow: Double) async throws {
        defer { done() }
        let calendar = Calendar.current
        let first = try #require(calendar.date(byAdding: .day, value: -3, to: .now.addingTimeInterval(hoursFromNow * 3600)))
        let (app, group, _) = try await start(lines: ["Ada": ["PASS"], "Ben": ["PASS"]],
                                              meeting: .init(next: first, every: "1d", topic: "Daily standup"))
        app.groups.meetDue()
        try await talkedThrough(app, group)
        #expect(app.groups.messages(in: group.id).filter { $0.kind == .meeting }.count == 1, "missed for days, held once")
        let next = try #require(app.groups.group(group.id)?.meeting?.next)
        #expect(Wakes.minutes(of: next) == Wakes.minutes(of: first), "at its own time of day")
        let wait = next.timeIntervalSinceNow / 3600
        #expect(wait > 3 && wait < 26, "next at its time tomorrow, not a few hours after this one: in \(wait) h")
    }

    /// A bot deleted (F8) leaves its chats: its seat there is deleted on the engine, and the chat
    /// goes on with the others, who no longer count it in.
    @Test func aDeletedBotLeavesItsChats() async throws {
        defer { done() }
        let (app, group, _) = try await start(lines: ["Ada": ["Hello.", "PASS"], "Ben": ["Hi.", "PASS"]])
        engine.on("DELETE", "/api/session/*", json: [:])
        app.groups.send("Say hello.", to: group.id)
        try await talkedThrough(app, group)
        let seat = try #require(app.groups.group(group.id)?.seats["bot_ben"])
        let ben = try #require(app.bots.bot("bot_ben"))

        try await app.bots.delete(ben)
        #expect(engine.requests("DELETE", "/api/session/\(seat)").count == 1, "its seat goes")
        let after = try #require(app.groups.group(group.id))
        #expect(after.members == ["bot_ada"])
        #expect(after.seats["bot_ben"] == nil && after.heard["bot_ben"] == nil)
        #expect(!app.workspace.seats.contains(seat))
    }
}
