import ClientSessions
import Foundation
import KuvoLink
import Observation

/// What bots do to the sessions they oversee, as they do it (`kuvo/work/oversight`, PROTOCOL.md
/// "Work"), on this Mac's box and each machine's: the sidebar lights the bot's lane to that
/// session, and its face is pleased when one finishes. Each is played once, as it comes; what
/// happened before you looked isn't played late.
@MainActor @Observable
final class BotOversight {
    @ObservationIgnored weak var app: AppModel?
    /// A box's client (a test's own); the app's otherwise.
    @ObservationIgnored var boxes: ((String) -> BoxClient)?
    /// When a mark is taken (a test's own clock); now otherwise.
    @ObservationIgnored var now: () -> Date = Date.init
    /// The marks to play, the latest first, with when each came: only the latest few seconds'.
    private(set) var recent: [(mark: OversightMark, came: Date)] = []
    /// The boxes whose marks come as they're made now.
    private(set) var live: Set<String> = []
    /// Each box's follow now, so one that ended (a reconnect) leaves the next one alone.
    @ObservationIgnored private var following: [String: UUID] = [:]

    /// How long after it comes a mark still plays: a row made meanwhile (a project opened, the
    /// sidebar back) plays it, and not one long gone.
    static let fresh: TimeInterval = 1.5

    private func client(_ box: String) -> BoxClient? {
        boxes?(box) ?? app?.box(box)
    }

    /// What bots do on `box`, from now on, until the task following it ends (a machine
    /// disconnecting, or removed). A box from before bots' oversight was shown is asked again
    /// only now and then.
    func follow(_ box: String) async {
        let me = UUID()
        following[box] = me
        var older = false
        while !Task.isCancelled {
            if let client = client(box) {
                // A new follow starts again: the line it starts with happened before it.
                var player = OversightPlayer()
                do {
                    for try await line in client.follow("kuvo/work/oversight/events") {
                        guard let list = try? JSONDecoder().decode(OversightMarks.self, from: line) else { continue }
                        take(player.take(list.marks))
                        if following[box] == me, !live.contains(box) { live.insert(box) }
                    }
                    older = false
                } catch let refusal as BoxRefusal {
                    older = refusal.status == 404 || refusal.status == 403
                } catch {}
            }
            if following[box] == me { live.remove(box) }
            try? await Task.sleep(for: .seconds(older ? 300 : BoxClient.streams(box) ? 2 : 30))
        }
        if following[box] == me {
            following[box] = nil
            live.remove(box)
        }
    }

    /// New marks, to play now.
    func take(_ marks: [OversightMark]) {
        guard !marks.isEmpty else { return }
        let now = now()
        recent = (marks.reversed().map { (mark: $0, came: now) } + recent).filter { now.timeIntervalSince($0.came) < Self.fresh }
    }

    /// The marks still to play, by bot, in `sessions`: the latest first.
    func playing(in sessions: Set<String>) -> [OversightMark] {
        let now = now()
        return recent.filter { sessions.contains($0.mark.session) && now.timeIntervalSince($0.came) < Self.fresh }.map(\.mark)
    }
}
