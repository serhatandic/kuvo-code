import Foundation
import Testing
@testable import OpenCodeKit

/// A box can run a newer engine than this app knows (a machine keeps one; a phone talks to boxes
/// at their own versions). A word of the engine's this app doesn't know is read as the closest one
/// it does, never by losing the list it's in.
struct NewerEngineTests {
    @Test func aSessionsListWithAWordThisAppDoesntKnowIsReadWhole() throws {
        let json = """
        [{"id":"ses_1","projectID":"p","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
          "time":{"created":1,"updated":1},"location":{"directory":"/p"},"outcome":"timed-out",
          "permissions":[{"action":"shell","resource":"*","effect":"deny-forever"}]},
         {"id":"ses_2","projectID":"p","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
          "time":{"created":1,"updated":1},"location":{"directory":"/p"},"outcome":"failed"}]
        """
        let sessions = try JSONDecoder().decode([Session].self, from: Data(json.utf8))
        #expect(sessions.map(\.id) == ["ses_1", "ses_2"])
        #expect(sessions[0].outcome == .unknown("timed-out"))
        #expect(sessions[1].outcome == .failed)
        // A rule of a kind it doesn't know holds back what it matches, never asks (which Approve
        // All would make an Allow).
        let effect = try #require(sessions[0].permissions?.first?.effect)
        #expect(effect == .unknown("deny-forever") && effect.holdsBack)
        // Both go back as they came, sent again or carried to another computer.
        let again = String(decoding: try JSONEncoder().encode(sessions[0]), as: UTF8.self)
        #expect(again.contains(#""outcome":"timed-out""#) && again.contains(#""effect":"deny-forever""#))
    }

    @Test func aConversationAndAQueueWithAWordThisAppDoesntKnowAreReadWhole() throws {
        let messages = """
        [{"id":"msg_1","time":{"created":1},"type":"idle","outcome":"timed-out"},
         {"id":"msg_2","time":{"created":2},"text":"next","type":"user"}]
        """
        let read = try JSONDecoder().decode([Message].self, from: Data(messages.utf8))
        #expect(read.count == 2)
        let inbox = """
        [{"id":"in_1","sessionID":"ses_1","type":"user","payload":{"text":"one"},"delivery":"after-lunch"},
         {"id":"in_2","sessionID":"ses_1","type":"user","payload":{"text":"two"},"delivery":"steer"}]
        """
        let items = try JSONDecoder().decode([InboxItem].self, from: Data(inbox.utf8))
        #expect(items.map(\.delivery) == [.queue, .steer], "one it doesn't know waits its turn")
    }
}
