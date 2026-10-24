import Foundation

/// How long what keeps a machine's connection current waits between its rounds and tries.
enum MachineClock {
    /// Waits `seconds`, or until the task is cancelled.
    static func wait(_ seconds: Int) async {
        await clock(seconds)
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
