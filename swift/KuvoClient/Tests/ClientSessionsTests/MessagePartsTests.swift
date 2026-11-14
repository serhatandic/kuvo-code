import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A message's parts as both apps draw them (PROTOCOL.md, "A message's parts"): read from what the
/// box keeps with a message, or reads of one from before, and sent as the fields the box writes the
/// agent's text from, held to Packages/KuvoLink/Vectors/message-parts.json, which the box's
/// message-parts.test.ts holds the box to.
@Suite(.serialized)
struct MessagePartsTests {
    nonisolated(unsafe) static let vectors: [String: Any] = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../../KuvoLink/Vectors/message-parts.json")
        return (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any] ?? [:]
    }()

    static func cases(_ name: String) -> [[String: Any]] { vectors[name] as? [[String: Any]] ?? [] }

    /// `value` as JSON, keys sorted.
    static func json(_ value: Any) -> String {
        String(data: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data(), encoding: .utf8) ?? ""
    }

    static func json<T: Encodable>(encoding value: T) -> String {
        let data = (try? JSONEncoder().encode(value)) ?? Data()
        return json((try? JSONSerialization.jsonObject(with: data)) ?? [:])
    }

    @Test func everyCaseHasParts() {
        #expect(Self.cases("compose").count >= 20)
        #expect(Self.cases("read").count >= 10)
    }

    @Test func partsKeptWithAMessageReadAsTheBoxWroteThem() throws {
        for each in Self.cases("compose") + Self.cases("read") { try partsRead(each) }
    }

    private func partsRead(_ each: [String: Any]) throws {
        let parts = try #require(each["parts"])
        let metadata = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: ["kuvo": ["parts": parts], "other": 1]))
        let read = try #require(MessageParts.kept(in: metadata), "\(each["about"] ?? "")")
        // Read and written again, the same parts.
        #expect(Self.json(encoding: read) == Self.json(parts), "\(each["about"] ?? "")")
        #expect(MessageParts.of(id: "msg_x", text: "the text as written", metadata: metadata) == read)
    }

    @Test func aClientSendsTheFieldsTheBoxTakes() throws {
        for each in Self.cases("compose") { try sends(each) }
    }

    private func sends(_ each: [String: Any]) throws {
        let fields = try #require(each["fields"] as? [String: Any])
        let comments = (fields["comments"] as? [[String: Any]] ?? []).map {
            MessageParts.Comment(file: $0["file"] as! String, line: $0["line"] as! Int, side: $0["side"] as! String == "old" ? .old : .new, snippet: $0["snippet"] as! String, text: $0["text"] as! String)
        }
        let notes = fields["notes"] as? [String: [String]] ?? [:]
        let sending = MessageParts.Sending(words: fields["words"] as! String, keyword: fields["keyword"] as? String, widget: fields["widget"] as? String, comments: comments,
                                           named: fields["named"] as? [String] ?? [], notes: .init(included: notes["included"] ?? [], paths: notes["paths"] ?? [], unsent: notes["unsent"] ?? []))
        #expect(Self.json(encoding: sending) == Self.json(fields), "\(each["about"] ?? "")")
    }

    @Test func aMessageFromBeforeIsItsTextUntilItsBoxReadsIt() async throws {
        MessageParts.forgetRead()
        defer { MessageParts.forgetRead() }
        let read = Self.cases("read")
        let messages: [(id: String, text: String, metadata: JSONValue?)] = read.enumerated().map { ("msg_\($0.offset)", $0.element["text"] as! String, nil) }
        let kept = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: ["kuvo": ["parts": ["words": "kept"]]]))
        // One that keeps its parts isn't asked for.
        let unread = MessageParts.unread(messages + [("msg_kept", "kept", kept)])
        #expect(unread.map(\.id) == messages.map(\.id))
        #expect(MessageParts.of(id: "msg_0", text: messages[0].text, metadata: nil).words == messages[0].text)
        final class Asked: @unchecked Sendable { var texts: [[String]] = [] }
        let asked = Asked()
        let answer = try JSONSerialization.data(withJSONObject: ["parts": read.map { $0["parts"]! }])
        let any = await MessageParts.read(unread) { body in
            let texts = (try JSONSerialization.jsonObject(with: body) as? [String: Any])?["texts"] as? [String] ?? []
            asked.texts.append(texts)
            return (200, answer)
        }
        #expect(any)
        #expect(asked.texts == [read.map { $0["text"] as! String }])
        for (index, each) in read.enumerated() {
            #expect(Self.json(encoding: MessageParts.of(id: "msg_\(index)", text: each["text"] as! String, metadata: nil)) == Self.json(each["parts"]!))
        }
        #expect(MessageParts.unread(messages).isEmpty)
    }

    /// What a box read is for the text it read: another message under the same id is read anew.
    @Test func whatWasReadIsForItsOwnText() async throws {
        MessageParts.forgetRead()
        defer { MessageParts.forgetRead() }
        let answer = try JSONSerialization.data(withJSONObject: ["parts": [["words": "Hi", "keyword": "/plan"]]])
        #expect(await MessageParts.read([("msg_a", "Hi\n\n<sent-with>…")]) { _ in (200, answer) })
        #expect(MessageParts.of(id: "msg_a", text: "Hi\n\n<sent-with>…", metadata: nil).keyword == "/plan")
        #expect(MessageParts.of(id: "msg_a", text: "Something else", metadata: nil) == MessageParts(words: "Something else"))
        #expect(MessageParts.unread([("msg_a", "Something else", nil)]).map(\.id) == ["msg_a"])
    }

    @Test func aBoxThatCantSayLeavesThemToAskAgain() async {
        MessageParts.forgetRead()
        defer { MessageParts.forgetRead() }
        let any = await MessageParts.read([("msg_a", "Hi")]) { _ in (503, Data()) }
        #expect(!any)
        #expect(MessageParts.unread([("msg_a", "Hi", nil)]).map(\.id) == ["msg_a"])
    }

    @Test func aMessageShownBeforeItsBoxHasItShowsItsParts() throws {
        let sending = MessageParts.Sending(words: "  Have a look \n", keyword: "/plan", comments: [.init(file: "a.js", line: 4, side: .new, snippet: "x()", text: "Here")], notes: .init(paths: ["/x/y.txt"]))
        let metadata = MessageParts.keeping(sending.parts, in: .object(["kuvo": .object(["wake": .bool(true)])]))
        let shown = try #require(MessageParts.kept(in: metadata))
        #expect(shown.words == "Have a look")
        #expect(shown.keyword == "/plan")
        #expect(shown.paths == ["/x/y.txt"])
        #expect(metadata?["kuvo"]?["wake"] == .bool(true))
    }
}
