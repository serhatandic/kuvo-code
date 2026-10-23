import Foundation
import OpenCodeKit

/// Adding and removing integrations on a computer, its keys where it keeps them: for Settings ›
/// Integrations and a phone alike.
extension AppModel {
    /// Adds it on `box`, as Connect (or Save, after its keys) does: one there already is written
    /// again as you set it up (turned off, Code Mode, headers you added), so the engine reads its
    /// keys again. False when its settings file can't be changed, or it's added in the browser.
    @discardableResult
    func addIntegration(_ service: Integrations.Service, on box: SidebarBox) -> Bool {
        let config = config(for: box)
        guard config.problem == nil else { return false }
        let path = MCPSettings.path + [service.id]
        let existing = config.value(at: path)
        guard let settings = existing ?? Integrations.settings(for: service, on: box.machine) else { return false }
        config.set(settings, at: path)
        // Back again: what its removal left to do on this machine, out of reach then, isn't done.
        if let machine = box.machine { machines.dropWaiting(marked: Machines.integrationMark(service.id), on: machine) }
        if existing == nil { Analytics.shared.track("integration_added", ["integration": service.id, "machine": box.machine != nil]) }
        return true
    }

    /// Its server connected again a moment after its keys changed: the engine reads them as it
    /// reads its settings again, which adding it (again) has it do. For Settings and a phone alike.
    func reconnectAfterKeys(_ service: Integrations.Service, on box: SidebarBox) async {
        guard let api = api(for: box) else { return }
        try? await Task.sleep(for: .seconds(2))
        await reconnect(service.id, api: api, machine: box.machine)
    }

    /// Its keys (by their names, `CLIENT_ID`, `API_KEY`…), where `box` keeps them: this Mac's
    /// Keychain, or a machine's own keys' folder.
    func saveIntegrationKeys(_ service: Integrations.Service, _ values: [String: String], on box: SidebarBox) async throws {
        let given = Integrations.keys(of: service.way).map { (IntegrationKeys.variable(service.id, $0.name), values[$0.name]?.trimmingCharacters(in: .whitespacesAndNewlines)) }
        guard let machine = box.machine else {
            guard given.allSatisfy({ IntegrationKeys.set($0.1, for: $0.0) }) else { throw IntegrationFailure.keychain }
            return
        }
        // A machine no longer added: nowhere to keep it (and never this Mac's Keychain).
        guard let engine = machines.engine(machine) else { throw IntegrationFailure.noMachine(machine) }
        for (variable, value) in given { try await MachineBox.setKey(variable, value, on: engine.machine.connection) }
    }

    /// Out of `box`'s settings, with its keys there, its sign-in, what its server kept, and its
    /// bots' own keys for it. A machine does it itself, as it does for a phone (its bridge's
    /// `DELETE kuvo/integrations/<id>`). `signIn`: its sign-in as last seen here, if known (else
    /// it's asked). Why not, when it couldn't be.
    @discardableResult
    func removeIntegration(_ service: Integrations.Service, on box: SidebarBox, signIn listed: String? = nil) async -> String? {
        // Its keys and sign-in stay while it stays in a settings file that can't be changed.
        let config = config(for: box)
        if let problem = config.problem { return "The engine's settings file can't be changed: \(problem)" }
        if let machine = box.machine {
            guard let engine = machines.engine(machine), engine.isReady else { return "\(machine) isn’t connected." }
            defer { config.reload() }
            do {
                let (status, body) = try await MachineBox.route("DELETE", "kuvo/integrations/\(service.id)", on: engine.machine.connection)
                // Not there any more: nothing to take away.
                guard status >= 400, status != 404 else { return nil }
                return (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["message"] as? String ?? "\(machine) said no (\(status))."
            } catch {
                return error.localizedDescription
            }
        }
        let api = api(for: box)
        // Its sign-in as the engine has it now, asked before it leaves the settings.
        var signIn = listed
        if signIn == nil, let api { signIn = (try? await api.mcpServers())?.first { $0.name == service.id }?.integrationID }
        config.set(nil, at: MCPSettings.path + [service.id])
        if let signIn { forgetSignIn(signIn, on: box) }
        // Bots here with keys of their own for it stop using it too: their keys go, and their
        // folders' settings stop naming its server.
        for bot in bots.list where bot.machine == nil {
            let theirs = Set(Integrations.keys(of: service.way).map { IntegrationKeys.variable(service.id, $0.name, bot: bot.id) })
            let held = await Task.detached { IntegrationKeys.variables(ofBot: bot.id) }.value
            if !theirs.isDisjoint(with: held) { await BotKeys.remove(service, bot: bot, app: self) }
        }
        for variable in Integrations.keys(of: service.way).map({ IntegrationKeys.variable(service.id, $0.name) }) { IntegrationKeys.set(nil, for: variable) }
        // What its server kept: its own folder (and the file it once kept).
        for name in [service.id, "\(service.id).json"] { try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: "integrations/\(name)")) }
        return nil
    }

    enum IntegrationFailure: LocalizedError {
        case keychain
        case noMachine(String)

        var errorDescription: String? {
            switch self {
            case .keychain: "Couldn’t save it in your Keychain. Try again, or check Keychain Access."
            case .noMachine(let machine): "\(machine) isn’t one of your machines any more."
            }
        }
    }
}
