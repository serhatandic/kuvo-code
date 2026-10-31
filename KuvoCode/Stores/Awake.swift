import Foundation

/// Keeps this Mac from falling asleep on its own while agents work on it (Settings › General), so
/// a long task, or a bot's wake-up, isn't cut off when you step away. The display can still sleep,
/// and sessions on your machines run there whatever this Mac does.
///
/// Whoever runs this Mac's box holds it: the keeper (`Keeper`, with an `Awake` of its own), whether
/// or not the app is open, after a restart too; the app (`shared`) only while it runs the box
/// itself. Following the keeper, the app holds nothing besides (`keeper`).
final class Awake {
    static let shared = Awake()
    static let key = "keepsAwake"

    static var isOn: Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }

    /// Whether agents are at work on this Mac.
    private var isWorking = false
    private var activity: NSObjectProtocol?

    /// This Mac's keeper, while the app follows the box it runs: it keeps the Mac awake itself, so
    /// the app lets go of its own, and asks it whether it holds (`holdsNow`).
    var keeper: (() async -> Bool)? {
        didSet { update() }
    }

    /// Whether it keeps this Mac awake now (this process, not the keeper it follows).
    var isHolding: Bool { activity != nil }

    /// Whether this Mac is kept awake for agents now: by the app, or by the keeper it follows.
    func holdsNow() async -> Bool {
        guard let keeper else { return isHolding }
        return await keeper()
    }

    func agentsWork(_ working: Bool) {
        guard working != isWorking else { return }
        isWorking = working
        update()
    }

    /// Holds or lets go, as the setting and the work say.
    func update() {
        let wanted = Self.isOn && isWorking && keeper == nil
        if wanted, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled, .userInitiated], reason: "Agents are working in Kuvo Code")
        } else if !wanted, let activity {
            ProcessInfo.processInfo.endActivity(activity)
            self.activity = nil
        }
    }
}
