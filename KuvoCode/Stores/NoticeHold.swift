import Foundation
import KuvoLink

/// This Mac's notices for your phones, held while you're at a computer (KuvoLink's PROTOCOL.md,
/// "kuvo/attention"), as a machine's bridge holds its own (`NoticeHold` in kuvo-link.js).
///
/// A client in use (this Mac's window while you're at it: `Attention`) says so for a short lease it
/// renews. While one is, each notice waits a little before it goes, and doesn't go if it was
/// answered meanwhile (a permission, a question, an ask) or its conversation came on that client's
/// screen. When the last lease ends (it ran out, or the client said it's not in use), what waits
/// goes at once; with none, notices go at once. So a client that vanishes holds nothing back for
/// longer than a hold.
final class NoticeHold {
    /// How long a notice waits while you're at a computer: what's asked of you less than news.
    static let askHold: TimeInterval = 30
    static let newsHold: TimeInterval = 60
    /// The longest lease a client gets: one it doesn't renew is over by then.
    static let longestLease: TimeInterval = 60
    /// A notice that couldn't go (no relay just now) is tried again this often, for this long.
    static let retryEvery: TimeInterval = 5
    static let tryFor: TimeInterval = 600
    /// Requests answered lately: one answered before its notice was made never goes.
    private static let mostAnswered = 200

    static func hold(for category: Notice.Category) -> TimeInterval {
        [.permission, .question, .ask].contains(category) ? askHold : newsHold
    }

    /// What time it is, and a way to be woken after a while: a test's own moves only when it says.
    struct Clock {
        var now: () -> Date
        /// Calls `fire` after `seconds`; what it gives back stops that.
        var after: (_ seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> () -> Void

        static var live: Clock { Clock(now: { Date() }, after: wake) }

        private static func wake(after seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> () -> Void {
            let task = Task { @MainActor in
                try? await Task.sleep(for: .seconds(seconds))
                if !Task.isCancelled { fire() }
            }
            return { task.cancel() }
        }
    }

    private struct Entry {
        var notice: Notice
        var at: Date
        var due: Date
        var seen = false
        var retry: Date?
    }

    private let clock: Clock
    /// To your phones; false when it can't go now.
    private let send: (Notice) -> Bool
    private var leases: [String: Date] = [:]
    private var held: [Entry] = []
    private var answered: [String] = []
    private var stopWake: (() -> Void)?

    init(clock: Clock? = nil, send: @escaping (Notice) -> Bool) {
        self.clock = clock ?? .live
        self.send = send
    }

    /// Whether a client is in use now.
    var inUse: Bool {
        let now = clock.now()
        return leases.values.contains { $0 > now }
    }

    /// How many notices wait.
    var count: Int { held.count }

    /// `client` is in use for `seconds` more (cut to the longest lease), with `sessions` on its
    /// screen; 0: it isn't any more.
    func attend(_ client: String, for seconds: TimeInterval, sessions: [String] = []) {
        if seconds > 0 {
            leases[client] = clock.now().addingTimeInterval(min(seconds, Self.longestLease))
            let shown = Set(sessions)
            for index in held.indices where shown.contains(Self.shownIn(held[index].notice)) { held[index].seen = true }
        } else {
            leases[client] = nil
        }
        settle()
    }

    /// A notice for your phones: it goes now, or once its hold ends.
    func tell(_ notice: Notice) {
        if let answer = Self.answeredBy(notice), answered.contains(answer) { return }
        let now = clock.now()
        held.append(Entry(notice: notice, at: now, due: inUse ? now.addingTimeInterval(Self.hold(for: notice.category)) : now))
        settle()
    }

    /// A request or an ask answered (or gone): its notice, waiting, never goes.
    func resolve(_ id: String) {
        guard !id.isEmpty else { return }
        answered.append(id)
        if answered.count > Self.mostAnswered { answered.removeFirst() }
        held.removeAll { Self.answeredBy($0.notice) == id }
        settle()
    }

    /// What a notice is about (its conversation, or group chat), and what answering takes it back.
    private static func shownIn(_ notice: Notice) -> String { notice.data["session"] ?? notice.data["group"] ?? notice.thread }
    private static func answeredBy(_ notice: Notice) -> String? { notice.data["request"] ?? notice.data["ask"] }

    /// When an entry may go: its hold's end while a client's in use, else now; one that couldn't go
    /// waits for its next try.
    private func time(of entry: Entry, waiting: Bool) -> Date {
        max(waiting ? entry.due : .distantPast, entry.retry ?? .distantPast)
    }

    /// Sends what's due, and wakes again when the next is (or a lease ends with something waiting).
    private func settle() {
        let now = clock.now()
        leases = leases.filter { $0.value > now }
        let waiting = !leases.isEmpty
        var kept: [Entry] = []
        for var entry in held {
            if time(of: entry, waiting: waiting) > now {
                kept.append(entry)
                continue
            }
            if entry.seen || send(entry.notice) { continue }
            if now.timeIntervalSince(entry.at) < Self.tryFor {
                entry.retry = now.addingTimeInterval(Self.retryEvery)
                kept.append(entry)
            }
        }
        held = kept
        stopWake?()
        stopWake = nil
        guard !kept.isEmpty, let next = (kept.map { time(of: $0, waiting: waiting) } + leases.values).min() else { return }
        stopWake = clock.after(max(0, next.timeIntervalSince(now))) { [weak self] in self?.settle() }
    }
}
