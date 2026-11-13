import Foundation
import OpenCodeKit

/// A conversation's decisions by Auto's reviewer, as its box keeps them
/// (`GET kuvo/sessions/<id>/decisions`, PROTOCOL.md "Auto's reviewer").
struct ReviewDecisions: Decodable, Equatable {
    struct Decision: Decodable, Equatable, Identifiable {
        var key: String?
        var at: Double
        var action: String
        var kind: String
        var decision: String
        var reason: String
        var by: String
        var why: String?
        var held: Bool?
        var approved: Double?
        var used: Double?
        /// A folder Auto allowed edits in for the rest of the conversation, and when you took it back.
        var place: String?
        var revoked: Double?

        enum CodingKeys: String, CodingKey { case key = "id", at, action, kind, decision, reason, by, why, held, approved, used, place, revoked }

        var id: String { key ?? "\(at)·\(action)" }
        var date: Date { Date(timeIntervalSince1970: at / 1000) }
        var refused: Bool { decision != "allowed" }
        /// Held back, and yours to approve now.
        var waiting: Bool { held == true && approved == nil }
        /// A folder Auto allows edits in now, which you can take back.
        var revocable: Bool { place != nil && revoked == nil }
    }
    var decisions: [Decision]
    var paused: Double?
    /// When you last looked at them, on any client: what's held back after it is news.
    var seen: Double?

    /// The latest first. (Not the box's note that one you approved ran: its own line says so.)
    var latestFirst: [Decision] { decisions.reversed().filter { $0.by != "you" } }
    var waiting: [Decision] { decisions.filter(\.waiting) }

    /// As Decisions lists them: what's yours to approve first, then the folders it allows edits in
    /// (yours to revoke), then the rest, the latest first; past `limit` of the rest, how many more
    /// there are (what waits on you, and those folders, always show).
    func listed(limit: Int?) -> (rows: [Decision], more: Int) {
        let rest = latestFirst.filter { !$0.waiting && !$0.revocable }
        let shown = limit.map { rest.prefix($0) } ?? rest[...]
        return (latestFirst.filter(\.waiting) + latestFirst.filter(\.revocable) + shown, rest.count - shown.count)
    }

    /// How many it holds back, and of what it allowed (or you approved after), how many of each kind.
    struct Counts: Equatable {
        var heldBack = 0, edits = 0, reads = 0, commands = 0, other = 0
    }

    var counts: Counts {
        // (A folder allowed is the edit that allowed it, counted once.)
        latestFirst.filter { $0.place == nil }.reduce(into: Counts()) { counts, each in
            switch (each.refused, each.kind, each.action.hasPrefix("Read ")) {
            case (true, _, _) where each.approved == nil: counts.heldBack += 1
            case (_, "command", _): counts.commands += 1
            case (_, "file", true): counts.reads += 1
            case (_, "file", false): counts.edits += 1
            default: counts.other += 1
            }
        }
    }
}

extension SessionModel {
    private var approvalRoute: String { "kuvo/sessions/\(id)/approval" }
    private var decisionsRoute: String { "kuvo/sessions/\(id)/decisions" }

    /// Reads its approval as its box shows it now. Quietly keeps what it had where its box can't
    /// say (an older box: what its rules say stands). Not while a pick is on its way: what it
    /// brings may be from before the box took it.
    func readApproval() async {
        guard approvalsPending == 0, let box = box() else { return }
        let asked = approvalChanges
        guard let shown = try? await box.value(ApprovalShown.self, "GET", approvalRoute) else { return }
        guard asked == approvalChanges, approvalsPending == 0 else { return }
        approvalShown = shown
    }

    /// Reads Auto's decisions here, once at a time. Asked for again while one is on its way, or
    /// changed meanwhile, it reads once more: what it brought may be older than what's there.
    func readDecisions() {
        decisionsAsked += 1
        guard decisionsRead == nil else { return }
        guard let box = box() else {
            decisionsUnread = decisions == nil
            return
        }
        decisionsUnread = false
        decisionsRead = Task { [weak self] in
            while let self {
                let asked = decisionsAsked
                let read = try? await box.value(ReviewDecisions.self, "GET", decisionsRoute)
                if asked != decisionsAsked { continue }
                decisionsRead = nil
                if let read, decisions != read { decisions = read }
                decisionsUnread = decisions == nil
                return
            }
        }
    }

