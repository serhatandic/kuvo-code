import Foundation

/// How long what keeps a machine's connection current waits between its rounds and tries.
enum MachineClock {
    /// Waits `seconds`, or until the task is cancelled.
    static func wait(_ seconds: Int) async {
        await clock(seconds)
    }

    /// Tries `attempt` after each of `waits` (seconds) in turn, until it says it's done: whether it
    /// was. Stops when the task is cancelled.
    @discardableResult
    static func retry(after waits: some Sequence<Int>, _ attempt: () async -> Bool) async -> Bool {
        for seconds in waits {
            await wait(seconds)
            guard !Task.isCancelled else { return false }
            if await attempt() { return true }
        }
        return false
    }

    /// Between tries to reach a machine that dropped, in seconds: further apart each time, up to
    /// half a minute (as a phone tries a box), then every two minutes after an hour away. Never
    /// ending: it's connected again by itself whenever it's back, however long that takes.
    static var reconnectWaits: some Sequence<Int> {
        let first = [3, 5, 10, 20, 30]
        // Half a minute apart for the rest of the first hour.
        let hour = (3600 - first.reduce(0, +)) / 30
        return sequence(state: 0) { tries in
            defer { tries += 1 }
            return tries < first.count ? first[tries] : tries < first.count + hour ? 30 : 120
        }
    }

    #if DEBUG
    /// Tests move a clock of their own on.
    static var clock: (Int) async -> Void = sleep
    #else
    private static let clock: (Int) async -> Void = sleep
    #endif

    private static func sleep(_ seconds: Int) async {
        try? await Task.sleep(for: .seconds(seconds))
    }
}
