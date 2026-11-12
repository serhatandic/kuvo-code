import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// Whether a session is a chat, the same on the Mac and the phone (#571): as its box marks it,
/// whatever folder it's in and whether its box's chats folder is known; a mark left from where it
/// was before (moved into a project) is no mark; a session without the mark (from a box from
/// before the mark) goes by its folder, as before.
struct SessionChatTests {
    private func session(in folder: String, metadata: String = "{}") throws -> Session {
        let json = #"{"id": "ses_1", "projectID": "p", "title": "t", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1, "updated": 2}, "location": {"directory": "\#(folder)"}, "metadata": \#(metadata)}"#
        return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private let chats = "/home/me/.kuvo-code/chats", project = "/home/me/shop"

    @Test func aMarkedChatIsAChatWhetherItsBoxsChatsFolderIsKnownOrNot() throws {
        let chat = try session(in: chats, metadata: #"{"kuvo": {"chat": "/home/me/.kuvo-code/chats", "approval": "auto"}}"#)
        #expect(SessionChat.isMarked(chat, folder: chats))
        // Its box's chats folder not known here (#337: its `kuvo/info` wasn't answered).
        #expect(SessionChat.isChat(chat, folder: chats) { _ in false })
        #expect(SessionChat.isChat(chat, folder: chats) { $0 == chats })
    }

    @Test func aProjectsSessionIsntAChatNorOneMovedOutWithItsMarkLeft() throws {
        let work = try session(in: project, metadata: #"{"kuvo": {"approval": "auto"}}"#)
        #expect(!SessionChat.isMarked(work, folder: project))
        #expect(!SessionChat.isChat(work, folder: project) { $0 == chats })
        // Moved into a project where no box took its mark off (a box from before, its watch down).
        let moved = try session(in: project, metadata: #"{"kuvo": {"chat": "/home/me/.kuvo-code/chats"}}"#)
        #expect(!SessionChat.isMarked(moved, folder: project))
        #expect(!SessionChat.isChat(moved, folder: project) { $0 == chats })
    }

    @Test func anOldBoxsChatGoesByItsFolder() throws {
        // A box from before the mark marks nothing: its chats folder, as its `kuvo/info` named it.
        let chat = try session(in: chats)
        #expect(!SessionChat.isMarked(chat, folder: chats))
        #expect(SessionChat.isChat(chat, folder: chats) { $0 == chats })
        #expect(!SessionChat.isChat(try session(in: project), folder: project) { $0 == chats })
    }
}