    /// Sets how much its agent does on its own, on its box. Full Access not confirmed on its
    /// computer yet: the composer asks (`confirmsFullAccess`), and `confirmFullAccess` sets it.
    /// Picks quickly one after another: the last one's answer is what shows, and once they're all
    /// answered it's read again, as the box may have taken them in another order.
    func setApproval(_ approval: ToolApproval) {
        guard canReach, let box = box() else { return }
        switch approvalShown?.option(approval)?.unavailable?.reason {
        case nil: break
        case "fullAccessOff": confirmsFullAccess = true; return
        // Not to be had here, as its box says (a bot's on a box before 0.9.188): shown, not picked.
        default: return
        }
        approvalChanges += 1
        approvalsPending += 1
        let pick = approvalChanges
        let before = approvalShown
        if var shown = approvalShown { shown.approval = approval; approvalShown = shown }
        Task {
            var latest: Bool { pick == approvalChanges }
            var refused = false
            do {
                let shown = try await box.value(ApprovalShown.self, "PUT", approvalRoute, body: ["approval": approval.rawValue])
                if latest {
                    approvalShown = shown
                    if approval == .auto { readDecisions() }
                }
            } catch let refusal as BoxRefusal where refusal.status == 409 && refusal.reason == "fullAccessOff" {
                if latest {
                    approvalShown = before
                    confirmsFullAccess = true
                }
            } catch let refusal as BoxRefusal where refusal.status == 409 && refusal.reason == "bot" {
                // Not to be had here (a bot's on a box before 0.9.188), picked before its options
                // were read: its menu shows why once read again.
                if latest { approvalShown = before }
                refused = true
            } catch {
                if latest {
                    approvalShown = before
                    failApproval(error)
                }
            }
            approvalsPending -= 1
            guard approvalsPending == 0 else { return }
            let overlapped = approvalBurst > 1
            approvalBurst = 0
            if overlapped || refused { await readApproval() }
        }
        approvalBurst += 1
    }

    /// You confirmed Full Access on its computer: switch it on there (for every conversation and
    /// new one there to see), then set it here.
    func confirmFullAccess(in workspace: Workspace) {
        confirmsFullAccess = false
        Task {
            do {
                try await workspace.allowFullAccess(for: session.location.directory)
                if var shown = approvalShown, let index = shown.options.firstIndex(where: { $0.approval == .fullAccess }) {
                    shown.options[index].unavailable = nil
                    approvalShown = shown
                }
                setApproval(.fullAccess)
            } catch {
                failApproval(error)
            }
        }
    }

    /// Approves one Auto's reviewer held back, once; a paused conversation goes on.
    func approveDecision(_ decision: ReviewDecisions.Decision) {
        guard let key = decision.key else { return }
        postDecisions(["approve": AnyEncodable(key)])
    }

    /// Takes back a folder Auto allowed edits in: each change there is judged again.
    func revokePlace(_ decision: ReviewDecisions.Decision) {
        guard let key = decision.key, decision.revocable else { return }
        postDecisions(["revoke": AnyEncodable(key)])
    }

    /// Lets Auto go on where it paused after too many refusals.
    func resumeAuto() { postDecisions(["resume": true]) }

    private func postDecisions(_ body: [String: AnyEncodable]) {
        guard let box = box() else { return }
        Task {
            do {
                let changed = try await box.value(ReviewDecisions.self, "POST", decisionsRoute, body: body)
                // A read on its way started before this: it reads again rather than showing the old.
                decisionsAsked += 1
                decisions = changed
            } catch {
                // Gone or approved elsewhere: show what's there now.
                readDecisions()
                if (error as? BoxRefusal)?.status != 404 { failApproval(error) }
            }
        }
    }

