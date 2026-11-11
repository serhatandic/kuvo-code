import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// Every picture of a conversation, in order, wherever it is (#445): what the viewer goes back and
/// forth through on the Mac and the phone, opened on any of them. Your pictures and the agent's,
/// across all its messages; not a step's own screenshots, nor files that aren't pictures.
struct ConversationPicturesTests {
    private static let png = "data:image/png;base64,iVBORw0KGgo="

    /// A conversation as the engine sends it.
    private func messages(_ json: String) throws -> [Message] {
        try JSONDecoder().decode([Message].self, from: Data(json.utf8))
    }

    private static func step(_ id: String, at time: Int, _ content: String) -> String {
        #"{"id": "\#(id)", "type": "assistant", "agent": "build", "time": {"created": \#(time), "completed": \#(time + 1)}, "model": {"id": "m", "providerID": "p"}, "content": [\#(content)]}"#
    }

    private static func tool(_ id: String, _ name: String, input: String, status: String = "completed", content: String = #"[{"type": "text", "text": "Done."}]"#) -> String {
        #"{"type": "tool", "id": "\#(id)", "name": "\#(name)", "state": {"status": "\#(status)", "input": \#(input), "content": \#(content), "error": {"type": "x", "message": "No."}}}"#
    }

    @Test func everyPictureAcrossItsMessagesInOrder() throws {
        let made = #"[{"type": "file", "uri": "file:///tmp/made.png", "mime": "image/png", "name": "made"}]"#
        let page = #"[{"type": "text", "text": "Took it."}, {"type": "file", "uri": "\#(Self.png)", "mime": "image/png"}]"#
        let conversation = try messages("""
        [
          {"id": "msg_1", "type": "user", "time": {"created": 1}, "text": "Here's how it looks. [Image 1] [Image 2]",
           "files": [{"mime": "image/png", "name": "before.png", "source": {"type": "uri", "uri": "\(Self.png)"}},
                     {"mime": "text/plain", "name": "notes.txt", "data": "aGk="},
                     {"mime": "application/octet-stream", "name": "after.jpg", "source": {"type": "uri", "uri": "file:///tmp/after.jpg"}}]},
          \(Self.step("msg_2", at: 2, [
              Self.tool("call_look", "kuvo-browser_browser_screenshot", input: #"{}"#, content: page),
              #"{"type": "text", "text": "Here it is now:"}"#,
              Self.tool("call_shown", "kuvo-browser_show_file", input: #"{"path": "/p/shots/light.png", "caption": "Light"}"#),
              Self.tool("call_doc", "kuvo-browser_show_file", input: #"{"path": "/p/README.md"}"#),
              Self.tool("call_page", "kuvo-browser_browser_screenshot", input: #"{"show": true}"#, content: page),
              Self.tool("call_failed", "generate_image", input: #"{"prompt": "a cat"}"#, status: "error"),
          ].joined(separator: ","))),
          {"id": "msg_3", "type": "idle", "time": {"created": 3}, "outcome": "succeeded"},
          {"id": "msg_4", "type": "user", "time": {"created": 4}, "text": "And make one.", "files": [{"mime": "image/jpeg", "name": "idea.jpg", "data": "/9j/"}]},
          \(Self.step("msg_5", at: 5, Self.tool("call_made", "generate_image", input: #"{"prompt": "a cat"}"#, content: made)))
        ]
        """)
        let pictures = ConversationPictures.all(in: conversation)
        #expect(pictures.map(\.id) == ["msg_1#0", "msg_1#2", "call_shown-shown", "call_page-1", "msg_4#0", "call_made-0"])
        #expect(pictures.map(\.name) == ["before.png", "after.jpg", "light.png", nil, "idea.jpg", "made"])
        #expect(pictures.map(\.message) == ["msg_1", "msg_1", "msg_2", "msg_2", "msg_4", "msg_5"])
        #expect(pictures[2].source == .shown(path: "/p/shots/light.png"))
        #expect(pictures[2].caption == "Light")
        #expect(pictures[5].source == .file(uri: "file:///tmp/made.png", mime: "image/png"))
        #expect(ConversationPictures.index(of: "msg_4#0", in: pictures) == 4)
    }

    @Test func aGroupChatsPicturesAreItsBotsStepsInOrder() throws {
        let made = #"[{"type": "file", "uri": "file:///tmp/made.png", "mime": "image/png"}]"#
        let steps = try JSONDecoder().decode([Message.ToolCall].self, from: Data("""
        [\(Self.tool("call_read", "read", input: #"{"path": "/p/a.swift"}"#)),
         \(Self.tool("call_shown", "kuvo-browser_show_file", input: #"{"path": "/p/shots/dark.png"}"#)),
         \(Self.tool("call_made", "generate_image", input: #"{"prompt": "a cat"}"#, content: made))]
        """.utf8))
        let pictures = ConversationPictures.pictures(of: steps, in: "grp_msg_2")
        #expect(pictures.map(\.id) == ["call_shown-shown", "call_made-0"])
        #expect(pictures.allSatisfy { $0.message == "grp_msg_2" })
        #expect(pictures.map(\.step) == ["call_shown", "call_made"])
    }

    @Test func aConversationWithNoPicturesHasNone() throws {
        let conversation = try messages("""
        [{"id": "msg_1", "type": "user", "time": {"created": 1}, "text": "Hi"},
         \(Self.step("msg_2", at: 2, #"{"type": "text", "text": "Hello."}"#))]
        """)
        #expect(ConversationPictures.all(in: conversation).isEmpty)
    }
}
