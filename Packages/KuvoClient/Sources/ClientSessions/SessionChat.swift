import Foundation
import OpenCodeKit

// Whether a session is a chat (a conversation of no project), the same on the Mac and the phone,
// as its box marks it (PROTOCOL.md, "Chats"): `kuvo.chat: true` in its metadata, on every session
// in its box's chats folder and no other, so a client never works it out from the session's folder.

public enum SessionChat {
    /// Whether its box marked `session` a chat.
    public static func isMarked(_ session: Session) -> Bool {
        session.metadata?["kuvo"]?["chat"]?.bool == true
    }

    /// Whether `session` is a chat: as its box marked it. One without the mark goes by the old-box
    /// path, `inChatsFolder` (whether its folder is its box's chats folder, as that box's
    /// `kuvo/info` named it): for a box from before `sessions.chat`, which marks nothing, and for a
    /// chat made a moment ago that its box hasn't marked yet.
    public static func isChat(_ session: Session, inChatsFolder: (String) -> Bool) -> Bool {
        isMarked(session) || inChatsFolder(session.location.directory)
    }
}