    /// The decisions held back since you last looked, here or on another client: the bar over the
    /// composer names these.
    var unseenHeld: [ReviewDecisions.Decision] {
        (decisions?.waiting ?? []).filter { $0.at > decisions?.seen ?? 0 && !decisionsSeen.contains($0.id) }
    }

    /// Opens Auto's Decisions, where there are any to show: in Auto, or decided before.
    var decisionsToShow: (() -> Void)? {
        let decided = !(decisions?.decisions.isEmpty ?? true)
        guard approval == .auto || decided else { return nil }
        return { [weak self] in self?.openDecisions() }
    }

    #if DEBUG
    /// KUVO_DEMO_AUTO: in Auto with sample decisions and no box behind it (`held`, `paused`,
    /// `decisions`, `fullAccess`, or `unread`: Decisions with its computer out of reach).
    func showAutoSample(_ state: String) {
        box = { nil }
        let now = Date.now.timeIntervalSince1970 * 1000
        func option(_ approval: ToolApproval) -> ApprovalShown.Option {
            ApprovalShown.Option(approval: approval, unavailable: approval == .fullAccess ? .init(reason: "fullAccessOff", why: "Confirm it once on this computer first.") : nil)
        }
        approvalShown = ApprovalShown(approval: .auto, effective: .auto, options: ToolApproval.allCases.map(option))
        typealias Decision = ReviewDecisions.Decision
        var sample = [
            Decision(key: "rd_1", at: now - 600_000, action: "npm install", kind: "command", decision: "allowed", reason: "Installs the project's own dependencies, which the task needs.", by: "model"),
            Decision(key: "rd_2", at: now - 420_000, action: "brew install jq", kind: "command", decision: "allowed", reason: "A tool the build script calls.", by: "model"),
            Decision(key: "rd_3", at: now - 300_000, action: "~/.zshrc", kind: "file", decision: "refused", reason: "Changes your shell's start-up for every project, which you didn't ask for.", by: "model", why: "reviewer", held: true, approved: now - 200_000),
            Decision(key: "rd_4", at: now - 60_000, action: "git push --force origin main", kind: "command", decision: "refused", reason: "It rewrites main on GitHub, which you didn't ask for.", by: "model", why: "reviewer", held: true),
        ]
        switch state {
        case "unread":
            decisions = nil
            openDecisions()
            return
        case "paused":
            sample.append(Decision(key: "rd_5", at: now - 30_000, action: "cat ~/.ssh/id_ed25519", kind: "command", decision: "refused", reason: "Reads your SSH key.", by: "model", why: "paused", held: true))
            decisions = ReviewDecisions(decisions: sample, paused: now - 30_000)
        default:
            decisions = ReviewDecisions(decisions: sample)
        }
        if state == "decisions" { openDecisions() }
        if state == "fullAccess" { confirmsFullAccess = true }
    }
    #endif

    /// Opening Decisions counts what's held back as seen, here and, through its box, on every client.
    func openDecisions() {
        decisionsSeen.formUnion((decisions?.waiting ?? []).map(\.id))
        showsDecisions = true
        guard let box = box() else { return readDecisions() }
        Task {
            // (A box from before `approval.seen` keeps none: seen here, until the app quits.)
            if let changed = try? await box.value(ReviewDecisions.self, "POST", decisionsRoute, body: ["seen": true]) {
                decisionsAsked += 1
                decisions = changed
            } else {
                readDecisions()
            }
        }
    }
}

/// A value of any of the few kinds a route's body takes here.
struct AnyEncodable: Encodable, ExpressibleByStringLiteral, ExpressibleByBooleanLiteral {
    private let encode: (any Encoder) throws -> Void
    init(_ value: some Encodable) { encode = value.encode }
    init(stringLiteral value: String) { self.init(value) }
    init(booleanLiteral value: Bool) { self.init(value) }
    func encode(to encoder: any Encoder) throws { try encode(encoder) }
}
