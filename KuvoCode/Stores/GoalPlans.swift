import ClientSessions
import Foundation
import KuvoLink
import Observation

/// Bots' goals and their plans (`kuvo/work/goals`, PROTOCOL.md "Work › Goals"), on this Mac's box and
/// each machine's: the card a bot puts to you, the goal under way with a track per step, what waits
/// for you, and its digest and report. Followed as they change on each box, shown on the bot's
/// conversation, and answered there, on its box. What waits for you, the digest and the report are
/// told here quietly as they come (each box tells your phones itself).
@MainActor @Observable
final class GoalPlans {
    @ObservationIgnored weak var app: AppModel?
    /// The goals on each box, by its id ("mac", or a machine's).
    private(set) var plans: [String: [GoalPlan]] = [:]
    /// Those being answered now, by id: their cards and bars wait.
    private(set) var answering: Set<String> = []
    /// Goals that are over and that you put away, by id: their bar goes (until the app starts again;
    /// the box lets them go after a day).
    var putAway: Set<String> = []
    /// A box's client (a test's own); the app's otherwise.
    @ObservationIgnored var boxes: ((String) -> BoxClient)?
    /// The conversations whose card waits for you, for their marks in the sidebar.
    @ObservationIgnored var onChange: ((Set<String>) -> Void)?
    /// A machine connected and ready, which its goals are read from (a test's own answer).
    @ObservationIgnored var connected: ((String) -> Bool)?
    /// What's been told here: waiting items by id, digests by their time, reports by goal.
    @ObservationIgnored private var told: Set<String> = []
    /// Boxes read at least once: what one had as it was first read was news before this Mac was there.
    @ObservationIgnored private var seen: Set<String> = []
    /// Each box's follow now, so one that ended (a reconnect) leaves the next one's goals alone.
    @ObservationIgnored private var following: [String: UUID] = [:]

    /// `box`'s client: a test's own, or the app's.
    func client(_ box: String) -> BoxClient? {
        boxes?(box) ?? app?.box(box)
    }

    /// The goal of the bot whose conversation is `session`, with its box: its latest, while it's
    /// proposed or running, or ended within the day.
    func plan(for session: String) -> (box: String, plan: GoalPlan)? {
        for (box, plans) in all {
            if let plan = plans.first(where: { $0.session == session }) { return (box, plan) }
        }
        return nil
    }

    private var all: [String: [GoalPlan]] {
        var all = plans
        #if DEBUG
        if let demo { all[BoxClient.mac] = [demo] + (all[BoxClient.mac] ?? []).filter { $0.session != demo.session } }
        #endif
        return all
    }

    #if DEBUG
    /// A goal on this Mac, for a look at its card and bar (KUVO_DEMO_GOAL).
    var demo: GoalPlan? {
        didSet { changed() }
    }
    /// What the demo's box says of its sandbox (KUVO_DEMO_GOAL=<bot>:cant, KUVO_DEMO_SANDBOX).
    @ObservationIgnored var demoSandbox: GoalSandbox.Reading?
    #endif

    /// `box`'s goals, from now on, until the task following it ends (a machine disconnecting, or
    /// removed). This Mac's box tells each change as it's made; a machine's is read as it connects
    /// (`read`), then followed while it's connected and ready. A box from before goals is asked again
    /// only now and then.
    func follow(_ box: String) async {
        let me = UUID()
        following[box] = me
        // (Followed as it changes on a box that streams (the app's own, and the one attached in place
        // while it's reached over its server: asked each round); read now and then on any other, which
        // answers once a read.)
        var onThisMac: Bool { BoxClient.streams(box) }
        var older = false
        while !Task.isCancelled {
            if !onThisMac {
                try? await Task.sleep(for: .seconds(older ? 300 : 30))
                guard !Task.isCancelled, isConnected(box) else { continue }
            }
            older = false
            if let client = client(box) {
                do {
                    for try await line in client.follow("kuvo/work/goals/events") {
                        guard let list = try? JSONDecoder().decode(GoalPlanList.self, from: line) else { continue }
                        take(list.goals, from: box)
                    }
                } catch let refusal as BoxRefusal {
                    older = refusal.status == 404 || refusal.status == 403
                } catch {}
            }
            if onThisMac { try? await Task.sleep(for: .seconds(older ? 300 : 2)) }
        }
        if following[box] == me {
            following[box] = nil
            plans[box] = nil
            changed()
        }
    }

    private func isConnected(_ box: String) -> Bool {
        connected?(box) ?? (app?.machines.engine(box)?.isReady == true)
    }

    /// `box`'s goals now, read once (as it connects).
    func read(_ box: String) async {
        guard BoxClient.isThisMac(box) || isConnected(box), let client = client(box), let list = try? await client.value(GoalPlanList.self, "GET", "kuvo/work/goals") else { return }
        take(list.goals, from: box)
    }

    /// `box`'s goals now, in place of what it had: what's new waiting for you, a digest and a report
    /// told once each. What a box had as it was first read isn't told: it was news before.
    func take(_ list: [GoalPlan], from box: String) {
        let before = plans[box] ?? []
        guard list != before else { return }
        let first = !seen.contains(box)
        seen.insert(box)
        plans[box] = list.isEmpty ? nil : list
        for plan in list {
            for item in plan.waiting where item.kind != .ask && told.insert(item.id).inserted && !first && plan.state == .running {
                Notifier.shared.notify(session: item.session ?? plan.session, title: plan.name, subtitle: "Needs you", body: item.text, quiet: !(plan.wake && item.kind == .you))
            }
            if let digest = plan.lastDigest, told.insert("digest:\(plan.id):\(digest.at)").inserted, !first {
                Notifier.shared.notify(session: plan.session, title: plan.goal, subtitle: plan.name, body: digest.text, quiet: true)
            }
            if plan.state == .done || plan.state == .stopped, let report = plan.report, told.insert("report:\(plan.id)").inserted, !first {
                Notifier.shared.notify(session: plan.session, title: plan.state == .done ? "\(plan.name) finished its goal" : "\(plan.name)’s goal ended", body: report)
            }
        }
        changed()
    }

    private func changed() {
        onChange?(Set(all.values.joined().filter(\.isProposed).map(\.session)))
    }

    /// Your answer, on its box: start (with your switches and limits), not now, or stop. Nil for one
    /// answered meanwhile on another client (or gone).
    @discardableResult
    func answer(_ plan: GoalPlan, on box: String, _ answer: GoalPlanAnswer) async throws -> GoalPlan? {
        guard let client = client(box) else { throw BoxRefusal(status: 503, message: "\(app?.machines.engine(box)?.machine.name ?? "Its computer") can’t be reached now. Try again once it’s connected.") }
        guard answering.insert(plan.id).inserted else { return nil }
        defer { answering.remove(plan.id) }
        struct Answered: Decodable { var goal: GoalPlan }
        do {
            let answered = try await client.value(Answered.self, "POST", "kuvo/work/goals/\(plan.id)", body: answer)
            take((plans[box] ?? []).map { $0.id == plan.id ? answered.goal : $0 }, from: box)
            return answered.goal
        } catch let refusal as BoxRefusal where refusal.status == 404 {
            // Answered meanwhile on another client, or gone.
            await read(box)
            return nil
        } catch let refusal as BoxRefusal where refusal.status == 400 {
            // Not as it was (a plan from more than a day ago): the box says why, on the card.
            await read(box)
            throw refusal
        }
    }

}
