import Foundation

/// A clock the test moves on, for what waits between a machine's syncs (`MachineClock`): a wait
/// goes on when the test says that long passed, or when its task is cancelled. No time at all
/// goes on at once. What waits now says which syncs are running.
nonisolated final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: [(id: Int, seconds: Int, resume: CheckedContinuation<Void, Never>)] = []
    private var cancelled: Set<Int> = []
    private var next = 0

    func wait(_ seconds: Int) async {
        guard seconds > 0 else { return }
        let id = lock.withLock {
            next += 1
            return next
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let goesOn = lock.withLock {
                    if cancelled.remove(id) != nil { return true }
                    waiting.append((id, seconds, continuation))
                    return false
                }
                if goesOn { continuation.resume() }
                TestPulse.beat()
            }
        } onCancel: {
            let found = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                guard let index = waiting.firstIndex(where: { $0.id == id }) else {
                    cancelled.insert(id)
                    return nil
                }
                return waiting.remove(at: index).resume
            }
            found?.resume()
            TestPulse.beat()
        }
    }

    /// What waits now, in seconds, shortest first.
    var waits: [Int] { lock.withLock { waiting.map(\.seconds).sorted() } }

    /// `seconds` passed: what waited that long goes on.
    func pass(_ seconds: Int) {
        let due = lock.withLock {
            let due = waiting.filter { $0.seconds == seconds }
            waiting.removeAll { $0.seconds == seconds }
            return due
        }
        for wait in due { wait.resume.resume() }
        TestPulse.beat()
    }
}
