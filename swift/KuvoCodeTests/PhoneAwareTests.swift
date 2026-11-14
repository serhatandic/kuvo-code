import ClientSessions
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The agent knows when you write from your phone: what a phone sends ends with a block saying
/// so (this Mac's box adds it, as a machine's bridge does with the Mac closed, in the same words),
/// which your bubble never shows, marking the message as from your iPhone instead; and who it names
/// with "&" is told with it, as a message written here tells it. There it shows you a file with
/// show_file, which puts it in the conversation; it's checked to be a file first. This Mac's box is
/// the real one, its engine a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneAwareTests {
    let engine = StubEngine(port: 47995)

    init() {
        engine.on("POST", "/api/session/ses_1/prompt", json: [:])
        engine.on("GET", "/api/session/ses_1", json: ["data": StubEngine.session("ses_1", title: "Here", directory: "/tmp/kuvo-tests-project")])
    }

    /// As a phone sends it: to this Mac's box (`kuvo/sessions/<id>/send`, as fields; `path`, the
    /// engine's prompt, as a phone from before sends its text), which passes it on to the engine.
    /// What the engine got: the text the agent reads, and the parts kept with it.
    private func send(_ body: [String: Any], to path: String = "kuvo/sessions/ses_1/send", through box: TestBox) async throws -> (text: String, parts: MessageParts?)? {
        let endpoint = try #require(box.process.endpoint)
        var request = URLRequest(url: try #require(URL(string: path, relativeTo: endpoint.url)))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let password = endpoint.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["id": "msg_\(UUID().uuidString.prefix(8))"].merging(body) { $1 })
        let (_, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        guard let sent = engine.requests("POST", "/api/session/ses_1/prompt").last?.body, let text = sent["text"] as? String else { return nil }
        let metadata = try (sent["metadata"]).map { try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: $0)) }
        return (text, MessageParts.kept(in: metadata))
    }

    private static let fromPhone = "<from-phone>\nThe user sent this from Kuvo Code on their iPhone.\n"

    /// A widget's answer from the phone: the box adds that it's from the phone, after the widget
    /// it names, and both come back apart.
    @Test func aWidgetsAnswerFromThePhoneKeepsItsWidget() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); engine.stop() }
        let sent = try #require(try await send(["words": "Show it in minutes", "widget": "Build times this week"], through: box))
        #expect(sent.text.contains("\n\n" + Self.fromPhone))
        #expect(sent.parts == MessageParts(words: "Show it in minutes", widget: "Build times this week", phone: true))
    }

    @Test func whatAPhoneSendsSaysSoAndYourBubbleDoesnt() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); engine.stop() }
        let sent = try #require(try await send(["words": "What's in the report?"], through: box))
        #expect(sent.text.hasPrefix("What's in the report?\n\n" + Self.fromPhone))
        #expect(sent.text.hasSuffix("</from-phone>") && sent.text.contains("show_file"))
        // Your bubble shows your words, from your iPhone.
        #expect(sent.parts == MessageParts(words: "What's in the report?", phone: true))
        // A phone from before sends its text itself: said once, however often it's sent.
        let before = try #require(try await send(["text": sent.text], to: "api/session/ses_1/prompt", through: box))
        #expect(before.text == sent.text)
        #expect(before.parts == MessageParts(words: "What's in the report?", phone: true))
    }

    /// However a phone from before wrote the path ("%70rompt"), its message says so: it's told by
    /// the path the engine gets.
    @Test func aPathWrittenAnotherWaySaysSoToo() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); engine.stop() }
        let sent = try #require(try await send(["text": "Hi"], to: "api/%73ession/ses_1/%70rompt", through: box))
        #expect(sent.text.hasSuffix("</from-phone>"))
        #expect(sent.parts?.phone == true)
    }

    /// A phone's message naming a conversation here with "&": the agent's told who it is, as when
    /// it's written on this Mac, and your bubble shows the name.
    @Test func whoAPhonesMessageNamesIsTold() async throws {
        engine.list([StubEngine.session("ses_scout", title: "Scout", directory: "/tmp/kuvo-tests-project"), StubEngine.session("ses_1", title: "Here", directory: "/tmp/kuvo-tests-project")])
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); engine.stop() }
        let sent = try #require(try await send(["words": "Ask &Scout about the report"], through: box))
        #expect(sent.text.contains("\n\n<named-agents>\n"))
        #expect(sent.parts == MessageParts(words: "Ask &Scout about the report", agents: [.init(name: "Scout", session: "ses_scout")], phone: true))
    }

    /// A machine's bridge, with the Mac closed, says it in the same words.
    @Test func aMachineSaysItTheSameWay() throws {
        defer { engine.stop() }
        let script = try String(decoding: Bridge.script, as: UTF8.self)
        #expect(script.contains(#"["<from-phone>", "The user sent this from Kuvo Code on their iPhone.", "They read your reply on a small screen,"#))
    }
}
