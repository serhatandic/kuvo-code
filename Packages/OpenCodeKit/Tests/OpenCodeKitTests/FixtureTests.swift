import Foundation
import Testing
@testable import OpenCodeKit

/// Fixtures are real responses from opencode 2.0.28 (paths anonymised).
enum Fixture {
    static func data(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        try HTTPClient.decoder.decode(T.self, from: data(name))
    }

    static func events() throws -> [ServerEvent] {
        try String(decoding: data("events.jsonl"), as: UTF8.self)
            .split(separator: "\n")
            .map { try ServerEvent(json: Data($0.utf8)) }
    }
}

struct DecodingTests {
    @Test func decodesTheIntegrationCatalog() throws {
        let integrations = try Fixture.decode("integration.json", as: LocatedEnvelope<[Integration]>.self).data
        #expect(integrations.count > 200)

        let copilot = try #require(integrations.first { $0.id == "github-copilot" })
        guard case .oauth(let id, let label, let form) = try #require(copilot.signInMethods.first) else {
            Issue.record("Copilot signs in with OAuth")
            return
        }
        #expect(id == "device")
        #expect(label == "Login with GitHub Copilot")
        // The enterprise URL only shows for enterprise deployments.
        let enterprise = try #require(form?.first { $0.key == "enterpriseUrl" })
        #expect(!enterprise.isActive(given: ["deploymentType": .string("github.com")]))
        #expect(enterprise.isActive(given: ["deploymentType": .string("enterprise")]))

        let openai = try #require(integrations.first { $0.id == "openai" })
        #expect(openai.signInMethods.contains { $0.id == "oauth:chatgpt-token-sharing" })
        #expect(openai.environmentVariables == ["OPENAI_API_KEY"])
    }

    @Test func decodesModelsAndAgents() throws {
        let models = try Fixture.decode("model.json", as: LocatedEnvelope<[Model]>.self).data
        #expect(models.contains { $0.id == "big-pickle" && $0.isFree })
        #expect(models.allSatisfy { $0.modelID == $0.id })
        // What a conversation can fill, as the context ring counts it: the provider's input limit
        // when it has one (the engine summarizes before it), else the whole window.
        #expect(models.first { $0.id == "big-pickle" }?.limit.usable == 160_000)
        #expect(models.first { $0.id == "exo-free" }?.limit.usable == 1_048_576)
        let agents = try Fixture.decode("agent.json", as: LocatedEnvelope<[Agent]>.self).data
        #expect(agents.filter(\.isPrimary).map(\.id) == ["build", "plan"])
    }

    /// Settings › Engine's plugins: a package that didn't load (a name misspelled) comes without a
    /// name of the engine's, and still shows, as what it was added as, with the others.
    @Test func decodesPluginsWithOneThatFailed() throws {
        let plugins = try Fixture.decode("plugin.json", as: LocatedEnvelope<[PluginInfo]>.self).data
        let added = plugins.filter { $0.source.type != "builtin" }
        #expect(added.map(\.source.entry) == ["opencode-wakatime", "@tarquinen/opencode-dcp", "opencode-doesnotexist-xyz-123"])
        #expect(added.first?.source.version == "1.4.0")
        let failed = try #require(added.last)
        #expect(failed.id == "opencode-doesnotexist-xyz-123")
        #expect(failed.state.status == "failed")
    }

    @Test func decodesStoredMessages() throws {
        let page = try Fixture.decode("messages.json", as: Page<Message>.self)
        #expect(page.data.count == 13)
        guard case .idle(let failed) = page.data[2] else {
            Issue.record("Third message is the failed turn's idle marker")
            return
        }
        #expect(failed.outcome == .failed)
        #expect(failed.error?.status == 410)
    }

    @Test func findsDeviceCodes() {
        func attempt(_ url: String, _ instructions: String) -> OAuthAttempt {
            OAuthAttempt(attemptID: "con_1", url: url, instructions: instructions, mode: .auto, time: .init(created: 0, expires: 0))
        }
        #expect(attempt("https://github.com/login/device", "Enter code: ABCD-1234").userCode == "ABCD-1234")
        #expect(attempt("https://x.ai/device?user_code=QWER", "Open it").userCode == "QWER")
        #expect(attempt("https://auth.openai.com/authorize", "Complete authorization in your browser. This window will close automatically.").userCode == nil)
    }

    @Test func mintsSortableMessageIDs() {
        let first = Identifier.message()
        let second = Identifier.message()
        #expect(first.hasPrefix("msg_") && first.count == 30)
        #expect(first < second)
        // Same encoding as the server's: msg_1349cb403001… was minted at 1791884047363 ms.
        #expect(Identifier.ascending(now: Date(timeIntervalSince1970: 1_791_884_047.3635)).hasPrefix("1349cb403"))
    }
}

struct TranscriptTests {
    private static let session = "ses_ecb63eb0fffeLZyYgRmShX9IVf"

    /// Replaying the live event stream from empty gives the transcript the server stored.
    @Test func replayMatchesTheServersProjection() throws {
        var transcript = Transcript(sessionID: Self.session)
        for event in try Fixture.events() { transcript.apply(event) }

        let stored = try Fixture.decode("messages.json", as: Page<Message>.self).data
        #expect(!transcript.isStale)
        #expect(!transcript.isRunning)
        #expect(transcript.pending.isEmpty)
        #expect(transcript.forms.isEmpty)
        #expect(transcript.messages.map(\.id) == stored.map(\.id))
        #expect(transcript.messages.map(Self.summary) == stored.map(Self.summary))
    }

