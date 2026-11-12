import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// Whether a session is a chat, the same on the Mac and the phone (#571): as its box marks it,
/// whatever folder it's in and whether its box's chats folder is known; a session without the mark
/// (from a box from before the mark) by its folder, as before.
struct SessionChatTests {
    private func session(in folder: String, metadata: String = "{}") throws -> Session {
        let json = #"{"id": "ses_1", "projectID": "p", "title": "t", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1, "updated": 2}, "location": {"directory": "\#(folder)"}, "metadata": \#(metadata)}"#
        return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private let chats = "/home/me/.kuvo-code/chats", project = "/home/me/shop"

    @Test func aMarkedChatIsAChatWhereverItsBoxKeepsChatsAndWhetherThatsKnown() throws {
        let chat = try session(in: chats, metadata: #"{"kuvo": {"chat": true, "approval": "auto"}}"#)
        #expect(SessionChat.isMarked(chat))
        // Its box's chats folder not known here (#337: its `kuvo/info` wasn't answered).
        #expect(SessionChat.isChat(chat) { _ in false })
        #expect(SessionChat.isChat(chat) { $0 == chats })
    }

    @Test func aProjectsSessionIsntAChat() throws {
        let work = try session(in: project, metadata: #"{"kuvo": {"approval": "auto"}}"#)
        #expect(!SessionChat.isMarked(work))
        #expect(!SessionChat.isChat(work) { $0 == chats })
        #expect(!SessionChat.isChat(try session(in: project, metadata: #"{"kuvo": {"chat": false}}"#)) { $0 == chats })
    }

    @Test func anOldBoxsChatGoesByItsFolder() throws {
        // A box from before the mark marks nothing: its chats folder, as its `kuvo/info` named it.
        let chat = try session(in: chats)
        #expect(!SessionChat.isMarked(chat))
        #expect(SessionChat.isChat(chat) { $0 == chats })
        #expect(!SessionChat.isChat(try session(in: project)) { $0 == chats })
    }
}
