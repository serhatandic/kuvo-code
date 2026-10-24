#if DEBUG
import Foundation
import Observation
import os

/// How the demo director waits: for the app to get somewhere (woken by the state it watches
/// changing, never by checking on a timer), or for a pause that paces what a screen recording
/// shows, each named for what it waits for.
@MainActor
enum DemoWait {
    private static let log = Logger(subsystem: "run.kuvo.code", category: "demo")

    /// As long as "until" means for what used to wait however long it took: an hour.
    static let unbounded = Duration.seconds(3600)

    /// Until `condition` holds, woken each time the observable state it reads changes; false (and
    /// logged, as waiting for `what`) if it still doesn't after `limit`. Only for state the app
    /// observes (stores' properties): one it doesn't would never wake it (see `poll`).
    @discardableResult
    static func until(_ what: String, limit: Duration = .seconds(60), _ condition: @escaping @MainActor () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: limit)
        while !condition() {
            guard ContinuousClock.now < deadline, !Task.isCancelled else { return gaveUp(what) }
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
    static func poll(_ what: String, every interval: Duration = .seconds(1), limit: Duration = unbounded, _ condition: @MainActor () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: limit)
        while !condition() {
            guard ContinuousClock.now < deadline, !Task.isCancelled else { return gaveUp(what) }
            try? await Task.sleep(for: interval)
        }
        return true
    }

    private static func gaveUp(_ what: String) -> Bool {
        if !Task.isCancelled { log.error("Demo: gave up waiting for \(what, privacy: .public)") }
        return false
    }

    /// A pause, for what it paces.
    static func pause(_ pace: Pace) async {
        try? await Task.sleep(for: pace.duration)
    }

    /// What a pause is for.
    enum Pace {
        /// The window to settle after launch: its restored frame is applied, then set again.
        case windowSettles
        /// The window closed a moment, before it opens again.
        case windowStaysClosed
        /// The app to have settled after launch, before a measured run starts.
        case launchSettles
        /// The conversation to come into view, so what opens in the panel is its.
        case conversationShows
        /// A conversation's messages to have come in and shown a while.
        case conversationRead
        /// The project's changes to have been read, for a comment on them.
        case changesRead
        /// A session to have been connected a while, as an agent's step would come.
        case connectedAWhile
        /// A beat after something loads, before acting in it, as a person would.
        case beat
        /// A moment with the conversation in view before a message goes, for a recording.
        case beforeSending
        /// A run to have started, before waiting for it to end.
        case runStarts
        /// A chat's reply to have come (`afterChat`), or the app to have settled.
        case replyComes(afterChat: Bool)
        /// Between asks the agent makes, again and again.
        case betweenAsks
        /// A step of a measured run (tab switches, toggles, resizes, typing).
        case step(Duration)
        /// As long as a launch variable asks.
        case asked(Double)

        var duration: Duration {
            switch self {
            case .windowSettles: .seconds(1)
            case .windowStaysClosed: .seconds(2)
            case .launchSettles: .seconds(10)
            case .conversationShows: .seconds(1.5)
            case .conversationRead: .seconds(6)
            case .changesRead: .seconds(2)
            case .connectedAWhile: .seconds(18)
            case .beat: .seconds(1)
            case .beforeSending: .seconds(2)
            case .runStarts: .seconds(3)
            case .replyComes(let afterChat): .seconds(afterChat ? 16 : 3)
            case .betweenAsks: .seconds(5)
            case .step(let duration): duration
            case .asked(let seconds): .seconds(seconds)
            }
        }
    }
}
#endif
