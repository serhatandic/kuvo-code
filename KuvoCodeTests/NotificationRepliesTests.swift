import UserNotifications
import ClientText
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

    /// A permission's notification names what its Always saves, as the conversation's card does:
    /// the kind of command (`git push *` for `git push origin main`), every edit, the folder.
    @Test func alwaysSaysWhatItSaves() throws {
        func request(_ action: String, _ resources: [String], save: [String]?) throws -> PermissionRequest {
            var json: [String: Any] = ["id": "per_push", "sessionID": id, "action": action, "resources": resources]
            if let save { json["save"] = save }
            return try JSONDecoder().decode(PermissionRequest.self, from: JSONSerialization.data(withJSONObject: json))
        }
        func titles(_ request: PermissionRequest) -> [String] {
            Notifier.buttons(always: AlwaysWords.of(action: request.action, save: request.save, resources: request.resources, home: "/Users/me").plain).map(\.title)
        }
        #expect(titles(try request("shell", ["git push origin main"], save: ["git push *"])) == ["Allow Once", "Always Allow git push", "Don’t Allow"])
        #expect(titles(try request("edit", ["Sources/App.swift"], save: ["*"])) == ["Allow Once", "Always Allow Edits", "Don’t Allow"])
        #expect(titles(try request("external_directory", ["/Users/me/notes/a.md"], save: ["/Users/me/notes/*"])) == ["Allow Once", "Always Allow ~/notes", "Don’t Allow"])
        #expect(Notifier.buttons(always: nil).map(\.answer) == [.once, .reject])

        let always = Notifier.info(session: id, permission: (session: id, request: "per_push"), question: nil)
        #expect(Notifier.response(to: Notifier.PermissionAnswer.always.rawValue, info: always, text: nil) == .permission(session: id, request: "per_push", .always))
        let none = Notifier.info(session: id, permission: (session: id, request: "per_push"), question: nil, offersAlways: false)
        #expect(Notifier.response(to: Notifier.PermissionAnswer.always.rawValue, info: none, text: nil) == .open(session: id), "no Always from one that has none")
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
    @Test func aUsageTapOpensTheUsagePanelThroughTheHostsDelegate() {
        let notifier = Notifier.shared
        let previous = notifier.openUsage
        defer { notifier.openUsage = previous }
        var opened = 0
        notifier.openUsage = { opened += 1 }
        let action = Notifier.response(to: UNNotificationDefaultActionIdentifier, info: ["usage": true], text: nil)
        notifier.handle(action)
        #expect(opened == 1)
    }

}
