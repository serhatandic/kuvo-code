import Foundation
import OpenCodeKit
import OSLog
import ServiceManagement

/// Background work (Settings › General): this Mac's keeper (`Keeper`), registered with macOS as
/// the app's launch agent the first time Kuvo Code opens, so your bots, goals, wake-ups and sessions
/// go on when you quit it. macOS tells you once that Kuvo Code added a background item, and keeps the
/// switch for it in System Settings › General › Login Items & Extensions; Stop Background Work stops
/// it until you open Kuvo Code or log in again.
@MainActor @Observable
final class BackgroundWork {
    static let shared = BackgroundWork()

    enum State: Equatable {
        /// Registered and allowed: launchd runs the keeper.
        case on
        /// Registered, but switched off in Login Items & Extensions (or never allowed): until it
        /// is, the app runs this Mac's box itself, and it stops when you quit.
        case needsApproval
        /// Not registered (yet, or it couldn't be).
        case off
    }

    private(set) var state: State = .off
    /// Why it couldn't be registered or started, when macOS said no.
    private(set) var failure: String?
    /// On, but its keeper didn't start this time (launchd couldn't, or it never came up): the app
    /// runs the work itself, and it stops when you quit.
    var didntStart = false

    #if DEBUG
    /// Tests: what macOS says of the agent, and whether this copy registers as a user's does.
    static var status: (() -> SMAppService.Status)?
    static var asUsersCopy = false
    #endif

    /// The launch agent in the app (`Contents/Library/LaunchAgents`), which a build phase names
    /// after this copy's bundle ID.
    nonisolated static var plistName: String { "\(AppInfo.bundleID).box.plist" }
    nonisolated static var label: String { "\(AppInfo.bundleID).box" }
    private var service: SMAppService { .agent(plistName: Self.plistName) }

    init() {
        refresh()
    }

    /// As macOS has it now (changed in System Settings, say).
    func refresh() {
        var status: SMAppService.Status { service.status }
        #if DEBUG
        if let given = Self.status {
            state = switch given() {
            case .enabled: .on
            case .requiresApproval: .needsApproval
            default: .off
            }
            return
        }
        #endif
        state = switch status {
        case .enabled: .on
        case .requiresApproval: .needsApproval
        default: .off
        }
    }

    /// The app attached to the box already on this Mac (`Here`), which starts on its own: no keeper
    /// of the app's is registered beside it, which would start a second box.
    nonisolated(unsafe) static var attachedHere = false

    /// Registered with macOS, once (the first time Kuvo Code opens, and again if it went): launchd
    /// starts the keeper now, and at each login. Whether it's on.
    @discardableResult
    func register() -> Bool {
        refresh()
        guard !Self.attachedHere else {
            failure = "This Mac’s box is the one already here, which starts on its own."
            return false
        }
        // A demo, test or measurement copy runs its work itself, also when its bundle ID was
        // registered before (by a copy run with KUVO_KEEPER=on): launchd would start that copy's
        // keeper, from wherever it was, or none at all.
        guard registersHere else {
            failure = "This copy runs its work itself (a demo, test or measurement): KUVO_KEEPER=on registers it."
            return false
        }
        guard state == .off else { return isOn() }
        guard AppInfo.mayPrompt("Background work (macOS adds a background item and tells you)") else {
            failure = "This copy never asks macOS (KUVO_DEMO_NO_PROMPTS)."
            return false
        }
        do {
            try service.register()
            failure = nil
        } catch {
            Logger(subsystem: "run.kuvo.code", category: "keeper").error("Background work wasn't registered: \(error.localizedDescription, privacy: .public)")
            failure = "macOS didn’t allow it. Check System Settings › General › Login Items & Extensions."
        }
        refresh()
        return isOn()
    }

    /// Whether this copy registers its keeper (`mayRegister`).
    var registersHere: Bool {
        #if DEBUG
        if Self.asUsersCopy { return true }
        #endif
        return !AppInfo.isHostingTests && Self.mayRegister(ProcessInfo.processInfo.environment)
    }

    /// Whether it's on; once it is, Open at Login's login item goes, since the work it opened
    /// Kuvo Code for runs at login without it.
    private func isOn() -> Bool {
        guard state == .on else { return false }
        OpenAtLogin.shared.retire()
        return true
    }

    /// Whether this copy registers its keeper: a copy launched for a demo, a test or a measurement
    /// (any `KUVO_DEMO_*`, `KUVO_PERF_*` or `KUVO_E2E`) never does unless `KUVO_KEEPER=on` asks,
    /// since launchd would go on running its box after it quits, without what it was launched with.
    nonisolated static func mayRegister(_ environment: [String: String]) -> Bool {
        if environment["KUVO_KEEPER"] == "on" { return true }
        return !environment.keys.contains { $0.hasPrefix("KUVO_DEMO_") || $0.hasPrefix("KUVO_PERF_") || $0 == "KUVO_E2E" }
    }

    /// Started again after Stop Background Work (opening the app, or Start in Settings): launchd
    /// runs it now, as it would at the next login.
    /// `over`: one running (but not answering) is stopped and started again. Whether launchd took
    /// it (it has no such agent when the app it was registered from is gone, say).
    @discardableResult
    func start(over: Bool = false) async -> Bool {
        guard register() else { return false }
        // Its end from `ChildProcess`, which never misses it, and the main thread never waits on it.
        let result = try? await ChildProcess.run(Self.launchctl, ["kickstart"] + (over ? ["-k"] : []) + ["gui/\(getuid())/\(Self.label)"],
                                                 output: .discard, errors: .discard, limit: .seconds(30), cancellable: false)
        return result.map { !$0.timedOut && $0.reason == .exit && $0.status == 0 } ?? false
    }

    /// What asks launchd to start it.
    nonisolated static var launchctl: String {
        #if DEBUG
        if let given = launchctlForTests { return given }
        #endif
        return "/bin/launchctl"
    }
    #if DEBUG
    /// Tests: a stand-in for launchctl.
    nonisolated(unsafe) static var launchctlForTests: String?
    #endif

    /// Stop Background Work: the keeper stops what runs, and itself, until it's started again.
    func stop() async throws {
        guard let keeper = KeeperRecord.read() else { return }
        do {
            try await KeeperControl.send(.stop, to: keeper)
        } catch {
            // Gone as it answered, or going (it waits for what it ran to stop first): stopped.
            for _ in 0..<40 where keeper.isAlive { try? await Task.sleep(for: .milliseconds(250)) }
            guard keeper.isAlive else { return }
            throw error
        }
    }

    /// Whether anything is under way in the background now (a session running on the engine or with
    /// the coding agents): Stop Background Work asks first only then.
    func isBusy() async -> Bool {
        (try? await KeeperControl.send(.status))?["busy"] as? Bool ?? false
    }

    /// System Settings at Login Items & Extensions, where its switch is.
    func openLoginItems() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
