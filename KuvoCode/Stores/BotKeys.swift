import Foundation
import OpenCodeKit
import os

/// Keys a bot has of its own for integrations you bring a key for (a GitHub token of its own),
/// used only in its conversation and kept on the computer it lives on: for a bot on this Mac, in
/// your Keychain beside the shared ones; for one on a machine, on that machine (its bridge's
/// `kuvo/bots/<id>/keys`, which a phone reaches too), never on this Mac. Where it works, a settings
/// file of its folder's own, `.opencode/opencode.json`, names each such integration's server with
/// its keys over the shared ones, and no other bot's or session's settings name them. A bot that
/// works in a project shares that folder with your sessions there, so it uses the keys they do.
@MainActor
enum BotKeys {
    private static let log = Logger(subsystem: "run.kuvo.code", category: "integrations")

    /// The integrations a bot can have keys of its own for: those you bring a key or token for.
    /// (One you sign in to through your app is the same sign-in everywhere.)
    static var services: [Integrations.Service] {
        Integrations.all.filter { service in
            switch service.way {
            case .officialToken: true
            case .package(_, let keys, _, _, _, let macOnly): !keys.isEmpty && !macOnly
            default: false
            }
        }
    }

    /// The integrations `bot` has every key of its own for, and those with a shared key, where it
    /// lives; nil for a machine that can't be asked now.
    static func status(of bot: Bot, app: AppModel) async -> (own: Set<String>, shared: Set<String>)? {
        guard let machine = bot.machine else { return await keychainStatus(of: bot.id) }
        guard let (status, body) = try? await onMachine(machine, "GET", path(bot), app: app), status == 200,
              let listed = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["keys"] as? [[String: Any]] else { return nil }
        let ids = { (flag: String) in Set(listed.filter { $0[flag] as? Bool == true }.compactMap { $0["integration"] as? String }) }
        return (ids("own"), ids("shared"))
    }

    /// The same for a bot on this Mac, from your Keychain. (Read off the main thread: it can wait on you.)
    nonisolated static func keychainStatus(of bot: String) async -> (own: Set<String>, shared: Set<String>) {
        let keyed = await MainActor.run { services.map { (id: $0.id, keys: Integrations.keys(of: $0.way).map(\.name)) } }
        return await Task.detached {
            var own: Set<String> = [], shared: Set<String> = []
            for service in keyed where !service.keys.isEmpty {
                if service.keys.allSatisfy({ IntegrationKeys.value(IntegrationKeys.variable(service.id, $0, bot: bot)) != nil }) { own.insert(service.id) }
                if service.keys.allSatisfy({ IntegrationKeys.value(IntegrationKeys.variable(service.id, $0)) != nil }) { shared.insert(service.id) }
            }
            return (own, shared)
        }.value
    }

    /// Saves `values` as `bot`'s own keys for `service` where it lives and puts them to use; why
    /// not, when they couldn't be.
    static func save(_ values: [String: String], for service: Integrations.Service, bot: Bot, app: AppModel) async -> String? {
        if let machine = bot.machine {
            do {
                let (status, body) = try await onMachine(machine, "PUT", path(bot, service), body: ["keys": values], app: app)
                return refusal(status, body)
            } catch {
                return error.localizedDescription
            }
        }
        let variables = Integrations.keys(of: service.way).map { (IntegrationKeys.variable(service.id, $0.name, bot: bot.id), values[$0.name]?.trimmingCharacters(in: .whitespacesAndNewlines)) }
        let saved = await Task.detached { variables.allSatisfy { IntegrationKeys.set($0.1, for: $0.0) } }.value
        guard saved else { return "Couldn’t save it in your Keychain. Try again, or check Keychain Access." }
        await apply(to: bot, app: app)
        return nil
    }

    /// Takes away `bot`'s own keys for `service`, where it lives: it uses the shared one again, if
    /// there is one. Why not, when they couldn't be.
    @discardableResult
    static func remove(_ service: Integrations.Service, bot: Bot, app: AppModel) async -> String? {
        if let machine = bot.machine {
            do {
                let (status, body) = try await onMachine(machine, "DELETE", path(bot, service), app: app)
                // Gone already: nothing to take away.
                return status == 404 ? nil : refusal(status, body)
            } catch {
                return error.localizedDescription
            }
        }
        let variables = Integrations.keys(of: service.way).map { IntegrationKeys.variable(service.id, $0.name, bot: bot.id) }
        await Task.detached { for variable in variables { IntegrationKeys.set(nil, for: variable) } }.value
        await apply(to: bot, app: app, removing: variables)
        return nil
    }

    /// When it's deleted: those this Mac keeps go from your Keychain (a machine's bot's go with its
    /// folder there, as `Bots.delete` takes it away).
    static func forget(_ bot: Bot, app: AppModel?) async {
        await Task.detached {
            for variable in IntegrationKeys.variables(ofBot: bot.id) { IntegrationKeys.set(nil, for: variable) }
        }.value
    }

