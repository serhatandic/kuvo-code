import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A new session and a move, asked of a box the same way by the Mac and the phone (PROTOCOL.md,
/// `kuvo/sessions`): a chat goes to the box's own chats folder, not a folder of the client's; only
/// what's chosen is sent, so the box decides the rest (its default approval, the project's folders);
/// and what it says back, the session and the worktree made for it, is read as it sends it, also
/// from a box that leaves either out.
struct SessionStartTests {
    private func sent(_ asked: some Encodable) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(asked)) as? [String: Any])
    }

    @Test func onlyWhatsChosenIsAsked() throws {
        #expect(try sent(SessionStart.Asked(folder: "/home/me/chats", chat: true)) as NSDictionary == ["chat": true] as NSDictionary)
        #expect(try sent(SessionStart.Asked(folder: "/home/me/shop")) as NSDictionary == ["folder": "/home/me/shop"] as NSDictionary)
        let all = try sent(SessionStart.Asked(folder: "/home/me/shop", worktree: true, agent: "plan", model: ModelRef(id: "gpt-5", providerID: "openai", variant: "high"), approval: "auto", autopilot: true))
        #expect(all["worktree"] as? Bool == true && all["agent"] as? String == "plan" && all["approval"] as? String == "auto" && all["autopilot"] as? Bool == true)
        #expect(all["model"] as? NSDictionary == ["providerID": "openai", "id": "gpt-5", "variant": "high"] as NSDictionary)
        #expect(all["task"] == nil)
    }

    @Test func whatTheBoxSaysBackIsRead() throws {
        let session = #"{"id": "ses_1", "projectID": "p", "title": "New session", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1, "updated": 2}, "location": {"directory": "/home/me/trees/otter"}}"#
        let full = #"{"session": "ses_1", "title": null, "folder": "/home/me/trees/otter", "project": "shop", "got": "askFirst", "info": \#(session), "worktree": {"project": "/home/me/shop", "root": "/home/me/trees/otter", "folder": "/home/me/trees/otter", "branch": "kuvo/otter", "base": "main"}}"#
        let started = try JSONDecoder().decode(SessionStart.Started.self, from: Data(full.utf8))
        #expect(started.info?.location.directory == "/home/me/trees/otter")
        #expect(started.worktree?.branch == "kuvo/otter" && started.got == "askFirst")
        let bare = try JSONDecoder().decode(SessionStart.Started.self, from: Data(#"{"session": "ses_2", "title": null, "folder": "/home/me/shop", "project": "shop"}"#.utf8))
        #expect(bare.session == "ses_2" && bare.info == nil && bare.worktree == nil)
        // A session as a newer engine lists it, that this client can't read: made all the same.
        let newer = try JSONDecoder().decode(SessionStart.Started.self, from: Data(#"{"session": "ses_3", "title": null, "folder": "/home/me/shop", "project": "shop", "info": {"id": "ses_3", "time": "now"}}"#.utf8))
        #expect(newer.session == "ses_3" && newer.info == nil)
        let movedNewer = try JSONDecoder().decode(SessionMove.Moved.self, from: Data(#"{"session": "ses_3", "directory": "/home/me/shop", "info": {"id": "ses_3", "time": "now"}}"#.utf8))
        #expect(movedNewer.directory == "/home/me/shop" && movedNewer.info == nil)

        let moved = try JSONDecoder().decode(SessionMove.Moved.self, from: Data(#"{"session": "ses_1", "directory": "/home/me/shop", "info": \#(session)}"#.utf8))
        #expect(moved.info?.id == "ses_1")
        #expect(SessionMove.route("ses_1") == "kuvo/sessions/ses_1/move")
    }
}
