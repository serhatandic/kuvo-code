import Foundation

// When a computer counts as not connected, for everything a client shows of it: a conversation's
// card over its composer, the marks on the computers' strip and list, a computer's pages, the Inbox,
// and the Mac's bar and its word that an engine isn't running (#443). A busy computer answers late,
// and its link goes away and comes back within moments; that isn't an outage, and says nothing
// alarming. Only one that stays out of reach for `Reach.grace` is shown as not connected, and the
// moment it's back, it isn't.

public enum Reach {
    /// How long a computer that was connected may stay out of reach before it shows as not
    /// connected. Connecting again takes up to 4 s on a quiet computer (a second's wait, a new
    /// handshake, the event feed, each a trip through the relay). Under a load of 150 to 200, a box's
    /// processes stall now and then: over four minutes of one, its agents' bridge answered a dozen
    /// requests more than a second late, and one 5.5 s late, its engine one 3.3 s late. A reconnect
    /// that hits such stalls takes 7 to 10 s. A real outage still shows within moments.
    public static let grace: Duration = .seconds(10)

    /// A request that failed only because its computer was slow or out of reach: it timed out with
    /// nothing back, the connection dropped, or none could be made. Nothing went wrong in what was
    /// asked (an agent's turn goes on through it), so it isn't said as a failure: it's asked again
    /// quietly, and a computer that stays away says so once `grace` is over. (A computer that
    /// turned this client away fails as one that can't be connected to: a client that can tell,
    /// says that first.)
    public static func isTransient(_ error: any Error) -> Bool {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        return transientCodes.contains(error.code)
    }

    private static let transientCodes: Set<Int> = [
        NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet,
        NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed,
        NSURLErrorSecureConnectionFailed, NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff,
    ]
}

/// A computer (or its engine) out of reach, as it goes: since when, and how many tries in a row
/// missed it. It shows as not connected only once it's been out of reach for the whole grace, with
/// at least `misses` tries missing it; any try that reaches it ends it.
public struct Outage: Sendable, Equatable {
    /// Since when it's been out of reach; nil while it's reached.
    public private(set) var since: ContinuousClock.Instant?
    /// Tries in a row that missed it.
    public private(set) var misses = 0

    public init() {}

    /// A try didn't reach it (the link dropped, a check went unanswered).
    public mutating func missed(at now: ContinuousClock.Instant = .now) {
        if since == nil { since = now }
        misses += 1
    }

    /// It answered: whatever came before is over.
    public mutating func reached() {
        since = nil
        misses = 0
    }

    /// Shown as not connected (or its engine as not running): out of reach for `grace` at least,
    /// and missed by `misses` tries at least.
    public func isShown(at now: ContinuousClock.Instant = .now, grace: Duration = Reach.grace, misses: Int = 1) -> Bool {
        guard let since else { return false }
        return now - since >= grace && self.misses >= misses
    }

    /// How long until it shows, if nothing reaches it meanwhile (zero once the grace is over): for
    /// a client to look again then. Nil while it's reached.
    public func untilShown(at now: ContinuousClock.Instant = .now, grace: Duration = Reach.grace) -> Duration? {
        guard let since else { return nil }
        return max(.zero, since + grace - now)
    }
}