    /// Its own keys where it lives now, by integration, each by its keys' names: to give it where
    /// it's going (`Moves`). Nil when they can't be read (its machine can't be asked).
    static func carried(_ bot: Bot, app: AppModel) async -> [String: [String: String]]? {
        guard let (own, _) = await status(of: bot, app: app) else { return nil }
        var keys: [String: [String: String]] = [:]
        for service in services where own.contains(service.id) {
            if let machine = bot.machine {
                guard let (status, body) = try? await onMachine(machine, "GET", path(bot, service), app: app), status == 200,
                      let values = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["keys"] as? [String: String] else { return nil }
                keys[service.id] = values
            } else {
                let names = Integrations.keys(of: service.way).map(\.name)
                keys[service.id] = await Task.detached {
                    Dictionary(uniqueKeysWithValues: names.compactMap { name in IntegrationKeys.value(IntegrationKeys.variable(service.id, name, bot: bot.id)).map { (name, $0) } })
                }.value
            }
        }
        return keys
    }

    /// `bot`, where it's moved to, given the keys it had (`carried`), and its folder's settings
    /// made right for there (they came with it, naming its keys where it was).
    static func give(_ keys: [String: [String: String]], to bot: Bot, app: AppModel) async {
        for (id, values) in keys {
            guard let service = Integrations.service(id) else { continue }
            if let failure = await save(values, for: service, bot: bot, app: app) {
                log.error("A moved bot's own key didn't reach where it lives now: \(failure, privacy: .public)")
            }
        }
        if let machine = bot.machine, let engine = app.machines.engine(machine), engine.isReady {
            try? await MachineBox.refreshBotKeys(on: engine.machine.connection)
        } else {
            await apply(to: bot, app: app)
        }
    }

    /// A bot moving off where it lived (`Moves`, `bot` as it was there), once it's moved: its own
    /// keys where it was go, those it has where it lives now, so none is lost on the way.
    static func leave(_ bot: Bot, app: AppModel?) async {
        guard let app, let now = app.bots.bot(bot.id), now.machine != bot.machine,
              let (there, _) = await status(of: now, app: app) else { return }
        for service in services where there.contains(service.id) {
            if let machine = bot.machine {
                _ = try? await onMachine(machine, "DELETE", path(bot, service), app: app)
            } else {
                let variables = Integrations.keys(of: service.way).map { IntegrationKeys.variable(service.id, $0.name, bot: bot.id) }
                await Task.detached { for variable in variables { IntegrationKeys.set(nil, for: variable) } }.value
            }
        }
    }

    /// As an engine starts (on `machine`, or this Mac's): each bot's there, in case its keys or the
    /// integrations' settings changed meanwhile. On this Mac, only bots with keys of their own or
    /// a folder's settings file, which change only where they name their servers. On a machine,
    /// the machine sees to its own (its catalog may be new); keys this Mac kept for its bots from
    /// before they lived there go to it first.
    static func applyAll(on machine: String?, app: AppModel) async {
        guard let machine else {
            let names = await Task.detached { IntegrationKeys.names }.value
            for bot in app.bots.list where bot.machine == nil && bot.project == nil {
                let hasKeys = !IntegrationKeys.variables(ofBot: bot.id, in: names).isEmpty
                let hadSome = FileManager.default.fileExists(atPath: URL(filePath: bot.directory).appending(path: ".opencode/opencode.json").path)
                if hasKeys || hadSome { await apply(to: bot, app: app) }
            }
            return
        }
        guard let engine = app.machines.engine(machine), engine.isReady else { return }
        await handOver(on: machine, app: app) { try await onMachine(machine, $0, $1, body: $2, app: app) }
        try? await MachineBox.refreshBotKeys(on: engine.machine.connection)
    }

    /// A request to a machine's box: method, path and body in, status and body out.
    typealias Ask = (_ method: String, _ path: String, _ body: [String: Any]?) async throws -> (status: Int, body: Data)

    /// Keys this Mac kept for `machine`'s bots (an earlier Kuvo Code kept every bot's in your
    /// Keychain): each given to the machine (`ask`), then gone from your Keychain once it has it.
    static func handOver(on machine: String, app: AppModel, ask: Ask) async {
        let names = await Task.detached { IntegrationKeys.names }.value
        for bot in app.bots.list where bot.machine == machine && bot.project == nil {
            let held = Set(IntegrationKeys.variables(ofBot: bot.id, in: names))
            guard !held.isEmpty else { continue }
            for service in services {
                let variables = Integrations.keys(of: service.way).map { (name: $0.name, variable: IntegrationKeys.variable(service.id, $0.name, bot: bot.id)) }
                guard variables.allSatisfy({ held.contains($0.variable) }) else { continue }
                let values = await Task.detached {
                    Dictionary(uniqueKeysWithValues: variables.compactMap { key in IntegrationKeys.value(key.variable).map { (key.name, $0) } })
                }.value
                guard values.count == variables.count,
                      let (status, _) = try? await ask("PUT", path(bot, service), ["keys": values]), status == 200 else { continue }
                await Task.detached { for key in variables { IntegrationKeys.set(nil, for: key.variable) } }.value
            }
        }
    }

