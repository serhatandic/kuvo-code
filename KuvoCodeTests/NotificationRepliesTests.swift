import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Answering from a notification (L41, K3): Allow on a permission's answers it, a question's
/// choice or what you type answers that question, Reply writes to the conversation (a message
/// that waits in line if the agent is at work), and a click opens the conversation. Each as the
/// notification carries it. Nothing is posted to Notification Center; the engine is stubbed.
@MainActor
@Suite(.serialized) struct NotificationRepliesTests {
    let engine = StubEngine(port: 47983)
    let workspace = Workspace()
    let id = "ses_note"

    init() {
        workspace.api = engine.api
    }

    @Test func eachButtonDoesWhatItSays() {
        let permission = Notifier.info(session: id, permission: (session: "ses_sub", request: "per_rm"), question: nil)
        #expect(Notifier.response(to: Notifier.PermissionAnswer.once.rawValue, info: permission, text: nil) == .permission(session: "ses_sub", request: "per_rm", .once))
        #expect(Notifier.response(to: Notifier.PermissionAnswer.reject.rawValue, info: permission, text: nil) == .permission(session: "ses_sub", request: "per_rm", .reject))

        let question = Notifier.Question(session: id, form: "frm_db", key: "database", text: "Which database?",
                                         choices: [("postgres", "Postgres"), ("sqlite", "SQLite")], allowsText: true)
        let asked = Notifier.info(session: id, permission: nil, question: question)
        #expect(Notifier.response(to: Notifier.choicePrefix + "1", info: asked, text: nil) == .question(session: id, form: "frm_db", key: "database", "sqlite"))
        #expect(Notifier.response(to: Notifier.answerAction, info: asked, text: "MySQL") == .question(session: id, form: "frm_db", key: "database", "MySQL"))
        #expect(Notifier.response(to: Notifier.choicePrefix + "7", info: asked, text: nil) == .open(session: id), "a choice it doesn't have opens it instead")

        let done = Notifier.info(session: id, permission: nil, question: nil)
        #expect(Notifier.response(to: Notifier.replyAction, info: done, text: "Now add tests") == .reply(session: id, "Now add tests"))
        #expect(Notifier.response(to: "com.apple.UNNotificationDefaultActionIdentifier", info: done, text: nil) == .open(session: id))
        #expect(Notifier.response(to: Notifier.replyAction, info: [:], text: "hi") == nil)
    }

    /// Always for This saves the engine's rule for a permission, which can be wider than its
    /// notification shows (`git push *` for `git push origin main`, any file for one): then the
    /// notification offers Allow Once and Don't Allow only, and an Always from it saves nothing.
    @Test func alwaysIsOfferedOnlyForWhatTheNotificationShows() throws {
        func request(_ resources: [String], save: [String]?) throws -> PermissionRequest {
            var json: [String: Any] = ["id": "per_push", "sessionID": id, "action": "shell", "resources": resources]
            if let save { json["save"] = save }
            return try JSONDecoder().decode(PermissionRequest.self, from: JSONSerialization.data(withJSONObject: json))
        }
        #expect(!Notifier.offersAlways(try request(["git push origin main"], save: ["git push *"])), "a wider rule than it shows")
        #expect(!Notifier.offersAlways(try request(["Sources/App.swift"], save: ["*"])), "any file, for one")
        #expect(Notifier.offersAlways(try request(["npm test"], save: ["npm test"])))
        #expect(Notifier.offersAlways(try request(["Sources/App.swift", "README.md"], save: nil)), "what it shows, when the engine names no rule")
        #expect(Notifier.buttons(offeringAlways: false) == [.once, .reject])
        #expect(Notifier.buttons(offeringAlways: true) == [.once, .always, .reject])

        let info = Notifier.info(session: id, permission: (session: id, request: "per_push"), question: nil, offersAlways: false)
        #expect(Notifier.response(to: Notifier.PermissionAnswer.always.rawValue, info: info, text: nil) == .open(session: id), "no Always from it")
        #expect(Notifier.response(to: Notifier.PermissionAnswer.once.rawValue, info: info, text: nil) == .permission(session: id, request: "per_push", .once))
    }

    @Test func aReplyGoesToTheConversation() async throws {
        defer { engine.stop() }
        engine.list([StubEngine.session(id, title: "Release notes", directory: "/tmp/kuvo-tests-note")], running: [id])
        engine.on("POST", "/api/session/\(id)/prompt", json: [:])
        await workspace.refresh()
        await workspace.send("  Now add tests for it \n", to: id)
        let sent = try #require(engine.requests("POST", "/api/session/\(id)/prompt").first)
        #expect(sent.body["text"] as? String == "Now add tests for it")
        #expect(sent.body["delivery"] as? String == "queue", "it waits in line while the agent works")
    }
}
