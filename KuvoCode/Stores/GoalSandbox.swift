import Foundation

/// Why a box can't work on a bot's goal on its own, for the row on the goal's card: what its
/// sandbox says (`GET kuvo/sandbox`, PROTOCOL.md "Sandbox"), in words, with a button that goes
/// where you can do something about it. The box names the reason and the action; this only says
/// them. The Mac and the phone say the same.
enum GoalSandbox {
    /// What a box says of its sandbox.
    struct Status: Decodable, Equatable {
        var on: Bool
        var why: String?
        var able: Bool?
        /// The coding agents' own commands are in it too.
        var agents: Bool?
        var reason: String?
        var action: String?
        /// The box's route that does the action: "POST kuvo/sandbox/check".
        var route: String?
        var needs: String?
        var check: String?
        var failures: Int?

        init(on: Bool, why: String? = nil, able: Bool? = nil, agents: Bool? = nil, reason: String? = nil, action: String? = nil,
             route: String? = nil, needs: String? = nil, check: String? = nil, failures: Int? = nil) {
            self.on = on
            self.why = why
            self.able = able
            self.agents = agents
            self.reason = reason
            self.action = action
            self.route = route
            self.needs = needs
            self.check = check
            self.failures = failures
        }
    }

    /// What was read of a box's sandbox.
    enum Reading: Equatable {
        case status(Status)
        /// A box from before the sandbox could be checked (no `sandbox.check`, or 404).
        case old
        /// It couldn't be read now.
        case unreadable
    }

    /// What a button does.
    enum Action: Equatable {
        case open(URL)
        /// A route of the box's ("POST", "kuvo/sandbox/check"), then the sandbox read again.
        case route(method: String, path: String)
        case reportProblem
        /// Settings › Machines, where a machine's Kuvo Code is updated.
        case updateMachine
        /// The app's own update window.
        case checkForUpdates
        /// Edit Bot, to run it on the engine.
        case editBot
        /// Read again.
        case readAgain
    }

    struct Button: Equatable {
        let label: String
        let action: Action
    }

    struct Row: Equatable {
        let title: String
        let text: String
        let buttons: [Button]
        /// A check is on its way: a spinner in place of the shield.
        var checking = false
    }

    /// Where the docs say how to check a machine's Linux, until a sandbox page of their own exists.
    static let helpPage = URL(string: "https://www.kuvo.run/code/docs/")!
    static let softwareUpdate = URL(string: "x-apple.systempreferences:com.apple.Software-Update-Settings.extension")!

    /// What a failed check found, by the check the box names.
    static func found(_ check: String?) -> String {
        switch check {
        case "folder": "a command couldn’t use its own folder"
        case "tempFiles": "a command couldn’t write its temporary files"
        case "readsOwn": "a command could still read Kuvo Code’s files"
        case "writesOwn": "a command could still write in Kuvo Code’s own folder"
        case "didntRun": "the check didn’t run"
        case "setup": "setting it up failed"
        default: "something wasn’t kept apart"
        }
    }

