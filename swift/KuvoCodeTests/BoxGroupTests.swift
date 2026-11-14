import AppKit
import Foundation
import KuvoLink
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Group chats on your computers, as the window shows them: this Mac's and a machine's alike, each
/// as its computer's bridge last said, following what it says as they go; what you do in one goes
/// where it lives. One whose bots all live on a machine moves there, and back; one whose bots live
/// on different computers stays where it is, and a bot in a machine's chat stays with it. A move
/// cut short is taken back. Both bridges are stubbed, holding their chats as the runner does
/// (`Packages/Box/src/agents/groups`); RealBridgeGroupTests runs the real one.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BoxGroupTests {
    let mac = StubEngine(port: 47986)
    let macBridge = StubEngine(port: 47950, alongside: true)
    let machineBridge = StubEngine(port: 47985, alongside: true)
    let here = Held()
    let there = Held()
    var botsFile: URL { AppInfo.supportDirectory.appending(path: "bots.json") }

    init() {
        Self.clean()
    }

    private static func clean() {
        for name in ["bots.json", "groups.json", "groups", "group-chats.json", "group-chats", "machine-groups.json", "machine-groups"] {
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name))
        }
        try? FileManager.default.removeItem(at: AppInfo.testTrash)
        UserDefaults.standard.removeObject(forKey: "movesUnderWay")
    }

    /// The chats on a computer, as its runner keeps them, from any thread.
    nonisolated final class Held: @unchecked Sendable {
        private let lock = NSLock()
        private var chats: [String: (group: [String: Any], status: String, messages: [[String: Any]])] = [:]
        private var asked: [String] = []
        var actions: [String] { lock.withLock { asked } }

        func add(_ group: [String: Any], status: String = "active", messages: [[String: Any]] = []) {
            lock.withLock { chats[group["id"] as! String] = (group, status, messages) }
        }

        func has(_ id: String) -> Bool { lock.withLock { chats[id] != nil } }
        func status(_ id: String) -> String? { lock.withLock { chats[id]?.status } }
        func messages(_ id: String) -> [[String: Any]] { lock.withLock { chats[id]?.messages ?? [] } }
        func group(_ id: String) -> [String: Any]? { lock.withLock { chats[id]?.group } }

        func answer(_ request: StubEngine.Request) -> StubWeb.Answer {
            defer { TestPulse.beat() }
            return lock.withLock {
                let parts = request.path.split(separator: "/").map(String.init).dropFirst(3)
                let id = parts.first
                let action = parts.dropFirst().first
                asked.append("\(request.method) \(([id, action].compactMap { $0 }).joined(separator: "/"))")
                let read = { (id: String) -> [String: Any] in
                    let chat = self.chats[id]!
                    return ["group": chat.group, "status": chat.status, "state": ["discussing": false, "paused": false], "messages": chat.messages]
                }
                switch (request.method, id, action) {
                case ("GET", nil, _):
                    return StubWeb.json(["version": 1, "data": chats.keys.sorted().map { key in
                        ["group": chats[key]!.group, "status": chats[key]!.status, "state": ["discussing": false, "paused": false], "last": chats[key]!.messages.last as Any]
                    }])
                // Your clock (`routes.ts`: the Mac sends only that, to `clock`).
                case ("PUT", "clock", _):
                    return StubWeb.json([:])
                // Any other id that isn't a chat's: no such chat, never taken for one, as the box
                // answers. (Its other settings paths the Mac doesn't send.)
                case (_, let id?, _) where !id.hasPrefix("grp_"):
                    return StubWeb.json(["message": "No such chat."], status: 404)
                case ("GET", let id?, nil):
                    return chats[id] == nil ? StubWeb.json(["message": "No such chat."], status: 404) : StubWeb.json(["data": read(id)])
                case ("PUT", let id?, nil):
                    if chats[id] != nil { return StubWeb.json(["message": "That chat is here already."], status: 409) }
                    chats[id] = (request.body["group"] as? [String: Any] ?? [:], request.body["status"] as? String ?? "held", request.body["messages"] as? [[String: Any]] ?? [])
                    return StubWeb.json(["data": read(id)])
                case ("PATCH", let id?, nil):
                    guard var chat = chats[id] else { return StubWeb.json(["message": "No such chat."], status: 404) }
                    if let members = request.body["members"] { chat.group["members"] = members }
                    if let name = request.body["name"] { chat.group["name"] = name }
                    chats[id] = chat
                    return StubWeb.json(["data": read(id)])
                case ("DELETE", let id?, nil):
                    guard let chat = chats[id] else { return StubWeb.json(["message": "No such chat."], status: 404) }
                    if chat.status == "held" { return StubWeb.json(["message": "That chat is moving."], status: 409) }
                    chats[id] = nil
                    return StubWeb.json([:])
                case ("POST", let id?, "activate"):
                    chats[id]?.status = "active"
                    return StubWeb.json(["data": read(id)])
                case ("POST", let id?, "hold"):
                    chats[id]?.status = "held"
                    return StubWeb.json(["data": ["group": chats[id]!.group, "messages": chats[id]!.messages]])
                case ("POST", let id?, "release"):
                    guard chats[id] != nil else { return StubWeb.json(["message": "No such chat."], status: 404) }
                    chats[id] = nil
                    return StubWeb.json([:])
                case ("POST", let id?, "stop"), ("POST", let id?, "keep-going"), ("POST", let id?, "start-work"):
                    if chats[id]?.status == "held" { return StubWeb.json(["message": "That chat is moving."], status: 409) }
                    return StubWeb.json([:])
                case ("POST", let id?, "send"):
                    if chats[id]?.status == "held" { return StubWeb.json(["message": "That chat is moving."], status: 409) }
                    let message: [String: Any] = ["id": "gm_sent", "text": request.body["text"] as? String ?? "", "time": "2026-10-22T09:00:00Z", "kind": "message"]
                    chats[id]?.messages.append(message)
                    return StubWeb.json(["data": message])
                default:
                    return StubWeb.json([:])
                }
            }
        }
    }

    private func app(machine: String = "box") -> AppModel {
        let app = AppModel()
        app.bots.app = app
        app.wakeUps.app = app
        app.boxGroups.app = app
        app.moves.app = app
        app.workspace.api = mac.api
        let macAPI = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: macBridge.url)!, password: "test"))
        let machineAPI = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: machineBridge.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: machine))
        app.boxGroups.bridge = { $0 == nil ? macAPI : $0 == machine ? machineAPI : nil }
        for (bridge, held) in [(macBridge, here), (machineBridge, there)] {
            bridge.on("GET", "/api/kuvo/groups") { held.answer($0) }
            for method in ["GET", "PUT", "PATCH", "DELETE", "POST"] { bridge.on(method, "/api/kuvo/groups/*") { held.answer($0) } }
        }
        mac.on("PATCH", "/api/session/*", json: [:])
        return app
    }

    private func saveBots(_ bots: [(String, String, String?)]) throws {
        try FileManager.default.createDirectory(at: botsFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: bots.map { id, name, machine in
            var bot: [String: Any] = ["id": id, "name": name, "job": "Helps", "instructions": "Helps.", "jobInMemory": true,
                                      "look": ["color": "mint", "shape": "round", "face": "calm"],
                                      "folder": machine == nil ? AppInfo.testRoot.appending(path: id).path : "/home/me/.kuvo-code/bots/\(id)",
                                      "sessionID": "ses_" + id, "created": "2026-10-21T09:00:00Z"]
            if let machine { bot["machine"] = machine }
            return bot
        }).write(to: botsFile)
    }

    private nonisolated static func group(_ id: String, members: [String], seats: [String: String] = [:]) -> [String: Any] {
        ["id": id, "name": "Crew", "members": members, "seats": seats, "heard": [:], "created": "2026-10-21T09:00:00Z"]
    }

    private static let said: [String: Any] = ["id": "gm_1", "author": "bot_pal", "text": "Morning.", "time": "2026-10-22T08:00:00Z", "kind": "message"]

    @Test func eachComputersChatsShowAndFollowWhatItSays() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box"), ("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        here.add(Self.group("grp_mac0000001", members: ["bot_ada", "bot_ben"]))
        there.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"], seats: ["bot_pal": "ses_seatP"]), messages: [Self.said])
        let app = app()

        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")

        #expect(here.actions.first == "PUT clock" && there.actions.first == "PUT clock", "your clock, before its chats are read")
        #expect(Set(app.chats.list.map(\.id)) == ["grp_mac0000001", "grp_box0000001"])
        #expect(app.chats.machine(of: "grp_box0000001") == "box" && app.chats.machine(of: "grp_mac0000001") == nil)
        #expect(app.chats.messages(in: "grp_box0000001").map(\.text) == ["Morning."])
        #expect(app.chats.isUnread(app.chats.group("grp_box0000001")!), "a bot's message you haven't seen")
        #expect(app.workspace.seats.contains("ses_seatP"), "its seats stay out of the lists")
        // What each says as it goes: a bot talking, a new message.
        let group = Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"], seats: ["bot_pal": "ses_seatP"])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["speaking": "bot_lb", "discussing": true, "paused": false]]), machine: "box")
        #expect(app.chats.speaking["grp_box0000001"] == "bot_lb" && app.chats.discussing.contains("grp_box0000001"))
        app.boxGroups.handle(try macBridge.event("kuvo.group.message", ["id": "grp_mac0000001", "message":
            ["id": "gm_2", "author": "bot_ada", "text": "Build is green.", "time": "2026-10-22T08:01:00Z", "kind": "message"]]), machine: nil)
        #expect(app.chats.messages(in: "grp_mac0000001").map(\.text) == ["Build is green."])
        // A message from one computer isn't taken for another's chat.
        app.boxGroups.handle(try machineBridge.event("kuvo.group.message", ["id": "grp_mac0000001", "message":
            ["id": "gm_3", "author": "bot_pal", "text": "Not here.", "time": "2026-10-22T08:02:00Z", "kind": "message"]]), machine: "box")
        #expect(app.chats.messages(in: "grp_mac0000001").count == 1)
        // Seen last, for while a computer is away or this Mac's bridge starts.
        app.boxGroups.flush()
        let lastSeen = BoxGroups()
        #expect(Set(lastSeen.chats.map(\.group.id)) == ["grp_mac0000001", "grp_box0000001"] && lastSeen.messages(in: "grp_box0000001").count == 1)
        #expect(lastSeen.discussing.isEmpty, "nothing talks until its computer says so")
        // What you write goes where it lives.
        try await app.boxGroups.send("Go ahead", to: "grp_box0000001")
        try await app.boxGroups.send("Hello here", to: "grp_mac0000001")
        #expect(there.actions.contains("POST grp_box0000001/send") && here.actions.contains("POST grp_mac0000001/send"))
        #expect(!there.actions.contains("POST grp_mac0000001/send"))
        // Gone there: gone here.
        app.boxGroups.handle(try machineBridge.event("kuvo.group.deleted", ["id": "grp_box0000001"]), machine: "box")
        #expect(app.chats.list.map(\.id) == ["grp_mac0000001"])
    }

    /// A bot's steps you open stay open as the chat goes on, with what you read where it is, and
    /// after they've gone far out of view and come back. A chat's steps come with the bot's message,
    /// so what comes in meanwhile is more messages.
    @Test func stepsOpenInAChatStayOpenAsItGoesOn() async throws {
        TestEnvironment.prepare()
        defer { Self.clean(); mac.stop(); AXElement.reading(false) }
        try saveBots([("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        let id = "grp_mac0000002"
        let steps: [[String: Any]] = (1...3).map {
            ["id": "call_\($0)", "name": "shell", "executed": true,
             "state": ["status": "completed", "input": ["command": "echo step\($0)"], "content": [["type": "text", "text": "step\($0)"]]]]
        }
        func said(_ number: Int, steps: [[String: Any]]? = nil) -> [String: Any] {
            var message: [String: Any] = ["id": "gm_\(number)", "author": "bot_ada", "text": "Message \(number).", "time": "2026-10-22T08:00:00Z", "kind": "message"]
            if let steps { message["steps"] = steps }
            return message
        }
        here.add(Self.group(id, members: ["bot_ada", "bot_ben"]), messages: (1...30).map { said($0) } + [said(31, steps: steps)])
        let app = app()
        await app.boxGroups.connected(nil)
        let group = try #require(app.chats.group(id))

        AXElement.reading(true)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 560), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AnyView(GroupChatView(group: group)
            .environment(app)
            .environment(app.catalog)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .frame(width: 760, height: 560)))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.close(); window.contentView = nil }
        var labels: [String] {
            window.contentView?.layoutSubtreeIfNeeded()
            DispatchQueue.main.async { TestPulse.beat() }
            return AXElement.all(in: window.contentView).compactMap(\.label)
        }
        var isOpen: Bool { labels.contains { $0.contains("echo step1") } }
        try await until { labels.contains("Ran 3 commands") }
        let line = try #require(AXElement.all(in: window.contentView).first { $0.label == "Ran 3 commands" })
        #expect(line.press())
        try await until { isOpen }
        func stacks(_ view: NSView?) -> [RowStackView] {
            guard let view else { return [] }
            return (view as? RowStackView).map { [$0] } ?? view.subviews.flatMap(stacks)
        }
        let stack = try #require(stacks(window.contentView).first)
        let clip = try #require(stack.enclosingScrollView?.contentView)
        func go(to y: CGFloat) {
            clip.scroll(to: NSPoint(x: 0, y: y))
            stack.enclosingScrollView?.reflectScrolledClipView(clip)
            window.contentView?.layoutSubtreeIfNeeded()
        }
        // Opened, it shows all of it, and then lets go of the end; what comes in leaves it be.
        try await until {
            DispatchQueue.main.async { TestPulse.beat() }
            return stack.scrollAnchor?.isFollowingEnd == false
        }
        let before = clip.bounds.minY
        #expect(before > 0, "it can scroll")
        for number in 32...34 {
            app.boxGroups.handle(try macBridge.event("kuvo.group.message", ["id": id, "message": said(number)]), machine: nil)
            try await until { labels.contains { $0.contains("Message \(number).") } || app.chats.messages(in: id).count == number }
            #expect(isOpen)
        }
        window.contentView?.layoutSubtreeIfNeeded()
        #expect(abs(clip.bounds.minY - before) < 1, "moved from \(before) to \(clip.bounds.minY)")
        // Far from it, more comes in, and back.
        for number in 35...90 {
            app.boxGroups.handle(try macBridge.event("kuvo.group.message", ["id": id, "message": said(number)]), machine: nil)
        }
        var y = before
        while y > 0 {
            y = max(0, y - 300)
            go(to: y)
        }
        try await until { !labels.contains("Ran 3 commands") }
        go(to: before)
        try await until { labels.contains("Ran 3 commands") }
        #expect(isOpen)
    }

    /// A group chat's composer is the session's: a quote pushes its last message up over it, and
    /// scrolled up, what you read by as much.
    @Test func aQuoteInAChatPushesItsConversationUp() async throws {
        TestEnvironment.prepare()
        defer { Self.clean(); mac.stop(); AXElement.reading(false) }
        try saveBots([("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        let id = "grp_mac0000003"
        here.add(Self.group(id, members: ["bot_ada", "bot_ben"]), messages: (1...30).map {
            ["id": "gm_\($0)", "author": "bot_ada", "text": "Message \($0). " + String(repeating: "Some words of it. ", count: 30), "time": "2026-10-22T08:00:00Z", "kind": "message"]
        })
        let app = app()
        await app.boxGroups.connected(nil)
        let group = try #require(app.chats.group(id))
        defer { Drafts.shared.remove(BotGroups.tabKey(id)) }

        AXElement.reading(true)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 560), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AnyView(GroupChatView(group: group)
            .environment(app)
            .environment(app.catalog)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .frame(width: 760, height: 560)))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.close(); window.contentView = nil }
        func stacks(_ view: NSView?) -> [RowStackView] {
            guard let view else { return [] }
            return (view as? RowStackView).map { [$0] } ?? view.subviews.flatMap(stacks)
        }
        var stack: RowStackView? {
            window.contentView?.layoutSubtreeIfNeeded()
            DispatchQueue.main.async { TestPulse.beat() }
            return stacks(window.contentView).first
        }
        try await until { stack?.shownFrames().window.isEmpty == false && stack?.enclosingScrollView?.contentInsets.bottom ?? 0 > 0 }
        let scroll = try #require(stack?.enclosingScrollView)
        var room: CGFloat {
            window.contentLayoutRect.height - scroll.contentInsets.bottom - (stack?.shownFrames().window.values.map(\.maxY).max() ?? 0)
        }
        // Settled at its end, its heights all measured.
        try await until { abs(room - ConversationEndFade.height) < 20 }
        let before = room
        let over = scroll.contentInsets.bottom
        _ = Drafts.shared.addQuote(String(repeating: "Some words of it. ", count: 20), to: BotGroups.tabKey(id))
        try await until { _ = stack; return scroll.contentInsets.bottom > over + 40 && abs(room - before) < 2 }

        // Scrolled up, what's added next pushes what you read by as much.
        let clip = scroll.contentView
        clip.scroll(to: NSPoint(x: 0, y: clip.bounds.minY - 900))
        scroll.reflectScrolledClipView(clip)
        stack?.scrollAnchor?.stopFollowing()
        try await until { stack?.scrollAnchor?.isFollowingEnd == false }
        let place = clip.bounds.minY
        let taller = scroll.contentInsets.bottom
        _ = Drafts.shared.addQuote("Another: " + String(repeating: "Some words of it. ", count: 20), to: BotGroups.tabKey(id))
        try await until { _ = stack; return scroll.contentInsets.bottom > taller + 40 }
        try await until { _ = stack; return abs(clip.bounds.minY - place - (scroll.contentInsets.bottom - taller)) < 1.5 }
    }

    /// New Group Chat from a machine's page: the chat is made by that machine's box and lives
    /// there, on its page, not on this Mac's; with the machine away, nothing's made and it says so.
    @Test func aGroupChatStartedOnAMachineLivesThere() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let app = app()
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")
        machineBridge.on("POST", "/api/kuvo/link/groups") { [there] request in
            there.add(Self.group("grp_box0000002", members: request.body["members"] as? [String] ?? []))
            return StubWeb.json(["group": ["id": "grp_box0000002"]])
        }

        let made = try await app.chats.create(name: "Crew", purpose: nil, members: ["bot_pal", "bot_lb"], meeting: nil, on: "box")

        #expect(made.id == "grp_box0000002")
        #expect(there.has("grp_box0000002") && !here.has("grp_box0000002"), "made by the machine's box")
        #expect(app.chats.machine(of: "grp_box0000002") == "box", "on the machine's page")
        await #expect(throws: BoxGroups.Failure.self) {
            try await app.chats.create(name: "Crew", purpose: nil, members: ["bot_pal", "bot_lb"], meeting: nil, on: "elsewhere")
        }
    }

    /// A machine running a newer Kuvo Code says a kind of message this copy doesn't know: its chats
    /// still show, with that message left out rather than shown as something else.
    @Test func aMessageOfANewerKindLeavesTheChatsShowing() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box")])
        let newer: [String: Any] = ["id": "gm_2", "author": "bot_pal", "text": "{\"chart\": 1}", "time": "2026-10-22T08:01:00Z", "kind": "chart"]
        there.add(Self.group("grp_box0000001", members: ["bot_pal"]), messages: [Self.said, newer])
        let app = app()

        await app.boxGroups.connected("box")

        #expect(app.chats.list.map(\.id) == ["grp_box0000001"])
        #expect(app.chats.messages(in: "grp_box0000001").map(\.text) == ["Morning."])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.message", ["id": "grp_box0000001", "message":
            ["id": "gm_3", "author": "bot_pal", "text": "{}", "time": "2026-10-22T08:02:00Z", "kind": "chart"]]), machine: "box")
        app.boxGroups.handle(try machineBridge.event("kuvo.group.message", ["id": "grp_box0000001", "message":
            ["id": "gm_4", "author": "bot_pal", "text": "Done.", "time": "2026-10-22T08:03:00Z", "kind": "message"]]), machine: "box")
        #expect(app.chats.messages(in: "grp_box0000001").map(\.text) == ["Morning.", "Done."])
    }

    /// A message of a kind a newer Kuvo Code says is kept as it said it, so this copy, once
    /// updated, shows it from what it kept (it reads a chat again only once a newer message comes).
    @Test func aMessageOfANewerKindIsKeptAsItCame() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box")])
        let newer: [String: Any] = ["id": "gm_2", "author": "bot_pal", "text": "{\"chart\": 1}", "time": "2026-10-22T08:01:00Z", "kind": "chart"]
        there.add(Self.group("grp_box0000001", members: ["bot_pal"]), messages: [Self.said, newer])
        let app = app()

        await app.boxGroups.connected("box")
        app.boxGroups.flush()

        let kept = try JSONSerialization.jsonObject(with: Data(contentsOf: BoxGroups.folder.appending(path: "grp_box0000001.json"))) as? [[String: Any]]
        #expect(kept?.compactMap { $0["kind"] as? String } == ["message", "chart"])
    }

    /// A meeting whose last word is of a kind a newer Kuvo Code says: its notification says the
    /// meeting came, not that message's raw text.
    @Test func aMeetingEndingInANewerKindSaysItCame() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let last = try decoder.decode(GroupMessage.self, from: JSONSerialization.data(withJSONObject:
            ["id": "gm_9", "author": "bot_pal", "text": "{\"chart\": 1}", "time": "2026-10-22T08:01:00Z", "kind": "chart"]))
        let said = try decoder.decode(GroupMessage.self, from: JSONSerialization.data(withJSONObject:
            ["id": "gm_8", "author": "bot_pal", "text": "All green.", "time": "2026-10-22T08:00:00Z", "kind": "wrapUp"]))
        #expect(BoxGroups.metLine(last) == "The meeting came.")
        #expect(BoxGroups.metLine(said) == "All green.")
    }

    /// A chat read again (its computer back, an edit) while its computer says something of it: what
    /// it said, after the read began, stays. Its talk ended stays ended; gone stays gone.
    @Test func whatAChatSaysWhileItsReadAgainStays() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box")])
        let group = Self.group("grp_box0000001", members: ["bot_pal"])
        there.add(group, messages: [Self.said])
        let app = app()
        await app.boxGroups.connected("box")
        // Read from while it talked.
        let talking = StubWeb.json(["data": ["group": group, "status": "active", "state": ["speaking": "bot_pal", "discussing": true, "paused": false], "messages": [Self.said]]])
        func readHeld(while said: () throws -> Void) async throws {
            let reading = Gate(), release = Gate()
            machineBridge.on("GET", "/api/kuvo/groups/grp_box0000001") { _ in
                reading.open()
                release.wait()
                return talking
            }
            let read = Task { await app.boxGroups.reload("grp_box0000001") }
            try await until { reading.isOpen }
            try said()
            release.open()
            await read.value
        }

        try await readHeld {
            app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                     "state": ["discussing": false, "paused": false]]), machine: "box")
        }
        #expect(app.chats.speaking["grp_box0000001"] == nil)
        #expect(!app.chats.discussing.contains("grp_box0000001"))

        try await readHeld {
            app.boxGroups.handle(try machineBridge.event("kuvo.group.deleted", ["id": "grp_box0000001"]), machine: "box")
        }
        #expect(app.chats.list.isEmpty)
    }

    /// A wrap-up's part in a state a newer Kuvo Code says: that computer's chats still show, with
    /// the wrap-up in them.
    @Test func aPartInANewerStateLeavesTheChatsShowing() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box")])
        let wrapUp: [String: Any] = ["id": "gm_2", "author": "bot_pal", "text": "Here's the plan.", "time": "2026-10-22T08:01:00Z", "kind": "wrapUp",
                                     "tasks": [["id": "task_1", "bot": "bot_pal", "task": "Fix the build", "state": "canceled"]]]
        there.add(Self.group("grp_box0000001", members: ["bot_pal"]), messages: [Self.said, wrapUp])
        let app = app()

        await app.boxGroups.connected("box")

        #expect(app.chats.list.map(\.id) == ["grp_box0000001"])
        #expect(app.chats.messages(in: "grp_box0000001").map(\.text) == ["Morning.", "Here's the plan."])
        // Not under way: no spinner forever, and Move to Computer isn't held back by it.
        let states = app.chats.messages(in: "grp_box0000001").flatMap { $0.tasks ?? [] }.map(\.state)
        #expect(states.count == 1 && !states.contains(.working) && !states.contains(.waiting))
        // Kept as it came, so a newer Kuvo Code reading the cache sees it.
        app.boxGroups.flush()
        let kept = try JSONSerialization.jsonObject(with: Data(contentsOf: BoxGroups.folder.appending(path: "grp_box0000001.json"))) as? [[String: Any]]
        #expect(kept?.compactMap { ($0["tasks"] as? [[String: Any]])?.first?["state"] as? String } == ["canceled"])
    }

    /// A part whose bot's conversation you stopped: the chat shows it waits on that conversation, as
    /// its computer says, until it goes on (or the computer is away, when nothing's known of it).
    @Test func aPartWaitingOnAStoppedConversationShowsUntilItGoesOn() async throws {
        defer { Self.clean(); mac.stop() }
        let app = app()
        let group = Self.group("grp_box0000001", members: ["bot_pal"])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false, "stopped": ["bot_pal"]]]), machine: "box")
        #expect(app.chats.stopped(in: "grp_box0000001") == ["bot_pal"])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false]]), machine: "box")
        #expect(app.chats.stopped(in: "grp_box0000001").isEmpty)
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false, "stopped": ["bot_pal"]]]), machine: "box")
        app.boxGroups.disconnected("box")
        #expect(app.chats.stopped(in: "grp_box0000001").isEmpty)
    }

    /// A chat moving: the copy held where it goes says nothing of what its parts wait on, so the
    /// chat still says a part waits on its stopped conversation.
    @Test func aCopyHeldWhileTheChatMovesLeavesWhatItsPartsWaitOn() async throws {
        defer { Self.clean(); mac.stop() }
        let app = app()
        let group = Self.group("grp_box0000001", members: ["bot_pal"])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false, "stopped": ["bot_pal"]]]), machine: "box")
        app.boxGroups.handle(try macBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "held",
                                                                             "state": ["discussing": false, "paused": false]]), machine: nil)
        #expect(app.chats.stopped(in: "grp_box0000001") == ["bot_pal"])
    }

    /// A chat that went on on this Mac's box while the window was closed: opened again, it shows as
    /// the box has it now (a part given again, waiting on its stopped conversation), not as last seen.
    @Test func aChatThatWentOnWhileClosedShowsAsItsBoxHasItNow() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        let group = Self.group("grp_mac0000001", members: ["bot_ada", "bot_ben"], seats: ["bot_ada": "ses_seatA", "bot_ben": "ses_seatB"])
        let asked: [String: Any] = ["id": "gm_1", "kind": "message", "text": "Are we ready to ship Friday?", "time": "2026-10-31T12:49:29Z"]
        let wrapUp = { (state: String) -> [String: Any] in
            ["id": "gm_2", "kind": "wrapUp", "author": "bot_ada", "time": "2026-10-31T12:50:09Z", "text": "We ship Friday.\n\n- **&Ben**: make `timer.test.ts` steady",
             "tasks": [["id": "gt_b", "bot": "bot_ben", "task": "Make `timer.test.ts` steady.", "state": state, "prompt": "msg_seedb", "started": "2026-10-31T12:50:59Z"]]]
        }
        let note: [String: Any] = ["id": "gm_3", "kind": "note", "text": "Ben couldn’t do its part: its message was taken back before Ben read it.", "time": "2026-10-31T12:54:29Z"]
        here.add(group, messages: [asked, wrapUp("failed"), note])
        let before = app()
        await before.boxGroups.connected(nil)
        #expect(before.chats.messages(in: "grp_mac0000001").map(\.id) == ["gm_1", "gm_2", "gm_3"])
        before.boxGroups.flush()

        // Meanwhile, on the box: the chat as it is now.
        here.add(group, messages: [asked, wrapUp("working")])
        let app = app()
        #expect(app.chats.messages(in: "grp_mac0000001").map(\.id) == ["gm_1", "gm_2", "gm_3"], "as last seen, until the box says")
        await app.boxGroups.connected(nil)
        #expect(app.chats.messages(in: "grp_mac0000001").map(\.id) == ["gm_1", "gm_2"])
        #expect(app.chats.messages(in: "grp_mac0000001").last?.tasks?.first?.state == .working)
    }

    /// One machine added twice, at two addresses, found to be one: its chats are kept once, as
    /// the address it's kept under says, not twice with one copy talking on.
    @Test func aMachineAtTwoAddressesKeepsItsChatsOnce() throws {
        defer { Self.clean(); mac.stop() }
        let app = app()
        let group = Self.group("grp_box0000001", members: ["bot_pal"])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["speaking": "bot_pal", "discussing": true, "paused": false]]), machine: "box-old")
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false]]), machine: "box")
        app.boxGroups.fold("box-old", into: "box")
        #expect(app.boxGroups.chats.filter { $0.group.id == "grp_box0000001" }.map(\.machine) == ["box"])
        #expect(!app.boxGroups.isTalking(on: "box"))
    }

    /// A chat read where it's going while the computer it's leaving lets it go (a move): the read
    /// there isn't taken for that computer's, and the chat shows where it went.
    @Test func aChatReadWhereItGoesWhileItLeavesShowsThere() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box")])
        let group = Self.group("grp_box0000001", members: ["bot_pal"])
        let app = app()
        await app.boxGroups.connected("box")
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false]]), machine: nil)
        let reading = Gate(), release = Gate()
        let answer = StubWeb.json(["data": ["group": group, "status": "active", "state": ["discussing": false, "paused": false], "messages": [Self.said]]])
        machineBridge.on("GET", "/api/kuvo/groups/grp_box0000001") { _ in
            reading.open()
            release.wait()
            return answer
        }
        let read = Task { await app.boxGroups.reload("grp_box0000001", on: "box") }
        try await until { reading.isOpen }
        app.boxGroups.handle(try machineBridge.event("kuvo.group.deleted", ["id": "grp_box0000001"]), machine: nil)
        release.open()
        await read.value

        #expect(app.boxGroups.machine(of: "grp_box0000001") == "box")
        #expect(app.chats.messages(in: "grp_box0000001").map(\.text) == ["Morning."])
    }

    /// One machine at two addresses, the name kept with a chat talking when last seen, not
    /// connected now: nothing shows talking there, so its settings aren't held back for it.
    @Test func aMachineAtTwoAddressesKeptAwayShowsNothingTalking() throws {
        defer { Self.clean(); mac.stop() }
        let app = app()
        let group = Self.group("grp_box0000001", members: ["bot_pal"])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false]]), machine: "box-old")
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["speaking": "bot_pal", "discussing": true, "paused": false]]), machine: "box")
        app.boxGroups.fold("box-old", into: "box")
        #expect(!app.boxGroups.isTalking(on: "box"))
        #expect(app.chats.speaking["grp_box0000001"] == nil)
    }

    /// The same, while the name kept is being read: a chat whose messages are here already, said to
    /// be talking meanwhile, still shows talking once the read is done, rather than cleared as if
    /// the machine were away (nothing else reads it again).
    @Test func aMachineAtTwoAddressesBeingReadKeepsWhatItSaidMeanwhile() async throws {
        defer { Self.clean(); mac.stop() }
        let app = app()
        let old = Self.group("grp_box0000001", members: ["bot_pal"]), talking = Self.group("grp_box0000002", members: ["bot_pal"])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": old, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false]]), machine: "box-old")
        there.add(talking, messages: [Self.said])
        await app.boxGroups.reload("grp_box0000002", on: "box")
        #expect(app.chats.messages(in: "grp_box0000002").map(\.text) == ["Morning."])
        let reading = Gate(), release = Gate()
        machineBridge.on("GET", "/api/kuvo/groups") { request in
            reading.open()
            release.wait()
            return there.answer(request)
        }
        let read = Task { await app.boxGroups.connected("box") }
        try await until { reading.isOpen }
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000002", "group": talking, "status": "active",
                                                                                 "state": ["speaking": "bot_pal", "discussing": true, "paused": false]]), machine: "box")
        app.boxGroups.fold("box-old", into: "box")
        release.open()
        await read.value

        #expect(app.boxGroups.isTalking(on: "box"))
        #expect(app.chats.speaking["grp_box0000002"] == "bot_pal")
    }

    /// This Mac's bridge starting, then stopped: its chats show as last seen, and what you write
    /// waits in the composer; once it's up, it goes.
    @Test func thisMacsChatsWaitForItsBridge() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        here.add(Self.group("grp_mac0000001", members: ["bot_ada", "bot_ben"]), messages: [Self.said])
        let app = app()
        let up = app.boxGroups.bridge
        await app.boxGroups.connected(nil)
        app.boxGroups.bridge = { $0 == nil ? nil : up?($0) }
        var failure: String?
        app.boxGroups.stoppedBecause = { failure }

        #expect(app.chats.reach("grp_mac0000001") == .starting)
        #expect(app.chats.messages(in: "grp_mac0000001").map(\.text) == ["Morning."], "as last seen")
        #expect(!app.chats.send("Anyone?", to: "grp_mac0000001"), "it waits in the composer")
        failure = "It stopped unexpectedly (exit code 1)."
        #expect(app.chats.reach("grp_mac0000001") == .stopped("It stopped unexpectedly (exit code 1)."))
        #expect(!app.chats.send("Anyone?", to: "grp_mac0000001"))
        #expect(!here.actions.contains("POST grp_mac0000001/send"))

        app.boxGroups.bridge = up
        #expect(app.chats.reach("grp_mac0000001") == .ready)
        #expect(app.chats.send("Anyone?", to: "grp_mac0000001"))
        try await until { here.actions.contains("POST grp_mac0000001/send") }
    }

    /// What you write in a chat goes after what you wrote there before, in order; a chat whose
    /// computer is slow to take it doesn't hold up another chat's.
    @Test func aSlowChatDoesntHoldUpAnothersAndEachGoesInOrder() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box"), ("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        here.add(Self.group("grp_mac0000001", members: ["bot_ada", "bot_ben"]))
        there.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"]))
        let app = app()
        // The machine's bridge at a real address, slow to take what's sent to its chat until the
        // test lets it (holding only that address's answers).
        let slow = Gate()
        let listener = try await machineBridge.listen()
        StubWeb.letThrough(port: Int(listener.port))
        defer { slow.open(); listener.stop() }
        machineBridge.on("POST", "/api/kuvo/groups/grp_box0000001/send") { [there] request in
            slow.wait()
            return there.answer(request)
        }
        let macAPI = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: macBridge.url)!, password: "test"))
        let machineAPI = OpenCodeAPI(endpoint: listener.endpoint, folderPrefix: RemoteFolder.prefix(for: "box"))
        app.boxGroups.bridge = { $0 == nil ? macAPI : $0 == "box" ? machineAPI : nil }
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")

        #expect(app.chats.send("First", to: "grp_box0000001"))
        #expect(app.chats.send("Second", to: "grp_box0000001"))
        #expect(app.chats.send("Meanwhile", to: "grp_mac0000001"))
        try await until { here.messages("grp_mac0000001").map { $0["text"] as? String } == ["Meanwhile"] }
        #expect(there.messages("grp_box0000001").isEmpty, "still on its way")
        slow.open()
        try await until { there.messages("grp_box0000001").count == 2 }
        #expect(there.messages("grp_box0000001").map { $0["text"] as? String } == ["First", "Second"])
    }

    /// Stop, Keep Going and Start the Work on a chat that's moving say why nothing happened, as
    /// sending to it does, rather than nothing at all.
    @Test func whatYouDoToAChatThatsMovingSaysWhy() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        there.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"]), status: "held")
        let app = app()
        await app.boxGroups.connected("box")

        for action in [{ try await app.boxGroups.stop("grp_box0000001") },
                       { try await app.boxGroups.keepGoing("grp_box0000001") },
                       { try await app.boxGroups.startWork("gm_wrap", in: "grp_box0000001") }] as [() async throws -> Void] {
            do {
                try await action()
                Issue.record("it said nothing")
            } catch {
                #expect(error.localizedDescription == Moves.Failure.moving.localizedDescription)
            }
        }
    }

    /// What this Mac's bridge lets go of goes to the Finder's Trash; nothing outside its own
    /// trash folder is touched, whatever an event says.
    @Test func whatThisMacsBridgeLetsGoOfGoesToTheTrash() async throws {
        defer { Self.clean(); mac.stop(); try? FileManager.default.removeItem(at: BoxGroups.macTrash) }
        let app = app()
        let folder = BoxGroups.macTrash.appending(path: "20261024T100000-group-grp_gone000001")
        try FileManager.default.createDirectory(at: folder.appending(path: "grp_gone000001"), withIntermediateDirectories: true)
        let elsewhere = AppInfo.testRoot.appending(path: "Keep-\(UUID().uuidString.prefix(6))")
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: elsewhere) }

        app.boxGroups.handle(try macBridge.event("kuvo.group.trashed", ["id": "grp_gone000001", "path": folder.path]), machine: nil)
        app.boxGroups.handle(try macBridge.event("kuvo.group.trashed", ["id": "grp_x", "path": elsewhere.path]), machine: nil)
        app.boxGroups.handle(try machineBridge.event("kuvo.group.trashed", ["id": "grp_y", "path": folder.path]), machine: "box")

        #expect(!FileManager.default.fileExists(atPath: folder.path))
        #expect(FileManager.default.fileExists(atPath: elsewhere.path), "not one outside its trash")
        #expect(FileManager.default.fileExists(atPath: AppInfo.testTrash.path))
    }

    /// Looked at here: told there once, not again each time the machine says it back (in whole
    /// seconds, as it keeps times).
    @Test func aLookIsToldOnce() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        there.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.boxGroups.connected("box")
        let told = { there.actions.filter { $0 == "PATCH grp_box0000001" }.count }
        app.chats.markViewed("grp_box0000001")
        try await until { told() > 0 }
        let seen = try #require(app.chats.group("grp_box0000001")?.viewed)
        var group = Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"])
        group["viewed"] = ISO8601DateFormatter().string(from: seen)
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false]]), machine: "box")
        // A message after it, and back: the look isn't told again.
        await app.boxGroups.reload("grp_box0000001")
        #expect(told() == 1, "not told again")
        #expect(app.chats.group("grp_box0000001")?.viewed == seen)
    }

    /// Read on the phone, with this Mac looking on: the machine says so, and it's read here too,
    /// its notification gone.
    @Test func aChatReadElsewhereIsReadHere() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        there.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.boxGroups.connected("box")
        #expect(app.chats.isUnread(app.chats.group("grp_box0000001")!))
        let shown = ShownNotifications(threads: [BotGroups.tabKey("grp_box0000001"), "ses_other"])
        defer { shown.done() }
        var group = Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"])
        group["viewed"] = "2026-10-22T08:05:00Z"
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false]]), machine: "box")
        #expect(!app.chats.isUnread(app.chats.group("grp_box0000001")!))
        try await until { shown.threads == ["ses_other"] }
        #expect(shown.threads == ["ses_other"], "its notification gone from Notification Center, the other's kept")
    }

    /// A move taken back that couldn't let go of its copy there: the one started here is the chat
    /// (listed once, read and written here), and the copy goes once the machine's there again.
    @Test func aCopyLeftOnAMachineIsntTheChatAndGoes() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let id = "grp_k000000004"
        here.add(Self.group(id, members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        there.add(Self.group(id, members: ["bot_pal", "bot_lb"]), status: "held")
        let app = app()
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")
        #expect(app.chats.list.filter { $0.id == id }.count == 1)
        #expect(app.chats.machine(of: id) == nil && app.chats.messages(in: id).map(\.text) == ["Morning."])
        #expect(there.actions.contains("POST \(id)/release") && !there.has(id))
    }

    @Test func aRemovedMachinesChatsGoFromHere() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        there.add(Self.group("grp_box0000003", members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.boxGroups.connected("box")
        #expect(app.chats.group("grp_box0000003") != nil)
        app.boxGroups.forget(machine: "box")
        #expect(app.chats.group("grp_box0000003") == nil)
        app.boxGroups.flush()
        #expect(BoxGroups().chats.isEmpty, "nor kept for later")
    }

    @Test func aDeletedBotLeavesItsChatsWhereverTheyLive() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box"), ("bot_x", "X", "box")])
        there.add(Self.group("grp_box0000002", members: ["bot_pal", "bot_lb", "bot_x"]))
        here.add(Self.group("grp_mac0000002", members: ["bot_pal", "bot_lb", "bot_x"]))
        let app = app()
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")
        await app.boxGroups.remove(try #require(app.bots.bot("bot_x")))
        #expect(app.chats.group("grp_box0000002")?.members == ["bot_pal", "bot_lb"])
        #expect(app.chats.group("grp_mac0000002")?.members == ["bot_pal", "bot_lb"])
    }
}
