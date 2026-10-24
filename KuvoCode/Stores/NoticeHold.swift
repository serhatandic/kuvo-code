import Foundation
import KuvoLink

/// This Mac's notices for your phones, held while you're at a computer (KuvoLink's PROTOCOL.md,
/// "kuvo/attention"), as a machine's bridge holds its own (`NoticeHold` in kuvo-link.js).
///
/// A client in use (this Mac's window while you're at it: `Attention`) says so for a short lease it
/// renews. While one is, each notice waits a little before it goes, and doesn't go if it was
/// answered meanwhile (a permission, a question, an ask) or seen: its conversation came on that
/// client's screen, or the client showed it in a notification of its own. When the last lease ends
/// (it ran out, or the client said it's not in use), what waits goes at once; with none, notices go
/// at once. So a client that vanishes holds nothing back for longer than a hold.
final class NoticeHold {
    /// How long a notice waits while you're at a computer: what's asked of you less than news.
    static let askHold: TimeInterval = 30
    static let newsHold: TimeInterval = 60
    /// The longest lease a client gets: one it doesn't renew is over by then.
    static let longestLease: TimeInterval = 60
    /// A client's notification of a notice's news and the notice itself come apart: one shown this
    /// long before the notice still counts.
    static let shownWithin: TimeInterval = 10
    /// A notice that couldn't go (no relay just now) is tried again this often, for this long.
    static let retryEvery: TimeInterval = 5
    static let tryFor: TimeInterval = 600
    /// Requests answered lately: one answered before its notice was made never goes.
    private static let mostAnswered = 200

    /// What's asked of you, as opposed to news.
    private static let asked: Set<Notice.Category> = [.permission, .question, .ask]

    static func hold(for category: Notice.Category) -> TimeInterval {
        asked.contains(category) ? askHold : newsHold
    }

    static func isAsked(_ category: Notice.Category) -> Bool { asked.contains(category) }

    /// A notification a client showed of its own: its conversation (as a notice's), whether it
    /// asked you something or was news, and the request or ask it's about, when it is.
    struct Shown: Equatable {
        var session: String
        var ask: Bool
        var request: String?
        /// The machine whose news it was (nil: this Mac's), for this Mac to tell that box alone; not
        /// sent.
        var machine: String?

        init(session: String, ask: Bool, request: String? = nil, machine: String? = nil) {
            self.session = session
            self.ask = ask
            self.request = request
            self.machine = machine
        }

        init(of notice: Notice) {
            self.init(session: NoticeHold.shownIn(notice), ask: NoticeHold.isAsked(notice.category), request: NoticeHold.answeredBy(notice))
        }

        /// Whether it's a notification of `notice`: the request or ask it's about, when it names
        /// one; else its conversation, and asked of you or news alike.
        func shows(_ notice: Notice) -> Bool {
            if let request { return request == NoticeHold.answeredBy(notice) }
            return session == NoticeHold.shownIn(notice) && ask == NoticeHold.isAsked(notice.category)
        }
    }

    typealias Instant = ContinuousClock.Instant

    /// Time gone by, which a change of the date or time can't move, and a way to be woken after a
    /// while: a test's own moves only when it says.
    struct Clock {
        var now: () -> Instant
        /// Calls `fire` after `delay`; what it gives back stops that.
        var after: (_ delay: Duration, _ fire: @escaping @MainActor () -> Void) -> () -> Void

        static var live: Clock { Clock(now: { ContinuousClock.now }, after: wake) }

        private static func wake(after delay: Duration, _ fire: @escaping @MainActor () -> Void) -> () -> Void {
            let task = Task { @MainActor in
                try? await Task.sleep(for: delay)
                if !Task.isCancelled { fire() }
            }
            return { task.cancel() }
        }
    }

    private struct Entry {
        var notice: Notice
        var at: Instant
        /// When its hold ends; nil for one seen that's asked of you, which waits while anyone's in use.
        var due: Instant?
        var seen = false
        var retry: Instant?
    }

    private let clock: Clock
    /// To your phones; false when it can't go now.
    private let send: (Notice) -> Bool
    private var leases: [String: Instant] = [:]
    private var held: [Entry] = []
    /// Notifications clients showed lately, for notices that come after them.
    private var shown: [(shown: Shown, at: Instant)] = []
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
    /// screen and `shown` in its own notifications just now; 0: it isn't any more.
    func attend(_ client: String, for seconds: TimeInterval, sessions: [String] = [], shown: [Shown] = []) {
        if seconds > 0 {
            let now = clock.now()
            leases[client] = now + .seconds(min(seconds, Self.longestLease))
            let onScreen = Set(sessions)
            for index in held.indices where onScreen.contains(Self.shownIn(held[index].notice)) { held[index].seen = true }
            // Each notification stands for one notice: the oldest held of it, or the next to come.
            self.shown.removeAll { now - $0.at >= .seconds(Self.shownWithin) }
            for each in shown {
                if let index = held.firstIndex(where: { !$0.seen && each.shows($0.notice) }) {
                    held[index].seen = true
                } else {
                    self.shown.append((each, now))
                }
            }
            self.shown = Array(self.shown.suffix(200))
        } else {
            leases[client] = nil
        }
        settle()
    }

    /// A notice for your phones: it goes now, or once its hold ends.
    func tell(_ notice: Notice) {
        if let answer = Self.answeredBy(notice), answered.contains(answer) { return }
        let now = clock.now()
        let inUse = inUse
        // Shown by a client in use just before it came.
        // (That notification is spent.)
        let mark = inUse ? shown.firstIndex { now - $0.at < .seconds(Self.shownWithin) && $0.shown.shows(notice) } : nil
        if let mark { shown.remove(at: mark) }
        let seen = mark != nil
        held.append(Entry(notice: notice, at: now, due: inUse ? now + .seconds(Self.hold(for: notice.category)) : now, seen: seen))
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

    /// When an entry may go: its hold's end while a client's in use (nil: not while one is), else
    /// now; one that couldn't go waits for its next try.
    private func time(of entry: Entry, waiting: Bool, now: Instant) -> Instant? {
        let retry = entry.retry ?? now
        guard waiting else { return retry }
        return entry.due.map { max($0, retry) }
    }

    /// Sends what's due, and wakes again when the next is (or a lease ends with something waiting).
    private func settle() {
        let now = clock.now()
        leases = leases.filter { $0.value > now }
        let waiting = !leases.isEmpty
        var kept: [Entry] = []
        for var entry in held {
            guard let time = time(of: entry, waiting: waiting, now: now), time <= now else {
                kept.append(entry)
                continue
            }
            // Seen: news needs telling no more; what's asked of you waits until it's answered, and
            // goes once no one's at a client (you saw it, and left it unanswered).
            if entry.seen && !Self.asked.contains(entry.notice.category) { continue }
            if entry.seen && waiting {
                entry.due = nil
                kept.append(entry)
                continue
            }
            if send(entry.notice) { continue }
            if now - entry.at < .seconds(Self.tryFor) {
                entry.retry = now + .seconds(Self.retryEvery)
                kept.append(entry)
            }
        }
        held = kept
        stopWake?()
        stopWake = nil
        guard !kept.isEmpty, let next = (kept.compactMap { time(of: $0, waiting: waiting, now: now) } + leases.values).min() else { return }
        stopWake = clock.after(max(.zero, next - now)) { [weak self] in self?.settle() }
    }
}
