import ClientText
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
    }

    /// As a phone sends it: to this Mac's box, which passes it on to the engine. What the engine got.
    private func send(_ text: String, to path: String = "api/session/ses_1/prompt", through box: TestBox) async throws -> String? {
        let endpoint = try #require(box.process.endpoint)
        var request = URLRequest(url: try #require(URL(string: path, relativeTo: endpoint.url)))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let password = endpoint.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["id": "msg_1", "text": text])
        let (_, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        return engine.requests("POST", "/api/session/ses_1/prompt").last?.body["text"] as? String
    }

    /// A widget's answer from the phone: the box adds that it's from the phone, after the widget
    /// it names, and both come back apart.
    @Test func aWidgetsAnswerFromThePhoneKeepsItsWidget() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); engine.stop() }
        let sent = try #require(try await send(WidgetAnswer.message("Show it in minutes", from: "Build times this week"), through: box))
        #expect(FromPhone.isFromPhone(sent))
        #expect(SentMessage.words(of: sent) == "Show it in minutes")
        #expect(SentMessage.widget(of: sent) == "Build times this week")
    }

    @Test func whatAPhoneSendsSaysSoAndYourBubbleDoesnt() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); engine.stop() }
        let sent = try #require(try await send("What's in the report?", through: box))
        #expect(sent.hasPrefix("What's in the report?\n\n<from-phone>\n\(FromPhone.heading)\n"))
        #expect(sent.hasSuffix("</from-phone>") && sent.contains("show_file"))
        // Your bubble shows your words, from your iPhone.
        #expect(SentMessage.words(of: sent) == "What's in the report?")
        #expect(FromPhone.isFromPhone(sent))
        // Sent again, it's said once.
        #expect(try await send(sent, through: box) == sent)
        // Words that only talk about the block keep it.
        #expect(!FromPhone.isFromPhone("What does <from-phone> mean?"))
    }

    /// However the phone wrote the path ("%70rompt"), its message says so: it's told by the path
    /// the engine gets.
    @Test func aPathWrittenAnotherWaySaysSoToo() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); engine.stop() }
        _ = try await send("Hi", to: "api/%73ession/ses_1/%70rompt", through: box)
        let sent = try #require(engine.requests("POST", "/api/session/ses_1/prompt").last?.body["text"] as? String)
        #expect(FromPhone.isFromPhone(sent))
    }

    /// A phone's message naming a conversation here with "&": the agent's told who it is, as when
    /// it's written on this Mac, and your bubble shows the name.
    @Test func whoAPhonesMessageNamesIsTold() async throws {
        engine.list([StubEngine.session("ses_scout", title: "Scout", directory: "/tmp/kuvo-tests-project"), StubEngine.session("ses_1", title: "Here", directory: "/tmp/kuvo-tests-project")])
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); engine.stop() }
        let sent = try #require(try await send("Ask &Scout about the report", through: box))
        let (words, _, _, references) = SentMessage.split(sent)
        #expect(words == "Ask &Scout about the report")
        #expect(references == [AgentReferences.Reference(name: "Scout", session: "ses_scout")])
        #expect(FromPhone.isFromPhone(sent))
    }

    /// A machine's bridge, with the Mac closed, says it in the same words.
    @Test func aMachineSaysItTheSameWay() throws {
        defer { engine.stop() }
        let script = try String(decoding: Bridge.script, as: UTF8.self)
        #expect(script.contains(#"["<from-phone>", "\#(FromPhone.heading)", "\#(FromPhone.advice)", "</from-phone>"]"#))
    }
}
