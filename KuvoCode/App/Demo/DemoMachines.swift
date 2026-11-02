#if DEBUG
import Foundation
import OpenCodeKit

/// KUVO_DEMO_MACHINE=<name>=<status>,…: stand-in machines, for a look at how the app shows a
/// machine in each state (Settings › Machines, the sidebar, its Remove dialog, its browser in the
/// panel) without one. Each is named under `.invalid` (added if the name lacks it), which never
/// resolves, and is never contacted: no SSH, no install, no keeper, no browser there
/// (`SSHConnection.isStandIn` refuses it, and its engine never starts); its state is shown as if it
/// had got there. They're never saved with your machines. Debug builds only.
///
/// The statuses: `connected`, `reading` (connected, its sessions being read), `connecting`,
/// `starting`, `downloading`, `copying` (the engine on its way to it), `reconnecting`, `failed`
/// (with `KUVO_DEMO_MACHINE_FAILURE`'s words, else SSH refusing this Mac's key), `notConnected`
/// and `stopped`. KUVO_DEMO_MACHINE_BROWSER says how its browser is: `installing`, `connecting`
/// or `failed`.
enum DemoMachines {
    struct StandIn {
        var id: String
        var status: String
    }

    static let list: [StandIn] = (ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE"] ?? "").split(separator: ",").compactMap { item in
        let parts = item.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let name = parts.first, !name.isEmpty else { return nil }
        return StandIn(id: SSHConnection.isStandIn(name) ? name : name + ".invalid", status: parts.count > 1 ? parts[1] : "connected")
    }

    /// The stand-in by this ID, if it's one.
    static func standIn(_ id: String) -> StandIn? { list.first { $0.id == id } }

    /// Why a `failed` one couldn't connect.
    static func failure(of name: String) -> String {
        ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE_FAILURE"]
            ?? RemoteEngineError.ssh(status: 255, message: "\(name): Permission denied (publickey).").localizedDescription
    }

    /// How a stand-in's browser shows.
    static var browser: String { ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE_BROWSER"] ?? "installing" }
}
#endif
