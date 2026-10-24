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
    static func retry(after waits: [Int], _ attempt: () async -> Bool) async -> Bool {
        for seconds in waits {
            await wait(seconds)
            guard !Task.isCancelled else { return false }
            if await attempt() { return true }
        }
        return false
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
