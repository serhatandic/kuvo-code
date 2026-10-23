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

    /// Coding agents with a newer version that their installer can update to, on every computer
    /// whose agents are up (this Mac, and each machine connected now), one per program: what
    /// Update All updates.
    var outdatedAgents: [OutdatedAgent] {
        boxes.flatMap { box -> [OutdatedAgent] in
            if let machine = box.machine, machines.engine(machine) == nil { return [] }
            let agents = agents(for: box)
            guard agents.api != nil else { return [] }
            var seen = Set<String>()
            return catalog(for: box).codingAgents.compactMap { integration in
                let metadata = integration.metadata
                guard metadata?["outdated"]?.bool == true, metadata?["updates"]?.bool == true,
                      let kind = metadata?["agent"]?.string, seen.insert(kind).inserted else { return nil }
                return OutdatedAgent(box: box, integration: integration)
            }
        }
    }

    /// Updates each of them, on its own computer, through the installer that owns it.
    func updateAllAgents() {
        for outdated in outdatedAgents {
            let agents = agents(for: outdated.box)
            let catalog = catalog(for: outdated.box)
            if agents.updating.contains(outdated.integration.id) { continue }
            agents.update(outdated.integration.id) { await catalog.refreshAgents(fresh: true) }
        }
    }

    /// A machine that isn't added any more: nothing there to show or change.
    private static let noSettings = EngineConfig(draft: [:])
}

/// A coding agent that can be updated, on the computer it's on.
struct OutdatedAgent {
    let box: SidebarBox
    let integration: Integration
}

extension EnvironmentValues {
    /// The computer a page of Settings is about: this Mac, or a machine, with its own settings.
    @Entry var settingsBox: SidebarBox = .mac
}
