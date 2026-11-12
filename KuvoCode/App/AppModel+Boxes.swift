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
        return machines.list.first { $0.id == machine }?.name ?? Machine(destination: machine).name
    }

    /// This Mac, then your machines. Attached to the box already here (#183), this Mac is that box
    /// (first of the machines), and there's no box of the app's own.
    var boxes: [SidebarBox] {
        (attached == nil ? [.mac] : []) + machines.list.map { .machine($0.id) }
    }

    /// This Mac's box: the app's own, or the one attached in place.
    var thisMacsBox: SidebarBox { attached == nil ? .mac : .attached }

    /// The box whose page the sidebar shows, while it's still there: where New Bot and New Group
    /// Chat start.
    var boxInView: SidebarBox {
        let picked = SidebarBox(id: UserDefaults.standard.string(forKey: SidebarBox.inViewKey) ?? "mac")
        return boxes.contains(picked) ? picked : thisMacsBox
    }

    /// Coding agents on `box` (while its agents are up) with a newer version that their installer
    /// can update to, one per program, asked of the agent's own sign-in (where its row or tile in
    /// Settings › Accounts shows how it goes): what that page's Update All updates.
    func outdatedAgents(on box: SidebarBox) -> [Integration] {
        if let machine = box.machine, machines.engine(machine) == nil { return [] }
        guard agents(for: box).api != nil, !agents(for: box).isDown else { return [] }
        var seen = Set<String>()
        // An agent's own sign-in ahead of the accounts added to it, which run the same program.
        let integrations = catalog(for: box).codingAgents
        let own = integrations.filter { $0.metadata?["accountID"]?.string ?? "default" == "default" }
        return (own + integrations.filter { !own.contains($0) }).compactMap { integration in
            let metadata = integration.metadata
            guard metadata?["outdated"]?.bool == true, metadata?["updates"]?.bool == true,
                  let kind = metadata?["agent"]?.string, seen.insert(kind).inserted else { return nil }
            return integration
        }
    }

    /// Updates each of them, on `box`, through the installer that owns it.
    /// (Each update under way, for a test to wait for.)
    @discardableResult
    func updateAllAgents(on box: SidebarBox) -> [Task<Void, Never>] {
        let agents = agents(for: box), catalog = catalog(for: box)
        return outdatedAgents(on: box).compactMap { outdated in
            if agents.isUpdating(outdated.id) { return nil }
            return agents.update(outdated.id) { await catalog.refreshAgents(fresh: true) }
        }
    }

    /// A machine that isn't added any more: nothing there to show or change.
    private static let noSettings = EngineConfig(draft: [:])
}

extension EnvironmentValues {
    /// The computer a page of Settings is about: this Mac, or a machine, with its own settings.
    @Entry var settingsBox: SidebarBox = .mac
}
