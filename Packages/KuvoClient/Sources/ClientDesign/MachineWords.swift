import Foundation

/// What both apps say of a machine one of your Macs adds and removes (PROTOCOL.md, `kuvo/machines`):
/// the step its first connection is on, and what Remove's dialog says Uninstall would stop it for.
public enum MachineWords {
    /// A connection's step in a row, by its name in `kuvo/machines` (`checking`, `downloading`,
    /// `copying`, `starting`, `reading`, `updating`): "Copying the engine". Nil for one it doesn't know.
    public static func step(_ name: String) -> String? {
        switch name {
        case "checking": "Checking the machine"
        case "downloading": "Downloading the engine"
        case "copying": "Copying the engine"
        case "starting": "Starting the engine"
        case "reading": "Reading its sessions"
        // The update gate (#679): its box brought up to date before it's used.
        case "updating": "Updating Kuvo Code"
        default: nil
        }
    }

    /// A row's status while the engine comes to the machine, with how far: "Copying the engine ·
    /// 41 of 98 MB", "Downloading the engine · 34%". Nil for any other step (the row says it's
    /// connecting).
    public static func installing(step: String, sent: Int64? = nil, total: Int64? = nil, fraction: Double? = nil) -> String? {
        switch step {
        case "copying": "Copying the engine" + (sent.flatMap { sent in total.map { $0 > 0 ? " · " + ProgressLine.Words.amount(done: sent, of: $0) : "…" } } ?? "…")
        case "downloading": "Downloading the engine" + (fraction.map { $0 > 0 ? " · " + ProgressLine.Words.percent($0) : "…" } ?? "…")
        default: nil
        }
    }

    /// Remove's dialog: what it says, and Uninstall's button (nil: not offered). Uninstall stops it
    /// for everyone else who uses it, so they're named first; one another Mac runs is uninstalled
    /// only from there. `name`: the machine's; `home`: the Mac that runs it, when it isn't `device`
    /// ("Another Mac" where it's unnamed); `otherMacs`, `phones`: who else uses it, as its box
    /// said (`otherMacs` nil: not known, so Uninstall's words cover anyone); `phonesKeepIt`: phones keep it once it's removed (a paired phone);
    /// `device`: where Remove takes it off ("this Mac", or the Mac's name on a phone).
    public static func removal(of name: String, home: String?, otherMacs: [String]?, phones: Int, phonesKeepIt: Bool, device: String) -> (message: String, uninstall: String?) {
        if let home {
            return ("\(home) runs \(name), so it can be uninstalled only from there. Remove takes it off \(device); it keeps running, with its sessions, bots, sign-ins and keys.", nil)
        }
        let others = (otherMacs ?? []) + (phones == 0 ? [] : [phones == 1 ? "your phone" : "your phones"])
        if !others.isEmpty {
            let who = ListFormatter.localizedString(byJoining: others)
            let one = others.count == 1 && phones <= 1
            return ("Remove takes it off \(device) only. \(who.prefix(1).uppercased() + who.dropFirst()) also \(one ? "uses" : "use") \(name): Uninstall stops it for everyone and deletes its sign-ins and keys.",
                    otherMacs?.isEmpty == false ? "Uninstall for Every Mac" : "Uninstall from \(name)")
        }
        // Not known (not read since it last connected): Uninstall says it would stop it for anyone.
        guard otherMacs != nil else {
            return ("Remove takes it off \(device); it keeps running, with its sessions, bots, sign-ins and keys\(phonesKeepIt ? ", and your phones keep it" : ""). Uninstall also stops it there, for any other Mac or phone that uses it, and deletes its sign-ins and keys.", "Uninstall from \(name)")
        }
        return ("Remove takes it off \(device); it keeps running, with its sessions, bots, sign-ins and keys\(phonesKeepIt ? ", and your phones keep it" : ""). Uninstall also stops it there and deletes its sign-ins and keys.", "Uninstall from \(name)")
    }
}
