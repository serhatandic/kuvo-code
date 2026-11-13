import AppKit
import ClientDesign
import ClientSessions
import KuvoLink
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// What's over a bot's composer never takes its conversation away: a goal under way with a long
/// plan and four things waiting for you, and its bot asking a question in the composer's place,
/// in a short window. The question's Skip and Answer stay in the window, and the conversation
/// keeps room to read and scroll. What its bot asks shows once: as the question, not again as
/// a row of what's waiting. The bot's conversation, the card over its composer and its goal bar
/// are the real ones, in a window of the test's own; its box is a stand-in answering as a box does.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ComposerStackRoomTests {
    let engine = StubEngine(port: 48_013)
    let app = AppModel()
    let catalog = Catalog()
    let model: SessionModel
    static let size = NSSize(width: 720, height: 620)
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)

    nonisolated static let question = "Step 1 is done: the concept is LeafCheck, a plant care app. Go with LeafCheck, or change it?"

    /// What the bot's box says: Pixel, and its goal under way, waiting for you on four things,
    /// the last its own question.
    nonisolated private static func answer(_ path: String) -> Data {
        let now = Date.now.timeIntervalSince1970 * 1000
        let body: Any
        switch path {
        case "kuvo/bots":
            body = ["bots": [["id": "bot_pixel00001", "session": "ses_pixel", "name": "Pixel", "look": ["color": "sky", "shape": "round", "face": "calm"], "created": "2026-10-01T09:00:00Z"]]]
        case _ where path.hasPrefix("kuvo/work?bot="):
            body = ["bot": "bot_pixel00001", "answered": [Any](), "today": ["started": 0, "working": 0, "tokens": 0], "sessions": [Any]()]
        case "kuvo/work/goals":
            let steps = ["Concept", "Design", "Build the app", "Paywall", "Test on devices", "App Store submission", "Launch and ASO"].enumerated().map { at, text in
                ["id": "s\(at + 1)", "text": text, "state": at == 0 ? "done" : at == 1 ? "doing" : "todo",
                 "began": at < 2 ? now - Double(3 - at) * 3_600_000 : nil, "ended": at == 0 ? now - 3_600_000 : nil].compactMapValues { $0 }
            }
            let waiting: [[String: Any]] = [
                ["id": "w1", "kind": "you", "text": "Apple Developer Program membership", "detail": "99 USD a year", "url": "https://developer.apple.com/programs/enroll/", "site": "developer.apple.com", "at": now - 3_000_000],
                ["id": "w2", "kind": "you", "text": "RevenueCat account and public SDK key", "url": "https://app.revenuecat.com", "site": "revenuecat.com", "at": now - 2_900_000],
                ["id": "w3", "kind": "judgment", "text": "Approve the concept before building", "at": now - 600_000],
                ["id": "w4", "kind": "ask", "text": "Pixel: Asks: \(question)", "session": "ses_pixel", "at": now - 500_000],
            ]
            body = ["goals": [["id": "goal_1", "bot": "bot_pixel00001", "name": "Pixel", "session": "ses_pixel", "title": "Plant care app",
                               "goal": "Make a profitable iOS app and launch it on the App Store.", "state": "running", "steps": steps,
                               "checks": [Any](), "spend": [Any](), "public": [Any](), "projects": [String](), "wake": false, "digest": "day",
                               "proposed": now - 4_000_000, "started": now - 3_600_000 * 3, "waiting": waiting, "paused": [Any](), "waited": 0,
                               "watching": [String](), "alone": true]]]
        default:
            body = [String: Any]()
        }
        return (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
    }

    init() async throws {
        TestEnvironment.prepare()
        try? FileManager.default.removeItem(at: Bots.file)
        let box = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            let path = request.path.hasPrefix("/") ? String(request.path.dropFirst()) : request.path
            let body = Self.answer(path)
            return AsyncThrowingStream { continuation in
                // A follow's stream ends at once: what it would tell, the reads here say.
                if !path.hasSuffix("/events") {
                    continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                }
                continuation.finish()
            }
        })
        app.bots.app = app
        app.botWork.app = app
        app.goalPlans.app = app
        app.bots.boxes = { _ in box }
        app.botWork.boxes = { _ in box }
        app.goalPlans.boxes = { _ in box }
        app.workspace.api = engine.api
        engine.list([StubEngine.session("ses_pixel", title: "Pixel", directory: "/tmp/kuvo-tests-stack-room", created: 1)])
        engine.conversation("ses_pixel", Self.conversation)
        await app.workspace.refresh()
        model = try #require(app.workspace.model(for: "ses_pixel"))
        await app.bots.refresh(BoxClient.mac)
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        await app.botWork.read(pixel)
        await app.goalPlans.read(BoxClient.mac)
        app.workspace.handle(try engine.event("form.created", session: "ses_pixel", ["form": [
            "id": "frm_concept", "sessionID": "ses_pixel", "title": "Concept approval", "metadata": ["kind": "question"],
            "fields": [["key": "q0", "title": "Concept approval", "description": Self.question, "type": "string",
                        "options": [["value": "LeafCheck", "label": "Go with LeafCheck", "description": "A plant care app: scan a leaf, get a care plan"],
                                    ["value": "Rename", "label": "Keep the idea, change the name", "description": "Same app under a name you pick"],
                                    ["value": "Other", "label": "Another concept", "description": "Tell me what to build instead"]], "custom": true]],
        ] as [String: Any]]))
        // Last, once nothing here can throw: `done()` switches it off again.
        AXElement.reading(true)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: root(Self.size))
        window.orderBack(nil)
    }

    /// What the bot said before it asked: the goal set, and its first step done.
    nonisolated private static var conversation: [[String: Any]] {
        let reply = { (id: String, text: String) -> [String: Any] in
            ["id": id, "type": "assistant", "agent": "build", "time": ["created": 3, "completed": 4], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": text]]]
        }
        return [["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Make a profitable iOS app and launch it on the App Store."],
                reply("msg_02", "On it. I've planned it in seven steps, from the concept to launch, and started on the concept."),
                reply("msg_03", "The concept is done: **LeafCheck**, a plant care app. You scan a leaf and get a care plan with reminders, with a paywall for more than three plants. Before I design it, I'd like your go-ahead.")]
    }

    /// The bot's conversation, as the window shows it at `size`.
    private func root(_ size: NSSize) -> AnyView {
        AnyView(SessionView(model: model)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: size.width, height: size.height))
    }

    /// The window at `size`, laid out again.
    private func show(_ size: NSSize) {
        window.setContentSize(size)
        (window.contentView as? NSHostingView<AnyView>)?.rootView = root(size)
    }

    private func done() {
        engine.stop()
        window.orderOut(nil)
        window.close()
        // The conversation's own tasks (it follows the vault's asks) end with its views, not with the process.
        window.contentView = nil
        Drafts.shared.remove("ses_pixel")
        try? FileManager.default.removeItem(at: Bots.file)
        AXElement.reading(false)
    }

    /// What VoiceOver finds in the window, as it lays out now. (Read while the window lays out,
    /// which `until` can't see: each look lays it out first, and says so on the main queue's next
    /// turn, once the wait is watching, for it to look again after SwiftUI's update.)
    private var elements: [AXElement] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView)
    }

    /// The window's content, on the screen, as VoiceOver's frames are.
    private var content: NSRect {
        window.convertToScreen(window.contentView?.frame ?? .zero)
    }

    @Test func aLongGoalAndAQuestionLeaveTheConversationRoomAndTheQuestionsButtonsInTheWindow() async throws {
        defer { done() }
        try await until { elements.contains { $0.label == "Answer" } && elements.contains { $0.label?.hasPrefix("Plant care app") == true } }
        let answer = try #require(elements.first { $0.label == "Answer" })
        let skip = try #require(elements.first { $0.label == "Skip" })
        for button in [answer, skip] {
            #expect(content.contains(button.frame), "\(button.label ?? "") at \(button.frame), in a window at \(content)")
        }
        // The goal's line, the top of what's over the conversation: the conversation keeps room
        // over it, to read and scroll. (VoiceOver's frames are on the screen, y going up.)
        let line = try #require(elements.first { $0.label?.hasPrefix("Plant care app") == true })
        #expect(content.contains(line.frame), "the goal's line, with its Stop, is in sight: at \(line.frame), in a window at \(content)")
        #expect(content.maxY - line.frame.maxY >= 120, "the conversation keeps room over the card: the goal's line at \(line.frame), in a window at \(content)")
    }

    /// A message waiting for the agent stays in sight under a goal too long for the card, where
    /// it goes next, rather than scrolled away under the goal's rows.
    @Test func aMessageWaitingForTheAgentStaysInSightUnderALongGoal() async throws {
        defer { done() }
        // Once its conversation is read, which would take the place of what waits.
        try await until { elements.contains { $0.label == "Answer" } && !model.transcript.messages.isEmpty }
        // Queued on the engine, as the conversation reads it.
        let item: [String: Any] = ["id": "msg_queued01", "sessionID": "ses_pixel", "type": "user", "delivery": "queue", "payload": ["text": "Then make the app icon"]]
        engine.on("GET", "/api/session/ses_pixel/inbox") { _ in StubWeb.json(["data": [item]]) }
        await model.load()
        // (Its row is found by its own Remove, the one in the card.)
        try await until { elements.contains { $0.label == "Remove" } }
        let queued = try #require(elements.first { $0.label == "Remove" })
        let answer = try #require(elements.first { $0.label == "Answer" })
        #expect(content.contains(queued.frame), "the waiting message at \(queued.frame), in a window at \(content)")
        #expect(queued.frame.minY > answer.frame.maxY, "over the question, as the card has it")
    }

    /// While its bot asks, the goal folds to its line, which keeps how far along it is and Stop and
    /// says how many things wait for you, so the question has the room. Opened by you, it stays
    /// open over the question; answered, it's open again as it was.
    @Test func aGoalFoldsToItsLineWhileItsBotAsksAndAnsweringOpensItAgain() async throws {
        defer { done() }
        // Tall enough for every row, whatever the card's room.
        show(NSSize(width: 820, height: 1_400))
        try await until { elements.contains { $0.label == "Answer" } && elements.contains { $0.label?.hasPrefix("Plant care app") == true } }
        var line = try #require(elements.first { $0.label?.hasPrefix("Plant care app") == true })
        #expect(line.label?.contains("3 wait for you") == true, "the line says what waits for you: \(line.label ?? "")")
        #expect(elements.contains { $0.label == "Stop…" }, "the line keeps its Stop")
        #expect(!elements.contains { $0.label == "Open RevenueCat" }, "its rows fold away while the question waits")

        // Opened by you: it stays open over the question.
        #expect(line.press())
        try await until { elements.contains { $0.label == "Open RevenueCat" } }
        line = try #require(elements.first { $0.label?.hasPrefix("Plant care app") == true })
        #expect(line.press())
        try await until { !elements.contains { $0.label == "Open RevenueCat" } }

        // Answered, by you or elsewhere: the goal shows again, as you left it before.
        app.workspace.handle(try engine.event("form.replied", session: "ses_pixel", ["id": "frm_concept", "sessionID": "ses_pixel"]))
        try await until { !elements.contains { $0.label == "Answer" } }
        #expect(!elements.contains { $0.label == "Open RevenueCat" }, "folded by you while it asked, it stays folded")
    }

    /// Never folded by you, the goal opens again once the question is answered.
    @Test func answeringOpensTheGoalTheQuestionFolded() async throws {
        defer { done() }
        show(NSSize(width: 820, height: 1_400))
        try await until { elements.contains { $0.label == "Answer" } && elements.contains { $0.label?.hasPrefix("Plant care app") == true } }
        #expect(!elements.contains { $0.label == "Open RevenueCat" })
        app.workspace.handle(try engine.event("form.replied", session: "ses_pixel", ["id": "frm_concept", "sessionID": "ses_pixel"]))
        try await until { elements.contains { $0.label == "Open RevenueCat" } }
    }

    @Test func whatTheBotAsksShowsOnceAsTheQuestionNotAgainAsARowOfWhatsWaiting() async throws {
        defer { done() }
        // Tall enough for every row, whatever the card's room.
        show(NSSize(width: 820, height: 1_400))
        try await until { elements.contains { $0.label == "Answer" } && elements.contains { $0.label?.hasPrefix("Plant care app") == true } }
        // The goal opened over the question, to see its rows.
        #expect(try #require(elements.first { $0.label?.hasPrefix("Plant care app") == true }).press())
        try await until { elements.contains { $0.label == "Open RevenueCat" } }
        // Each row of what's waiting puts away with its own button; the question's row would
        // have been the one that opens its conversation.
        let labels = elements.compactMap(\.label)
        #expect(labels.filter { $0 == "Put Away" }.count == 3, "the other three wait as rows: \(labels)")
        #expect(!labels.contains("Open"), "its own question isn't a row too, opening the conversation it's in: \(labels)")
    }

    /// The window as it shows, in each size and look, into KUVO_DRAFTS_OUT (with `KUVO_DRAFTS_TAG`
    /// before each name: before, after): not a test of behavior, it runs only when that's set.
    /// `folded`: the goal folded to its line by you.
    @Test func renders() async throws {
        defer { done() }
        guard let out = ProcessInfo.processInfo.environment["KUVO_DRAFTS_OUT"].map({ URL(fileURLWithPath: $0) }) else { return }
        let tag = ProcessInfo.processInfo.environment["KUVO_DRAFTS_TAG"] ?? "now"
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try await until { elements.contains { $0.label == "Answer" } }
        let shots: [(name: String, size: NSSize, folded: Bool)] = [("wide", NSSize(width: 820, height: 900), false), ("short", NSSize(width: 820, height: 620), false),
                                                                  ("narrow", NSSize(width: 460, height: 760), false), ("folded", NSSize(width: 820, height: 620), true)]
        // The app's own look too, which some controls draw by.
        let look = NSApp.appearance
        defer { NSApp.appearance = look }
        for shot in shots where tag != "before" || !shot.folded {
            model.hidesGoal = shot.folded
            for scheme in ["dark", "light"] {
                // A fresh host in each look, as a window opened in it draws.
                window.appearance = NSAppearance(named: scheme == "dark" ? .darkAqua : .aqua)
                NSApp.appearance = window.appearance
                window.setContentSize(shot.size)
                window.contentView = NSHostingView(rootView: root(shot.size))
                for _ in 0..<15 {
                    window.contentView?.layoutSubtreeIfNeeded()
                    // Awaited, not a run loop turn: what's read needs the main actor free.
                    try await Task.sleep(for: .milliseconds(80))
                }
                let host = try #require(window.contentView)
                host.display()
                let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: rep)
                // Over the window's own background, which the view leaves to it, at the capture's scale.
                let cg = try #require(rep.cgImage)
                let context = try #require(CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0,
                                                     space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.setFillColor(scheme == "dark" ? CGColor(gray: 0.12, alpha: 1) : CGColor(gray: 0.97, alpha: 1))
                context.fill(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
                context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
                let png = try #require(context.makeImage().flatMap { NSBitmapImageRep(cgImage: $0).representation(using: .png, properties: [:]) })
                try png.write(to: out.appending(path: "\(tag)-\(shot.name)-\(scheme).png"))
            }
        }
    }
    /// Writing tucks the card into its line, the bars as they were under it, and sending brings
    /// them back (#408); the field having the keyboard alone, as it does whenever a conversation
    /// shows, doesn't. The card's own control tucks it too, apart from each bar's chevron. With
    /// KUVO_SHOTS_OUT, pictures of each, light and dark, go there.
    @Test func writingTucksTheCardAndSendingRestoresIt() async throws {
        defer { done() }
        let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"].map { URL(fileURLWithPath: $0) }
        engine.on("POST", "/api/session/ses_pixel/prompt", json: [String: String]())
        // Its models, as the engine lists them: a message goes on the default (with none known,
        // the chip asks for a model and Return opens the picker instead).
        let location = ["directory": "/"]
        let luna: [String: Any] = ["id": "luna", "modelID": "luna", "providerID": "openai", "name": "Luna",
                                   "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [], "time": ["released": 1],
                                   "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true, "limit": ["context": 100_000, "output": 8_000]]
        engine.on("GET", "/api/integration", json: ["location": location, "data": [["id": "openai", "name": "OpenAI", "methods": [["type": "key"]],
                                                                                  "connections": [["type": "credential", "credentialID": "cred_openai", "method": "key"]]]]])
        engine.on("GET", "/api/model", json: ["location": location, "data": [luna]])
        engine.on("GET", "/api/model/default", json: ["location": location, "data": luna])
        engine.on("GET", "/api/agent", json: ["location": location, "data": []])
        engine.on("GET", "/api/command", json: ["location": location, "data": []])
        catalog.api = engine.api
        await catalog.refresh()
        app.workspace.handle(try engine.event("form.replied", session: "ses_pixel", ["id": "frm_concept", "sessionID": "ses_pixel"]))
        app.workspace.handle(try engine.event("shell.created", session: "ses_pixel", ["info": [
            "id": "sh_408", "metadata": ["sessionID": "ses_pixel"], "status": "running", "command": "swift build"
        ]] as [String: Any]))
        show(NSSize(width: 820, height: 1000))
        try await until { app.workspace.lastingShellJobs.contains("sh_408") }
        func fields(_ view: NSView?) -> [MessageTextView] {
            guard let view else { return [] }
            return (view as? MessageTextView).map { [$0] } ?? view.subviews.flatMap { fields($0) }
        }
        let previousAppearance = NSApp.appearance
        defer { NSApp.appearance = previousAppearance }
        for dark in out == nil ? [false] : [false, true] {
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            NSApp.appearance = window.appearance
            let look = dark ? "dark" : "light"
            try await until { !fields(window.contentView).isEmpty }
            let field = try #require(fields(window.contentView).first)
            window.makeFirstResponder(field)
            model.draftText = ""
            model.tuck.show()
            try await until { elements.contains { $0.label == "Fold all bars" } && elements.contains { $0.label?.hasPrefix("Running in the background") == true } }
            #expect(window.firstResponder === field)
            #expect(!model.tuck.isOn(among: [.goal, .background]), "the field's keyboard alone doesn't tuck the card")
            func keep(_ state: String) async throws {
                guard let out else { return }
                var previous: [NSRect] = []
                var changed = Date.now
                try await until {
                    let frames = elements.map(\.frame)
                    if frames != previous { previous = frames; changed = .now }
                    return Date.now.timeIntervalSince(changed) > 0.6
                }
                let host = try #require(window.contentView)
                host.layoutSubtreeIfNeeded()
                host.display()
                let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: rep)
                let cg = try #require(rep.cgImage)
                let context = try #require(CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0,
                                                     space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.setFillColor(CGColor(gray: dark ? 0.12 : 0.97, alpha: 1))
                context.fill(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
                context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
                let png = try #require(context.makeImage().flatMap { NSBitmapImageRep(cgImage: $0).representation(using: .png, properties: [:]) })
                try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                try png.write(to: out.appending(path: "mac-\(look)-\(state).png"))
            }
            try await keep("open")
            #expect(try #require(elements.first { $0.label == "Fold all bars" }).press())
            try await until { elements.contains { $0.label?.hasPrefix("Bars: ") == true } }
            try await keep("folded")
            #expect(try #require(elements.first { $0.label?.hasPrefix("Bars: ") == true }).press())
            try await until { elements.contains { $0.label == "Fold all bars" } }
            window.makeFirstResponder(field)
            field.insertText("Keep the conversation in sight", replacementRange: NSRange(location: NSNotFound, length: 0))
            try await until { model.draftText == "Keep the conversation in sight" && model.tuck.isOn(among: [.goal, .background]) }
            try await keep("typing")
            let enter = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                                    context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
            field.keyDown(with: enter)
            // Its send is on its way: waited for however this ends, before `done()` stops the
            // engine, which would put the words back in the composer (`Drafts.shared`).
            do {
                try await until { model.draftText.isEmpty && !model.tuck.isOn(among: [.goal, .background]) }
                try await until { elements.contains { $0.label == "Fold all bars" } }
                try await keep("sent")
            } catch {
                await model.messagesSent()
                throw error
            }
            await model.messagesSent()
            #expect(model.draftText.isEmpty, "its words didn't come back")
            #expect(model.failure == nil, "\(model.failure ?? "")")
        }
    }

}
