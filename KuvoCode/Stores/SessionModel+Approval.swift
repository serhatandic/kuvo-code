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

        enum CodingKeys: String, CodingKey { case key = "id", at, action, kind, decision, reason, by, why, held, approved, used }

        var id: String { key ?? "\(at)·\(action)" }
        var date: Date { Date(timeIntervalSince1970: at / 1000) }
        var refused: Bool { decision != "allowed" }
        /// Held back, and yours to approve now.
        var waiting: Bool { held == true && approved == nil }
    }
    var decisions: [Decision]
    var paused: Double?

    /// The latest first, as Decisions lists them.
    var latestFirst: [Decision] { decisions.reversed() }
    var waiting: [Decision] { decisions.filter(\.waiting) }
}

extension SessionModel {
    private var approvalRoute: String { "kuvo/sessions/\(id)/approval" }
    private var decisionsRoute: String { "kuvo/sessions/\(id)/decisions" }

    /// Reads its approval as its box shows it now. Quietly keeps what it had where its box can't
    /// say (an older box: what its rules say stands).
    func readApproval() async {
        guard let box = box() else { return }
        let asked = approvalChanges
        guard let shown = try? await box.value(ApprovalShown.self, "GET", approvalRoute) else { return }
        // One picked while this was on its way is newer.
        guard asked == approvalChanges else { return }
        approvalShown = shown
    }

    /// Reads Auto's decisions here, once at a time. Asked for again while one is on its way, or
    /// changed meanwhile, it reads once more: what it brought may be older than what's there.
    func readDecisions() {
        decisionsAsked += 1
        guard decisionsRead == nil, let box = box() else { return }
        decisionsRead = Task { [weak self] in
            while let self {
                let asked = decisionsAsked
                let read = try? await box.value(ReviewDecisions.self, "GET", decisionsRoute)
                if asked != decisionsAsked { continue }
                decisionsRead = nil
                if let read, decisions != read { decisions = read }
                return
            }
        }
    }

    /// Sets how much its agent does on its own, on its box. Full Access not confirmed on its
    /// computer yet: the composer asks (`confirmsFullAccess`), and `confirmFullAccess` sets it.
    func setApproval(_ approval: ToolApproval) {
        guard canReach, let box = box() else { return }
        approvalChanges += 1
        let before = approvalShown
        if var shown = approvalShown { shown.approval = approval; approvalShown = shown }
        ToolApproval.lastPicked = approval
        Task {
            do {
                approvalShown = try await box.value(ApprovalShown.self, "PUT", approvalRoute, body: ["approval": approval.rawValue])
                if approval == .auto { readDecisions() }
            } catch let refusal as BoxRefusal where refusal.status == 409 && refusal.reason == "fullAccessOff" {
                approvalShown = before
                confirmsFullAccess = true
            } catch {
                approvalShown = before
                failApproval(error)
            }
        }
    }

    /// You confirmed Full Access on its computer: switch it on there, then set it here.
    func confirmFullAccess() {
        confirmsFullAccess = false
        guard let box = box() else { return }
        Task {
            do {
                let (status, data) = try await box.send("PATCH", "kuvo/approval", body: try JSONEncoder().encode(["fullAccess": true]))
                guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
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

    /// The decisions held back since you last looked: the bar over the composer names these.
    var unseenHeld: [ReviewDecisions.Decision] {
        (decisions?.waiting ?? []).filter { !decisionsSeen.contains($0.id) }
    }

    /// Opens Auto's Decisions, where there are any to show: in Auto, or decided before.
    var decisionsToShow: (() -> Void)? {
        let decided = !(decisions?.decisions.isEmpty ?? true)
        guard approval == .auto || decided else { return nil }
        return { [weak self] in self?.openDecisions() }
    }

    /// Opening Decisions counts what's held back as seen.
    func openDecisions() {
        decisionsSeen.formUnion((decisions?.waiting ?? []).map(\.id))
        showsDecisions = true
        readDecisions()
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
