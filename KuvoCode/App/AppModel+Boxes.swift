import ClientAccounts
import OpenCodeKit
import SwiftUI

/// Each computer's own, as a box of its own (this Mac, or a machine): its engine's settings, its
/// engine, its models and its coding agents, for what a page or a tab is about.
extension AppModel {
    /// Its engine's settings: this Mac's file, or the machine's own (read once it's reached).
    func config(for box: SidebarBox) -> EngineConfig {
        guard let machine = box.machine else { return engineConfig }
        return machines.engine(machine)?.config ?? Self.noSettings
    }

    /// Its engine, while it's running.
    func api(for box: SidebarBox) -> OpenCodeAPI? {
        guard let machine = box.machine else { return api }
        return machines.engine(machine)?.api
    }

    /// Its engine, or why it can't be reached now, for what a click on its page does.
    func reachableAPI(for box: SidebarBox) throws -> OpenCodeAPI {
        guard let api = api(for: box) else { throw Unreachable(computer: box.machine.map { _ in name(of: box) }) }
        return api
    }

    /// A computer's engine can't be reached now: this Mac's isn't running, or a machine isn't connected.
    struct Unreachable: LocalizedError {
        /// The machine's name (nil: this Mac).
        var computer: String?

        var errorDescription: String? {
            computer.map { "\($0) isn’t connected. Try again once it is." } ?? "This Mac’s engine isn’t running. Try again in a moment."
        }
    }

    /// Its engine is running and answering: what pages read from it, read again once it is.
    func isReady(_ box: SidebarBox) -> Bool {
        guard let machine = box.machine else { return engine == .ready }
        guard let engine = machines.engine(machine) else { return false }
        return engine.isReady && engine.isLive
    }

    /// Its models, accounts and agents, as its engine lists them.
    func catalog(for box: SidebarBox) -> Catalog {
        guard let machine = box.machine else { return catalog }
        return machines.engine(machine)?.catalog ?? catalog
    }

    /// Its coding agents, beside its engine.
    func agents(for box: SidebarBox) -> OutsideAgents {
        guard let machine = box.machine else { return agents }
        return machines.engine(machine)?.agents ?? agents
    }

    /// What it's called: this Mac's name, or the machine's.
    func name(of box: SidebarBox) -> String {
        guard let machine = box.machine else { return PhoneLink.computerName }
        return machines.list.first { $0.id == machine }?.name ?? machine
    }

    /// This Mac, then your machines.
    var boxes: [SidebarBox] {
        [.mac] + machines.list.map { .machine($0.id) }
    }

    /// The box whose page the sidebar shows, while it's still there: where New Bot and New Group
    /// Chat start.
    var boxInView: SidebarBox {
        let picked = SidebarBox(id: UserDefaults.standard.string(forKey: SidebarBox.inViewKey) ?? "mac")
        return boxes.contains(picked) ? picked : .mac
    }

    /// What Update All updates on `box` (while its agents are up), as its box picks it, once for
    /// each program: each shows how it goes on its row or tile in Settings › Accounts.
    func outdatedAgents(on box: SidebarBox) -> [Integration] {
        if let machine = box.machine, machines.engine(machine) == nil { return [] }
        guard agents(for: box).api != nil, !agents(for: box).isDown else { return [] }
        return catalog(for: box).codingAgents.filter(\.isInUpdateAll)
    }

    /// Update All on `box`: its box updates each it picks, through the installer that owns it, and
    /// says how each goes. Throws only when it couldn't be asked.
    func updateAllAgents(on box: SidebarBox) async throws {
        let agents = agents(for: box)
        guard let api = agents.api else { throw OutsideAgents.Failure.notRunning(agents.failure) }
        try await api.updateAllPrograms(catalog(for: box).codingAgents)
        await catalog(for: box).refreshAgents()
    }

    /// A machine that isn't added any more: nothing there to show or change.
    private static let noSettings = EngineConfig(draft: [:])
}

extension EnvironmentValues {
    /// The computer a page of Settings is about: this Mac, or a machine, with its own settings.
    @Entry var settingsBox: SidebarBox = .mac
}
