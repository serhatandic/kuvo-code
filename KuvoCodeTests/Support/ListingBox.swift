import Foundation
import KuvoLink
@testable import KuvoCode

/// This Mac's box's session list for a test (`kuvo/sessions/list`, PROTOCOL.md "Session lists"),
/// for one whose engine is a stand-in with no events for a real box to follow: what each of the
/// stand-in's sessions is and where it's filed, worked out as the box does
/// (Packages/Box/src/link/lists/rule.ts, and held to the same vectors: ListingBoxTests), sent whole
/// now and again each time the test says (`push`), as a box tells a change.
nonisolated final class ListingBox: BoxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: @Sendable () -> [[String: Any]]
    private var place: Place
    private var followers: [UUID: AsyncThrowingStream<LinkResponsePart, Error>.Continuation] = [:]
    private var seq = 0

    /// What the box knows beside its sessions.
    struct Place {
        var chats: String
        var bots = ""
        var botSessions: Set<String> = []
        /// The project each folder is filed under, where it isn't its own (`worktrees` in `kuvo/projects`).
        var filed: [String: String] = [:]
        /// Its project list's (not removed) folders, with their names.
        var projects: [String: String?] = [:]
    }

    init(chats: String, sessions: @escaping @Sendable () -> [[String: Any]] = { [] }) {
        self.sessions = sessions
        place = Place(chats: chats)
    }

    /// The engine's sessions it lists, from now on.
    func list(_ sessions: @escaping @Sendable () -> [[String: Any]]) {
        lock.withLock { self.sessions = sessions }
    }

    /// What the box knows changed.
    func change(_ change: (inout Place) -> Void) {
        lock.withLock { change(&place) }
        push()
    }

    /// The list sent again, whole, to those following it.
    func push() {
        let (line, followers) = lock.withLock { (lineNow(), Array(followers.values)) }
        for follower in followers { follower.yield(.body(line)) }
    }

    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
        let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
        return AsyncThrowingStream { continuation in
            guard path == "kuvo/sessions/list" || path == "kuvo/sessions/list/events" else {
                continuation.yield(.head(status: 404, headers: [:]))
                return continuation.finish()
            }
            continuation.yield(.head(status: 200, headers: ["content-type": path.hasSuffix("/events") ? "application/x-ndjson" : "application/json"]))
            let id = UUID()
            let line = lock.withLock { () -> Data in
                if path.hasSuffix("/events") { followers[id] = continuation }
                return lineNow()
            }
            continuation.onTermination = { [weak self] _ in self?.lock.withLock { self?.followers[id] = nil } }
            continuation.yield(.body(line))
            if !path.hasSuffix("/events") { continuation.finish() }
        }
    }

    /// The list now, whole (under the lock).
    private func lineNow() -> Data {
        seq += 1
        let listed = Self.list(sessions(), place: place)
        var line = (try? JSONSerialization.data(withJSONObject: ["at": "test.\(seq)", "full": true, "sessions": listed.sessions, "projects": listed.projects])) ?? Data()
        line.append(UInt8(ascii: "\n"))
        return line
    }

    /// Each session's facts and the projects shown, as the box works them out.
    static func list(_ sessions: [[String: Any]], place: Place, running: Set<String> = [], asked: [String: Double] = [:], away: Set<String> = []) -> (sessions: [String: [String: Any]], projects: [String: [String: Any]]) {
        var facts: [String: [String: Any]] = [:]
        var newest: [String: Double] = [:]
        for session in sessions {
            guard let id = session["id"] as? String, facts[id] == nil else { continue }
            let directory = (session["location"] as? [String: Any])?["directory"] as? String ?? ""
            let metadata = session["metadata"] as? [String: Any] ?? [:]
            let kuvo = metadata["kuvo"] as? [String: Any] ?? [:]
            let time = session["time"] as? [String: Any] ?? [:]
            let updated = (time["updated"] as? NSNumber)?.doubleValue ?? 0
            var one: [String: Any] = ["directory": directory, "created": (time["created"] as? NSNumber)?.doubleValue ?? 0, "updated": updated]
            if let title = session["title"] as? String, !title.isEmpty { one["title"] = title }
            let archived = time["archived"] != nil || metadata["kuvo.archived"] as? Bool == true || kuvo["archived"] as? Bool == true
            if metadata["kuvo.pinned"] as? Bool == true { one["pinned"] = true }
            if archived { one["archived"] = true }
            if running.contains(id) { one["running"] = true }
            if let since = asked[id] { one["asked"] = since }
            if away.contains(id) { one["away"] = true }
            if let parent = session["parentID"] as? String, !parent.isEmpty {
                one["kind"] = "subagent"
                one["parent"] = parent
            } else if kuvo["seat"] != nil {
                one["kind"] = "seat"
            } else if kuvo["engineFor"] != nil || kuvo["reviewPart"] != nil {
                one["kind"] = "hidden"
            } else if place.botSessions.contains(id) || (!place.bots.isEmpty && directory.hasPrefix(place.bots + "/")) {
                one["kind"] = "bot"
            } else if kuvo["chat"] as? String == directory || directory == place.chats {
                one["kind"] = "chat"
            } else {
                var project = place.filed[directory] ?? directory
                if place.filed[directory] == nil, let mark = kuvo["filed"] as? [String: Any], mark["folder"] as? String == directory,
                   let marked = mark["project"] as? String, !marked.isEmpty, marked != directory {
                    project = place.filed[marked] ?? marked
                }
                one["kind"] = "project"
                one["project"] = project
                if !archived { newest[project] = max(newest[project] ?? 0, updated) }
            }
            facts[id] = one
        }
        var projects: [String: [String: Any]] = [:]
        for (directory, name) in place.projects { projects[directory] = name.map { ["name": $0] } ?? [:] }
        for (directory, updated) in newest { projects[directory, default: [:]]["updated"] = updated }
        return (facts, projects)
    }
}
