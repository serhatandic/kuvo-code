import Foundation
import OpenCodeKit

// What a client shows of a computer's sessions, the same in both apps: which are kept out of
// sight, which have news you haven't read (and what reading one reads with it), and what a search
// of what was said couldn't reach.

/// Sessions a client keeps out of sight.
public enum HiddenSessions {
    /// A group chat's seat (its chat shows what matters), a run the engine keeps for a coding
    /// agents' session (that session shows what it does), or a review's part, read in a session of
    /// its own (its review shows it, and opens it).
    public static func isHidden(_ session: Session) -> Bool {
        session.metadata?["kuvo"]?["seat"] != nil || session.metadata?["kuvo"]?["engineFor"] != nil || session.metadata?["kuvo"]?["reviewPart"] != nil
    }
}

/// Conversations you started from another one, which show under it: a branch ("Branch from
/// here") or a handoff's ("/handoff"), as their box marks them. A subagent's session isn't one:
/// the agent started it, and it shows in the conversation it works for.
public enum Branches {
    /// `started`: one an agent started from it (its start_session tool).
    public enum Kind: Sendable, Equatable { case branch, handoff, started }

    /// The conversation `session` came from, and how.
    public static func origin(of session: Session) -> (id: String, kind: Kind)? {
        let kuvo = session.metadata?["kuvo"]
        if let id = kuvo?["branchedFrom"]?.string, !id.isEmpty { return (id, .branch) }
        if let id = kuvo?["handoffFrom"]?.string, !id.isEmpty { return (id, .handoff) }
        if let id = kuvo?["startedBy"]?.string, !id.isEmpty { return (id, .started) }
        return nil
    }

