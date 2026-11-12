import Foundation
import OpenCodeKit

// Whether a session is a chat (a conversation of no project), the same on the Mac and the phone,
// as its box marks it (PROTOCOL.md, "Chats"): `kuvo.chat` in its metadata, naming the chats folder
// it's in, so a client never works it out from the session's folder. A mark naming another folder
// than the session's own is no mark: one moved out of the chats while no box could take it off.

public enum SessionChat {
    /// Whether its box marked `session` a chat where it is now: its mark names `folder`, its folder
    /// as its box names it (a Mac writes a machine's with the machine before it).
    public static func isMarked(_ session: Session, folder: String) -> Bool {
        session.metadata?["kuvo"]?["chat"]?.string == folder
    }

    /// Whether `session` is a chat: as its box marked it. One without the mark goes by the old-box
    /// path, `inChatsFolder` (whether its folder, `session.location.directory`, is its box's chats
    /// folder, as that box's `kuvo/info` named it): for a box from before `sessions.chat`, which
    /// marks nothing, and for a chat made a moment ago that its box hasn't marked yet.
    public static func isChat(_ session: Session, folder: String, inChatsFolder: (String) -> Bool) -> Bool {
        isMarked(session, folder: folder) || inChatsFolder(session.location.directory)
    }
}