    /// `kuvo/bots/<id>/keys`, and one integration's.
    private static func path(_ bot: Bot, _ service: Integrations.Service? = nil) -> String {
        "kuvo/bots/\(bot.id)/keys" + (service.map { "/\($0.id)" } ?? "")
    }

    /// A request to `machine`'s box, as a phone's goes (`MachineBox.route`).
    private static func onMachine(_ machine: String, _ method: String, _ path: String, body: [String: Any]? = nil, app: AppModel) async throws -> (status: Int, body: Data) {
        guard let engine = app.machines.engine(machine), engine.isReady else { throw Unreachable(machine: machine) }
        return try await MachineBox.route(method, path, body: body, on: engine.machine.connection)
    }

    private struct Unreachable: LocalizedError {
        var machine: String
        var errorDescription: String? { "\(machine) isn’t connected, so its bots’ keys can’t be changed now." }
    }

    /// Nil for a change the machine made; else what it said.
    private static func refusal(_ status: Int, _ body: Data) -> String? {
        if (200..<300).contains(status) { return nil }
        return (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["message"] as? String ?? "The machine said no (\(status))."
    }

    /// Names a server in its folder's settings for each integration it has its own keys for, and
    /// takes away those it named for keys it no longer has, for a bot on this Mac (a machine's bot's
    /// its machine sees to). The rest of those settings is the folder's own (the bot's, or yours)
    /// and stays as it is; the file goes only once nothing is left in it, and its `.opencode`
    /// folder only if that held nothing else. Each of those servers connects again in its folder.
    static func apply(to bot: Bot, app: AppModel, removing removed: [String] = []) async {
        guard bot.project == nil, bot.machine == nil else { return }
        let (own, _) = await keychainStatus(of: bot.id)
        let chosen = services.filter { own.contains($0.id) }
        var servers: [String: JSONValue] = [:]
        for service in chosen { servers[service.id] = Integrations.settings(for: service, bot: bot.id) }
        let touched = Set(chosen.map(\.id) + services.filter { service in removed.contains { $0.hasPrefix(IntegrationKeys.variable(service.id, "")) } }.map(\.id))
        let folder = URL(filePath: bot.directory).appending(path: ".opencode")
        let file = folder.appending(path: "opencode.json")
        let exists = FileManager.default.fileExists(atPath: file.path)
        let current = exists ? try? String(contentsOf: file, encoding: .utf8) : nil
        switch exists && current == nil ? .notPlainJSON : change(current, servers: servers, bot: bot.id) {
        case .write(let settings):
            if let text = text(settings) {
                try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                FileManager.default.createFile(atPath: file.path, contents: Data((text + "\n").utf8), attributes: [.posixPermissions: 0o600])
            }
        case .remove:
            try? FileManager.default.removeItem(at: file)
            // The folder too, if that was all it held: rmdir leaves one that isn't empty.
            rmdir(folder.path)
        case .notPlainJSON:
            log.error("A bot's folder settings aren't plain JSON, so its own keys aren't named there")
        case .same:
            break
        }
        if let api = app.workspace.api(forFolder: bot.directory) { for id in touched { try? await api.connectMCP(id, directory: bot.directory) } }
    }

    /// What becomes of a folder's settings file.
    nonisolated enum SettingsChange: Equatable {
        case same, write([String: JSONValue]), remove
        /// Not plain JSON (comments, say): left alone, as Settings leaves the engine's own.
        case notPlainJSON
    }

    /// `text`, a bot's folder's settings file (nil when there's none), with `servers` in place of
    /// those it named for `bot`'s own keys before (each reads one of them), and everything else in
    /// it as it was.
    nonisolated static func change(_ text: String?, servers: [String: JSONValue], bot: String) -> SettingsChange {
        var old: [String: JSONValue] = [:]
        if let text, !text.allSatisfy(\.isWhitespace) {
            guard let settings = try? JSONDecoder().decode([String: JSONValue].self, from: Data(text.utf8)) else { return .notPlainJSON }
            old = settings
        }
        guard old["mcp"] == nil || old["mcp"]?.object != nil,
              old["mcp"]?["servers"] == nil || old["mcp"]?["servers"]?.object != nil else { return .notPlainJSON }
        var mcp = old["mcp"]?.object ?? [:]
        var named = (mcp["servers"]?.object ?? [:]).filter { IntegrationKeys.variables(ofBot: bot, in: Integrations.keyNames(in: $0.value)).isEmpty }
        named.merge(servers) { $1 }
        mcp["servers"] = named.isEmpty ? nil : .object(named)
        var new = old
        new["mcp"] = mcp.isEmpty ? nil : .object(mcp)
        if new == old { return .same }
        return new.isEmpty ? .remove : .write(new)
    }

    /// Settings as a file's text. Slashes as they are: the engine finds `{file:…}` in the text
    /// before it reads it.
    private static func text(_ settings: [String: JSONValue]) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(settings)).map { String(decoding: $0, as: UTF8.self) }
    }
}
