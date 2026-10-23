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
    /// bots' own keys for it. `signIn`: its sign-in as last seen, if known (else it's asked).
    func removeIntegration(_ service: Integrations.Service, on box: SidebarBox, signIn listed: String? = nil) async {
        // Its keys and sign-in stay while it stays in a settings file that can't be changed.
        let config = config(for: box)
        guard config.problem == nil else { return }
        let api = api(for: box)
        // Its sign-in as the engine has it now, asked before it leaves the settings.
        var signIn = listed
        if signIn == nil, let api { signIn = (try? await api.mcpServers())?.first { $0.name == service.id }?.integrationID }
        config.set(nil, at: MCPSettings.path + [service.id])
        if let signIn { forgetSignIn(signIn, on: box) }
        let variables = Integrations.keys(of: service.way).map { IntegrationKeys.variable(service.id, $0.name) }
        // Bots there with keys of their own for it stop using it too: their keys go, and their
        // folders' settings stop naming its server.
        for bot in bots.list where bot.machine == box.machine {
            let theirs = Set(Integrations.keys(of: service.way).map { IntegrationKeys.variable(service.id, $0.name, bot: bot.id) })
            let held = await Task.detached { IntegrationKeys.variables(ofBot: bot.id) }.value
            if !theirs.isDisjoint(with: held) { await BotKeys.remove(service, bot: bot, app: self) }
        }
        guard let machine = box.machine else {
            for variable in variables { IntegrationKeys.set(nil, for: variable) }
            // What its server kept: its own folder (and the file it once kept).
            for name in [service.id, "\(service.id).json"] { try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: "integrations/\(name)")) }
            return
        }
        // On the machine: its keys and what its server kept there, now or the next time it answers.
        let root = "\"$HOME/\(RemoteEngineInstaller.root)"
        let script = (["rm -rf \(root)/integrations/\(service.id)\""] + variables.map { "rm -f \(root)/box/keys/\($0)\"" }).joined(separator: "; ")
        let later = Machines.integrationMark(service.id) + script
        guard machines.engine(machine)?.isReady == true else { machines.runLater(later, on: machine); return }
        let done = await Task.detached { RemoteShell.run(script, on: machine) != nil }.value
        if !done { machines.runLater(later, on: machine) }
    }

    /// Bots' own keys for integrations a machine removed by itself (from a phone), as it noted
    /// them (`box/integrations-removed.json`): gone from your Keychain too, so they don't come back
    /// to it. Read as it connects, and as its settings change there. One its settings have again
    /// (added back since) keeps them. The note goes once it's been acted on, unless the machine
    /// noted more meanwhile; with its settings unreadable, it stays for next time.
    func takeInRemovedIntegrations(on machine: String) async {
        guard let connection = machines.engine(machine)?.machine.connection else { return }
        let box = "\"$HOME/\(RemoteEngineInstaller.root)/box"
        let mark = "--kuvo-settings--"
        guard let output = try? await connection.run("f=\(box)/integrations-removed.json\"; [ -f \"$f\" ] || exit 0; cat \"$f\"; echo; echo \(mark); cat \(box)/opencode.json\""),
              let read = Self.removedToTakeIn(output, mark: mark) else { return }
        for id in read.ids {
            guard let service = Integrations.service(id) else { continue }
            for bot in bots.list where bot.machine == machine {
                let theirs = Integrations.keys(of: service.way).map { IntegrationKeys.variable(service.id, $0.name, bot: bot.id) }
                await Task.detached { for variable in theirs { IntegrationKeys.set(nil, for: variable) } }.value
            }
        }
        _ = try? await connection.run("f=\(box)/integrations-removed.json\"; printf '%s' \(SSHConnection.quoted(read.note)) | cmp -s - \"$f\" && rm -f \"$f\"; true")
    }

    /// A machine's note of what it removed and its settings, as `takeInRemovedIntegrations` reads
    /// them (`mark` between): the note as read, and the integrations it names that the settings
    /// don't have again. Nil when either can't be read.
    static func removedToTakeIn(_ output: String, mark: String) -> (note: String, ids: [String])? {
        let parts = output.components(separatedBy: "\n\(mark)\n")
        guard parts.count == 2,
              let removed = (try? JSONSerialization.jsonObject(with: Data(parts[0].utf8)) as? [String: Any])?["removed"] as? [String],
              let settings = try? JSONDecoder().decode([String: JSONValue].self, from: Data(parts[1].utf8)) else { return nil }
        return (parts[0], removed.filter { EngineConfig.value(at: MCPSettings.path + [$0], in: settings) == nil })
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