    /// The row for a goal that can't run alone on `computer` ("This Mac", or a machine's name).
    /// `agent`: the coding agent the bot runs on ("Claude Code"), nil for one on the engine. None
    /// where there's nothing to fix: the sandbox is on. It's always on; a box reports it not on with
    /// no reason only while it's switched off for the rollout, with nothing here to press.
    static func row(_ reading: Reading?, computer: String, onThisMac: Bool, bot: String, agent: String?) -> Row? {
        let cant = "\(computer) can’t work on its own yet"
        let withYou = "Until then, \(bot) works while you’re here."
        // A coding agent's commands aren't in the sandbox, whatever it says: the engine is the way.
        if let agent, !coversAgents(reading) {
            return Row(title: "\(bot) can’t work on its own yet",
                       text: "\(bot) runs on \(agent), and the sandbox doesn’t cover \(agent)’s commands yet. \(bot) works while you’re here.",
                       buttons: [Button(label: "Use the Engine…", action: .editBot)])
        }
        guard let reading else {
            return Row(title: "Checking the sandbox…", text: "", buttons: [], checking: true)
        }
        let status: Status
        switch reading {
        case .old where onThisMac:
            return Row(title: cant, text: "This version of Kuvo Code has no sandbox. \(withYou)", buttons: [Button(label: "Check for Updates…", action: .checkForUpdates)])
        case .old:
            return Row(title: cant, text: "Kuvo Code on \(computer) is too old for the sandbox. \(withYou)", buttons: [Button(label: "Update \(computer)…", action: .updateMachine)])
        case .unreadable:
            return Row(title: cant, text: "Its sandbox can’t be read now. \(withYou)", buttons: [Button(label: "Try Again", action: .readAgain)])
        case .status(let read):
            status = read
        }
        let route = status.route.flatMap(Self.route)
        let retry = Button(label: "Try Again", action: route.map { .route(method: $0.method, path: $0.path) } ?? .readAgain)
        let restart = Button(label: "Restart Engine", action: .route(method: route?.method ?? "POST", path: route?.path ?? "kuvo/engine/restart"))
        switch status.reason {
        case "kernel":
            return Row(title: "\(computer) can’t work on its own",
                       text: "\(computer)’s Linux is too old for the sandbox. Ask whoever runs it to update to \(status.needs ?? "Linux 5.13") or later. \(bot) works while you’re here.",
                       buttons: [Button(label: "How to Check…", action: .open(helpPage))])
        case "macos":
            return Row(title: "\(computer) can’t work on its own", text: "This version of macOS can’t run the sandbox. \(bot) works while you’re here.",
                       buttons: [Button(label: "Software Update…", action: .open(softwareUpdate))])
        case "engineMissing":
            return Row(title: cant, text: "Its engine isn’t set up yet. \(withYou)", buttons: [retry] + report(status))
        case "checking":
            return Row(title: "Checking the sandbox…", text: "\(bot) works while you’re here until it’s checked.", buttons: [retry] + report(status), checking: true)
        case "checkFailed":
            let again = (status.failures ?? 1) >= 2
            return Row(title: cant, text: "Its check \(again ? "failed again:" : "found that") \(found(status.check)), so commands run outside the sandbox for now. Try Again checks it again.",
                       buttons: [retry] + report(status))
        case "plugin":
            return Row(title: cant, text: "The sandbox’s part in the engine was changed or removed. Fix It puts it back.",
                       buttons: [Button(label: "Fix It", action: retry.action)])
        case "engineDown":
            return Row(title: cant, text: "The engine isn’t running, so the sandbox can’t be checked. \(withYou)", buttons: [restart])
        case "waiting":
            return Row(title: cant, text: "The engine hasn’t loaded the sandbox yet. \(withYou)", buttons: [restart])
        case nil where status.on:
            return nil
        case nil:
            return Row(title: cant, text: "\(bot) works while you’re here.", buttons: [])
        default:
            // A reason this app doesn't know yet: the box's own words, and checking again.
            return Row(title: cant, text: [status.why, "\(bot) works while you’re here."].compactMap { $0 }.joined(separator: " "), buttons: [retry] + report(status))
        }
    }

    /// Whether the box's sandbox takes in the coding agents' own commands too.
    private static func coversAgents(_ reading: Reading?) -> Bool {
        if case .status(let status) = reading { return status.agents == true }
        return false
    }

    /// Report a Problem, once a check has failed twice in a row.
    private static func report(_ status: Status) -> [Button] {
        (status.failures ?? 0) >= 2 ? [Button(label: "Report a Problem…", action: .reportProblem)] : []
    }

    /// "POST kuvo/sandbox/check" as its method and path.
    static func route(_ route: String) -> (method: String, path: String)? {
        let parts = route.split(separator: " ", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        return (parts[0].uppercased(), parts[1].hasPrefix("/") ? String(parts[1].dropFirst()) : parts[1])
    }
}

extension GoalPlans {
    /// What `box` says of its sandbox: a box without `sandbox.check` (or that answers 404) is from
    /// before it.
    func sandbox(on box: String) async -> GoalSandbox.Reading {
        #if DEBUG
        if let demoSandbox { return demoSandbox }
        #endif
        guard let client = boxClient(box) else { return .unreadable }
        struct Info: Decodable { var features: [String]? }
        guard let info = try? await client.value(Info.self, "GET", "kuvo/info") else { return .unreadable }
        guard info.features?.contains("sandbox.check") == true else { return .old }
        do {
            return .status(try await client.value(GoalSandbox.Status.self, "GET", "kuvo/sandbox"))
        } catch let refusal as BoxRefusal where refusal.status == 404 {
            return .old
        } catch {
            return .unreadable
        }
    }

    /// A route of `box`'s sandbox (check again, fix, restart the engine).
    func sandboxRoute(_ method: String, _ path: String, on box: String) async throws {
        guard let client = boxClient(box) else { throw BoxRefusal(status: 503, message: "Its computer can’t be reached now.") }
        let (status, data) = try await client.send(method, path, body: method == "GET" ? nil : Data("{}".utf8))
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
    }
}
