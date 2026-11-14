import ClientSandbox
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// Settings › Permissions › Also Allowed, as this Mac reads and changes it (PROTOCOL.md, "Sandbox"):
/// every rule on a computer at once, each by whose it is (a project, a bot's own folder, the chats,
/// whose one rule is every chat's), a folder added for a bot or the chats by whose it is, and one
/// removed leaving the rest. The box is stood in for at its routes, keeping rules as it does.
@MainActor
@Suite(.serialized) struct AlsoAllowedTests {
    let sandboxes = Sandboxes()

    init() { TestEnvironment.prepare() }

    /// A box keeping its rules: `owners` false answers as a box from before them (each answer its
    /// project's, by its folder, and no owners).
    nonisolated final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var rules: [[String: Any]]
        let owners: Bool
        private(set) var sent: [LinkRequest] = []

        init(rules: [[String: Any]], owners: Bool = true) {
            self.rules = rules
            self.owners = owners
        }

        func answer(_ request: LinkRequest) -> Data {
            lock.withLock {
                sent.append(request)
                let query = request.path.split(separator: "?").dropFirst().first.map(String.init) ?? ""
                var of: String?
                if request.method == "POST" {
                    let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
                    var project = body["project"] as? String
                    var owner: [String: Any]?
                    if let given = body["owner"] as? [String: String] {
                        project = given["kind"] == "chats" ? "/box/chats" : "/box/bots/\(given["id"] ?? "")/workspace"
                        owner = given["kind"] == "chats" ? ["kind": "chats", "name": "Chats"] : ["kind": "bot", "id": given["id"] ?? "", "name": "Scout"]
                    }
                    var rule: [String: Any] = ["id": "al_\(rules.count + 10)", "project": project ?? "", "kind": "write", "path": body["path"] as? String ?? "", "at": 1_793_275_200_000, "by": "Mac"]
                    rule["owner"] = owner ?? ["kind": "project", "name": URL(filePath: project ?? "").lastPathComponent]
                    rules.append(rule)
                    of = project
                } else if request.method == "DELETE" {
                    let id = String(request.path.split(separator: "?")[0].split(separator: "/").last ?? "")
                    of = rules.first { $0["id"] as? String == id }?["project"] as? String
                    rules.removeAll { $0["id"] as? String == id }
                }
                // (A GET with no project lists every rule, from a box before owners too; `?all` is theirs.)
                let all = request.method == "GET" || (owners && query == "all")
                var listed = all ? rules : rules.filter { $0["project"] as? String == of }
                if !owners { listed = listed.map { $0.filter { $0.key != "owner" } } }
                var answer: [String: Any] = ["allowed": listed]
                if all && owners { answer["owners"] = [["kind": "bot", "id": "bot_scout", "name": "Scout"], ["kind": "chats", "name": "Chats"]] }
                return (try? JSONSerialization.data(withJSONObject: answer)) ?? Data()
            }
        }
    }

    /// An answer the box makes as the request comes, held back until the test lets it go: one that
    /// comes after a later change's.
    nonisolated final class Held: @unchecked Sendable {
        let path: String
        private let lock = NSLock()
        private var hasArrived = false, isReleased = false
        private var arrivals: [CheckedContinuation<Void, Never>] = [], releases: [CheckedContinuation<Void, Never>] = []

        init(_ path: String) { self.path = path }

        func arrived() {
            let waiting = lock.withLock { hasArrived = true; defer { arrivals = [] }; return arrivals }
            waiting.forEach { $0.resume() }
        }

        func arrival() async {
            await withCheckedContinuation { continuation in
                let now = lock.withLock { hasArrived || { arrivals.append(continuation); return false }() }
                if now { continuation.resume() }
            }
        }

        func release() {
            let waiting = lock.withLock { isReleased = true; defer { releases = [] }; return releases }
            waiting.forEach { $0.resume() }
        }

        func released() async {
            await withCheckedContinuation { continuation in
                let now = lock.withLock { isReleased || { releases.append(continuation); return false }() }
                if now { continuation.resume() }
            }
        }
    }

    private func standIn(_ box: Box, holding held: Held? = nil) {
        let client = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            let body = box.answer(request)
            return AsyncThrowingStream { continuation in
                Task {
                    if let held, held.path == request.path {
                        held.arrived()
                        await held.released()
                    }
                    continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                    continuation.finish()
                }
            }
        })
        sandboxes.client = { $0 == BoxClient.mac ? client : nil }
    }

    private static let kept: [[String: Any]] = [
        ["id": "al_1", "project": "/box/chats", "kind": "write", "path": "/Users/me/Downloads/exports", "at": 1_793_275_200_000, "owner": ["kind": "chats", "name": "Chats"]],
        ["id": "al_2", "project": "/Users/me/kuvo-ai", "kind": "write", "path": "/Users/me/kuvo-web/dist", "at": 1_793_275_200_000, "owner": ["kind": "project", "name": "kuvo-ai"]],
        ["id": "al_3", "project": "/box/bots/bot_scout/workspace", "kind": "write", "path": "/Users/me/Reports", "at": 1_793_275_200_000, "owner": ["kind": "bot", "id": "bot_scout", "name": "Scout"]],
    ]

    @Test func everyRuleShowsByWhoseItIsAndAFolderAddedForABotOrTheChatsLandsUnderIt() async throws {
        let box = Box(rules: Self.kept)
        standIn(box)
        try await sandboxes.readAllowed(on: BoxClient.mac)
        let names = ["/Users/me/kuvo-ai": "Kuvo AI"]
        var groups = AlsoAllowed.groups(sandboxes.allowed[BoxClient.mac]?.allowed ?? [], names: names, order: ["/Users/me/kuvo-ai"])
        #expect(groups.map(\.name) == ["Kuvo AI", "Scout", "Chats"], "a bot's and the chats' rules show beside the projects'")
        #expect(groups.map(\.caption) == ["project", "its own folder", "every chat"])
        #expect(sandboxes.allowed[BoxClient.mac]?.owners?.map(\.name) == ["Scout", "Chats"], "whom else a folder can be added for")

        // Added for the chats, by whose it is: under Chats, with the rest kept.
        try await sandboxes.allow("/Users/me/Desktop/receipts", for: .chats, on: BoxClient.mac)
        let added = try #require(box.sent.last)
        #expect(added.method == "POST" && added.path == "kuvo/sandbox/allowed?all")
        let body = try #require(try JSONSerialization.jsonObject(with: added.body) as? [String: Any])
        #expect(body["owner"] as? [String: String] == ["kind": "chats"] && body["project"] == nil)
        groups = AlsoAllowed.groups(sandboxes.allowed[BoxClient.mac]?.allowed ?? [], names: names, order: ["/Users/me/kuvo-ai"])
        #expect(groups.last?.rules.map(\.path) == ["/Users/me/Downloads/exports", "/Users/me/Desktop/receipts"])
        #expect(groups.count == 3)

        // Removed, Scout's goes and the others stay.
        let scouts = try #require(groups.first { $0.owner.kind == .bot }?.rules.first)
        try await sandboxes.remove(scouts, on: BoxClient.mac)
        #expect(box.sent.last?.path == "kuvo/sandbox/allowed/al_3?all")
        groups = AlsoAllowed.groups(sandboxes.allowed[BoxClient.mac]?.allowed ?? [], names: names, order: ["/Users/me/kuvo-ai"])
        #expect(groups.map(\.name) == ["Kuvo AI", "Chats"])
    }

    @Test func aBoxFromBeforeOwnersStillListsAndKeepsEveryRuleAfterAnAdd() async throws {
        let box = Box(rules: Self.kept, owners: false)
        standIn(box)
        try await sandboxes.readAllowed(on: BoxClient.mac)
        #expect(sandboxes.allowed[BoxClient.mac]?.allowed.count == 3)
        #expect(sandboxes.allowed[BoxClient.mac]?.owners == nil, "only its projects can be added for")
        // Its answer to an add is that project's only: everything is read again.
        try await sandboxes.allow("/Users/me/cache", in: "/Users/me/kuvo-ai", on: BoxClient.mac)
        #expect(sandboxes.allowed[BoxClient.mac]?.allowed.count == 4)
        #expect(box.sent.last?.method == "GET")
        // A removal's answer is its project's only too: the rest stay.
        let first = try #require(sandboxes.allowed[BoxClient.mac]?.allowed.first)
        try await sandboxes.remove(first, on: BoxClient.mac)
        #expect(sandboxes.allowed[BoxClient.mac]?.allowed.count == 3)
    }

    @Test func twoFoldersRemovedQuicklyStayRemovedWhicheverAnswerComesLast() async throws {
        let box = Box(rules: Self.kept)
        // The first removal's answer, which still lists the second folder, comes after the second's.
        let held = Held("kuvo/sandbox/allowed/al_1?all")
        standIn(box, holding: held)
        try await sandboxes.readAllowed(on: BoxClient.mac)
        let rules = try #require(sandboxes.allowed[BoxClient.mac]?.allowed)
        let first = Task { try await sandboxes.remove(rules[0], on: BoxClient.mac) }
        await held.arrival()
        try await sandboxes.remove(rules[2], on: BoxClient.mac)
        held.release()
        try await first.value
        #expect(sandboxes.allowed[BoxClient.mac]?.allowed.map(\.id) == ["al_2"])
    }
}
