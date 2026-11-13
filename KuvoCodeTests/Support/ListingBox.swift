import Foundation
import KuvoLink
@testable import KuvoCode

/// This Mac's box's session list for a test (`kuvo/sessions/list`, PROTOCOL.md "Session lists"),
/// for one whose engine is a stand-in with no events for a real box to follow: what each of the
/// stand-in's sessions is and where it's filed, worked out as the box does
/// (Packages/Box/src/link/lists/rule.ts, and held to the same vectors: ListingBoxTests), sent whole
/// now and again each time the test says (`push`), as a box tells a change. With a real box beside
/// it (`rest`), that box answers everything else, and says where its folders are filed (its
/// `kuvo/projects`), as the box's own list would go by.
nonisolated final class ListingBox: BoxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: @Sendable () -> [[String: Any]]
    private var place: Place
    private var followers: [UUID: AsyncThrowingStream<LinkResponsePart, Error>.Continuation] = [:]
    private var seq = 0
    /// Every other request, where a test's box answers the rest (a real one's, say).
    private var rest: BoxTransport?
    /// Lines worked out one after another, so they're told in order.
    private var lastLine: Task<Void, Never>?
    /// Its own: each line's `at` starts with it, so a test knows a line is this box's (not a list
    /// an earlier test left kept).
    let tag = "test" + UUID().uuidString.prefix(8).filter(\.isLetter)

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

    init(chats: String, rest: BoxTransport? = nil, sessions: @escaping @Sendable () -> [[String: Any]] = { [] }) {
        self.sessions = sessions
        self.rest = rest
        place = Place(chats: chats)
    }

    /// The engine's sessions it lists, from now on.
    func list(_ sessions: @escaping @Sendable () -> [[String: Any]]) {
        lock.withLock { self.sessions = sessions }
    }

    /// A real box beside it, from now on: it answers the rest, and says where folders are filed.
    func answer(rest: BoxTransport) {
        lock.withLock { self.rest = rest }
    }

    /// What the box knows changed.
    func change(_ change: (inout Place) -> Void) {
        lock.withLock { change(&place) }
        push()
    }

    /// The list sent again, whole, to those following it, after any line before it.
    func push() {
        inTurn { line in
            for follower in self.lock.withLock({ Array(self.followers.values) }) { follower.yield(.body(line)) }
            // (A test waiting on what it says looks again: one that changed nothing changes no state it observes.)
            TestPulse.beat()
        }
    }

    /// A line worked out after the one before it, then `then`.
    private func inTurn(_ then: @escaping @Sendable (Data) -> Void) {
        lock.withLock {
            let before = lastLine
            lastLine = Task {
                await before?.value
                then(await self.lineNow())
            }
        }
    }

    func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
        let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
        return AsyncThrowingStream { continuation in
            guard path == "kuvo/sessions/list" || path == "kuvo/sessions/list/events" else {
                if let rest = lock.withLock({ rest }) {
                    let task = Task {
                        do {
                            for try await part in rest.send(request) { continuation.yield(part) }
                            continuation.finish()
                        } catch {
                            continuation.finish(throwing: error)
                        }
                    }
                    continuation.onTermination = { _ in task.cancel() }
                    return
                }
                continuation.yield(.head(status: 404, headers: [:]))
                return continuation.finish()
            }
            let streams = path.hasSuffix("/events")
            continuation.yield(.head(status: 200, headers: ["content-type": streams ? "application/x-ndjson" : "application/json"]))
            let id = UUID()
            continuation.onTermination = { [weak self] _ in self?.lock.withLock { self?.followers[id] = nil } }
            inTurn { [weak self] line in
                // (Following from its first line: each one after goes to it too.)
                if streams { self?.lock.withLock { self?.followers[id] = continuation } }
                continuation.yield(.body(line))
                if !streams { continuation.finish() }
                TestPulse.beat()
            }
        }
    }

    /// The list now, whole: where folders are filed as the real box beside it says, if there is one.
    private func lineNow() async -> Data {
        var place = lock.withLock { self.place }
        if let rest = lock.withLock({ rest }), let listed = await Self.projects(from: rest) {
            place.filed = listed.worktrees ?? [:]
            place.projects = Dictionary(listed.projects.filter { $0.removed != true }.map { ($0.directory, $0.name) }) { first, _ in first }
        }
        let (at, sessions) = lock.withLock { () -> (Int, [[String: Any]]) in
            seq += 1
            return (seq, self.sessions())
        }
        let listed = Self.list(sessions, place: place)
        var line = (try? JSONSerialization.data(withJSONObject: ["at": "\(tag).\(at)", "full": true, "sessions": listed.sessions, "projects": listed.projects])) ?? Data()
        line.append(UInt8(ascii: "\n"))
        return line
    }

    private struct Projects: Decodable {
        struct Project: Decodable {
            var directory: String
            var name: String?
            var removed: Bool?
        }
        var projects: [Project]
        var worktrees: [String: String]?
    }

    /// A real box's projects and worktrees, as it answers `kuvo/projects`.
    private static func projects(from box: BoxTransport) async -> Projects? {
        var data = Data()
        var status = 0
        do {
            for try await part in box.send(LinkRequest(method: "GET", path: "kuvo/projects")) {
                switch part {
                case .head(status: let code, headers: _): status = code
                case .body(let chunk): data.append(chunk)
                }
            }
        } catch {
            return nil
        }
        return status == 200 ? try? JSONDecoder().decode(Projects.self, from: data) : nil
    }

    /// `workspace` following this as this Mac's box's list, as AppModel has it follow its box's
    /// (`boxes` answering the rest as `rest` does), once it has this box's first line: how to stop.
    @MainActor func follow(_ workspace: Workspace) async throws -> Task<Void, Never> {
        let listing = self
        workspace.boxes = { id in id == BoxClient.mac ? BoxClient(box: BoxClient.mac, transport: listing) : nil }
        let following = Task { await workspace.followSessionList(on: BoxClient.mac) }
        try await until { workspace.listCursor(BoxClient.mac)?.hasPrefix(listing.tag) == true }
        return following
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