    /// The events said to change nothing don't: the app leaves them out.
    @Test func leavesOutOnlyEventsThatChangeNothing() throws {
        var all = Transcript(sessionID: Self.session)
        var some = Transcript(sessionID: Self.session)
        for event in try Fixture.events() {
            all.apply(event)
            if Transcript.changes(with: event.type) { some.apply(event) }
            #expect(some == all, "after \(event.type)")
        }
        #expect(Transcript.isStreamed("session.text.delta") && Transcript.changes(with: "session.text.delta"))
    }

    /// Streaming words in, changed in place, leaves a copy taken before as it was.
    @Test func keepsCopiesAsTheyWere() throws {
        let events = try Fixture.events()
        var transcript = Transcript(sessionID: Self.session)
        var copies: [Transcript] = []
        for event in events {
            copies.append(transcript)
            transcript.apply(event)
        }
        var again = Transcript(sessionID: Self.session)
        for (event, copy) in zip(events, copies) {
            #expect(again == copy, "before \(event.type)")
            again.apply(event)
        }
    }

    /// A conversation saved and read back (the app's copy of a machine's) is the same one.
    @Test func messagesSurviveBeingSaved() throws {
        let stored = try Fixture.decode("messages.json", as: Page<Message>.self).data
        let again = try JSONDecoder().decode([Message].self, from: JSONEncoder().encode(stored))
        #expect(again == stored)
    }

    @Test func showsTheQuestionWhileItsOpen() throws {
        var transcript = Transcript(sessionID: Self.session)
        for event in try Fixture.events() {
            transcript.apply(event)
            if event.type == "form.created" { break }
        }
        let form = try #require(transcript.forms.first)
        #expect(form.isQuestion)
        #expect(transcript.isRunning)
        guard case .string(let options, let custom, _, _, _, _) = form.fields.first?.kind else {
            Issue.record("The question is a string field")
            return
        }
        #expect(options?.map(\.label) == ["Red", "Blue"])
        #expect(custom)

        // As a notification asks it: the question, not its header, with its choices.
        let single = try #require(form.single)
        #expect(single.key == "q0")
        #expect(single.text == "Which color do you prefer?")
        #expect(single.choices.map(\.value) == ["Red", "Blue"])
        #expect(single.allowsText)
    }

    @Test func keepsLocalMessagesUntilTheServerHasThem() throws {
        var transcript = Transcript(sessionID: Self.session)
        transcript.addLocal(id: "msg_1349cb403001YFcOUTFbPGFYeS", text: "Create a file", delivery: .steer)
        transcript.load(messages: [], inbox: [], permissions: [], forms: [], isRunning: false)
        #expect(transcript.pending.map(\.isLocal) == [true])

        for event in try Fixture.events() where event.type.hasPrefix("session.inbox") {
            transcript.apply(event)
        }
        #expect(transcript.pending.isEmpty)
        #expect(transcript.messages.contains { $0.id == "msg_1349cb403001YFcOUTFbPGFYeS" })
    }

    @Test func keepsTheFilesOfWaitingInput() throws {
        let picked = URL(filePath: "/Users/me/Desktop/photo.heic")
        let converted = "file:///Users/me/Library/Attachments/photo.png"
        var transcript = Transcript(sessionID: Self.session)
        transcript.addLocal(id: "msg_1", text: "Look", delivery: .queue, files: [picked])

        // The server's copy names the converted file; the local one knows what was picked.
        let enqueued = """
        {"id":"evt_2","type":"session.inbox.enqueued","data":{"inboxID":"msg_1","sessionID":"\(Self.session)",\
        "item":{"type":"user","payload":{"text":"Look","files":[{"uri":"\(converted)"}]},"delivery":"queue"}}}
        """
        transcript.apply(try ServerEvent(json: Data(enqueued.utf8)))
        #expect(transcript.pending.map(\.isLocal) == [false])
        #expect(transcript.pending.first?.files == [picked])

        // Read back after a restart: the files on this Mac, nothing else.
        let payload = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"text":"Look","files":[{"uri":"\(converted)"},{"uri":"data:image/png;base64,AAAA"}]}
        """.utf8))
        let item = InboxItem(id: "msg_1", sessionID: Self.session, type: "user", payload: payload, delivery: .queue)
        var restarted = Transcript(sessionID: Self.session)
        restarted.load(messages: [], inbox: [item], permissions: [], forms: [], isRunning: false)
        #expect(restarted.pending.first?.files == [URL(string: converted)!])

        // Read again while it's still shown: the files as they were picked stay (one sent inline,
        // to a machine, has no file the server could name).
        transcript.load(messages: [], inbox: [item], permissions: [], forms: [], isRunning: false)
        #expect(transcript.pending.first?.files == [picked])
    }

    /// What a person would see: message kind, text, tools and their outcome.
    private static func summary(_ message: Message) -> String {
        switch message {
        case .user(let m): "user: \(m.text)"
        case .assistant(let m):
            "assistant(\(m.finish ?? "-")): " + m.content.map { block in
                switch block {
                case .text(let t): "text[\(t.text)]"
                case .reasoning(let t): "reasoning[\(t.text)]"
                case .tool(let call):
                    switch call.state {
                    case .completed(_, let output, _): "tool[\(call.name) ok \(output.compactMap(\.text).joined())]"
                    case .failed(_, let error, _, _): "tool[\(call.name) failed \(error.message)]"
                    default: "tool[\(call.name) unfinished]"
                    }
                case .other(let type): type
                }
            }.joined(separator: " ")
        case .idle(let m): "idle: \(m.outcome) \(m.error?.message ?? "")"
        case .modelSwitched(let m): "model: \(m.model.id)"
        case .agentSwitched(let m): "agent: \(m.agent)"
        default: "\(message)"
        }
    }
}
