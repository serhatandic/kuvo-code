import Foundation
import KuvoLink

/// Settings › General's While Agents Work for a phone (PROTOCOL.md, `kuvo/mac`): this Mac's
/// background work, and staying awake while agents work.
extension PhoneLink {
    /// `awakeNow`: whether it's kept awake now, by the app or by the keeper it follows (which reads
    /// the setting again as it's asked, so the answer to a change here says what it changed).
    func answerMac(_ request: LinkRequest) async -> (Int, Data) {
        let work = BackgroundWork.shared
        let login = OpenAtLogin.shared
        switch request.method.uppercased() {
        case "GET":
            work.refresh()
            login.refresh()
        case "PATCH":
            let body = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
            work.refresh()
            // Background work first: when it can't be turned on, nothing changes. A phone from
            // before it asks for Open at Login, which it replaced: the same thing now, so the two
            // never both open Kuvo Code at login.
            if let on = body["backgroundWork"] as? Bool ?? body["openAtLogin"] as? Bool {
                if !on {
                    // What it replaced goes, as asked; background work itself is macOS's own
                    // switch, in Login Items & Extensions on the Mac, as Settings says.
                    login.refresh()
                    if login.isOn {
                        login.set(false)
                        if let failure = login.failure { return (409, Self.message(failure)) }
                    }
                    if work.state != .off, work.registersHere {
                        return (400, Self.message("Background work is turned off in Login Items & Extensions, on the Mac."))
                    }
                } else if !work.isOnHere, work.state != .needsApproval {
                    // Asked of macOS: on, or waiting for your OK in Login Items (which Settings
                    // shows, and the answer says).
                    guard work.register() || work.state == .needsApproval else {
                        return (409, Self.message(work.failure ?? "macOS didn’t allow it. Check System Settings › General › Login Items & Extensions."))
                    }
                }
            }
            if let keeps = body["keepsAwake"] as? Bool {
                UserDefaults.standard.set(keeps, forKey: Awake.key)
                Awake.shared.update()
            }
        default:
            return (405, Data("{}".utf8))
        }
        var answer: [String: Any] = [
            "backgroundWork": work.phoneState,
            // For a phone from before background work, which shows Open at Login.
            "openAtLogin": login.isOn || work.isOnHere,
            "keepsAwake": Awake.isOn, "awakeNow": await Awake.shared.holdsNow(),
        ]
        if let failure = work.failure { answer["backgroundWorkFailure"] = failure }
        return (200, Self.json(answer))
    }
}

extension BackgroundWork {
    /// As Settings › General shows it: `on`; `notRunning` (on, but its keeper didn't start this
    /// time, so the work stops when you quit); `needsApproval` (waiting for your OK in Login Items &
    /// Extensions); `off` (also a demo or test copy, which runs its work itself).
    var phoneState: String {
        switch state {
        case .on where !registersHere: "off"
        case .on: didntStart ? "notRunning" : "on"
        case .needsApproval: "needsApproval"
        case .off: "off"
        }
    }

    /// On, as macOS has it, for this copy.
    var isOnHere: Bool { state == .on && registersHere }
}
