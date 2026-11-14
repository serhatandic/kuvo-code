import Foundation

// When a computer counts as not connected, for everything a client shows of it: a conversation's
// card over its composer, the marks on the computers' strip and list, and the Mac's bar over a
// machine's conversation (#443). A busy computer answers late, and its link goes away and comes back
// within moments; that isn't an outage, and says nothing alarming.

/// The one rule both apps follow. Its link down, nothing says so for `grace`: what's on screen
/// stays, at most "Updating…" while it's read again. Then it's checked, and only a check that fails
/// (no answer within `patience`) makes it out of reach, the "isn't connected" card. A check that
/// answers, however late, keeps it in reach, and it's checked again `again` later while its link
/// stays down. Back at any point, nothing more is said. (What's sure at once, like an engine stopped
/// on purpose or a phone turned away, is each app's to say at once.)
///
/// A request still under way is never "timed out" either: each app's requests wait as long as the
/// computer answers its link's own checks, and a read that fails only because the link went
/// (`isTransient`) is read again once it can be, rather than said as a failure.
public enum Reach {
    /// How long its link may be down before it's checked. Connecting again takes up to 4 s on a
    /// quiet computer (a second's wait, a new handshake, the event feed, each a trip through the
    /// relay). Under a load of 150 to 200, a box's processes stall now and then: over four minutes
    /// of one, its agents' bridge answered a dozen requests more than a second late, and one 5.5 s
    /// late, its engine one 3.3 s late. A reconnect that hits such stalls takes 7 to 10 s.
    public static let grace: Duration = .seconds(10)
    /// How long a check may take before it counts as failed: a busy computer answers late.
    public static let patience: Duration = .seconds(30)
    /// How long after a check that answered it's checked again, while its link stays down.
    public static let again: Duration = .seconds(10)

    /// After a computer's link went down: whether it's out of reach. True once it's been down
    /// through `grace` and a check since failed; false once it's back (`isBack`), or the wait is
    /// called off. `check` is true when the computer answered (anything at all, a refusal too).
    @MainActor
    public static func isAway(grace: Duration = grace, patience: Duration = patience, again: Duration = again,
                              isBack: @escaping @MainActor () -> Bool, check: @escaping @MainActor () async -> Bool,
                              wait: @escaping @MainActor (Duration) async -> Void = { try? await Task.sleep(for: $0) }) async -> Bool {
        await wait(grace)
        while !Task.isCancelled, !isBack() {
            let answered = await answers(within: patience, check)
            guard !Task.isCancelled, !isBack() else { return false }
            if !answered { return true }
            await wait(again)
        }
        return false
    }

    /// Whether `check` answered (said true) within `patience`: one still asking then hasn't.
    @MainActor
    public static func answers(within patience: Duration, _ check: @escaping @MainActor () async -> Bool) async -> Bool {
        await withTaskGroup(of: Bool?.self) { group in
            group.addTask { await check() }
            group.addTask {
                try? await Task.sleep(for: patience)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? false
        }
    }

    /// How long before reading again what only a link failure kept from being read
    /// (`isTransient`), after `tries` such reads in a row: soon, then less often, up to half a
    /// minute apart while the computer stays slow.
    public static func readAgain(after tries: Int) -> Duration {
        .seconds(min(1 << min(max(tries, 1), 5), 30))
    }

    /// A request that failed only because its computer was slow or out of reach: it timed out with
    /// nothing back, the connection dropped, or none could be made. Nothing went wrong in what was
    /// asked (an agent's turn goes on through it): what was being read is read again quietly. (A
    /// computer that turned this client away fails as one that can't be connected to: a client that
    /// can tell, says that first.)
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
