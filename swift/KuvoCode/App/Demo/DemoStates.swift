#if DEBUG
import ClientDesign
import Foundation
import Observation

/// KUVO_DEMO_STATES: stand-in states for the sidebar's rows and tabs, to see and measure many marks
/// at once without as many agents at work. A list of `kind=percent` (`working=30,needsYou=10,new=15`)
/// shares the sessions out by their IDs; KUVO_DEMO_STATES_CHURN=<seconds> deals them again that
/// often, so states come and go as they do while agents work. Debug builds only.
@MainActor @Observable
final class DemoStates {
    static let shared = DemoStates(ProcessInfo.processInfo.environment)

    private let shares: [(kind: StatusMark.Kind, upTo: Int)]
    private(set) var round = 0

    private init(_ environment: [String: String]) {
        var total = 0
        shares = (environment["KUVO_DEMO_STATES"] ?? "").split(separator: ",").compactMap { pair in
            let parts = pair.split(separator: "=")
            guard parts.count == 2, let kind = Self.kinds[String(parts[0])], let percent = Int(parts[1]) else { return nil }
            total += percent
            return (kind, total)
        }
        if !shares.isEmpty, let seconds = environment["KUVO_DEMO_STATES_CHURN"].flatMap(Double.init), seconds.isFinite, seconds > 0 {
            Task { [weak self] in
                while let self {
                    try? await Task.sleep(for: .seconds(seconds))
                    self.round += 1
                }
            }
        }
    }

    private static let kinds: [String: StatusMark.Kind] = [
        "working": .working, "subagents": .subagents, "needsYou": .needsYou, "new": .new, "failed": .failed,
        "wake": .wake, "watching": .watching, "paused": .paused, "waitingForComputer": .waitingForComputer, "offline": .offline,
    ]

    /// Whether the variable is set: then every session's state is a stand-in, nil for none.
    var isOn: Bool { !shares.isEmpty }

    /// The stand-in state of a session, the same for a given ID until the next deal.
    func kind(of id: String) -> StatusMark.Kind? {
        var hash: UInt64 = 1469598103934665603
        for byte in "\(id)#\(round)".utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        let slot = Int(hash % 100)
        return shares.first { slot < $0.upTo }?.kind
    }
}
#endif
