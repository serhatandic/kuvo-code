import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// Branch Backups, as its sheet shows them (PROTOCOL.md, "Branch backups"): each backup's time and
/// what taking it back would bring back now, Take Back saying in plain words what came back with
/// the list read again after it, a repository whose `.git` is gone made again, and what a box
/// refused in its own words. The box is stood in for at its routes.
@MainActor
@Suite(.serialized) struct BranchBackupsTests {
    /// 2026-11-03 14:32 UTC, a Tuesday.
    private let now = Date(timeIntervalSince1970: 1_793_716_320)
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_GB")
        return calendar
    }

    private func backup(_ id: String, hoursAgo: Double = 0, gone: [String] = [], moved: [String] = [], stashesGone: Int = 0) -> String {
        let at = (now.timeIntervalSince1970 - hoursAgo * 3600) * 1000
        func list(_ names: [String]) -> String { "[" + names.map { "\"\($0)\"" }.joined(separator: ",") + "]" }
        return #"{"id":"\#(id)","at":\#(at),"head":"main","branches":6,"stashes":2,"gone":\#(list(gone)),"moved":\#(list(moved)),"stashesGone":\#(stashesGone)}"#
    }

    private func listing(exists: Bool = true, _ backups: [String]) -> String {
        #"{"repository":"/Users/me/my project","exists":\#(exists),"backups":[\#(backups.joined(separator: ","))]}"#
    }

    private func rows(_ backups: BranchBackups) throws -> [String] {
        guard case .listed(let listing) = backups.shown else { throw TestFailure("not listed: \(backups.shown)") }
        return listing.backups.map { BranchBackups.when($0.date, now: now, calendar: calendar) + " — " + BranchBackups.detailLine($0, exists: listing.exists) }
    }

    @Test func eachBackupSaysWhenAndWhatTakingItBackBringsBack() async throws {
        let box = StandIn(listings: [listing([
            backup("b1", hoursAgo: 0),
            backup("b2", hoursAgo: 1, gone: ["feature/search"], moved: ["main"], stashesGone: 1),
            backup("b3", hoursAgo: 20, gone: ["feature/search", "fix/timer", "spike/parser"]),
            backup("b4", hoursAgo: 24 * 3, moved: ["main", "dev"]),
            backup("b5", hoursAgo: 24 * 30, stashesGone: 2),
        ])])
        let backups = BranchBackups(box: box.client, folder: "/Users/me/my project")
        await backups.load()

        #expect(box.requests.first?.path == "kuvo/git/backups?folder=/Users/me/my%20project")
        #expect(try rows(backups) == [
            "Today, 14:32 — 6 branches, 2 stashes · nothing to bring back",
            "Today, 13:32 — feature/search deleted since · main moved · 1 stash gone",
            "Yesterday, 18:32 — feature/search, fix/timer and 1 more deleted since",
            "Saturday, 14:32 — main and dev moved",
            "4 Oct, 14:32 — 2 stashes gone",
        ])
        guard case .listed(let listing) = backups.shown else { return }
        #expect(listing.backups.map { BranchBackups.bringsBack($0, exists: true) } == [false, true, true, true, true],
                "one with nothing to bring back can't be taken back")
        #expect(BranchBackups.detail(listing.backups[1], exists: true).map(\.warns) == [true, false, false], "only the deleted branches are marked")
    }

    @Test func takeBackSaysWhatCameBackAndTheListIsReadAgain() async throws {
        let box = StandIn(listings: [
            listing([backup("b2", gone: ["feature/search"], moved: ["main"], stashesGone: 1)]),
            listing([backup("b2", moved: ["main"])]),
        ], restore: (200, #"{"remade":false,"branches":[{"name":"feature/search","as":"feature/search"},{"name":"main","as":"main-restored-20261103-1432"}],"stashes":1}"#))
        let backups = BranchBackups(box: box.client, folder: "/Users/me/my project")
        await backups.load()
        guard case .listed(let before) = backups.shown, let taken = before.backups.first else { throw TestFailure("not listed") }

        await backups.takeBack(taken)

        let restore = try #require(box.requests.first { $0.method == "POST" })
        #expect(restore.path == "kuvo/git/backups/restore")
        #expect(try JSONSerialization.jsonObject(with: restore.body) as? [String: String] == ["folder": "/Users/me/my project", "id": "b2"])
        #expect(backups.outcome == .restored("feature/search is back. main’s earlier place is on main-restored-20261103-1432, so you can reset to it. 1 stash is back on the list.", missed: []))
        #expect(try rows(backups) == ["Today, 14:32 — main moved"], "what it would bring back now")
        #expect(backups.restoring == nil)
    }

    @Test func aRepositoryWhoseGitIsGoneIsMadeAgain() async throws {
        let box = StandIn(listings: [listing(exists: false, [backup("b1", gone: ["main", "feature/search"])])],
                          restore: (200, #"{"remade":true,"branches":[{"name":"main","as":"main"},{"name":"feature/search","as":"feature/search"},{"name":"","as":"detached-restored-20261103-1432"}],"stashes":2,"missed":["The remote origin"]}"#))
        let backups = BranchBackups(box: box.client, folder: "/Users/me/my project")
        await backups.load()
        #expect(try rows(backups) == ["Today, 14:32 — 6 branches, 2 stashes"], "all of it comes back")
        guard case .listed(let listing) = backups.shown, let taken = listing.backups.first else { throw TestFailure("not listed") }
        #expect(BranchBackups.bringsBack(taken, exists: false))

        await backups.takeBack(taken)
        #expect(backups.outcome == .restored("The repository is back, around your files as they are. main and feature/search are back. The checkout on no branch is on detached-restored-20261103-1432. 2 stashes are back on the list.",
                                             missed: ["The remote origin"]))
    }

    @Test func whatTheBoxRefusedIsSaidInItsWords() async throws {
        let box = StandIn(listings: [listing([backup("b1", gone: ["main"])])],
                          restore: (409, #"{"message":"The .git there can't be read."}"#))
        let backups = BranchBackups(box: box.client, folder: "/Users/me/my project")
        await backups.load()
        guard case .listed(let listing) = backups.shown, let taken = listing.backups.first else { throw TestFailure("not listed") }
        await backups.takeBack(taken)
        #expect(backups.outcome == .failed("The .git there can't be read."))
        #expect(try rows(backups) == ["Today, 14:32 — main deleted since"], "the list stays")

        // A box from before backups.
        let old = BranchBackups(box: StandIn(listings: [], listStatus: 404).client, folder: "/Users/me/my project")
        await old.load()
        #expect(old.shown == .failed("This computer’s Kuvo Code doesn’t keep branch backups yet. Update it, then try again."))
    }
}

/// A box's backups routes: each read answers the next listing (the last one again after them).
private nonisolated final class StandIn: @unchecked Sendable {
    private let lock = NSLock()
    private var listings: [String]
    private let listStatus: Int
    private let restore: (Int, String)
    private var sent: [LinkRequest] = []

    init(listings: [String], listStatus: Int = 200, restore: (Int, String) = (500, #"{"message":"No."}"#)) {
        self.listings = listings
        self.listStatus = listStatus
        self.restore = restore
    }

    var requests: [LinkRequest] { lock.withLock { sent } }

    private func answer(_ request: LinkRequest) -> (Int, String) {
        lock.withLock {
            sent.append(request)
            if request.method == "POST" { return restore }
            guard listStatus == 200 else { return (listStatus, #"{"message":"Not found."}"#) }
            return (200, listings.count > 1 ? listings.removeFirst() : listings.first ?? "{}")
        }
    }

    @MainActor var client: BoxClient {
        BoxClient(box: BoxClient.mac, transport: LocalBox { [self] request in
            let (status, body) = answer(request)
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data(body.utf8)))
                continuation.finish()
            }
        })
    }
}
