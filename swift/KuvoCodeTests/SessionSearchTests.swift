import ClientSessions
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Searching the sidebar for what was said in conversations (B18): sessions whose conversation has
/// the words, archived ones too, the latest first, with the words around them; not one deleted
/// since, and not every session for a word only the app's own labels have ("You", "Agent", "Read
/// …" for a step), though a step's file is found.
/// A bot's own conversation is found as the bot, with its face, as the sidebar shows it: by its name,
/// its conversation's title, or what was said in it.
/// Each box searches its own conversations (`kuvo/search`): this Mac's is the real box; the engine
/// is stubbed.
@MainActor
@Suite(.serialized) struct SessionSearchTests {
    let engine = StubEngine(port: 47990)
    let workspace = Workspace()

    init() {
        workspace.api = engine.api
    }

    /// What you said, and the agent's reply after a step or two: it asked you something and read
    /// a file of the project.
    private func conversation(_ id: String, you: String, agent: String) -> [[String: Any]] {
        [
            ["id": "msg_\(id)_1", "type": "user", "time": ["created": 1], "text": you],
            ["id": "msg_\(id)_2", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3],
             "model": ["id": "m", "providerID": "p"], "content": [
                 ["type": "tool", "id": "call_\(id)_q", "name": "question", "executed": true,
                  "state": ["status": "completed", "input": [:], "output": "ok"]],
                 ["type": "tool", "id": "call_\(id)_r", "name": "read", "executed": true,
                  "state": ["status": "completed", "input": ["path": "/tmp/kuvo-tests-search/Sources/\(id).swift"], "output": "…"]],
                 ["type": "text", "text": agent],
             ]],
        ]
    }

    /// Three sessions: the login fix (the latest), dark mode, and an archived one about logs.
    private func start() async {
        engine.list([
            StubEngine.session("ses_login", title: "Login", directory: "/tmp/kuvo-tests-search", created: 30),
            StubEngine.session("ses_dark", title: "Theme", directory: "/tmp/kuvo-tests-search", created: 20),
            StubEngine.session("ses_logs", title: "Old one", directory: "/tmp/kuvo-tests-search", created: 10,
                               extra: ["metadata": ["kuvo.archived": true]]),
        ])
        engine.conversation("ses_login", conversation("login", you: "The sign-in form forgets the email", agent: "Fixed: the form keeps the email now."))
        engine.conversation("ses_dark", conversation("dark", you: "Add a dark theme", agent: "Done: the theme follows the system."))
        engine.conversation("ses_logs", conversation("logs", you: "Why is the email log so big?", agent: "It keeps every request."))
        await workspace.refresh()
    }

    /// This Mac's box, which searches, reaching the stubbed engine.
    private func searching() async throws -> TestBox {
        let box = try await TestBox(engine: engine.url)
        workspace.boxes = { _ in box.client(engine: engine.url) }
        return box
    }

    private func found(_ query: String) async -> [String] {
        await workspace.searchConversations(query).map(\.session.id)
    }

    @Test func findsWhatWasSaidLatestFirstArchivedToo() async throws {
        let box = try await searching()
        defer {
            box.stop()
            engine.stop()
        }
        await start()
        #expect(await found("email") == ["ses_login", "ses_logs"])
        #expect(await found("THEME") == ["ses_dark"])
        #expect(workspace.unsearched.isEmpty)
        // A machine that isn't connected: its conversations aren't searched, and that's said.
        workspace.machines = ["devbox"]
        #expect(await found("email") == ["ses_login", "ses_logs"])
        #expect(workspace.unsearched == ["devbox": .notConnected])
        let snippet = try #require(await workspace.searchConversations("forgets").first?.snippet)
        #expect(snippet.contains("forgets the email"), "the words around it: \(snippet)")
    }

    /// What a subagent said finds the conversation it works for, which shows what it found, once.
    @Test func aSubagentsWordsFindItsConversation() async throws {
        let box = try await searching()
        defer {
            box.stop()
            engine.stop()
        }
        await start()
        engine.list([
            StubEngine.session("ses_login", title: "Login", directory: "/tmp/kuvo-tests-search", created: 30),
            StubEngine.session("ses_find", title: "Find the form", directory: "/tmp/kuvo-tests-search", created: 31,
                               extra: ["parentID": "ses_login"]),
            StubEngine.session("ses_dark", title: "Theme", directory: "/tmp/kuvo-tests-search", created: 20),
        ])
        engine.conversation("ses_find", conversation("find", you: "Find the sign-in form", agent: "It's in LoginView, beside the cookie banner."))
        await workspace.refresh()
        let found = await workspace.searchConversations("cookie banner")
        #expect(found.map(\.session.id) == ["ses_login"])
        #expect(found.first?.snippet.contains("cookie banner") == true)
        #expect(found.first?.subagent == "ses_find", "said by its subagent: opened without Find, which has nothing to show")
        let form = await workspace.searchConversations("form")
        #expect(form.map(\.session.id) == ["ses_login"], "its own words and its subagent's: found once")
        #expect(form.first?.subagent == nil, "by its own words first")
    }

    /// Words only the app adds when it writes a conversation out (who's speaking, its title) find
    /// nothing: no one said them.
    /// Each computer's finds show as it answers: one that's slow (a machine reading its
    /// conversations for the first time) holds none of the others up.
    @Test func eachComputersFindsComeAsItAnswers() async throws {
        let box = try await searching()
        let gate = Gate()
        defer {
            gate.open()
            box.stop()
            engine.stop()
        }
        await start()
        let slow = BoxClient(box: "devbox", transport: LocalBox { _ in
            AsyncThrowingStream { continuation in
                Task.detached {
                    gate.wait()
                    continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(Data(#"{"results": []}"#.utf8)))
                    continuation.finish()
                }
            }
        })
        let mac = box.client(engine: engine.url)
        workspace.searchedBoxes = { [BoxClient.mac, "devbox"] }
        workspace.boxes = { $0 == BoxClient.mac ? mac : slow }
        final class Answers { var byBox: [String: [String]] = [:] }
        let answers = Answers()
        let search = Task { await workspace.searchConversations("email") { box, finds in answers.byBox[box] = finds.map(\.session.id) } }
        try await until { answers.byBox[BoxClient.mac] != nil }
        #expect(answers.byBox[BoxClient.mac] == ["ses_login", "ses_logs"], "this Mac's, while the machine still searches")
        #expect(answers.byBox["devbox"] == nil)
        gate.open()
        #expect(await search.value.map(\.session.id) == ["ses_login", "ses_logs"])
        #expect(answers.byBox["devbox"] == [])
    }

    @Test func theAppsOwnLabelsFindNothing() async throws {
        let box = try await searching()
        defer {
            box.stop()
            engine.stop()
        }
        await start()
        #expect(await found("you").isEmpty)
        #expect(await found("Agent").isEmpty)
        // Nor its words for the steps: "Asked you a question", "Read …".
        #expect(await found("asked").isEmpty)
        #expect(await found("read").isEmpty)
        // What a step worked on is found.
        #expect(await found("dark.swift") == ["ses_dark"])
        #expect(await found("Old one").isEmpty, "a title is found by the title search, not in conversations")
    }

    @Test func aDeletedSessionIsntFound() async throws {
        let box = try await searching()
        defer {
            box.stop()
            engine.stop()
        }
        await start()
        #expect(await found("email").contains("ses_logs"))
        workspace.handle(try engine.event("session.deleted", session: "ses_logs"))
        #expect(await found("email") == ["ses_login"])
    }

    /// A bot, Ada, whose conversation is called "Morning digest" and has the email in it.
    private func startWithABot() async throws {
        try FileManager.default.createDirectory(at: Bots.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [[
            "id": "bot_ada", "name": "Ada", "job": "Reads my mail", "instructions": "Reads my mail.", "jobInMemory": true,
            "look": ["color": "mint", "shape": "round", "face": "calm"], "folder": AppInfo.testRoot.appending(path: "bot_ada").path,
            "sessionID": "ses_ada", "created": "2026-10-21T09:00:00Z",
        ]]).write(to: Bots.file)
        engine.list([
            StubEngine.session("ses_login", title: "Login", directory: "/tmp/kuvo-tests-search", created: 30),
            StubEngine.session("ses_ada", title: "Morning digest", directory: AppInfo.testRoot.appending(path: "bot_ada").path, created: 40),
        ])
        engine.conversation("ses_login", conversation("login", you: "The sign-in form forgets the email", agent: "Fixed."))
        engine.conversation("ses_ada", conversation("ada", you: "Sum up the email from the bank", agent: "Ada here: the bank wrote twice."))
        await workspace.refresh()
    }

    @Test func aBotIsFoundAsItself() async throws {
        let box = try await searching()
        defer {
            box.stop()
            engine.stop()
            try? FileManager.default.removeItem(at: Bots.file)
        }
        try await startWithABot()
        let bots = Bots()
        func shown(_ found: [SidebarSearch.Found]) -> [String] {
            found.map { if case .bot(let bot) = $0 { "bot " + bot.name } else { "session " + $0.id } }
        }
        #expect(shown(SidebarSearch.byName("ada", in: workspace, bots: bots)) == ["bot Ada"], "by its name")
        #expect(shown(SidebarSearch.byName("digest", in: workspace, bots: bots)) == ["bot Ada"], "by its conversation's title")
        #expect(shown(SidebarSearch.byName("log", in: workspace, bots: bots)) == ["session ses_login"])
        let said = SidebarSearch.inConversations(await workspace.searchConversations("email"), besides: [], in: workspace, bots: bots)
        #expect(shown(said.map(\.found)) == ["bot Ada", "session ses_login"], "by what was said in it, the latest first")
        #expect(said.first?.snippet.contains("email from the bank") == true, "with the words found")
        // Found by its name and by what was said to it: once.
        let named = SidebarSearch.byName("Ada", in: workspace, bots: bots)
        let ada = await workspace.searchConversations("Ada")
        #expect(ada.map(\.session.id) == ["ses_ada"], "it's in what was said too")
        let alsoSaid = SidebarSearch.inConversations(ada, besides: named, in: workspace, bots: bots)
        #expect(shown(named) + shown(alsoSaid.map(\.found)) == ["bot Ada"])
    }
}