    /// The session a start_session step started, as its result names it ("… (address ses_…)"), on
    /// a Mac or a machine: its row in the conversation opens it.
    public static func started(byStep result: String) -> String? {
        guard let range = result.range(of: #"\(address (ses_[A-Za-z0-9]+)\)"#, options: .regularExpression) else { return nil }
        return String(result[range].dropFirst("(address ".count).dropLast())
    }

    /// The session a start_session step started while the step still waits for its first answer
    /// (its result, with the address, comes only then): one an agent started once the step began,
    /// with the title the step gave it if it gave one, the first of them. So its row opens it at once.
    public static func started(byWaiting step: Message.ToolCall, among sessions: [Session]) -> String? {
        guard case .running(let input, _) = step.state, let began = step.time?.created ?? step.time?.ran else { return nil }
        let title = input["title"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        return sessions
            .filter { origin(of: $0)?.kind == .started && $0.time.created >= began - 1_000 }
            .filter { title?.isEmpty != false || $0.title == title }
            .min { $0.time.created < $1.time.created }?.id
    }

    /// The lead on another of your computers that started `session`, as its box marks it
    /// (`kuvo.lead`: the lead's name and its computer, as that box names it); nil for one started
    /// on the computer it's on.
    public static func lead(of session: Session) -> (name: String, computer: String)? {
        guard let lead = session.metadata?["kuvo"]?["lead"], let name = lead["name"]?.string, !name.isEmpty,
              let computer = lead["box"]?.string, !computer.isEmpty else { return nil }
        return (name, computer)
    }

    /// The hint for a conversation that came from `title`'s; started by a lead on another
    /// computer that isn't listed here, from that lead there: "Started from Foreman on Mini".
    public static func hint(of session: Session, from title: String?) -> String? {
        guard let origin = origin(of: session) else { return nil }
        if let title { return hint(origin.kind, from: title) }
        if origin.kind == .started, let lead = lead(of: session) { return hint(.started, from: "\(lead.name) on \(lead.computer)") }
        return hint(origin.kind, from: "another conversation")
    }

    /// What a session's row tells VoiceOver of where it came from (`title`: that conversation's,
    /// where it's listed here): nested under it, that; at the top, only a lead on another computer
    /// that isn't listed here, since nothing above it says so.
    public static func rowHint(of session: Session, nested: Bool, from title: String?) -> String {
        if nested { return hint(of: session, from: title) ?? "" }
        guard title == nil, origin(of: session)?.kind == .started, lead(of: session) != nil else { return "" }
        return hint(of: session, from: nil) ?? ""
    }

    /// What a session's row shows at its end when a lead on another computer started it and that
    /// lead isn't listed here (`title` nil), at the top of the list: "from Mini". Pointed at, or
    /// read by VoiceOver, its `rowHint` says the whole.
    public static func tail(of session: Session, nested: Bool, from title: String?) -> String? {
        guard !nested, title == nil, origin(of: session)?.kind == .started, let lead = lead(of: session) else { return nil }
        return "from " + lead.computer
    }

    /// The sidebar's hint for a conversation that came from `title`'s.
    public static func hint(_ kind: Kind, from title: String) -> String {
        switch kind {
        case .branch: "Branched from " + title
        case .handoff: "Carried on from " + title
        case .started: "Started from " + title
        }
    }

    /// `sessions`, each under the one it came from when that one is among them too (all the way
    /// up, never in a loop): those at the top, in their order, and those under each, newest first.
    public static func tree(_ sessions: [Session]) -> (top: [Session], under: [String: [Session]]) {
        let listed = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func parent(of session: Session) -> String? {
            guard let origin = origin(of: session)?.id, origin != session.id, listed[origin] != nil else { return nil }
            // One whose chain comes back round to it stays at the top.
            var seen: Set<String> = [session.id]
            var above: String? = origin
            while let id = above {
                guard seen.insert(id).inserted else { return nil }
                above = listed[id].flatMap { Branches.origin(of: $0)?.id }.flatMap { listed[$0] != nil ? $0 : nil }
            }
            return origin
        }
        var top: [Session] = []
        var under: [String: [Session]] = [:]
        for session in sessions {
            if let parent = parent(of: session) { under[parent, default: []].append(session) } else { top.append(session) }
        }
        return (top, under.mapValues { $0.sorted { $0.time.created > $1.time.created } })
    }

    /// Everything under `id` in `under` (a tree's), its own and theirs: what a folded row stands
    /// for, so one waiting on you or done while it's folded shows on that row.
    public static func all(under id: String, in under: [String: [Session]]) -> [Session] {
        var found: [Session] = []
        var seen: Set<String> = [id]
        var next = under[id] ?? []
        while let session = next.popLast() {
            guard seen.insert(session.id).inserted else { continue }
            found.append(session)
            next += under[session.id] ?? []
        }
        return found
    }

    /// `tree(sessions)` for a list that shows the latest first, and maybe only the first few:
    /// those at the top by the latest of each and what's under it, so one at work under an older
    /// one keeps it in view.
    public static func latestFirst(_ sessions: [Session]) -> (top: [Session], under: [String: [Session]]) {
        let (top, under) = tree(sessions)
        func latest(_ session: Session, depth: Int = 0) -> Milliseconds {
            guard depth < 20 else { return session.time.updated }
            return ([session.time.updated] + (under[session.id] ?? []).map { latest($0, depth: depth + 1) }).max() ?? session.time.updated
        }
        let ranked = top.map { ($0, latest($0)) }.enumerated().sorted { $0.element.1 != $1.element.1 ? $0.element.1 > $1.element.1 : $0.offset < $1.offset }
        return (ranked.map(\.element.0), under)
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
    /// Each once, though a box lists them in a loop.
    public static func hasNew(under id: String, in subSessions: [String: [Session]], rootViewed: (Session) -> Milliseconds?) -> Bool {
        var seen: Set<String> = [id]
        var next = subSessions[id] ?? []
        while let sub = next.popLast() {
            guard seen.insert(sub.id).inserted else { continue }
            if isNew(sub, rootViewed: rootViewed(sub)) { return true }
            next += subSessions[sub.id] ?? []
        }
        return false
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
        // Each once, though a box lists them in a loop.
        var seen: Set<String> = [id]
        func readUnder(_ id: String) {
            for (index, child) in (subSessions[id] ?? []).enumerated() {
                if child.isUnread, let idle = child.time.idle {
                    subSessions[id]?[index].time.viewed = idle
                    if !read.contains(where: { $0.id == child.id }) { read.append((child.id, idle)) }
                }
                if seen.insert(child.id).inserted { readUnder(child.id) }
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

/// Who a subagent's task is from, as its conversation's first message says it: the agent that
/// started it.
public enum SubagentStarter {
    /// `parent`: the session that started it, where it's known. A subagent's own subagent is from
    /// that subagent, by its task, as the conversation's header names it; anything else from the
    /// main agent.
    public static func name(of parent: Session?) -> String {
        guard let parent, parent.parentID != nil else { return "the main agent" }
        let task = parent.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return task.isEmpty ? "a subagent" : task
    }
}
