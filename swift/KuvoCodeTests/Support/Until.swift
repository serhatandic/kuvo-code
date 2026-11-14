import Foundation
import Observation
import Testing

/// Waits until `condition` holds, looking again only when something it depends on changed: an
/// observable property it read (the app's stores, a session, a browser tab), or a beat of
/// `TestPulse`, which what the app does outside them sends (a request reaching a stand-in, a
/// script sent to a machine, a test's clock waited on). No sleeps and no time limit of its own:
/// what never comes is the suite's `.timeLimit` to report, which ends the wait by cancelling it
/// (and this says which wait it was).
@MainActor
func until(_ condition: () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async throws {
    while true {
        let wake = Wake()
        let met = withObservationTracking {
            _ = TestPulse.shared.beats
            return condition()
        } onChange: {
            wake.fire()
        }
        if met { return }
        do {
            try await wake.wait()
        } catch {
            Issue.record("What this waited for never came", sourceLocation: sourceLocation)
            throw error
        }
    }
}

/// What changed outside observable state, for `until`: stand-ins and test doubles beat it after
/// they record something a test waits for.
@MainActor
@Observable
final class TestPulse {
    static let shared = TestPulse()
    private(set) var beats = 0

    /// From any thread: after what changed is recorded, so a wait that looks again sees it.
    nonisolated static func beat() {
        if Thread.isMainThread {
            MainActor.assumeIsolated { shared.beats &+= 1 }
        } else {
            Task { @MainActor in shared.beats &+= 1 }
        }
    }
}

/// Resumes one wait, once: when something changed, or when the waiting test was cancelled.
nonisolated private final class Wake: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    private var waiting: CheckedContinuation<Void, Never>?

    func fire() {
        let resumed = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            fired = true
            defer { waiting = nil }
            return waiting
        }
        resumed?.resume()
    }

    func wait() async throws {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let now = lock.withLock {
                    if fired { return true }
                    waiting = continuation
                    return false
                }
                if now { continuation.resume() }
            }
        } onCancel: {
            fire()
        }
        try Task.checkCancellation()
    }
}
