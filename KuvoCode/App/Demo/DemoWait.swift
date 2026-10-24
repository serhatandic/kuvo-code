#if DEBUG
import Foundation
import Observation

/// How the demo director waits: for the app to get somewhere (woken by the state it watches
/// changing, never by checking on a timer), or for a pause that paces what a screen recording
/// shows, each named for what it waits for.
@MainActor
enum DemoWait {
    /// Until `condition` holds, woken each time the observable state it reads changes; false if it
    /// still doesn't after `limit`. Only for state the app observes (stores' properties): one it
    /// doesn't would never wake it (see `poll`).
    @discardableResult
    static func until(_ limit: Duration = .seconds(60), _ condition: @escaping @MainActor () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: limit)
        while !condition() {
            guard ContinuousClock.now < deadline, !Task.isCancelled else { return false }
            let changed = AsyncStream<Void> { continuation in
                withObservationTracking { _ = condition() } onChange: { continuation.finish() }
                let timeout = Task { try? await Task.sleep(until: deadline); continuation.finish() }
                continuation.onTermination = { _ in timeout.cancel() }
            }
            for await _ in changed {}
        }
        return true
    }

    /// Until `condition` holds, checking it every `interval`: for state the app doesn't observe
    /// (a store set up behind observation's back), where `until` would never wake.
    @discardableResult
    static func poll(every interval: Duration = .seconds(1), limit: Duration = .seconds(180), _ condition: @MainActor () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: limit)
        while !condition() {
            guard ContinuousClock.now < deadline, !Task.isCancelled else { return false }
            try? await Task.sleep(for: interval)
        }
        return true
    }

    /// A pause, for what it paces.
    static func pause(_ pace: Pace) async {
        try? await Task.sleep(for: pace.duration)
    }

    /// What a pause is for.
    enum Pace {
        /// The window to settle after launch: its restored frame is applied, then set again.
        case windowSettles
        /// The conversation to come into view, so what opens in the panel is its.
        case conversationShows
        /// A beat after something loads, before acting in it, as a person would.
        case beat
        /// A step of a measured run (tab switches, toggles, resizes): what the measurement paces.
        case step(Duration)
        /// As long as a launch variable asks.
        case seconds(Double)

        var duration: Duration {
            switch self {
            case .windowSettles: .seconds(1)
            case .conversationShows: .seconds(1.5)
            case .beat: .seconds(1)
            case .step(let duration): duration
            case .seconds(let seconds): .seconds(seconds)
            }
        }
    }
}
#endif
