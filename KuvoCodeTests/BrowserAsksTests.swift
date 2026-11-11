import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// What the agent asks you for while it browses: a card in the conversation that asked (a
/// subagent's, in the one it works for), answered once, gone when the run that asked ends; a
/// sign-in that asks for the username and password on two pages is asked for once.
@MainActor
@Suite struct BrowserAsksTests {
    let asks = BrowserAsks()

    init() {
        TestEnvironment.prepare()
        // A subagent works for its parent's conversation.
        asks.conversation = { $0 == "ses_sub" ? "ses_parent" : $0 }
    }

    /// Adds an ask as a machine's browser sends one; its answers, as they come.
    private func ask(_ kind: BrowserAsks.Kind, host: String = "github.com", session: String?, machine: String? = "box") -> (id: String, answers: Answers) {
        let answers = Answers()
        let id = UUID().uuidString
        asks.add(BrowserAsks.Ask(id: id, kind: kind, host: host, machine: machine, session: session)) { answers.got.append($0) }
        return (id, answers)
    }

    final class Answers { var got: [BrowserAsks.Answer] = [] }

    @Test func aSubagentsAskShowsInItsConversationAndGoesWithItsRun() {
        let (_, answers) = ask(.action(instruction: "Approve on your phone"), session: "ses_sub", machine: nil)
        #expect(asks.asks(for: "ses_parent").count == 1)
        #expect(asks.asks(for: "ses_sub").isEmpty)
        // The conversation's own run ending isn't the subagent's.
        asks.runEnded("ses_parent")
        #expect(asks.asks(for: "ses_parent").count == 1)
        asks.runEnded("ses_sub")
        #expect(asks.asks.isEmpty)
        if case .declined? = answers.got.first {} else { Issue.record("its call wasn't told no: \(answers.got)") }
    }

    @Test func anAnswerGoesOnceAndTheCardGoes() {
        let (id, answers) = ask(.code(prompt: "Enter the code"), session: "ses_a")
        asks.answer(id, .code("123456"))
        asks.answer(id, .code("654321"))
        #expect(asks.asks.isEmpty)
        #expect(answers.got.count == 1)
        if case .code(let code)? = answers.got.first { #expect(code == "123456") } else { Issue.record("no code") }
    }

    /// The password page after the username's: answered from the sign-in you just gave, for that
    /// conversation and site only.
    @Test func aSignInOverTwoPagesIsAskedForOnce() {
        let (first, _) = ask(.signIn(username: true, password: false), session: "ses_a")
        asks.answer(first, .signIn(username: "me@example.com", password: "hunter2"))
        let (_, again) = ask(.signIn(username: false, password: true), session: "ses_a")
        #expect(asks.asks.isEmpty)
        if case .signIn(_, let password)? = again.got.first { #expect(password == "hunter2") } else { Issue.record("not answered: \(again.got)") }
        // Another conversation, or another site: asked.
        _ = ask(.signIn(username: false, password: true), session: "ses_b")
        _ = ask(.signIn(username: false, password: true), host: "gitlab.com", session: "ses_a")
        #expect(asks.asks.count == 2)
    }

    /// From a phone: the cards listed (the site, the machine by its name and its box, whose ask it
    /// is and where a phone's answer goes when this Mac can't take it; what the page asks for),
    /// each answered as on the Mac, once; an answer that isn't the card's, or a card that's gone,
    /// says so.
    @Test func aPhoneAnswersThem() async throws {
        let link = PhoneLink()
        link.browserAsks = asks
        link.machineName = { $0 == "box" ? "Build Box" : nil }
        link.standIn(machine: "box", key: "box-key", address: "box-link-address")
        func phone(_ path: String, _ body: [String: String]? = nil) async throws -> (status: Int, json: [String: Any]?) {
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
        let (signIn, signedIn) = ask(.signIn(username: true, password: true), session: "ses_a")
        let (code, coded) = ask(.code(prompt: "Enter the 6-digit code"), host: "bank.example", session: "ses_b", machine: nil)
        let listed = try #require(try await phone("kuvo/asks").json?["asks"] as? [[String: Any]])
        let card = try #require(listed.first { $0["id"] as? String == signIn })
        #expect(card["kind"] as? String == "signIn" && card["host"] as? String == "github.com" && card["machine"] as? String == "Build Box")
        #expect(card["box"] as? String == "box-link-address")
        #expect(card["username"] as? Bool == true && card["password"] as? Bool == true)
        #expect(listed.first { $0["id"] as? String == code }?["box"] == nil, "this Mac's own")
        #expect(listed.first { $0["id"] as? String == code }?["prompt"] as? String == "Enter the 6-digit code")

        #expect(try await phone("kuvo/asks/\(signIn)", ["answer": "code", "code": "1"]).status == 400, "not what the card asks")
        #expect(try await phone("kuvo/asks/\(signIn)", ["answer": "signIn", "username": "me@example.com", "password": "hunter2"]).status == 200)
        if case .signIn(let username, let password)? = signedIn.got.first { #expect(username == "me@example.com" && password == "hunter2") } else { Issue.record("not signed in: \(signedIn.got)") }
        #expect(try await phone("kuvo/asks/\(code)", ["answer": "code", "code": " 123456 "]).status == 200)
        if case .code(let given)? = coded.got.first { #expect(given == "123456") } else { Issue.record("no code: \(coded.got)") }
        #expect(asks.asks.isEmpty)
        #expect(try await phone("kuvo/asks/\(code)", ["answer": "declined"]).status == 404, "answered already")
    }

    /// A machine gone: its cards go, this Mac's and other machines' stay.
    @Test func aMachineGoneTakesItsCards() {
        _ = ask(.code(prompt: "Code"), session: "ses_a", machine: "box")
        _ = ask(.code(prompt: "Code"), session: "ses_b", machine: "lab")
        asks.closeAll(on: "box")
        #expect(asks.asks.map(\.machine) == ["lab"])
    }

    /// An ask that doesn't say whose it is: the session that started asking on that machine.
    @Test func whoseAskItIs() {
        asks.askerName = { $0 == "ses_bot" ? "Pixel" : nil }
        asks.noteAsker("Pixel", session: "ses_bot", machine: "box")
        _ = ask(.action(instruction: "Solve the CAPTCHA"), session: nil, machine: "box")
        #expect(asks.asks.first?.session == "ses_bot")
        #expect(asks.asks.first?.asker == "Pixel")
    }
}
