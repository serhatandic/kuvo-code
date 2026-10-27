import Foundation
import OpenCodeKit

// What a client shows of a computer's sessions, the same in both apps: which are kept out of
// sight, which have news you haven't read (and what reading one reads with it), and what a search
// of what was said couldn't reach.

/// Sessions a client keeps out of sight.
public enum HiddenSessions {
    /// A group chat's seat (its chat shows what matters), or a run the engine keeps for a coding
    /// agents' session (that session shows what it does).
    public static func isHidden(_ session: Session) -> Bool {
        session.metadata?["kuvo"]?["seat"] != nil || session.metadata?["kuvo"]?["engineFor"] != nil
    }
}

/// What you haven't read, and what reading reads.
public enum ReadState {
    /// A sub-session (a subagent's session) finished since you were last in it, or in the session
    /// at the top of its chain, which shows what it found (`rootViewed`, when that one was last
    /// read). One from before sub-sessions were marked read has the second only.
    public static func isNew(_ sub: Session, rootViewed: Milliseconds?) -> Bool {
        guard sub.isUnread, let idle = sub.time.idle else { return false }
        return (rootViewed ?? 0) < idle
    }

    /// One of `id`'s sub-sessions, or theirs, is new. `subSessions`: each session's, by the one
    /// that started them; `rootViewed`: when a sub-session's top session was last read.
    public static func hasNew(under id: String, in subSessions: [String: [Session]], rootViewed: (Session) -> Milliseconds?) -> Bool {
        (subSessions[id] ?? []).contains { isNew($0, rootViewed: rootViewed($0)) || hasNew(under: $0.id, in: subSessions, rootViewed: rootViewed) }
    }

    /// Reads `id`: itself (one of `sessions`, or a sub-session, under `parent(id)`), and its
    /// sub-sessions that finished, all the way down, whose findings show in its conversation. Marks
    /// them read in place, and returns each, with what it's read up to, for its box to be told.
    public static func read(_ id: String, sessions: inout [Session], subSessions: inout [String: [Session]], parent: (String) -> String?) -> [(id: String, idle: Milliseconds)] {
        var read: [(id: String, idle: Milliseconds)] = []
        if let index = sessions.firstIndex(where: { $0.id == id }), sessions[index].isUnread, let idle = sessions[index].time.idle {
            sessions[index].time.viewed = idle
            read.append((id, idle))
        }
        if let above = parent(id), let index = subSessions[above]?.firstIndex(where: { $0.id == id }),
           let sub = subSessions[above]?[index], sub.isUnread, let idle = sub.time.idle {
            subSessions[above]?[index].time.viewed = idle
            if !read.contains(where: { $0.id == id }) { read.append((id, idle)) }
        }
        func readUnder(_ id: String) {
            for (index, child) in (subSessions[id] ?? []).enumerated() {
                if child.isUnread, let idle = child.time.idle {
                    subSessions[id]?[index].time.viewed = idle
                    read.append((child.id, idle))
                }
                readUnder(child.id)
            }
        }
        readUnder(id)
        return read
    }

    /// Read elsewhere, as its box says (`session.viewed`): `id`, among `sessions` or a sub-session,
    /// read up to `idle`, when that's later than here. Whether anything changed.
    @discardableResult
    public static func sawRead(_ id: String, upTo idle: Milliseconds, sessions: inout [Session], subSessions: inout [String: [Session]], parent: (String) -> String?) -> Bool {
        var changed = false
        if let index = sessions.firstIndex(where: { $0.id == id }), idle > (sessions[index].time.viewed ?? 0) {
            sessions[index].time.viewed = idle
            changed = true
        }
        if let above = parent(id), let index = subSessions[above]?.firstIndex(where: { $0.id == id }), idle > (subSessions[above]?[index].time.viewed ?? 0) {
            subSessions[above]?[index].time.viewed = idle
            changed = true
        }
        return changed
    }
}

/// Why a computer's conversations couldn't be searched (`kuvo/search`), said the same in both apps.
public enum UnsearchedReason: Sendable, Equatable {
    /// It isn't connected (a machine away, a computer the phone can't reach).
    case notConnected
    /// It was asked and didn't answer (its engine starting, an error).
    case didntAnswer
    /// Its box is from before it could search what was said.
    case needsUpdate

    /// The line a client shows for `computer`.
    public func line(for computer: String) -> String {
        switch self {
        case .notConnected: "\(computer) isn’t connected, so its conversations weren’t searched."
        case .didntAnswer: "\(computer) didn’t answer, so its conversations weren’t searched."
        case .needsUpdate: "\(computer) needs an update to search what was said in its conversations."
        }
    }
}
